const db = require('../config/database');

function parseRow(t) {
  if (!t) return t;
  return {
    ...t,
    fraud_reasons: JSON.parse(t.fraud_reasons || '[]'),
    shap_explanation: JSON.parse(t.shap_explanation || '[]'),
    hard_flag_triggered: t.hard_flag_triggered ? JSON.parse(t.hard_flag_triggered) : null,
  };
}

/**
 * Total count comes along for the ride via `COUNT(*) OVER()`, so a page
 * of rows and the count needed for pagination metadata cost one query
 * instead of two. Every row carries the same `total` value; it's pulled
 * off the first row (0 when the page is empty, since there's no row to
 * read it from).
 */
function splitTotal(rows) {
  const total = rows.length > 0 ? Number(rows[0].total) : 0;
  return { rows: rows.map(({ total: _total, ...rest }) => rest), total };
}

/**
 * Builds the shared WHERE clause + params for the filter fields both
 * forUser and allWithUsername accept — the "ops tool" filter bar
 * (merchant, category, risk level, amount range, date range). See
 * alertRepository.buildFilterClause for the same pattern on alerts.
 */
function buildFilterClause(filters, baseConditions, baseParams, alias = '') {
  const col = (name) => (alias ? `${alias}.${name}` : name);
  const conditions = [...baseConditions];
  const params = [...baseParams];

  if (filters.merchant) {
    conditions.push(`${col('merchant')} LIKE ?`);
    params.push(`%${filters.merchant}%`);
  }
  if (filters.category) {
    conditions.push(`${col('category')} = ?`);
    params.push(filters.category);
  }
  if (filters.riskLevel) {
    conditions.push(`${col('risk_level')} = ?`);
    params.push(filters.riskLevel);
  }
  if (filters.dateFrom) {
    conditions.push(`${col('created_at')} >= ?`);
    params.push(filters.dateFrom);
  }
  if (filters.dateTo) {
    conditions.push(`${col('created_at')} <= ?`);
    params.push(filters.dateTo);
  }
  if (filters.amountMin !== undefined) {
    conditions.push(`${col('amount')} >= ?`);
    params.push(filters.amountMin);
  }
  if (filters.amountMax !== undefined) {
    conditions.push(`${col('amount')} <= ?`);
    params.push(filters.amountMax);
  }

  return { where: conditions.join(' AND '), params };
}

async function forUser(userId, { page = 1, limit = 100, ...filters } = {}) {
  const offset = (page - 1) * limit;
  const { where, params } = buildFilterClause(filters, ['user_id = ?'], [userId]);
  const rows = await db.all(
    `SELECT *, COUNT(*) OVER() as total FROM transactions
     WHERE ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );
  const { rows: pageRows, total } = splitTotal(rows);
  return { rows: pageRows.map(parseRow), total };
}

async function allWithUsername({ page = 1, limit = 100, ...filters } = {}) {
  const offset = (page - 1) * limit;
  const { where, params } = buildFilterClause(filters, ['1=1'], [], 't');
  const rows = await db.all(`
    SELECT t.*, u.username, COUNT(*) OVER() as total FROM transactions t
    JOIN users u ON t.user_id = u.id
    WHERE ${where}
    ORDER BY t.created_at DESC LIMIT ? OFFSET ?
  `, [...params, limit, offset]);
  const { rows: pageRows, total } = splitTotal(rows);
  return { rows: pageRows.map(parseRow), total };
}

/**
 * Recent transactions for one user, used by the fraud engine to derive
 * velocity/spending-deviation/geo-distance/device-novelty features.
 * Optionally scoped to before a given timestamp (used by the demo data
 * seeder to backdate history correctly).
 */
async function recentForUser(userId, { before, limit = 20 } = {}) {
  if (before) {
    return db.all(
      `SELECT amount, merchant, location, device_fingerprint, ip_address, created_at
       FROM transactions WHERE user_id = ? AND created_at < ? ORDER BY created_at DESC LIMIT ?`,
      [userId, before, limit]
    );
  }
  return db.all(
    `SELECT amount, merchant, location, device_fingerprint, ip_address, created_at
     FROM transactions WHERE user_id = ? ORDER BY created_at DESC LIMIT ?`,
    [userId, limit]
  );
}

/**
 * Devices/IPs that belong on the hard-rule dynamic blacklist — this is
 * where the analyst feedback loop actually closes (see
 * docs/METHODOLOGY.md and the alerts.resolve verdict). A device/IP is
 * blacklisted when either:
 *   - an analyst has explicitly confirmed a transaction on it as fraud
 *     (`alerts.verdict = 'confirmed_fraud'`), regardless of what the
 *     model originally scored it — this catches medium-risk transactions
 *     a human later confirmed as fraud, not just ones the model already
 *     flagged high; or
 *   - the transaction was scored `is_fraud = 1` and hasn't been
 *     overridden by an analyst marking it a false positive.
 * The second clause is deliberately excluded once `verdict =
 * 'false_positive'` — without that exclusion, a device/IP that
 * triggered one incorrect high-risk score would stay permanently
 * blacklisted even after a human confirms it wasn't actually fraud,
 * which is exactly the "feedback loop doesn't close" gap this fixes.
 */
async function fraudDeviceAndIpBlacklist({ before } = {}) {
  const beforeClause = before ? 'AND t.created_at < ?' : '';
  const baseWhere = `
    (a.verdict = 'confirmed_fraud' OR (t.is_fraud = 1 AND (a.verdict IS NULL OR a.verdict != 'false_positive')))
    ${beforeClause}
  `;
  const deviceSql = `
    SELECT DISTINCT t.device_fingerprint FROM transactions t
    LEFT JOIN alerts a ON a.transaction_id = t.id
    WHERE t.device_fingerprint IS NOT NULL AND ${baseWhere}
  `;
  const ipSql = `
    SELECT DISTINCT t.ip_address FROM transactions t
    LEFT JOIN alerts a ON a.transaction_id = t.id
    WHERE t.ip_address IS NOT NULL AND ${baseWhere}
  `;
  const params = before ? [before] : [];

  const [devices, ips] = await Promise.all([
    db.all(deviceSql, params),
    db.all(ipSql, params),
  ]);
  return {
    devices: new Set(devices.map((r) => r.device_fingerprint)),
    ips: new Set(ips.map((r) => r.ip_address)),
  };
}

/**
 * Inserts one transaction. `created_at` is optional — omit for real-time
 * transactions (the DB's default timestamp applies) or pass an ISO
 * string to backdate a transaction when seeding historical demo data.
 */
async function insert(txn) {
  const cols = [
    'user_id', 'amount', 'merchant', 'category', 'location', 'card_type',
    'device_fingerprint', 'ip_address',
    'is_fraud', 'fraud_score', 'risk_level', 'fraud_reasons',
    'scoring_method', 'model_version', 'hard_flag_triggered', 'shap_explanation',
    'model_probability', 'policy_version', 'ml_latency_ms', 'is_synthetic',
    'status',
    'verification_action', 'verification_mode', 'verification_policy_version', 'verification_enforced', 'verification_note',
    'geo_velocity_status', 'geo_distance_km', 'geo_required_kmh',
  ];
  const values = [
    txn.user_id, txn.amount, txn.merchant, txn.category, txn.location, txn.card_type,
    txn.device_fingerprint || null, txn.ip_address || null,
    txn.is_fraud, txn.fraud_score, txn.risk_level, JSON.stringify(txn.fraud_reasons || []),
    txn.scoring_method || 'rule_engine', txn.model_version || null,
    txn.hard_flag_triggered ? JSON.stringify(txn.hard_flag_triggered) : null,
    JSON.stringify(txn.shap_explanation || []),
    txn.model_probability ?? null, txn.policy_version ?? null, txn.ml_latency_ms ?? null, txn.is_synthetic ? 1 : 0,
    txn.status || 'completed',
    txn.verification_action ?? null, txn.verification_mode ?? null, txn.verification_policy_version ?? null,
    txn.verification_enforced === undefined || txn.verification_enforced === null ? null : (txn.verification_enforced ? 1 : 0), txn.verification_note ?? null,
    txn.geo_velocity_status ?? null, txn.geo_distance_km ?? null, txn.geo_required_kmh ?? null,
  ];
  if (txn.created_at) {
    cols.push('created_at');
    values.push(txn.created_at);
  }
  const placeholders = cols.map(() => '?').join(', ');
  return db.insert(`INSERT INTO transactions (${cols.join(', ')}) VALUES (${placeholders})`, values);
}

async function findById(id) {
  return parseRow(await db.get('SELECT * FROM transactions WHERE id = ?', [id]));
}

/**
 * Caches the generated plain-language explanation (feature: LLM-generated
 * explanations — see services/explanationService.js) so the same alert
 * never regenerates it — or re-bills an LLM call for it — on a second
 * view.
 */
async function savePlainLanguageExplanation(id, text) {
  return db.run('UPDATE transactions SET plain_language_explanation = ? WHERE id = ?', [text, id]);
}

/**
 * Used by the step-up auth flow (feature: step-up authentication — see
 * routes/transactions.js) to move a transaction out of
 * 'pending_step_up' once the challenge is resolved ('completed' on
 * success, 'blocked' on failure).
 */
async function updateStatus(id, status, { onlyFrom } = {}) {
  // `onlyFrom` makes this a compare-and-set: it applies only while the
  // transaction is still in that status (changes === 0 otherwise).
  if (onlyFrom) {
    return db.run('UPDATE transactions SET status = ? WHERE id = ? AND status = ?', [status, id, onlyFrom]);
  }
  return db.run('UPDATE transactions SET status = ? WHERE id = ?', [status, id]);
}

// Dashboard counters that need the whole table, not a page of it: medium-risk ("held for review"), declined
// (status 'blocked') and held (status 'pending_step_up').
const EXTRA_COUNTS = `
      COALESCE(SUM(CASE WHEN risk_level = 'medium' THEN 1 ELSE 0 END), 0) as medium_count,
      COALESCE(SUM(CASE WHEN status = 'blocked' THEN 1 ELSE 0 END), 0) as declined_count,
      COALESCE(SUM(CASE WHEN status = 'pending_step_up' THEN 1 ELSE 0 END), 0) as held_count`;

async function statsForUser(userId) {
  return db.get(`
    SELECT COUNT(*) as total, COALESCE(SUM(is_fraud), 0) as fraud_count,
      COALESCE(SUM(amount), 0) as total_amount, COALESCE(AVG(fraud_score), 0) as avg_fraud_score,
      ${EXTRA_COUNTS}
    FROM transactions WHERE user_id = ?
  `, [userId]);
}

async function statsGlobal() {
  return db.get(`
    SELECT COUNT(*) as total, COALESCE(SUM(is_fraud), 0) as fraud_count,
      COALESCE(SUM(amount), 0) as total_amount, COALESCE(AVG(fraud_score), 0) as avg_fraud_score,
      ${EXTRA_COUNTS}
    FROM transactions
  `);
}

async function adminSummary() {
  return db.get(`
    SELECT COUNT(*) as total, COALESCE(SUM(is_fraud), 0) as fraud_count FROM transactions
  `);
}

module.exports = {
  forUser, allWithUsername, recentForUser, fraudDeviceAndIpBlacklist,
  insert, findById, savePlainLanguageExplanation, updateStatus, statsForUser, statsGlobal, adminSummary, parseRow,
};
