const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const userRepository = require('../models/userRepository');
const refreshTokenRepository = require('../models/refreshTokenRepository');
const transactionRepository = require('../models/transactionRepository');
const alertRepository = require('../models/alertRepository');
const auditLogRepository = require('../models/auditLogRepository');
const apiKeyRepository = require('../models/apiKeyRepository');
const webhookRepository = require('../models/webhookRepository');
const emailService = require('../services/emailService');
const totpService = require('../services/totpService');
const config = require('../config/env');
const { authMiddleware } = require('../middleware/auth');
const { AppError, asyncHandler } = require('../middleware/errorHandler');
const { validate } = require('../middleware/validate');
const { authLimiter } = require('../middleware/rateLimiters');
const authSchemas = require('../schemas/authSchemas');
const { audit } = require('../middleware/auditLog');

/**
 * Auth: short-lived access JWT + long-lived rotating refresh token,
 * instead of one long-lived JWT (feature: refresh tokens). The access
 * token (config.jwtAccessExpiresIn, default 15m) is what authMiddleware
 * verifies on every request; the refresh token (opaque, random, hashed
 * at rest — see models/refreshTokenRepository.js) is only ever sent to
 * POST /refresh to mint a new pair. Shortening the access token's blast
 * radius (a leaked one is only useful for ~15 minutes) is the whole
 * point — the refresh token is the thing worth protecting long-term,
 * and it's revocable server-side (logout, reuse detection below) in a
 * way a bare JWT never is.
 */

function signAccessToken(userId) {
  return jwt.sign({ id: userId, type: 'access' }, config.jwtSecret, { expiresIn: config.jwtAccessExpiresIn });
}

function generateRefreshToken() {
  return crypto.randomBytes(40).toString('hex');
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/** Issues a fresh access+refresh pair and persists the refresh token
 * (hashed). Shared by register/login/refresh/mfa-login so all of them
 * behave identically. */
async function issueTokenPair(userId, req) {
  const accessToken = signAccessToken(userId);
  const refreshToken = generateRefreshToken();
  const expiresAt = new Date(Date.now() + config.refreshTokenExpiresDays * 24 * 60 * 60 * 1000).toISOString();

  await refreshTokenRepository.create({
    userId,
    tokenHash: hashToken(refreshToken),
    expiresAt,
    ipAddress: req.ip,
  });

  return { accessToken, refreshToken };
}

// --- MFA challenge tokens (feature: TOTP 2FA) ---
// A distinct JWT `type` from the access token, signed with the same
// secret — middleware/auth.js's authMiddleware explicitly rejects any
// token whose type isn't 'access', so this can never be mistaken for
// (or misused as) a real session token even though it shares a signing
// key. Short-lived (config.mfaChallengeExpiresMinutes, default 5m):
// it exists only to carry "this password was already verified" across
// the two-request login flow below, not as a standing credential.
function signMfaChallengeToken(userId) {
  return jwt.sign({ id: userId, type: 'mfa_challenge' }, config.jwtSecret, { expiresIn: `${config.mfaChallengeExpiresMinutes}m` });
}

function verifyMfaChallengeToken(token) {
  let decoded;
  try {
    decoded = jwt.verify(token, config.jwtSecret);
  } catch (err) {
    return null;
  }
  return decoded.type === 'mfa_challenge' ? decoded.id : null;
}

/** Generates a random token, stores its hash (never the raw value) with
 * an expiry, and emails the raw value as a link — shared shape for both
 * email verification and password reset (feature: email verification,
 * forgot-password). Mirrors how refresh tokens are handled: the DB only
 * ever holds a SHA-256 hash, so a DB read alone can't produce a usable
 * link. */
async function issueEmailToken({ user, hoursValid, minutesValid, storeToken, sendEmail }) {
  const rawToken = crypto.randomBytes(32).toString('hex');
  const ms = hoursValid ? hoursValid * 60 * 60 * 1000 : minutesValid * 60 * 1000;
  const expiresAt = new Date(Date.now() + ms).toISOString();
  await storeToken(user.id, hashToken(rawToken), expiresAt);
  await sendEmail(user, rawToken); // best-effort — see services/emailService.js
  return rawToken;
}

// POST /api/auth/register
router.post('/register', authLimiter, validate({ body: authSchemas.register }), asyncHandler(async (req, res) => {
  const { username, email, password } = req.body;

  const existing = await userRepository.findByUsernameOrEmail(username, email);
  if (existing) throw AppError.conflict('Username or email already taken');

  const hash = bcrypt.hashSync(password, 10);
  const user = await userRepository.create({ username, email, passwordHash: hash, role: 'user' });

  // Email verification (feature: email verification on register) — the
  // account is usable immediately (see the module comment on why login
  // isn't gated on this), but a verification link goes out right away.
  await issueEmailToken({
    user,
    hoursValid: config.emailVerificationExpiresHours,
    storeToken: userRepository.setEmailVerificationToken,
    sendEmail: emailService.sendVerificationEmail,
  });

  const tokens = await issueTokenPair(user.id, req);
  audit({ req, userId: user.id, username: user.username, action: 'auth.register', outcome: 'success' });

  res.status(201).json({ ...tokens, user: { ...user, email_verified: 0 } });
}));

// POST /api/auth/login
router.post('/login', authLimiter, validate({ body: authSchemas.login }), asyncHandler(async (req, res) => {
  const { username, password } = req.body;

  const user = await userRepository.findByUsername(username);

  if (!user) {
    // Same generic error either way (below) so the response never
    // reveals whether the username exists — but the audit trail (an
    // operator-only view) still distinguishes the reasons.
    audit({ req, username, action: 'auth.login', outcome: 'failure', details: { reason: 'user_not_found' } });
    throw AppError.unauthorized('Invalid credentials');
  }

  // Account lockout (feature: lockout after failed login attempts).
  if (user.locked_until && new Date(user.locked_until).getTime() > Date.now()) {
    audit({ req, userId: user.id, username: user.username, action: 'auth.login', outcome: 'denied', details: { reason: 'locked' } });
    throw AppError.locked(`Account is temporarily locked due to too many failed login attempts. Try again in a few minutes.`);
  }

  if (!bcrypt.compareSync(password, user.password)) {
    const attempts = await userRepository.incrementFailedAttempts(user.id);
    const { maxAttempts, lockoutMinutes } = config.loginLockout;

    if (attempts >= maxAttempts) {
      const until = new Date(Date.now() + lockoutMinutes * 60 * 1000).toISOString();
      await userRepository.lockAccount(user.id, until);
      audit({ req, userId: user.id, username: user.username, action: 'auth.login', outcome: 'denied', details: { reason: 'locked_now', attempts } });
      throw AppError.locked(`Too many failed login attempts. Account locked for ${lockoutMinutes} minutes.`);
    }

    audit({ req, userId: user.id, username: user.username, action: 'auth.login', outcome: 'failure', details: { reason: 'bad_password', attempts, remaining: maxAttempts - attempts } });
    throw AppError.unauthorized('Invalid credentials');
  }

  // MFA (feature: TOTP 2FA) — password verified, but that's only half
  // of login for an account with 2FA enabled. Don't issue a session yet:
  // hand back a short-lived challenge token and require POST
  // /login/mfa to complete the flow. resetLoginAttempts happens on
  // *this* success (the password was correct), independent of whether
  // the MFA step that follows succeeds — a wrong TOTP code shouldn't
  // count as another wrong-password attempt toward the lockout.
  await userRepository.resetLoginAttempts(user.id);

  if (user.totp_enabled) {
    const mfaToken = signMfaChallengeToken(user.id);
    audit({ req, userId: user.id, username: user.username, action: 'auth.login_password_verified', outcome: 'success', details: { mfaPending: true } });
    return res.json({ mfaRequired: true, mfaToken });
  }

  const tokens = await issueTokenPair(user.id, req);
  audit({ req, userId: user.id, username: user.username, action: 'auth.login', outcome: 'success' });

  res.json({
    ...tokens,
    user: { id: user.id, username: user.username, email: user.email, role: user.role, email_verified: user.email_verified, totp_enabled: user.totp_enabled },
  });
}));

// POST /api/auth/login/mfa — completes login for an account with TOTP
// enabled, using the challenge token from POST /login above plus a
// 6-digit authenticator code (or a single-use backup code).
router.post('/login/mfa', authLimiter, validate({ body: authSchemas.mfaLogin }), asyncHandler(async (req, res) => {
  const { mfaToken, code } = req.body;

  const userId = verifyMfaChallengeToken(mfaToken);
  if (!userId) {
    audit({ req, action: 'auth.login', outcome: 'failure', details: { reason: 'mfa_token_invalid' } });
    throw AppError.unauthorized('Invalid or expired MFA challenge — please log in again');
  }

  const user = await userRepository.findByIdFull(userId);
  if (!user || !user.totp_enabled) {
    audit({ req, userId, action: 'auth.login', outcome: 'failure', details: { reason: 'mfa_not_enabled' } });
    throw AppError.unauthorized('Invalid or expired MFA challenge — please log in again');
  }

  const validTotp = await totpService.verifyTotpToken(user.totp_secret, code);
  let usedBackupCode = false;

  if (!validTotp) {
    // Not a valid TOTP code — try it as a single-use backup code before
    // failing outright.
    const backupCodes = JSON.parse(user.totp_backup_codes || '[]');
    const remaining = totpService.consumeBackupCode(code, backupCodes);
    if (remaining === null) {
      audit({ req, userId: user.id, username: user.username, action: 'auth.login', outcome: 'failure', details: { reason: 'mfa_invalid_code' } });
      throw AppError.unauthorized('Invalid authentication code');
    }
    await userRepository.updateBackupCodes(user.id, remaining);
    usedBackupCode = true;
  }

  const tokens = await issueTokenPair(user.id, req);
  audit({ req, userId: user.id, username: user.username, action: 'auth.login', outcome: 'success', details: { usedBackupCode } });

  res.json({
    ...tokens,
    user: { id: user.id, username: user.username, email: user.email, role: user.role, email_verified: user.email_verified, totp_enabled: user.totp_enabled },
    ...(usedBackupCode ? { backupCodeWarning: 'You logged in with a backup code. Consider regenerating your backup codes from Account Settings.' } : {}),
  });
}));

// POST /api/auth/refresh — exchanges a refresh token for a new pair.
// Rotates on every use: the presented token is revoked and a new one
// issued, with a `replaced_by_id` link preserving the rotation chain.
router.post('/refresh', authLimiter, validate({ body: authSchemas.refresh }), asyncHandler(async (req, res) => {
  const { refreshToken } = req.body;
  const tokenHash = hashToken(refreshToken);
  const record = await refreshTokenRepository.findByHash(tokenHash);

  if (!record) {
    audit({ req, action: 'auth.refresh', outcome: 'failure', details: { reason: 'not_found' } });
    throw AppError.unauthorized('Invalid refresh token');
  }

  if (record.revoked_at) {
    // A revoked token being presented again means it was already
    // rotated once — a legitimate client would be using its
    // replacement, not this one. Treat as a possible theft/replay and
    // kill every active session for the account rather than just this
    // token, the same way rotation-reuse detection works in production
    // auth systems.
    await refreshTokenRepository.revokeAllForUser(record.user_id);
    audit({ req, userId: record.user_id, action: 'auth.refresh_reuse_detected', outcome: 'denied', details: { tokenId: record.id } });
    throw AppError.unauthorized('Invalid refresh token');
  }

  if (new Date(record.expires_at).getTime() < Date.now()) {
    audit({ req, userId: record.user_id, action: 'auth.refresh', outcome: 'failure', details: { reason: 'expired' } });
    throw AppError.unauthorized('Refresh token expired, please log in again');
  }

  const user = await userRepository.findById(record.user_id);
  if (!user) {
    audit({ req, userId: record.user_id, action: 'auth.refresh', outcome: 'failure', details: { reason: 'user_not_found' } });
    throw AppError.unauthorized('Invalid refresh token');
  }

  const tokens = await issueTokenPair(user.id, req);
  // Find the row we just inserted (issueTokenPair doesn't return its id)
  // to link it as this token's replacement — re-hash + look up rather
  // than threading the id through, keeps issueTokenPair's signature
  // simple for its other callers that don't need rotation lineage.
  const newRecord = await refreshTokenRepository.findByHash(hashToken(tokens.refreshToken));
  await refreshTokenRepository.revoke(record.id, newRecord?.id ?? null);

  audit({ req, userId: user.id, username: user.username, action: 'auth.refresh', outcome: 'success' });

  res.json({ ...tokens, user });
}));

// POST /api/auth/logout — revokes the refresh token server-side, so
// "logging out" actually ends the session instead of just clearing
// localStorage client-side. Idempotent/always-200: never reveals
// whether the token it was given was valid.
router.post('/logout', asyncHandler(async (req, res) => {
  const { refreshToken } = req.body || {};
  if (refreshToken) {
    const record = await refreshTokenRepository.findByHash(hashToken(refreshToken));
    if (record && !record.revoked_at) {
      await refreshTokenRepository.revoke(record.id);
      audit({ req, userId: record.user_id, action: 'auth.logout', outcome: 'success' });
    }
  }
  res.json({ message: 'Logged out' });
}));

// GET /api/auth/me
router.get('/me', authMiddleware, (req, res) => {
  res.json({ user: req.user });
});

// ============================================================
// Password reset (feature: forgot-password / reset-password flow)
// ============================================================

// POST /api/auth/forgot-password — always responds with the same
// generic message regardless of whether the email exists, so this
// can't be used to enumerate registered accounts. Rate-limited (same
// tier as login/register) since it's an unauthenticated endpoint that
// triggers an email send per request.
router.post('/forgot-password', authLimiter, validate({ body: authSchemas.forgotPassword }), asyncHandler(async (req, res) => {
  const { email } = req.body;
  const user = await userRepository.findByEmail(email);

  if (user) {
    await issueEmailToken({
      user,
      minutesValid: config.passwordResetExpiresMinutes,
      storeToken: userRepository.setPasswordResetToken,
      sendEmail: emailService.sendPasswordResetEmail,
    });
    audit({ req, userId: user.id, username: user.username, action: 'auth.password_reset_requested', outcome: 'success' });
  } else {
    audit({ req, action: 'auth.password_reset_requested', outcome: 'failure', details: { reason: 'no_account_for_email' } });
  }

  res.json({ message: 'If an account with that email exists, a password reset link has been sent.' });
}));

// POST /api/auth/reset-password — completes the flow above. Revokes
// every refresh token for the account once the password changes, the
// same reasoning as a self-service password change below: a password
// reset (by definition, someone regained control of the account) should
// force every other session — including a possible attacker's — to
// re-authenticate.
router.post('/reset-password', authLimiter, validate({ body: authSchemas.resetPassword }), asyncHandler(async (req, res) => {
  const { token, password } = req.body;
  const tokenHash = hashToken(token);
  const user = await userRepository.findByPasswordResetTokenHash(tokenHash);

  if (!user || !user.password_reset_expires_at || new Date(user.password_reset_expires_at).getTime() < Date.now()) {
    audit({ req, userId: user?.id, action: 'auth.password_reset', outcome: 'failure', details: { reason: 'invalid_or_expired_token' } });
    throw AppError.badRequest('This password reset link is invalid or has expired. Please request a new one.');
  }

  const hash = bcrypt.hashSync(password, 10);
  await userRepository.updatePassword(user.id, hash);
  await refreshTokenRepository.revokeAllForUser(user.id);

  audit({ req, userId: user.id, username: user.username, action: 'auth.password_reset', outcome: 'success' });

  res.json({ message: 'Password reset successfully. Please log in with your new password.' });
}));

// ============================================================
// Email verification (feature: email verification on register)
// ============================================================

// POST /api/auth/verify-email — public: the token itself is the
// credential (same shape as password reset above), so no auth header
// is required to complete this.
router.post('/verify-email', authLimiter, validate({ body: authSchemas.verifyEmail }), asyncHandler(async (req, res) => {
  const { token } = req.body;
  const tokenHash = hashToken(token);
  const user = await userRepository.findByEmailVerificationTokenHash(tokenHash);

  if (!user || !user.email_verification_expires_at || new Date(user.email_verification_expires_at).getTime() < Date.now()) {
    audit({ req, userId: user?.id, action: 'auth.email_verified', outcome: 'failure', details: { reason: 'invalid_or_expired_token' } });
    throw AppError.badRequest('This verification link is invalid or has expired. Please request a new one.');
  }

  await userRepository.markEmailVerified(user.id);
  audit({ req, userId: user.id, username: user.username, action: 'auth.email_verified', outcome: 'success' });

  res.json({ message: 'Email verified successfully.' });
}));

// POST /api/auth/resend-verification — self-service; requires being
// logged in (avoids the enumeration/spam surface of accepting an
// arbitrary email in the body).
router.post('/resend-verification', authMiddleware, authLimiter, asyncHandler(async (req, res) => {
  const user = await userRepository.findByIdFull(req.user.id);
  if (user.email_verified) {
    return res.json({ message: 'Your email is already verified.' });
  }

  await issueEmailToken({
    user,
    hoursValid: config.emailVerificationExpiresHours,
    storeToken: userRepository.setEmailVerificationToken,
    sendEmail: emailService.sendVerificationEmail,
  });
  audit({ req, userId: user.id, username: user.username, action: 'auth.email_verification_resent', outcome: 'success' });

  res.json({ message: 'Verification email sent.' });
}));

// ============================================================
// Self-service profile management (feature: change own password/email)
// ============================================================

// PATCH /api/auth/password — requires the current password, same as
// disabling MFA below; changing a credential should always re-prove
// you hold the old one, not just an active session (a stolen access
// token alone shouldn't be enough to lock the real owner out).
// Revokes every other refresh token — see the comment on
// POST /reset-password above for why.
router.patch('/password', authMiddleware, validate({ body: authSchemas.changePassword }), asyncHandler(async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  const user = await userRepository.findByIdFull(req.user.id);

  if (!bcrypt.compareSync(currentPassword, user.password)) {
    audit({ req, userId: user.id, username: user.username, action: 'auth.password_changed', outcome: 'failure', details: { reason: 'bad_current_password' } });
    throw AppError.unauthorized('Current password is incorrect');
  }

  const hash = bcrypt.hashSync(newPassword, 10);
  await userRepository.updatePassword(user.id, hash);
  await refreshTokenRepository.revokeAllForUser(user.id);

  const tokens = await issueTokenPair(user.id, req); // re-issue for *this* session so the caller isn't logged out by their own change
  audit({ req, userId: user.id, username: user.username, action: 'auth.password_changed', outcome: 'success' });

  res.json({ message: 'Password changed successfully.', ...tokens });
}));

// PATCH /api/auth/email — requires the current password, and re-resets
// email_verified so the new address has to be re-proven, same as at
// registration.
router.patch('/email', authMiddleware, validate({ body: authSchemas.changeEmail }), asyncHandler(async (req, res) => {
  const { newEmail, currentPassword } = req.body;
  const user = await userRepository.findByIdFull(req.user.id);

  if (!bcrypt.compareSync(currentPassword, user.password)) {
    audit({ req, userId: user.id, username: user.username, action: 'auth.email_changed', outcome: 'failure', details: { reason: 'bad_current_password' } });
    throw AppError.unauthorized('Current password is incorrect');
  }

  if (newEmail === user.email) {
    return res.json({ message: 'That is already your email address.', user: { ...req.user, email: newEmail } });
  }

  const existing = await userRepository.findByEmail(newEmail);
  if (existing) throw AppError.conflict('That email address is already in use');

  await userRepository.updateEmail(user.id, newEmail);
  const updatedUser = { ...user, email: newEmail };
  await issueEmailToken({
    user: updatedUser,
    hoursValid: config.emailVerificationExpiresHours,
    storeToken: userRepository.setEmailVerificationToken,
    sendEmail: emailService.sendVerificationEmail,
  });

  audit({ req, userId: user.id, username: user.username, action: 'auth.email_changed', outcome: 'success' });

  res.json({
    message: 'Email updated. Please check your inbox to verify the new address.',
    user: { id: user.id, username: user.username, email: newEmail, role: user.role, email_verified: 0, totp_enabled: user.totp_enabled },
  });
}));

// ============================================================
// MFA / TOTP 2FA (feature: 2FA)
// ============================================================

// POST /api/auth/mfa/setup — generates a new secret and stores it as
// *pending* (not yet required at login — see setPendingTotpSecret's
// comment). Returns the secret (plaintext, once — for manual entry as
// a fallback) plus a QR code the frontend renders for scanning.
router.post('/mfa/setup', authMiddleware, asyncHandler(async (req, res) => {
  const user = await userRepository.findByIdFull(req.user.id);
  if (user.totp_enabled) throw AppError.badRequest('Two-factor authentication is already enabled. Disable it first to set up a new device.');

  const secret = totpService.generateTotpSecret();
  await userRepository.setPendingTotpSecret(user.id, secret);
  const otpauthUrl = totpService.buildOtpauthUrl(secret, user.username);
  const qrCodeDataUrl = await totpService.generateQrCodeDataUrl(otpauthUrl);

  audit({ req, userId: user.id, username: user.username, action: 'auth.mfa_setup_started', outcome: 'success' });

  res.json({ secret, otpauthUrl, qrCodeDataUrl });
}));

// POST /api/auth/mfa/enable — confirms setup by requiring one valid
// code from the authenticator app (proves the secret was actually
// scanned/entered correctly before 2FA becomes mandatory at login).
// Returns backup codes in plaintext exactly once.
router.post('/mfa/enable', authMiddleware, validate({ body: authSchemas.mfaEnable }), asyncHandler(async (req, res) => {
  const user = await userRepository.findByIdFull(req.user.id);
  if (user.totp_enabled) throw AppError.badRequest('Two-factor authentication is already enabled.');
  if (!user.totp_secret) throw AppError.badRequest('Call POST /auth/mfa/setup first.');

  const valid = await totpService.verifyTotpToken(user.totp_secret, req.body.code);
  if (!valid) {
    audit({ req, userId: user.id, username: user.username, action: 'auth.mfa_enabled', outcome: 'failure', details: { reason: 'bad_code' } });
    throw AppError.badRequest('Invalid code. Check your authenticator app and try again.');
  }

  const backupCodes = totpService.generateBackupCodes();
  await userRepository.enableTotp(user.id, totpService.hashBackupCodes(backupCodes));
  // Revokes every refresh token for the account, including this
  // session's — then immediately reissues a fresh pair for *this*
  // session (same reasoning as PATCH /password above), so enabling MFA
  // doesn't force the person who just enabled it to log back in, while
  // still requiring the MFA challenge on every other device/session.
  await refreshTokenRepository.revokeAllForUser(user.id);
  const tokens = await issueTokenPair(user.id, req);

  audit({ req, userId: user.id, username: user.username, action: 'auth.mfa_enabled', outcome: 'success' });

  res.json({
    message: 'Two-factor authentication enabled.',
    backupCodes,
    warning: 'Save these backup codes somewhere safe — they will not be shown again, and each can only be used once if you lose access to your authenticator app.',
    ...tokens,
  });
}));

// POST /api/auth/mfa/disable — requires the current password, same
// reasoning as changing it (see PATCH /password above).
router.post('/mfa/disable', authMiddleware, validate({ body: authSchemas.mfaDisable }), asyncHandler(async (req, res) => {
  const user = await userRepository.findByIdFull(req.user.id);
  if (!user.totp_enabled) throw AppError.badRequest('Two-factor authentication is not enabled.');

  if (!bcrypt.compareSync(req.body.password, user.password)) {
    audit({ req, userId: user.id, username: user.username, action: 'auth.mfa_disabled', outcome: 'failure', details: { reason: 'bad_password' } });
    throw AppError.unauthorized('Password is incorrect');
  }

  await userRepository.disableTotp(user.id);
  audit({ req, userId: user.id, username: user.username, action: 'auth.mfa_disabled', outcome: 'success' });

  res.json({ message: 'Two-factor authentication disabled.' });
}));

// ============================================================
// Self-service data export & account deletion
// (feature: self-service data export + account deletion)
// ============================================================

// GET /api/auth/me/export — a JSON bundle of everything this app holds
// about the caller's own account: profile, transactions, alerts, the
// audit trail entries where they were the actor, and metadata (never
// secrets/hashes) for their API keys and webhooks. Capped at
// EXPORT_ROW_CAP per section so this can't be used to pull an
// unbounded amount of data in one request even for a very active
// account — a second export after that point is a legitimate use case
// this doesn't try to prevent, just bound per-request.
const EXPORT_ROW_CAP = 10000;
router.get('/me/export', authMiddleware, asyncHandler(async (req, res) => {
  const userId = req.user.id;

  const [transactions, alerts, auditLogs, apiKeys, webhooks] = await Promise.all([
    transactionRepository.forUser(userId, { page: 1, limit: EXPORT_ROW_CAP }),
    alertRepository.forUser(userId, { page: 1, limit: EXPORT_ROW_CAP }),
    auditLogRepository.list({ userId, page: 1, limit: EXPORT_ROW_CAP }),
    apiKeyRepository.forUser(userId),
    webhookRepository.forUser(userId),
  ]);

  audit({ req, userId, username: req.user.username, action: 'auth.data_exported', outcome: 'success' });

  res.json({
    exported_at: new Date().toISOString(),
    profile: req.user,
    transactions: transactions.rows,
    alerts: alerts.rows,
    audit_log_entries: auditLogs.rows,
    api_keys: apiKeys.map(({ key_hash: _hash, ...rest }) => rest),
    webhooks: webhooks.map(({ secret: _secret, ...rest }) => rest),
  });
}));

// DELETE /api/auth/me — anonymizes the account (see
// userRepository.anonymize's comment for why this isn't a hard delete)
// and revokes every credential tied to it: refresh tokens, API keys,
// and webhooks (deactivated, not removed, so their delivery history
// stays intact). Requires the current password, same reasoning as
// every other irreversible-ish account action above.
router.delete('/me', authMiddleware, validate({ body: authSchemas.deleteAccount }), asyncHandler(async (req, res) => {
  const user = await userRepository.findByIdFull(req.user.id);

  if (!bcrypt.compareSync(req.body.password, user.password)) {
    audit({ req, userId: user.id, username: user.username, action: 'auth.account_deleted', outcome: 'failure', details: { reason: 'bad_password' } });
    throw AppError.unauthorized('Password is incorrect');
  }

  await userRepository.anonymize(user.id);
  await refreshTokenRepository.revokeAllForUser(user.id);
  await apiKeyRepository.revokeAllForUser(user.id);
  await webhookRepository.deactivateAllForUser(user.id);

  // Logged against the pre-anonymization username/id — this is the
  // last audit entry that will ever show the real username, since
  // findById (and therefore every future lookup) stops resolving this
  // account the moment deleted_at is set.
  audit({ req, userId: user.id, username: user.username, action: 'auth.account_deleted', outcome: 'success' });

  res.json({ message: 'Your account has been deleted. Your transaction and alert history is retained for fraud-prevention purposes, with no link back to your original username or email — see the API documentation for details.' });
}));

module.exports = router;
