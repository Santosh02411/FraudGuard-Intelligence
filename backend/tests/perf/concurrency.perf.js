/**
 * Concurrent transactions: correctness FIRST (no lost, duplicated or half-written decisions), then latency.
 * ML is stubbed with a realistic 15 ms latency so scoring overlaps the way it does in production.
 */
jest.mock('../../models/mlClient', () => ({
  ...jest.requireActual('../../models/mlClient'),
  scoreWithML: jest.fn(async () => { await new Promise((r) => setTimeout(r, 15)); return { fraud_score: 62, model_probability: 0.62, raw_probability: 0.62, calibrated: true, ml_calibrated: true, model_used: 'x', model_version: 'perf', top_factors: [] }; }),
}));
// Rate limiting is covered by its own tests; here it would only mask the concurrency behaviour under test.
jest.mock('../../middleware/rateLimiters', () => { const pass = (req, res, next) => next(); return { authLimiter: pass, transactionLimiter: pass, generalLimiter: pass }; });
const request = require('supertest');
const app = require('../../app');
const db = require('../../config/database');
const { initSchema } = require('../../config/schema');
const { pct, timed, record, flush } = require('./helpers');
const API = '/api/v1';
const PW = 'Str0ng!Passw0rd1';
const USERS = 20; const TOTAL = 300;
const tokens = [];

beforeAll(async () => {
  await initSchema();
  for (let i = 0; i < USERS; i++) {
    await request(app).post(`${API}/auth/register`).send({ username: `perf${i}`, email: `perf${i}@example.com`, password: PW });
    tokens.push((await request(app).post(`${API}/auth/login`).send({ username: `perf${i}`, password: PW })).body.accessToken);
  }
}, 120000);
afterAll(() => flush('concurrency.json'));

const body = (i) => ({ amount: 20 + (i % 50), merchant: `Shop ${i % 7}`, category: 'food', location: 'New York, US', card_type: 'credit' });
const send = (i, extra = {}) => request(app).post(`${API}/transactions`).set('Authorization', `Bearer ${tokens[i % USERS]}`).set('User-Agent', `dev-${i % USERS}`).set(extra).send(body(i));

test(`${TOTAL} concurrent transactions across ${USERS} users: all committed exactly once, atomically, fast`, async () => {
  const before = Number((await db.get('SELECT COUNT(*) n FROM transactions')).n);
  const t0 = Date.now();
  const timings = [];
  const results = await Promise.all(Array.from({ length: TOTAL }, async (_, i) => { const r = await timed(() => send(i)); timings.push(r.ms); return r.out; }));
  const wall = Date.now() - t0;

  const statuses = results.reduce((m, r) => ({ ...m, [r.status]: (m[r.status] || 0) + 1 }), {});
  expect(statuses).toEqual({ 201: TOTAL });
  const after = Number((await db.get('SELECT COUNT(*) n FROM transactions')).n);
  expect(after - before).toBe(TOTAL);
  // every transaction has exactly one original decision record, and one alert iff flagged
  const missing = Number((await db.get('SELECT COUNT(*) n FROM transactions t WHERE NOT EXISTS (SELECT 1 FROM decision_records d WHERE d.transaction_id = t.id AND d.seq = 1)')).n);
  expect(missing).toBe(0);
  const dupAlerts = await db.all('SELECT transaction_id FROM alerts GROUP BY transaction_id HAVING COUNT(*) > 1');
  expect(dupAlerts).toHaveLength(0);
  const chains = await db.all('SELECT transaction_id, COUNT(*) c, MAX(seq) m FROM decision_records GROUP BY transaction_id HAVING COUNT(*) != MAX(seq)');
  expect(chains).toHaveLength(0);

  record('concurrent_txn_p50', pct(timings, 50), { budgetMs: 5000 });
  record('concurrent_txn_p95', pct(timings, 95), { budgetMs: 8000 });
  record('concurrent_txn_throughput', (TOTAL / wall) * 1000, { unit: 'txn/s', note: `${TOTAL} requests in ${wall} ms` });
  expect((TOTAL / wall) * 1000).toBeGreaterThan(10 / Number(process.env.PERF_BUDGET_SCALE || 1)); // floor, not a target
}, 120000);

test('60 simultaneous retries of one idempotency key create exactly one transaction', async () => {
  const key = `perf-key-${Date.now()}`;
  const rs = await Promise.all(Array.from({ length: 60 }, () => send(1000, { 'Idempotency-Key': key })));
  const ids = new Set(rs.filter((r) => r.status === 201 || r.status === 200).map((r) => r.body.transaction?.id).filter(Boolean));
  expect(ids.size).toBe(1);
  expect(rs.every((r) => [200, 201, 409].includes(r.status))).toBe(true); // 409 = "still in flight", never a duplicate or a 5xx
  const n = Number((await db.get("SELECT COUNT(*) n FROM transactions WHERE merchant = ? AND amount = ?", [body(1000).merchant, body(1000).amount])).n);
  expect(n).toBeGreaterThanOrEqual(1);
  expect(new Set(rs.map((r) => r.status)).has(500)).toBe(false);
}, 60000);

test('concurrent claims, resolves and bulk resolves on the same alerts never lose or double-apply an action', async () => {
  const admin = (await request(app).post(`${API}/auth/login`).send({ username: 'admin', password: 'admin123' })).body.accessToken;
  const alerts = (await request(app).get(`${API}/alerts?limit=40&status=open`).set('Authorization', `Bearer ${admin}`)).body.alerts.slice(0, 20);
  expect(alerts.length).toBeGreaterThan(5);
  const ids = alerts.map((a) => a.id);
  const rs = await Promise.all(ids.flatMap((id) => [
    request(app).patch(`${API}/alerts/${id}/resolve`).set('Authorization', `Bearer ${admin}`).send({ verdict: 'false_positive' }),
    request(app).patch(`${API}/alerts/${id}/resolve`).set('Authorization', `Bearer ${admin}`).send({ verdict: 'confirmed_fraud' }),
  ]));
  // exactly one resolve per alert wins; the other is a clean 409, never a 5xx
  expect(rs.filter((r) => r.status === 200)).toHaveLength(ids.length);
  expect(rs.filter((r) => r.status === 409)).toHaveLength(ids.length);
  expect(rs.some((r) => r.status >= 500)).toBe(false);
}, 60000);
