/**
 * Model performance & outcome feedback
 * ======================================
 * Connects what the system PREDICTED (a transaction was or wasn't flagged, and
 * with what score) to what was later learned (analyst verdicts, customer
 * disputes). Offline evaluation metrics live in the ML service; this is the
 * operational view.
 *
 * Label sources and what each can and cannot tell us (stated in every report):
 *   TP  flagged (has an alert) and the analyst verdict is confirmed_fraud
 *   FP  flagged and the analyst verdict is false_positive
 *   unreviewed  flagged, no verdict yet — excluded from precision, reported separately
 *   FN* NOT flagged but the customer disputed it — a missed-fraud CANDIDATE
 *       (customer reports are unverified; this is why it is starred)
 *   TN* NOT flagged, not disputed, and older than `maturityDays` — PRESUMED
 *       legitimate (a fraud nobody noticed or reported counts here)
 *
 * So: precision is solid (analyst-verified). Recall and false-positive rate lean
 * on presumptions and are estimates; the report says so and shows the counts
 * behind every figure so nobody has to take a percentage on faith.
 */
const db = require('../config/database');
const { averagePrecision } = require('./modelEvaluationService');

const DEFAULT_DAYS = 90;
const DEFAULT_MATURITY_DAYS = 30;
const ROW_CAP = 200000;
const MIN_N_FOR_RATE = 10; // below this a rate is reported with `low_sample: true`

const r4 = (x) => (x === null || x === undefined || Number.isNaN(x) ? null : Math.round(x * 10000) / 10000);

function wilson(k, n, z = 1.96) {
  if (!n) return [null, null];
  const p = k / n; const d = 1 + (z * z) / n; const c = p + (z * z) / (2 * n);
  const m = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [r4(Math.max(0, (c - m) / d)), r4(Math.min(1, (c + m) / d))];
}

function dateFilter(column) {
  return db.dialect === 'postgres' ? `${column}::timestamptz >= ?::timestamptz` : `${column} >= ?`;
}

const ts = (v) => { const t = new Date(v && !String(v).includes('T') && !String(v).endsWith('Z') ? `${String(v).replace(' ', 'T')}Z` : v).getTime(); return Number.isFinite(t) ? t : null; };

function weekStart(ms) {
  const d = new Date(ms); const day = (d.getUTCDay() + 6) % 7; // Monday = 0
  d.setUTCHours(0, 0, 0, 0); d.setUTCDate(d.getUTCDate() - day);
  return d.toISOString().slice(0, 10);
}

function cohortOf(ageDays) {
  if (ageDays === null) return 'unknown';
  if (ageDays < 7) return 'new (<7d)';
  if (ageDays < 30) return '7-30d';
  if (ageDays < 180) return '30-180d';
  return 'established (180d+)';
}

/** Loads one row per transaction in the window with its outcome signals. */
async function loadRows({ days, now }) {
  const cutoff = new Date(now - days * 86400000).toISOString();
  const rows = await db.all(
    `SELECT t.id, t.user_id, t.created_at, t.amount, t.merchant, t.category, t.risk_level, t.fraud_score, t.model_version,
            t.scoring_method, u.created_at AS user_created_at,
            a.id AS alert_id, a.verdict, a.resolved, a.created_at AS alert_created_at, d.id AS dispute_id
       FROM transactions t
       JOIN users u ON u.id = t.user_id
       LEFT JOIN alerts a ON a.transaction_id = t.id
       LEFT JOIN disputes d ON d.transaction_id = t.id
      WHERE t.is_synthetic = 0 AND ${dateFilter('t.created_at')}
      ORDER BY t.id DESC LIMIT ${ROW_CAP}`,
    [cutoff]
  );
  return rows;
}

function classify(r, now, maturityMs) {
  const created = ts(r.created_at);
  if (r.alert_id) {
    if (r.verdict === 'confirmed_fraud') return 'TP';
    if (r.verdict === 'false_positive') return 'FP';
    return 'UNREVIEWED';
  }
  if (r.dispute_id) return 'FN';
  if (created !== null && now - created >= maturityMs) return 'TN';
  return 'IMMATURE';
}

function metricsFor(items) {
  const c = { TP: 0, FP: 0, UNREVIEWED: 0, FN: 0, TN: 0, IMMATURE: 0 };
  for (const it of items) c[it.cls] += 1;
  const reviewed = c.TP + c.FP;
  const flagged = reviewed + c.UNREVIEWED;
  const [pLo, pHi] = wilson(c.TP, reviewed);
  const [rLo, rHi] = wilson(c.TP, c.TP + c.FN);
  const [fLo, fHi] = wilson(c.FP, c.FP + c.TN);

  // PR-AUC over everything that has a label (verdicts + candidates + presumed negatives)
  const labelled = items.filter((i) => ['TP', 'FP', 'FN', 'TN'].includes(i.cls));
  const labels = labelled.map((i) => (i.cls === 'TP' || i.cls === 'FN' ? 1 : 0));
  const scores = labelled.map((i) => Number(i.score) || 0);
  const positives = labels.reduce((a, b) => a + b, 0);
  const prAuc = positives > 0 && positives < labels.length ? averagePrecision(labels, scores) : null;
  // reviewed-only variant: removes the presumption about unflagged traffic entirely
  const rev = items.filter((i) => i.cls === 'TP' || i.cls === 'FP');
  const revLabels = rev.map((i) => (i.cls === 'TP' ? 1 : 0));
  const revPos = revLabels.reduce((a, b) => a + b, 0);
  const prAucReviewed = revPos > 0 && revPos < rev.length ? averagePrecision(revLabels, rev.map((i) => Number(i.score) || 0)) : null;

  return {
    transactions: items.length,
    flagged,
    reviewed,
    unreviewed: c.UNREVIEWED,
    confirmed_fraud: c.TP,
    false_positives: c.FP,
    missed_candidates: c.FN,
    presumed_legitimate: c.TN,
    immature_unflagged: c.IMMATURE,
    review_coverage: flagged ? r4(reviewed / flagged) : null,
    precision: reviewed ? r4(c.TP / reviewed) : null,
    precision_ci: [pLo, pHi],
    recall_estimate: c.TP + c.FN ? r4(c.TP / (c.TP + c.FN)) : null,
    recall_ci: [rLo, rHi],
    false_positive_rate_estimate: c.FP + c.TN ? r4(c.FP / (c.FP + c.TN)) : null,
    fpr_ci: [fLo, fHi],
    pr_auc: r4(prAuc),
    pr_auc_reviewed_only: r4(prAucReviewed),
    pr_auc_baseline: labels.length ? r4(positives / labels.length) : null, // random-model PR-AUC = prevalence
    low_sample: reviewed < MIN_N_FOR_RATE,
  };
}

function group(items, keyFn) {
  const m = new Map();
  for (const it of items) { const k = keyFn(it); if (!m.has(k)) m.set(k, []); m.get(k).push(it); }
  return m;
}

function breakdown(items, keyFn, { limit = 15, minFlagged = 1 } = {}) {
  return [...group(items, keyFn).entries()]
    .map(([key, list]) => ({ key, ...metricsFor(list) }))
    .filter((r) => r.flagged >= minFlagged)
    .sort((a, b) => b.flagged - a.flagged || String(a.key).localeCompare(String(b.key)))
    .slice(0, limit);
}

function versionOf(it) { return it.model_version || (String(it.scoring_method || '').startsWith('rule_engine') ? 'rule_engine' : 'unversioned'); }

async function report({ days = DEFAULT_DAYS, maturityDays = DEFAULT_MATURITY_DAYS, now = Date.now() } = {}) {
  const maturityMs = maturityDays * 86400000;
  const rows = await loadRows({ days, now });
  const items = rows.map((r) => {
    const created = ts(r.created_at); const userCreated = ts(r.user_created_at);
    return {
      ...r,
      cls: classify(r, now, maturityMs),
      score: r.fraud_score,
      week: created ? weekStart(created) : 'unknown',
      cohort: cohortOf(created !== null && userCreated !== null ? Math.max(0, (created - userCreated) / 86400000) : null),
      version: versionOf(r),
      created,
    };
  });

  const overall = metricsFor(items);

  const over_time = [...group(items, (i) => i.week).entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([week, list]) => ({ week, ...metricsFor(list) }));

  // versions ordered by when each was first seen in the window
  const byVersion = group(items, (i) => i.version);
  const versions = [...byVersion.entries()].map(([version, list]) => ({
    version,
    first_seen: new Date(Math.min(...list.map((i) => i.created || Infinity))).toISOString(),
    last_seen: new Date(Math.max(...list.map((i) => i.created || 0))).toISOString(),
    ...metricsFor(list),
  })).sort((a, b) => a.first_seen.localeCompare(b.first_seen));

  let comparison = null;
  if (versions.length >= 2) {
    const current = versions[versions.length - 1]; const previous = versions[versions.length - 2];
    const sig = (a, b) => (a.precision_ci[0] === null || b.precision_ci[0] === null ? null : a.precision_ci[0] > b.precision_ci[1] || b.precision_ci[0] > a.precision_ci[1]);
    const d = (k) => (current[k] === null || previous[k] === null ? null : r4(current[k] - previous[k]));
    comparison = {
      current: current.version, previous: previous.version,
      delta: { precision: d('precision'), recall_estimate: d('recall_estimate'), false_positive_rate_estimate: d('false_positive_rate_estimate'), pr_auc: d('pr_auc'), pr_auc_reviewed_only: d('pr_auc_reviewed_only') },
      precision_difference_significant: sig(current, previous),
      note: 'Versions saw different traffic at different times (and carry different label maturity). Treat deltas as indicative; use shadow-scored outcome evaluation for a like-for-like comparison.',
    };
  }

  const flaggedItems = items.filter((i) => ['TP', 'FP', 'UNREVIEWED'].includes(i.cls));
  const nowMs = now;
  const open = flaggedItems.filter((i) => i.cls === 'UNREVIEWED');
  const ages = open.map((i) => (nowMs - (ts(i.alert_created_at) || nowMs)) / 3600000);
  const feedback = {
    flagged_predictions: flaggedItems.length,
    unreviewed_predictions: open.length,
    unreviewed_older_than_24h: ages.filter((h) => h > 24).length,
    unreviewed_older_than_7d: ages.filter((h) => h > 168).length,
    oldest_unreviewed_hours: ages.length ? Math.round(Math.max(...ages)) : null,
    confirmed_outcomes: overall.reviewed,
    confirmed_fraud: overall.confirmed_fraud,
    false_positives: overall.false_positives,
    unflagged_disputes: overall.missed_candidates,
    review_coverage: overall.review_coverage,
  };

  return {
    generated_at: new Date(now).toISOString(),
    window_days: days,
    maturity_days: maturityDays,
    overall,
    feedback,
    over_time,
    versions,
    version_comparison: comparison,
    breakdowns: {
      risk_band: breakdown(items, (i) => i.risk_level || 'unknown', { limit: 10 }),
      category: breakdown(items, (i) => i.category || 'unknown'),
      merchant: breakdown(items, (i) => i.merchant || 'unknown', { limit: 15 }),
      customer_cohort: breakdown(items, (i) => i.cohort, { limit: 10 }),
    },
    caveats: [
      'Precision uses analyst-reviewed alerts only. Unreviewed alerts are excluded and counted separately.',
      `Recall and false-positive rate are estimates: unflagged transactions disputed by the customer are treated as missed-fraud candidates (unverified), and unflagged, undisputed transactions older than ${maturityDays} days are PRESUMED legitimate. Fraud nobody noticed is invisible here.`,
      'Only flagged transactions are reviewed, so labels are selection-biased toward the model\'s own view; the PR-AUC (reviewed only) removes the presumption but only ranks flagged cases.',
      'Rates under 10 reviewed cases are marked low_sample; confidence intervals are Wilson 95%.',
      'Synthetic/demo transactions are excluded.',
    ],
  };
}

const COLS = ['transactions', 'flagged', 'reviewed', 'unreviewed', 'confirmed_fraud', 'false_positives', 'missed_candidates', 'presumed_legitimate', 'review_coverage', 'precision', 'recall_estimate', 'false_positive_rate_estimate', 'pr_auc', 'pr_auc_reviewed_only', 'low_sample'];

/** Flattens a report to CSV rows: section, key, then the metric columns. */
function toRows(rep) {
  const rows = [];
  const push = (section, key, m) => rows.push({ section, key, ...Object.fromEntries(COLS.map((c) => [c, m[c]])) });
  push('overall', 'all', rep.overall);
  rep.over_time.forEach((m) => push('week', m.week, m));
  rep.versions.forEach((m) => push('model_version', m.version, m));
  for (const [dim, list] of Object.entries(rep.breakdowns)) list.forEach((m) => push(dim, m.key, m));
  return rows;
}
const CSV_COLUMNS = [{ key: 'section', header: 'Section' }, { key: 'key', header: 'Key' }, ...COLS.map((c) => ({ key: c, header: c }))];

module.exports = { report, toRows, CSV_COLUMNS, metricsFor, classify, wilson, weekStart, cohortOf, DEFAULT_DAYS, DEFAULT_MATURITY_DAYS };
