const crypto = require('crypto');
const { isDemoEmail } = require('../config/demo');
const bcrypt = require('bcryptjs');
const db = require('../config/database');

async function findByUsernameOrEmail(username, email) {
  return db.get('SELECT id FROM users WHERE username = ? OR email = ?', [username, email]);
}

async function findByUsername(username) {
  return db.get('SELECT * FROM users WHERE username = ?', [username]);
}

/**
 * Excludes anonymized/deleted accounts (feature: self-service account
 * deletion) — this is the lookup authMiddleware and apiKeyAuth.js both
 * use on every authenticated request, so filtering here is what makes a
 * deletion take effect immediately: a still-valid access token or API
 * key belonging to a just-deleted account starts failing auth on its
 * very next request, without needing to track/revoke stateless JWTs
 * individually.
 */
async function findById(id) {
  return db.get('SELECT id, username, email, role, email_verified, totp_enabled FROM users WHERE id = ? AND deleted_at IS NULL', [id]);
}

/** Full row, including auth-sensitive fields (password hash, TOTP
 * secret/backup codes) — used only where those are genuinely needed
 * (changing your own password, checking TOTP state at login), never
 * exposed via findById's projection above. */
async function findByIdFull(id) {
  return db.get('SELECT * FROM users WHERE id = ?', [id]);
}

async function findByEmail(email) {
  return db.get('SELECT * FROM users WHERE email = ?', [email]);
}

async function create({ username, email, passwordHash, role = 'user' }) {
  const { lastInsertRowid } = await db.insert(
    'INSERT INTO users (username, email, password, role) VALUES (?, ?, ?, ?)',
    [username, email, passwordHash, role]
  );
  return { id: lastInsertRowid, username, email, role };
}

async function listWithStats() {
  const rows = await db.all(`
    SELECT u.id, u.username, u.email, u.role, u.created_at,
      COUNT(t.id) as total_transactions,
      COALESCE(SUM(t.is_fraud), 0) as fraud_count,
      CASE WHEN COUNT(t.id) > 0
        THEN ROUND(SUM(t.is_fraud) * 100.0 / COUNT(t.id), 2)
        ELSE 0 END as fraud_rate
    FROM users u
    LEFT JOIN transactions t ON t.user_id = u.id
    GROUP BY u.id, u.username, u.email, u.role, u.created_at
    ORDER BY u.created_at ASC
  `);
  // Postgres returns COUNT()/SUM() as strings (BIGINT semantics avoid JS
  // precision loss); SQLite returns native numbers. Normalize here so
  // every caller gets the same JS types regardless of dialect.
  return rows.map((r) => ({
    ...r,
    is_demo: isDemoEmail(r.email),
    total_transactions: Number(r.total_transactions),
    fraud_count: Number(r.fraud_count),
    fraud_rate: Number(r.fraud_rate),
  }));
}

async function updateRole(id, role) {
  return db.run('UPDATE users SET role = ? WHERE id = ?', [role, id]);
}

async function count() {
  const row = await db.get('SELECT COUNT(*) as count FROM users');
  return Number(row.count);
}

/** Non-admin user ids — used by realtime/simulator.js to pick a random
 * account to attribute a synthetic transaction to. Excludes admins so
 * the demo feed doesn't inflate the admin account's own history. */
async function listDemoUserIds() {
  const rows = await db.all("SELECT id FROM users WHERE role != 'admin' AND LOWER(email) LIKE ?", ['%@demo.fraudguard.io']);
  return rows.map((r) => r.id);
}

async function listNonAdminIds() {
  const rows = await db.all("SELECT id FROM users WHERE role != 'admin'");
  return rows.map((r) => r.id);
}

// --- Account lockout (feature: login attempt lockout, see routes/auth.js) ---

/** Bumps the failed-attempt counter and returns the new count, so the
 * caller can decide whether it crosses the lockout threshold. */
async function incrementFailedAttempts(id) {
  await db.run('UPDATE users SET failed_login_attempts = failed_login_attempts + 1 WHERE id = ?', [id]);
  const row = await db.get('SELECT failed_login_attempts FROM users WHERE id = ?', [id]);
  return Number(row.failed_login_attempts);
}

/** `until`: ISO-8601 string (computed in JS, not DB-side date math, so
 * the same call works identically against SQLite and Postgres). */
async function lockAccount(id, until) {
  return db.run('UPDATE users SET locked_until = ? WHERE id = ?', [until, id]);
}

/** Called on a successful login — clears both the counter and any lock. */
async function resetLoginAttempts(id) {
  return db.run('UPDATE users SET failed_login_attempts = 0, locked_until = NULL WHERE id = ?', [id]);
}

// --- Email verification (feature: email verification on register) ---

async function setEmailVerificationToken(id, tokenHash, expiresAt) {
  return db.run(
    'UPDATE users SET email_verification_token_hash = ?, email_verification_expires_at = ? WHERE id = ?',
    [tokenHash, expiresAt, id]
  );
}

async function findByEmailVerificationTokenHash(tokenHash) {
  return db.get('SELECT * FROM users WHERE email_verification_token_hash = ?', [tokenHash]);
}

async function markEmailVerified(id) {
  return db.run(
    'UPDATE users SET email_verified = 1, email_verification_token_hash = NULL, email_verification_expires_at = NULL WHERE id = ?',
    [id]
  );
}

// --- Password reset (feature: forgot-password / reset-password flow) ---

async function setPasswordResetToken(id, tokenHash, expiresAt) {
  return db.run(
    'UPDATE users SET password_reset_token_hash = ?, password_reset_expires_at = ? WHERE id = ?',
    [tokenHash, expiresAt, id]
  );
}

async function findByPasswordResetTokenHash(tokenHash) {
  return db.get('SELECT * FROM users WHERE password_reset_token_hash = ?', [tokenHash]);
}

/** Used by both the "forgot password" reset flow and the self-service
 * "change my password" endpoint — either way, any in-flight reset token
 * for the account is invalidated once the password actually changes. */
async function updatePassword(id, passwordHash) {
  return db.run(
    'UPDATE users SET password = ?, password_reset_token_hash = NULL, password_reset_expires_at = NULL WHERE id = ?',
    [passwordHash, id]
  );
}

// --- Self-service profile (feature: change own email) ---

/** Changing email re-requires verification of the new address — see
 * routes/auth.js's PATCH /email, which calls this then sends a fresh
 * verification email. */
async function updateEmail(id, email) {
  return db.run('UPDATE users SET email = ?, email_verified = 0 WHERE id = ?', [email, id]);
}

// --- TOTP / MFA (feature: 2FA) ---

/** Stores a newly-generated secret as *pending* — TOTP isn't actually
 * required at login until enableTotp() below flips totp_enabled. */
async function setPendingTotpSecret(id, secret) {
  return db.run('UPDATE users SET totp_secret = ? WHERE id = ?', [secret, id]);
}

async function enableTotp(id, hashedBackupCodes) {
  return db.run(
    'UPDATE users SET totp_enabled = 1, totp_backup_codes = ? WHERE id = ?',
    [JSON.stringify(hashedBackupCodes), id]
  );
}

async function disableTotp(id) {
  return db.run(
    'UPDATE users SET totp_enabled = 0, totp_secret = NULL, totp_backup_codes = NULL WHERE id = ?',
    [id]
  );
}

/** Persists the backup-code list after one has been consumed (see
 * services/totpService.js's consumeBackupCode, which returns the
 * remaining set for the caller to save back here). */
async function updateBackupCodes(id, hashedBackupCodes) {
  return db.run('UPDATE users SET totp_backup_codes = ? WHERE id = ?', [JSON.stringify(hashedBackupCodes), id]);
}

// --- Account deletion (feature: self-service data export + deletion) ---

/**
 * Anonymizes rather than hard-deletes an account: username/email are
 * scrambled to an unguessable placeholder (freeing the originals for
 * reuse by a new registration), the password hash is replaced with a
 * random unguessable value (no one can ever authenticate as this
 * account again, including via a stale bcrypt comparison), and every
 * MFA/reset/verification credential is cleared. `deleted_at` is what
 * userRepository.findById filters on, which is what actually revokes
 * access immediately — see that function's comment.
 *
 * Transactions and alerts created by this account are deliberately
 * NOT deleted or reassigned: this app's own dynamic fraud blacklist
 * (transactionRepository.fraudDeviceAndIpBlacklist) and audit trail
 * depend on historical transaction/alert data staying intact regardless
 * of whether the account that created it still exists — losing that
 * history the moment someone closes their account would be a real
 * fraud-prevention regression, not a privacy improvement. Every
 * transaction/alert record already avoids storing anything beyond what
 * fraud detection actually needs (no PAN, no cardholder name), so
 * retaining it after account closure isn't retaining "personal data"
 * beyond what a fraud system legitimately keeps.
 */
async function anonymize(id) {
  const placeholder = `deleted_user_${id}_${crypto.randomBytes(4).toString('hex')}`;
  const randomPassword = bcrypt.hashSync(crypto.randomBytes(32).toString('hex'), 10);
  return db.run(
    `UPDATE users SET
       username = ?,
       email = ?,
       password = ?,
       email_verified = 0,
       email_verification_token_hash = NULL,
       email_verification_expires_at = NULL,
       password_reset_token_hash = NULL,
       password_reset_expires_at = NULL,
       totp_secret = NULL,
       totp_enabled = 0,
       totp_backup_codes = NULL,
       deleted_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [placeholder, `${placeholder}@deleted.invalid`, randomPassword, id]
  );
}

module.exports = {
  findByUsernameOrEmail, findByUsername, findById, findByIdFull, findByEmail,
  create, listWithStats, updateRole, count,
  listNonAdminIds, listDemoUserIds, incrementFailedAttempts, lockAccount, resetLoginAttempts,
  setEmailVerificationToken, findByEmailVerificationTokenHash, markEmailVerified,
  setPasswordResetToken, findByPasswordResetTokenHash, updatePassword, updateEmail,
  setPendingTotpSecret, enableTotp, disableTotp, updateBackupCodes, anonymize,
};
