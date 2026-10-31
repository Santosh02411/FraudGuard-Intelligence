/**
 * API keys (feature: service-to-service auth). A merchant's backend
 * integrating with the fraud API shouldn't need to hold a human's
 * password-derived session (an access token tied to someone's login,
 * refreshed via someone's refresh token) just to call POST
 * /transactions programmatically — that's what API keys are for: a
 * credential that belongs to the integration itself, independently
 * revocable, with its own name and scope, without ever touching a
 * user's password.
 *
 * Format mirrors Stripe/GitHub-style keys: a recognizable prefix (so a
 * key can be identified as "one of ours" in a leaked-secrets scan)
 * followed by high-entropy random data. Only the SHA-256 hash is ever
 * persisted — see middleware/apiKeyAuth.js — same reasoning as
 * password/refresh-token storage: a database read alone should never
 * hand over a usable credential.
 */

const crypto = require('crypto');

const KEY_PREFIX = 'fg_live_';
const PREFIX_DISPLAY_CHARS = 12; // how much of the key is shown after creation for identification, e.g. "fg_live_a1b2c3d4..."

function generateApiKey() {
  const random = crypto.randomBytes(24).toString('base64url'); // ~32 URL-safe chars
  return `${KEY_PREFIX}${random}`;
}

function hashApiKey(key) {
  return crypto.createHash('sha256').update(key).digest('hex');
}

function displayPrefix(key) {
  return key.slice(0, PREFIX_DISPLAY_CHARS);
}

module.exports = { generateApiKey, hashApiKey, displayPrefix, KEY_PREFIX };
