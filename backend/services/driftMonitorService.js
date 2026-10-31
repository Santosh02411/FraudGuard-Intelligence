/**
 * Persistent drift monitoring & model-health alerts
 * ====================================================
 * Builds on the monitoring that already exists instead of adding a second system:
 *   - drift maths is the ML service's own (utils/drift.py via POST /model/drift/evaluate), so a "drift" number here and in
 *     GET /model/drift are the same calculation;
 *   - the score-distribution PSI reuses services/modelHealthService.psi and the version's training score histogram;
 *   - quality reuses services/modelPerformanceService (same label taxonomy);
 *   - alerts are rows in the existing model_health_events table (extended with scope/lifecycle columns), next to the
 *     rollback triggers.
 * What is new is DURABILITY and RESOLUTION: every run stores a snapshot per (time window x customer segment) in the
 * backend database, built from model_inference_log, so history and segments survive restarts of either service.
 *
 * Interpretation, stated everywhere it is shown: drift = the INPUT distribution moved relative to training. That is a
 * warning signal, not proof that accuracy fell (new but legitimate traffic drifts too). Drift alerts are therefore at
 * most `warn`/`critical` ATTENTION levels and NEVER trigger a rollback on their own (that stays with the existing
 * modelHealthService triggers). Each alert carries the latest label-based quality evidence beside it.
 */
const db = require('../config/database');
const config = require('../config/env');
const logger = require('../config/logger');
const mlAdminClient = require('./mlAdminClient');
const modelHealth = require('./modelHealthService');
const inferenceLog = require('./inferenceLog');
const settingsService = require('./monitoringSettings');
const modelPerformance = require('./modelPerformanceService');

const ML_BATCH_CAP = 5000;
const r4 = (x) => (x === null || x === undefined || Number.isNaN(x) ? null : Math.round(x * 10000) / 10000);
const labelFor = (h) => (h >= 48 && h % 24 === 0 ? `${h / 24}d` : `${h}h`);
const parseJson = (s, d) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };
const INTERPRETATION = 'The distribution of model INPUTS moved relative to the training data. That is a warning signal, not proof that accuracy has fallen: new but legitimate traffic also drifts. Check label-based quality before acting.';

// -------------------------------------------------------------------- operational metrics

function opsMetrics(rows) {
  const n = rows.length;
  const lat = rows.map((r) => r.latency_ms).filter((v) => v !== null && Number.isFinite(v)).sort((a, b) => a - b);
  const failures = {};
  for (const r of rows) if (r.outcome !== 'ok') failures[r.outcome] = (failures[r.outcome] || 0) + 1;
  const failed = Object.values(failures).reduce((a, b) => a + b, 0);
  const missingRows = rows.filter((r) => r.missing.length > 0);
  const fieldCounts = {};
  for (const r of rows) for (const f of r.missing) fieldCounts[f] = (fieldCounts[f] || 0) + 1;
  const unseenCounts = {};
  for (const r of rows) for (const [c, v] of Object.entries(r.unseen || {})) { const k = `${c}=${v}`; unseenCounts[k] = (unseenCounts[k] || 0) + 1; }
  const top = (o, k = 8) => Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, k).map(([name, count]) => ({ name, count, rate: r4(count / n) }));
  return {
    n,
    scored: n - failed,
    prediction_failures: failed,
    failure_rate: n ? r4(failed / n) : null,
    fallback_rate: n ? r4(failed / n) : null,      // a failed ML call is scored by the rule engine instead
    failures_by_kind: failures,
    latency_p50_ms: modelHealth.percentile(lat, 0.5),
    latency_p95_ms: modelHealth.percentile(lat, 0.95),
    latency_max_ms: lat.length ? lat[lat.length - 1] : null,
    missing_rate: n ? r4(missingRows.length / n) : null,
    missing_inferences: missingRows.length,
    top_missing_fields: top(fieldCounts),
    unseen_categories: top(unseenCounts),
  };
}

// -------------------------------------------------------------------- severity logic (pure)

function severityFor(value, warn, critical) {
  if (value === null || value === undefined) return 'ok';
  return value >= critical ? 'critical' : value >= warn ? 'warn' : 'ok';
}
const driftStatus = (sev) => (sev === 'critical' ? 'significant_drift' : sev === 'warn' ? 'moderate_drift' : 'stable');
const worse = (a, b) => ['ok', 'warn', 'critical'][Math.max(['ok', 'warn', 'critical'].indexOf(a), ['ok', 'warn', 'critical'].indexOf(b))];

// -------------------------------------------------------------------- alerts (model_health_events)

async function reconcileAlert({ version, name, scope, severity, kind, details, now }) {
  const open = await db.get(
    'SELECT * FROM model_health_events WHERE model_version = ? AND trigger_name = ? AND scope = ? AND resolved_at IS NULL ORDER BY id DESC LIMIT 1', [version, name, scope]);
  const nowIso = now.toISOString();
  if (severity === 'ok') {
    if (!open) return 'none';
    await db.run("UPDATE model_health_events SET resolved_at = ?, action_taken = 'cleared: back within threshold' WHERE id = ?", [nowIso, open.id]);
    return 'cleared';
  }
  if (open && open.severity === severity) {
    await db.run('UPDATE model_health_events SET details = ?, last_seen_at = ? WHERE id = ?', [JSON.stringify(details), nowIso, open.id]);
    return 'updated';
  }
  if (open) await db.run("UPDATE model_health_events SET resolved_at = ?, action_taken = 'superseded by a different severity' WHERE id = ?", [nowIso, open.id]);
  await db.run(
    `INSERT INTO model_health_events (model_version, trigger_name, severity, details, action_taken, scope, kind, last_seen_at, created_at)
     VALUES (?, ?, ?, ?, 'none', ?, ?, ?, ?)`,
    [version, name, severity, JSON.stringify(details), scope, kind, nowIso, db.dialect === 'postgres' ? nowIso : nowIso.replace('T', ' ').slice(0, 19)]);
  return 'opened';
}

async function notifyAdmins(opened) {
  if (!config.monitoring.emailAlerts || !opened.length) return;
  try {
    const admins = await db.all("SELECT email FROM users WHERE role = 'admin' AND email_verified = 1 AND email IS NOT NULL");
    const text = `FraudGuard model monitoring opened ${opened.length} alert(s):\n\n${opened.map((o) => `- [${o.severity}] ${o.name} (${o.scope}): ${o.summary}`).join('\n')}\n\n${INTERPRETATION}\n`;
    const { sendMail } = require('./emailService');
    for (const a of admins) await sendMail({ to: a.email, subject: `FraudGuard: ${opened.length} model-monitoring alert(s)`, text });
  } catch (err) { logger.warn('Monitoring alert email failed', { error: err.message }); }
}

// -------------------------------------------------------------------- snapshots

async function insertSnapshot(s) {
  const { lastInsertRowid } = await db.insert(
    `INSERT INTO drift_snapshots (created_at, model_version, window_label, window_start, window_end, segment_dim, segment_value, n, status, max_psi, feature_psi, score_psi, score_mean, score_high_rate, ops, quality)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [s.created_at, s.model_version, s.window_label, s.window_start, s.window_end, s.segment_dim, s.segment_value, s.n, s.status, s.max_psi ?? null,
      s.feature_psi ? JSON.stringify(s.feature_psi) : null, s.score_psi ?? null, s.score_mean ?? null, s.score_high_rate ?? null,
      s.ops ? JSON.stringify(s.ops) : null, s.quality ? JSON.stringify(s.quality) : null]);
  return Number(lastInsertRowid);
}

/** Drift of one scope (a set of scored inferences) via the ML service's own report. */
async function driftOfRows(version, scored, baseline) {
  const sample = scored.slice(-ML_BATCH_CAP);
  const report = await mlAdminClient.evaluateDrift({ rows: sample.map((r) => r.features), scores: sample.map((r) => r.score ?? 0), version });
  const psis = report.feature_psi || {};
  const entries = Object.entries(psis).sort((a, b) => b[1] - a[1]);
  const maxPsi = entries.length ? entries[0][1] : 0;
  const hist = baseline?.score?.hist; const edges = baseline?.score?.hist_edges;
  const live = sample.map((r) => r.score).filter((v) => v !== null);
  const scorePsi = hist && edges && live.length ? modelHealth.psi(hist, edges, live) : null;
  return {
    max_psi: r4(maxPsi), top_features: entries.slice(0, 8).map(([feature, psi]) => ({ feature, psi })),
    feature_psi: Object.fromEntries(entries.slice(0, 20)),
    score_psi: scorePsi === null ? null : r4(scorePsi),
    score_mean: report.score_drift?.live_mean_score ?? null, score_high_rate: report.score_drift?.live_high_risk_rate ?? null,
    baseline_score_mean: report.score_drift?.baseline_mean_score ?? null, baseline_high_rate: report.score_drift?.baseline_high_risk_rate ?? null,
    unseen_category_rows: report.unseen_category_rows || {}, sampled: sample.length < scored.length ? sample.length : null,
  };
}

async function qualityContext(version, settings, now) {
  const rep = await modelPerformance.report({ days: 30, now: now.getTime() });
  const v = rep.versions.find((x) => x.version === version);
  if (!v || v.reviewed < settings.min_reviewed_for_quality) {
    return { status: 'insufficient_data', reviewed: v ? v.reviewed : 0, floor: settings.min_reviewed_for_quality, flagged: v ? v.flagged : 0, review_coverage: v ? v.review_coverage : null };
  }
  return {
    status: 'ok', reviewed: v.reviewed, flagged: v.flagged, confirmed_fraud: v.confirmed_fraud, false_positives: v.false_positives, missed_candidates: v.missed_candidates,
    precision: v.precision, precision_ci: v.precision_ci, recall_estimate: v.recall_estimate, pr_auc_reviewed_only: v.pr_auc_reviewed_only, review_coverage: v.review_coverage,
    window_days: 30,
  };
}

async function latestQualitySnapshot(version, olderThanIso = null) {
  const row = await db.get(
    `SELECT * FROM drift_snapshots WHERE segment_dim = 'quality' AND model_version = ? AND status = 'ok' ${olderThanIso ? 'AND created_at <= ?' : ''} ORDER BY id DESC LIMIT 1`,
    olderThanIso ? [version, olderThanIso] : [version]);
  return row ? { ...row, quality: parseJson(row.quality, null) } : null;
}

// -------------------------------------------------------------------- the run

/**
 * One evaluation pass. Safe to call from several instances or by hand: snapshots append, alerts reconcile by
 * (version, trigger, scope), so repeating a run never duplicates an alert.
 */
async function runOnce({ now = new Date() } = {}) {
  const { settings } = await settingsService.get();
  const summary = { evaluated_at: now.toISOString(), version: null, snapshots: 0, alerts_opened: 0, alerts_updated: 0, alerts_cleared: 0, skipped: [], errors: [] };
  if (!settings.enabled) { summary.skipped.push('monitoring disabled in settings'); return summary; }

  let version;
  try { version = (await mlAdminClient.listVersions()).active; } catch (err) { summary.errors.push(`ML service unreachable: ${err.message}`); return summary; }
  if (!version) { summary.skipped.push('no active model'); return summary; }
  summary.version = version;

  // alerts about a model that is no longer serving are moot
  await db.run("UPDATE model_health_events SET resolved_at = ?, action_taken = 'cleared: model version changed' WHERE resolved_at IS NULL AND scope IS NOT NULL AND model_version <> ?", [now.toISOString(), version]);

  let baseline = null;
  try { baseline = await mlAdminClient.getBaseline(); } catch (err) { summary.errors.push(`baseline unavailable: ${err.message}`); }

  // ---- quality first: drift alerts carry it as context
  let quality = null;
  try {
    quality = await qualityContext(version, settings, now);
    await insertSnapshot({ created_at: now.toISOString(), model_version: version, window_label: '30d', window_start: new Date(now.getTime() - 30 * 86400000).toISOString(), window_end: now.toISOString(),
      segment_dim: 'quality', segment_value: 'all', n: quality.reviewed, status: quality.status, quality });
    summary.snapshots += 1;
    const prev = await latestQualitySnapshot(version, new Date(now.getTime() - 7 * 86400000).toISOString());
    let sev = 'ok'; let det = { kind: 'accuracy', quality };
    if (quality.status === 'ok' && prev?.quality?.precision_ci) {
      const [pLo] = prev.quality.precision_ci; const [, cHi] = quality.precision_ci;
      const declined = settings.quality_decline_confidence ? (cHi !== null && pLo !== null && cHi < pLo) : (quality.precision !== null && prev.quality.precision !== null && quality.precision < prev.quality.precision - 0.1);
      if (declined) { sev = 'warn'; det = { kind: 'accuracy', current: quality, previous: { at: prev.created_at, precision: prev.quality.precision, precision_ci: prev.quality.precision_ci }, message: 'Precision among analyst-reviewed alerts is lower than a week or more ago, beyond what sampling noise explains.' }; }
    }
    const res = await reconcileAlert({ version, name: 'quality_decline', scope: '30d|all', severity: sev, kind: 'accuracy', details: det, now });
    if (res === 'opened') { summary.alerts_opened += 1; summary.opened = [...(summary.opened || []), { name: 'quality_decline', severity: sev, scope: '30d|all', summary: det.message }]; } else if (res === 'cleared') summary.alerts_cleared += 1; else if (res === 'updated') summary.alerts_updated += 1;
  } catch (err) { summary.errors.push(`quality: ${err.message}`); logger.warn('Monitoring quality step failed', { error: err.message }); }

  const accuracyEvidence = (() => {
    if (!quality || quality.status !== 'ok') return 'no_labels_yet';
    return 'see_quality';
  })();
  const openQualityAlert = await db.get("SELECT id FROM model_health_events WHERE trigger_name = 'quality_decline' AND model_version = ? AND resolved_at IS NULL", [version]);

  // ---- windows x segments
  for (const hours of settings.windows_hours) {
    const label = labelFor(hours);
    const end = now; const start = new Date(now.getTime() - hours * 3600000);
    let rows;
    try { rows = await inferenceLog.loadWindow({ version, sinceIso: start.toISOString(), untilIso: new Date(now.getTime() + 1000).toISOString() }); } catch (err) { summary.errors.push(`${label}: ${err.message}`); continue; }
    const scored = rows.filter((r) => r.outcome === 'ok' && r.features && r.score !== null);

    const scopes = [{ dim: 'all', value: 'all', all: rows, scored, min: settings.min_samples_overall }];
    for (const { dim, column } of inferenceLog.SEGMENT_DIMS) {
      const groups = new Map();
      for (const r of rows) { const v = r[column]; if (!groups.has(v)) groups.set(v, []); groups.get(v).push(r); }
      const eligible = [...groups.entries()].map(([value, list]) => ({ value, list, sc: list.filter((r) => r.outcome === 'ok' && r.features && r.score !== null) }))
        .filter((g) => g.sc.length >= settings.min_samples_segment).sort((a, b) => b.sc.length - a.sc.length).slice(0, settings.max_segments_per_dimension);
      for (const g of eligible) scopes.push({ dim, value: g.value, all: g.list, scored: g.sc, min: settings.min_samples_segment });
    }

    for (const sc of scopes) {
      const scope = `${label}|${sc.dim}=${sc.value}`;
      const ops = opsMetrics(sc.all);
      const base = { created_at: now.toISOString(), model_version: version, window_label: label, window_start: start.toISOString(), window_end: end.toISOString(), segment_dim: sc.dim, segment_value: sc.value, n: sc.scored.length, ops };
      if (sc.scored.length < sc.min) {
        if (sc.dim === 'all') { await insertSnapshot({ ...base, status: 'insufficient_data' }); summary.snapshots += 1; }
        // too little data to judge: leave any open alert for this scope as it is
        continue;
      }
      let d;
      try { d = await driftOfRows(version, sc.scored, baseline); } catch (err) { summary.errors.push(`${scope}: ${err.message}`); continue; }
      const featSev = severityFor(d.max_psi, settings.psi_warn, settings.psi_critical);
      const scoreSev = severityFor(d.score_psi, settings.score_psi_warn, settings.score_psi_critical);
      const status = driftStatus(worse(featSev, scoreSev));
      await insertSnapshot({ ...base, status, max_psi: d.max_psi, feature_psi: { top: d.top_features, all: d.feature_psi, unseen_category_rows: d.unseen_category_rows }, score_psi: d.score_psi, score_mean: d.score_mean, score_high_rate: d.score_high_rate });
      summary.snapshots += 1;

      const context = { kind: 'input_shift', interpretation: INTERPRETATION, window: label, segment: { dim: sc.dim, value: sc.value }, n: sc.scored.length,
        quality_evidence: accuracyEvidence === 'no_labels_yet' ? { status: 'no_labels_yet', detail: 'Not enough analyst-reviewed alerts yet to tell whether accuracy changed.' } : { status: openQualityAlert ? 'decline_observed' : 'no_decline_observed', precision: quality.precision, precision_ci: quality.precision_ci, reviewed: quality.reviewed } };
      const results = [];
      results.push(await reconcileAlert({ version, name: 'drift_features', scope, severity: featSev, kind: 'input_shift', details: { ...context, value: d.max_psi, warn: settings.psi_warn, critical: settings.psi_critical, top_features: d.top_features.slice(0, 5) }, now }));
      results.push(await reconcileAlert({ version, name: 'drift_score', scope, severity: scoreSev, kind: 'input_shift', details: { ...context, value: d.score_psi, warn: settings.score_psi_warn, critical: settings.score_psi_critical, live_mean_score: d.score_mean, baseline_mean_score: d.baseline_score_mean }, now }));
      if (sc.dim === 'all') {
        const missSev = severityFor(ops.missing_rate, settings.missing_rate_warn, settings.missing_rate_critical);
        results.push(await reconcileAlert({ version, name: 'missing_features', scope, severity: missSev, kind: 'data_quality',
          details: { kind: 'data_quality', window: label, value: ops.missing_rate, warn: settings.missing_rate_warn, critical: settings.missing_rate_critical, top_missing_fields: ops.top_missing_fields, unseen_categories: ops.unseen_categories, n: ops.n,
            interpretation: 'Inputs were missing or defaulted, or a category was never seen in training. The model scored these with substitute values, so their scores are less reliable.' }, now }));
      }
      for (const r of results) { if (r === 'opened') summary.alerts_opened += 1; else if (r === 'updated') summary.alerts_updated += 1; else if (r === 'cleared') summary.alerts_cleared += 1; }
      const names = ['drift_features', 'drift_score', 'missing_features'];
      results.forEach((r, i) => { if (r === 'opened') { const sev = i === 0 ? featSev : i === 1 ? scoreSev : severityFor(ops.missing_rate, settings.missing_rate_warn, settings.missing_rate_critical); (summary.opened = summary.opened || []).push({ name: names[i], severity: sev, scope, summary: i === 2 ? `missing/defaulted inputs on ${(ops.missing_rate * 100).toFixed(1)}% of inferences` : `PSI ${i === 0 ? d.max_psi : d.score_psi}` }); } });
    }
  }

  // retention
  try {
    await inferenceLog.prune(config.monitoring.inferenceRetentionDays);
    const cutoff = new Date(now.getTime() - config.monitoring.snapshotRetentionDays * 86400000).toISOString();
    await db.run('DELETE FROM drift_snapshots WHERE created_at < ?', [cutoff]);
  } catch (err) { summary.errors.push(`retention: ${err.message}`); }

  await settingsService.kvSet('last_run', JSON.stringify({ at: now.toISOString(), version, errors: summary.errors.length, snapshots: summary.snapshots }));
  notifyAdmins(summary.opened || []).catch(() => {});
  return summary;
}

// -------------------------------------------------------------------- reads

async function openAlerts({ includeResolved = false, limit = 100 } = {}) {
  const rows = await db.all(
    `SELECT e.*, u.username AS acknowledged_by_username FROM model_health_events e LEFT JOIN users u ON u.id = e.acknowledged_by
      WHERE e.scope IS NOT NULL ${includeResolved ? '' : 'AND e.resolved_at IS NULL'} ORDER BY e.id DESC LIMIT ?`, [limit]);
  return rows.map((r) => ({ ...r, id: Number(r.id), details: parseJson(r.details, {}), acknowledged: !!r.acknowledged_at }));
}

async function acknowledge(id, { note, userId }) {
  const row = await db.get('SELECT * FROM model_health_events WHERE id = ? AND scope IS NOT NULL', [id]);
  if (!row) return { error: 'NOT_FOUND' };
  if (row.resolved_at) return { error: 'ALREADY_RESOLVED' };
  const r = await db.run('UPDATE model_health_events SET acknowledged_by = ?, acknowledged_at = ?, ack_note = ? WHERE id = ? AND acknowledged_at IS NULL', [userId, new Date().toISOString(), note, id]);
  if (r.changes === 0) return { error: 'ALREADY_ACKNOWLEDGED' };
  return { ok: true };
}

async function snapshots({ window, dim = 'all', value = 'all', limit = 200, version }) {
  const rows = await db.all(
    `SELECT * FROM drift_snapshots WHERE segment_dim = ? AND segment_value = ? ${window ? 'AND window_label = ?' : ''} ${version ? 'AND model_version = ?' : ''} ORDER BY id DESC LIMIT ?`,
    [dim, value, ...(window ? [window] : []), ...(version ? [version] : []), limit]);
  return rows.reverse().map((r) => ({ ...r, id: Number(r.id), n: Number(r.n), max_psi: r.max_psi === null ? null : Number(r.max_psi), score_psi: r.score_psi === null ? null : Number(r.score_psi), feature_psi: parseJson(r.feature_psi, null), ops: parseJson(r.ops, null), quality: parseJson(r.quality, null) }));
}

/** Latest snapshot per segment for a window. */
async function segments(window) {
  const rows = await db.all(
    `SELECT s.* FROM drift_snapshots s WHERE s.window_label = ? AND s.segment_dim <> 'quality' AND s.id = (
       SELECT MAX(id) FROM drift_snapshots x WHERE x.window_label = s.window_label AND x.segment_dim = s.segment_dim AND x.segment_value = s.segment_value) ORDER BY s.segment_dim, s.segment_value`, [window]);
  return rows.map((r) => ({ id: Number(r.id), created_at: r.created_at, model_version: r.model_version, segment_dim: r.segment_dim, segment_value: r.segment_value, n: Number(r.n), status: r.status,
    max_psi: r.max_psi === null ? null : Number(r.max_psi), score_psi: r.score_psi === null ? null : Number(r.score_psi), top_features: parseJson(r.feature_psi, null)?.top || [], ops: parseJson(r.ops, null) }));
}

/** Live operational view straight from the durable log (no ML call): works even when the ML service is down. */
async function operations({ hours = 24, now = new Date() } = {}) {
  const { active } = await mlAdminClient.listVersions().catch(() => ({ active: null }));
  const start = new Date(now.getTime() - hours * 3600000);
  const rows = await inferenceLog.loadWindow({ version: active, sinceIso: start.toISOString(), untilIso: new Date(now.getTime() + 1000).toISOString() });
  // when the ML service is down no version is known; failures (null version) are still shown
  const buckets = new Map();
  const bucketMs = hours <= 48 ? 3600000 : 86400000;
  for (const r of rows) { const t = Math.floor(new Date(r.created_at).getTime() / bucketMs) * bucketMs; if (!buckets.has(t)) buckets.set(t, []); buckets.get(t).push(r); }
  const series = [...buckets.entries()].sort((a, b) => a[0] - b[0]).map(([t, list]) => { const o = opsMetrics(list); return { at: new Date(t).toISOString(), n: o.n, fallback_rate: o.fallback_rate, latency_p95_ms: o.latency_p95_ms, missing_rate: o.missing_rate }; });
  return { version: active, window_hours: hours, ...opsMetrics(rows), series };
}

async function overview({ now = new Date() } = {}) {
  const [{ settings, updated_at, source }, alerts, ops, lastRun, shadow] = await Promise.all([
    settingsService.get(), openAlerts(), operations({ now }), settingsService.kvGet('last_run'),
    mlAdminClient.getShadowStatus().catch(() => null),
  ]);
  const latest = {};
  for (const w of settings.windows_hours.map(labelFor)) latest[w] = (await snapshots({ window: w, dim: 'all', value: 'all', limit: 1 }))[0] || null;
  const quality = (await snapshots({ dim: 'quality', value: 'all', limit: 12 }));
  return {
    version: ops.version, generated_at: now.toISOString(), last_run: parseJson(lastRun, null),
    settings, settings_source: source, settings_updated_at: updated_at,
    operations: ops, latest_drift: latest, quality_trend: quality, shadow: shadow && shadow.active ? shadow : null,
    open_alerts: alerts, interpretation: INTERPRETATION,
  };
}

// -------------------------------------------------------------------- timer

let timer = null;
function start() {
  if (timer || !config.monitoring.intervalMs) return;
  timer = setInterval(() => { runOnce().catch((e) => logger.error('Monitoring run failed', { error: e.message })); }, config.monitoring.intervalMs);
  timer.unref?.();
}
function stop() { if (timer) { clearInterval(timer); timer = null; } }

module.exports = { runOnce, overview, operations, snapshots, segments, openAlerts, acknowledge, opsMetrics, severityFor, reconcileAlert, start, stop, labelFor, INTERPRETATION };
