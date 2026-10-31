/**
 * Alert case management: severity, SLA deadlines, escalation, claim locks,
 * comments, evidence and outcome amounts.
 *
 * Claim lock (so two investigators never unknowingly work one case)
 * ------------------------------------------------------------------
 * `claimed_by` + `claim_expires_at` form a short LEASE (default 15 min), renewed by the
 * holder's heartbeat and released on resolve. Every state-changing alert update carries the
 * guard `lockFree(actorId)` IN the UPDATE itself, so the check and the write are one atomic
 * statement (no check-then-act race). Someone else's live lease makes the write change 0 rows;
 * the route then reports 409 ALERT_LOCKED with the holder. An admin may take over with
 * `force`, which is audited. Leases expire on their own, so a closed laptop never blocks a case.
 * Comments and evidence deliberately do NOT need the lock (collaboration), and claiming does
 * not bump `version` (a heartbeat must not invalidate someone's open form).
 */
const db = require('../config/database');
const config = require('../config/env');

const SEVERITIES = ['critical', 'high', 'medium', 'low'];
const CASE_STATUSES = ['open', 'in_review', 'escalated', 'pending_info'];
const RESOLUTION_REASONS = [
  'customer_confirmed_legitimate', 'customer_confirmed_fraud', 'card_testing', 'account_takeover',
  'stolen_card', 'merchant_error', 'duplicate_alert', 'rule_too_sensitive', 'insufficient_evidence', 'other',
];
const HIGH_VALUE = 5000;
const dayLimit = 500;

const iso = (d = new Date()) => (d instanceof Date ? d : new Date(d)).toISOString();

function severityFor(riskLevel, amount) {
  const big = Number(amount) >= HIGH_VALUE;
  if (riskLevel === 'high') return big ? 'critical' : 'high';
  if (riskLevel === 'medium') return big ? 'high' : 'medium';
  return 'low';
}
const slaMinutes = (severity) => config.alertCases.slaMinutes[severity] || config.alertCases.slaMinutes.medium;
const dueFor = (from, severity) => iso(new Date(new Date(from).getTime() + slaMinutes(severity) * 60000));

// "this stored instant is before that parameter" for either dialect
const before = (col) => (db.dialect === 'postgres' ? `${col}::timestamptz < ?::timestamptz` : `datetime(${col}) < datetime(?)`);

/** SQL fragment + params: the alert is not under someone else's live lease. */
function lockFree(actorId, now = iso()) {
  return { sql: `(claimed_by IS NULL OR claimed_by = ? OR claim_expires_at IS NULL OR ${before('claim_expires_at')})`, params: [actorId, now] };
}

/** Is it under someone else's live lease? (JS mirror of lockFree, for presenting rows) */
function isLockedForOthers(alert, actorId, now = new Date()) {
  return !!alert.claimed_by && alert.claimed_by !== actorId && !!alert.claim_expires_at && new Date(alert.claim_expires_at) > now;
}

function present(alert, now = new Date()) {
  if (!alert) return alert;
  const resolved = !!alert.resolved;
  const due = alert.due_at ? new Date(alert.due_at) : null;
  const live = !!alert.claimed_by && !!alert.claim_expires_at && new Date(alert.claim_expires_at) > now;
  return {
    ...alert,
    overdue: !resolved && !!due && due < now,
    minutes_to_due: !resolved && due ? Math.round((due - now) / 60000) : null,
    locked: live,
    claim: live ? { user_id: alert.claimed_by, username: alert.claimed_by_username ?? null, expires_at: alert.claim_expires_at } : null,
  };
}

async function backfillCaseFields() {
  // Alerts that predate case management: derive severity; give unresolved ones a fresh SLA window from now
  // (not from their age, which would mark the entire historical backlog overdue at once).
  const rows = await db.all(
    `SELECT a.id, a.risk_level, a.resolved, a.created_at, t.amount FROM alerts a JOIN transactions t ON t.id = a.transaction_id
     WHERE a.severity IS NULL LIMIT 5000`
  );
  const now = new Date();
  for (const r of rows) {
    const sev = severityFor(r.risk_level, r.amount);
    await db.run('UPDATE alerts SET severity = ?, due_at = ? WHERE id = ?', [sev, r.resolved ? null : dueFor(now, sev), r.id]);
  }
}

// ---------------------------------------------------------------- claim lease
async function claim(id, userId, { force = false } = {}) {
  const now = iso();
  const expires = iso(new Date(Date.now() + config.alertCases.claimTtlMinutes * 60000));
  const guard = force ? '1=1' : lockFree(userId, now).sql;
  const params = force ? [] : lockFree(userId, now).params;
  const r = await db.run(
    `UPDATE alerts SET claimed_by = ?, claim_expires_at = ? WHERE id = ? AND resolved = 0 AND ${guard}`,
    [userId, expires, id, ...params]
  );
  return { claimed: Number(r.changes) === 1, expires_at: expires };
}

async function release(id, userId, { force = false } = {}) {
  const r = await db.run(
    `UPDATE alerts SET claimed_by = NULL, claim_expires_at = NULL WHERE id = ? AND claimed_by IS NOT NULL ${force ? '' : 'AND claimed_by = ?'}`,
    force ? [id] : [id, userId]
  );
  return Number(r.changes) === 1;
}

// ------------------------------------------------------------- status / severity
async function setStatus(id, status, { actorId, expectedVersion } = {}) {
  const lf = lockFree(actorId);
  const versioned = expectedVersion !== undefined && expectedVersion !== null;
  const r = await db.run(
    `UPDATE alerts SET status = ?, version = version + 1 WHERE id = ? AND resolved = 0 AND ${lf.sql} ${versioned ? 'AND version = ?' : ''}`,
    [status, id, ...lf.params, ...(versioned ? [expectedVersion] : [])]
  );
  return Number(r.changes) === 1;
}

async function setSeverity(id, severity, { actorId, expectedVersion } = {}) {
  const alert = await db.get('SELECT created_at FROM alerts WHERE id = ?', [id]);
  const lf = lockFree(actorId);
  const versioned = expectedVersion !== undefined && expectedVersion !== null;
  const r = await db.run(
    `UPDATE alerts SET severity = ?, due_at = ?, version = version + 1 WHERE id = ? AND resolved = 0 AND ${lf.sql} ${versioned ? 'AND version = ?' : ''}`,
    [severity, dueFor(alert.created_at instanceof Date ? alert.created_at : new Date(`${String(alert.created_at).replace(' ', 'T')}${/Z|[+-]\d\d:?\d\d$/.test(String(alert.created_at)) ? '' : 'Z'}`), severity), id, ...lf.params, ...(versioned ? [expectedVersion] : [])]
  );
  return Number(r.changes) === 1;
}

// --------------------------------------------------------------- escalation
/** Compare-and-set on escalation_level so two instances sweeping at once escalate once. */
async function escalate(id, fromLevel) {
  const alert = await db.get('SELECT severity FROM alerts WHERE id = ?', [id]);
  if (!alert) return false;
  const now = new Date();
  const nextDue = iso(new Date(now.getTime() + (slaMinutes(alert.severity) / 2) * 60000)); // the next level is due sooner
  const r = await db.run(
    `UPDATE alerts SET escalation_level = escalation_level + 1, escalated_at = ?, status = 'escalated', due_at = ?, version = version + 1
     WHERE id = ? AND resolved = 0 AND escalation_level = ?`,
    [iso(now), nextDue, id, fromLevel]
  );
  return Number(r.changes) === 1;
}

async function overdueUnresolved({ limit = 200, now = iso() } = {}) {
  return db.all(
    `SELECT id, user_id, severity, escalation_level, assigned_to, due_at, risk_level FROM alerts
     WHERE resolved = 0 AND due_at IS NOT NULL AND escalation_level < ? AND ${before('due_at')} ORDER BY due_at ASC LIMIT ?`,
    [config.alertCases.maxEscalationLevel, now, limit]
  );
}

// ----------------------------------------------------------------- outcomes
/** Throws a plain Error('...') describing the first violated rule; returns the normalised amounts otherwise. */
function validateOutcome({ verdict, transactionAmount, prevented = null, recovered = null, loss = null }) {
  const A = Number(transactionAmount);
  const nums = { prevented, recovered, loss };
  for (const [k, v] of Object.entries(nums)) {
    if (v !== null && v !== undefined && (!Number.isFinite(Number(v)) || Number(v) < 0)) throw new Error(`${k} amount must be a non-negative number`);
  }
  const p = Number(prevented || 0); const r = Number(recovered || 0); const l = Number(loss || 0);
  const any = p > 0 || r > 0 || l > 0;
  if (verdict === 'false_positive' && any) throw new Error('A false positive has no loss, recovery or prevented amount');
  const eps = 0.005;
  if (l > A + eps) throw new Error(`loss ($${l.toFixed(2)}) cannot exceed the transaction amount ($${A.toFixed(2)})`);
  if (p > A + eps) throw new Error(`prevented ($${p.toFixed(2)}) cannot exceed the transaction amount ($${A.toFixed(2)})`);
  if (l + p > A + eps) throw new Error('loss plus prevented cannot exceed the transaction amount');
  if (r > l + eps) throw new Error('recovered cannot exceed the loss it recovers from');
  return { prevented: prevented === null || prevented === undefined ? null : p, recovered: recovered === null || recovered === undefined ? null : r, loss: loss === null || loss === undefined ? null : l };
}

async function setOutcome(id, { prevented, recovered, loss, expectedVersion }) {
  const versioned = expectedVersion !== undefined && expectedVersion !== null;
  const r = await db.run(
    `UPDATE alerts SET prevented_amount = ?, recovered_amount = ?, loss_amount = ?, version = version + 1
     WHERE id = ? AND resolved = 1 AND verdict = 'confirmed_fraud' ${versioned ? 'AND version = ?' : ''}`,
    [prevented, recovered, loss, id, ...(versioned ? [expectedVersion] : [])]
  );
  return Number(r.changes) === 1;
}

// ---------------------------------------------------------------- comments
async function addComment(alertId, author, body) {
  const at = iso();
  const { lastInsertRowid } = await db.insert(
    'INSERT INTO alert_comments (alert_id, author_id, author_username, body, created_at) VALUES (?, ?, ?, ?, ?)',
    [alertId, author.id, author.username, body, at]
  );
  return { id: Number(lastInsertRowid), alert_id: alertId, author_id: author.id, author_username: author.username, body, created_at: at };
}
async function listComments(alertId) {
  return (await db.all('SELECT * FROM alert_comments WHERE alert_id = ? ORDER BY id ASC', [alertId])).map((r) => ({ ...r, id: Number(r.id) }));
}

// ---------------------------------------------------------------- evidence
async function addEvidence(alertId, uploader, { filename, contentType, content, sha256, description }) {
  const count = Number((await db.get('SELECT COUNT(*) AS n FROM alert_evidence WHERE alert_id = ?', [alertId])).n);
  if (count >= config.alertCases.evidenceMaxFiles) { const e = new Error('too many evidence files'); e.code = 'EVIDENCE_LIMIT'; throw e; }
  const at = iso();
  const { lastInsertRowid } = await db.insert(
    `INSERT INTO alert_evidence (alert_id, uploaded_by, uploaded_by_username, filename, content_type, size_bytes, sha256, description, content, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [alertId, uploader.id, uploader.username, filename, contentType, content.length, sha256, description || null, content, at]
  );
  return { id: Number(lastInsertRowid), alert_id: alertId, filename, content_type: contentType, size_bytes: content.length, sha256, description: description || null, uploaded_by_username: uploader.username, created_at: at };
}
async function listEvidence(alertId) {
  return (await db.all(
    'SELECT id, alert_id, uploaded_by, uploaded_by_username, filename, content_type, size_bytes, sha256, description, created_at FROM alert_evidence WHERE alert_id = ? ORDER BY id ASC', [alertId]
  )).map((r) => ({ ...r, id: Number(r.id), size_bytes: Number(r.size_bytes) }));
}
async function getEvidence(alertId, evidenceId) {
  return db.get('SELECT * FROM alert_evidence WHERE alert_id = ? AND id = ?', [alertId, evidenceId]);
}

// ----------------------------------------------------------------- metrics
async function metrics({ days = 30, now = new Date() } = {}) {
  const since = iso(new Date(now.getTime() - days * 86400000));
  const nowIso = iso(now);
  const open = await db.all(
    `SELECT status, severity, assigned_to, due_at, escalation_level FROM alerts WHERE resolved = 0`
  );
  const byStatus = {}; const bySeverity = {};
  let overdue = 0; let unassigned = 0; let escalated = 0;
  for (const a of open) {
    byStatus[a.status] = (byStatus[a.status] || 0) + 1;
    bySeverity[a.severity || 'unknown'] = (bySeverity[a.severity || 'unknown'] || 0) + 1;
    if (a.due_at && new Date(a.due_at) < now) overdue += 1;
    if (!a.assigned_to) unassigned += 1;
    if (a.escalation_level > 0) escalated += 1;
  }
  const sinceCmp = db.dialect === 'postgres' ? '?::timestamptz <= a.resolved_at::timestamptz' : 'datetime(?) <= datetime(a.resolved_at)';
  const resolvedRows = await db.all(
    `SELECT a.verdict, a.created_at, a.resolved_at, a.due_at, a.resolved_by, a.assigned_to, a.loss_amount, a.recovered_amount, a.prevented_amount, a.resolution_reason, t.amount
     FROM alerts a JOIN transactions t ON t.id = a.transaction_id
     WHERE a.resolved = 1 AND a.resolved_at IS NOT NULL AND ${sinceCmp} ORDER BY a.id DESC LIMIT ${dayLimit * 10}`,
    [since]
  );
  const asDate = (v) => (v instanceof Date ? v : new Date(`${String(v).replace(' ', 'T')}${/Z|[+-]\d\d:?\d\d$/.test(String(v)) ? '' : 'Z'}`));
  const confirmed = resolvedRows.filter((r) => r.verdict === 'confirmed_fraud');
  const fps = resolvedRows.filter((r) => r.verdict === 'false_positive');
  const sum = (rows, f) => Math.round(rows.reduce((s, r) => s + Number(f(r) || 0), 0) * 100) / 100;
  const mins = resolvedRows.map((r) => (asDate(r.resolved_at) - asDate(r.created_at)) / 60000).filter((m) => m >= 0).sort((a, b) => a - b);
  const withDue = resolvedRows.filter((r) => r.due_at);
  const metSla = withDue.filter((r) => asDate(r.resolved_at) <= asDate(r.due_at)).length;
  const loss = sum(confirmed, (r) => r.loss_amount);
  const reasons = {};
  for (const r of resolvedRows) { const k = r.resolution_reason || 'unspecified'; reasons[k] = (reasons[k] || 0) + 1; }
  const workload = await db.all(
    `SELECT u.username, COUNT(*) AS open_cases FROM alerts a JOIN users u ON u.id = a.assigned_to WHERE a.resolved = 0 GROUP BY u.username ORDER BY open_cases DESC LIMIT 25`
  );
  return {
    window_days: days, generated_at: nowIso,
    open: { total: open.length, by_status: byStatus, by_severity: bySeverity, overdue, unassigned, escalated },
    resolved: {
      total: resolvedRows.length, confirmed_fraud: confirmed.length, false_positive: fps.length,
      false_positive_rate: confirmed.length + fps.length ? Math.round((fps.length / (confirmed.length + fps.length)) * 1000) / 1000 : null,
      by_reason: reasons,
      median_minutes_to_resolve: mins.length ? Math.round(mins[Math.floor(mins.length / 2)]) : null,
      sla_met_rate: withDue.length ? Math.round((metSla / withDue.length) * 1000) / 1000 : null,
    },
    amounts: {
      confirmed_fraud_transaction_amount: sum(confirmed, (r) => r.amount),
      false_positive_transaction_amount: sum(fps, (r) => r.amount),
      loss: loss, recovered: sum(confirmed, (r) => r.recovered_amount), prevented: sum(confirmed, (r) => r.prevented_amount),
      recovery_rate: loss > 0 ? Math.round((sum(confirmed, (r) => r.recovered_amount) / loss) * 1000) / 1000 : null,
      cases_without_amounts: confirmed.filter((r) => r.loss_amount === null && r.prevented_amount === null).length,
    },
    workload: workload.map((w) => ({ username: w.username, open_cases: Number(w.open_cases) })),
    truncated: resolvedRows.length >= dayLimit * 10,
  };
}

module.exports = {
  SEVERITIES, CASE_STATUSES, RESOLUTION_REASONS, severityFor, slaMinutes, dueFor, lockFree, isLockedForOthers, present, backfillCaseFields,
  claim, release, setStatus, setSeverity, escalate, overdueUnresolved, validateOutcome, setOutcome,
  addComment, listComments, addEvidence, listEvidence, getEvidence, metrics, iso,
};
