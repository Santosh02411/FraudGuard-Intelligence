/** Risk-based verification: policy guard rails, advisory vs enforce, outcomes, expiry, replay, races, measurement. */
jest.mock('../../models/mlClient');
const request = require('supertest');
const app = require('../../app');
const db = require('../../config/database');
const { initSchema } = require('../../config/schema');
const verificationService = require('../../services/verificationService');
const vp = require('../../models/verificationPolicy');

const API = '/api/v1';
const A = (t) => ({ Authorization: `Bearer ${t}` });
let admin; let seq = 100;

const MEDIUM = { amount: 2000, merchant: 'Bet365', category: 'gambling', location: 'New York, US', card_type: 'credit' };
const HIGH = { amount: 100, merchant: 'DarkNet Market', category: 'electronics', location: 'New York, US', card_type: 'credit' };

async function mkUser(name, { subscribe = false } = {}) {
  const password = 'Str0ng!Passw0rd1';
  await request(app).post(`${API}/auth/register`).send({ username: name, email: `${name}@example.com`, password });
  const token = (await request(app).post(`${API}/auth/login`).send({ username: name, password })).body.accessToken;
  if (subscribe) await request(app).post(`${API}/webhooks`).set(A(token)).send({ url: 'https://example.com/hook', events: ['transaction.step_up_required'] });
  return token;
}
function post(token, body) {
  seq += 1;
  return request(app).post(`${API}/transactions`).set(A(token)).set('User-Agent', `ua-${seq}`).set('X-Forwarded-For', `198.51.100.${seq % 250}`).send(body);
}
const policy = (o = {}) => ({ mode: 'enforce', actions: { low: 'approve', medium: 'challenge', high: 'decline' }, min_amount: null, ttl_seconds: 300, note: 'Test policy change', confirm_enforce: true, ...o });
const setPolicy = (o) => request(app).put(`${API}/verification/policy`).set(A(admin)).send(policy(o));
const verify = (token, id, challenge_token, outcome) => request(app).post(`${API}/transactions/${id}/step-up/verify`).set(A(token)).send({ challenge_token, outcome });

beforeAll(async () => {
  await initSchema();
  admin = (await request(app).post(`${API}/auth/login`).send({ username: 'admin', password: 'admin123' })).body.accessToken;
});

describe('policy', () => {
  test('admin only; defaults to off with legacy semantics', async () => {
    const u = await mkUser('vp_user');
    expect((await request(app).get(`${API}/verification/policy`)).status).toBe(401);
    expect((await request(app).get(`${API}/verification/policy`).set(A(u))).status).toBe(403);
    const r = await request(app).get(`${API}/verification/policy`).set(A(admin));
    expect(r.body.active).toMatchObject({ mode: 'off', version: 0 });
    expect(r.body.separation).toMatch(/never authorizes/);
  });

  test('guard rails: low risk never challenged, medium never declined, ttl bounds, note + confirmation required', async () => {
    const bad = async (o, re) => { const r = await setPolicy(o); expect(r.status).toBe(400); expect(JSON.stringify(r.body)).toMatch(re); };
    await bad({ actions: { low: 'challenge', medium: 'challenge', high: 'decline' } }, /low-risk action/);
    await bad({ actions: { low: 'approve', medium: 'decline', high: 'decline' } }, /medium-risk action/);
    await bad({ ttl_seconds: 5 }, /ttl_seconds/);
    await bad({ note: 'short' }, /at least 10/);
    const noConfirm = await request(app).put(`${API}/verification/policy`).set(A(admin)).send(policy({ confirm_enforce: undefined }));
    expect(noConfirm.status).toBe(400); expect(noConfirm.body.details.code).toBe('CONFIRM_ENFORCE_REQUIRED');
  });

  test('saves as an append-only version and rejects a no-op', async () => {
    const r = await setPolicy({ mode: 'advisory', confirm_enforce: undefined });
    expect(r.status).toBe(200); expect(r.body.policy.version).toBeGreaterThan(0);
    expect((await setPolicy({ mode: 'advisory', confirm_enforce: undefined })).status).toBe(400);
    const h = (await request(app).get(`${API}/verification/policy`).set(A(admin))).body.history;
    expect(h[0].version).toBe(r.body.policy.version);
  });

  test('evaluate() is pure and degrades safely', () => {
    const p = { mode: 'enforce', actions: { low: 'approve', medium: 'challenge', high: 'decline' }, min_amount: 500 };
    expect(vp.evaluate({ policy: p, level: 'high', amount: 1, hasChannel: false })).toMatchObject({ effective: 'decline', enforced: true });
    expect(vp.evaluate({ policy: p, level: 'medium', amount: 10, hasChannel: true })).toMatchObject({ effective: 'approve', reason: 'below_min_amount' });
    expect(vp.evaluate({ policy: p, level: 'medium', amount: 900, hasChannel: false })).toMatchObject({ recommended: 'challenge', effective: 'approve', enforced: false, reason: 'no_verification_channel' });
    expect(vp.evaluate({ policy: { ...p, mode: 'advisory' }, level: 'medium', amount: 900, hasChannel: false })).toMatchObject({ recommended: 'challenge', effective: 'approve', enforced: false });
  });
});

describe('modes', () => {
  test('advisory records the recommendation but does not hold an account that has no legacy hold', async () => {
    await setPolicy({ mode: 'advisory', ttl_seconds: 301, confirm_enforce: undefined });
    const t = await mkUser('vm_adv');
    const r = await post(t, MEDIUM);
    expect(r.status).toBe(201);
    expect(r.body.transaction.status).toBe('completed');
    expect(r.body.verification).toMatchObject({ mode: 'advisory', recommended_action: 'challenge', applied_action: 'approve', enforced: false });
    expect(r.body.verification.authorization.performed).toBe(false);
    const row = await db.get('SELECT verification_action, verification_mode, verification_enforced FROM transactions WHERE id = ?', [r.body.transaction.id]);
    expect(row).toMatchObject({ verification_action: 'challenge', verification_mode: 'advisory' });
    expect(Number(row.verification_enforced)).toBe(0);
  });

  test('enforce: high risk is declined (blocked, no challenge); the decision is recorded', async () => {
    await setPolicy({ ttl_seconds: 302 });
    const t = await mkUser('vm_decl');
    const r = await post(t, HIGH);
    expect(r.body.analysis.risk_level).toBe('high');
    expect(r.body.transaction.status).toBe('blocked');
    expect(r.body.step_up).toBeFalsy();
    expect(r.body.verification).toMatchObject({ applied_action: 'decline', enforced: true });
    expect(r.body.analysis.message).toMatch(/Declined/);
    expect(await db.get('SELECT id FROM step_up_challenges WHERE transaction_id = ?', [r.body.transaction.id])).toBeFalsy();
  });

  test('enforce: medium risk is challenged for a subscribed account, with the policy TTL; unsubscribed accounts are not stranded', async () => {
    await setPolicy({ ttl_seconds: 600 });
    const sub = await mkUser('vm_sub', { subscribe: true });
    const r = await post(sub, MEDIUM);
    expect(r.body.transaction.status).toBe('pending_step_up');
    const ttl = (new Date(r.body.step_up.expires_at).getTime() - Date.now()) / 1000;
    expect(ttl).toBeGreaterThan(540); expect(ttl).toBeLessThanOrEqual(600);
    const ch = await db.get('SELECT * FROM step_up_challenges WHERE transaction_id = ?', [r.body.transaction.id]);
    expect(ch).toMatchObject({ risk_level: 'medium' });

    const nosub = await mkUser('vm_nosub');
    const r2 = await post(nosub, MEDIUM);
    expect(r2.body.transaction.status).toBe('completed');
    expect(r2.body.verification).toMatchObject({ recommended_action: 'challenge', applied_action: 'approve', enforced: false, reason: 'no_verification_channel' });
  });

  test('enforce: min_amount keeps small transactions frictionless', async () => {
    await setPolicy({ ttl_seconds: 601, min_amount: 5000 });
    const sub = await mkUser('vm_min', { subscribe: true });
    const r = await post(sub, MEDIUM);
    expect(r.body.transaction.status).toBe('completed');
    expect(r.body.verification.reason).toBe('below_min_amount');
  });
});

describe('challenge outcomes, expiry, replay', () => {
  let sub; let n = 0;
  beforeAll(async () => { await setPolicy({ ttl_seconds: 603 }); });
  // a fresh account per hold: repeated transactions from one account raise velocity and would push it past "medium"
  const held = async () => { n += 1; sub = await mkUser(`vo_sub_${n}`, { subscribe: true }); const r = await post(sub, MEDIUM); return { id: r.body.transaction.id, ct: r.body.step_up.challenge_token, tok: sub }; };

  test.each([['success', 'verified', 'completed'], ['failure', 'failed', 'blocked'], ['abandoned', 'abandoned', 'blocked']])('outcome %s -> challenge %s, transaction %s', async (outcome, cStatus, tStatus) => {
    const h = await held();
    const r = await verify(h.tok, h.id, h.ct, outcome);
    expect(r.status).toBe(200);
    expect(r.body.challenge_status).toBe(cStatus);
    expect(r.body.transaction.status).toBe(tStatus);
    const ch = await db.get('SELECT * FROM step_up_challenges WHERE transaction_id = ?', [h.id]);
    expect(ch.status).toBe(cStatus); expect(ch.resolved_at).toBeTruthy();
    const kinds = (await db.all('SELECT kind FROM verification_events WHERE transaction_id = ? ORDER BY id', [h.id])).map((e) => e.kind);
    expect(kinds).toEqual(['issued', cStatus]);
  });

  test('an expired challenge cannot be completed late; the hold is released as blocked, not left pending', async () => {
    const h = await held();
    await db.run("UPDATE step_up_challenges SET expires_at = ? WHERE transaction_id = ?", [new Date(Date.now() - 1000).toISOString(), h.id]);
    const r = await verify(h.tok, h.id, h.ct, 'success');
    expect(r.status).toBe(409); expect(r.body.details.code).toBe('CHALLENGE_EXPIRED');
    expect((await db.get('SELECT status FROM transactions WHERE id = ?', [h.id])).status).toBe('blocked');
    expect((await db.get('SELECT status FROM step_up_challenges WHERE transaction_id = ?', [h.id])).status).toBe('expired');
  });

  test('replay: a resolved token cannot be reused, the attempt is counted and audited, and nothing changes', async () => {
    const h = await held();
    expect((await verify(h.tok, h.id, h.ct, 'success')).status).toBe(200);
    const again = await verify(h.tok, h.id, h.ct, 'failure');
    expect(again.status).toBe(409); expect(again.body.details.code).toBe('CHALLENGE_REPLAY');
    expect((await db.get('SELECT status FROM transactions WHERE id = ?', [h.id])).status).toBe('completed');
    expect(Number((await db.get('SELECT replay_attempts FROM step_up_challenges WHERE transaction_id = ?', [h.id])).replay_attempts)).toBe(1);
    expect((await db.all('SELECT kind FROM verification_events WHERE transaction_id = ?', [h.id])).map((e) => e.kind)).toContain('replay_rejected');
  });

  test('a token is bound to its own transaction', async () => {
    const a = await held(); const b = await held();
    expect((await verify(a.tok, a.id, b.ct, 'success')).status).toBe(404);
    expect((await db.get('SELECT status FROM transactions WHERE id = ?', [a.id])).status).toBe('pending_step_up');
  });

  test('the sweep expires overdue challenges once and leaves live ones alone', async () => {
    const old = await held(); const live = await held();
    await db.run("UPDATE step_up_challenges SET expires_at = ? WHERE transaction_id = ?", [new Date(Date.now() - 5000).toISOString(), old.id]);
    const r = await request(app).post(`${API}/verification/sweep`).set(A(admin));
    expect(r.status).toBe(200); expect(r.body.expired).toBeGreaterThanOrEqual(1);
    expect((await db.get('SELECT status FROM transactions WHERE id = ?', [old.id])).status).toBe('blocked');
    expect((await db.get('SELECT status FROM transactions WHERE id = ?', [live.id])).status).toBe('pending_step_up');
    expect((await request(app).post(`${API}/verification/sweep`).set(A(admin))).body.expired).toBe(0);
  });

  test('race: the customer callback and the sweep cannot both resolve a challenge', async () => {
    const h = await held();
    await db.run("UPDATE step_up_challenges SET expires_at = ? WHERE transaction_id = ?", [new Date(Date.now() - 1000).toISOString(), h.id]);
    const ch = await db.get('SELECT * FROM step_up_challenges WHERE transaction_id = ?', [h.id]);
    const results = await Promise.all([verificationService.resolve(ch, 'success'), verificationService.resolve(ch, 'expired'), verificationService.resolve(ch, 'failure')]);
    expect(results.filter(Boolean)).toHaveLength(1);
    const kinds = (await db.all("SELECT kind FROM verification_events WHERE transaction_id = ? AND kind != 'issued'", [h.id]));
    expect(kinds).toHaveLength(1);
  });
});

describe('measurement', () => {
  async function txnWith({ status, amount = 100, verdict, dispute = false, synthetic = 0, action = null, mode = 'enforce', enforced = 1, challenge }) {
    const uid = (await db.get("SELECT id FROM users WHERE username = 'admin'")).id;
    const { lastInsertRowid: id } = await db.insert(
      `INSERT INTO transactions (user_id, amount, merchant, category, location, card_type, fraud_score, risk_level, status, created_at, is_synthetic, verification_action, verification_mode, verification_enforced, verification_policy_version)
       VALUES (?, ?, 'MX', 'food', 'NY', 'credit', 50, 'medium', ?, ?, ?, ?, ?, ?, 9)`, [uid, amount, status, new Date().toISOString(), synthetic, action, mode, enforced]);
    if (verdict) await db.insert(`INSERT INTO alerts (transaction_id, user_id, message, risk_level, status, created_at, resolved, verdict) VALUES (?, ?, 'x', 'medium', 'resolved', ?, 1, ?)`, [id, uid, new Date().toISOString(), verdict]);
    if (dispute) await db.insert('INSERT INTO disputes (transaction_id, amount_disputed, reason) VALUES (?, ?, \'x\')', [id, amount]);
    if (challenge) {
      const created = new Date(Date.now() - 60000).toISOString();
      await db.insert(`INSERT INTO step_up_challenges (transaction_id, status, method, challenge_token, expires_at, created_at, resolved_at) VALUES (?, ?, 'otp', ?, ?, ?, ?)`,
        [id, challenge, `tok-${id}-${Math.random()}`, new Date(Date.now() + 1e6).toISOString(), created, challenge === 'pending' ? null : new Date().toISOString()]);
    }
    return id;
  }

  test('fraud loss and friction are split by outcome and label, with honest handling of unlabelled outcomes', async () => {
    await db.exec('UPDATE transactions SET is_synthetic = 1'); // sideline everything created by earlier tests
    await txnWith({ status: 'blocked', amount: 1000, verdict: 'confirmed_fraud', challenge: 'failed' });      // fraud stopped
    await txnWith({ status: 'completed', amount: 400, verdict: 'confirmed_fraud', challenge: 'verified' });   // fraud passed challenge
    await txnWith({ status: 'completed', amount: 50, verdict: 'false_positive', challenge: 'verified' });     // legit, completed (friction but no loss)
    await txnWith({ status: 'blocked', amount: 70, verdict: 'false_positive', challenge: 'abandoned' });      // legit lost
    await txnWith({ status: 'blocked', amount: 90, challenge: 'expired' });                                    // unlabelled — neither claimed
    await txnWith({ status: 'blocked', amount: 300, verdict: 'confirmed_fraud', action: 'decline' });         // declined fraud
    await txnWith({ status: 'completed', amount: 250, dispute: true });                                         // flagged, not challenged, fraud got through
    await txnWith({ status: 'pending_step_up', amount: 20, challenge: 'pending' });
    await txnWith({ status: 'blocked', amount: 5000, verdict: 'confirmed_fraud', synthetic: 1, challenge: 'failed' }); // demo traffic: ignored

    const r = (await request(app).get(`${API}/verification/effectiveness?days=30`).set(A(admin))).body;
    expect(r.total_transactions).toBe(8);                                       // synthetic excluded
    expect(r.challenges).toMatchObject({ issued: 6, verified: 2, failed: 1, abandoned: 1, expired: 1, pending: 1, resolved: 5 });
    expect(r.challenges.completion_rate).toBeCloseTo(2 / 5, 4);
    expect(r.challenges.abandonment_rate).toBeCloseTo(2 / 5, 4);
    expect(r.fraud_loss.stopped_by_challenge).toEqual({ count: 1, amount: 1000 });
    expect(r.fraud_loss.passed_challenge).toEqual({ count: 1, amount: 400 });
    expect(r.fraud_loss.stopped_by_decline).toEqual({ count: 1, amount: 300 });
    expect(r.fraud_loss.flagged_not_challenged).toEqual({ count: 1, amount: 250 });
    expect(r.friction).toMatchObject({ legit_confirmed_challenged: 2, legit_confirmed_not_completed: 1, legit_confirmed_not_completed_amount: 70, unlabelled_not_completed: 1, declined: 1 });
    expect(r.caveats.join(' ')).toMatch(/Observational/);
    expect(r.by_policy['enforce|decline|v9'].count).toBe(1);
  });

  test('preview shows how a candidate policy would have treated recent history, read-only', async () => {
    const before = await db.get('SELECT CAST(COUNT(*) AS INTEGER) c FROM verification_policy');
    const r = await request(app).post(`${API}/verification/policy/preview`).set(A(admin)).send({ mode: 'enforce', actions: { low: 'approve', medium: 'challenge', high: 'decline' }, ttl_seconds: 300, days: 30 });
    expect(r.status).toBe(200);
    expect(r.body.evaluated).toBe(8);
    expect(r.body.actions.challenge).toBeGreaterThan(0);
    expect(r.body.challenged_labels.legit).toBeGreaterThanOrEqual(2);
    expect((await db.get('SELECT CAST(COUNT(*) AS INTEGER) c FROM verification_policy')).c).toBe(before.c);
    expect((await request(app).get(`${API}/verification/challenges?status=failed`).set(A(admin))).body.challenges.length).toBeGreaterThan(0);
  });
});
