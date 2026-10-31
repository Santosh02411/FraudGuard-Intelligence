// No COGNEE_SERVICE_URL: the integration must be inert and say so clearly - never crash, never fake data.
const request = require('supertest');
const app = require('../../app');
const db = require('../../config/database');
const { initSchema } = require('../../config/schema');
const sync = require('../../services/cognee/syncService');

const API = '/api/v1/cognee-memory';
let admin;
beforeAll(async () => {
  await initSchema();
  admin = (await request(app).post('/api/v1/auth/login').send({ username: 'admin', password: 'admin123' })).body.accessToken;
});

test('health and status report not_configured with an actionable message', async () => {
  const h = await request(app).get(`${API}/health`).set({ Authorization: `Bearer ${admin}` });
  expect(h.status).toBe(200);
  expect(h.body).toMatchObject({ configured: false, reachable: false, status: 'not_configured' });
  expect(h.body.message).toMatch(/COGNEE_SERVICE_URL/);
  const s = await request(app).get(`${API}/status`).set({ Authorization: `Bearer ${admin}` });
  expect(s.body).toMatchObject({ configured: false, connected: false });
});

test.each([['post', '/sync', {}], ['post', '/search', { query: 'anything' }], ['get', '/entities', undefined], ['post', '/assistant', { kind: 'transaction', id: 1 }]])(
  '%s %s answers 503 (not 500) when not configured', async (method, path, body) => {
    const r = await request(app)[method](`${API}${path}`).set({ Authorization: `Bearer ${admin}` }).send(body);
    expect(r.status).toBe(503);
  });

test('scheduler never starts without configuration and nothing is written to the sync tables', async () => {
  expect(sync.startScheduler()).toBe(false);
  expect(Number((await db.get('SELECT COUNT(*) AS n FROM cognee_sync_records')).n)).toBe(0);
});

test('the migration is additive and idempotent', async () => {
  await initSchema(); await initSchema();
  const tables = (await db.all("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'cognee_%'")).map((r) => r.name).sort();
  expect(tables).toEqual(['cognee_sync_cursor', 'cognee_sync_records', 'cognee_sync_runs']);
});
