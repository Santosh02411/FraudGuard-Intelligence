/**
 * Turns the fraud engine's result into an auditable decision record.
 *
 * What is stored is the EVIDENCE needed to reconstruct a decision, copied at
 * decision time (not referenced), because the things it depends on change:
 * the model is promoted, the thresholds are edited, rules are added.
 *
 * Deliberately NOT stored: raw IP address, device fingerprint, card data,
 * names/emails, auth tokens. The feature snapshot holds the behavioural
 * features the model saw (amount, category, location, time features,
 * velocity, new-device/IP flags...), not the identifiers they were derived from.
 */
const crypto = require('crypto');
const { RULE_ENGINE_POLICY, NETWORK_WATCH_SCORE_BOOST } = require('../models/fraudEngine');
const pkg = require('../package.json');

const DECISION_SCHEMA_VERSION = 1;
const ENGINE_VERSION = `fraudguard-backend@${pkg.version}/decision-schema-${DECISION_SCHEMA_VERSION}`;

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

/** 'ml' | 'hard_rule' | 'fallback' */
function decisionSource(scoringMethod) {
  const m = String(scoringMethod || '');
  if (m.startsWith('hard_rule_override')) return 'hard_rule';
  if (m.startsWith('ml_model')) return 'ml';
  return 'fallback';
}

/** The numeric thresholds that turned the score into a level for THIS decision. */
function thresholdsFor(analysis) {
  const source = decisionSource(analysis.scoring_method);
  const policy = analysis.policy_used || {};
  if (source === 'fallback') {
    return { basis: 'rule_engine_fixed', medium_threshold: RULE_ENGINE_POLICY.medium_threshold, high_threshold: RULE_ENGINE_POLICY.high_threshold, units: 'rule-engine points (0-100), not a probability' };
  }
  if (source === 'hard_rule') {
    return { basis: 'hard_rule_override', note: 'A hard rule fixed the outcome (score 100 / high) regardless of thresholds.', reference_policy: { policy_version: policy.version ?? null, medium_threshold: policy.medium_threshold ?? null, high_threshold: policy.high_threshold ?? null } };
  }
  return { basis: 'risk_policy', policy_version: policy.version ?? null, medium_threshold: policy.medium_threshold ?? null, high_threshold: policy.high_threshold ?? null, units: 'calibrated probability x 100' };
}

/**
 * @param {object} p
 * @param {object} p.analysis        result of analyzeTransactionHybrid
 * @param {object} p.ruleSet         { version, hash } the rules were taken from
 * @param {number} [p.historyCount]  how many prior transactions the features were derived from
 */
function buildDecisionSpec({ analysis, ruleSet, historyCount = null, decisionType = 'original', origin = 'live', applied = true, actor = null, reason = null }) {
  const method = analysis.scoring_method;
  const features = analysis.feature_snapshot || null;
  const shap = analysis.shap_explanation || [];
  const featuresJson = features ? JSON.stringify(features) : null;
  const shapJson = JSON.stringify(shap);
  return {
    decision_type: decisionType,
    applied,
    origin,
    decision_source: decisionSource(method),
    scoring_method: method,
    model_version: analysis.model_version || null,
    model_name: analysis.model_used || null,
    model_probability: analysis.model_probability ?? null,
    raw_probability: analysis.ml_raw_probability ?? null,
    calibrated: analysis.ml_calibrated === null || analysis.ml_calibrated === undefined ? null : (analysis.ml_calibrated ? 1 : 0),
    ruleset_version: ruleSet?.version ?? null,
    ruleset_hash: ruleSet?.hash ?? null,
    policy_version: analysis.policy_version ?? analysis.policy_used?.version ?? null,
    thresholds: JSON.stringify(thresholdsFor(analysis)),
    fraud_score: analysis.fraud_score,
    risk_level: analysis.risk_level,
    is_fraud: analysis.is_fraud ? 1 : 0,
    reasons: JSON.stringify(analysis.fraud_reasons || []),
    hard_flags: analysis.hard_flag_triggered ? JSON.stringify(analysis.hard_flag_triggered) : null,
    shap: shapJson,
    feature_snapshot: featuresJson,
    features_sha256: featuresJson ? sha256(featuresJson) : null,
    shap_sha256: sha256(shapJson),
    context: JSON.stringify({
      ml: {
        status: analysis.ml_error ? 'unavailable' : (analysis.model_version ? 'scored' : 'not_used'),
        error: analysis.ml_error ? String(analysis.ml_error).slice(0, 200) : null,
        latency_ms: analysis.ml_latency_ms ?? null,
      },
      rule_engine_score: analysis.rule_engine_score ?? null,
      ml_score_before_calibration_guard: analysis.ml_score_for_reference ?? null,
      calibration_guard_applied: String(method).includes('calibration_floor'),
      network_signal: analysis.network_signal || { triggered: false },
      network_watch_score_boost: String(method).includes('network_watch') ? NETWORK_WATCH_SCORE_BOOST : null,
      history_transactions_considered: historyCount,
    }),
    engine_version: ENGINE_VERSION,
    actor_user_id: actor?.id ?? null,
    actor_username: actor?.username ?? null,
    reason,
  };
}

/** What may be sent outside the building (webhooks, API responses): the outcome and its reasons, not the model's internals. */
function publicAnalysis(analysis) {
  return {
    is_fraud: analysis.is_fraud,
    fraud_score: analysis.fraud_score,
    risk_level: analysis.risk_level,
    fraud_reasons: analysis.fraud_reasons,
    scoring_method: analysis.scoring_method,
    model_used: analysis.model_used || null,
    model_version: analysis.model_version || null,
    hard_flag_triggered: analysis.hard_flag_triggered || null,
    shap_explanation: analysis.shap_explanation || [],
  };
}

module.exports = { buildDecisionSpec, publicAnalysis, thresholdsFor, decisionSource, ENGINE_VERSION, sha256, DECISION_SCHEMA_VERSION };
