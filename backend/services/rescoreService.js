/**
 * Rescoring without rewriting history
 * ======================================
 * A rescore answers "what would we decide NOW?" about an existing transaction.
 * It never edits the original decision. It APPENDS a record (decision_type
 * 'rescore') to the append-only history, and by default leaves the transaction's
 * effective decision untouched (applied = 0, a dry run that is still recorded).
 * An admin may pass apply=true to make the new decision the effective one; the
 * previous effective decision then remains in the history, and the change is audited
 * with before/after values.
 *
 * Inputs: the STORED feature snapshot (so the model sees what it saw originally, not
 * features re-derived from today's history), the CURRENT model, rule set, risk policy and
 * fraud-device blacklist. If the ML service is unavailable the rescore is refused: a
 * rule-engine fallback result must not be presented as "the model's opinion today".
 */
const db = require('../config/database');
const { AppError } = require('../middleware/errorHandler');
const transactionRepository = require('../models/transactionRepository');
const alertRepository = require('../models/alertRepository');
const decisionRepository = require('../models/decisionRepository');
const fraudRuleRepository = require('../models/fraudRuleRepository');
const riskPolicyRepository = require('../models/riskPolicyRepository');
const { analyzeTransactionHybrid } = require('../models/fraudEngine');
const { networkRiskForTransaction } = require('../models/networkRepository');
const { buildDecisionSpec } = require('./decisionSnapshot');

const DECISION_FIELDS = ['is_fraud', 'fraud_score', 'risk_level', 'scoring_method', 'model_version', 'policy_version'];

const effective = (t) => ({
  is_fraud: !!t.is_fraud, fraud_score: t.fraud_score, risk_level: t.risk_level,
  scoring_method: t.scoring_method, model_version: t.model_version, policy_version: t.policy_version,
});

function diff(before, after) {
  const out = {};
  for (const k of DECISION_FIELDS) if (before[k] !== after[k]) out[k] = { before: before[k], after: after[k] };
  return out;
}

async function rescore({ transactionId, actor, reason, apply = false }) {
  const txn = await transactionRepository.findById(transactionId);
  if (!txn) throw AppError.notFound('Transaction not found');

  await decisionRepository.ensureBaseline(txn); // transactions from before decision auditing get a labelled baseline
  const history = await decisionRepository.list(transactionId);
  const original = history[0];
  const snapshot = [...history].reverse().find((r) => r.feature_snapshot)?.feature_snapshot || null;

  const [ruleSet, policy, blacklist] = await Promise.all([
    fraudRuleRepository.getActiveRuleSet(),
    riskPolicyRepository.getActive(),
    transactionRepository.fraudDeviceAndIpBlacklist(),
  ]);
  const createdIso = decisionRepository.toIso(txn.created_at);
  const recent = await transactionRepository.recentForUser(txn.user_id, { before: createdIso });
  const networkRisk = await networkRiskForTransaction(txn, txn.user_id);

  const analysis = await analyzeTransactionHybrid(
    txn, recent, blacklist, new Date(createdIso), networkRisk, ruleSet.config, policy,
    snapshot ? { featurePayload: snapshot } : {}
  );

  if (analysis.scoring_method.startsWith('rule_engine_fallback')) {
    throw new AppError('The ML service is unavailable, so a rescore would only be a rule-engine fallback result. Nothing was recorded; try again when the model is reachable.', 503);
  }

  const before = effective(txn);
  const spec = buildDecisionSpec({
    analysis, ruleSet, historyCount: recent.length, decisionType: 'rescore', origin: snapshot ? 'rescore_stored_snapshot' : 'rescore_rederived_features',
    applied: apply, actor, reason,
  });
  const after = { is_fraud: !!analysis.is_fraud, fraud_score: analysis.fraud_score, risk_level: analysis.risk_level, scoring_method: analysis.scoring_method, model_version: analysis.model_version || null, policy_version: analysis.policy_version ?? null };

  const result = await db.transaction(async () => {
    const rec = await decisionRepository.append(transactionId, spec);
    let alertCreated = false;
    if (apply) {
      await db.run(
        `UPDATE transactions SET is_fraud = ?, fraud_score = ?, risk_level = ?, fraud_reasons = ?, scoring_method = ?, model_version = ?,
           hard_flag_triggered = ?, shap_explanation = ?, model_probability = ?, policy_version = ? WHERE id = ?`,
        [analysis.is_fraud ? 1 : 0, analysis.fraud_score, analysis.risk_level, JSON.stringify(analysis.fraud_reasons || []), analysis.scoring_method,
          analysis.model_version || null, analysis.hard_flag_triggered ? JSON.stringify(analysis.hard_flag_triggered) : null,
          JSON.stringify(analysis.shap_explanation || []), analysis.model_probability ?? null, analysis.policy_version ?? null, transactionId]
      );
      if (analysis.risk_level === 'high' || analysis.risk_level === 'medium') {
        const r = await alertRepository.insertOnce({
          transaction_id: transactionId, user_id: txn.user_id, risk_level: analysis.risk_level, amount: txn.amount,
          message: `${analysis.risk_level === 'high' ? 'High risk' : 'Medium risk'} transaction at ${txn.merchant} (raised by rescore). Amount: $${Number(txn.amount).toFixed(2)}`,
        });
        alertCreated = r.created;
      }
    }
    return { rec, alertCreated };
  });

  return {
    transaction_id: transactionId, applied: !!apply, recorded_seq: result.rec.seq, alert_created: result.alertCreated,
    original: { seq: original.seq, origin: original.origin, decision_source: original.decision_source, fraud_score: original.fraud_score, risk_level: original.risk_level, is_fraud: original.is_fraud, model_version: original.model_version, ruleset_version: original.ruleset_version },
    before, after, changed: diff(before, after),
    inputs: { used_stored_feature_snapshot: !!snapshot, ruleset_version: ruleSet.version, policy_version: analysis.policy_version ?? null, model_version: analysis.model_version || null },
  };
}

module.exports = { rescore, diff };
