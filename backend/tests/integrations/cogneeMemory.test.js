process.env.COGNEE_SERVICE_URL = 'http://cognee.test';
process.env.COGNEE_SERVICE_API_KEY = 'test-service-key-0123456789abcdef0123456789';
process.env.COGNEE_PSEUDONYM_SECRET = 'pseudonym-secret-for-tests-only-1234';
process.env.COGNEE_RETRY_BASE_MS = '0';
process.env.COGNEE_MAX_RETRIES = '2';
process.env.COGNEE_SYNC_INTERVAL_MS = '0';
process.env.COGNEE_SYNC_BATCH_SIZE = '2';

const request = require('supertest');
const app = require('../../app');
const db = require('../../config/database');
const { initSchema } = require('../../config/schema');
const { installFakeCognee } = require('../helpers/cogneeFake');
const sync = require('../../services/cognee/syncService');

const API = '/api/v1/cognee-memory';
const A = (t) => ({ Authorization: `Bearer ${t}` });
const nowIso = () => new Date().toISOString();
let admin; let userTok; let uid1; let uid2; let fake;
const CANARY = { ip: '203.0.113.77', fp: 'ua-fingerprint-canary-9f8e7d', email: 'canary.customer@example.com', card: '4111 1111 1111 1111' };

async function mkTxn(userId, { merchant = 'Acme Electronics', amount = 120, score = 40, risk = 'medium', fp = CANARY.fp, alert = false, verdict = null } = {}) {
  const { lastInsertRowid } = await db.insert(
    `INSERT INTO transactions (user_id, amount, merchant, category, location, card_type, device_fingerprint, ip_address, is_fraud, fraud_score, risk_level, fraud_reasons, status, created_at, is_synthetic)
     VALUES (?, ?, ?, 'electronics', 'Lagos', 'credit', ?, ?, ?, ?, ?, ?, 'completed', ?, 0)`,
    [userId, amount, merchant, fp, CANARY.ip, risk === 'high' ? 1 : 0, score, risk, JSON.stringify(['Unusual amount: 950 vs median 40']), nowIso()]);
  const tid = Number(lastInsertRowid);
  let aid = null;
  if (alert) aid = Number((await db.insert(
    "INSERT INTO alerts (transaction_id, user_id, message, risk_level, severity, status, verdict, created_at, resolved) VALUES (?, ?, 'x', ?, 'high', 'open', ?, ?, 0)",
    [tid, userId, risk, verdict, nowIso()])).lastInsertRowid);
  return { tid, aid };
}

beforeAll(async () => {
  await initSchema();
  const login = async (u, p) => (await request(app).post('/api/v1/auth/login').send({ username: u, password: p })).body.accessToken;
  admin = await login('admin', 'admin123');
  for (const n of ['cog_one', 'cog_two']) await request(app).post('/api/v1/auth/register').send({ username: n, email: n === 'cog_one' ? CANARY.email : `${n}@example.com`, password: 'Str0ng!Passw0rd1' });
  userTok = await login('cog_one', 'Str0ng!Passw0rd1');
  uid1 = (await db.get("SELECT id FROM users WHERE username='cog_one'")).id;
  uid2 = (await db.get("SELECT id FROM users WHERE username='cog_two'")).id;
});
beforeEach(() => { fake = installFakeCognee(); });
afterEach(() => { fake.restore(); });

const sendAll = () => fake.state.ingestCalls.flatMap((c) => [...c.transactions, ...c.investigations]);

describe('access control', () => {
  const routes = [['get', '/health'], ['get', '/status'], ['get', '/stats'], ['post', '/sync'], ['get', '/sync/runs'], ['post', '/search'], ['get', '/entities'], ['get', '/entities/abcdefgh-1/related'], ['post', '/assistant']];
  test.each(routes)('%s %s requires authentication', async (method, path) => {
    expect((await request(app)[method](`${API}${path}`)).status).toBe(401);
  });
  test.each(routes)('%s %s is forbidden to non-admin users', async (method, path) => {
    expect((await request(app)[method](`${API}${path}`).set(A(userTok)).send({})).status).toBe(403);
  });
  test('no response ever contains the service key', async () => {
    const texts = [];
    for (const p of ['/health', '/status', '/stats']) texts.push((await request(app).get(`${API}${p}`).set(A(admin))).text);
    texts.push((await request(app).post(`${API}/sync`).set(A(admin)).send({})).text);
    for (const t of texts) expect(t).not.toContain(process.env.COGNEE_SERVICE_API_KEY);
  });
});

describe('synchronisation', () => {
  let t1; let t2; let t3;
  test('first sync sends minimised, pseudonymised records and authenticates with the service key', async () => {
    t1 = await mkTxn(uid1, { merchant: 'Lagos Crypto Exchange', score: 91, risk: 'high', alert: true });
    t2 = await mkTxn(uid2, { merchant: 'Lagos Crypto Exchange', score: 88, risk: 'high' });
    await db.insert("INSERT INTO alert_comments (alert_id, author_id, author_username, body, created_at) VALUES (?, 1, 'admin', ?, ?)",
      [t1.aid, `Called ${CANARY.email} on +1 415 555 0100, card ${CANARY.card} used from ${CANARY.ip}`, nowIso()]);
    const r = await request(app).post(`${API}/sync`).set(A(admin)).send({});
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: 'completed', failed: 0 });
    expect(r.body.ingested).toBeGreaterThanOrEqual(2);

    const sent = sendAll();
    const rec = sent.find((x) => x.source_id === String(t1.tid));
    expect(rec.customer_ref).toMatch(/^acct_[a-f0-9]{24}$/);
    expect(rec.device_ref).toMatch(/^dev_[a-f0-9]{24}$/);
    expect(rec.customer_ref).not.toBe(`acct_${uid1}`);          // not the raw user id
    expect(rec.content_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(fake.state.headers[0]['X-Cognee-Service-Key']).toBe(process.env.COGNEE_SERVICE_API_KEY);

    const wire = JSON.stringify(fake.state.ingestCalls);
    for (const leak of [CANARY.ip, CANARY.fp, CANARY.email, '4111', '415 555', 'card_type', 'ip_address', 'device_fingerprint', 'password', 'canary.customer']) {
      expect(wire).not.toContain(leak);
    }
    expect(wire).toContain('[redacted');                       // the analyst note survived, redacted
    expect(rec.analyst_notes.join(' ')).toContain('Called');
  });

  test('the same account/device always get the same reference; different ones differ', async () => {
    const projector = require('../../services/cognee/projector');
    const recs = await projector.projectTransactions([t1.tid, t2.tid]);
    const again = await projector.projectTransactions([t1.tid, t2.tid]);
    const a = recs.get(t1.tid); const b = recs.get(t2.tid);
    expect(a.device_ref).toBe(b.device_ref);                    // same fingerprint -> same pseudonymous device
    expect(a.customer_ref).not.toBe(b.customer_ref);            // different customers
    expect(a.content_hash).toBe(again.get(t1.tid).content_hash); // projection + hash are deterministic
    t3 = await mkTxn(uid1, { merchant: 'Other Shop' });
  });

  test('a second sync with nothing changed ingests nothing (duplicate prevention)', async () => {
    const before = await db.get("SELECT COUNT(*) AS n FROM cognee_sync_records WHERE status = 'synced'");
    fake.state.ingestCalls.length = 0;
    const r = await request(app).post(`${API}/sync`).set(A(admin)).send({});
    expect(r.body.ingested).toBeGreaterThanOrEqual(1);          // t3 is new
    expect(sendAll().map((x) => x.source_id)).toEqual([String(t3.tid)]);   // ONLY the new one
    fake.state.ingestCalls.length = 0;
    const again = await request(app).post(`${API}/sync`).set(A(admin)).send({});
    expect(again.body).toMatchObject({ ingested: 0, failed: 0 });
    expect(again.body.skippedUnchanged).toBeGreaterThanOrEqual(1);   // alert-bearing records are re-checked by hash and skipped
    expect(fake.state.ingestCalls).toHaveLength(0);              // nothing was sent at all
    const after = await db.get("SELECT COUNT(*) AS n FROM cognee_sync_records WHERE status = 'synced'");
    expect(Number(after.n)).toBeGreaterThan(Number(before.n) - 1);
  });

  test('an analyst verdict change is detected and ONLY that record is re-sent', async () => {
    await db.run("UPDATE alerts SET verdict = 'confirmed_fraud', status = 'resolved', resolution_note = 'Customer confirmed theft', resolved = 1 WHERE id = ?", [t1.aid]);
    fake.state.ingestCalls.length = 0;
    const r = await request(app).post(`${API}/sync`).set(A(admin)).send({});
    expect(r.body.ingested).toBe(1);
    const only = sendAll();
    expect(only).toHaveLength(1);
    expect(only[0]).toMatchObject({ source_id: String(t1.tid), verdict: 'confirmed_fraud', alert_status: 'resolved' });
    expect(only[0].analyst_notes.join(' ')).toContain('Customer confirmed theft');
  });

  test('force re-sends unchanged records; full mode still skips unchanged ones', async () => {
    fake.state.ingestCalls.length = 0;
    const full = await request(app).post(`${API}/sync`).set(A(admin)).send({ mode: 'full' });
    expect(full.body.ingested).toBe(0);
    const forced = await request(app).post(`${API}/sync`).set(A(admin)).send({ mode: 'full', force: true });
    expect(forced.body.ingested).toBeGreaterThanOrEqual(3);
  });

  test('investigations sync with their member transactions and later outcome changes are picked up', async () => {
    const inv = await db.insert("INSERT INTO investigations (title, summary, status, priority, created_at, updated_at, version) VALUES (?, ?, 'open', 'high', ?, ?, 1)",
      ['Crypto exchange ring', 'Two accounts on one device', nowIso(), nowIso()]);
    const iid = Number(inv.lastInsertRowid);
    for (const t of [t1.tid, t2.tid]) await db.insert("INSERT INTO investigation_items (investigation_id, item_type, item_id, added_at) VALUES (?, 'transaction', ?, ?)", [iid, t, nowIso()]);
    await db.insert("INSERT INTO investigation_events (investigation_id, kind, actor_username, summary, created_at) VALUES (?, 'comment', 'admin', ?, ?)", [iid, `Spoke to ${CANARY.email}`, nowIso()]);
    fake.state.ingestCalls.length = 0;
    await request(app).post(`${API}/sync`).set(A(admin)).send({});
    const invRec = sendAll().find((x) => x.source_type === 'investigation');
    expect(invRec.transaction_ids.sort()).toEqual([String(t1.tid), String(t2.tid)].sort());
    expect(invRec.customer_refs).toHaveLength(2);
    expect(JSON.stringify(invRec)).not.toContain(CANARY.email);
    // transactions were re-sent too because they now belong to an investigation (investigation_id changed)
    expect(sendAll().filter((x) => x.source_type === 'transaction').every((x) => x.investigation_id === String(iid))).toBe(true);

    await db.run("UPDATE investigations SET status='closed', outcome='confirmed_fraud', outcome_note='Blocked both accounts', updated_at=? WHERE id=?", [nowIso(), iid]);
    fake.state.ingestCalls.length = 0;
    await request(app).post(`${API}/sync`).set(A(admin)).send({});
    expect(sendAll()).toHaveLength(1);
    expect(sendAll()[0]).toMatchObject({ source_type: 'investigation', outcome: 'confirmed_fraud', outcome_note: 'Blocked both accounts' });
  });

  test('transient service errors are retried and the run still succeeds', async () => {
    const t = await mkTxn(uid2, { merchant: 'Retry Shop' });
    fake.restore(); fake = installFakeCognee({ failIngest: 2 });         // 2 failures, then success (maxRetries = 2)
    const r = await request(app).post(`${API}/sync`).set(A(admin)).send({});
    expect(r.status).toBe(200);
    expect(r.body.failed).toBe(0);
    expect(fake.state.ingestCalls.length).toBe(3);
    expect(sendAll().some((x) => x.source_id === String(t.tid))).toBe(true);
  });

  test('a record that fails is marked failed, others still sync, and the failure is retried next run', async () => {
    const good = await mkTxn(uid1, { merchant: 'Good Shop' });
    const bad = await mkTxn(uid1, { merchant: 'Bad Shop' });
    fake.restore(); fake = installFakeCognee({ failKeys: [`transaction:${bad.tid}`] });
    const r = await request(app).post(`${API}/sync`).set(A(admin)).send({});
    expect(r.body).toMatchObject({ status: 'completed_with_errors', failed: 1 });
    const row = await db.get("SELECT status, attempts, last_error FROM cognee_sync_records WHERE source_type='transaction' AND source_id = ?", [String(bad.tid)]);
    expect(row).toMatchObject({ status: 'failed' }); expect(row.last_error).toContain('simulated');
    expect((await db.get("SELECT status FROM cognee_sync_records WHERE source_id = ? AND source_type='transaction'", [String(good.tid)])).status).toBe('synced');
    fake.restore(); fake = installFakeCognee();                           // service healthy again
    const retry = await request(app).post(`${API}/sync`).set(A(admin)).send({});
    expect(retry.body.ingested).toBe(1);
    expect(sendAll().map((x) => x.source_id)).toEqual([String(bad.tid)]);
  });

  test('an unreachable service fails the run cleanly and does NOT skip records on the next run', async () => {
    const t = await mkTxn(uid2, { merchant: 'Outage Shop' });
    fake.restore(); fake = installFakeCognee({ unreachable: true });
    const down = await request(app).post(`${API}/sync`).set(A(admin)).send({});
    expect(down.status).toBe(502);
    expect(down.body.error || down.body.message).toBeTruthy();
    const run = (await request(app).get(`${API}/sync/runs`).set(A(admin))).body.runs[0];
    expect(run.status).toBe('failed');
    fake.restore(); fake = installFakeCognee();
    const up = await request(app).post(`${API}/sync`).set(A(admin)).send({});
    expect(sendAll().some((x) => x.source_id === String(t.tid))).toBe(true);   // not lost
    expect(up.body.status).toBe('completed');
  });

  test('two simultaneous runs: exactly one executes, the other is rejected as busy (HTTP 409)', async () => {
    await mkTxn(uid1, { merchant: 'Concurrent Shop' });
    fake.restore(); fake = installFakeCognee({ delayMs: 200 });
    const first = request(app).post(`${API}/sync`).set(A(admin)).send({}).then((r) => r);
    await new Promise((r) => setTimeout(r, 60));
    const second = await request(app).post(`${API}/sync`).set(A(admin)).send({});
    expect(second.status).toBe(409);
    expect(second.body.details?.code || second.body.error?.details?.code || JSON.stringify(second.body)).toMatch(/sync_busy/);
    expect((await first).status).toBe(200);
  });

  test('the in-process lock is atomic: racing runSync calls cannot both start', async () => {
    await mkTxn(uid2, { merchant: 'Race Shop' });
    fake.restore(); fake = installFakeCognee({ delayMs: 50 });
    const results = await Promise.allSettled([sync.runSync({}), sync.runSync({}), sync.runSync({})]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected').every((r) => r.reason instanceof sync.SyncBusyError)).toBe(true);
  });

  test('run history and stats expose ingestion activity and counts', async () => {
    const runs = (await request(app).get(`${API}/sync/runs?limit=5`).set(A(admin))).body.runs;
    expect(runs.length).toBeGreaterThan(3);
    expect(runs.find((r) => r.actor === 'admin')).toEqual(expect.objectContaining({ trigger: 'manual', actor: 'admin', status: expect.any(String) }));
    const stats = (await request(app).get(`${API}/stats`).set(A(admin))).body;
    expect(stats.sync.records.transaction.synced).toBeGreaterThan(3);
    expect(stats.sync.lastSuccessfulSyncAt).toBeTruthy();
    expect(stats.memory.dataset).toBe('fraudguard-test');
  });

  test('invalid sync options are rejected', async () => {
    expect((await request(app).post(`${API}/sync`).set(A(admin)).send({ mode: 'everything' })).status).toBe(400);
    expect((await request(app).post(`${API}/sync`).set(A(admin)).send({ surprise: true })).status).toBe(400);
  });
});

describe('search, entities and assistant', () => {
  test('search forwards a validated query and cross-checks results against live records', async () => {
    const t = await mkTxn(uid1, { merchant: 'Zebra Gift Cards', alert: true });
    await request(app).post(`${API}/sync`).set(A(admin)).send({});
    await db.run("UPDATE alerts SET verdict = 'confirmed_fraud' WHERE id = ?", [t.aid]);          // live changed, memory not yet synced
    const r = await request(app).post(`${API}/search`).set(A(admin)).send({ query: 'Zebra gift cards', topK: 5 });
    expect(r.status).toBe(200);
    expect(r.body.evidence.label).toMatch(/not generated/);
    const item = r.body.evidence.items.find((i) => i.source_id === String(t.tid));
    expect(item.live).toMatchObject({ exists: true, url: `/transactions/${t.tid}`, verdict: 'confirmed_fraud', memoryOutOfDate: true });
    expect(r.body.answer).toBeNull();
    const withAnswer = await request(app).post(`${API}/search`).set(A(admin)).send({ query: 'Zebra gift cards', includeAnswer: true });
    expect(withAnswer.body.answer.label).toMatch(/AI-generated/);
  });

  test('search validates input', async () => {
    for (const body of [{}, { query: 'x' }, { query: 'a'.repeat(1001) }, { query: 'ok query', topK: 99 }, { query: 'ok query', sourceTypes: ['customer'] }]) {
      expect((await request(app).post(`${API}/search`).set(A(admin)).send(body)).status).toBe(400);
    }
  });

  test('query text is never written to the audit log', async () => {
    const secretQuery = 'unique-secret-phrase-about-merchant-xyz';
    await request(app).post(`${API}/search`).set(A(admin)).send({ query: secretQuery });
    await new Promise((r) => setTimeout(r, 50));
    const rows = await db.all("SELECT details FROM audit_logs WHERE action = 'cognee_memory.search'");
    expect(rows.length).toBeGreaterThan(0);
    expect(JSON.stringify(rows)).not.toContain(secretQuery);
  });

  test('entities and related-entity endpoints validate and proxy', async () => {
    expect((await request(app).get(`${API}/entities?type=Customer&limit=5`).set(A(admin))).status).toBe(200);
    expect((await request(app).get(`${API}/entities?type=Bogus`).set(A(admin))).status).toBe(400);
    expect((await request(app).get(`${API}/entities/some-entity-id/related?depth=3`).set(A(admin))).status).toBe(400);
    expect((await request(app).get(`${API}/entities/some-entity-id/related?depth=2`).set(A(admin))).status).toBe(200);
    expect((await request(app).get(`${API}/entities/missing-entity/related`).set(A(admin))).status).toBe(404);
    expect((await request(app).get(`${API}/entities/..%2F..%2Fetc/related`).set(A(admin))).status).toBe(400);
  });

  test('assistant builds the subject from the database without raw identifiers and returns layered output', async () => {
    const t = await mkTxn(uid1, { merchant: 'Assist Shop', score: 85, risk: 'high', alert: true });
    const r = await request(app).post(`${API}/assistant`).set(A(admin)).send({ kind: 'transaction', id: t.tid, question: 'Is this part of a ring?' });
    expect(r.status).toBe(200);
    expect(r.body).toHaveProperty('subject'); expect(r.body).toHaveProperty('evidence'); expect(r.body).toHaveProperty('ai_status');
    expect(r.body.subject.label).toMatch(/FraudGuard record facts/);
    const sentSubject = fake.state.assistant[0].subject;
    expect(sentSubject.summary).toContain('Assist Shop');
    expect(sentSubject.summary).toContain('acct_');
    for (const leak of [CANARY.ip, CANARY.fp, CANARY.email]) expect(JSON.stringify(fake.state.assistant[0])).not.toContain(leak);
    expect(fake.state.assistant[0].question).toBe('Is this part of a ring?');
  });

  test('assistant 404s for unknown records and validates input', async () => {
    expect((await request(app).post(`${API}/assistant`).set(A(admin)).send({ kind: 'transaction', id: 999999 })).status).toBe(404);
    expect((await request(app).post(`${API}/assistant`).set(A(admin)).send({ kind: 'customer', id: 1 })).status).toBe(400);
    expect((await request(app).post(`${API}/assistant`).set(A(admin)).send({ kind: 'transaction', id: -4 })).status).toBe(400);
  });
});

describe('health', () => {
  test('reports healthy when the service answers', async () => {
    const h = (await request(app).get(`${API}/health`).set(A(admin))).body;
    expect(h).toMatchObject({ configured: true, reachable: true, status: 'ok' });
  });
  test('reports unreachable (200, not a crash) when the service is down', async () => {
    fake.restore(); fake = installFakeCognee({ unreachable: true });
    const r = await request(app).get(`${API}/health`).set(A(admin));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ configured: true, reachable: false, status: 'unreachable' });
  });
});

afterAll(() => sync.stopScheduler());
