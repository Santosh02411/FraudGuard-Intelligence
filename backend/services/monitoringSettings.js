/** Admin-configurable monitoring thresholds, persisted (monitoring_settings). Defaults derive from the existing model-health env limits. */
const db = require('../config/database');
const config = require('../config/env');

function defaults() {
  const g = config.modelGovernance;
  return {
    enabled: true,
    windows_hours: [24, 168],
    psi_warn: 0.1, psi_critical: 0.25,                 // worst single-feature PSI against the training baseline
    score_psi_warn: Number((g.maxPsi * 0.4).toFixed(3)), score_psi_critical: g.maxPsi,
    missing_rate_warn: 0.02, missing_rate_critical: 0.1, // share of inferences with at least one missing/defaulted input
    min_samples_overall: 100, min_samples_segment: 50,
    min_reviewed_for_quality: 20,
    quality_decline_confidence: true,                    // flag a precision decline only when the 95% intervals do not overlap
    max_segments_per_dimension: 8,
  };
}

const RANGES = {
  psi_warn: [0.01, 5], psi_critical: [0.01, 10], score_psi_warn: [0.01, 5], score_psi_critical: [0.01, 10],
  missing_rate_warn: [0, 1], missing_rate_critical: [0, 1],
  min_samples_overall: [10, 100000], min_samples_segment: [10, 100000], min_reviewed_for_quality: [5, 100000], max_segments_per_dimension: [0, 20],
};

function validate(s) {
  const problems = [];
  for (const [k, [lo, hi]] of Object.entries(RANGES)) {
    if (typeof s[k] !== 'number' || !(s[k] >= lo && s[k] <= hi)) problems.push(`${k} must be a number between ${lo} and ${hi}`);
  }
  if (s.psi_warn >= s.psi_critical) problems.push('psi_warn must be below psi_critical');
  if (s.score_psi_warn >= s.score_psi_critical) problems.push('score_psi_warn must be below score_psi_critical');
  if (s.missing_rate_warn >= s.missing_rate_critical) problems.push('missing_rate_warn must be below missing_rate_critical');
  if (!Array.isArray(s.windows_hours) || !s.windows_hours.length || s.windows_hours.length > 4 || s.windows_hours.some((h) => !Number.isInteger(h) || h < 1 || h > 720)) problems.push('windows_hours must be 1-4 whole numbers of hours between 1 and 720');
  return problems;
}

async function get() {
  const row = await db.get("SELECT value, updated_by, updated_at FROM monitoring_settings WHERE key = 'thresholds'");
  let saved = {};
  try { saved = row ? JSON.parse(row.value) : {}; } catch { saved = {}; }
  return { settings: { ...defaults(), ...saved }, updated_by: row?.updated_by ?? null, updated_at: row?.updated_at ?? null, source: row ? 'saved' : 'default' };
}

async function save(settings, userId) {
  const now = new Date().toISOString();
  const value = JSON.stringify(settings);
  const r = await db.run("UPDATE monitoring_settings SET value = ?, updated_by = ?, updated_at = ? WHERE key = 'thresholds'", [value, userId, now]);
  if (r.changes === 0) await db.run("INSERT INTO monitoring_settings (key, value, updated_by, updated_at) VALUES ('thresholds', ?, ?, ?)", [value, userId, now]);
}

async function kvGet(key) { const r = await db.get('SELECT value FROM monitoring_settings WHERE key = ?', [key]); return r ? r.value : null; }
async function kvSet(key, value) {
  const now = new Date().toISOString();
  const r = await db.run('UPDATE monitoring_settings SET value = ?, updated_at = ? WHERE key = ?', [value, now, key]);
  if (r.changes === 0) await db.run('INSERT INTO monitoring_settings (key, value, updated_by, updated_at) VALUES (?, ?, NULL, ?)', [key, value, now]);
}

module.exports = { get, save, validate, defaults, RANGES, kvGet, kvSet };
