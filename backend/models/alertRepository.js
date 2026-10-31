const db = require('../config/database');
const alertCase = require('./alertCaseRepository');

/** See transactionRepository.splitTotal — same one-query-for-page-and-count trick. */
function splitTotal(rows) {
  const total = rows.length > 0 ? Number(rows[0].total) : 0;
  return { rows: rows.map(({ total: _total, ...rest }) => rest), total };
}

/**
 * Builds the shared WHERE clause + params for the filter fields both
 * forUser and allWithUsername accept (status, riskLevel, merchant,
 * date range, amount range, assignedTo) — kept in one place so the two
 * queries can't drift out of sync on what a given filter means.
 * `baseConditions`/`baseParams` seed it with the caller's own required
 * condition (e.g. `a.user_id = ?`).
 */
function buildFilterClause(filters, baseConditions, baseParams) {
  const conditions = [...baseConditions];
  const params = [...baseParams];

  if (filters.status) {
    conditions.push('a.status = ?');
    params.push(filters.status);
  }
  if (filters.riskLevel) {
    conditions.push('a.risk_level = ?');
    params.push(filters.riskLevel);
  }
  if (filters.merchant) {
    conditions.push('t.merchant LIKE ?');
    params.push(`%${filters.merchant}%`);
  }
  if (filters.dateFrom) {
    conditions.push('a.created_at >= ?');
    params.push(filters.dateFrom);
  }
  if (filters.dateTo) {
    conditions.push('a.created_at <= ?');
    params.push(filters.dateTo);
  }
  if (filters.amountMin !== undefined) {
    conditions.push('t.amount >= ?');
    params.push(filters.amountMin);
  }
  if (filters.amountMax !== undefined) {
    conditions.push('t.amount <= ?');
    params.push(filters.amountMax);
  }
  if (filters.assignedTo !== undefined) {
    conditions.push('a.assigned_to = ?');
    params.push(filters.assignedTo);
  }
  if (filters.severity) {
    conditions.push('a.severity = ?');
    params.push(filters.severity);
  }
  if (filters.overdue === true || filters.overdue === 'true') {
    conditions.push(db.dialect === 'postgres' ? 'a.resolved = 0 AND a.due_at IS NOT NULL AND a.due_at::timestamptz < ?::timestamptz' : 'a.resolved = 0 AND a.due_at IS NOT NULL AND datetime(a.due_at) < datetime(?)');
    params.push(new Date().toISOString());
  }
  if (filters.unassigned === true || filters.unassigned === 'true') conditions.push('a.assigned_to IS NULL AND a.resolved = 0');

  return { where: conditions.join(' AND '), params };
}

/** 'priority' = the working queue: unresolved first, nearest deadline first. Default: newest first. */
function orderBy(sort) {
  if (sort === 'priority') return 'ORDER BY a.resolved ASC, CASE WHEN a.due_at IS NULL THEN 1 ELSE 0 END ASC, a.due_at ASC, a.id ASC';
  return 'ORDER BY a.created_at DESC';
}

async function forUser(userId, { page = 1, limit = 50, ...filters } = {}) {
  const offset = (page - 1) * limit;
  const { where, params } = buildFilterClause(filters, ['a.user_id = ?'], [userId]);
  const rows = await db.all(`
    SELECT a.*, t.merchant, t.amount, assignee.username as assignee_username, claimer.username as claimed_by_username, COUNT(*) OVER() as total
    FROM alerts a
    JOIN transactions t ON a.transaction_id = t.id
    LEFT JOIN users assignee ON a.assigned_to = assignee.id
    LEFT JOIN users claimer ON a.claimed_by = claimer.id
    WHERE ${where}
    ${orderBy(filters.sort)} LIMIT ? OFFSET ?
  `, [...params, limit, offset]);
  return splitTotal(rows);
}

async function allWithUsername({ page = 1, limit = 50, ...filters } = {}) {
  const offset = (page - 1) * limit;
  const { where, params } = buildFilterClause(filters, ['1=1'], []);
  const rows = await db.all(`
    SELECT a.*, t.merchant, t.amount, u.username, assignee.username as assignee_username, claimer.username as claimed_by_username, COUNT(*) OVER() as total
    FROM alerts a
    JOIN transactions t ON a.transaction_id = t.id
    JOIN users u ON a.user_id = u.id
    LEFT JOIN users assignee ON a.assigned_to = assignee.id
    LEFT JOIN users claimer ON a.claimed_by = claimer.id
    WHERE ${where}
    ${orderBy(filters.sort)} LIMIT ? OFFSET ?
  `, [...params, limit, offset]);
  return splitTotal(rows);
}

async function findById(id) {
  return db.get('SELECT * FROM alerts WHERE id = ?', [id]);
}

/** Same shape as forUser/allWithUsername's rows (joined with the
 * transaction and owner), for the single-alert view endpoint. Includes
 * the extra transaction columns (feature: LLM-generated explanations)
 * needed to build/cache a plain-language explanation without a second
 * query — category/location/card_type for context, fraud_score/
 * fraud_reasons/shap_explanation/hard_flag_triggered/scoring_method as
 * the actual signals explained, plain_language_explanation as the cache. */
async function findByIdWithDetails(id) {
  return db.get(`
    SELECT a.*, t.merchant, t.amount, t.category, t.location, t.card_type,
      t.fraud_score, t.fraud_reasons, t.shap_explanation, t.hard_flag_triggered,
      t.scoring_method, t.plain_language_explanation,
      u.username, assignee.username as assignee_username, claimer.username as claimed_by_username
    FROM alerts a
    JOIN transactions t ON a.transaction_id = t.id
    JOIN users u ON a.user_id = u.id
    LEFT JOIN users assignee ON a.assigned_to = assignee.id
    LEFT JOIN users claimer ON a.claimed_by = claimer.id
    WHERE a.id = ?
  `, [id]);
}

/**
 * Resolves an alert with an analyst's verdict — the whole point of this
 * endpoint (see schemas/alertSchemas.js's comment on why verdict is
 * required, not optional). `verdict: 'confirmed_fraud'` vs.
 * `'false_positive'` is what transactionRepository.fraudDeviceAndIpBlacklist
 * actually reads to decide whether this transaction's device/IP belongs
 * on the dynamic blacklist — resolving without a verdict would leave
 * that feedback loop open.
 */
async function resolve(id, { verdict, note, reason, prevented, recovered, loss, resolvedBy, expectedVersion, actorId = resolvedBy }) {
  // Optimistic concurrency: with `expectedVersion` the update applies only
  // if nobody changed the alert since the caller read it. Without it the
  // alert must still be unresolved, so a second investigator can never
  // silently overwrite the first one's verdict. The claim-lock guard is part
  // of the same statement: someone else's live lease means 0 rows change.
  const lf = alertCase.lockFree(actorId);
  const guard = expectedVersion !== undefined && expectedVersion !== null ? 'AND version = ?' : 'AND resolved = 0';
  const params = [verdict, note || null, reason || null, prevented ?? null, recovered ?? null, loss ?? null, resolvedBy, id, ...lf.params];
  if (guard.includes('version')) params.push(expectedVersion);
  return db.run(
    `UPDATE alerts
     SET resolved = 1, status = 'resolved', verdict = ?, resolution_note = ?, resolution_reason = ?,
         prevented_amount = ?, recovered_amount = ?, loss_amount = ?, resolved_by = ?, resolved_at = CURRENT_TIMESTAMP,
         claimed_by = NULL, claim_expires_at = NULL, version = version + 1
     WHERE id = ? AND ${lf.sql} ${guard}`,
    params
  );
}

/**
 * Assigns (or unassigns, if assigneeId is null) an alert to an analyst.
 * Auto-transitions status open <-> in_review to reflect who's working
 * it — but never touches a status of 'resolved', since assignment after
 * the fact (e.g. re-triage) shouldn't reopen a closed case. With
 * `expectedVersion`, applies only if the alert is unchanged since read.
 */
async function assign(id, assigneeId, { expectedVersion, actorId } = {}) {
  const versioned = expectedVersion !== undefined && expectedVersion !== null;
  const lf = actorId ? alertCase.lockFree(actorId) : { sql: '1=1', params: [] };
  const params = [assigneeId, assigneeId, id, ...lf.params];
  if (versioned) params.push(expectedVersion);
  return db.run(
    `UPDATE alerts
     SET assigned_to = ?,
         status = CASE
           WHEN status IN ('resolved', 'escalated', 'pending_info') THEN status
           WHEN CAST(? AS INTEGER) IS NOT NULL THEN 'in_review'
           ELSE 'open'
         END,
         version = version + 1
     WHERE id = ? AND ${lf.sql} ${versioned ? 'AND version = ?' : ''}`,
    params
  );
}

/**
 * Fetches multiple alerts by id in one query — used by the bulk-resolve
 * route (feature: bulk actions) to validate ownership/existence for the
 * whole batch before touching any of them, rather than looping one
 * findById call per id.
 */
async function findByIds(ids) {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => '?').join(', ');
  return db.all(`SELECT * FROM alerts WHERE id IN (${placeholders})`, ids);
}

/**
 * Resolves a batch of alerts with the same verdict/note in one UPDATE
 * (feature: bulk actions) — a real ops sweep ("mark this whole set of
 * false-positive card-testing alerts") shouldn't cost one round trip
 * per alert. The caller (routes/alerts.js) is responsible for having
 * already verified ownership of every id in the batch.
 */
async function bulkResolve(ids, { verdict, note, reason, resolvedBy }) {
  if (ids.length === 0) return { changes: 0 };
  const placeholders = ids.map(() => '?').join(', ');
  const lf = alertCase.lockFree(resolvedBy);
  return db.run(
    `UPDATE alerts
     SET resolved = 1, status = 'resolved', verdict = ?, resolution_note = ?, resolution_reason = ?, resolved_by = ?, resolved_at = CURRENT_TIMESTAMP,
         claimed_by = NULL, claim_expires_at = NULL, version = version + 1
     WHERE id IN (${placeholders}) AND resolved = 0 AND ${lf.sql}`,
    [verdict, note || null, reason || null, resolvedBy, ...ids, ...lf.params]
  );
}

async function countUnresolved() {
  const row = await db.get('SELECT COUNT(*) as count FROM alerts WHERE resolved = 0');
  return Number(row.count);
}

/**
 * Inserts one alert. `created_at` optional, same reasoning as
 * transactionRepository.insert().
 */
async function insert(alert) {
  const severity = alert.severity || alertCase.severityFor(alert.risk_level, alert.amount);
  const cols = ['transaction_id', 'user_id', 'message', 'risk_level', 'severity', 'due_at'];
  // SLA clock: from the alert's creation, unless the caller anchors it (the demo seeder backdates alerts).
  const values = [alert.transaction_id, alert.user_id, alert.message, alert.risk_level, severity, alertCase.dueFor(alert.due_from || alert.created_at || new Date(), severity)];
  if (alert.created_at) {
    cols.push('created_at');
    values.push(alert.created_at);
  }
  const placeholders = cols.map(() => '?').join(', ');
  return db.insert(`INSERT INTO alerts (${cols.join(', ')}) VALUES (${placeholders})`, values);
}

/**
 * Creates the alert for a transaction exactly once. The database enforces
 * one alert per transaction (unique index), so two racing writers cannot
 * both create one: the loser's INSERT is ignored and both get the same row.
 * Returns { alert, created }.
 */
async function insertOnce(alert) {
  const severity = alert.severity || alertCase.severityFor(alert.risk_level, alert.amount);
  const cols = ['transaction_id', 'user_id', 'message', 'risk_level', 'severity', 'due_at'];
  // SLA clock: from the alert's creation, unless the caller anchors it (the demo seeder backdates alerts).
  const values = [alert.transaction_id, alert.user_id, alert.message, alert.risk_level, severity, alertCase.dueFor(alert.due_from || alert.created_at || new Date(), severity)];
  if (alert.created_at) {
    cols.push('created_at');
    values.push(alert.created_at);
  }
  const { changes } = await db.run(
    `INSERT INTO alerts (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})
     ON CONFLICT (transaction_id) DO NOTHING`,
    values
  );
  const row = await db.get('SELECT * FROM alerts WHERE transaction_id = ?', [alert.transaction_id]);
  return { alert: row, created: changes === 1 };
}

module.exports = {
  insertOnce,
  forUser, allWithUsername, findById, findByIdWithDetails, findByIds,
  resolve, bulkResolve, assign, countUnresolved, insert,
};
