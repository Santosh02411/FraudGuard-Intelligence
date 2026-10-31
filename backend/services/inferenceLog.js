/**
 * Durable per-inference record (real traffic only) — what the monitoring views are built from.
 *
 * The ML service keeps a rolling in-memory/SQLite buffer for its own drift report; that is the hot path and it is
 * per-process. THIS is the system of record: every real scoring attempt (success OR failure) is written to the backend
 * database with the exact input features the model saw, the served score, latency, the failure class, which inputs were
 * missing/defaulted/unseen, and four customer-segment keys. Windows and segments are reconstructed from it, so they
 * survive restarts of either service. Behavioural features only: no IP address, device fingerprint, user id or merchant.
 */
const db = require('../config/database');
const logger = require('../config/logger');

const SEGMENT_DIMS = [
  { dim: 'category', column: 'seg_category' },
  { dim: 'amount_band', column: 'seg_amount_band' },
  { dim: 'card_type', column: 'seg_card_type' },
  { dim: 'device', column: 'seg_device' },
];

function amountBand(a) {
  const n = Number(a);
  if (!Number.isFinite(n)) return 'unknown';
  if (n < 50) return 'under_50';
  if (n < 500) return '50_to_500';
  if (n < 2000) return '500_to_2000';
  return '2000_plus';
}

const isMissing = (v) => v === null || v === undefined || (typeof v === 'number' && !Number.isFinite(v)) || v === '';

/** Fields the model was given no real value for: invalid on our side, or defaulted/unseen according to the ML service. */
function missingFields(features, quality) {
  const out = new Set();
  for (const [k, v] of Object.entries(features || {})) if (isMissing(v)) out.add(k);
  for (const k of quality?.defaulted || []) out.add(k);
  return [...out].sort();
}

function buildRecord({ transactionId, analysis, txn, now = new Date() }) {
  const features = analysis.feature_snapshot || null;
  const ok = !analysis.ml_error && analysis.model_version;
  return {
    transaction_id: transactionId ?? null,
    created_at: now.toISOString(),
    model_version: ok ? analysis.model_version : null,
    outcome: ok ? 'ok' : (analysis.ml_error_kind || 'unreachable'),
    latency_ms: Number.isFinite(analysis.ml_latency_ms) ? Math.round(analysis.ml_latency_ms) : null,
    score: ok && Number.isFinite(analysis.fraud_score) && analysis.scoring_method !== 'rule_engine' && analysis.model_probability != null ? Math.round(analysis.model_probability * 10000) / 100 : null,
    features: features ? JSON.stringify(features) : null,
    missing: JSON.stringify(missingFields(features, analysis.ml_feature_quality)),
    unseen: JSON.stringify(analysis.ml_feature_quality?.unseen_categories || {}),
    seg_category: txn.category || 'unknown',
    seg_amount_band: amountBand(txn.amount),
    seg_card_type: txn.card_type || 'unknown',
    seg_device: features && Number(features.is_new_device) === 1 ? 'new_device' : 'known_device',
  };
}

/** Best-effort: a monitoring write must never fail or slow a transaction. */
async function record(args) {
  try {
    const r = buildRecord(args);
    await db.run(
      `INSERT INTO model_inference_log (transaction_id, created_at, model_version, outcome, latency_ms, score, features, missing, unseen, seg_category, seg_amount_band, seg_card_type, seg_device)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [r.transaction_id, r.created_at, r.model_version, r.outcome, r.latency_ms, r.score, r.features, r.missing, r.unseen, r.seg_category, r.seg_amount_band, r.seg_card_type, r.seg_device]);
  } catch (err) {
    logger.warn('Could not write the inference log', { error: err.message });
  }
}

const parse = (s, d) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };

/** Rows of a window. Failures carry no model_version, so they are included regardless of version (they are about the ML service). */
async function loadWindow({ version, sinceIso, untilIso }) {
  const rows = await db.all(
    `SELECT * FROM model_inference_log WHERE created_at >= ? AND created_at < ? AND (model_version = ? OR model_version IS NULL) ORDER BY id`, [sinceIso, untilIso, version]);
  return rows.map((r) => ({ ...r, features: parse(r.features, null), missing: parse(r.missing, []), unseen: parse(r.unseen, {}), latency_ms: r.latency_ms === null ? null : Number(r.latency_ms), score: r.score === null ? null : Number(r.score) }));
}

async function prune(days) {
  const cutoff = new Date(Date.now() - days * 86400000).toISOString();
  const r = await db.run('DELETE FROM model_inference_log WHERE created_at < ?', [cutoff]);
  return r.changes || 0;
}

module.exports = { record, buildRecord, loadWindow, prune, amountBand, missingFields, SEGMENT_DIMS };
