/** Geo-velocity wired into the transaction pipeline. */
jest.mock('../../models/mlClient');
const request = require('supertest');
const app = require('../../app');
const db = require('../../config/database');
const { initSchema } = require('../../config/schema');

const API = '/api/v1';
const A = (t) => ({ Authorization: `Bearer ${t}` });
let token; let userId; let seq = 0;
const body = (location) => ({ amount: 40, merchant: 'Corner Cafe', category: 'food', location, card_type: 'debit' });
const post = (location) => { seq += 1; return request(app).post(`${API}/transactions`).set(A(token)).set('User-Agent', `geo-${seq}`).set('X-Forwarded-For', `192.0.2.${seq}`).send(body(location)); };

beforeAll(async () => {
  await initSchema();
  const password = 'Str0ng!Passw0rd1';
  await request(app).post(`${API}/auth/register`).send({ username: 'geo_user', email: 'geo_user@example.com', password });
  token = (await request(app).post(`${API}/auth/login`).send({ username: 'geo_user', password })).body.accessToken;
  userId = (await db.get("SELECT id FROM users WHERE username = 'geo_user'")).id;
});

test('first transaction has no history: indeterminate, unchanged', async () => {
  const r = await post('New York, US');
  expect(r.status).toBe(201);
  expect(r.body.geo_velocity).toMatchObject({ status: 'indeterminate', reason: 'no_previous_transaction' });
  expect(r.body.analysis.risk_level).toBe('low');
});

test('New York then Sydney moments later is flagged MEDIUM with an explanation, never HIGH, and stored', async () => {
  const r = await post('Sydney, AU');
  expect(r.body.geo_velocity).toMatchObject({ mode: 'flag', status: 'implausible', reason: 'faster_than_travel' });
  expect(r.body.analysis.risk_level).toBe('medium');
  expect(r.body.analysis.risk_level).not.toBe('high');
  expect(r.body.analysis.fraud_reasons.join(' ')).toMatch(/implausible travel/i);
  expect(r.body.analysis.fraud_reasons.join(' ')).toMatch(/not proof/);
  const row = await db.get('SELECT geo_velocity_status, geo_distance_km, geo_required_kmh, risk_level FROM transactions WHERE id = ?', [r.body.transaction.id]);
  expect(row.geo_velocity_status).toBe('implausible');
  expect(row.geo_distance_km).toBeGreaterThan(10000);
});

test('the same trip with a feasible gap is plausible and not flagged', async () => {
  await db.run('UPDATE transactions SET created_at = ? WHERE user_id = ?', [new Date(Date.now() - 30 * 3600000).toISOString().replace('T', ' ').slice(0, 19), userId]);
  const r = await post('London, UK');
  expect(r.body.geo_velocity.status).toBe('plausible');
  expect(r.body.analysis.fraud_reasons.join(' ')).not.toMatch(/implausible travel/i);
});

test('an unresolvable location is not treated as a travel anomaly', async () => {
  const r = await post('Unknown');
  expect(r.body.geo_velocity).toMatchObject({ status: 'indeterminate', reason: 'location_not_resolvable' });
  expect(r.body.analysis.fraud_reasons.join(' ')).not.toMatch(/implausible travel/i);
});
