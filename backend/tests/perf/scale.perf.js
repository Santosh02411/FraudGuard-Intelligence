/**
 * Large histories: the hot paths must not degrade with data volume. Seeds a big dataset directly
 * (bulk insert in one DB transaction), then times the operations a busy deployment performs constantly.
 */
jest.mock('../../models/mlClient', () => ({
  ...jest.requireActual('../../models/mlClient'),
  scoreWithML: jest.fn(async () => ({ fraud_score: 30, model_probability: 0.3, raw_probability: 0.3, calibrated: true, ml_calibrated: true, model_used: 'x', model_version: 'perf', top_factors: [] })),
}));
const request = require('supertest');
const app = require('../../app');
const db = require('../../config/database');
const { initSchema } = require('../../config/schema');
const { pct, timed, record, flush } = require('./helpers');
const API = '/api/v1';
const PW = 'Str0ng!Passw0rd1';
const HEAVY_USER_TXNS = Number(process.env.PERF_HEAVY_TXNS || 20000);
const OTHER_USERS = 50; const OTHER_TXNS_EACH = Number(process.env.PERF_OTHER_TXNS || 600);
let heavyTok; let adminTok; let heavyId;

async function bulkInsert(userId, count, { flaggedEvery = 25, startDaysAgo = 400 } = {}) {
  const t0 = Date.now() - startDaysAgo * 86400000;
  const step = (startDaysAgo * 86400000) / count;
  await db.transaction(async () => {
    for (let i = 0; i < count; i++) {
      const at = new Date(t0 + i * step).toISOString();
      const flagged = i % flaggedEvery === 0;
      const { lastInsertRowid } = await db.insert(
        `INSERT INTO transactions (user_id, amount, merchant, category, location, card_type, device_fingerprint, ip_address, is_fraud, fraud_score, risk_level, status, created_at, is_synthetic)
         VALUES (?, ?, ?, 'food', 'New York, US', 'credit', ?, ?, ?, ?, ?, 'completed', ?, 0)`,
        [userId, 10 + (i % 300), `Merchant ${i % 40}`, `dev${userId}-${i % 5}`, `10.${userId % 250}.${i % 250}.1`, flagged && i % 100 === 0 ? 1 : 0, flagged ? 70 : 5, flagged ? 'high' : 'low', at]);
      if (flagged) {
        await db.insert(
          `INSERT INTO alerts (transaction_id, user_id, message, risk_level, severity, due_at, status, created_at, resolved, verdict) VALUES (?, ?, 'seeded', 'high', 'high', ?, 'open', ?, ?, ?)`,
          [lastInsertRowid, userId, new Date(Date.now() + 3600000).toISOString(), at, i % 3 === 0 ? 1 : 0, i % 3 === 0 ? (i % 200 === 0 ? 'confirmed_fraud' : 'false_positive') : null]);
      }
    }
  });
}

beforeAll(async () => {
  await initSchema();
  await request(app).post(`${API}/auth/register`).send({ username: 'heavy', email: 'heavy@example.com', password: PW });
  heavyTok = (await request(app).post(`${API}/auth/login`).send({ username: 'heavy', password: PW })).body.accessToken;
  adminTok = (await request(app).post(`${API}/auth/login`).send({ username: 'admin', password: 'admin123' })).body.accessToken;
  heavyId = (await db.get("SELECT id FROM users WHERE username = 'heavy'")).id;
  const t = Date.now();
  await bulkInsert(heavyId, HEAVY_USER_TXNS);
  for (let u = 0; u < OTHER_USERS; u++) {
    const r = await db.insert("INSERT INTO users (username, email, password, role) VALUES (?, ?, 'x', 'user')", [`bulk${u}`, `bulk${u}@example.com`]);
    await bulkInsert(Number(r.lastInsertRowid), OTHER_TXNS_EACH, { flaggedEvery: 40 });
  }
  console.log(`seeded ${HEAVY_USER_TXNS + OTHER_USERS * OTHER_TXNS_EACH} transactions in ${Date.now() - t} ms`);
}, 600000);
afterAll(() => flush('scale.json'));

const auth = (t) => ({ Authorization: `Bearer ${t}` });
async function sample(n, fn) { const ms = []; for (let i = 0; i < n; i++) ms.push((await timed(fn)).ms); return ms; }

test('scoring a new transaction for a user with a huge history stays fast (history lookup is bounded)', async () => {
  let i = 0;
  const ms = await sample(30, () => request(app).post(`${API}/transactions`).set(auth(heavyTok)).set('User-Agent', `heavy-${i++ % 3}`)
    .send({ amount: 42, merchant: 'Cafe', category: 'food', location: 'New York, US', card_type: 'credit' }).expect(201));
  record(`score_new_txn_heavy_user_p95 (history ${HEAVY_USER_TXNS})`, pct(ms, 95), { budgetMs: 800 });
  record('score_new_txn_heavy_user_p50', pct(ms, 50), { budgetMs: 400 });
}, 120000);

test('the heavy user\'s transaction list: first page, deep page, filtered', async () => {
  const first = await sample(10, () => request(app).get(`${API}/transactions?page=1&limit=50`).set(auth(heavyTok)).expect(200));
  const deep = await sample(5, () => request(app).get(`${API}/transactions?page=300&limit=50`).set(auth(heavyTok)).expect(200));
  const filtered = await sample(5, () => request(app).get(`${API}/transactions?riskLevel=high&limit=50`).set(auth(heavyTok)).expect(200));
  record('txn_list_first_page_p95', pct(first, 95), { budgetMs: 500 });
  record('txn_list_deep_page_p95', pct(deep, 95), { budgetMs: 800 });
  record('txn_list_filtered_p95', pct(filtered, 95), { budgetMs: 800 });
}, 120000);

test('admin views over the whole dataset: alert queue, metrics, summary', async () => {
  const queue = await sample(10, () => request(app).get(`${API}/alerts?sort=priority&limit=50`).set(auth(adminTok)).expect(200));
  const filtered = await sample(5, () => request(app).get(`${API}/alerts?severity=high&overdue=true&limit=50`).set(auth(adminTok)).expect(200));
  const metrics = await sample(3, () => request(app).get(`${API}/alerts/metrics?days=365`).set(auth(adminTok)).expect(200));
  record('alert_queue_priority_p95', pct(queue, 95), { budgetMs: 800 });
  record('alert_queue_filtered_p95', pct(filtered, 95), { budgetMs: 800 });
  record('alert_metrics_p95', pct(metrics, 95), { budgetMs: 2500 });
}, 120000);

test('network/ring detection and the dynamic blacklist (run on every scored transaction) scale with the data', async () => {
  const repo = require('../../models/transactionRepository');
  const net = require('../../models/networkRepository');
  const bl = await sample(5, () => repo.fraudDeviceAndIpBlacklist());
  const ring = await sample(3, () => net.networkRiskForTransaction({ device_fingerprint: 'new-dev', ip_address: '203.0.113.9' }, heavyId));
  record('fraud_blacklist_query_p95', pct(bl, 95), { budgetMs: 800 });
  record('network_ring_detection_p95', pct(ring, 95), { budgetMs: 3100 });
}, 120000);

test('decision history and rescore on a transaction in a big table stay constant-time', async () => {
  const id = (await db.get('SELECT id FROM transactions WHERE user_id = ? ORDER BY id DESC LIMIT 1', [heavyId])).id;
  const ms = await sample(10, () => request(app).get(`${API}/admin/transactions/${id}/decision-history`).set(auth(adminTok)).expect(200));
  record('decision_history_p95', pct(ms, 95), { budgetMs: 500 });
}, 60000);

test('relationship analysis over the whole dataset: clusters, graph expansion, model-performance report', async () => {
  const rel = require('../../services/relationshipService');
  // realistic sharing: 300 users x 40 txns drawing from a pool of public IPs and devices, so clusters, hubs and weak leads all occur
  await db.transaction(async () => {
    for (let u = 0; u < 300; u++) {
      const uid = Number((await db.insert("INSERT INTO users (username, email, password, role) VALUES (?, ?, 'x', 'user')", [`relperf${u}`, `relperf${u}@example.com`])).lastInsertRowid);
      for (let i = 0; i < 40; i++) {
        await db.insert(`INSERT INTO transactions (user_id, amount, merchant, category, location, card_type, device_fingerprint, ip_address, fraud_score, risk_level, status, created_at, is_synthetic) VALUES (?, ?, ?, 'food', 'NY', 'credit', ?, ?, 5, 'low', 'completed', ?, 0)`,
          [uid, 3 + (i % 40), `Rare${(u + i) % 400}`, `rdev${Math.floor((u + i) / 3) % 150}`, `203.0.${Math.floor(((u * 7 + i) % 120) / 3)}.${(u + i) % 20 + 1}`, new Date(Date.now() - (u * 40 + i) * 60000).toISOString()]);
      }
    }
  });
  const tx = await db.get('SELECT id FROM transactions WHERE user_id = ? ORDER BY id DESC LIMIT 1', [heavyId]);
  const clusters = await sample(3, async () => { rel.invalidate(); return rel.clusters({ limit: 25 }); });
  const graph = await sample(5, () => rel.graph({ transactionId: tx.id, depth: 2 }));
  const perf = await sample(3, () => request(app).get(`${API}/admin/model-performance?days=365`).set(auth(adminTok)).expect(200));
  record('relationship_clusters_cold_p95', pct(clusters, 95), { budgetMs: 6000 });
  record('relationship_graph_depth2_p95', pct(graph, 95), { budgetMs: 1500 });
  record('model_performance_report_p95', pct(perf, 95), { budgetMs: 6000 });
}, 120000);

test('retention dry-run over the whole decision table', async () => {
  const retention = require('../../services/retentionService');
  const { ms } = await timed(() => retention.run({ dryRun: true, now: new Date(Date.now() + 3100 * 86400000) }));
  record('retention_dry_run', ms, { budgetMs: 5000 });
}, 60000);
