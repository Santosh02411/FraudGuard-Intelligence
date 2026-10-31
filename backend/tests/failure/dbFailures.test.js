/**
 * A database outage must be survivable and honest: readiness says not-ready, requests fail with a clean 5xx
 * (no stack, SQL or driver text), nothing half-written is left behind, and the service recovers on its own.
 */
const request = require('supertest');
const app = require('../../app');
const db = require('../../config/database');
const { initSchema } = require('../../config/schema');
const API = '/api/v1';
let token;

beforeAll(async () => {
  await initSchema();
  await request(app).post(`${API}/auth/register`).send({ username: 'dbf', email: 'dbf@example.com', password: 'Str0ng!Passw0rd1' });
  token = (await request(app).post(`${API}/auth/login`).send({ username: 'dbf', password: 'Str0ng!Passw0rd1' })).body.accessToken;
});
afterEach(() => jest.restoreAllMocks());

const LEAKS = /SqliteError|SQLITE|syntax error|at Object\.|node_modules|SELECT |INSERT |UPDATE |password_hash|stack/i;
const down = () => new Error('SQLITE_IOERR: disk I/O error (simulated outage)');

function failEverything() {
  for (const m of ['get', 'all', 'run', 'insert', 'exec']) jest.spyOn(db, m).mockRejectedValue(down());
  jest.spyOn(db, 'transaction').mockRejectedValue(down());
}

test('liveness stays up; readiness reports not_ready when the database is gone, and recovers', async () => {
  expect((await request(app).get(`${API}/health`)).status).toBe(200);
  expect((await request(app).get(`${API}/health/ready`)).status).toBe(200);
  failEverything();
  expect((await request(app).get(`${API}/health`)).status).toBe(200);
  const ready = await request(app).get(`${API}/health/ready`);
  expect(ready.status).toBe(503);
  expect(ready.body).toMatchObject({ status: 'not_ready', checks: { database: 'unavailable' } });
  jest.restoreAllMocks();
  expect((await request(app).get(`${API}/health/ready`)).status).toBe(200);
});

test.each([
  ['login', (r) => r.post(`${API}/auth/login`).send({ username: 'dbf', password: 'Str0ng!Passw0rd1' })],
  ['create transaction', (r, t) => r.post(`${API}/transactions`).set('Authorization', `Bearer ${t}`).send({ amount: 5, merchant: 'x', category: 'food', location: 'New York, US', card_type: 'credit' })],
  ['list alerts', (r, t) => r.get(`${API}/alerts`).set('Authorization', `Bearer ${t}`)],
  ['list transactions', (r, t) => r.get(`${API}/transactions`).set('Authorization', `Bearer ${t}`)],
])('%s during an outage: clean 5xx, no internals leaked', async (_name, call) => {
  failEverything();
  const res = await call(request(app), token);
  expect(res.status).toBeGreaterThanOrEqual(500);
  expect(res.status).toBeLessThan(600);
  expect(res.status).not.toBe(200);
  const text = JSON.stringify(res.body) + (res.text || '');
  expect(text).not.toMatch(LEAKS);
  expect(res.body.requestId).toBeTruthy(); // supportable: the caller can quote an id
});

test('a failure in the middle of persisting a transaction leaves nothing behind, and the next request works', async () => {
  const before = Number((await db.get('SELECT COUNT(*) n FROM transactions')).n);
  const realInsert = db.insert.bind(db);
  // let the transaction row insert succeed, then fail the next write inside the same DB transaction
  let writes = 0;
  jest.spyOn(db, 'insert').mockImplementation(async (...a) => { writes += 1; if (writes === 2) throw down(); return realInsert(...a); });
  const res = await request(app).post(`${API}/transactions`).set('Authorization', `Bearer ${token}`).set('User-Agent', 'dbf-mid')
    .send({ amount: 7, merchant: 'Mid', category: 'food', location: 'New York, US', card_type: 'credit' });
  expect(res.status).toBeGreaterThanOrEqual(500);
  jest.restoreAllMocks();
  expect(Number((await db.get('SELECT COUNT(*) n FROM transactions')).n)).toBe(before); // rolled back
  const ok = await request(app).post(`${API}/transactions`).set('Authorization', `Bearer ${token}`).set('User-Agent', 'dbf-after')
    .send({ amount: 8, merchant: 'After', category: 'food', location: 'New York, US', card_type: 'credit' });
  expect(ok.status).toBe(201);
  expect(Number((await db.get('SELECT COUNT(*) n FROM decision_records WHERE transaction_id = ?', [ok.body.transaction.id])).n)).toBe(1);
});

test('an idempotency key is not poisoned by a failed attempt: the retry succeeds exactly once', async () => {
  const key = `idem-${Date.now()}`;
  const send = () => request(app).post(`${API}/transactions`).set('Authorization', `Bearer ${token}`).set('Idempotency-Key', key).set('User-Agent', 'dbf-idem')
    .send({ amount: 9, merchant: 'Idem', category: 'food', location: 'New York, US', card_type: 'credit' });
  jest.spyOn(db, 'transaction').mockRejectedValueOnce(down());
  const first = await send();
  expect(first.status).toBeGreaterThanOrEqual(500);
  const retry = await send();
  expect(retry.status).toBe(201);
  const again = await send();
  expect(again.body.transaction.id).toBe(retry.body.transaction.id); // replay, not a duplicate
  expect(Number((await db.get("SELECT COUNT(*) n FROM transactions WHERE merchant = 'Idem'")).n)).toBe(1);
});
