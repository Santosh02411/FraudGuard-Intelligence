/**
 * ML Scoring Client
 * ===================
 * Calls the Python FastAPI ML service (ml_service/app.py) which scores a
 * transaction using the currently-promoted model version (see
 * ml_service/models/registry/).
 *
 * Derives every behavioral feature the model expects from the user's own
 * transaction history in SQLite — the current transaction form only
 * collects amount/merchant/category/location/card_type, so velocity,
 * time-since-last-transaction, spending-pattern deviation, geo-distance,
 * and device/IP novelty are all computed here, server-side, from real
 * history (not sent by the client — a client could lie about those).
 */

const { haversineKm } = require('./geo');
const config = require('../config/env');

const ML_SERVICE_URL = config.mlServiceUrl;
const ML_TIMEOUT_MS = config.mlServiceTimeoutMs;

/**
 * Builds the ML feature payload from the new transaction + the user's
 * recent transaction history (already fetched by the caller, most-recent
 * first, including device_fingerprint/ip_address/location/amount/merchant).
 *
 * @param {Date} [referenceTime] - "now", for velocity/time-since-last
 *   calculations. Defaults to the real current time for live traffic;
 *   the demo seed generator (scripts/generateDemoData.js) passes a
 *   simulated historical timestamp instead, so seeded transactions get
 *   scored against the transaction time they claim to have happened at,
 *   not the moment the seed script actually ran.
 */
function buildFeaturePayload(txn, recentTxns, referenceTime) {
  const now = referenceTime || new Date();
  const oneHourAgo = now.getTime() - 60 * 60 * 1000;

  // --- Velocity ---
  const velocity_last_hour = recentTxns.filter(
    (t) => new Date(t.created_at).getTime() > oneHourAgo
  ).length;

  // --- Time since last transaction ---
  const time_since_last_transaction_minutes = recentTxns.length
    ? (now.getTime() - new Date(recentTxns[0].created_at).getTime()) / 60000
    : 1440; // no history -> treat as "a day since last activity"

  // --- Spending pattern deviation (z-score vs. the user's own history) ---
  const amounts = recentTxns.map((t) => t.amount).filter((a) => typeof a === 'number');
  let spending_zscore = 0;
  let ratio_to_median_purchase_price = 1;
  if (amounts.length >= 3) {
    const mean = amounts.reduce((a, b) => a + b, 0) / amounts.length;
    const variance = amounts.reduce((a, b) => a + (b - mean) ** 2, 0) / amounts.length;
    const std = Math.sqrt(variance) || 1;
    spending_zscore = (txn.amount - mean) / std;
    ratio_to_median_purchase_price = txn.amount / (median(amounts) || 1);
  }

  // --- Geo-distance: home location deviation + jump from last transaction ---
  const locations = recentTxns.map((t) => t.location);
  const home_location = mostCommon(locations) || txn.location;
  const distance_from_home = haversineKm(home_location, txn.location);

  const last_location = recentTxns.length ? recentTxns[0].location : txn.location;
  const geo_distance_from_last_km = haversineKm(last_location, txn.location);

  // --- Repeat retailer ---
  const merchants = recentTxns.map((t) => t.merchant);
  const repeat_retailer = merchants.includes(txn.merchant) ? 1 : 0;

  // --- Device / IP fingerprinting ---
  const knownDevices = new Set(recentTxns.map((t) => t.device_fingerprint).filter(Boolean));
  const knownIps = new Set(recentTxns.map((t) => t.ip_address).filter(Boolean));
  const is_new_device = txn.device_fingerprint ? (knownDevices.has(txn.device_fingerprint) ? 0 : 1) : 0;
  let ip_status = 'known';
  if (!txn.ip_address) {
    ip_status = 'unknown';
  } else if (recentTxns.length === 0) {
    ip_status = 'known'; // first-ever transaction: nothing to compare against
  } else if (!knownIps.has(txn.ip_address)) {
    ip_status = 'new';
  }

  const hour = now.getHours();
  const day_of_week = now.getDay();

  return {
    amount: txn.amount,
    category: txn.category,
    location: txn.location,
    card_type: txn.card_type,
    hour,
    day_of_week,
    distance_from_home,
    geo_distance_from_last_km,
    time_since_last_transaction_minutes: Number(time_since_last_transaction_minutes.toFixed(1)),
    ratio_to_median_purchase_price: Number(ratio_to_median_purchase_price.toFixed(3)),
    spending_zscore: Number(spending_zscore.toFixed(3)),
    repeat_retailer,
    used_chip: 0,
    used_pin_number: 0,
    online_order: 1, // web-app transactions are card-not-present by definition
    velocity_last_hour,
    is_new_device,
    ip_status,
  };
}

function median(nums) {
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function mostCommon(arr) {
  if (!arr.length) return null;
  const counts = {};
  let best = arr[0];
  for (const v of arr) {
    counts[v] = (counts[v] || 0) + 1;
    if (counts[v] > (counts[best] || 0)) best = v;
  }
  return best;
}

/** An Error carrying a machine-readable failure class: timeout | unreachable | http_error | invalid_score. */
function mlError(message, kind) {
  const e = new Error(message);
  e.kind = kind;
  return e;
}

/**
 * Calls the ML service. Throws on failure/timeout so the caller can fall
 * back to the rule-based engine (see fraudEngine.js hybrid logic).
 */
async function scoreWithML(txn, recentTxns, referenceTime, policy, featurePayload) {
  // `featurePayload` lets a RESCORE send the exact stored feature snapshot instead of re-deriving it.
  const payload = featurePayload || buildFeaturePayload(txn, recentTxns, referenceTime);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ML_TIMEOUT_MS);

  try {
    // The ML service returns a PROBABILITY and makes no policy decision. The
    // live thresholds are passed only so its shadow-model comparison log
    // agrees with the policy actually in force.
    const query = policy ? `?medium=${policy.medium_threshold}&high=${policy.high_threshold}` : '';
    const response = await fetch(`${ML_SERVICE_URL}/predict${query}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(config.mlServiceApiKey ? { 'X-ML-Api-Key': config.mlServiceApiKey } : {}),
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw mlError(`ML service responded with status ${response.status}`, 'http_error');
    }

    const result = await response.json();
    // Never trust the other service's output blindly: a 200 with a missing/garbled score must become a
    // fallback (caller catches), not a NaN that silently turns into a risk decision.
    const okProb = typeof result?.fraud_probability === 'number' && Number.isFinite(result.fraud_probability) && result.fraud_probability >= 0 && result.fraud_probability <= 1;
    const okScore = typeof result?.fraud_score === 'number' && Number.isFinite(result.fraud_score) && result.fraud_score >= 0 && result.fraud_score <= 100;
    if (!okProb && !okScore) throw mlError('ML service returned an invalid score', 'invalid_score');
    // Backward compatible with a ML service that predates calibration: fall
    // back to fraud_score/100 and mark it uncalibrated.
    const probability = typeof result.fraud_probability === 'number' ? result.fraud_probability : result.fraud_score / 100;
    return {
      ml_calibrated: result.calibrated === true,
      fraud_score: result.fraud_score,           // = calibrated probability x 100
      model_probability: probability,            // calibrated P(fraud), 0-1
      raw_probability: result.raw_probability ?? null,
      calibrated: result.calibrated === true,
      // NOTE: no risk_level / is_fraud here on purpose — turning a probability
      // into a decision is the backend's risk policy (riskPolicyRepository).
      model_used: result.model_used,
      model_version: result.model_version,
      // Challenger score, when a shadow model is active — recorded per
      // transaction so it can later be judged against analyst verdicts.
      shadow: result.shadow && typeof result.shadow.fraud_probability === 'number' ? result.shadow : null,
      top_factors: result.top_factors || [], // [{feature, shap_value, effect}]
      // The exact feature payload the model scored — the hybrid layer's
      // calibration guard (fraudEngine.js) reads amount/geo outliers from it.
      features: payload,
      // What the model silently filled in: inputs the caller did not send (schema defaults were used) and categorical
      // values it never saw in training. Persisted by services/inferenceLog.js for the monitoring views.
      feature_quality: result.feature_quality && typeof result.feature_quality === 'object' ? result.feature_quality : null,
      source: 'ml_model',
    };
  } catch (err) {
    if (!err.kind) err.kind = err.name === 'AbortError' ? 'timeout' : 'unreachable';
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = { scoreWithML, buildFeaturePayload };
