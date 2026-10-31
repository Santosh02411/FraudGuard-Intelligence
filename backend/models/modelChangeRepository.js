/**
 * Model change requests = the promotion history
 * =================================================
 * One row per request to change which model version serves (promote or
 * roll back). It is the permanent answer to "who changed the model, when,
 * from what to what, why, who approved it, and what evidence they saw": the
 * gate report is stored with the request (and re-stored at apply time), the
 * checklist as submitted, and rows are never deleted.
 *
 * Status:  pending_approval -> approved -> applying -> applied | apply_failed
 *          pending_approval -> rejected | cancelled
 *
 * Concurrency: every transition is a compare-and-set (`WHERE status = ?`),
 * and a partial unique index allows only ONE open request per action, so two
 * admins can neither double-approve nor double-apply the same change.
 */
const db = require('../config/database');

const OPEN = ['pending_approval', 'approved', 'applying'];

const parse = (v, fallback) => {
  if (v === null || v === undefined) return fallback;
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v); } catch { return fallback; }
};

function normalize(r) {
  if (!r) return null;
  return {
    id: Number(r.id),
    action: r.action,
    target_version: r.target_version,
    from_version: r.from_version,
    status: r.status,
    reason: r.reason,
    checklist: parse(r.checklist, {}),
    gate_report: parse(r.gate_report, null),
    gate_report_at_apply: parse(r.gate_report_at_apply, null),
    acknowledged_gates: parse(r.acknowledged_gates, []),
    requested_by: r.requested_by ?? null,
    requested_by_username: r.requested_by_username ?? (r.requested_by == null ? 'system' : null),
    requested_at: r.requested_at,
    decided_by: r.decided_by ?? null,
    decided_by_username: r.decided_by_username ?? null,
    decided_at: r.decided_at,
    decision_note: r.decision_note,
    applied_at: r.applied_at,
    apply_result: parse(r.apply_result, null),
    version: Number(r.version),
  };
}

const SELECT = `SELECT c.*, ru.username AS requested_by_username, du.username AS decided_by_username
                  FROM model_change_requests c
                  LEFT JOIN users ru ON ru.id = c.requested_by
                  LEFT JOIN users du ON du.id = c.decided_by`;

async function get(id) {
  return normalize(await db.get(`${SELECT} WHERE c.id = ?`, [id]));
}

async function list({ status, limit = 50 } = {}) {
  const rows = status
    ? await db.all(`${SELECT} WHERE c.status = ? ORDER BY c.id DESC LIMIT ?`, [status, limit])
    : await db.all(`${SELECT} ORDER BY c.id DESC LIMIT ?`, [limit]);
  return rows.map(normalize);
}

/** Returns the new request, or null when another request of this action is already open. */
async function create({ action, targetVersion, fromVersion, reason, checklist, gateReport, requestedBy, status = 'pending_approval' }) {
  try {
    const { lastInsertRowid: id } = await db.insert(
      `INSERT INTO model_change_requests (action, target_version, from_version, status, reason, checklist, gate_report, requested_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [action, targetVersion, fromVersion ?? null, status, reason, JSON.stringify(checklist || {}), gateReport ? JSON.stringify(gateReport) : null, requestedBy ?? null]
    );
    return get(id);
  } catch (err) {
    if (/unique|duplicate/i.test(err.message)) return null;
    throw err;
  }
}

/** pending_approval -> approved | rejected, only if still pending (and at the version the decider saw, when given). */
async function decide(id, { status, decidedBy, note, acknowledged, expectedVersion }) {
  const params = [status, decidedBy ?? null, note, JSON.stringify(acknowledged || []), id];
  let sql = `UPDATE model_change_requests
                SET status = ?, decided_by = ?, decided_at = CURRENT_TIMESTAMP, decision_note = ?, acknowledged_gates = ?, version = version + 1
              WHERE id = ? AND status = 'pending_approval'`;
  if (expectedVersion != null) { sql += ' AND version = ?'; params.push(expectedVersion); }
  const { changes } = await db.run(sql, params);
  return changes === 1;
}

async function cancel(id, { by, note }) {
  const { changes } = await db.run(
    `UPDATE model_change_requests SET status = 'cancelled', decided_by = ?, decided_at = CURRENT_TIMESTAMP, decision_note = ?, version = version + 1
      WHERE id = ? AND status = 'pending_approval'`, [by ?? null, note, id]);
  return changes === 1;
}

/** approved -> applying; exactly one caller wins. */
async function claimApply(id) {
  const { changes } = await db.run(
    `UPDATE model_change_requests SET status = 'applying', version = version + 1 WHERE id = ? AND status = 'approved'`, [id]);
  return changes === 1;
}

async function finishApply(id, { ok, result, gateReportAtApply }) {
  await db.run(
    `UPDATE model_change_requests
        SET status = ?, applied_at = CURRENT_TIMESTAMP, apply_result = ?, gate_report_at_apply = ?, version = version + 1
      WHERE id = ? AND status = 'applying'`,
    [ok ? 'applied' : 'apply_failed', JSON.stringify(result || {}), gateReportAtApply ? JSON.stringify(gateReportAtApply) : null, id]);
}

/** The last change that made `version` the serving model, if the workflow did it. */
async function lastAppliedFor(version) {
  return normalize(await db.get(`${SELECT} WHERE c.target_version = ? AND c.status = 'applied' ORDER BY c.id DESC LIMIT 1`, [version]));
}

module.exports = { OPEN, get, list, create, decide, cancel, claimApply, finishApply, lastAppliedFor };
