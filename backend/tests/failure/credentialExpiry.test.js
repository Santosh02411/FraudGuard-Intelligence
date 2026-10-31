/**
 * Expired, forged, revoked and wrong-purpose credentials must all fail CLOSED, with the same
 * generic message (no oracle), and an expired credential must never be usable for anything.
 */
jest.mock('../../models/mlClient', () => ({ ...jest.requireActual('../../models/mlClient'), scoreWithML: jest.fn().mockResolvedValue({ fraud_score: 30, model_probability: 0.3, raw_probability: 0.3, calibrated: true, ml_calibrated: true, model_used: 'x', model_version: 'v', top_factors: [] }) }));

const request = require('supertest');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const app = require('../../app');
const db = require('../../config/database');
const config = require('../../config/env');
const { initSchema } = require('../../config/schema');
const API = '/api/v1';
const PW = 'Str0ng!Passw0rd1';
let userId; let access; let n = 0;

const sign = (payload, opts = {}, secret = config.jwtSecret) => jwt.sign(payload, secret, opts);
const hash = (t) => crypto.createHash('sha256').update(t).digest('hex');
const me = (tok) => request(app).get(`${API}/transactions`).set('Authorization', `Bearer ${tok}`);

beforeAll(async () => {
  await initSchema();
  await request(app).post(`${API}/auth/register`).send({ username: 'cred', email: 'cred@example.com', password: PW });
  const r = await request(app).post(`${API}/auth/login`).send({ username: 'cred', password: PW });
  access = r.body.accessToken;
  userId = (await db.get("SELECT id FROM users WHERE username = 'cred'")).id;
});

describe('access tokens', () => {
  test('a valid token works (control)', async () => { expect((await me(access)).status).toBe(200); });

  test.each([
    ['expired', () => sign({ id: userId, type: 'access' }, { expiresIn: -10 })],
    ['signed with the wrong secret', () => sign({ id: userId, type: 'access' }, { expiresIn: '5m' }, 'not-the-secret')],
    ['alg=none (unsigned)', () => `${Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url')}.${Buffer.from(JSON.stringify({ id: userId, type: 'access', exp: Math.floor(Date.now() / 1000) + 600 })).toString('base64url')}.`],
    ['wrong token type (refresh-style claim)', () => sign({ id: userId, type: 'refresh' }, { expiresIn: '5m' })],
    ['missing type claim', () => sign({ id: userId }, { expiresIn: '5m' })],
    ['for a user that no longer exists', () => sign({ id: 999999, type: 'access' }, { expiresIn: '5m' })],
    ['tampered payload', () => { const [h, , s] = access.split('.'); return `${h}.${Buffer.from(JSON.stringify({ id: 1, type: 'access', exp: Math.floor(Date.now() / 1000) + 600 })).toString('base64url')}.${s}`; }],
    ['garbage', () => 'not.a.jwt'],
  ])('%s -> 401, generic message', async (_name, make) => {
    const res = await me(make());
    expect(res.status).toBe(401);
    expect(JSON.stringify(res.body)).not.toMatch(/jwt|signature|secret|expired at/i);
  });

  test('an expired token cannot reach admin routes or alerts either', async () => {
    const dead = sign({ id: userId, type: 'access' }, { expiresIn: -1 });
    for (const path of ['/admin/users', '/alerts', '/disputes', '/api-keys']) {
      expect((await request(app).get(`${API}${path}`).set('Authorization', `Bearer ${dead}`)).status).toBe(401);
    }
  });

  test('a token whose user was demoted from admin loses admin immediately (role is read per request)', async () => {
    await request(app).post(`${API}/auth/register`).send({ username: 'demote', email: 'demote@example.com', password: PW });
    await db.run("UPDATE users SET role = 'admin' WHERE username = 'demote'");
    const tok = (await request(app).post(`${API}/auth/login`).send({ username: 'demote', password: PW })).body.accessToken;
    expect((await request(app).get(`${API}/admin/users`).set('Authorization', `Bearer ${tok}`)).status).toBe(200);
    await db.run("UPDATE users SET role = 'user' WHERE username = 'demote'");
    expect((await request(app).get(`${API}/admin/users`).set('Authorization', `Bearer ${tok}`)).status).toBe(403);
  });
});

describe('refresh tokens', () => {
  test('an expired refresh token is refused and cannot mint new tokens', async () => {
    const login = await request(app).post(`${API}/auth/login`).send({ username: 'cred', password: PW });
    await db.run('UPDATE refresh_tokens SET expires_at = ? WHERE token_hash = ?', [new Date(Date.now() - 1000).toISOString(), hash(login.body.refreshToken)]);
    const res = await request(app).post(`${API}/auth/refresh`).send({ refreshToken: login.body.refreshToken });
    expect(res.status).toBe(401);
    expect(res.body.accessToken).toBeUndefined();
  });

  test('reusing a rotated refresh token revokes the whole family (theft detection)', async () => {
    const login = await request(app).post(`${API}/auth/login`).send({ username: 'cred', password: PW });
    const rotated = await request(app).post(`${API}/auth/refresh`).send({ refreshToken: login.body.refreshToken });
    expect(rotated.status).toBe(200);
    expect((await request(app).post(`${API}/auth/refresh`).send({ refreshToken: login.body.refreshToken })).status).toBe(401); // replay
    expect((await request(app).post(`${API}/auth/refresh`).send({ refreshToken: rotated.body.refreshToken })).status).toBe(401); // the legit holder is cut off too
  });

  test('a password change revokes existing refresh tokens', async () => {
    await request(app).post(`${API}/auth/register`).send({ username: 'pwchg', email: 'pwchg@example.com', password: PW });
    const l = await request(app).post(`${API}/auth/login`).send({ username: 'pwchg', password: PW });
    const ch = await request(app).patch(`${API}/auth/password`).set('Authorization', `Bearer ${l.body.accessToken}`).send({ currentPassword: PW, newPassword: 'N3w!Passw0rd-Strong' });
    expect([200, 204]).toContain(ch.status);
    expect((await request(app).post(`${API}/auth/refresh`).send({ refreshToken: l.body.refreshToken })).status).toBe(401);
  });
});

describe('single-purpose tokens', () => {
  test('an expired password-reset token cannot reset the password; a used one cannot be reused', async () => {
    const token = crypto.randomBytes(24).toString('hex');
    await db.run('UPDATE users SET password_reset_token_hash = ?, password_reset_expires_at = ? WHERE id = ?', [hash(token), new Date(Date.now() - 60000).toISOString(), userId]);
    const res = await request(app).post(`${API}/auth/reset-password`).send({ token, password: 'An0ther!Strong-Pass' });
    expect(res.status).toBe(400);
    expect((await request(app).post(`${API}/auth/login`).send({ username: 'cred', password: PW })).status).toBe(200); // password unchanged

    const fresh = crypto.randomBytes(24).toString('hex');
    await db.run('UPDATE users SET password_reset_token_hash = ?, password_reset_expires_at = ? WHERE id = ?', [hash(fresh), new Date(Date.now() + 600000).toISOString(), userId]);
    expect((await request(app).post(`${API}/auth/reset-password`).send({ token: fresh, password: PW })).status).toBe(200);
    expect((await request(app).post(`${API}/auth/reset-password`).send({ token: fresh, password: PW })).status).toBe(400); // single use
  });

  test('an expired email-verification token does not verify the account', async () => {
    const token = crypto.randomBytes(24).toString('hex');
    await db.run('UPDATE users SET email_verified = 0, email_verification_token_hash = ?, email_verification_expires_at = ? WHERE id = ?', [hash(token), new Date(Date.now() - 1000).toISOString(), userId]);
    const res = await request(app).post(`${API}/auth/verify-email`).send({ token });
    expect(res.status).toBe(400);
    expect((await db.get('SELECT email_verified FROM users WHERE id = ?', [userId])).email_verified).toBe(0);
  });

  test('an MFA login challenge token (not an access token) cannot be used as an access token', async () => {
    const mfaStyle = sign({ id: userId, type: 'mfa_challenge' }, { expiresIn: '5m' });
    expect((await me(mfaStyle)).status).toBe(401);
  });
});

describe('API keys', () => {
  test('expired and revoked keys are refused; a live one works', async () => {
    const login = await request(app).post(`${API}/auth/login`).send({ username: 'cred', password: PW });
    const mk = async (extra = {}) => (await request(app).post(`${API}/api-keys`).set('Authorization', `Bearer ${login.body.accessToken}`).send({ name: `k${++n}`, scopes: ['transactions:read'], expiresInDays: 1, ...extra })).body;
    const live = await mk(); const old = await mk(); const revoked = await mk();
    const call = (key) => request(app).get(`${API}/transactions`).set('X-API-Key', key);
    expect((await call(live.key)).status).toBe(200);
    await db.run('UPDATE api_keys SET expires_at = ? WHERE id = ?', [new Date(Date.now() - 1000).toISOString(), old.id]);
    expect((await call(old.key)).status).toBe(401);
    await request(app).delete(`${API}/api-keys/${revoked.id}`).set('Authorization', `Bearer ${login.body.accessToken}`);
    expect((await call(revoked.key)).status).toBe(401);
    expect((await call('fg_live_' + 'a'.repeat(40))).status).toBe(401);
  });

  test('a key without the scope is refused (403), not silently allowed', async () => {
    const login = await request(app).post(`${API}/auth/login`).send({ username: 'cred', password: PW });
    const k = (await request(app).post(`${API}/api-keys`).set('Authorization', `Bearer ${login.body.accessToken}`).send({ name: 'readonly', scopes: ['transactions:read'] })).body;
    const res = await request(app).post(`${API}/transactions`).set('X-API-Key', k.key).send({ amount: 5, merchant: 'x', category: 'food', location: 'New York, US', card_type: 'credit' });
    expect([401, 403]).toContain(res.status);
  });
});

describe('step-up challenges', () => {
  test('an expired challenge cannot be verified', async () => {
    const stepUp = require('../../models/stepUpRepository');
    const { lastInsertRowid } = await db.insert(
      `INSERT INTO transactions (user_id, amount, merchant, category, location, card_type, is_fraud, fraud_score, risk_level, status)
       VALUES (?, 80, 'M', 'food', 'New York, US', 'credit', 0, 30, 'medium', 'pending_step_up')`, [userId]);
    const ch = await stepUp.createChallenge({ transactionId: lastInsertRowid });
    await db.run('UPDATE step_up_challenges SET expires_at = ? WHERE transaction_id = ?', [new Date(Date.now() - 1000).toISOString(), lastInsertRowid]);
    const login = await request(app).post(`${API}/auth/login`).send({ username: 'cred', password: PW });
    const res = await request(app).post(`${API}/transactions/${lastInsertRowid}/step-up/verify`).set('Authorization', `Bearer ${login.body.accessToken}`).send({ challenge_token: ch.challenge_token, outcome: 'success' });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect((await db.get('SELECT status FROM transactions WHERE id = ?', [lastInsertRowid])).status).not.toBe('completed');
  });
});
