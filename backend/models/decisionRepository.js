/**
 * Decision history (append-only, hash-chained per transaction)
 * ================================================================
 * `transactions` holds the CURRENT decision (what the product acts on).
 * `decision_records` holds EVERY decision ever made about a transaction:
 *   seq 1  the original, written in the same database transaction as the
 *          transaction row (services/transactionPipeline.js);
 *   seq 2+ rescores (services/rescoreService.js). A rescore never overwrites
 *          seq 1; it is a new record, `applied = 0` unless an admin chose to
 *          make it the effective decision.
 * Database triggers refuse UPDATE/DELETE (config/decisionAuditSchema.js).
 *
 * Each record carries `record_hash = sha256(canonical record + prev_hash)`,
 * chaining the records of one transaction; `verifyChain` recomputes it.
 * The hash covers the DIGEST of the feature snapshot / SHAP, not the bulky
 * text, so the retention job can redact those later without breaking the chain.
 * Honest limit: a database superuser who can drop the triggers and recompute
 * hashes can rewrite history; this makes casual or accidental tampering fail
 * loudly and makes deliberate tampering detectable if hashes are exported/anchored elsewhere.
 */
const crypto = require('crypto');
const db = require('../config/database');
const { buildDecisionSpec, ENGINE_VERSION } = require('../services/decisionSnapshot');

const HASHED_FIELDS = [
  'transaction_id', 'seq', 'decision_type', 'applied', 'origin', 'decision_source', 'scoring_method',
  'model_version', 'model_name', 'model_probability', 'raw_probability', 'calibrated',
  'ruleset_version', 'ruleset_hash', 'policy_version', 'thresholds', 'fraud_score', 'risk_level', 'is_fraud',
  'reasons', 'hard_flags', 'features_sha256', 'shap_sha256', 'context', 'engine_version',
  'actor_user_id', 'reason', 'prev_hash', 'created_at',
];

function hashRecord(r) {
  const norm = (v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v); // booleans are stored as 0/1
  const body = JSON.stringify(HASHED_FIELDS.map((f) => norm(r[f])));
  return crypto.createHash('sha256').update(body).digest('hex');
}

/** DB timestamps -> ISO-8601 UTC (SQLite gives 'YYYY-MM-DD HH:MM:SS' or ISO text, Postgres a Date). */
function toIso(v) {
  if (v instanceof Date) return v.toISOString();
  const str = String(v);
  const hasZone = /(Z|[+-]\d\d:?\d\d)$/.test(str);
  return new Date(hasZone ? str : `${str.replace(' ', 'T')}Z`).toISOString();
}

const parseJson = (v) => { if (v === null || v === undefined) return null; try { return JSON.parse(v); } catch { return null; } };

function present(row) {
  if (!row) return null;
  return {
    id: Number(row.id), transaction_id: Number(row.transaction_id), seq: Number(row.seq),
    decision_type: row.decision_type, applied: !!row.applied, origin: row.origin,
    decision_source: row.decision_source, scoring_method: row.scoring_method,
    model_version: row.model_version, model_name: row.model_name,
    model_probability: row.model_probability, raw_probability: row.raw_probability,
    calibrated: row.calibrated === null || row.calibrated === undefined ? null : !!row.calibrated,
    ruleset_version: row.ruleset_version === null ? null : Number(row.ruleset_version), ruleset_hash: row.ruleset_hash,
    policy_version: row.policy_version === null ? null : Number(row.policy_version),
    thresholds: parseJson(row.thresholds), fraud_score: row.fraud_score, risk_level: row.risk_level, is_fraud: !!row.is_fraud,
    reasons: parseJson(row.reasons) || [], hard_flags: parseJson(row.hard_flags),
    shap: parseJson(row.shap), feature_snapshot: parseJson(row.feature_snapshot), features_sha256: row.features_sha256,
    context: parseJson(row.context) || {}, engine_version: row.engine_version,
    actor_user_id: row.actor_user_id ?? null, actor_username: row.actor_username ?? null, reason: row.reason,
    prev_hash: row.prev_hash, record_hash: row.record_hash, redacted_at: row.redacted_at, created_at: row.created_at,
  };
}

/** Appends a record. Call inside the caller's DB transaction when atomicity with other writes matters. */
async function append(transactionId, spec, { createdAt } = {}) {
  const last = await db.get('SELECT seq, record_hash FROM decision_records WHERE transaction_id = ? ORDER BY seq DESC LIMIT 1', [transactionId]);
  const row = {
    ...spec,
    transaction_id: transactionId,
    seq: last ? Number(last.seq) + 1 : 1,
    prev_hash: last ? last.record_hash : null,
    created_at: createdAt || new Date().toISOString(),
  };
  row.record_hash = hashRecord(row);
  const cols = ['transaction_id', 'seq', 'decision_type', 'applied', 'origin', 'decision_source', 'scoring_method', 'model_version', 'model_name',
    'model_probability', 'raw_probability', 'calibrated', 'ruleset_version', 'ruleset_hash', 'policy_version', 'thresholds', 'fraud_score',
    'risk_level', 'is_fraud', 'reasons', 'hard_flags', 'shap', 'feature_snapshot', 'features_sha256', 'shap_sha256', 'context', 'engine_version',
    'actor_user_id', 'actor_username', 'reason', 'prev_hash', 'record_hash', 'created_at'];
  await db.insert(
    `INSERT INTO decision_records (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
    cols.map((c) => (row[c] === undefined ? null : (typeof row[c] === 'boolean' ? (row[c] ? 1 : 0) : row[c])))
  );
  return { seq: row.seq, record_hash: row.record_hash };
}

async function list(transactionId) {
  const rows = await db.all('SELECT * FROM decision_records WHERE transaction_id = ? ORDER BY seq ASC', [transactionId]);
  return rows.map(present);
}

/**
 * Transactions written before this audit trail existed (or inserted by a script) have no record.
 * Creates seq 1 from the stored row, honestly marked origin='backfill': the original model inputs,
 * rule-set version and thresholds were NOT captured then and are not invented now.
 */
async function ensureBaseline(txn) {
  const existing = await db.get('SELECT id FROM decision_records WHERE transaction_id = ? LIMIT 1', [txn.id]);
  if (existing) return false;
  const method = txn.scoring_method || 'rule_engine';
  const source = String(method).startsWith('hard_rule_override') ? 'hard_rule' : String(method).startsWith('ml_model') ? 'ml' : 'fallback';
  const parse = (v) => { try { return typeof v === 'string' ? JSON.parse(v) : v; } catch { return null; } };
  const reasons = parse(txn.fraud_reasons) || [];
  const shap = parse(txn.shap_explanation) || [];
  const hard = parse(txn.hard_flag_triggered);
  const shapJson = JSON.stringify(shap);
  const spec = {
    decision_type: 'original', applied: 1, origin: 'backfill', decision_source: source, scoring_method: method,
    model_version: txn.model_version || null, model_name: null, model_probability: txn.model_probability ?? null, raw_probability: null, calibrated: null,
    ruleset_version: null, ruleset_hash: null, policy_version: txn.policy_version ?? null,
    thresholds: JSON.stringify({ basis: 'unknown', note: 'Recorded before decision auditing existed; the thresholds in force were not captured.' }),
    fraud_score: txn.fraud_score, risk_level: txn.risk_level, is_fraud: txn.is_fraud ? 1 : 0,
    reasons: JSON.stringify(reasons), hard_flags: hard ? JSON.stringify(hard) : null, shap: shapJson, feature_snapshot: null,
    features_sha256: null, shap_sha256: require('crypto').createHash('sha256').update(shapJson).digest('hex'),
    context: JSON.stringify({ backfilled_at: new Date().toISOString(), note: 'Reconstructed from the stored transaction row. Model inputs, rule-set version and thresholds were not captured at the time.' }),
    engine_version: ENGINE_VERSION, actor_user_id: null, actor_username: null, reason: 'backfill',
  };
  const created = toIso(txn.created_at);
  try {
    await append(txn.id, spec, { createdAt: created });
    return true;
  } catch (err) {
    if (/unique|duplicate/i.test(err.message)) return false; // another request backfilled first
    throw err;
  }
}

/** Recomputes every hash and link. Returns { valid, records, problems[] }. */
async function verifyChain(transactionId) {
  const rows = await db.all('SELECT * FROM decision_records WHERE transaction_id = ? ORDER BY seq ASC', [transactionId]);
  const problems = [];
  let prev = null;
  rows.forEach((r, i) => {
    if (Number(r.seq) !== i + 1) problems.push(`seq ${r.seq}: expected ${i + 1} (a record is missing)`);
    if ((r.prev_hash || null) !== prev) problems.push(`seq ${r.seq}: prev_hash does not match the previous record`);
    if (hashRecord(r) !== r.record_hash) problems.push(`seq ${r.seq}: contents do not match record_hash`);
    prev = r.record_hash;
  });
  return { valid: problems.length === 0, records: rows.length, problems };
}

/**
 * Opens the retention gate for the duration of fn (inside one DB transaction), then closes it.
 * ONLY the retention job, the demo-data reset and tests may call this; no HTTP route does.
 */
async function withRetentionGate(fn) {
  return db.transaction(async () => {
    await db.run('UPDATE retention_gate SET unlocked = 1');
    try {
      return await fn();
    } finally {
      await db.run('UPDATE retention_gate SET unlocked = 0');
    }
  });
}

/** Deletes decision records (and audit rows are untouched) for transactions about to be removed (demo reset, tests). */
async function purgeForTransactions(transactionIds) {
  if (!transactionIds.length) return 0;
  const ph = transactionIds.map(() => '?').join(',');
  return withRetentionGate(async () => {
    await db.run(`DELETE FROM decision_records WHERE transaction_id IN (${ph})`, transactionIds);
    return transactionIds.length;
  });
}

module.exports = { toIso, withRetentionGate, purgeForTransactions, append, list, ensureBaseline, verifyChain, hashRecord, present, buildDecisionSpec };
