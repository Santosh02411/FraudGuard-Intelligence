/** Rule Lab: historical simulation maths on a hand-built history, lifecycle invariants, rollback safety. */
jest.mock('../../models/mlClient');
const request = require('supertest');
const app = require('../../app');
const db = require('../../config/database');
const config = require('../../config/env');
const { initSchema } = require('../../config/schema');
const sim = require('../../services/ruleSimulationService');

const API = '/api/v1/rule-proposals';
const DAY = 86400000;
const iso = (d) => new Date(Date.now() - d * DAY).toISOString();
let admin; let admin2; let userTok; let uid;
const A = (t) => ({ Authorization: `Bearer ${t}` });

async function txn({ merchant, prob, risk = 'low', daysAgo = 50, verdict, dispute = false, amount = 50, hard = null }) {
  const { lastInsertRowid } = await db.insert(
    `INSERT INTO transactions (user_id, amount, merchant, category, location, card_type, fraud_score, risk_level, model_probability, hard_flag_triggered, status, created_at, is_synthetic)
     VALUES (?, ?, ?, 'food', 'NY', 'credit', ?, ?, ?, ?, 'completed', ?, 0)`, [uid, amount, merchant, (prob ?? 0) * 100, risk, prob ?? null, hard, iso(daysAgo)]);
  if (verdict) await db.insert(`INSERT INTO alerts (transaction_id, user_id, message, risk_level, status, created_at, resolved, verdict) VALUES (?, ?, 'x', ?, 'resolved', ?, 1, ?)`, [lastInsertRowid, uid, risk, iso(daysAgo), verdict]);
  if (dispute) await db.insert(`INSERT INTO disputes (transaction_id, amount_disputed, reason) VALUES (?, 50, 'not me')`, [lastInsertRowid]);
}

beforeAll(async () => {
  await initSchema();
  const login = async (u, p) => (await request(app).post('/api/v1/auth/login').send({ username: u, password: p })).body.accessToken;
  admin = await login('admin', 'admin123');
  const hash = (await db.get("SELECT password FROM users WHERE username='admin'")).password;
  await db.insert("INSERT INTO users (username, email, password, role, email_verified) VALUES ('rl_admin2', 'rl2@example.com', ?, 'admin', 1)", [hash]);
  admin2 = await login('rl_admin2', 'admin123');
  await request(app).post('/api/v1/auth/register').send({ username: 'rl_user', email: 'rl@example.com', password: 'Str0ng!Passw0rd1' });
  userTok = await login('rl_user', 'Str0ng!Passw0rd1');
  uid = (await db.get("SELECT id FROM users WHERE username='rl_user'")).id;

  for (let i = 0; i < 6; i++) await txn({ merchant: 'Coffee Corp', prob: 0.02 });                       // TN
  for (let i = 0; i < 3; i++) await txn({ merchant: 'ShadyGift', prob: 0.3, risk: 'medium', verdict: 'confirmed_fraud' }); // TP
  for (let i = 0; i < 4; i++) await txn({ merchant: 'GiftHub', prob: 0.05, dispute: true });             // FN (unflagged, disputed)
  for (let i = 0; i < 2; i++) await txn({ merchant: 'GiftHub', prob: 0.03 });                            // TN (presumed)
  await txn({ merchant: 'Recent Shop', prob: 0.02, daysAgo: 2 });                                         // immature
});

const mk = (body, tok = admin) => request(app).post(API).set(A(tok)).send({ title: 'Block GiftHub', ...body });
const GIFT = { rule_changes: [{ op: 'add', rule_type: 'blacklist_merchant', value: 'GiftHub' }] };

test('admin only', async () => {
  expect((await request(app).get(API)).status).toBe(401);
  expect((await request(app).get(API).set(A(userTok))).status).toBe(403);
});

describe('simulation maths', () => {
  test('ad-hoc simulation compares current vs proposed using labels, without changing anything', async () => {
    const before = await db.get('SELECT CAST(COUNT(*) AS INTEGER) c FROM fraud_rules');
    const r = await request(app).post(`${API}/simulate`).set(A(admin)).send(GIFT);
    expect(r.status).toBe(200);
    expect(r.body.current).toMatchObject({ flagged: 3, tp: 3, fp: 0, fn: 4 });
    expect(r.body.proposed).toMatchObject({ flagged: 9, tp: 7, fp: 2, fn: 0 });
    expect(r.body.delta).toMatchObject({ flagged: 6, true_positives: 4, false_positives: 2, missed_fraud: -4 });
    expect(r.body.newly_flagged).toMatchObject({ count: 6, likely_fraud: 4, likely_legitimate: 2 });
    expect(r.body.proposed.precision).toBeCloseTo(7 / 9, 3);
    expect(r.body.label_counts.IMMATURE).toBe(1);
    expect(r.body.caveats.join(' ')).toMatch(/PRESUMED/);
    expect((await db.get('SELECT CAST(COUNT(*) AS INTEGER) c FROM fraud_rules')).c).toBe(before.c); // read-only
  });

  test('a policy threshold change moves flags by model probability', async () => {
    const r = await request(app).post(`${API}/simulate`).set(A(admin)).send({ policy_change: { medium_threshold: 2.5, high_threshold: 50 } });
    expect(r.status).toBe(200);
    // the 0.03/0.05 probability rows (6) now exceed 2.5; the 0.02 rows (7) do not
    expect(r.body.delta.flagged).toBe(6);
    expect(r.body.proposed.fn).toBe(0);
  });

  test('rejects changes that cannot apply or violate policy limits', async () => {
    expect((await request(app).post(`${API}/simulate`).set(A(admin)).send({ rule_changes: [{ op: 'delete', rule_id: 99999 }] })).status).toBe(400);
    expect((await request(app).post(`${API}/simulate`).set(A(admin)).send({ policy_change: { medium_threshold: 20, high_threshold: 22 } })).status).toBe(400);
    expect((await request(app).post(`${API}/simulate`).set(A(admin)).send({})).status).toBe(400);
  });

  test('applyRuleChanges is pure and supports add/update/disable/delete', () => {
    const rows = [{ id: 1, rule_type: 'amount_cap', value: null, threshold: 100, enabled: 1 }, { id: 2, rule_type: 'blacklist_merchant', value: 'X', threshold: null, enabled: 1 }];
    const out = sim.applyRuleChanges(rows, [{ op: 'update', rule_id: 1, threshold: 50 }, { op: 'disable', rule_id: 2 }, { op: 'add', rule_type: 'blacklist_ip', value: '1.2.3.4' }]);
    expect(out.find((r) => r.id === 1).threshold).toBe(50);
    expect(out.find((r) => r.id === 2).enabled).toBe(0);
    expect(out).toHaveLength(3);
    expect(rows[0].threshold).toBe(100);
  });
});

describe('lifecycle', () => {
  let id;
  test('draft -> cannot approve without simulation', async () => {
    const r = await mk(GIFT); expect(r.status).toBe(201); id = r.body.proposal.id;
    expect(r.body.proposal.status).toBe('draft');
    const a = await request(app).post(`${API}/${id}/approve`).set(A(admin2)).send({});
    expect(a.status).toBe(409); expect(a.body.details.code).toBe('NO_SIMULATION');
  });

  test('simulate stores result; editing content discards it', async () => {
    const s = await request(app).post(`${API}/${id}/simulate`).set(A(admin)).send({});
    expect(s.status).toBe(200); expect(s.body.proposal.simulated_current).toBe(true);
    expect(s.body.proposal.simulation.delta.flagged).toBe(6);
    const e = await request(app).patch(`${API}/${id}`).set(A(admin)).send({ title: 'Block GiftHub merchant' });
    expect(e.body.proposal.simulated_current).toBe(true);        // title only: simulation kept
    const e2 = await request(app).patch(`${API}/${id}`).set(A(admin)).send({ rule_changes: [{ op: 'add', rule_type: 'blacklist_merchant', value: 'GiftHub' }, { op: 'add', rule_type: 'blacklist_merchant', value: 'ShadyGift' }] });
    expect(e2.body.proposal.simulated_current).toBe(false);
    expect(e2.body.proposal.simulation).toBeNull();
    await request(app).patch(`${API}/${id}`).set(A(admin)).send(GIFT);
    await request(app).post(`${API}/${id}/simulate`).set(A(admin)).send({});
  });

  test('four-eyes: creator cannot approve; a second admin can; approved is not editable', async () => {
    const self = await request(app).post(`${API}/${id}/approve`).set(A(admin)).send({});
    expect(self.status).toBe(409); expect(self.body.details.code).toBe('SELF_APPROVAL');
    const ok = await request(app).post(`${API}/${id}/approve`).set(A(admin2)).send({ note: 'looks right' });
    expect(ok.status).toBe(200); expect(ok.body.proposal.status).toBe('approved');
    expect((await request(app).patch(`${API}/${id}`).set(A(admin)).send({ title: 'nope nope' })).status).toBe(409);
    expect((await db.get("SELECT CAST(COUNT(*) AS INTEGER) c FROM fraud_rules WHERE value = 'GiftHub'")).c).toBe(0); // still not live
  });

  test('activate applies rules, records versions; double activate is refused', async () => {
    const r = await request(app).post(`${API}/${id}/activate`).set(A(admin)).send();
    expect(r.status).toBe(200); expect(r.body.proposal.status).toBe('active');
    expect(r.body.proposal.effects.created).toHaveLength(1);
    expect((await db.get("SELECT CAST(COUNT(*) AS INTEGER) c FROM fraud_rules WHERE value = 'GiftHub' AND enabled = 1")).c).toBe(1);
    expect(r.body.proposal.applied_rule_version).toBeGreaterThan(0);
    expect((await request(app).post(`${API}/${id}/activate`).set(A(admin)).send()).status).toBe(409);
  });

  test('rollback removes the rule via a new rule-set version; reason required; not repeatable', async () => {
    expect((await request(app).post(`${API}/${id}/rollback`).set(A(admin)).send({ reason: 'short' })).status).toBe(400);
    const before = (await request(app).get(`${API}/state`).set(A(admin))).body.rule_version;
    const r = await request(app).post(`${API}/${id}/rollback`).set(A(admin)).send({ reason: 'Too many false positives in week one' });
    expect(r.status).toBe(200); expect(r.body.proposal.status).toBe('rolled_back');
    expect((await db.get("SELECT CAST(COUNT(*) AS INTEGER) c FROM fraud_rules WHERE value = 'GiftHub'")).c).toBe(0);
    expect((await request(app).get(`${API}/state`).set(A(admin))).body.rule_version).toBeGreaterThan(before);
    expect((await request(app).post(`${API}/${id}/rollback`).set(A(admin)).send({ reason: 'again again again' })).status).toBe(409);
    const ev = (await request(app).get(`${API}/${id}`).set(A(admin))).body.events.map((e) => e.kind);
    expect(ev).toEqual(expect.arrayContaining(['created', 'simulated', 'approved', 'activated', 'rolled_back']));
  });
});

describe('safety', () => {
  test('stale simulation: live rules changed after simulating -> approve and activate are refused', async () => {
    const p = (await mk({ title: 'Stale test', rule_changes: [{ op: 'add', rule_type: 'blacklist_merchant', value: 'StaleCo' }] })).body.proposal;
    await request(app).post(`${API}/${p.id}/simulate`).set(A(admin)).send({});
    await request(app).post('/api/v1/admin/fraud-rules').set(A(admin)).send({ rule_type: 'blacklist_merchant', value: 'Unrelated Inc' });
    const a = await request(app).post(`${API}/${p.id}/approve`).set(A(admin2)).send({});
    expect(a.status).toBe(409); expect(a.body.details.code).toBe('STALE_SIMULATION');
    await request(app).post(`${API}/${p.id}/simulate`).set(A(admin)).send({});
    expect((await request(app).post(`${API}/${p.id}/approve`).set(A(admin2)).send({})).status).toBe(200);
    // base moves AFTER approval
    await request(app).post('/api/v1/admin/fraud-rules').set(A(admin)).send({ rule_type: 'blacklist_merchant', value: 'Another Inc' });
    const act = await request(app).post(`${API}/${p.id}/activate`).set(A(admin)).send();
    expect(act.status).toBe(409); expect(act.body.details.code).toBe('STALE_BASE');
    expect((await db.get("SELECT CAST(COUNT(*) AS INTEGER) c FROM fraud_rules WHERE value = 'StaleCo'")).c).toBe(0);
  });

  test('concurrent activation applies once', async () => {
    const p = (await mk({ title: 'Race test', rule_changes: [{ op: 'add', rule_type: 'blacklist_merchant', value: 'RaceCo' }] })).body.proposal;
    await request(app).post(`${API}/${p.id}/simulate`).set(A(admin)).send({});
    await request(app).post(`${API}/${p.id}/approve`).set(A(admin2)).send({});
    const rs = await Promise.all([1, 2, 3].map(() => request(app).post(`${API}/${p.id}/activate`).set(A(admin)).send()));
    expect(rs.filter((r) => r.status === 200)).toHaveLength(1);
    expect((await db.get("SELECT CAST(COUNT(*) AS INTEGER) c FROM fraud_rules WHERE value = 'RaceCo'")).c).toBe(1);
  });

  test('rollback conflict: a later edit of the same rule blocks automatic rollback and changes nothing', async () => {
    const p = (await mk({ title: 'Conflict test', rule_changes: [{ op: 'add', rule_type: 'blacklist_merchant', value: 'ConflictCo' }] })).body.proposal;
    await request(app).post(`${API}/${p.id}/simulate`).set(A(admin)).send({});
    await request(app).post(`${API}/${p.id}/approve`).set(A(admin2)).send({});
    const act = (await request(app).post(`${API}/${p.id}/activate`).set(A(admin)).send()).body.proposal;
    await request(app).patch(`${'/api/v1/admin/fraud-rules'}/${act.effects.created[0].id}`).set(A(admin)).send({ value: 'ConflictCo2' });
    const rb = await request(app).post(`${API}/${p.id}/rollback`).set(A(admin)).send({ reason: 'Attempting rollback after edit' });
    expect(rb.status).toBe(409); expect(rb.body.details.code).toBe('ROLLBACK_CONFLICT');
    expect((await request(app).get(`${API}/${p.id}`).set(A(admin))).body.proposal.status).toBe('active'); // claim rolled back with the tx
    expect((await db.get("SELECT CAST(COUNT(*) AS INTEGER) c FROM fraud_rules WHERE value = 'ConflictCo2'")).c).toBe(1);
  });

  test('policy changes activate as a new policy version and roll back as another new version', async () => {
    const p = (await mk({ title: 'Tighten policy', policy_change: { medium_threshold: 12, high_threshold: 55 } })).body.proposal;
    await request(app).post(`${API}/${p.id}/simulate`).set(A(admin)).send({});
    await request(app).post(`${API}/${p.id}/approve`).set(A(admin2)).send({});
    const act = await request(app).post(`${API}/${p.id}/activate`).set(A(admin)).send();
    expect(act.status).toBe(200);
    const pol = (await request(app).get('/api/v1/admin/risk-policy').set(A(admin))).body;
    expect(pol.active).toMatchObject({ medium_threshold: 12, high_threshold: 55 });
    const rb = await request(app).post(`${API}/${p.id}/rollback`).set(A(admin)).send({ reason: 'Reverting the policy trial' });
    expect(rb.status).toBe(200);
    const after = (await request(app).get('/api/v1/admin/risk-policy').set(A(admin))).body;
    expect(after.active).toMatchObject({ medium_threshold: 10, high_threshold: 50 });
    expect(after.active.version).toBeGreaterThan(pol.active.version);   // append-only history
  });

  test('reject needs a reason and closes the proposal', async () => {
    const p = (await mk({ title: 'Reject me', rule_changes: [{ op: 'add', rule_type: 'blacklist_ip', value: '9.9.9.9' }] })).body.proposal;
    expect((await request(app).post(`${API}/${p.id}/reject`).set(A(admin2)).send({ reason: 'no' })).status).toBe(400);
    const r = await request(app).post(`${API}/${p.id}/reject`).set(A(admin2)).send({ reason: 'Not enough evidence' });
    expect(r.body.proposal.status).toBe('rejected');
    expect((await request(app).post(`${API}/${p.id}/approve`).set(A(admin2)).send({})).status).toBe(409);
  });

  test('RULE_CHANGES_REQUIRE_PROPOSAL blocks direct edits', async () => {
    config.ruleLifecycle.requireProposal = true;
    try {
      const r = await request(app).post('/api/v1/admin/fraud-rules').set(A(admin)).send({ rule_type: 'blacklist_ip', value: '8.8.8.8' });
      expect(r.status).toBe(409); expect(r.body.details.code).toBe('PROPOSAL_REQUIRED');
      expect((await request(app).put('/api/v1/admin/risk-policy').set(A(admin)).send({ medium_threshold: 11, high_threshold: 51, note: 'direct change attempt' })).status).toBe(409);
    } finally { config.ruleLifecycle.requireProposal = false; }
  });
});
