/**
 * TOTP-based two-factor authentication (feature: MFA/2FA).
 * =============================================================
 * RFC 6238 TOTP via otplib — compatible with Google Authenticator, Authy,
 * 1Password, and any standard authenticator app. See routes/auth.js for
 * how this fits into the login flow: a user with `totp_enabled` doesn't
 * get a token pair from POST /login directly — they get a short-lived
 * MFA challenge token and must complete POST /login/mfa with a code from
 * this module before a real session is issued.
 *
 * Backup codes exist for the "lost my phone" case — without them, a
 * user who loses their authenticator device is permanently locked out
 * of an account they otherwise fully control, which is worse than the
 * account-takeover risk 2FA is meant to reduce in the first place.
 */

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { authenticator } = require('otplib');
const qrcode = require('qrcode');

const BACKUP_CODE_COUNT = 8;

function generateTotpSecret() {
  return authenticator.generateSecret();
}

function buildOtpauthUrl(secret, username) {
  return authenticator.keyuri(username, 'FraudGuard', secret);
}

async function generateQrCodeDataUrl(otpauthUrl) {
  return qrcode.toDataURL(otpauthUrl);
}

/** `token` is the 6-digit code from the user's authenticator app. */
async function verifyTotpToken(secret, token) {
  if (!token || !/^\d{6}$/.test(token)) return false;
  try {
    return authenticator.check(token, secret);
  } catch (err) {
    return false; // otplib throws on a malformed secret rather than returning false
  }
}

/**
 * Backup codes: 8 codes, 10 hex chars each, formatted like
 * "a1b2-c3d4e5" for readability. Returned in plaintext exactly once
 * (at generation time) — only bcrypt hashes are ever persisted, same
 * reasoning as password storage: a DB read shouldn't hand over a
 * usable credential.
 */
function generateBackupCodes(count = BACKUP_CODE_COUNT) {
  return Array.from({ length: count }, () => {
    const raw = crypto.randomBytes(5).toString('hex'); // 10 hex chars
    return `${raw.slice(0, 4)}-${raw.slice(4)}`;
  });
}

function hashBackupCodes(codes) {
  return codes.map((code) => bcrypt.hashSync(code, 10));
}

/**
 * Checks `code` against the stored (hashed) backup codes and, if it
 * matches, returns the remaining set with that one removed — backup
 * codes are single-use, so the caller persists this returned array back
 * to replace what was stored. Returns null if no code matched.
 */
function consumeBackupCode(code, hashedCodes) {
  const normalized = (code || '').trim().toLowerCase();
  const index = hashedCodes.findIndex((hash) => bcrypt.compareSync(normalized, hash));
  if (index === -1) return null;
  return [...hashedCodes.slice(0, index), ...hashedCodes.slice(index + 1)];
}

module.exports = {
  generateTotpSecret, buildOtpauthUrl, generateQrCodeDataUrl, verifyTotpToken,
  generateBackupCodes, hashBackupCodes, consumeBackupCode, BACKUP_CODE_COUNT,
};
