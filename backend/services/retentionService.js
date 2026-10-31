/**
 * Controlled retention for the decision trail
 * ==============================================
 * Three independent windows (config.retention):
 *   - snapshots: after SNAPSHOT_REDACTION_DAYS the feature snapshot and SHAP values of a
 *     decision record are blanked (redacted_at set). The record, its reasons, thresholds,
 *     versions and hash stay, so the chain still verifies (hashes cover digests).
 *   - decision records: removed per TRANSACTION, and only when every record of that
 *     transaction is older than DECISION_RETENTION_DAYS (a chain is never cut in the middle).
 *   - audit logs: rows older than AUDIT_RETENTION_DAYS.
 * Never touched: anything belonging to a transaction under an active legal hold or with an
 * open dispute. Every run (dry or real) is recorded in retention_runs with counts and a digest.
 * Runs are dry by default; only this module opens the retention gate.
 */
const crypto = require('crypto');
const db = require('../config/database');
const config = require('../config/env');
const { withRetentionGate } = require('../models/decisionRepository');

const dayMs = 86400000;
const iso = (d) => d.toISOString();
const cmp = (col, ph) => (db.dialect === 'postgres' ? `${col}::timestamptz < ${ph}::timestamptz` : `datetime(${col}) < datetime(${ph})`);

// Transactions that must not lose evidence.
const PROTECTED_TXNS = `(SELECT transaction_id FROM legal_holds WHERE released_at IS NULL
  UNION SELECT transaction_id FROM disputes WHERE status IN ('opened','evidence_submitted'))`;
const PROTECTED_AUDIT = `(target_type = 'transaction' AND target_id IN ${PROTECTED_TXNS})
  OR (target_type = 'alert' AND target_id IN (SELECT id FROM alerts WHERE transaction_id IN ${PROTECTED_TXNS}))
  OR (target_type = 'dispute' AND target_id IN (SELECT id FROM disputes WHERE transaction_id IN ${PROTECTED_TXNS}))`;

function policy(now = new Date(), overrides = {}) {
  const r = { ...config.retention, ...overrides };
  return {
    decision_days: r.decisionDays, audit_days: r.auditDays, snapshot_redaction_days: r.snapshotRedactionDays,
    decision_cutoff: iso(new Date(now - r.decisionDays * dayMs)), audit_cutoff: iso(new Date(now - r.auditDays * dayMs)),
    snapshot_cutoff: iso(new Date(now - r.snapshotRedactionDays * dayMs)),
  };
}

async function run({ dryRun = true, actor = 'system', now = new Date(), overrides } = {}) {
  const pol = policy(now, overrides);

  // transactions whose WHOLE chain is past the window and that are not protected
  const expiredTxns = (await db.all(
    `SELECT transaction_id FROM decision_records GROUP BY transaction_id
     HAVING ${cmp('MAX(created_at)', '?')} AND transaction_id NOT IN ${PROTECTED_TXNS}`, [pol.decision_cutoff]
  )).map((r) => Number(r.transaction_id));
  const redactable = Number((await db.get(
    `SELECT COUNT(*) AS n FROM decision_records WHERE redacted_at IS NULL AND (feature_snapshot IS NOT NULL OR shap IS NOT NULL)
       AND ${cmp('created_at', '?')} AND transaction_id NOT IN ${PROTECTED_TXNS}`, [pol.snapshot_cutoff])).n);
  const auditExpired = Number((await db.get(
    `SELECT COUNT(*) AS n FROM audit_logs WHERE ${cmp('created_at', '?')} AND NOT (${PROTECTED_AUDIT})`, [pol.audit_cutoff])).n);
  const heldSkipped = Number((await db.get(
    `SELECT COUNT(DISTINCT transaction_id) AS n FROM decision_records WHERE transaction_id IN ${PROTECTED_TXNS}`)).n);

  const results = { dry_run: dryRun, snapshots_redacted: redactable, decision_transactions_purged: expiredTxns.length, audit_rows_deleted: auditExpired, protected_transactions: heldSkipped };

  if (!dryRun) {
    await withRetentionGate(async () => {
      await db.run(
        `UPDATE decision_records SET feature_snapshot = NULL, shap = NULL, redacted_at = ?
         WHERE redacted_at IS NULL AND (feature_snapshot IS NOT NULL OR shap IS NOT NULL)
           AND ${cmp('created_at', '?')} AND transaction_id NOT IN ${PROTECTED_TXNS}`, [iso(now), pol.snapshot_cutoff]);
      for (let i = 0; i < expiredTxns.length; i += 500) {
        const chunk = expiredTxns.slice(i, i + 500);
        await db.run(`DELETE FROM decision_records WHERE transaction_id IN (${chunk.map(() => '?').join(',')})`, chunk);
      }
      await db.run(`DELETE FROM audit_logs WHERE ${cmp('created_at', '?')} AND NOT (${PROTECTED_AUDIT})`, [pol.audit_cutoff]);
    });
  }

  const digest = crypto.createHash('sha256').update(JSON.stringify({ pol, results, txns: expiredTxns.slice(0, 10000) })).digest('hex');
  await db.insert('INSERT INTO retention_runs (ran_at, actor, dry_run, policy, results) VALUES (?, ?, ?, ?, ?)',
    [iso(now), actor, dryRun ? 1 : 0, JSON.stringify(pol), JSON.stringify({ ...results, digest })]);
  return { policy: pol, results, digest };
}

async function history(limit = 20) {
  const rows = await db.all('SELECT * FROM retention_runs ORDER BY id DESC LIMIT ?', [limit]);
  return rows.map((r) => ({ id: Number(r.id), ran_at: r.ran_at, actor: r.actor, dry_run: !!r.dry_run, policy: JSON.parse(r.policy), results: JSON.parse(r.results) }));
}

async function placeHold({ transactionId, reason, userId }) {
  const { lastInsertRowid } = await db.insert('INSERT INTO legal_holds (transaction_id, reason, placed_by, placed_at) VALUES (?, ?, ?, ?)', [transactionId, reason, userId, iso(new Date())]);
  return Number(lastInsertRowid);
}
async function releaseHold({ holdId, userId }) {
  const r = await db.run('UPDATE legal_holds SET released_by = ?, released_at = ? WHERE id = ? AND released_at IS NULL', [userId, iso(new Date()), holdId]);
  return Number(r.changes) === 1;
}
async function holds(transactionId) {
  return db.all(`SELECT * FROM legal_holds ${transactionId ? 'WHERE transaction_id = ?' : ''} ORDER BY id DESC`, transactionId ? [transactionId] : []);
}

module.exports = { run, history, policy, placeHold, releaseHold, holds };
