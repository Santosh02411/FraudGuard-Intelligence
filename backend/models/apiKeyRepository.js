const db = require('../config/database');

function parseRow(row) {
  if (!row) return row;
  return { ...row, scopes: JSON.parse(row.scopes || '[]') };
}

async function create({ userId, name, keyHash, keyPrefix, scopes, createdBy, expiresAt }) {
  return db.insert(
    'INSERT INTO api_keys (user_id, name, key_hash, key_prefix, scopes, created_by, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [userId, name, keyHash, keyPrefix, JSON.stringify(scopes), createdBy || null, expiresAt || null]
  );
}

async function findByHash(keyHash) {
  return parseRow(await db.get('SELECT * FROM api_keys WHERE key_hash = ?', [keyHash]));
}

async function findById(id) {
  return parseRow(await db.get('SELECT * FROM api_keys WHERE id = ?', [id]));
}

async function forUser(userId) {
  const rows = await db.all('SELECT * FROM api_keys WHERE user_id = ? ORDER BY created_at DESC', [userId]);
  return rows.map(parseRow);
}

async function allWithUsername() {
  const rows = await db.all(`
    SELECT k.*, u.username FROM api_keys k
    JOIN users u ON k.user_id = u.id
    ORDER BY k.created_at DESC
  `);
  return rows.map(parseRow);
}

/** Best-effort — called on every authenticated request (see
 * middleware/apiKeyAuth.js) without being awaited, so a slow write here
 * never adds latency to the request that triggered it. */
async function touchLastUsed(id) {
  return db.run('UPDATE api_keys SET last_used_at = CURRENT_TIMESTAMP WHERE id = ?', [id]);
}

async function revoke(id) {
  return db.run('UPDATE api_keys SET revoked_at = CURRENT_TIMESTAMP WHERE id = ? AND revoked_at IS NULL', [id]);
}

/** Used by account deletion (routes/auth.js DELETE /me) — revokes every
 * active key belonging to a user in one statement, rather than the
 * caller looping revoke() per key. */
async function revokeAllForUser(userId) {
  return db.run('UPDATE api_keys SET revoked_at = CURRENT_TIMESTAMP WHERE user_id = ? AND revoked_at IS NULL', [userId]);
}

module.exports = { create, findByHash, findById, forUser, allWithUsername, touchLastUsed, revoke, revokeAllForUser };
