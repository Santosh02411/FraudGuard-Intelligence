/**
 * Rule-set versions
 * ====================
 * The hard rules (blacklists, amount cap) are editable at runtime, so "the
 * rules" is not one thing over time. Every distinct ENABLED configuration is
 * stored once, immutably, with a hash. A decision records the version it was
 * made under; an investigator can open that version and see exactly which
 * merchants/locations/devices/IPs were blacklisted and what the cap was.
 *
 * Versions are captured (a) right after every admin change to the rules and
 * (b) lazily, whenever the stored latest version differs from what the live
 * table says (a change made outside the API, a seed, a restore). So a decision
 * can never be recorded against a stale version number.
 */
const crypto = require('crypto');
const db = require('../config/database');

function canonical(rows) {
  const items = rows
    .map((r) => ({ rule_type: r.rule_type, value: r.value ?? null, threshold: r.threshold === null || r.threshold === undefined ? null : Number(r.threshold) }))
    .sort((a, b) => `${a.rule_type}|${a.value}|${a.threshold}`.localeCompare(`${b.rule_type}|${b.value}|${b.threshold}`));
  return JSON.stringify(items);
}
const hashOf = (json) => crypto.createHash('sha256').update(json).digest('hex');

async function latest() {
  return db.get('SELECT * FROM rule_set_versions ORDER BY id DESC LIMIT 1');
}

/** Returns {id, hash, created} for the live rules, creating a new version if they changed. */
async function captureIfChanged({ by = null, note = 'rules changed' } = {}) {
  const rows = await db.all('SELECT rule_type, value, threshold FROM fraud_rules WHERE enabled = 1');
  const json = canonical(rows);
  const hash = hashOf(json);
  const last = await latest();
  if (last && last.hash === hash) return { id: Number(last.id), hash, created: false };
  try {
    const { lastInsertRowid } = await db.insert(
      'INSERT INTO rule_set_versions (parent_id, hash, config, note, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      [last ? Number(last.id) : 0, hash, json, note, by, new Date().toISOString()]
    );
    return { id: Number(lastInsertRowid), hash, created: true };
  } catch (err) {
    // A concurrent request captured the same change first.
    if (!/unique|duplicate/i.test(err.message)) throw err;
    const again = await latest();
    return { id: Number(again.id), hash: again.hash, created: false };
  }
}

async function get(id) {
  const row = await db.get('SELECT * FROM rule_set_versions WHERE id = ?', [id]);
  return row ? { ...row, id: Number(row.id), config: JSON.parse(row.config) } : null;
}

async function list(limit = 50) {
  const rows = await db.all('SELECT id, parent_id, hash, note, created_by, created_at FROM rule_set_versions ORDER BY id DESC LIMIT ?', [limit]);
  return rows.map((r) => ({ ...r, id: Number(r.id) }));
}

module.exports = { captureIfChanged, get, list, canonical, hashOf };
