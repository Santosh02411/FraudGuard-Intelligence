/**
 * Feedback labels: an investigator's claim that a transaction WAS or WAS NOT fraud, verified by a second person
 * before it may reach training data.
 *
 *   proposed --verify--> verified --withdraw--> withdrawn
 *      \--reject--> rejected      \--withdraw--> withdrawn   (rejected/withdrawn free the transaction for a new label)
 *
 * Invariants (SQL/one transaction, not caller discipline): one live (proposed|verified) label per transaction
 * (partial unique index); every transition is a compare-and-set on status; the reviewer must differ from the proposer
 * (FEEDBACK_ALLOW_SELF_VERIFY is a dev-only escape hatch, refused in production); the event log is append-only.
 * Synthetic (simulator) transactions can never be labelled: they would teach the model its own demo traffic.
 */
const db = require('../config/database');
const config = require('../config/env');

const LABELS = ['fraud', 'legitimate'];
const now = () => new Date().toISOString();

class FeedbackError extends Error {
  constructor(code, message, extra = {}) { super(message); this.code = code; this.extra = extra; }
}

const norm = (r) => r && ({ ...r, id: Number(r.id), transaction_id: Number(r.transaction_id), version: Number(r.version) });

async function event(labelId, kind, actor, summary) {
  await db.run('INSERT INTO label_feedback_events (label_id, kind, actor_id, actor_username, summary, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    [labelId, kind, actor?.id ?? null, actor?.username ?? null, summary, now()]);
}

async function propose({ transactionId, label, source = 'manual_review', sourceRef = null, evidence, actor }) {
  if (!LABELS.includes(label)) throw new FeedbackError('INVALID', `label must be one of ${LABELS.join(', ')}`);
  const txn = await db.get('SELECT id, is_synthetic FROM transactions WHERE id = ?', [transactionId]);
  if (!txn) throw new FeedbackError('NOT_FOUND', 'Transaction not found');
  if (Number(txn.is_synthetic) === 1) throw new FeedbackError('SYNTHETIC', 'Simulator transactions cannot be used as training labels');
  try {
    const id = await db.transaction(async () => {
      const { lastInsertRowid } = await db.insert(
        `INSERT INTO label_feedback (transaction_id, label, source, source_ref, evidence_note, status, proposed_by, proposed_at)
         VALUES (?, ?, ?, ?, ?, 'proposed', ?, ?)`, [transactionId, label, source, sourceRef, evidence, actor.id, now()]);
      await event(lastInsertRowid, 'proposed', actor, `Proposed label "${label}" (${source})`);
      return lastInsertRowid;
    });
    return norm(await db.get('SELECT * FROM label_feedback WHERE id = ?', [id]));
  } catch (e) {
    if (/unique|duplicate/i.test(e.message)) throw new FeedbackError('ALREADY_LABELLED', 'This transaction already has a live label; withdraw or reject it first');
    throw e;
  }
}

async function decide(id, { to, from, actor, note, selfCheck }) {
  const row = await db.get('SELECT * FROM label_feedback WHERE id = ?', [id]);
  if (!row) throw new FeedbackError('NOT_FOUND', 'Label not found');
  if (selfCheck && Number(row.proposed_by) === Number(actor.id) && !config.feedback.allowSelfVerify) {
    throw new FeedbackError('SELF_VERIFICATION', 'A different investigator must verify this label (four-eyes)');
  }
  const r = await db.run('UPDATE label_feedback SET status = ?, reviewed_by = ?, reviewed_at = ?, review_note = ?, version = version + 1 WHERE id = ? AND status IN (' + from.map(() => '?').join(',') + ')',
    [to, actor.id, now(), note, id, ...from]);
  if (!r.changes) throw new FeedbackError('NOT_PENDING', `Label is no longer ${from.join('/')}`, { current: (await db.get('SELECT status FROM label_feedback WHERE id = ?', [id])).status });
  await event(id, to, actor, `${to}: ${note}`);
  return norm(await db.get('SELECT * FROM label_feedback WHERE id = ?', [id]));
}

const verify = (id, a) => decide(id, { to: 'verified', from: ['proposed'], selfCheck: true, ...a });
const reject = (id, a) => decide(id, { to: 'rejected', from: ['proposed'], selfCheck: false, ...a });
const withdraw = (id, a) => decide(id, { to: 'withdrawn', from: ['proposed', 'verified'], selfCheck: false, ...a });

async function list({ status, limit = 50, offset = 0 } = {}) {
  const where = status ? 'WHERE l.status = ?' : '';
  const params = status ? [status] : [];
  const total = Number((await db.get(`SELECT COUNT(*) AS n FROM label_feedback l ${where}`, params)).n);
  const rows = await db.all(
    `SELECT l.*, pu.username AS proposed_by_username, ru.username AS reviewed_by_username, t.amount, t.merchant, t.risk_level
     FROM label_feedback l LEFT JOIN users pu ON pu.id = l.proposed_by LEFT JOIN users ru ON ru.id = l.reviewed_by
     JOIN transactions t ON t.id = l.transaction_id ${where} ORDER BY l.id DESC LIMIT ? OFFSET ?`, [...params, limit, offset]);
  return { total, labels: rows.map(norm) };
}

async function events(id) {
  return db.all('SELECT kind, actor_username, summary, created_at FROM label_feedback_events WHERE label_id = ? ORDER BY id', [id]);
}

async function counts() {
  const rows = await db.all('SELECT status, label, COUNT(*) AS n FROM label_feedback GROUP BY status, label');
  const out = { proposed: 0, verified: 0, rejected: 0, withdrawn: 0, verified_fraud: 0, verified_legitimate: 0 };
  for (const r of rows) {
    out[r.status] += Number(r.n);
    if (r.status === 'verified') out[`verified_${r.label}`] += Number(r.n);
  }
  return out;
}

/**
 * Proposes labels from analyst verdicts already recorded on resolved alerts (confirmed_fraud -> fraud,
 * false_positive -> legitimate). They are PROPOSED, not verified: a second investigator still has to sign off.
 */
async function importFromOutcomes(actor, { limit = 500 } = {}) {
  const rows = await db.all(
    `SELECT a.id AS alert_id, a.transaction_id, a.verdict FROM alerts a
     JOIN transactions t ON t.id = a.transaction_id
     WHERE a.verdict IN ('confirmed_fraud', 'false_positive') AND t.is_synthetic = 0
       AND NOT EXISTS (SELECT 1 FROM label_feedback l WHERE l.transaction_id = a.transaction_id AND l.status IN ('proposed', 'verified'))
     ORDER BY a.id LIMIT ?`, [limit]);
  let created = 0;
  for (const r of rows) {
    // eslint-disable-next-line no-await-in-loop
    await propose({ transactionId: Number(r.transaction_id), label: r.verdict === 'confirmed_fraud' ? 'fraud' : 'legitimate', source: 'alert_verdict', sourceRef: Number(r.alert_id),
      evidence: `Imported from the analyst verdict "${r.verdict}" on alert #${r.alert_id}`, actor });
    created += 1;
  }
  return { proposed: created, scanned: rows.length, capped: rows.length >= limit };
}

module.exports = { FeedbackError, LABELS, propose, verify, reject, withdraw, list, events, counts, importFromOutcomes };
