/**
 * Refresh tokens (feature: short-lived access token + long-lived refresh
 * token, instead of one long-lived JWT). See routes/auth.js for the
 * issue/rotate/revoke flow.
 *
 * The raw token is a high-entropy random value generated in routes/
 * auth.js and returned to the client exactly once; only its SHA-256
 * hash is ever persisted, so a database read (backup leak, SQL
 * injection, etc.) doesn't hand over a usable credential — the same
 * reasoning as bcrypt for passwords, minus the deliberate slowness,
 * which isn't needed here since the input is already high-entropy
 * rather than a human-guessable password.
 */

const db = require('../config/database');

async function create({ userId, tokenHash, expiresAt, ipAddress }) {
  const { lastInsertRowid } = await db.insert(
    'INSERT INTO refresh_tokens (user_id, token_hash, expires_at, ip_address) VALUES (?, ?, ?, ?)',
    [userId, tokenHash, expiresAt, ipAddress || null]
  );
  return { id: lastInsertRowid, userId, tokenHash, expiresAt };
}

/** Looks up a token by its hash. Returns null if it doesn't exist —
 * doesn't itself check expiry/revocation, so callers can distinguish
 * "never existed" from "existed but is no longer valid" if useful. */
async function findByHash(tokenHash) {
  return db.get('SELECT * FROM refresh_tokens WHERE token_hash = ?', [tokenHash]);
}

/** Marks a token used/rotated: revoked, with a pointer to its replacement
 * — preserves rotation lineage, which is what lets a reuse of an already-
 * rotated token be recognized as a signal the token was stolen (see
 * routes/auth.js's /refresh handler). */
async function revoke(id, replacedById = null) {
  return db.run(
    'UPDATE refresh_tokens SET revoked_at = CURRENT_TIMESTAMP, replaced_by_id = ? WHERE id = ?',
    [replacedById, id]
  );
}

/** Revokes every active token for a user — used on password-change-like
 * events (e.g. an admin unlocking/demoting an account) to force
 * re-authentication everywhere that account is logged in. */
async function revokeAllForUser(userId) {
  return db.run(
    'UPDATE refresh_tokens SET revoked_at = CURRENT_TIMESTAMP WHERE user_id = ? AND revoked_at IS NULL',
    [userId]
  );
}

module.exports = { create, findByHash, revoke, revokeAllForUser };
