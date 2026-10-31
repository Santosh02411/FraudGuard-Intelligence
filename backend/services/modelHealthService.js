/**
 * Rollback triggers for the serving model
 * ==========================================
 * Evaluated from stored production data over a recent window (never from
 * memory), only on REAL traffic (is_synthetic = 0) and only for the version
 * now serving, so a restart or a second instance sees the same picture.
 *
 *   latency_p95         p95 of the ML scoring call
 *   fallback_rate       share of transactions the ML service did not score
 *                       (rule-engine fallback = errors/timeouts)
 *   score_distribution  PSI of the served calibrated scores against the
 *                       version's training-time score histogram
 *   confirmed_outcomes  precision of the model's flags among reviewed alerts
 *                       (Wilson 95% UPPER bound below the floor = the model's
 *                       flags are mostly wrong, with confidence)
 *
 * Each trigger is ok | warn | critical | insufficient_data. A sample floor
 * stops noise from rolling a model back. What happens on `critical`:
 *   default              record + recommend (a human opens a rollback request)
 *   MODEL_AUTO_ROLLBACK  an automatic rollback to the previous version,
 *                        recorded in the promotion history under the system
 *                        actor. Opt-in: a bad trigger must never be able to
 *                        take the fraud decision path down on its own by default.
 * Limits: confirmed outcomes lag (analysts review later) and carry selection
 * bias; fallback_rate cannot tell an ML outage from a bad model.
 */
const db = require('../config/database');
const config = require('../config/env');
const logger = require('../config/logger');
const modelChangeRepository = require('../models/modelChangeRepository');
const mlAdminClient = require('./mlAdminClient');

/** `column >= ?` that compares instants correctly in both dialects (SQLite stores 'YYYY-MM-DD HH:MM:SS', which does not sort against an ISO 'T' string). */
const since = (column) => (db.dialect === 'postgres' ? `${column} >= ?::timestamptz` : `datetime(${column}) >= datetime(?)`);

function wilson(k, n, z = 1.96) {
  if (!n) return { lo: 0, hi: 1 };
  const p = k / n; const d = 1 + (z * z) / n;
  const c = p + (z * z) / (2 * n); const m = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return { lo: Math.max(0, (c - m) / d), hi: Math.min(1, (c + m) / d) };
}

function percentile(sorted, p) {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)];
}

/** PSI between a baseline proportion vector and live scores bucketed with the baseline's edges. */
function psi(baselineHist, edges, liveScores, eps = 1e-4) {
  const counts = new Array(baselineHist.length).fill(0);
  liveScores.forEach((s) => {
    let b = edges.length - 2;
    for (let i = 0; i < edges.length - 1; i += 1) if (s >= edges[i] && s < edges[i + 1]) { b = i; break; }
    counts[Math.max(0, Math.min(b, counts.length - 1))] += 1;
  });
  const n = liveScores.length || 1;
  return baselineHist.reduce((sum, pa, i) => {
    const a = Math.max(pa, eps); const b = Math.max(counts[i] / n, eps);
    return sum + (b - a) * Math.log(b / a);
  }, 0);
}

async function servingSince(version) {
  const change = await modelChangeRepository.lastAppliedFor(version);
  const at = change?.applied_at;
  if (!at) return null;
  if (at instanceof Date) return at;
  const s = String(at);
  return new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s.replace(' ', 'T') : `${s.replace(' ', 'T')}Z`);   // SQLite CURRENT_TIMESTAMP is UTC without a zone
}

async function evaluate({ now = new Date() } = {}) {
  const gc = config.modelGovernance;
  const { active } = await mlAdminClient.listVersions();
  if (!active) return { version: null, status: 'no_model', triggers: [] };

  let windowStart = new Date(now.getTime() - gc.windowMinutes * 60000);
  const switched = await servingSince(active);
  if (switched && switched > windowStart) windowStart = switched;
  const sinceIso = windowStart.toISOString();

  const rows = await db.all(
    `SELECT ml_latency_ms, scoring_method, model_probability, model_version
       FROM transactions WHERE is_synthetic = 0 AND ${since('created_at')}`, [sinceIso]);
  const scored = rows.filter((r) => r.model_version === active || r.model_version === null || r.model_version === undefined);
  const n = rows.length;
  const triggers = [];

  // latency
  const lat = rows.map((r) => r.ml_latency_ms).filter((v) => v !== null && v !== undefined).map(Number).sort((a, b) => a - b);
  const p95 = percentile(lat, 0.95);
  triggers.push(lat.length < gc.minSamples
    ? { name: 'latency_p95', status: 'insufficient_data', n: lat.length, floor: gc.minSamples }
    : { name: 'latency_p95', status: p95 > gc.maxP95Ms ? 'critical' : p95 > gc.maxP95Ms * 0.7 ? 'warn' : 'ok', value: p95, limit: gc.maxP95Ms, n: lat.length });

  // fallback / error rate
  const failed = rows.filter((r) => !/ml_model|\+ml/.test(String(r.scoring_method))).length;
  const rate = n ? failed / n : 0;
  triggers.push(n < gc.minSamples
    ? { name: 'fallback_rate', status: 'insufficient_data', n, floor: gc.minSamples }
    : { name: 'fallback_rate', status: rate > gc.maxFallbackRate ? 'critical' : rate > gc.maxFallbackRate * 0.5 ? 'warn' : 'ok', value: Number(rate.toFixed(4)), limit: gc.maxFallbackRate, n });

  // score distribution vs training baseline
  let psiTrigger = { name: 'score_distribution', status: 'insufficient_data', detail: 'no baseline histogram for this version' };
  try {
    const baseline = await mlAdminClient.getBaseline();
    const hist = baseline?.score?.hist; const edges = baseline?.score?.hist_edges;
    const live = scored.map((r) => r.model_probability).filter((v) => v !== null && v !== undefined).map((v) => Number(v) * 100);
    if (hist && edges && live.length >= gc.minSamples * 2) {
      const value = psi(hist, edges, live);
      psiTrigger = { name: 'score_distribution', status: value >= gc.maxPsi ? 'critical' : value >= gc.maxPsi * 0.4 ? 'warn' : 'ok', value: Number(value.toFixed(4)), limit: gc.maxPsi, n: live.length };
    } else if (hist && edges) {
      psiTrigger = { name: 'score_distribution', status: 'insufficient_data', n: live.length, floor: gc.minSamples * 2 };
    }
  } catch (err) { psiTrigger.detail = `baseline unavailable: ${err.message}`; }
  triggers.push(psiTrigger);

  // confirmed outcomes of what the serving model flagged
  const verdicts = await db.all(
    `SELECT a.verdict FROM alerts a JOIN transactions t ON t.id = a.transaction_id
      WHERE t.is_synthetic = 0 AND t.model_version = ? AND a.verdict IN ('confirmed_fraud', 'false_positive') AND ${since('a.resolved_at')}`, [active, sinceIso]);
  const tp = verdicts.filter((v) => v.verdict === 'confirmed_fraud').length;
  if (verdicts.length < gc.minVerdicts) {
    triggers.push({ name: 'confirmed_outcomes', status: 'insufficient_data', n: verdicts.length, floor: gc.minVerdicts, detail: 'analyst verdicts lag; this trigger needs reviewed alerts' });
  } else {
    const w = wilson(tp, verdicts.length);
    triggers.push({ name: 'confirmed_outcomes', status: w.hi < gc.minPrecision ? 'critical' : (tp / verdicts.length) < gc.minPrecision ? 'warn' : 'ok',
      value: Number((tp / verdicts.length).toFixed(4)), ci95_upper: Number(w.hi.toFixed(4)), limit: gc.minPrecision, n: verdicts.length, confirmed_fraud: tp });
  }

  const status = triggers.some((t) => t.status === 'critical') ? 'critical' : triggers.some((t) => t.status === 'warn') ? 'warn' : 'ok';
  return { version: active, status, window_start: sinceIso, evaluated_at: now.toISOString(), transactions_in_window: n, triggers, thresholds: { ...gc } };
}

async function recentEvents(limit = 50) {
  const rows = await db.all('SELECT * FROM model_health_events ORDER BY id DESC LIMIT ?', [limit]);
  return rows.map((r) => ({ ...r, details: (() => { try { return JSON.parse(r.details); } catch { return {}; } })() }));
}

async function recordOnce(version, trigger, action) {
  const hourAgo = new Date(Date.now() - 3600000).toISOString();
  const dupe = await db.get(`SELECT id FROM model_health_events WHERE model_version = ? AND trigger_name = ? AND severity = ? AND ${since('created_at')}`, [version, trigger.name, trigger.status, hourAgo]);
  if (dupe) return false;
  await db.run('INSERT INTO model_health_events (model_version, trigger_name, severity, details, action_taken) VALUES (?, ?, ?, ?, ?)',
    [version, trigger.name, trigger.status, JSON.stringify(trigger), action]);
  return true;
}

/** Evaluate, record breaches, and (opt-in) roll back. Returns the report with the action taken. */
async function run({ governance } = {}) {
  const report = await evaluate();
  report.action = 'none';
  const breaches = report.triggers.filter((t) => t.status === 'critical' || t.status === 'warn');
  const critical = breaches.filter((t) => t.status === 'critical');
  if (critical.length) {
    const prev = await modelChangeRepository.lastAppliedFor(report.version);
    const toVersion = prev?.action === 'promote' ? prev.from_version : null;
    if (config.modelGovernance.autoRollback && governance && toVersion) {
      const res = await governance.automaticRollback({ toVersion, trigger: critical[0].name, details: critical[0] });
      report.action = res.applied ? `auto_rolled_back_to_${toVersion}` : `auto_rollback_failed: ${res.reason}`;
    } else {
      report.action = toVersion ? `recommend_rollback_to_${toVersion}` : 'recommend_review (no workflow-promoted predecessor to roll back to)';
    }
  }
  for (const t of breaches) {
    await recordOnce(report.version, t, t.status === 'critical' ? report.action : 'none').catch((e) => logger.warn('model health event not recorded', { error: e.message }));
  }
  return report;
}

module.exports = { evaluate, run, recentEvents, wilson, psi, percentile };
