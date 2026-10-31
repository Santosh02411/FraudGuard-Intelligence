const request = require('supertest');

jest.mock('../../services/emailService', () => ({
  sendMail: jest.fn().mockResolvedValue(true),
  sendVerificationEmail: jest.fn().mockResolvedValue(true),
  sendPasswordResetEmail: jest.fn().mockResolvedValue(true),
}));

const emailService = require('../../services/emailService');
const app = require('../../app');
const { initSchema } = require('../../config/schema');
const { authenticator } = require('otplib');

beforeAll(async () => {
  await initSchema();
});

beforeEach(() => {
  emailService.sendVerificationEmail.mockClear();
  emailService.sendPasswordResetEmail.mockClear();
});

const API = '/api/v1';
const STRONG_PASSWORD = 'Str0ng!Passw0rd1';

async function registerAndLogin(username, password = STRONG_PASSWORD) {
  await request(app).post(`${API}/auth/register`).send({ username, email: `${username}@example.com`, password });
  const res = await request(app).post(`${API}/auth/login`).send({ username, password });
  return res.body;
}

async function loginAdmin() {
  const res = await request(app).post(`${API}/auth/login`).send({ username: 'admin', password: 'admin123' });
  return res.body.accessToken;
}

/** Pulls the raw (unhashed) token out of the mocked email call — this
 * is the token a real user would get from clicking the link in their
 * inbox; the API response itself never contains it. */
function lastTokenSentTo(mockFn, email) {
  const call = mockFn.mock.calls.reverse().find(([user]) => user.email === email);
  return call ? call[1] : undefined;
}

describe('Email verification', () => {
  test('registering sends a verification email and starts unverified', async () => {
    const email = 'verify_user1@example.com';
    const res = await request(app).post(`${API}/auth/register`).send({ username: 'verify_user1', email, password: STRONG_PASSWORD });

    expect(res.status).toBe(201);
    expect(res.body.user.email_verified).toBe(0);
    expect(emailService.sendVerificationEmail).toHaveBeenCalledTimes(1);
    expect(emailService.sendVerificationEmail.mock.calls[0][0].email).toBe(email);
  });

  test('an unverified account can still log in (verification is not required to use the app)', async () => {
    const { accessToken } = await registerAndLogin('verify_user2');
    expect(typeof accessToken).toBe('string');
  });

  test('verifying with a bogus token is rejected', async () => {
    const res = await request(app).post(`${API}/auth/verify-email`).send({ token: 'not-a-real-token' });
    expect(res.status).toBe(400);
  });

  test('verifying with the real token marks the account verified', async () => {
    const email = 'verify_user3@example.com';
    await request(app).post(`${API}/auth/register`).send({ username: 'verify_user3', email, password: STRONG_PASSWORD });
    const token = lastTokenSentTo(emailService.sendVerificationEmail, email);
    expect(token).toBeDefined();

    const verifyRes = await request(app).post(`${API}/auth/verify-email`).send({ token });
    expect(verifyRes.status).toBe(200);

    const login = await request(app).post(`${API}/auth/login`).send({ username: 'verify_user3', password: STRONG_PASSWORD });
    expect(login.body.user.email_verified).toBe(1);
  });

  test('resend-verification requires auth, and no-ops once already verified', async () => {
    const unauth = await request(app).post(`${API}/auth/resend-verification`);
    expect(unauth.status).toBe(401);

    const email = 'verify_user4@example.com';
    const { accessToken } = await registerAndLogin('verify_user4');
    const token = lastTokenSentTo(emailService.sendVerificationEmail, email);
    await request(app).post(`${API}/auth/verify-email`).send({ token });

    emailService.sendVerificationEmail.mockClear();
    const resendRes = await request(app).post(`${API}/auth/resend-verification`).set('Authorization', `Bearer ${accessToken}`);
    expect(resendRes.status).toBe(200);
    expect(resendRes.body.message).toMatch(/already verified/i);
    expect(emailService.sendVerificationEmail).not.toHaveBeenCalled();
  });

  test('resend-verification sends a fresh token for a still-unverified account', async () => {
    const { accessToken } = await registerAndLogin('verify_user5');
    emailService.sendVerificationEmail.mockClear();

    const res = await request(app).post(`${API}/auth/resend-verification`).set('Authorization', `Bearer ${accessToken}`);
    expect(res.status).toBe(200);
    expect(emailService.sendVerificationEmail).toHaveBeenCalledTimes(1);
  });
});

describe('Forgot / reset password', () => {
  test('forgot-password for an unknown email returns the same generic message (no enumeration)', async () => {
    const res = await request(app).post(`${API}/auth/forgot-password`).send({ email: 'nobody-here@example.com' });
    expect(res.status).toBe(200);
    expect(res.body.message).toMatch(/if an account with that email exists/i);
    expect(emailService.sendPasswordResetEmail).not.toHaveBeenCalled();
  });

  test('forgot-password for a known email sends a reset email with the same generic message', async () => {
    const email = 'reset_user1@example.com';
    await request(app).post(`${API}/auth/register`).send({ username: 'reset_user1', email, password: STRONG_PASSWORD });

    const res = await request(app).post(`${API}/auth/forgot-password`).send({ email });
    expect(res.status).toBe(200);
    expect(res.body.message).toMatch(/if an account with that email exists/i);
    expect(emailService.sendPasswordResetEmail).toHaveBeenCalledTimes(1);
  });

  test('reset-password rejects a bogus token', async () => {
    const res = await request(app).post(`${API}/auth/reset-password`).send({ token: 'not-real', password: STRONG_PASSWORD });
    expect(res.status).toBe(400);
  });

  test('reset-password rejects a weak new password', async () => {
    const email = 'reset_user2@example.com';
    await request(app).post(`${API}/auth/register`).send({ username: 'reset_user2', email, password: STRONG_PASSWORD });
    await request(app).post(`${API}/auth/forgot-password`).send({ email });
    const token = lastTokenSentTo(emailService.sendPasswordResetEmail, email);

    const res = await request(app).post(`${API}/auth/reset-password`).send({ token, password: 'weak' });
    expect(res.status).toBe(400);
  });

  test('reset-password with a valid token changes the password, revokes existing sessions, and the old password stops working', async () => {
    const email = 'reset_user3@example.com';
    const { refreshToken: oldRefreshToken } = await registerAndLogin('reset_user3');

    await request(app).post(`${API}/auth/forgot-password`).send({ email });
    const token = lastTokenSentTo(emailService.sendPasswordResetEmail, email);

    const newPassword = 'N3wStr0ng!Passw0rd';
    const resetRes = await request(app).post(`${API}/auth/reset-password`).send({ token, password: newPassword });
    expect(resetRes.status).toBe(200);

    const oldLogin = await request(app).post(`${API}/auth/login`).send({ username: 'reset_user3', password: STRONG_PASSWORD });
    expect(oldLogin.status).toBe(401);

    const newLogin = await request(app).post(`${API}/auth/login`).send({ username: 'reset_user3', password: newPassword });
    expect(newLogin.status).toBe(200);

    // The refresh token issued before the reset should no longer work —
    // resetting a password revokes every existing session.
    const refreshRes = await request(app).post(`${API}/auth/refresh`).send({ refreshToken: oldRefreshToken });
    expect(refreshRes.status).toBe(401);
  });

  test('the same reset token cannot be used twice', async () => {
    const email = 'reset_user4@example.com';
    await request(app).post(`${API}/auth/register`).send({ username: 'reset_user4', email, password: STRONG_PASSWORD });
    await request(app).post(`${API}/auth/forgot-password`).send({ email });
    const token = lastTokenSentTo(emailService.sendPasswordResetEmail, email);

    const first = await request(app).post(`${API}/auth/reset-password`).send({ token, password: 'N3wStr0ng!Passw0rd' });
    expect(first.status).toBe(200);

    const second = await request(app).post(`${API}/auth/reset-password`).send({ token, password: 'AnotherStr0ng!Pass' });
    expect(second.status).toBe(400);
  });
});

describe('Self-service: change password', () => {
  test('requires authentication', async () => {
    const res = await request(app).patch(`${API}/auth/password`).send({ currentPassword: STRONG_PASSWORD, newPassword: 'N3wStr0ng!Passw0rd' });
    expect(res.status).toBe(401);
  });

  test('rejects the wrong current password', async () => {
    const { accessToken } = await registerAndLogin('changepw_user1');
    const res = await request(app).patch(`${API}/auth/password`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ currentPassword: 'WrongPassword1!', newPassword: 'N3wStr0ng!Passw0rd' });
    expect(res.status).toBe(401);
  });

  test('rejects a weak new password', async () => {
    const { accessToken } = await registerAndLogin('changepw_user2');
    const res = await request(app).patch(`${API}/auth/password`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ currentPassword: STRONG_PASSWORD, newPassword: 'weak' });
    expect(res.status).toBe(400);
  });

  test('changes the password, revokes other sessions, and issues a fresh pair for this one', async () => {
    const { accessToken, refreshToken: oldRefreshToken } = await registerAndLogin('changepw_user3');
    const newPassword = 'N3wStr0ng!Passw0rd';

    const res = await request(app).patch(`${API}/auth/password`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ currentPassword: STRONG_PASSWORD, newPassword });
    expect(res.status).toBe(200);
    expect(typeof res.body.accessToken).toBe('string');
    expect(typeof res.body.refreshToken).toBe('string');

    // Check the newly-issued refresh token BEFORE touching the old one:
    // presenting an already-revoked token to /refresh is (correctly)
    // treated as a possible-theft signal and revokes every active
    // session for the account (see /refresh's reuse-detection branch) —
    // checking the old token first would revoke this brand-new one too
    // and produce a false failure here, not a real bug in the app.
    const newRefreshRes = await request(app).post(`${API}/auth/refresh`).send({ refreshToken: res.body.refreshToken });
    expect(newRefreshRes.status).toBe(200);

    const login = await request(app).post(`${API}/auth/login`).send({ username: 'changepw_user3', password: newPassword });
    expect(login.status).toBe(200);

    // Now confirm the pre-change refresh token is rejected too.
    const oldRefreshRes = await request(app).post(`${API}/auth/refresh`).send({ refreshToken: oldRefreshToken });
    expect(oldRefreshRes.status).toBe(401);
  });
});

describe('Self-service: change email', () => {
  test('requires authentication', async () => {
    const res = await request(app).patch(`${API}/auth/email`).send({ newEmail: 'x@example.com', currentPassword: STRONG_PASSWORD });
    expect(res.status).toBe(401);
  });

  test('rejects the wrong current password', async () => {
    const { accessToken } = await registerAndLogin('changeemail_user1');
    const res = await request(app).patch(`${API}/auth/email`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ newEmail: 'changeemail_new1@example.com', currentPassword: 'WrongPassword1!' });
    expect(res.status).toBe(401);
  });

  test('rejects an email already in use by another account', async () => {
    await request(app).post(`${API}/auth/register`).send({ username: 'changeemail_taken', email: 'changeemail_taken_addr@example.com', password: STRONG_PASSWORD });
    const { accessToken } = await registerAndLogin('changeemail_user2');

    const res = await request(app).patch(`${API}/auth/email`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ newEmail: 'changeemail_taken_addr@example.com', currentPassword: STRONG_PASSWORD });
    expect(res.status).toBe(409);
  });

  test('changes the email, resets verification, and sends a new verification email', async () => {
    const { accessToken } = await registerAndLogin('changeemail_user3');
    emailService.sendVerificationEmail.mockClear();
    const newEmail = 'changeemail_user3_new@example.com';

    const res = await request(app).patch(`${API}/auth/email`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ newEmail, currentPassword: STRONG_PASSWORD });

    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe(newEmail);
    expect(res.body.user.email_verified).toBe(0);
    expect(emailService.sendVerificationEmail).toHaveBeenCalledTimes(1);
    expect(emailService.sendVerificationEmail.mock.calls[0][0].email).toBe(newEmail);
  });
});

describe('MFA (TOTP 2FA)', () => {
  async function enableMfaFor(username) {
    const { accessToken } = await registerAndLogin(username);
    const setupRes = await request(app).post(`${API}/auth/mfa/setup`).set('Authorization', `Bearer ${accessToken}`);
    const { secret } = setupRes.body;
    const code = authenticator.generate(secret);
    const enableRes = await request(app).post(`${API}/auth/mfa/enable`).set('Authorization', `Bearer ${accessToken}`).send({ code });
    return { accessToken, secret, backupCodes: enableRes.body.backupCodes };
  }

  test('setup requires auth and returns a secret, otpauth URL, and QR code', async () => {
    const unauth = await request(app).post(`${API}/auth/mfa/setup`);
    expect(unauth.status).toBe(401);

    const { accessToken } = await registerAndLogin('mfa_setup_user');
    const res = await request(app).post(`${API}/auth/mfa/setup`).set('Authorization', `Bearer ${accessToken}`);
    expect(res.status).toBe(200);
    expect(typeof res.body.secret).toBe('string');
    expect(res.body.otpauthUrl).toContain('otpauth://totp/');
    expect(res.body.qrCodeDataUrl).toMatch(/^data:image\/png;base64,/);
  });

  test('enable rejects a wrong code', async () => {
    const { accessToken } = await registerAndLogin('mfa_enable_wrong_user');
    await request(app).post(`${API}/auth/mfa/setup`).set('Authorization', `Bearer ${accessToken}`);
    const res = await request(app).post(`${API}/auth/mfa/enable`).set('Authorization', `Bearer ${accessToken}`).send({ code: '000000' });
    expect(res.status).toBe(400);
  });

  test('enable with the correct code turns on 2FA and returns 8 one-time backup codes', async () => {
    const { backupCodes } = await enableMfaFor('mfa_enable_user');
    expect(backupCodes).toHaveLength(8);
  });

  test('enable reissues a fresh token pair for the current session, since it revokes every existing refresh token (including this one)', async () => {
    const { accessToken } = await registerAndLogin('mfa_enable_reissue_user');
    const setupRes = await request(app).post(`${API}/auth/mfa/setup`).set('Authorization', `Bearer ${accessToken}`);
    const code = authenticator.generate(setupRes.body.secret);

    const enableRes = await request(app).post(`${API}/auth/mfa/enable`).set('Authorization', `Bearer ${accessToken}`).send({ code });
    expect(enableRes.status).toBe(200);
    expect(typeof enableRes.body.accessToken).toBe('string');
    expect(typeof enableRes.body.refreshToken).toBe('string');

    // The freshly-issued refresh token should actually work.
    const refreshRes = await request(app).post(`${API}/auth/refresh`).send({ refreshToken: enableRes.body.refreshToken });
    expect(refreshRes.status).toBe(200);
  });

  test('cannot set up MFA again once already enabled', async () => {
    const { accessToken } = await enableMfaFor('mfa_double_setup_user');
    const res = await request(app).post(`${API}/auth/mfa/setup`).set('Authorization', `Bearer ${accessToken}`);
    expect(res.status).toBe(400);
  });

  test('logging in on an MFA-enabled account returns a challenge instead of tokens', async () => {
    await enableMfaFor('mfa_login_challenge_user');
    const res = await request(app).post(`${API}/auth/login`).send({ username: 'mfa_login_challenge_user', password: STRONG_PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body.mfaRequired).toBe(true);
    expect(typeof res.body.mfaToken).toBe('string');
    expect(res.body.accessToken).toBeUndefined();
  });

  test('login/mfa rejects a wrong code', async () => {
    await enableMfaFor('mfa_login_wrongcode_user');
    const loginRes = await request(app).post(`${API}/auth/login`).send({ username: 'mfa_login_wrongcode_user', password: STRONG_PASSWORD });
    const res = await request(app).post(`${API}/auth/login/mfa`).send({ mfaToken: loginRes.body.mfaToken, code: '000000' });
    expect(res.status).toBe(401);
  });

  test('login/mfa rejects an invalid/expired challenge token', async () => {
    const res = await request(app).post(`${API}/auth/login/mfa`).send({ mfaToken: 'not-a-real-jwt', code: '123456' });
    expect(res.status).toBe(401);
  });

  test('login/mfa with the correct TOTP code completes login', async () => {
    const { secret } = await enableMfaFor('mfa_login_success_user');
    const loginRes = await request(app).post(`${API}/auth/login`).send({ username: 'mfa_login_success_user', password: STRONG_PASSWORD });
    const code = authenticator.generate(secret);

    const res = await request(app).post(`${API}/auth/login/mfa`).send({ mfaToken: loginRes.body.mfaToken, code });
    expect(res.status).toBe(200);
    expect(typeof res.body.accessToken).toBe('string');
    expect(res.body.user.username).toBe('mfa_login_success_user');
  });

  test('a backup code can complete login exactly once', async () => {
    const { backupCodes } = await enableMfaFor('mfa_backup_code_user');
    const usedCode = backupCodes[0];

    const loginRes1 = await request(app).post(`${API}/auth/login`).send({ username: 'mfa_backup_code_user', password: STRONG_PASSWORD });
    const firstUse = await request(app).post(`${API}/auth/login/mfa`).send({ mfaToken: loginRes1.body.mfaToken, code: usedCode });
    expect(firstUse.status).toBe(200);
    expect(firstUse.body.backupCodeWarning).toBeDefined();

    const loginRes2 = await request(app).post(`${API}/auth/login`).send({ username: 'mfa_backup_code_user', password: STRONG_PASSWORD });
    const secondUse = await request(app).post(`${API}/auth/login/mfa`).send({ mfaToken: loginRes2.body.mfaToken, code: usedCode });
    expect(secondUse.status).toBe(401);
  });

  test('disable requires the correct password', async () => {
    const { accessToken } = await enableMfaFor('mfa_disable_wrongpw_user');
    const res = await request(app).post(`${API}/auth/mfa/disable`).set('Authorization', `Bearer ${accessToken}`).send({ password: 'WrongPassword1!' });
    expect(res.status).toBe(401);
  });

  test('disable turns off 2FA, and login goes back to issuing tokens directly', async () => {
    const { accessToken } = await enableMfaFor('mfa_disable_user');
    const disableRes = await request(app).post(`${API}/auth/mfa/disable`).set('Authorization', `Bearer ${accessToken}`).send({ password: STRONG_PASSWORD });
    expect(disableRes.status).toBe(200);

    const loginRes = await request(app).post(`${API}/auth/login`).send({ username: 'mfa_disable_user', password: STRONG_PASSWORD });
    expect(loginRes.status).toBe(200);
    expect(loginRes.body.mfaRequired).toBeUndefined();
    expect(typeof loginRes.body.accessToken).toBe('string');
  });
});

describe('GET /auth/me/export — self-service data export', () => {
  test('requires auth', async () => {
    const res = await request(app).get(`${API}/auth/me/export`);
    expect(res.status).toBe(401);
  });

  test('returns a bundle of the caller\'s own profile, transactions, alerts, audit log, api keys, and webhooks', async () => {
    const { accessToken } = await registerAndLogin('export_data_user');
    await request(app).post(`${API}/transactions`).set('Authorization', `Bearer ${accessToken}`)
      .send({ amount: 25, merchant: 'Export Test Shop', category: 'grocery', location: 'New York, US', card_type: 'credit' });
    await request(app).post(`${API}/api-keys`).set('Authorization', `Bearer ${accessToken}`).send({ name: 'Export Test Key' });
    await request(app).post(`${API}/webhooks`).set('Authorization', `Bearer ${accessToken}`).send({ url: 'https://example.com/export-test-hook' });

    const res = await request(app).get(`${API}/auth/me/export`).set('Authorization', `Bearer ${accessToken}`);
    expect(res.status).toBe(200);
    expect(res.body.profile.username).toBe('export_data_user');
    expect(res.body.transactions.some((t) => t.merchant === 'Export Test Shop')).toBe(true);
    expect(res.body.api_keys).toHaveLength(1);
    expect(res.body.api_keys[0].key_hash).toBeUndefined();
    expect(res.body.api_keys[0].key).toBeUndefined();
    expect(res.body.webhooks).toHaveLength(1);
    expect(res.body.webhooks[0].secret).toBeUndefined();
    expect(Array.isArray(res.body.audit_log_entries)).toBe(true);
  });

  test('does not include another user\'s data', async () => {
    const { accessToken: tokenA } = await registerAndLogin('export_data_user_a');
    const { accessToken: tokenB } = await registerAndLogin('export_data_user_b');
    await request(app).post(`${API}/transactions`).set('Authorization', `Bearer ${tokenA}`)
      .send({ amount: 25, merchant: 'User A Private Shop', category: 'grocery', location: 'New York, US', card_type: 'credit' });

    const res = await request(app).get(`${API}/auth/me/export`).set('Authorization', `Bearer ${tokenB}`);
    expect(res.body.transactions.some((t) => t.merchant === 'User A Private Shop')).toBe(false);
  });
});

describe('DELETE /auth/me — self-service account deletion', () => {
  test('requires auth', async () => {
    const res = await request(app).delete(`${API}/auth/me`).send({ password: STRONG_PASSWORD });
    expect(res.status).toBe(401);
  });

  test('rejects the wrong password without deleting anything', async () => {
    const { accessToken } = await registerAndLogin('delete_wrongpw_user');
    const res = await request(app).delete(`${API}/auth/me`).set('Authorization', `Bearer ${accessToken}`).send({ password: 'WrongPassword1!' });
    expect(res.status).toBe(401);

    const stillWorks = await request(app).get(`${API}/auth/me`).set('Authorization', `Bearer ${accessToken}`);
    expect(stillWorks.status).toBe(200);
  });

  test('deletes the account: old credentials stop working, the access token is immediately invalidated, and refresh fails', async () => {
    const { accessToken, refreshToken } = await registerAndLogin('delete_success_user');

    const res = await request(app).delete(`${API}/auth/me`).set('Authorization', `Bearer ${accessToken}`).send({ password: STRONG_PASSWORD });
    expect(res.status).toBe(200);

    // The access token was valid seconds ago but is rejected immediately —
    // findById excludes anonymized accounts, so authMiddleware's normal
    // "does this user still exist" check now fails for it.
    const usingOldAccessToken = await request(app).get(`${API}/auth/me`).set('Authorization', `Bearer ${accessToken}`);
    expect(usingOldAccessToken.status).toBe(401);

    const loginAttempt = await request(app).post(`${API}/auth/login`).send({ username: 'delete_success_user', password: STRONG_PASSWORD });
    expect(loginAttempt.status).toBe(401);

    const refreshAttempt = await request(app).post(`${API}/auth/refresh`).send({ refreshToken });
    expect(refreshAttempt.status).toBe(401);
  });

  test('revokes every API key and deactivates every webhook belonging to the account', async () => {
    const { accessToken } = await registerAndLogin('delete_cleanup_user');
    const keyRes = await request(app).post(`${API}/api-keys`).set('Authorization', `Bearer ${accessToken}`).send({ name: 'Doomed key' });
    const rawKey = keyRes.body.key;
    const webhookRes = await request(app).post(`${API}/webhooks`).set('Authorization', `Bearer ${accessToken}`).send({ url: 'https://example.com/doomed-hook' });

    await request(app).delete(`${API}/auth/me`).set('Authorization', `Bearer ${accessToken}`).send({ password: STRONG_PASSWORD });

    const usingKey = await request(app).get(`${API}/transactions`).set('X-API-Key', rawKey);
    expect(usingKey.status).toBe(401);

    const db = require('../../config/database');
    const webhookRow = await db.get('SELECT active FROM webhooks WHERE id = ?', [webhookRes.body.id]);
    expect(webhookRow.active).toBe(0);
  });

  test('retains the account\'s transactions and alerts for fraud history, visible to an admin', async () => {
    const { accessToken } = await registerAndLogin('delete_retain_user');
    const txnRes = await request(app).post(`${API}/transactions`).set('Authorization', `Bearer ${accessToken}`)
      .send({ amount: 5000, merchant: 'Retained Merchant', category: 'electronics', location: 'Lagos, NG', card_type: 'prepaid' });

    await request(app).delete(`${API}/auth/me`).set('Authorization', `Bearer ${accessToken}`).send({ password: STRONG_PASSWORD });

    const adminToken = await loginAdmin();
    const check = await request(app).get(`${API}/transactions/${txnRes.body.transaction.id}`).set('Authorization', `Bearer ${adminToken}`);
    expect(check.status).toBe(200);
    expect(check.body.transaction.merchant).toBe('Retained Merchant');
  });

  test('the original username and email become available for a new registration', async () => {
    const username = 'delete_reuse_user';
    const email = `${username}@example.com`;
    const { accessToken } = await registerAndLogin(username);
    await request(app).delete(`${API}/auth/me`).set('Authorization', `Bearer ${accessToken}`).send({ password: STRONG_PASSWORD });

    const reregister = await request(app).post(`${API}/auth/register`).send({ username, email, password: STRONG_PASSWORD });
    expect(reregister.status).toBe(201);
  });

  test('the audit trail records the deletion under the original username, before it was scrambled', async () => {
    const { accessToken } = await registerAndLogin('delete_audit_user');
    await request(app).delete(`${API}/auth/me`).set('Authorization', `Bearer ${accessToken}`).send({ password: STRONG_PASSWORD });

    const adminToken = await loginAdmin();
    const logs = await request(app).get(`${API}/admin/audit-logs`).set('Authorization', `Bearer ${adminToken}`)
      .query({ action: 'auth.account_deleted' });
    expect(logs.body.logs.some((l) => l.username === 'delete_audit_user')).toBe(true);
  });
});
