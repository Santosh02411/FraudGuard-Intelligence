/** Append-only, versioned verification policy (same pattern as risk_policy). */
const db = require('../config/database');
const config = require('../config/env');
const { DEFAULT_POLICY } = require('./verificationPolicy');

const parse = (s, d) => { try { return JSON.parse(s); } catch { return d; } };
function normalize(row) {
  return {
    version: Number(row.version), mode: row.mode, actions: parse(row.actions, DEFAULT_POLICY.actions),
    min_amount: row.min_amount === null || row.min_amount === undefined ? null : Number(row.min_amount),
    ttl_seconds: Number(row.ttl_seconds), note: row.note, created_by: row.created_by ?? null,
    created_by_username: row.created_by_username ?? null, created_at: row.created_at, source: 'saved',
  };
}

async function getActive() {
  const row = await db.get('SELECT * FROM verification_policy ORDER BY version DESC LIMIT 1');
  if (row) return normalize(row);
  return { ...DEFAULT_POLICY, ttl_seconds: Math.round(config.stepUpChallengeTtlMs / 1000) };
}

async function history(limit = 20) {
  const rows = await db.all(
    `SELECT p.*, u.username AS created_by_username FROM verification_policy p LEFT JOIN users u ON u.id = p.created_by ORDER BY p.version DESC LIMIT ?`, [limit]);
  return rows.map(normalize);
}

async function create({ mode, actions, min_amount = null, ttl_seconds, note, createdBy }) {
  const { lastInsertRowid } = await db.insert(
    'INSERT INTO verification_policy (mode, actions, min_amount, ttl_seconds, note, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING version',
    [mode, JSON.stringify(actions), min_amount, ttl_seconds, note, createdBy || null, new Date().toISOString()]);
  return normalize(await db.get('SELECT * FROM verification_policy WHERE version = ?', [lastInsertRowid]));
}

module.exports = { getActive, history, create };
