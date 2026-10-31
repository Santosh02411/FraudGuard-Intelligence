jest.mock('../../models/mlClient');
const request = require('supertest');
const app = require('../../app');
const db = require('../../config/database');
const { initSchema } = require('../../config/schema');
const transactionRepository = require('../../models/transactionRepository');

const API = '/api/v1';
const A = (t) => ({ Authorization: `Bearer ${t}` });
let admin; let userToken; let userId;
const ago = (d) => new Date(Date.now() - d * 86400000).toISOString().replace('T', ' ').slice(0, 19);

beforeAll(async () => {
  await initSchema();
  admin = (await request(app).post(`${API}/auth/login`).send({ username: 'admin', password: 'admin123' })).body.accessToken;
  const password = 'Str0ng!Passw0rd1';
  await request(app).post(`${API}/auth/register`).send({ username: 'prof_user', email: 'prof_user@example.com', password });
  userToken = (await request(app).post(`${API}/auth/login`).send({ username: 'prof_user', password })).body.accessToken;
  userId = (await db.get("SELECT id FROM users WHERE username = 'prof_user'")).id;
  for (let i = 0; i < 12; i += 1) {
    await transactionRepository.insert({ user_id: userId, amount: 40 + i, merchant: 'Cafe', category: 'food', location: 'New York, US', card_type: 'debit', device_fingerprint: 'dev-a', is_fraud: 0, fraud_score: 1, risk_level: 'low', created_at: ago(5 + i * 2) });
  }
  await transactionRepository.insert({ user_id: userId, amount: 1500, merchant: 'Electronics', category: 'electronics', location: 'Sydney, AU', card_type: 'debit', device_fingerprint: 'dev-b', is_fraud: 0, fraud_score: 5, risk_level: 'low', geo_velocity_status: 'implausible', created_at: ago(0.5) });
});

test('admin only', async () => {
  expect((await request(app).get(`${API}/customer-profiles`)).status).toBe(401);
  expect((await request(app).get(`${API}/customer-profiles`).set(A(userToken))).status).toBe(403);
  expect((await request(app).get(`${API}/customer-profiles/${userId}`).set(A(userToken))).status).toBe(403);
});

test('a profile explains itself: factors, evidence, weights, coverage, disclaimer', async () => {
  const r = await request(app).get(`${API}/customer-profiles/${userId}`).set(A(admin));
  expect(r.status).toBe(200);
  const p = r.body.profile;
  expect(p.username).toBe('prof_user');
  expect(p.factors).toHaveLength(6);
  expect(p.factors.find((f) => f.name === 'spending').score).toBeGreaterThan(50);
  expect(p.factors.find((f) => f.name === 'location').score).toBeGreaterThan(0);
  expect(p.top_factors[0].headline).toBeTruthy();
  expect(p.disclaimer).toMatch(/never blocks/);
  expect(JSON.stringify(p)).not.toMatch(/dev-a|dev-b/);
});

test('unknown user is 404; bad id is 400; viewing is audited', async () => {
  expect((await request(app).get(`${API}/customer-profiles/999999`).set(A(admin))).status).toBe(404);
  expect((await request(app).get(`${API}/customer-profiles/abc`).set(A(admin))).status).toBe(400);
  await new Promise((r) => setTimeout(r, 200));
  const row = await db.get("SELECT action FROM audit_logs WHERE action = 'customer_profile.view' LIMIT 1");
  expect(row).toBeTruthy();
});

test('the ranked list includes the account, supports min_band, and reports its scan cap honestly', async () => {
  const r = await request(app).get(`${API}/customer-profiles?limit=10`).set(A(admin));
  expect(r.status).toBe(200);
  expect(r.body.profiles.some((p) => p.username === 'prof_user')).toBe(true);
  expect(r.body).toHaveProperty('truncated');
  const high = await request(app).get(`${API}/customer-profiles?min_band=high`).set(A(admin));
  expect(high.body.profiles.every((p) => p.band === 'high')).toBe(true);
  expect((await request(app).get(`${API}/customer-profiles?min_band=low`).set(A(admin))).status).toBe(400);
});
