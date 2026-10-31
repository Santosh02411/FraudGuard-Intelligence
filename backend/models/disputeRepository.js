/**
 * Dispute Repository
 * ====================
 * Feature: chargeback/dispute tracking. alerts.verdict
 * ('confirmed_fraud' / 'false_positive') is FraudGuard's OWN read on a
 * transaction, set by an analyst. A dispute tracks something different
 * and often disconnected from that: what actually happened financially
 * with the card network once a customer (or the analyst, on the
 * customer's behalf) formally disputed the charge. A transaction
 * FraudGuard never even flagged can still be disputed (a customer says
 * "I didn't make this"), and a transaction FraudGuard correctly flagged
 * as fraud can still be lost at chargeback (missing/weak evidence) — the
 * two are related signals, not the same fact, which is why this is its
 * own table rather than another alerts column.
 *
 * Lifecycle (enforced by TRANSITIONS below, not a DB constraint, so it
 * stays portable across dialects the same way fraud_rules is):
 *
 *   opened --> evidence_submitted --> won
 *          \                      \-> lost
 *           \--------------------------> won   (merchant concedes early / no real case)
 *            \-------------------------> lost  (merchant concedes early / no real case)
 *
 * i.e. evidence_submitted is an optional intermediate step, not a
 * required one — real disputes are sometimes resolved without a
 * separate "evidence" step (grace period expires, merchant doesn't
 * contest).
 */

const db = require('../config/database');
const { isUniqueViolation } = require('./idempotencyRepository');

const STATUSES = ['opened', 'evidence_submitted', 'won', 'lost'];

const TRANSITIONS = {
  opened: ['evidence_submitted', 'won', 'lost'],
  evidence_submitted: ['won', 'lost'],
  won: [],
  lost: [],
};

function assertValidTransition(fromStatus, toStatus) {
  if (!(TRANSITIONS[fromStatus] || []).includes(toStatus)) {
    const allowed = TRANSITIONS[fromStatus] || [];
    const err = new Error(
      allowed.length > 0
        ? `Cannot move a dispute from "${fromStatus}" to "${toStatus}" — allowed next steps: ${allowed.join(', ')}`
        : `Dispute is already resolved ("${fromStatus}") and cannot be transitioned further`
    );
    err.code = 'INVALID_TRANSITION';
    throw err;
  }
}

async function findById(id) {
  return db.get(`
    SELECT d.*, t.merchant, t.amount as transaction_amount, t.user_id as transaction_user_id,
      opener.username as opened_by_username, updater.username as updated_by_username
    FROM disputes d
    JOIN transactions t ON d.transaction_id = t.id
    LEFT JOIN users opener ON d.opened_by = opener.id
    LEFT JOIN users updater ON d.updated_by = updater.id
    WHERE d.id = ?
  `, [id]);
}

async function findByTransactionId(transactionId) {
  return db.get('SELECT * FROM disputes WHERE transaction_id = ?', [transactionId]);
}

/**
 * @param {{transactionId: number, amountDisputed: number, reason?: string, openedBy: number}} params
 */
async function openDispute({ transactionId, amountDisputed, reason, openedBy }) {
  const existing = await findByTransactionId(transactionId);
  if (existing) {
    const err = new Error(`Transaction ${transactionId} already has a dispute (#${existing.id}, status "${existing.status}")`);
    err.code = 'ALREADY_DISPUTED';
    throw err;
  }
  let lastInsertRowid;
  try {
    ({ lastInsertRowid } = await db.insert(
      `INSERT INTO disputes (transaction_id, status, amount_disputed, reason, opened_by, updated_by)
       VALUES (?, 'opened', ?, ?, ?, ?)`,
      [transactionId, amountDisputed, reason ?? null, openedBy, openedBy]
    ));
  } catch (e) {
    // The check above is only a fast path; transaction_id is UNIQUE, so two
    // simultaneous openers cannot both succeed — the loser lands here.
    if (isUniqueViolation(e)) {
      const err = new Error(`Transaction ${transactionId} already has a dispute`);
      err.code = 'ALREADY_DISPUTED';
      throw err;
    }
    throw e;
  }
  return findById(lastInsertRowid);
}

/**
 * Advances the dispute's status, validating the transition and stamping
 * the right timestamp/note column for the stage being entered.
 * @param {number} id
 * @param {{status: string, note?: string}} params
 * @param {number} updatedBy
 */
async function transition(id, { status, note, expectedVersion }, updatedBy) {
  const current = await db.get('SELECT * FROM disputes WHERE id = ?', [id]);
  if (!current) return null;
  if (expectedVersion !== undefined && expectedVersion !== null && current.version !== expectedVersion) {
    throw versionConflict(current);
  }
  assertValidTransition(current.status, status);

  const sets = ['status = ?', 'updated_by = ?', 'updated_at = CURRENT_TIMESTAMP', 'version = version + 1'];
  const params = [status, updatedBy];

  if (status === 'evidence_submitted') {
    sets.push('evidence_submitted_at = CURRENT_TIMESTAMP', 'evidence_note = ?');
    params.push(note ?? null);
  } else if (status === 'won' || status === 'lost') {
    sets.push('resolved_at = CURRENT_TIMESTAMP', 'resolution_note = ?');
    params.push(note ?? null);
  }
  // Compare-and-set on the version we validated against: if another
  // investigator moved the case between our read and this write, nothing
  // is updated and we report a conflict instead of overwriting them.
  params.push(id, current.version);
  const { changes } = await db.run(`UPDATE disputes SET ${sets.join(', ')} WHERE id = ? AND version = ?`, params);
  if (changes === 0) {
    const latest = await findById(id);
    throw versionConflict(latest);
  }
  return findById(id);
}

function versionConflict(current) {
  const err = new Error(`This dispute was changed by someone else (now "${current.status}", version ${current.version}). Reload and retry.`);
  err.code = 'VERSION_CONFLICT';
  err.current = current;
  return err;
}

/** Admin case list, newest first, optionally filtered by status. */
async function list({ status } = {}) {
  const where = status ? 'WHERE d.status = ?' : '';
  const params = status ? [status] : [];
  return db.all(`
    SELECT d.*, t.merchant, t.amount as transaction_amount, u.username as account_username,
      opener.username as opened_by_username
    FROM disputes d
    JOIN transactions t ON d.transaction_id = t.id
    JOIN users u ON t.user_id = u.id
    LEFT JOIN users opener ON d.opened_by = opener.id
    ${where}
    ORDER BY d.opened_at DESC
  `, params);
}

/**
 * Financial rollup for the admin dashboard — total exposure, how much
 * has actually been won back vs. lost to chargeback, and a win rate
 * over RESOLVED disputes only (an open/evidence_submitted dispute isn't
 * a win or a loss yet, so it shouldn't dilute the rate either way).
 */
async function financialSummary() {
  const rows = await db.all('SELECT status, amount_disputed FROM disputes');
  const summary = {
    total_disputes: rows.length,
    by_status: { opened: 0, evidence_submitted: 0, won: 0, lost: 0 },
    total_amount_disputed: 0,
    amount_won: 0,
    amount_lost: 0,
    amount_pending: 0,
    win_rate: null,
  };
  for (const row of rows) {
    const amount = Number(row.amount_disputed) || 0;
    summary.by_status[row.status] = (summary.by_status[row.status] || 0) + 1;
    summary.total_amount_disputed += amount;
    if (row.status === 'won') summary.amount_won += amount;
    else if (row.status === 'lost') summary.amount_lost += amount;
    else summary.amount_pending += amount;
  }
  const resolvedCount = summary.by_status.won + summary.by_status.lost;
  if (resolvedCount > 0) summary.win_rate = Math.round((summary.by_status.won / resolvedCount) * 10000) / 100;

  summary.total_amount_disputed = Math.round(summary.total_amount_disputed * 100) / 100;
  summary.amount_won = Math.round(summary.amount_won * 100) / 100;
  summary.amount_lost = Math.round(summary.amount_lost * 100) / 100;
  summary.amount_pending = Math.round(summary.amount_pending * 100) / 100;
  return summary;
}

module.exports = { STATUSES, TRANSITIONS, findById, findByTransactionId, openDispute, transition, list, financialSummary };
