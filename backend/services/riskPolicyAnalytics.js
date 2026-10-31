/**
 * Risk-policy analytics
 * =======================
 * Answers two operator questions from the data the system already holds:
 *
 *   simulate():          "If I move the thresholds, what happens to missed
 *                         fraud and to legitimate transactions I flag?"
 *   calibrationReport(): "Does a score of 80 still mean what it claims?"
 *                         — plus how hard-rule overrides perform ON THEIR OWN.
 *
 * Ground truth is the analyst verdict on alerts (alerts.verdict). That has a
 * built-in selection bias which these functions state rather than hide:
 * only transactions that were flagged get an alert, so labels exist only at
 * or above the threshold that was in force. Lowering a threshold below that
 * floor flags transactions nobody has ever reviewed — their precision can't
 * be measured, only their number.
 */

const db = require('../config/database');

const SWEEP_THRESHOLDS = [1, 2, 3, 5, 7.5, 10, 15, 20, 30, 40, 50, 60, 70, 80, 90];
const CALIBRATION_EDGES = [0, 5, 10, 20, 40, 60, 80, 100.0001];
const MIN_LABELS_FOR_ESTIMATES = 30;
const MIN_BUCKET_FOR_STATUS = 20;

function methodGroup(method = '') {
  if (method.startsWith('hard_rule_override')) return 'hard_rule_override';
  if (method.includes('calibration_floor')) return 'calibration_floor';
  if (method.includes('network_watch')) return 'model_with_network_boost';
  if (method.startsWith('ml_model')) return 'model';
  if (method.startsWith('rule_engine')) return 'rule_engine_fallback';
  return 'other';
}

function dateFilter(column) {
  return db.dialect === 'postgres' ? `${column}::date >= ?::date` : `date(${column}) >= date(?)`;
}

async function loadRows(days) {
  const cutoff = new Date(Date.now() - days * 86400000).toISOString();
  const rows = await db.all(
    `SELECT t.id, t.model_probability, t.fraud_score, t.risk_level, t.scoring_method, t.policy_version, t.created_at,
            a.verdict AS verdict, a.id AS alert_id, d.id AS dispute_id
       FROM transactions t
       LEFT JOIN alerts a ON a.transaction_id = t.id
       LEFT JOIN disputes d ON d.transaction_id = t.id
      WHERE ${dateFilter('t.created_at')}`,
    [cutoff]
  );
  return rows.map((r) => {
    const group = methodGroup(r.scoring_method);
    const hasProb = r.model_probability !== null && r.model_probability !== undefined;
    return {
      id: r.id,
      score: hasProb ? Number(r.model_probability) * 100 : null,
      modelProbability: hasProb ? Number(r.model_probability) : null,
      group,
      override: group === 'hard_rule_override',
      historicRisk: r.risk_level,
      label: r.verdict === 'confirmed_fraud' ? 'fraud'
        : r.verdict === 'false_positive' ? 'legit'
        : r.alert_id ? 'unreviewed' : 'none',
      hasAlert: Boolean(r.alert_id),
      disputed: Boolean(r.dispute_id),
    };
  });
}

/** Wilson score interval for a binomial proportion — honest about small n. */
function wilson(k, n, z = 1.96) {
  if (!n) return [null, null];
  const p = k / n;
  const d = 1 + (z * z) / n;
  const c = p + (z * z) / (2 * n);
  const m = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [Math.max(0, (c - m) / d), Math.min(1, (c + m) / d)];
}

const r4 = (x) => (x === null || x === undefined ? null : Math.round(x * 10000) / 10000);

/** Decision for one row under candidate thresholds. Rows the thresholds
 *  cannot influence (hard-rule overrides, rule-engine fallback / unscored
 *  rows) keep their historic outcome. */
function decide(row, medium, high) {
  if (row.override) return { flagged: true, high: true, affected: false };
  if (row.score === null) {
    return { flagged: row.historicRisk !== 'low', high: row.historicRisk === 'high', affected: false };
  }
  return { flagged: row.score >= medium, high: row.score >= high, affected: true };
}

function metricsFor(rows, medium, high, days, capacity) {
  const m = { flagged: 0, high_tier: 0, confirmed_fraud_caught: 0, false_positives: 0, unreviewed: 0, flagged_without_label: 0,
    confirmed_fraud_missed: 0, disputed_but_not_flagged: 0 };
  for (const r of rows) {
    const d = decide(r, medium, high);
    if (d.flagged) {
      m.flagged += 1;
      if (d.high) m.high_tier += 1;
      if (r.label === 'fraud') m.confirmed_fraud_caught += 1;
      else if (r.label === 'legit') m.false_positives += 1;
      else if (r.label === 'unreviewed') m.unreviewed += 1;
      else m.flagged_without_label += 1;
    } else {
      if (r.label === 'fraud') m.confirmed_fraud_missed += 1;
      if (r.disputed && r.label !== 'fraud') m.disputed_but_not_flagged += 1;
    }
  }
  const reviewed = m.confirmed_fraud_caught + m.false_positives;
  const knownFraud = m.confirmed_fraud_caught + m.confirmed_fraud_missed;
  const out = {
    medium_threshold: medium, high_threshold: high,
    ...m,
    flagged_rate: rows.length ? r4(m.flagged / rows.length) : null,
    flagged_per_day: r4(m.flagged / days),
    precision_of_reviewed_flags: reviewed ? r4(m.confirmed_fraud_caught / reviewed) : null,
    recall_of_confirmed_fraud: knownFraud ? r4(m.confirmed_fraud_caught / knownFraud) : null,
  };
  if (capacity) out.exceeds_review_capacity = out.flagged_per_day > capacity;
  return out;
}

function labelCoverageFloor(rows) {
  // Lowest model score that ever produced an alert: below this there are no
  // labels at all, because nothing was flagged there.
  const scores = rows.filter((r) => r.score !== null && !r.override && r.hasAlert).map((r) => r.score);
  return scores.length ? Math.min(...scores) : null;
}

async function simulate({ medium_threshold, high_threshold, days, review_capacity_per_day = null }, activePolicy) {
  const rows = await loadRows(days);
  const floor = labelCoverageFloor(rows);
  const labeled = rows.filter((r) => r.label === 'fraud' || r.label === 'legit').length;

  const current = metricsFor(rows, activePolicy.medium_threshold, activePolicy.high_threshold, days, activePolicy.review_capacity_per_day);
  const capacity = review_capacity_per_day ?? activePolicy.review_capacity_per_day;
  const candidate = metricsFor(rows, medium_threshold, high_threshold, days, capacity);

  const warnings = [];
  const labelsIncomplete = floor !== null && medium_threshold < floor - 1e-9;
  if (labelsIncomplete) {
    const unreviewed = rows.filter((r) => r.score !== null && !r.override && !r.hasAlert && r.score >= medium_threshold && r.score < floor).length;
    candidate.newly_flagged_never_reviewed = unreviewed;
    warnings.push(`Labels only exist for scores >= ${r4(floor)} (nothing below that was ever flagged, so no analyst has judged it). `
      + `${unreviewed} additional transactions would be flagged below that line; their precision CANNOT be estimated from history — only their volume.`);
  }
  if (labeled < MIN_LABELS_FOR_ESTIMATES) {
    warnings.push(`Only ${labeled} alerts in this window have an analyst verdict (confirmed_fraud / false_positive). Precision and recall below are unreliable until more alerts are reviewed.`);
  }
  if (candidate.exceeds_review_capacity) {
    warnings.push(`Candidate would flag ~${candidate.flagged_per_day}/day, above the review capacity of ${capacity}/day.`);
  }
  if (floor === null) warnings.push('No model-scored alerts exist in this window, so no threshold effect can be measured yet.');

  const sweep = SWEEP_THRESHOLDS.map((t) => {
    const x = metricsFor(rows, t, Math.max(high_threshold, t + 1), days, null);
    return {
      medium_threshold: t, flagged: x.flagged, flagged_per_day: x.flagged_per_day,
      confirmed_fraud_caught: x.confirmed_fraud_caught, confirmed_fraud_missed: x.confirmed_fraud_missed,
      false_positives: x.false_positives, precision_of_reviewed_flags: x.precision_of_reviewed_flags,
      recall_of_confirmed_fraud: x.recall_of_confirmed_fraud,
      labels_incomplete: floor !== null && t < floor - 1e-9,
    };
  });

  return {
    window_days: days,
    population: {
      transactions: rows.length,
      model_scored: rows.filter((r) => r.score !== null).length,
      hard_rule_overrides: rows.filter((r) => r.override).length,
      not_affected_by_thresholds: rows.filter((r) => r.override || r.score === null).length,
      confirmed_fraud: rows.filter((r) => r.label === 'fraud').length,
      false_positive: rows.filter((r) => r.label === 'legit').length,
      alerts_awaiting_verdict: rows.filter((r) => r.label === 'unreviewed').length,
      disputed: rows.filter((r) => r.disputed).length,
    },
    label_coverage_floor_score: floor === null ? null : r4(floor),
    current, candidate,
    delta: {
      flagged: candidate.flagged - current.flagged,
      confirmed_fraud_caught: candidate.confirmed_fraud_caught - current.confirmed_fraud_caught,
      confirmed_fraud_missed: candidate.confirmed_fraud_missed - current.confirmed_fraud_missed,
      false_positives: candidate.false_positives - current.false_positives,
    },
    sweep,
    warnings,
    method_note: 'Transactions decided by hard-rule overrides, and rows never scored by the ML model, are not affected by thresholds and keep their historic outcome.',
  };
}

function bucketize(rows) {
  const out = [];
  for (let i = 0; i < CALIBRATION_EDGES.length - 1; i += 1) {
    const lo = CALIBRATION_EDGES[i];
    const hi = CALIBRATION_EDGES[i + 1];
    const inBin = rows.filter((r) => r.score >= lo && r.score < hi);
    const n = inBin.length;
    const fraud = inBin.filter((r) => r.label === 'fraud').length;
    const meanPred = n ? inBin.reduce((s, r) => s + r.modelProbability, 0) / n : null;
    const [wl, wh] = wilson(fraud, n);
    out.push({
      score_range: `${lo}-${Math.min(hi, 100)}`,
      reviewed_alerts: n,
      confirmed_fraud: fraud,
      mean_predicted_probability: r4(meanPred),
      observed_fraud_rate: n ? r4(fraud / n) : null,
      observed_95ci: [r4(wl), r4(wh)],
      consistent_with_prediction: n >= MIN_BUCKET_FOR_STATUS && meanPred !== null ? (meanPred >= wl && meanPred <= wh) : null,
    });
  }
  return out;
}

async function calibrationReport({ days }, activePolicy) {
  const rows = await loadRows(days);
  const reviewedModel = rows.filter((r) => r.score !== null && !r.override && (r.label === 'fraud' || r.label === 'legit'));
  const buckets = bucketize(reviewedModel);

  const evaluable = buckets.filter((b) => b.consistent_with_prediction !== null);
  let status = 'insufficient_data';
  if (reviewedModel.length >= MIN_LABELS_FOR_ESTIMATES && evaluable.length > 0) {
    status = evaluable.every((b) => b.consistent_with_prediction) ? 'consistent' : 'drifting';
  }

  const groups = {};
  for (const r of rows) {
    if (!r.hasAlert) continue;
    const g = (groups[r.group] ||= { alerts: 0, confirmed_fraud: 0, false_positives: 0, awaiting_verdict: 0 });
    g.alerts += 1;
    if (r.label === 'fraud') g.confirmed_fraud += 1;
    else if (r.label === 'legit') g.false_positives += 1;
    else g.awaiting_verdict += 1;
  }
  for (const g of Object.values(groups)) {
    const reviewed = g.confirmed_fraud + g.false_positives;
    g.precision_of_reviewed_alerts = reviewed ? r4(g.confirmed_fraud / reviewed) : null;
    g.reviewed = reviewed;
  }

  // Did the hard rules add anything the model would NOT have flagged?
  const overrides = rows.filter((r) => r.override && r.hasAlert);
  const wouldMissWithoutRule = overrides.filter((r) => r.score === null || r.score < activePolicy.medium_threshold);
  const hardRuleValue = {
    overrides_with_alert: overrides.length,
    model_would_not_have_flagged: wouldMissWithoutRule.length,
    of_those_confirmed_fraud: wouldMissWithoutRule.filter((r) => r.label === 'fraud').length,
    of_those_false_positives: wouldMissWithoutRule.filter((r) => r.label === 'legit').length,
  };

  const unflagged = rows.filter((r) => r.score !== null && !r.override && !r.hasAlert);
  const disputedUnflagged = unflagged.filter((r) => r.disputed).length;

  return {
    window_days: days,
    score_meaning: 'fraud_probability x 100 from the calibrated model: among transactions the model scores near S, about S in 100 were fraud in its validation data. '
      + 'This report checks that claim against analyst verdicts.',
    status,
    status_explanation: {
      insufficient_data: `Fewer than ${MIN_LABELS_FOR_ESTIMATES} reviewed model-scored alerts (or no bucket with >= ${MIN_BUCKET_FOR_STATUS}) — cannot judge calibration yet.`,
      consistent: 'In every bucket with enough reviewed alerts, the predicted probability lies inside the 95% interval of the observed fraud rate.',
      drifting: 'At least one bucket\'s observed fraud rate is outside the 95% interval of its prediction: scores no longer mean what they claim. Investigate drift / retrain / recalibrate.',
    }[status],
    reviewed_model_alerts: reviewedModel.length,
    buckets,
    coverage_note: `Only flagged transactions get an analyst verdict, so this measures calibration from the review threshold upward (lowest scored alert: ${r4(labelCoverageFloor(rows))}). Below it there are no labels.`,
    unflagged_model_scored_transactions: { n: unflagged.length, customer_disputed: disputedUnflagged,
      note: 'Disputes on transactions that were never flagged are the only evidence of missed fraud available below the review threshold; a dispute is not proof of fraud.' },
    by_decision_path: groups,
    hard_rule_overrides: { ...hardRuleValue,
      note: 'Hard-rule overrides bypass the model entirely, so they are evaluated here on their own: precision_of_reviewed_alerts under by_decision_path.hard_rule_override, and how many of them the model alone would have missed.' },
  };
}

module.exports = { simulate, calibrationReport, methodGroup, wilson, SWEEP_THRESHOLDS, MIN_LABELS_FOR_ESTIMATES };
