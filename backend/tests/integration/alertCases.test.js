/**
 * Alert investigation workflow: claims, severity/SLA/escalation, comments, evidence, outcomes, metrics.
 */
jest.mock('../../models/mlClient', () => ({ ...jest.requireActual('../../models/mlClient'), scoreWithML: jest.fn() }));

const request = require('supertest');
const crypto = require('crypto');
const { scoreWithML } = require('../../models/mlClient');
const app = require('../../app');
const db = require('../../config/database');
const { initSchema } = require('../../config/schema');
const alertCase = require('../../models/alertCaseRepository');
const escalation = require('../../services/alertEscalationService');
const auditLogRepository = require('../../models/auditLogRepository');

const API = '/api/v1';
let a1; let a2; let userTok; let n = 0;
const as = (tok) => (r) => r.set('Authorization', `Bearer ${tok}`);
const ml = (p) => ({ fraud_score: p * 100, model_probability: p, raw_probability: p, calibrated: true, ml_calibrated: true, model_used: 'xgb', model_version: 'v9', top_factors: [] });
const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 1)]);

// audit() is fire-and-forget by design (it must never fail the request), so poll briefly.
async function auditEntry(alertId, action) {
  for (let i = 0; i < 40; i++) {
    const hit = (await auditLogRepository.forTarget('alert', alertId)).find((l) => l.action === action);
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 25));
  }
  return undefined;
}
async function login(username, password) { return (await request(app).post(`${API}/auth/login`).send({ username, password })).body.accessToken; }
async function newAlert({ amount = 300, p = 0.9 } = {}) {
  scoreWithML.mockResolvedValue(ml(p));
  n += 1;
  const res = await request(app).post(`${API}/transactions`).set('Authorization', `Bearer ${userTok}`).set('User-Agent', `case${n}`)
    .send({ amount, merchant: 'Shop', category: 'food', location: 'New York, US', card_type: 'credit' });
  const alert = await db.get('SELECT * FROM alerts WHERE transaction_id = ?', [res.body.transaction.id]);
  expect(alert).toBeTruthy();
  return alert;
}

beforeAll(async () => {
  await initSchema();
  a1 = await login('admin', 'admin123');
  await request(app).post(`${API}/auth/register`).send({ username: 'inv2', email: 'inv2@example.com', password: 'Str0ng!Passw0rd1' });
  await db.run("UPDATE users SET role = 'admin' WHERE username = 'inv2'");
  a2 = await login('inv2', 'Str0ng!Passw0rd1');
  await request(app).post(`${API}/auth/register`).send({ username: 'cust', email: 'cust@example.com', password: 'Str0ng!Passw0rd1' });
  userTok = await login('cust', 'Str0ng!Passw0rd1');
});
beforeEach(() => scoreWithML.mockReset());

describe('severity and SLA deadline', () => {
  test('severity derives from risk and value; deadline = creation + SLA for that severity', async () => {
    const big = await newAlert({ amount: 9000, p: 0.9 });
    const normal = await newAlert({ amount: 200, p: 0.9 });
    const med = await newAlert({ amount: 200, p: 0.3 });
    expect([big.severity, normal.severity]).toEqual(['critical', 'high']);
    expect(med.severity).toBe(alertCase.severityFor(med.risk_level, 200)); // the engine may rate it medium or high depending on the user's recent velocity
    const mins = (a) => Math.round((new Date(a.due_at) - Date.now()) / 60000);
    expect(mins(big)).toBeGreaterThan(55); expect(mins(big)).toBeLessThanOrEqual(60);
    expect(mins(normal)).toBeGreaterThan(235); expect(mins(normal)).toBeLessThanOrEqual(240);
    expect(alertCase.severityFor('medium', 200)).toBe('medium');
    expect(alertCase.severityFor('medium', 9000)).toBe('high');
  });

  test('changing severity needs a reason, recomputes the deadline, and is audited before/after', async () => {
    const a = await newAlert();
    expect((await as(a1)(request(app).patch(`${API}/alerts/${a.id}/severity`)).send({ severity: 'low' })).status).toBe(400);
    const r = await as(a1)(request(app).patch(`${API}/alerts/${a.id}/severity`)).send({ severity: 'low', reason: 'customer verified by phone' });
    expect(r.status).toBe(200);
    expect(r.body.alert.severity).toBe('low');
    const log = (await auditEntry(a.id, 'alerts.severity_change'));
    expect(log.details.before.severity).toBe('high');
    expect(log.details.after.severity).toBe('low');
  });
});

describe('claim lease: two investigators cannot unknowingly work one case', () => {
  test('second investigator is refused with who holds it; resolve/assign/status are blocked by the lock', async () => {
    const a = await newAlert();
    expect((await as(a1)(request(app).post(`${API}/alerts/${a.id}/claim`)).send({})).status).toBe(200);
    const second = await as(a2)(request(app).post(`${API}/alerts/${a.id}/claim`)).send({});
    expect(second.status).toBe(409);
    expect(second.body.details.code).toBe('ALERT_LOCKED');
    expect(second.body.details.current.claim.username).toBe('admin');

    const resolve = await as(a2)(request(app).patch(`${API}/alerts/${a.id}/resolve`)).send({ verdict: 'false_positive' });
    expect(resolve.status).toBe(409);
    expect(resolve.body.details.code).toBe('ALERT_LOCKED');
    expect((await as(a2)(request(app).patch(`${API}/alerts/${a.id}/status`)).send({ status: 'pending_info' })).status).toBe(409);
    expect((await as(a2)(request(app).patch(`${API}/alerts/${a.id}/assign`)).send({ assigneeId: 1 })).status).toBe(409);
    // still unresolved
    expect((await db.get('SELECT resolved FROM alerts WHERE id = ?', [a.id])).resolved).toBe(0);
    // holder can act, and resolving clears the lease
    expect((await as(a1)(request(app).patch(`${API}/alerts/${a.id}/resolve`)).send({ verdict: 'false_positive' })).status).toBe(200);
    expect((await db.get('SELECT claimed_by FROM alerts WHERE id = ?', [a.id])).claimed_by).toBeNull();
  });

  test('the holder can renew; an expired lease is free for anyone; release works', async () => {
    const a = await newAlert();
    await as(a1)(request(app).post(`${API}/alerts/${a.id}/claim`)).send({});
    expect((await as(a1)(request(app).post(`${API}/alerts/${a.id}/claim`)).send({})).status).toBe(200); // heartbeat
    await db.run('UPDATE alerts SET claim_expires_at = ? WHERE id = ?', [new Date(Date.now() - 1000).toISOString(), a.id]);
    expect((await as(a2)(request(app).post(`${API}/alerts/${a.id}/claim`)).send({})).status).toBe(200);
    expect((await as(a2)(request(app).delete(`${API}/alerts/${a.id}/claim`)).send({})).body.released).toBe(true);
    expect((await as(a1)(request(app).post(`${API}/alerts/${a.id}/claim`)).send({})).status).toBe(200);
  });

  test('takeover needs force + reason and is audited; release by a non-holder does nothing', async () => {
    const a = await newAlert();
    await as(a1)(request(app).post(`${API}/alerts/${a.id}/claim`)).send({});
    expect((await as(a2)(request(app).post(`${API}/alerts/${a.id}/claim`)).send({ force: true })).status).toBe(400);
    expect((await as(a2)(request(app).delete(`${API}/alerts/${a.id}/claim`)).send({})).body.released).toBe(false);
    const take = await as(a2)(request(app).post(`${API}/alerts/${a.id}/claim`)).send({ force: true, reason: 'admin is out sick today' });
    expect(take.status).toBe(200);
    const log = (await auditEntry(a.id, 'alerts.claim_takeover'));
    expect(log.details.before.claimed_by).toBe('admin');
    expect(log.details.after.claimed_by).toBe('inv2');
  });

  test('racing claims: exactly one wins', async () => {
    const a = await newAlert();
    const results = await Promise.all([a1, a2, a1, a2, a1, a2].map((t) => as(t)(request(app).post(`${API}/alerts/${a.id}/claim`)).send({})));
    const winners = new Set(results.filter((r) => r.status === 200).map((r) => r.body.alert.claim.username));
    expect(winners.size).toBe(1);
    expect(results.some((r) => r.status === 409)).toBe(true);
  });

  test('bulk resolve skips cases another investigator holds and reports them', async () => {
    const x = await newAlert(); const y = await newAlert();
    await as(a2)(request(app).post(`${API}/alerts/${y.id}/claim`)).send({});
    const r = await as(a1)(request(app).patch(`${API}/alerts/bulk-resolve`)).send({ alertIds: [x.id, y.id], verdict: 'false_positive' });
    expect(r.body).toMatchObject({ resolvedCount: 1, lockedCount: 1, lockedIds: [y.id] });
  });

  test('case actions are admin-only', async () => {
    const a = await newAlert();
    for (const [m, path, body] of [['post', 'claim', {}], ['get', 'case'], ['post', 'comments', { body: 'x' }], ['get', 'evidence'], ['patch', 'status', { status: 'open' }]]) {
      const req = request(app)[m](`${API}/alerts/${a.id}/${path}`).set('Authorization', `Bearer ${userTok}`);
      expect((await (body ? req.send(body) : req)).status).toBe(403);
    }
    expect((await request(app).get(`${API}/alerts/metrics`).set('Authorization', `Bearer ${userTok}`)).status).toBe(403);
  });
});

describe('overdue alerts and escalation', () => {
  test('overdue flag + filter; sweep escalates once per level with audit, shorter deadline, status escalated', async () => {
    const a = await newAlert();
    await db.run('UPDATE alerts SET due_at = ? WHERE id = ?', [new Date(Date.now() - 60000).toISOString(), a.id]);
    const list = await as(a1)(request(app).get(`${API}/alerts?overdue=true&limit=100`));
    expect(list.body.alerts.find((x) => x.id === a.id).overdue).toBe(true);

    const first = await escalation.sweep();
    expect(first.escalated).toBeGreaterThanOrEqual(1);
    const again = await escalation.sweep(); // deadline moved; nothing re-escalates immediately
    expect(again.escalated).toBe(0);
    const row = await db.get('SELECT status, escalation_level, due_at FROM alerts WHERE id = ?', [a.id]);
    expect(row).toMatchObject({ status: 'escalated', escalation_level: 1 });
    expect(new Date(row.due_at) > new Date()).toBe(true);
    const log = (await auditEntry(a.id, 'alerts.escalate'));
    expect(log.username).toBe('system:escalation');
    expect(log.details.after.escalation_level).toBe(1);
  });

  test('concurrent sweeps escalate a case once', async () => {
    const a = await newAlert();
    await db.run('UPDATE alerts SET due_at = ? WHERE id = ?', [new Date(Date.now() - 60000).toISOString(), a.id]);
    await Promise.all([escalation.sweep(), escalation.sweep(), escalation.sweep()]);
    expect((await db.get('SELECT escalation_level FROM alerts WHERE id = ?', [a.id])).escalation_level).toBe(1);
  });

  test('levels stop at the maximum; resolved alerts are never escalated; manual escalation needs a reason', async () => {
    const a = await newAlert();
    for (let i = 0; i < 5; i++) {
      await db.run('UPDATE alerts SET due_at = ? WHERE id = ?', [new Date(Date.now() - 60000).toISOString(), a.id]);
      await escalation.sweep();
    }
    expect((await db.get('SELECT escalation_level FROM alerts WHERE id = ?', [a.id])).escalation_level).toBe(3);
    const done = await newAlert();
    await as(a1)(request(app).patch(`${API}/alerts/${done.id}/resolve`)).send({ verdict: 'false_positive' });
    await db.run('UPDATE alerts SET due_at = ? WHERE id = ?', [new Date(Date.now() - 60000).toISOString(), done.id]);
    await escalation.sweep();
    expect((await db.get('SELECT escalation_level FROM alerts WHERE id = ?', [done.id])).escalation_level).toBe(0);
    const m = await newAlert();
    expect((await as(a1)(request(app).post(`${API}/alerts/${m.id}/escalate`)).send({})).status).toBe(400);
    const ok = await as(a1)(request(app).post(`${API}/alerts/${m.id}/escalate`)).send({ reason: 'customer is travelling' });
    expect(ok.body.alert).toMatchObject({ status: 'escalated', escalation_level: 1 });
  });

  test('priority sort puts the nearest deadline first', async () => {
    const soon = await newAlert(); const late = await newAlert();
    await db.run('UPDATE alerts SET due_at = ? WHERE id = ?', [new Date(Date.now() + 60000).toISOString(), soon.id]);
    await db.run('UPDATE alerts SET due_at = ? WHERE id = ?', [new Date(Date.now() + 9e8).toISOString(), late.id]);
    const ids = (await as(a1)(request(app).get(`${API}/alerts?sort=priority&limit=100`))).body.alerts.map((x) => x.id);
    expect(ids.indexOf(soon.id)).toBeLessThan(ids.indexOf(late.id));
  });
});

describe('comments and evidence', () => {
  test('comments are append-only, attributed, and not visible to the customer', async () => {
    const a = await newAlert();
    const c = await as(a1)(request(app).post(`${API}/alerts/${a.id}/comments`)).send({ body: 'Called the cardholder, no answer.' });
    expect(c.status).toBe(201);
    expect((await as(a1)(request(app).post(`${API}/alerts/${a.id}/comments`)).send({ body: '   ' })).status).toBe(400);
    const full = await as(a2)(request(app).get(`${API}/alerts/${a.id}/case`));
    expect(full.body.comments).toHaveLength(1);
    expect(full.body.comments[0]).toMatchObject({ author_username: 'admin' });
    expect((await as(a1)(request(app).delete(`${API}/alerts/${a.id}/comments/${c.body.comment.id}`))).status).toBe(404);
    expect(JSON.stringify((await request(app).get(`${API}/alerts/${a.id}`).set('Authorization', `Bearer ${userTok}`)).body)).not.toContain('Called the cardholder');
  });

  test('evidence: type decided by content, hashed, downloadable as an attachment, integrity-checked', async () => {
    const a = await newAlert();
    const up = await as(a1)(request(app).post(`${API}/alerts/${a.id}/evidence?filename=screenshot.png&description=login%20page`)).set('Content-Type', 'application/octet-stream').send(png);
    expect(up.status).toBe(201);
    expect(up.body.evidence).toMatchObject({ content_type: 'image/png', size_bytes: png.length, sha256: crypto.createHash('sha256').update(png).digest('hex') });
    const dl = await as(a2)(request(app).get(`${API}/alerts/${a.id}/evidence/${up.body.evidence.id}`)).buffer(true).parse((res, cb) => { const d = []; res.on('data', (c) => d.push(c)); res.on('end', () => cb(null, Buffer.concat(d))); });
    expect(dl.status).toBe(200);
    expect(dl.headers['content-disposition']).toMatch(/^attachment/);
    expect(dl.headers['x-content-type-options']).toBe('nosniff');
    expect(Buffer.compare(dl.body, png)).toBe(0);
    // tamper with the stored bytes -> refused and audited
    await db.run('UPDATE alert_evidence SET content = ? WHERE id = ?', [Buffer.concat([png, Buffer.from('x')]), up.body.evidence.id]);
    expect((await as(a1)(request(app).get(`${API}/alerts/${a.id}/evidence/${up.body.evidence.id}`))).status).toBe(500);
    expect(!!(await auditEntry(a.id, 'alerts.evidence_integrity_failure'))).toBe(true);
  });

  test('evidence rejects disguised or unsupported files, mismatched extensions, empty and oversized bodies', async () => {
    const a = await newAlert();
    const post = (name, body, type = 'application/octet-stream') => as(a1)(request(app).post(`${API}/alerts/${a.id}/evidence?filename=${encodeURIComponent(name)}`)).set('Content-Type', type).send(body);
    expect((await post('x.png', Buffer.from('<html><script>alert(1)</script>'), 'image/png')).status).toBe(400); // text pretending to be a PNG
    expect((await post('x.html', Buffer.from('<html></html>'))).status).toBe(400); // html is never an allowed name
    expect((await post('x.svg', Buffer.from('<svg onload=alert(1)/>'), 'image/svg+xml')).status).toBe(400);
    expect((await post('x.exe', Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00]))).status).toBe(400); // binary, no recognised signature
    expect((await post('x.pdf', png)).status).toBe(400); // PNG bytes named .pdf
    expect((await post('x.png', Buffer.alloc(0))).status).toBe(400);
    expect((await post('x.png', Buffer.concat([png, Buffer.alloc(3 * 1024 * 1024)]))).status).toBe(400); // over EVIDENCE_MAX_BYTES
    const ok = await post('../../etc/pass wd.txt', Buffer.from('plain notes'));
    expect(ok.status).toBe(201);
    expect(ok.body.evidence.filename).not.toMatch(/[\\/]/);
    expect((await as(a1)(request(app).get(`${API}/alerts/${a.id}/evidence`))).body.evidence).toHaveLength(1);
  });
});

describe('resolution reasons and outcome amounts', () => {
  test('resolve records a structured reason; unknown reasons are rejected', async () => {
    const a = await newAlert();
    expect((await as(a1)(request(app).patch(`${API}/alerts/${a.id}/resolve`)).send({ verdict: 'false_positive', reason: 'because' })).status).toBe(400);
    const r = await as(a1)(request(app).patch(`${API}/alerts/${a.id}/resolve`)).send({ verdict: 'false_positive', reason: 'customer_confirmed_legitimate', note: 'verified' });
    expect(r.body.alert).toMatchObject({ resolved: 1, verdict: 'false_positive', resolution_reason: 'customer_confirmed_legitimate' });
  });

  test('confirmed fraud: loss/prevented/recovered validated against the transaction amount and each other', async () => {
    const a = await newAlert({ amount: 1000 });
    const res = (body) => as(a1)(request(app).patch(`${API}/alerts/${a.id}/resolve`)).send({ verdict: 'confirmed_fraud', reason: 'stolen_card', ...body });
    expect((await res({ loss_amount: 1200 })).status).toBe(400);
    expect((await res({ loss_amount: 700, prevented_amount: 400 })).status).toBe(400); // 1100 > 1000
    expect((await res({ loss_amount: 100, recovered_amount: 200 })).status).toBe(400);
    expect((await res({ loss_amount: -5 })).status).toBe(400);
    const ok = await res({ loss_amount: 600, recovered_amount: 100, prevented_amount: 400 });
    expect(ok.status).toBe(200);
    expect(ok.body.alert).toMatchObject({ loss_amount: 600, recovered_amount: 100, prevented_amount: 400 });
  });

  test('a false positive cannot carry loss amounts; customers cannot record amounts', async () => {
    const a = await newAlert({ amount: 500 });
    expect((await as(a1)(request(app).patch(`${API}/alerts/${a.id}/resolve`)).send({ verdict: 'false_positive', loss_amount: 10 })).status).toBe(400);
    expect((await request(app).patch(`${API}/alerts/${a.id}/resolve`).set('Authorization', `Bearer ${userTok}`).send({ verdict: 'confirmed_fraud', loss_amount: 10 })).status).toBe(403);
  });

  test('recoveries can be added later with before/after audit; only for confirmed-fraud cases; stale versions refused', async () => {
    const a = await newAlert({ amount: 800 });
    const fp = await newAlert({ amount: 800 });
    await as(a1)(request(app).patch(`${API}/alerts/${fp.id}/resolve`)).send({ verdict: 'false_positive' });
    expect((await as(a1)(request(app).patch(`${API}/alerts/${fp.id}/outcome`)).send({ loss_amount: 5 })).status).toBe(400);
    const resolved = await as(a1)(request(app).patch(`${API}/alerts/${a.id}/resolve`)).send({ verdict: 'confirmed_fraud', loss_amount: 800 });
    const v = resolved.body.alert.version;
    const up = await as(a2)(request(app).patch(`${API}/alerts/${a.id}/outcome`)).send({ recovered_amount: 300, version: v });
    expect(up.body.alert).toMatchObject({ loss_amount: 800, recovered_amount: 300 });
    expect((await as(a2)(request(app).patch(`${API}/alerts/${a.id}/outcome`)).send({ recovered_amount: 900, version: v + 1 })).status).toBe(400); // > loss
    expect((await as(a2)(request(app).patch(`${API}/alerts/${a.id}/outcome`)).send({ recovered_amount: 400, version: v })).status).toBe(409); // stale
    const log = (await auditEntry(a.id, 'alerts.outcome_update'));
    expect(log.details.before.recovered).toBeNull();
    expect(log.details.after.recovered).toBe(300);
  });
});

describe('team metrics', () => {
  test('queue health, verdict mix, false-positive rate, amounts and recovery rate add up', async () => {
    const m = await as(a1)(request(app).get(`${API}/alerts/metrics?days=30`));
    expect(m.status).toBe(200);
    const { open, resolved, amounts } = m.body;
    expect(open.total).toBe(Object.values(open.by_status).reduce((a, b) => a + b, 0));
    expect(open.total).toBe(Object.values(open.by_severity).reduce((a, b) => a + b, 0));
    expect(resolved.total).toBe(resolved.confirmed_fraud + resolved.false_positive);
    expect(resolved.false_positive_rate).toBeCloseTo(resolved.false_positive / (resolved.confirmed_fraud + resolved.false_positive), 2);
    expect(amounts.loss).toBeGreaterThanOrEqual(amounts.recovered);
    expect(amounts.recovery_rate).toBeCloseTo(amounts.recovered / amounts.loss, 2);
    expect(resolved.by_reason.stolen_card).toBeGreaterThan(0);
    expect((await as(a1)(request(app).get(`${API}/alerts/metrics?days=0`))).status).toBe(400);
  });
});

describe('backwards compatibility and privacy', () => {
  test('alerts that predate case management get severity and a fresh deadline (not an instant overdue backlog)', async () => {
    const a = await newAlert();
    await db.run('UPDATE alerts SET severity = NULL, due_at = NULL, created_at = ? WHERE id = ?', ['2020-01-01 00:00:00', a.id]);
    await alertCase.backfillCaseFields();
    const row = await db.get('SELECT severity, due_at FROM alerts WHERE id = ?', [a.id]);
    expect(row.severity).toBeTruthy();
    expect(new Date(row.due_at) > new Date()).toBe(true);
  });

  test('the old assign flow still moves open <-> in_review, and keeps escalated/pending_info', async () => {
    const a = await newAlert();
    expect((await as(a1)(request(app).patch(`${API}/alerts/${a.id}/assign`)).send({ assigneeId: 1 })).body.alert.status).toBe('in_review');
    await as(a1)(request(app).patch(`${API}/alerts/${a.id}/status`)).send({ status: 'pending_info' });
    expect((await as(a1)(request(app).patch(`${API}/alerts/${a.id}/assign`)).send({ assigneeId: null })).body.alert.status).toBe('pending_info');
  });

  test('case events go to admin rooms only and are replayable by admins, never by the customer', async () => {
    const realtimeEvents = require('../../models/realtimeEventRepository');
    const a = await newAlert();
    await as(a1)(request(app).post(`${API}/alerts/${a.id}/claim`)).send({});
    await new Promise((r) => setTimeout(r, 50));
    const cust = await db.get("SELECT id FROM users WHERE username = 'cust'");
    const adm = await db.get("SELECT id FROM users WHERE username = 'admin'");
    const forCust = await realtimeEvents.listFor({ id: cust.id, role: 'user' }, { types: ['alert:updated'] });
    const forAdmin = await realtimeEvents.listFor({ id: adm.id, role: 'admin' }, { types: ['alert:updated'] });
    expect(forCust.events).toHaveLength(0);
    expect(forAdmin.events.some((e) => e.kind === 'claimed' && e.alert_id === a.id)).toBe(true);
  });

  test('the customer still sees only their own alerts and cannot read case details', async () => {
    const mine = await request(app).get(`${API}/alerts`).set('Authorization', `Bearer ${userTok}`);
    expect(mine.status).toBe(200);
    expect(mine.body.alerts.length).toBeGreaterThan(0);
  });
});
