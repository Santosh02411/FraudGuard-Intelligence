jest.mock('../../models/mlClient');
const request = require('supertest');
const app = require('../../app');
const db = require('../../config/database');
const { initSchema } = require('../../config/schema');
const rel = require('../../services/relationshipService');

const API = '/api/v1';
let admin; let userTok; let n = 0;
const A = (t) => ({ Authorization: `Bearer ${t}` });
const minutesAgo = (m) => new Date(Date.now() - m * 60000).toISOString();

async function mkUser(createdAt = new Date().toISOString()) {
  n += 1;
  return Number((await db.insert("INSERT INTO users (username, email, password, role, created_at) VALUES (?, ?, 'x', 'user', ?)", [`rel_u${n}`, `rel_u${n}@example.com`, createdAt])).lastInsertRowid);
}
async function mkTxn(userId, { ip, device, merchant = 'Shop', amount = 50, at = minutesAgo(5), alert, verdict } = {}) {
  const tid = Number((await db.insert(
    `INSERT INTO transactions (user_id, amount, merchant, category, location, card_type, device_fingerprint, ip_address, fraud_score, risk_level, status, created_at, is_synthetic)
     VALUES (?, ?, ?, 'food', 'NY', 'credit', ?, ?, 10, 'low', 'completed', ?, 0)`, [userId, amount, merchant, device || null, ip || null, at])).lastInsertRowid);
  if (alert || verdict) await db.insert(`INSERT INTO alerts (transaction_id, user_id, message, risk_level, severity, status, created_at, resolved, verdict) VALUES (?, ?, 'x', 'high', 'high', ?, ?, ?, ?)`, [tid, userId, verdict ? 'resolved' : 'open', at, verdict ? 1 : 0, verdict || null]);
  return tid;
}
const find = async (...users) => (await rel.clusters({ minScore: 0, limit: 100 })).clusters.find((c) => users.every((u) => c.members.some((m) => m.user_id === u)));

beforeAll(async () => {
  await initSchema();
  admin = (await request(app).post(`${API}/auth/login`).send({ username: 'admin', password: 'admin123' })).body.accessToken;
  await request(app).post(`${API}/auth/register`).send({ username: 'rel_cust', email: 'rel_cust@example.com', password: 'Str0ng!Passw0rd1' });
  userTok = (await request(app).post(`${API}/auth/login`).send({ username: 'rel_cust', password: 'Str0ng!Passw0rd1' })).body.accessToken;
});

describe('identifier hygiene', () => {
  test('private, loopback and carrier-grade addresses are never treated as identifiers', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.1.5', '172.16.0.9', '172.31.255.1', '169.254.1.1', '100.64.0.1', '::1', 'fd00::1', '::ffff:10.0.0.1', null]) expect(rel.isPrivateIp(ip)).toBe(true);
    for (const ip of ['198.51.100.7', '8.8.8.8', '172.32.0.1', '2001:db8::1']) expect(rel.isPrivateIp(ip)).toBe(false);
  });

  test('two accounts on the same loopback IP and device never cluster', async () => {
    const a = await mkUser(); const b = await mkUser();
    for (const u of [a, b]) await mkTxn(u, { ip: '127.0.0.1', device: 'dev-loop-same' });
    expect(await find(a, b)).toBeUndefined();
  });

  test('a single shared public IP is only a weak lead: no cluster, but it is visible in the graph', async () => {
    const a = await mkUser(); const b = await mkUser();
    const t = await mkTxn(a, { ip: '198.51.100.10', device: 'dev-a-1' }); await mkTxn(b, { ip: '198.51.100.10', device: 'dev-b-1' });
    expect(await find(a, b)).toBeUndefined();
    const g = await rel.graph({ transactionId: t, depth: 1 });
    expect(g.nodes.filter((x) => x.type === 'account').map((x) => x.user_id)).toEqual(expect.arrayContaining([a, b]));
    expect(g.edges.some((e) => e.type === 'weak_lead')).toBe(true);
    expect(g.edges.some((e) => e.type === 'strong_link')).toBe(false);
  });

  test('a popular IP (an office/carrier) shared by many accounts is suppressed even when a device also matches', async () => {
    const users = []; for (let i = 0; i < 9; i++) users.push(await mkUser());
    for (const u of users) await mkTxn(u, { ip: '203.0.113.99', device: 'dev-office-same' });
    expect(await find(users[0], users[1])).toBeUndefined();
    const out = await rel.clusters({});
    expect(out.suppressed_identifiers.ips).toBeGreaterThanOrEqual(1);
    expect(out.suppressed_identifiers.devices).toBeGreaterThanOrEqual(1);
    const g = await rel.graph({ userId: users[0], depth: 2 });
    const ipNode = g.nodes.find((x) => x.type === 'ip' && x.label === '203.0.113.99');
    expect(ipNode.common).toBe(true);
    expect(g.nodes.filter((x) => x.type === 'account')).toHaveLength(1); // not expanded into strangers
  });
});

describe('clusters and scoring', () => {
  test('same IP + same device links two accounts, but topology alone is capped below "high" and says why', async () => {
    const a = await mkUser(); const b = await mkUser(Date.now() - 400 * 86400000 > 0 ? new Date(Date.now() - 90 * 86400000).toISOString() : undefined);
    await mkTxn(a, { ip: '198.51.100.21', device: 'dev-pair-1' }); await mkTxn(b, { ip: '198.51.100.21', device: 'dev-pair-1' });
    const c = await find(a, b);
    expect(c).toBeDefined();
    expect(c.corroborated).toBe(false);
    expect(c.risk_score).toBeLessThanOrEqual(rel.constants.TOPOLOGY_ONLY_CAP);
    expect(c.risk_band).not.toBe('high');
    expect(c.reasons.join(' ')).toMatch(/no behavioural corroboration/);
    expect(c.caveats.join(' ')).toMatch(/not a finding of fraud/);
  });

  test('same IP + two rare merchants also links (independent evidence), one shared merchant does not', async () => {
    const a = await mkUser(); const b = await mkUser(); const c2 = await mkUser(); const d = await mkUser();
    for (const u of [a, b]) { await mkTxn(u, { ip: '198.51.100.31', merchant: 'RareShop-X1' }); await mkTxn(u, { ip: '198.51.100.31', merchant: 'RareShop-X2' }); }
    for (const u of [c2, d]) await mkTxn(u, { ip: '198.51.100.32', merchant: 'RareShop-Y1' });
    expect(await find(a, b)).toBeDefined();
    expect(await find(c2, d)).toBeUndefined();
  });

  test('analyst-confirmed fraud + a coordinated burst + open alerts push a cluster to high, with the reasons itemised', async () => {
    const a = await mkUser(); const b = await mkUser();
    await mkTxn(a, { ip: '198.51.100.41', device: 'dev-burst', verdict: 'confirmed_fraud', at: minutesAgo(600) });
    await mkTxn(b, { ip: '198.51.100.41', device: 'dev-burst', alert: true, at: minutesAgo(600) });
    for (let i = 0; i < 7; i++) await mkTxn(i % 2 ? a : b, { ip: '198.51.100.41', device: 'dev-burst', at: minutesAgo(30 - i) });
    const c = await find(a, b);
    expect(c.risk_band).toBe('high'); expect(c.corroborated).toBe(true);
    expect(c.signals.burst.txns).toBeGreaterThanOrEqual(6); expect(c.signals.burst.accounts).toBe(2);
    expect(c.reasons.join(' ')).toMatch(/confirmed fraud/); expect(c.reasons.join(' ')).toMatch(/coordinated burst/);
    expect(c.members.find((m) => m.user_id === a).confirmed_fraud).toBe(true);
    expect(c.open_alert_ids.length).toBeGreaterThan(0);
    expect(c.risk_score).toBeLessThanOrEqual(100);
    expect(c.score_components.reduce((s, x) => s + x.points, 0)).toBeGreaterThanOrEqual(c.risk_score - 2);
  });

  test('repeated small transactions (card testing) are detected per account and inside clusters', async () => {
    const a = await mkUser(); const b = await mkUser();
    await mkTxn(b, { ip: '198.51.100.51', device: 'dev-ct' }); await mkTxn(a, { ip: '198.51.100.51', device: 'dev-ct' });
    for (let i = 0; i < 6; i++) await mkTxn(a, { amount: 1.5, merchant: `Tiny${i}`, at: minutesAgo(20 - i) });
    const s = await rel.accountSignals({});
    expect(s.repeated_small.find((x) => x.user_id === a).txns).toBeGreaterThanOrEqual(5);
    expect(s.repeated_small.find((x) => x.user_id === b)).toBeUndefined();
    expect((await find(a, b)).signals.repeated_small.map((x) => x.user_id)).toContain(a);
  });

  test('three accounts created within hours of each other and linked are flagged as created together', async () => {
    const t0 = new Date(Date.now() - 3 * 3600000).toISOString();
    const us = [await mkUser(t0), await mkUser(t0), await mkUser(t0)];
    for (const u of us) await mkTxn(u, { ip: '198.51.100.61', device: 'dev-fresh' });
    const c = await find(...us);
    expect(c.signals.accounts_created_together).toBe(3);
  });

  test('burst/small-repeat detectors need real volume: 3 quick transactions are nothing', () => {
    const t = [1, 2, 3].map((i) => ({ created_at: minutesAgo(i), user_id: i % 2, amount: 2, merchant: 'x' }));
    expect(rel.detectBurst(t)).toBeNull(); expect(rel.detectSmallRepeats(t)).toEqual([]);
  });
});

describe('live scoring signal', () => {
  test('a single shared IP with a confirmed-fraud account does NOT trigger anything', async () => {
    const bad = await mkUser(); const victim = await mkUser();
    await mkTxn(bad, { ip: '198.51.100.71', device: 'dev-bad-1', verdict: 'confirmed_fraud' });
    await mkTxn(victim, { ip: '198.51.100.71', device: 'dev-victim-1' });
    const r = await rel.networkRiskForTransaction({ ip_address: '198.51.100.71', device_fingerprint: 'dev-victim-1' }, victim);
    expect(r.triggered).toBe(false); expect(r.hardOverride).toBe(false);
  });

  test('IP + device shared with a confirmed-fraud account triggers a score boost but never an automatic block by default', async () => {
    const bad = await mkUser(); const other = await mkUser();
    await mkTxn(bad, { ip: '198.51.100.72', device: 'dev-shared-72', verdict: 'confirmed_fraud' });
    await mkTxn(other, { ip: '198.51.100.72', device: 'dev-shared-72' });
    const r = await rel.networkRiskForTransaction({ ip_address: '198.51.100.72', device_fingerprint: 'dev-shared-72' }, other);
    expect(r.triggered).toBe(true); expect(r.hardOverride).toBe(false);
    expect(r.ring.confirmed_fraud_members.length).toBe(1);
  });

  test('a brand-new account that arrives on a confirmed-fraud account\'s exact IP+device is linked by this transaction itself', async () => {
    const bad = await mkUser(); const fresh = await mkUser();
    await mkTxn(bad, { ip: '198.51.100.73', device: 'dev-73', verdict: 'confirmed_fraud' });
    const r = await rel.networkRiskForTransaction({ ip_address: '198.51.100.73', device_fingerprint: 'dev-73' }, fresh);
    expect(r.triggered).toBe(true);
    const onlyIp = await rel.networkRiskForTransaction({ ip_address: '198.51.100.73', device_fingerprint: 'unseen-dev' }, fresh);
    expect(onlyIp.triggered).toBe(false);
  });

  test('loopback / private traffic never triggers regardless of how many accounts share it', async () => {
    const r = await rel.networkRiskForTransaction({ ip_address: '127.0.0.1', device_fingerprint: 'dev-loop-same' }, 1);
    expect(r.triggered).toBe(false);
  });

  test('the strict override is opt-in (config)', async () => {
    const config = require('../../config/env');
    const bad = await mkUser(); const other = await mkUser();
    await mkTxn(bad, { ip: '198.51.100.74', device: 'dev-74', verdict: 'confirmed_fraud' }); await mkTxn(other, { ip: '198.51.100.74', device: 'dev-74' });
    config.relationships.hardOverride = true;
    try { expect((await rel.networkRiskForTransaction({ ip_address: '198.51.100.74', device_fingerprint: 'dev-74' }, other)).hardOverride).toBe(true); } finally { config.relationships.hardOverride = false; }
  });
});

describe('graph expansion', () => {
  test('expands from a flagged transaction to related accounts at depth 1 and 2 with node caps', async () => {
    const a = await mkUser(); const b = await mkUser(); const c = await mkUser();
    const t = await mkTxn(a, { ip: '198.51.100.81', device: 'dev-81a' });
    await mkTxn(b, { ip: '198.51.100.81', device: 'dev-81b' });     // b shares IP with a
    await mkTxn(b, { ip: '198.51.100.82', device: 'dev-81b' }); await mkTxn(c, { ip: '198.51.100.82', device: 'dev-82c' }); // c shares IP2 with b only
    const d1 = await rel.graph({ transactionId: t, depth: 1 });
    const accts1 = d1.nodes.filter((x) => x.type === 'account').map((x) => x.user_id);
    expect(accts1).toEqual(expect.arrayContaining([a, b])); expect(accts1).not.toContain(c);
    expect(d1.nodes.find((x) => x.type === 'transaction' && x.seed)).toBeTruthy();
    const d2 = await rel.graph({ transactionId: t, depth: 2 });
    expect(d2.nodes.filter((x) => x.type === 'account').map((x) => x.user_id)).toContain(c);
    const capped = await rel.graph({ transactionId: t, depth: 2, maxNodes: 4 });
    expect(capped.truncated).toBe(true); expect(capped.nodes.length).toBeLessThanOrEqual(4);
    expect(await rel.graph({ transactionId: 99999999 })).toBeNull();
  });
});

describe('API', () => {
  test('admin only', async () => {
    for (const p of ['/relationships/clusters', '/relationships/signals', '/relationships/graph?userId=1']) {
      expect((await request(app).get(`${API}${p}`)).status).toBe(401);
      expect((await request(app).get(`${API}${p}`).set(A(userTok))).status).toBe(403);
    }
  });
  test('validation and lookups', async () => {
    expect((await request(app).get(`${API}/relationships/graph`).set(A(admin))).status).toBe(400);
    expect((await request(app).get(`${API}/relationships/graph?userId=1&transactionId=1`).set(A(admin))).status).toBe(400);
    expect((await request(app).get(`${API}/relationships/graph?userId=1&depth=5`).set(A(admin))).status).toBe(400);
    expect((await request(app).get(`${API}/relationships/graph?userId=99999999`).set(A(admin))).status).toBe(404);
    expect((await request(app).get(`${API}/relationships/clusters/abc`).set(A(admin))).status).toBe(400);
    expect((await request(app).get(`${API}/relationships/clusters/c99999999`).set(A(admin))).status).toBe(404);
    expect((await request(app).get(`${API}/relationships/clusters?minScore=500`).set(A(admin))).status).toBe(400);
  });
  test('cluster list and detail round-trip; graph views are audited', async () => {
    const list = await request(app).get(`${API}/relationships/clusters?limit=100`).set(A(admin));
    expect(list.status).toBe(200); expect(list.body.clusters.length).toBeGreaterThan(0);
    const top = list.body.clusters[0];
    for (let i = 1; i < list.body.clusters.length; i++) expect(list.body.clusters[i - 1].risk_score).toBeGreaterThanOrEqual(list.body.clusters[i].risk_score);
    const one = await request(app).get(`${API}/relationships/clusters/${top.cluster_id}`).set(A(admin));
    expect(one.status).toBe(200); expect(one.body.cluster_id).toBe(top.cluster_id);
    const g = await request(app).get(`${API}/relationships/graph?userId=${top.members[0].user_id}`).set(A(admin));
    expect(g.status).toBe(200); expect(g.body.cautions.length).toBeGreaterThan(0);
    for (let i = 0; i < 20 && !(await db.get("SELECT id FROM audit_logs WHERE action = 'relationships.graph_view'")); i++) await new Promise((r) => setTimeout(r, 50));
    expect(await db.get("SELECT id FROM audit_logs WHERE action = 'relationships.graph_view'")).toBeTruthy();
  });
  test('a cluster\'s open alerts can seed a case', async () => {
    const list = (await request(app).get(`${API}/relationships/clusters?limit=100`).set(A(admin))).body.clusters.find((c) => c.open_alert_ids.length > 0);
    expect(list).toBeDefined();
    const r = await request(app).post(`${API}/investigations`).set(A(admin)).send({ title: 'From cluster', alertIds: list.open_alert_ids.slice(0, 3) });
    expect(r.status).toBe(201);
  });
});

describe('caching', () => {
  test('with a TTL, concurrent callers share one build and data changes show up after invalidation', async () => {
    const config = require('../../config/env');
    config.relationships.cacheTtlMs = 60000; rel.invalidate();
    try {
      const spy = jest.spyOn(db, 'all');
      const [a, b, c] = await Promise.all([rel.buildIndex({}), rel.buildIndex({}), rel.buildIndex({})]);
      expect(a).toBe(b); expect(b).toBe(c);
      const loads = spy.mock.calls.filter(([sql]) => /FROM transactions t WHERE .*GROUP BY t.user_id, t.device_fingerprint/s.test(sql)).length;
      expect(loads).toBe(1);
      spy.mockRestore();
      expect(await rel.buildIndex({})).toBe(a);          // cached
      rel.invalidate();
      expect(await rel.buildIndex({})).not.toBe(a);       // rebuilt
    } finally { config.relationships.cacheTtlMs = 0; rel.invalidate(); }
  });
});
