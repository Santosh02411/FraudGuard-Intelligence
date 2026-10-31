const request = require('supertest');
const app = require('../../app');
const db = require('../../config/database');
const { initSchema } = require('../../config/schema');
const { getMlStatus, _resetCacheForTests } = require('../../services/mlStatus');

const API = '/api/v1';
let admin; let userTok; let uid;
const A = (t) => ({ Authorization: `Bearer ${t}` });

async function tx(userId, { risk = 'low', status = 'completed', fraud = 0, amount = 10 } = {}) {
  await db.insert(`INSERT INTO transactions (user_id, amount, merchant, category, location, card_type, is_fraud, fraud_score, risk_level, status, created_at, is_synthetic)
    VALUES (?, ?, 'M', 'food', 'NY', 'credit', ?, 10, ?, ?, ?, 0)`, [userId, amount, fraud, risk, status, new Date().toISOString()]);
}

beforeAll(async () => {
  await initSchema();
  const login = async (u, p) => (await request(app).post(`${API}/auth/login`).send({ username: u, password: p })).body.accessToken;
  admin = await login('admin', 'admin123');
  await request(app).post(`${API}/auth/register`).send({ username: 'stat_user', email: 'stat_user@example.com', password: 'Str0ng!Passw0rd1' });
  userTok = await login('stat_user', 'Str0ng!Passw0rd1');
  uid = (await db.get("SELECT id FROM users WHERE username='stat_user'")).id;
  await tx(uid, { risk: 'medium' }); await tx(uid, { risk: 'medium' }); await tx(uid, { risk: 'high', fraud: 1, status: 'blocked' });
  await tx(uid, { status: 'pending_step_up', risk: 'medium' }); await tx(uid);
});

describe('dashboard counters in /transactions/stats', () => {
  test('exposes medium, declined and held counts over the whole table (user scope)', async () => {
    const r = await request(app).get(`${API}/transactions/stats`).set(A(userTok));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ total_transactions: 5, fraud_count: 1, medium_count: 3, declined_count: 1, held_count: 1 });
  });
  test('admin scope covers everyone; existing fields are unchanged', async () => {
    const r = await request(app).get(`${API}/transactions/stats`).set(A(admin));
    expect(r.body.total_transactions).toBeGreaterThanOrEqual(5);
    for (const k of ['total_transactions', 'fraud_count', 'fraud_rate', 'total_amount', 'avg_fraud_score', 'medium_count', 'declined_count', 'held_count']) expect(r.body).toHaveProperty(k);
  });
});

describe('GET /system/status', () => {
  const realFetch = global.fetch;
  afterEach(() => { global.fetch = realFetch; _resetCacheForTests(); });

  test('requires authentication', async () => { expect((await request(app).get(`${API}/system/status`)).status).toBe(401); });

  test('reports the ML service as down when it is unreachable (never an error)', async () => {
    const r = await request(app).get(`${API}/system/status`).set(A(userTok));   // test env points ML_SERVICE_URL at a closed port
    expect(r.status).toBe(200);
    expect(r.body.ml.status).toBe('down');
  });

  test('reports ok when the ML service answers /health, and caches the answer', async () => {
    global.fetch = jest.fn(async () => ({ ok: true, status: 200 }));
    const first = await getMlStatus({ force: true, now: 1000 });
    const second = await getMlStatus({ now: 5000 });
    expect(first.status).toBe('ok'); expect(second).toBe(first);
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(global.fetch.mock.calls[0][0]).toMatch(/\/health$/);
    await getMlStatus({ now: 1000 + 16000 });                                   // past the TTL: asks again
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  test('a non-200 or a hung ML service is "down"', async () => {
    global.fetch = jest.fn(async () => ({ ok: false, status: 503 }));
    expect((await getMlStatus({ force: true })).status).toBe('down');
    global.fetch = jest.fn((url, init) => new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(new Error('aborted')))));
    const t0 = Date.now(); const v = await getMlStatus({ force: true });
    expect(v.status).toBe('down'); expect(Date.now() - t0).toBeLessThan(4000);
  });
});
