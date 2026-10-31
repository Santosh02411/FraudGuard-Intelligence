jest.mock('../../models/mlClient');
const request = require('supertest');
const app = require('../../app');
const db = require('../../config/database');
const { initSchema } = require('../../config/schema');

const API = '/api/v1';
let admin; let admin2; let admin2Id; let userTok; let u1; let u2; let seq = 0;
const A = (t) => ({ Authorization: `Bearer ${t}` });

async function mkTxn(userId, { device = 'devA', ip = '10.0.0.1', amount = 100, alert = true, severity = 'high' } = {}) {
  seq += 1;
  const { lastInsertRowid: tid } = await db.insert(
    `INSERT INTO transactions (user_id, amount, merchant, category, location, card_type, device_fingerprint, ip_address, fraud_score, risk_level, status, created_at, is_synthetic)
     VALUES (?, ?, ?, 'food', 'NY', 'credit', ?, ?, 80, 'high', 'completed', ?, 0)`, [userId, amount, `M${seq}`, device, ip, new Date().toISOString()]);
  let aid = null;
  if (alert) aid = Number((await db.insert(`INSERT INTO alerts (transaction_id, user_id, message, risk_level, severity, status, created_at, resolved) VALUES (?, ?, 'x', 'high', ?, 'open', ?, 0)`, [tid, userId, severity, new Date().toISOString()])).lastInsertRowid);
  return { tid: Number(tid), aid };
}
const mkCase = (body, tok = admin) => request(app).post(`${API}/investigations`).set(A(tok)).send({ title: 'Ring around devA', ...body });

beforeAll(async () => {
  await initSchema();
  const login = async (u, p) => (await request(app).post(`${API}/auth/login`).send({ username: u, password: p })).body.accessToken;
  admin = await login('admin', 'admin123');
  const hash = (await db.get("SELECT password FROM users WHERE username='admin'")).password;
  admin2Id = Number((await db.insert("INSERT INTO users (username, email, password, role, email_verified) VALUES ('inv2', 'inv2@example.com', ?, 'admin', 1)", [hash])).lastInsertRowid);
  admin2 = await login('inv2', 'admin123');
  for (const n of ['cust_one', 'cust_two']) await request(app).post(`${API}/auth/register`).send({ username: n, email: `${n}@example.com`, password: 'Str0ng!Passw0rd1' });
  userTok = await login('cust_one', 'Str0ng!Passw0rd1');
  u1 = (await db.get("SELECT id FROM users WHERE username='cust_one'")).id; u2 = (await db.get("SELECT id FROM users WHERE username='cust_two'")).id;
});

test('admin only', async () => {
  expect((await request(app).get(`${API}/investigations`)).status).toBe(401);
  expect((await request(app).get(`${API}/investigations`).set(A(userTok))).status).toBe(403);
  expect((await request(app).post(`${API}/investigations`).set(A(userTok)).send({ title: 'abc', alertIds: [1] })).status).toBe(403);
});

describe('creation and membership', () => {
  test('groups alerts and their transactions; priority derives from the worst alert; timeline records creation', async () => {
    const a = await mkTxn(u1, { severity: 'medium' }); const b = await mkTxn(u2, { severity: 'critical', amount: 250 });
    const r = await mkCase({ alertIds: [a.aid, b.aid] });
    expect(r.status).toBe(201);
    expect(r.body.investigation.priority).toBe('critical');
    expect(r.body.alerts.map((x) => x.id).sort()).toEqual([a.aid, b.aid].sort());
    expect(r.body.transactions).toHaveLength(2);           // transactions travel with their alerts
    expect(r.body.summary.exposure_amount).toBe(350);
    expect(r.body.summary.accounts).toBe(2);
    const tl = (await request(app).get(`${API}/investigations/${r.body.investigation.id}/timeline`).set(A(admin))).body.timeline;
    expect(tl[0].kind === 'created' || tl.some((e) => e.kind === 'created')).toBe(true);
  });

  test('a transaction with no alert (e.g. a missed fraud reported by the customer) can anchor a case', async () => {
    const t = await mkTxn(u1, { alert: false });
    const r = await mkCase({ transactionIds: [t.tid] });
    expect(r.status).toBe(201);
    expect(r.body.alerts).toHaveLength(0); expect(r.body.investigation.priority).toBe('medium');
  });

  test('a transaction that has an alert brings the alert with it', async () => {
    const t = await mkTxn(u1);
    const r = await mkCase({ transactionIds: [t.tid] });
    expect(r.body.alerts.map((x) => x.id)).toEqual([t.aid]);
  });

  test('an alert can belong to only one case: second case gets 409 naming the first', async () => {
    const t = await mkTxn(u1);
    const first = await mkCase({ alertIds: [t.aid] });
    const second = await mkCase({ alertIds: [t.aid] });
    expect(second.status).toBe(409);
    expect(second.body.error?.details?.code || second.body.details?.code || JSON.stringify(second.body)).toMatch(/ITEM_IN_OTHER_CASE/);
    expect(JSON.stringify(second.body)).toContain(String(first.body.investigation.id));
    // and the failed attempt left nothing behind (atomic create)
    expect(Number((await db.get("SELECT COUNT(*) n FROM investigations WHERE title = 'Ring around devA'")).n)).toBeGreaterThanOrEqual(1);
    expect(await db.get('SELECT id FROM investigation_items WHERE item_id = ? AND item_type = ? AND investigation_id != ?', [t.aid, 'alert', first.body.investigation.id])).toBeFalsy();
  });

  test('racing to claim the same alert: exactly one case wins, no orphan case rows', async () => {
    const t = await mkTxn(u1);
    const before = Number((await db.get('SELECT COUNT(*) n FROM investigations')).n);
    const rs = await Promise.all([mkCase({ alertIds: [t.aid], title: 'Race A' }), mkCase({ alertIds: [t.aid], title: 'Race B', }, admin2)]);
    expect(rs.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(Number((await db.get('SELECT COUNT(*) n FROM investigations')).n) - before).toBe(1);
  });

  test('validation: empty case, unknown alert, bad title', async () => {
    expect((await mkCase({})).status).toBe(400);
    expect((await mkCase({ alertIds: [999999] })).status).toBe(404);
    expect((await request(app).post(`${API}/investigations`).set(A(admin)).send({ title: 'x', alertIds: [1] })).status).toBe(400);
  });

  test('add and remove items; removing an alert removes its transaction; paired transaction cannot be removed alone', async () => {
    const a = await mkTxn(u1); const b = await mkTxn(u1);
    const c = (await mkCase({ alertIds: [a.aid] })).body.investigation;
    const add = await request(app).post(`${API}/investigations/${c.id}/items`).set(A(admin)).send({ alertIds: [b.aid] });
    expect(add.status).toBe(200); expect(add.body.added).toBe(2); expect(add.body.alerts).toHaveLength(2);
    const again = await request(app).post(`${API}/investigations/${c.id}/items`).set(A(admin)).send({ alertIds: [b.aid] });
    expect(again.body.added).toBe(0); // idempotent
    expect((await request(app).delete(`${API}/investigations/${c.id}/items/transaction/${b.tid}`).set(A(admin))).status).toBe(409);
    const rm = await request(app).delete(`${API}/investigations/${c.id}/items/alert/${b.aid}`).set(A(admin));
    expect(rm.status).toBe(200); expect(rm.body.transactions.map((t) => t.id)).not.toContain(b.tid);
    // freed alert can now go to another case
    expect((await mkCase({ alertIds: [b.aid] })).status).toBe(201);
  });
});

describe('workflow', () => {
  let c; let a;
  beforeAll(async () => { a = await mkTxn(u1); c = (await mkCase({ alertIds: [a.aid] })).body.investigation; });

  test('assignment: only an investigator can own a case; assigning moves open -> investigating', async () => {
    expect((await request(app).patch(`${API}/investigations/${c.id}/assign`).set(A(admin)).send({ assigneeId: u1 })).status).toBe(400); // customer
    const r = await request(app).patch(`${API}/investigations/${c.id}/assign`).set(A(admin)).send({ assigneeId: admin2Id });
    expect(r.status).toBe(200);
    expect(r.body.investigation.assignee_username).toBe('inv2'); expect(r.body.investigation.status).toBe('investigating');
  });

  test('status transitions are validated; stale versions get 409', async () => {
    const cur = (await request(app).get(`${API}/investigations/${c.id}`).set(A(admin))).body.investigation;
    const ok = await request(app).patch(`${API}/investigations/${c.id}/status`).set(A(admin)).send({ status: 'pending_info', version: cur.version });
    expect(ok.status).toBe(200);
    const stale = await request(app).patch(`${API}/investigations/${c.id}/status`).set(A(admin)).send({ status: 'investigating', version: cur.version });
    expect(stale.status).toBe(409);
    expect(JSON.stringify(stale.body)).toMatch(/VERSION_CONFLICT/);
    // the stale write changed nothing
    expect((await request(app).get(`${API}/investigations/${c.id}`).set(A(admin))).body.investigation.status).toBe('pending_info');
    expect((await request(app).patch(`${API}/investigations/${c.id}/status`).set(A(admin)).send({ status: 'closed' })).status).toBe(400); // zod: close has its own route
  });

  test('comments, evidence and disputes appear on one chronological timeline', async () => {
    await request(app).post(`${API}/investigations/${c.id}/comments`).set(A(admin)).send({ body: 'Called the customer, voicemail.' });
    await request(app).post(`${API}/alerts/${a.aid}/comments`).set(A(admin)).send({ body: 'Same device seen on two accounts' });
    await request(app).post(`${API}/alerts/${a.aid}/evidence?filename=note.txt`).set(A(admin)).set('Content-Type', 'application/octet-stream').send(Buffer.from('chat transcript'));
    await db.insert("INSERT INTO disputes (transaction_id, amount_disputed, reason, opened_at) VALUES (?, 100, 'not me', ?)", [a.tid, new Date().toISOString()]);
    const tl = (await request(app).get(`${API}/investigations/${c.id}/timeline`).set(A(admin))).body.timeline;
    const kinds = tl.map((e) => e.kind);
    expect(kinds).toEqual(expect.arrayContaining(['created', 'assigned', 'status', 'comment', 'alert_comment', 'evidence', 'dispute_opened', 'transaction']));
    for (let i = 1; i < tl.length; i++) expect(new Date(tl[i].at) >= new Date(tl[i - 1].at)).toBe(true);
    const detail = (await request(app).get(`${API}/investigations/${c.id}`).set(A(admin))).body;
    expect(detail.links.disputes).toHaveLength(1);
  });

  test('closing needs an outcome and an explanation; closed cases are frozen; reopening needs a reason and is recorded', async () => {
    expect((await request(app).post(`${API}/investigations/${c.id}/close`).set(A(admin)).send({ outcome: 'confirmed_fraud', note: 'short' })).status).toBe(400);
    expect((await request(app).post(`${API}/investigations/${c.id}/close`).set(A(admin)).send({ outcome: 'bogus', note: 'long enough note here' })).status).toBe(400);
    const r = await request(app).post(`${API}/investigations/${c.id}/close`).set(A(admin)).send({ outcome: 'inconclusive', note: 'Customer unreachable; no further signal.' });
    expect(r.status).toBe(200); expect(r.body.investigation.status).toBe('closed'); expect(r.body.investigation.outcome).toBe('inconclusive');
    expect((await request(app).post(`${API}/investigations/${c.id}/comments`).set(A(admin)).send({ body: 'late note' })).status).toBe(409);
    expect((await request(app).post(`${API}/investigations/${c.id}/close`).set(A(admin)).send({ outcome: 'legitimate', note: 'trying again after close' })).status).toBe(409);
    expect((await request(app).patch(`${API}/investigations/${c.id}/status`).set(A(admin)).send({ status: 'open' })).status).toBe(400);
    const re = await request(app).patch(`${API}/investigations/${c.id}/status`).set(A(admin)).send({ status: 'open', reason: 'New chargeback evidence arrived' });
    expect(re.status).toBe(200); expect(re.body.investigation.outcome).toBeNull();
    const tl = (await request(app).get(`${API}/investigations/${c.id}/timeline`).set(A(admin))).body.timeline;
    expect(tl.some((e) => e.kind === 'closed')).toBe(true); expect(tl.some((e) => e.kind === 'reopened')).toBe(true);
  });

  test('inconclusive cases cannot auto-resolve alerts', async () => {
    const t = await mkTxn(u1); const k = (await mkCase({ alertIds: [t.aid] })).body.investigation;
    expect((await request(app).post(`${API}/investigations/${k.id}/close`).set(A(admin)).send({ outcome: 'inconclusive', note: 'not enough to decide', resolve_alerts: true })).status).toBe(400);
  });
});

describe('outcomes feed back into alerts', () => {
  test('closing as confirmed fraud resolves its open alerts with that verdict (audited)', async () => {
    const a = await mkTxn(u1); const b = await mkTxn(u2);
    const c = (await mkCase({ alertIds: [a.aid, b.aid] })).body.investigation;
    const r = await request(app).post(`${API}/investigations/${c.id}/close`).set(A(admin)).send({ outcome: 'confirmed_fraud', note: 'Both accounts used the same stolen card.', resolve_alerts: true });
    expect(r.status).toBe(200); expect(r.body.alerts_resolved.sort()).toEqual([a.aid, b.aid].sort());
    const rows = await db.all('SELECT verdict, resolution_reason, resolved FROM alerts WHERE id IN (?, ?)', [a.aid, b.aid]);
    rows.forEach((x) => { expect(x.verdict).toBe('confirmed_fraud'); expect(x.resolved).toBeTruthy(); expect(x.resolution_reason).toBe('customer_confirmed_fraud'); });
    for (let i = 0; i < 20 && !(await db.get("SELECT id FROM audit_logs WHERE action = 'investigations.close'")); i++) await new Promise((res) => setTimeout(res, 50));
    expect(await db.get("SELECT id FROM audit_logs WHERE action = 'investigations.close'")).toBeTruthy();
  });

  test('legitimate maps to false_positive; an alert locked by another investigator is skipped, not overridden', async () => {
    const a = await mkTxn(u1); const b = await mkTxn(u1);
    const c = (await mkCase({ alertIds: [a.aid, b.aid] })).body.investigation;
    expect((await request(app).post(`${API}/alerts/${b.aid}/claim`).set(A(admin2)).send({})).status).toBe(200);
    const r = await request(app).post(`${API}/investigations/${c.id}/close`).set(A(admin)).send({ outcome: 'legitimate', note: 'Customer confirmed all purchases.', resolve_alerts: true });
    expect(r.body.alerts_resolved).toEqual([a.aid]); expect(r.body.alerts_skipped).toEqual([b.aid]);
    expect((await db.get('SELECT verdict FROM alerts WHERE id = ?', [a.aid])).verdict).toBe('false_positive');
    expect((await db.get('SELECT resolved FROM alerts WHERE id = ?', [b.aid])).resolved).toBeFalsy();
    const tl = (await request(app).get(`${API}/investigations/${c.id}/timeline`).set(A(admin))).body.timeline;
    expect(tl.some((e) => e.kind === 'comment' && /not auto-resolved/.test(e.summary))).toBe(true);
  });
});

describe('related activity', () => {
  test('suggestions find unclaimed alerts sharing account/device/IP, never those already in a case, with a caution', async () => {
    const a = await mkTxn(u1, { device: 'shared-dev-1', ip: '198.51.100.7' });
    const dev = await mkTxn(u2, { device: 'shared-dev-1', ip: '203.0.113.50' });
    const ipOnly = await mkTxn(u2, { device: 'other-dev', ip: '198.51.100.7' });
    const unrelated = await mkTxn(u2, { device: 'zzz', ip: '192.0.2.200' });
    const taken = await mkTxn(u2, { device: 'shared-dev-1', ip: '1.1.1.1' }); await mkCase({ alertIds: [taken.aid], title: 'Other case' });
    const c = (await mkCase({ alertIds: [a.aid] })).body.investigation;
    const s = (await request(app).get(`${API}/investigations/${c.id}/suggestions`).set(A(admin))).body;
    const ids = s.suggestions.map((x) => x.alert_id);
    expect(ids).toEqual(expect.arrayContaining([dev.aid, ipOnly.aid]));
    expect(ids).not.toContain(unrelated.aid); expect(ids).not.toContain(taken.aid); expect(ids).not.toContain(a.aid);
    expect(s.suggestions.find((x) => x.alert_id === dev.aid).reasons).toContain('same device');
    expect(s.caution).toMatch(/not proof/);
    // the related-cases link shows the other case that shares the device
    const d = (await request(app).get(`${API}/investigations/${c.id}`).set(A(admin))).body;
    expect(d.links.related_cases).toBeDefined();
  });

  test('by-item lookup and list filters', async () => {
    const t = await mkTxn(u1); const c = (await mkCase({ alertIds: [t.aid], title: 'Findable zebra case' })).body.investigation;
    expect((await request(app).get(`${API}/investigations/by-item?type=alert&id=${t.aid}`).set(A(admin))).body.case_id).toBe(c.id);
    expect((await request(app).get(`${API}/investigations/by-item?type=alert&id=999999`).set(A(admin))).body.case_id).toBeNull();
    const l = await request(app).get(`${API}/investigations?q=zebra&status=open`).set(A(admin));
    expect(l.body.cases.map((x) => x.id)).toContain(c.id); expect(l.body.cases[0].alert_count).toBe(1);
    expect((await request(app).get(`${API}/investigations?status=nope`).set(A(admin))).status).toBe(400);
    expect((await request(app).get(`${API}/investigations/999999`).set(A(admin))).status).toBe(404);
  });
});
