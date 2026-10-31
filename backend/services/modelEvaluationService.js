/**
 * Challenger evaluation on REAL OUTCOMES
 * =========================================
 * Shadow-score agreement says two models behave alike; it says nothing about
 * which one is right. Only labels do. This scores the shadow model's recorded
 * probabilities (shadow_scores) AND the incumbent's, on the same transactions,
 * against analyst verdicts (alerts.verdict: confirmed_fraud / false_positive),
 * and compares them with a paired bootstrap — the same stated rule the ML
 * service uses on its benchmark.
 *
 * Honest limits, repeated in every report:
 *  - Only transactions that got an alert have a verdict, and an alert exists
 *    because the INCUMBENT flagged the transaction. Fraud the incumbent missed
 *    has no label here, so this is selection-biased toward the incumbent's
 *    view: it can reject a challenger that ranks flagged cases worse, but it
 *    cannot show that a challenger catches fraud the incumbent misses.
 *  - Analyst verdicts are themselves imperfect.
 *  - Below the sample floors the gate reports `insufficient`, never `pass`.
 */
const config = require('../config/env');
const shadowScoreRepository = require('../models/shadowScoreRepository');

const AUC_MARGIN = 0.03;
const N_BOOT = 400;

function rocAuc(labels, scores) {
  // Mann-Whitney U with average ranks for ties.
  const n = labels.length;
  const idx = Array.from({ length: n }, (_, i) => i).sort((a, b) => scores[a] - scores[b]);
  const ranks = new Array(n);
  for (let i = 0; i < n;) {
    let j = i;
    while (j + 1 < n && scores[idx[j + 1]] === scores[idx[i]]) j += 1;
    const avg = (i + j) / 2 + 1;
    for (let k = i; k <= j; k += 1) ranks[idx[k]] = avg;
    i = j + 1;
  }
  let pos = 0; let rankSum = 0;
  for (let i = 0; i < n; i += 1) if (labels[i] === 1) { pos += 1; rankSum += ranks[i]; }
  const neg = n - pos;
  if (pos === 0 || neg === 0) return null;
  return (rankSum - (pos * (pos + 1)) / 2) / (pos * neg);
}

function averagePrecision(labels, scores) {
  const n = labels.length;
  const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => scores[b] - scores[a]);
  const totalPos = labels.reduce((a, b) => a + b, 0);
  if (totalPos === 0) return null;
  let tp = 0; let ap = 0;
  order.forEach((i, rank) => { if (labels[i] === 1) { tp += 1; ap += tp / (rank + 1); } });
  return ap / totalPos;
}

// Small deterministic PRNG so a report is reproducible.
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pairedBootstrap(labels, a, b, fn, nBoot = N_BOOT, seed = 7) {
  const rnd = mulberry32(seed);
  const n = labels.length;
  const diffs = [];
  for (let k = 0; k < nBoot; k += 1) {
    const yl = new Array(n); const sa = new Array(n); const sb = new Array(n);
    for (let i = 0; i < n; i += 1) {
      const j = Math.floor(rnd() * n);
      yl[i] = labels[j]; sa[i] = a[j]; sb[i] = b[j];
    }
    const fa = fn(yl, sa); const fb = fn(yl, sb);
    if (fa !== null && fb !== null) diffs.push(fb - fa);
  }
  diffs.sort((x, y) => x - y);
  if (!diffs.length) return null;
  const q = (p) => diffs[Math.min(diffs.length - 1, Math.max(0, Math.floor(p * diffs.length)))];
  return { mean: diffs.reduce((s, d) => s + d, 0) / diffs.length, ci95: [q(0.025), q(0.975)], n_boot: diffs.length };
}

async function evaluateChallenger(shadowVersion, { days = 30 } = {}) {
  const gc = config.modelGovernance;
  const rows = await shadowScoreRepository.labelledFor(shadowVersion, { days });
  const reviewed = rows.filter((r) => (r.verdict === 'confirmed_fraud' || r.verdict === 'false_positive')
    && r.incumbent_probability !== null && r.incumbent_probability !== undefined);
  const labels = reviewed.map((r) => (r.verdict === 'confirmed_fraud' ? 1 : 0));
  const nFraud = labels.reduce((s, v) => s + v, 0);
  const base = {
    shadow_version: shadowVersion,
    window_days: days,
    shadow_scored_transactions: rows.length,
    labelled: reviewed.length,
    confirmed_fraud: nFraud,
    false_positive: reviewed.length - nFraud,
    caveats: [
      'Only alerted transactions have verdicts; alerts exist because the incumbent flagged them, so this view is biased toward the incumbent and cannot show fraud only the challenger would catch.',
      'Analyst verdicts are imperfect.',
    ],
  };
  const floors = { labelled: gc.outcomeMinLabelled, each_class: gc.outcomeMinFraud };
  if (reviewed.length < floors.labelled || nFraud < floors.each_class || reviewed.length - nFraud < floors.each_class) {
    return {
      ...base, status: 'insufficient', floors,
      detail: `needs at least ${floors.labelled} labelled alerts with ${floors.each_class}+ of each outcome while the challenger shadow-scores real traffic (have ${reviewed.length}: ${nFraud} fraud / ${reviewed.length - nFraud} not)`,
    };
  }
  const sh = reviewed.map((r) => Number(r.shadow_probability));
  const inc = reviewed.map((r) => Number(r.incumbent_probability));
  const aucS = rocAuc(labels, sh); const aucI = rocAuc(labels, inc);
  const apS = averagePrecision(labels, sh); const apI = averagePrecision(labels, inc);
  const dAuc = pairedBootstrap(labels, inc, sh, rocAuc);
  const dAp = pairedBootstrap(labels, inc, sh, averagePrecision);
  let status = 'pass'; const reasons = [];
  if (dAuc && dAuc.ci95[0] < -AUC_MARGIN) { status = 'fail'; reasons.push(`ROC-AUC on confirmed outcomes: challenger may be worse by up to ${(-dAuc.ci95[0]).toFixed(3)} (margin ${AUC_MARGIN})`); }
  if (status !== 'fail' && dAuc && dAuc.ci95[0] > 0) { status = 'pass_better'; reasons.push('challenger ranks confirmed fraud above false positives better than the incumbent (clear on this sample)'); }
  if (!reasons.length) reasons.push('non-inferior on confirmed outcomes (not clearly better)');
  return {
    ...base, status, floors, detail: reasons.join('; '), margin: AUC_MARGIN,
    challenger: { roc_auc: aucS, average_precision: apS },
    incumbent: { roc_auc: aucI, average_precision: apI },
    paired_difference: { roc_auc: dAuc, average_precision: dAp },
  };
}

/** The workflow gate built from the evaluation. Never hard: lack of evidence needs an explicit acknowledgement, a regression cannot be waved through (handled in the governance service). */
async function outcomeGate(shadowVersion) {
  const r = await evaluateChallenger(shadowVersion);
  const status = r.status === 'insufficient' ? 'insufficient' : r.status === 'fail' ? 'fail' : 'pass';
  return { id: 'outcome_evidence', title: 'Challenger judged on confirmed fraud outcomes (analyst verdicts)', status, hard: false, detail: r.detail, data: r };
}

module.exports = { rocAuc, averagePrecision, pairedBootstrap, evaluateChallenger, outcomeGate };
