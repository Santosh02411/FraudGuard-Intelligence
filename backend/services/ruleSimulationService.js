/**
 * Rule & policy historical simulation
 * =====================================
 * Replays a PROPOSED rule set + risk policy against past transactions and compares it with the
 * CURRENT one, so an administrator can see the likely effect before anything touches live traffic.
 * Nothing here writes to fraud_rules / risk_policy: it only reads.
 *
 * How a transaction is judged (identically for both sides, so the comparison is like-for-like):
 *   flagged = a hard rule matches  OR  policy level != low
 *   policy level = levelFor(model_probability x 100, policy). Transactions the ML model never
 *   scored (model_probability NULL) keep their recorded level unless a hard rule decided it.
 *
 * Labels come from the same taxonomy as the model performance center (TP, FP, FN-candidate, presumed TN, unreviewed, immature):
 *   positive = confirmed fraud (analyst) or customer-disputed;  negative = analyst false positive or
 *   presumed legitimate (mature, undisputed). Unreviewed and immature rows are excluded from rates
 *   and reported separately. Every figure that rests on a presumption says so in `caveats`.
 *
 * Known limits, returned with every result: replay uses today's models' stored probabilities (not a
 * re-score); the dynamic device/IP reputation blacklist is not replayed; network/relationship overrides
 * are not replayed; "false positive" for never-flagged traffic is a presumption.
 */
const db = require('../config/database');
const { checkHardRules } = require('../models/fraudEngine');
const { configFromRows } = require('../models/fraudRuleRepository');
const { levelFor, RULE_ENGINE_POLICY } = require('../models/riskPolicy');
const { classify, wilson } = require('./modelPerformanceService');

const ROW_CAP = 100000;
const DEFAULT_DAYS = 90;
const DEFAULT_MATURITY_DAYS = 30;
const SAMPLE = 20;
const r4 = (x) => (x === null || x === undefined || Number.isNaN(x) ? null : Math.round(x * 10000) / 10000);
const ratio = (a, b) => (b ? r4(a / b) : null);

const CAVEATS = [
  'Replay uses the model probabilities stored at scoring time; transactions are not re-scored.',
  'The dynamic device/IP reputation list and relationship (network) overrides are not replayed, so hard-rule hits from those sources are not part of either side.',
  'Negative labels for never-flagged traffic are PRESUMED (mature and undisputed): a fraud nobody noticed counts as legitimate, so false-positive and recall figures are estimates.',
  'Transactions without a model probability keep their recorded risk level unless a hard rule decides them.',
];

/** Applies rule-change operations to a copy of the rule rows. Pure. Throws {code:'BAD_CHANGE'} for ops that cannot apply. */
function applyRuleChanges(rows, changes = []) {
  const out = rows.map((r) => ({ ...r, enabled: Number(r.enabled) ? 1 : 0 }));
  let tmp = -1;
  for (const c of changes) {
    if (c.op === 'add') {
      out.push({ id: tmp--, rule_type: c.rule_type, value: c.value ?? null, threshold: c.threshold ?? null, enabled: 1, _new: true, reason: c.reason ?? null });
      continue;
    }
    const idx = out.findIndex((r) => Number(r.id) === Number(c.rule_id));
    if (idx < 0) { const e = new Error(`Rule ${c.rule_id} does not exist`); e.code = 'BAD_CHANGE'; throw e; }
    if (c.op === 'delete') out.splice(idx, 1);
    else if (c.op === 'enable') out[idx].enabled = 1;
    else if (c.op === 'disable') out[idx].enabled = 0;
    else if (c.op === 'update') {
      if (c.value !== undefined) out[idx].value = c.value;
      if (c.threshold !== undefined) out[idx].threshold = c.threshold;
    }
  }
  return out;
}

const enabledConfig = (rows) => configFromRows(rows.filter((r) => Number(r.enabled)).map((r) => ({ rule_type: r.rule_type, value: r.value, threshold: r.threshold === null || r.threshold === undefined ? null : Number(r.threshold) })));

function decide(t, config, policy) {
  const hard = checkHardRules(t, {}, config).triggered;
  if (hard) return { flagged: true, level: 'high', hard: true };
  let level;
  if (t.model_probability !== null && t.model_probability !== undefined) level = levelFor(Number(t.model_probability) * 100, policy);
  else if (t.hard_flag_triggered) level = levelFor(Number(t.fraud_score) || 0, RULE_ENGINE_POLICY); // rule-decided then, rule-gone now: fall back to engine score
  else level = t.risk_level || 'low';
  return { flagged: level !== 'low', level, hard: false };
}

function confusion(items, key) {
  const c = { flagged: 0, tp: 0, fp: 0, fn: 0, tn: 0, unlabelled_flagged: 0, hard_flagged: 0, high: 0, medium: 0 };
  for (const it of items) {
    const d = it[key];
    if (d.flagged) { c.flagged += 1; if (d.hard) c.hard_flagged += 1; if (d.level === 'high') c.high += 1; else if (d.level === 'medium') c.medium += 1; }
    if (it.label === null) { if (d.flagged) c.unlabelled_flagged += 1; continue; }
    if (it.label === 'pos') { if (d.flagged) c.tp += 1; else c.fn += 1; } else if (d.flagged) c.fp += 1; else c.tn += 1;
  }
  const [pLo, pHi] = wilson(c.tp, c.tp + c.fp);
  const [fLo, fHi] = wilson(c.fp, c.fp + c.tn);
  return {
    ...c,
    precision: ratio(c.tp, c.tp + c.fp), precision_ci: [pLo, pHi],
    recall_estimate: ratio(c.tp, c.tp + c.fn),
    false_positive_rate_estimate: ratio(c.fp, c.fp + c.tn), false_positive_rate_ci: [fLo, fHi],
  };
}

const toLabel = (cls) => (cls === 'TP' || cls === 'FN' ? 'pos' : cls === 'FP' || cls === 'TN' ? 'neg' : null);
const dateFilter = (col) => (db.dialect === 'postgres' ? `${col}::timestamptz >= ?::timestamptz` : `${col} >= ?`);

async function loadHistory({ days, now }) {
  const cutoff = new Date(now - days * 86400000).toISOString();
  return db.all(
    `SELECT t.id, t.created_at, t.amount, t.merchant, t.location, t.device_fingerprint, t.ip_address, t.model_probability,
            t.risk_level, t.fraud_score, t.hard_flag_triggered, a.id AS alert_id, a.verdict, d.id AS dispute_id
       FROM transactions t
       LEFT JOIN alerts a ON a.transaction_id = t.id
       LEFT JOIN disputes d ON d.transaction_id = t.id
      WHERE t.is_synthetic = 0 AND ${dateFilter('t.created_at')}
      ORDER BY t.id DESC LIMIT ${ROW_CAP}`,
    [cutoff]
  );
}

/**
 * @param {object} p
 * @param {object[]} p.currentRules      fraud_rules rows now
 * @param {object}   p.currentPolicy     active policy
 * @param {object[]} [p.ruleChanges]     change ops
 * @param {object|null} [p.policyChange] {medium_threshold, high_threshold, review_capacity_per_day?}
 */
async function simulate({ currentRules, currentPolicy, ruleChanges = [], policyChange = null, days = DEFAULT_DAYS, maturityDays = DEFAULT_MATURITY_DAYS, now = Date.now() }) {
  const proposedRules = applyRuleChanges(currentRules, ruleChanges);
  const curCfg = enabledConfig(currentRules);
  const newCfg = enabledConfig(proposedRules);
  const curPol = currentPolicy;
  const newPol = policyChange ? { ...currentPolicy, ...policyChange } : currentPolicy;

  const rows = await loadHistory({ days, now });
  const maturityMs = maturityDays * 86400000;
  const items = rows.map((r) => {
    const cls = classify({ ...r, created_at: r.created_at }, now, maturityMs);
    const t = { ...r, amount: Number(r.amount), model_probability: r.model_probability === null ? null : Number(r.model_probability) };
    return { row: r, cls, label: toLabel(cls), cur: decide(t, curCfg, curPol), prop: decide(t, newCfg, newPol) };
  });

  const current = confusion(items, 'cur');
  const proposed = confusion(items, 'prop');
  const newly = items.filter((i) => i.prop.flagged && !i.cur.flagged);
  const released = items.filter((i) => i.cur.flagged && !i.prop.flagged);
  const levelChanged = items.filter((i) => i.cur.flagged && i.prop.flagged && i.cur.level !== i.prop.level).length;
  const breakdown = (arr) => ({
    count: arr.length,
    likely_fraud: arr.filter((i) => i.label === 'pos').length,
    likely_legitimate: arr.filter((i) => i.label === 'neg').length,
    unlabelled: arr.filter((i) => i.label === null).length,
  });
  const sample = (arr) => arr.slice(0, SAMPLE).map((i) => ({
    id: Number(i.row.id), amount: Number(i.row.amount), merchant: i.row.merchant, location: i.row.location, label: i.cls,
    created_at: i.row.created_at, current_level: i.cur.level, proposed_level: i.prop.level,
  }));
  const perDay = (n) => r4(n / days);
  const capacity = newPol.review_capacity_per_day ?? null;

  const warnings = [];
  const share = items.length ? newly.length / items.length : 0;
  if (items.length === 0) warnings.push('No historical transactions in the window — nothing to compare. Treat this simulation as uninformative.');
  if (share > 0.1) warnings.push(`The proposal would newly flag ${(share * 100).toFixed(1)}% of all transactions in the window — unusually broad.`);
  const nl = breakdown(newly);
  if (nl.count >= 10 && nl.likely_legitimate / Math.max(1, nl.likely_fraud + nl.likely_legitimate) > 0.9) warnings.push('More than 90% of the newly flagged labelled transactions look legitimate (presumed) — expect mostly false positives.');
  if (capacity && perDay(proposed.flagged) > capacity) warnings.push(`Proposed flag volume (~${perDay(proposed.flagged)}/day) exceeds the configured review capacity (${capacity}/day).`);
  if (current.tp + current.fn < 5) warnings.push('Fewer than 5 positive labels in the window: recall and precision comparisons are not reliable.');
  if (policyChange) {
    const noModel = items.filter((i) => i.row.model_probability === null).length;
    if (noModel) warnings.push(`${noModel} transaction(s) had no model probability, so the policy threshold change cannot affect them.`);
  }

  return {
    window_days: days, maturity_days: maturityDays, evaluated: items.length, truncated: rows.length >= ROW_CAP,
    labelled: items.filter((i) => i.label).length,
    label_counts: items.reduce((a, i) => { a[i.cls] = (a[i.cls] || 0) + 1; return a; }, {}),
    current_policy: { medium_threshold: curPol.medium_threshold, high_threshold: curPol.high_threshold, version: curPol.version },
    proposed_policy: { medium_threshold: newPol.medium_threshold, high_threshold: newPol.high_threshold, review_capacity_per_day: capacity },
    current, proposed,
    delta: {
      flagged: proposed.flagged - current.flagged,
      flagged_per_day: r4((proposed.flagged - current.flagged) / days),
      true_positives: proposed.tp - current.tp,
      false_positives: proposed.fp - current.fp,
      missed_fraud: proposed.fn - current.fn,
      precision: proposed.precision !== null && current.precision !== null ? r4(proposed.precision - current.precision) : null,
    },
    newly_flagged: { ...breakdown(newly), sample: sample(newly) },
    no_longer_flagged: { ...breakdown(released), sample: sample(released) },
    level_changes: levelChanged,
    warnings, caveats: CAVEATS,
  };
}

module.exports = { simulate, applyRuleChanges, enabledConfig, DEFAULT_DAYS, DEFAULT_MATURITY_DAYS };
