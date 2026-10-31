/**
 * Risk Policy Repository
 * =========================
 * Three different things used to be one number:
 *
 *   1. MODEL PROBABILITY  - the ML model's calibrated P(fraud). A fact about the
 *                           transaction as the model sees it. Stored in
 *                           transactions.model_probability.
 *   2. POLICY DECISION    - low / medium (review) / high (treat as fraud). A
 *                           BUSINESS choice about how much risk to accept,
 *                           made by comparing (1) to the thresholds below.
 *                           Stored in transactions.risk_level / is_fraud, tagged
 *                           with policy_version.
 *   3. CONFIRMED OUTCOME  - what actually happened (analyst verdict on the
 *                           alert, later a dispute). Stored in alerts.verdict.
 *
 * Only (2) is a policy, so only (2) is configurable. Thresholds are in SCORE
 * units: score = calibrated probability x 100, so "medium = 10" means "send to
 * review when the model thinks there is at least a 1-in-10 chance of fraud".
 *
 * Changes are versioned and append-only: every transaction records the
 * policy_version it was decided under, so a threshold change never silently
 * rewrites history, and analytics can tell which thresholds produced which
 * decisions.
 */

const db = require('../config/database');

const { DEFAULT_POLICY, LIMITS, validateThresholds, levelFor } = require('./riskPolicy');

function normalize(row) {
  return {
    version: Number(row.version),
    medium_threshold: Number(row.medium_threshold),
    high_threshold: Number(row.high_threshold),
    review_capacity_per_day: row.review_capacity_per_day === null || row.review_capacity_per_day === undefined
      ? null : Number(row.review_capacity_per_day),
    note: row.note,
    created_by: row.created_by ?? null,
    created_by_username: row.created_by_username ?? null,
    created_at: row.created_at,
    source: 'saved',
  };
}

async function getActive() {
  const row = await db.get('SELECT * FROM risk_policy ORDER BY version DESC LIMIT 1');
  return row ? normalize(row) : { ...DEFAULT_POLICY };
}

async function history(limit = 20) {
  const rows = await db.all(
    `SELECT p.*, u.username as created_by_username FROM risk_policy p
     LEFT JOIN users u ON p.created_by = u.id
     ORDER BY p.version DESC LIMIT ?`,
    [limit]
  );
  return rows.map(normalize);
}

/** Policies in force at any point since `sinceIso` (used to know how far
 *  down the labelled data actually reaches — see riskPolicyAnalytics). */
async function listSince(sinceVersionCutoffIso) {
  const rows = await db.all('SELECT * FROM risk_policy WHERE created_at >= ? ORDER BY version', [sinceVersionCutoffIso]);
  return rows.map(normalize);
}

async function create({ medium_threshold, high_threshold, review_capacity_per_day = null, note, createdBy }) {
  const { lastInsertRowid } = await db.insert(
    'INSERT INTO risk_policy (medium_threshold, high_threshold, review_capacity_per_day, note, created_by) VALUES (?, ?, ?, ?, ?) RETURNING version',
    [medium_threshold, high_threshold, review_capacity_per_day, note, createdBy || null]
  );
  const row = await db.get('SELECT * FROM risk_policy WHERE version = ?', [lastInsertRowid]);
  return normalize(row);
}

module.exports = { DEFAULT_POLICY, LIMITS, validateThresholds, levelFor, getActive, history, listSince, create };
