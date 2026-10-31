/**
 * LIVE end-to-end: real FraudGuard backend (DB, projector, sync, routes) <-> real cognee_service
 * (real Cognee SDK: graph store, vector store, cognify). Not part of the default `npm test`.
 *
 *   # terminal 1:  cd cognee_service && python -m tests.run_offline_server     (offline stand-ins)
 *   #          or: run the service normally with real LLM/embedding keys
 *   # terminal 2:  COGNEE_E2E_URL=http://127.0.0.1:8765 COGNEE_E2E_KEY=<key> npm run test:e2e:cognee
 */
const URL_ = process.env.COGNEE_E2E_URL;
const describeLive = URL_ ? describe : describe.skip;
process.env.COGNEE_SERVICE_URL = URL_ || 'http://127.0.0.1:1';
process.env.COGNEE_SERVICE_API_KEY = process.env.COGNEE_E2E_KEY || 'e2e-service-key-0123456789abcdef0123456789';
process.env.COGNEE_PSEUDONYM_SECRET = 'e2e-pseudonym-secret-0123456789abcd';
process.env.COGNEE_SYNC_INTERVAL_MS = '0';
process.env.COGNEE_MAX_RETRIES = '0';
jest.setTimeout(120000);

const request = require('supertest');
const app = require('../../app');
const db = require('../../config/database');
const { initSchema } = require('../../config/schema');

const API = '/api/v1/cognee-memory';
let admin; let uA; let uB; let uC;
const H = () => ({ Authorization: `Bearer ${admin}` });
const iso = () => new Date().toISOString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function tx(userId, merchant, { fp, score = 20, risk = 'low', reasons = [], alert = false, verdict = null, note = null } = {}) {
  const { lastInsertRowid } = await db.insert(
    `INSERT INTO transactions (user_id, amount, merchant, category, location, card_type, device_fingerprint, ip_address, is_fraud, fraud_score, risk_level, fraud_reasons, status, created_at, is_synthetic)
     VALUES (?, ?, ?, 'gift_cards', 'Lagos', 'credit', ?, '203.0.113.5', ?, ?, ?, ?, 'completed', ?, 0)`,
    [userId, 450, merchant, fp || null, risk === 'high' ? 1 : 0, score, risk, JSON.stringify(reasons), iso()]);
  const tid = Number(lastInsertRowid); let aid = null;
  if (alert) {
    aid = Number((await db.insert("INSERT INTO alerts (transaction_id, user_id, message, risk_level, severity, status, verdict, resolved, created_at, resolution_note) VALUES (?, ?, 'x', ?, 'high', ?, ?, ?, ?, ?)",
      [tid, userId, risk, verdict ? 'resolved' : 'open', verdict, verdict ? 1 : 0, iso(), note])).lastInsertRowid);
  }
  return { tid, aid };
}

describeLive('FraudGuard <-> Cognee service (live)', () => {
  let t1; let t2; let t3; let t4;
  beforeAll(async () => {
    await initSchema();
    admin = (await request(app).post('/api/v1/auth/login').send({ username: 'admin', password: 'admin123' })).body.accessToken;
    for (const n of ['e2e_a', 'e2e_b', 'e2e_c']) await request(app).post('/api/v1/auth/register').send({ username: n, email: `${n}@example.com`, password: 'Str0ng!Passw0rd1' });
    [uA, uB, uC] = await Promise.all(['e2e_a', 'e2e_b', 'e2e_c'].map(async (n) => (await db.get('SELECT id FROM users WHERE username = ?', [n])).id));
    t1 = await tx(uA, 'Midnight Gift Cards', { fp: 'shared-device-fp', score: 95, risk: 'high', reasons: ['Card testing pattern: many small purchases'], alert: true, verdict: 'confirmed_fraud', note: 'Customer never made these purchases; card reissued' });
    t2 = await tx(uB, 'Midnight Gift Cards', { fp: 'shared-device-fp', score: 91, risk: 'high', reasons: ['Card testing pattern: many small purchases'], alert: true });
    t3 = await tx(uC, 'Sunrise Bakery', { fp: 'other-fp', score: 3 });
    t4 = await tx(uC, 'Midnight Gift Cards', { fp: 'new-device-fp', score: 90, risk: 'high', reasons: ['Card testing pattern: many small purchases'], alert: true });
    const inv = await db.insert("INSERT INTO investigations (title, summary, status, priority, outcome, outcome_note, created_at, updated_at, version) VALUES ('Gift card testing ring', 'Two accounts one device', 'closed', 'high', 'confirmed_fraud', 'Blocked device; refunded customers', ?, ?, 1)", [iso(), iso()]);
    for (const t of [t1.tid, t2.tid]) await db.insert("INSERT INTO investigation_items (investigation_id, item_type, item_id, added_at) VALUES (?, 'transaction', ?, ?)", [Number(inv.lastInsertRowid), t, iso()]);
  });

  test('health reports the real service', async () => {
    const h = (await request(app).get(`${API}/health`).set(H())).body;
    expect(h).toMatchObject({ configured: true, reachable: true, status: 'ok' });
  });

  test('sync ingests real records into the real Cognee graph; a repeat sync sends nothing', async () => {
    const r = await request(app).post(`${API}/sync`).set(H()).send({});
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: 'completed', failed: 0 });
    expect(r.body.ingested).toBeGreaterThanOrEqual(5);              // 4 transactions + 1 investigation
    await sleep(1500);
    const again = (await request(app).post(`${API}/sync`).set(H()).send({})).body;
    expect(again.ingested).toBe(0);
    const stats = (await request(app).get(`${API}/stats`).set(H())).body;
    expect(stats.memory.structured_entities.Transaction).toBeGreaterThanOrEqual(4);
    expect(stats.memory.structured_entities.Investigation).toBeGreaterThanOrEqual(1);
    expect(stats.memory.suspicious_devices).toBeGreaterThanOrEqual(1);     // shared-device-fp links two accounts
  });

  test('graph: transactions link to customer, merchant, device and pattern; shared device is flagged', async () => {
    const devs = (await request(app).get(`${API}/entities?type=Device&suspiciousOnly=true`).set(H())).body;
    expect(devs.entities.length).toBeGreaterThanOrEqual(1);
    expect(devs.entities[0].signals.accounts).toBe(2);
    const rel = (await request(app).get(`${API}/entities/${devs.entities[0].id}/related?depth=2`).set(H())).body;
    const labels = rel.nodes.map((n) => n.label);
    expect(labels.some((l) => l === 'Midnight Gift Cards')).toBe(true);
    expect(labels.filter((l) => /^acct_/.test(l)).length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(rel)).not.toMatch(/shared-device-fp|203\.0\.113\.5|@example\.com/);   // no raw identifiers in the graph
  });

  test('natural-language search returns the relevant history, cross-checked with live records', async () => {
    const r = (await request(app).post(`${API}/search`).set(H()).send({ query: 'card testing small purchases at a gift card merchant', topK: 6 })).body;
    const ids = r.evidence.items.map((i) => i.source_key);
    expect(ids.some((k) => k === `transaction:${t1.tid}` || k === `transaction:${t2.tid}` || k.startsWith('investigation:'))).toBe(true);
    expect(ids.slice(0, 3)).not.toContain(`transaction:${t3.tid}`);        // the bakery is not the top match
    expect(r.evidence.items[0].live.exists).toBe(true);
    expect(r.answer).toBeNull();
  });

  test('a changed verdict is re-synced as an UPDATE (no duplicate entity)', async () => {
    await db.run("UPDATE alerts SET verdict = 'false_positive', status = 'resolved', resolved = 1 WHERE id = ?", [t2.aid]);
    const before = (await request(app).get(`${API}/stats`).set(H())).body.memory.structured_entities.Transaction;
    const r = (await request(app).post(`${API}/sync`).set(H()).send({})).body;
    expect(r.ingested).toBe(1);
    await sleep(1500);
    const after = (await request(app).get(`${API}/stats`).set(H())).body.memory.structured_entities.Transaction;
    expect(after).toBe(before);
  });

  test('assistant returns subject / evidence / ai as separate, labelled layers', async () => {
    const r = (await request(app).post(`${API}/assistant`).set(H()).send({ kind: 'transaction', id: t4.tid })).body;
    expect(r.subject.label).toMatch(/FraudGuard record facts/);
    expect(r.evidence.label).toMatch(/not generated/);
    expect(r.evidence.items.every((i) => i.source_key !== `transaction:${t4.tid}`)).toBe(true);
    expect(r.evidence.items.length).toBeGreaterThan(0);
    expect(['ok', 'llm_not_configured', 'generation_failed']).toContain(r.ai_status);
    if (r.ai) expect(r.ai.label).toMatch(/AI-generated/);
  });
});
