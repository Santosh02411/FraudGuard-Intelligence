/**
 * End-to-end journey through the real HTTP stack and a real database:
 *   customer registers -> logs in -> a risky transaction is scored and flagged ->
 *   investigator works the case (claim, notes, evidence, rescore, resolve with amounts) ->
 *   customer disputes the charge -> dispute resolved -> every step is auditable and the numbers add up.
 * Only the ML model is stubbed (a deterministic score); everything else is production code.
 */
jest.mock('../../models/mlClient', () => ({ ...jest.requireActual('../../models/mlClient'), scoreWithML: jest.fn() }));

const request = require('supertest');
const { scoreWithML } = require('../../models/mlClient');
const app = require('../../app');
const db = require('../../config/database');
const { initSchema } = require('../../config/schema');
const API = '/api/v1';
const PW = 'Str0ng!Passw0rd1';
const ml = (p) => ({ fraud_score: p * 100, model_probability: p, raw_probability: p, calibrated: true, ml_calibrated: true, model_used: 'xgb', model_version: 'v-e2e', top_factors: [{ feature: 'amount', impact: 0.4 }] });
const bearer = (t) => ({ Authorization: `Bearer ${t}` });
const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16, 7)]);

let customer; let other; let admin; let txnId; let alertId; let disputeId;
const state = {};

beforeAll(async () => { await initSchema(); });

describe('journey', () => {
  test('1. registration, login, session refresh', async () => {
    const reg = await request(app).post(`${API}/auth/register`).send({ username: 'journey_cust', email: 'journey@example.com', password: PW });
    expect(reg.status).toBe(201);
    const login = await request(app).post(`${API}/auth/login`).send({ username: 'journey_cust', password: PW });
    expect(login.status).toBe(200);
    customer = login.body.accessToken;
    const refreshed = await request(app).post(`${API}/auth/refresh`).send({ refreshToken: login.body.refreshToken });
    expect(refreshed.status).toBe(200);
    expect(refreshed.body.refreshToken).not.toBe(login.body.refreshToken);
    customer = refreshed.body.accessToken;

    await request(app).post(`${API}/auth/register`).send({ username: 'journey_other', email: 'other@example.com', password: PW });
    other = (await request(app).post(`${API}/auth/login`).send({ username: 'journey_other', password: PW })).body.accessToken;
    admin = (await request(app).post(`${API}/auth/login`).send({ username: 'admin', password: 'admin123' })).body.accessToken;
  });

  test('2. a safe transaction is approved without an alert', async () => {
    scoreWithML.mockResolvedValue(ml(0.02));
    const res = await request(app).post(`${API}/transactions`).set(bearer(customer)).set('User-Agent', 'phone-1')
      .send({ amount: 12.5, merchant: 'Corner Cafe', category: 'food', location: 'New York, US', card_type: 'credit' });
    expect(res.status).toBe(201);
    expect(res.body.analysis.risk_level).toBe('low');
    expect(await db.get('SELECT id FROM alerts WHERE transaction_id = ?', [res.body.transaction.id])).toBeFalsy();
  });

  test('3. a risky transaction is flagged: alert, severity, deadline, decision evidence', async () => {
    scoreWithML.mockResolvedValue(ml(0.93));
    const res = await request(app).post(`${API}/transactions`).set(bearer(customer)).set('User-Agent', 'laptop-9')
      .send({ amount: 6200, merchant: 'Gadget Hub', category: 'electronics', location: 'Lagos, NG', card_type: 'credit' });
    expect(res.status).toBe(201);
    expect(res.body.analysis.risk_level).toBe('high');
    txnId = res.body.transaction.id;
    const alert = await db.get('SELECT * FROM alerts WHERE transaction_id = ?', [txnId]);
    alertId = alert.id;
    expect(alert).toMatchObject({ severity: 'critical', status: 'open', resolved: 0 });
    expect(new Date(alert.due_at) > new Date()).toBe(true);
    const rec = await db.get('SELECT decision_source, model_version, ruleset_version FROM decision_records WHERE transaction_id = ? AND seq = 1', [txnId]);
    expect(rec).toMatchObject({ decision_source: expect.stringMatching(/ml|hard_rule/), ruleset_version: expect.any(Number) });
  });

  test('4. the customer sees their alert; another customer sees nothing of it', async () => {
    const mine = await request(app).get(`${API}/alerts`).set(bearer(customer));
    expect(mine.body.alerts.some((a) => a.id === alertId)).toBe(true);
    const theirs = await request(app).get(`${API}/alerts`).set(bearer(other));
    expect(theirs.body.alerts.some((a) => a.id === alertId)).toBe(false);
    expect((await request(app).get(`${API}/alerts/${alertId}`).set(bearer(other))).status).toBe(403);
    expect((await request(app).get(`${API}/transactions/${txnId}`).set(bearer(other))).status).toBeGreaterThanOrEqual(403);
    expect((await request(app).get(`${API}/alerts/${alertId}/case`).set(bearer(customer))).status).toBe(403); // internal workspace
  });

  test('5. the investigator finds it at the top of the work queue and works the case', async () => {
    const queue = await request(app).get(`${API}/alerts?sort=priority&limit=5`).set(bearer(admin));
    expect(queue.body.alerts[0].id).toBe(alertId); // critical, nearest deadline
    expect((await request(app).post(`${API}/alerts/${alertId}/claim`).set(bearer(admin)).send({})).status).toBe(200);
    expect((await request(app).patch(`${API}/alerts/${alertId}/status`).set(bearer(admin)).send({ status: 'pending_info' })).status).toBe(200);
    expect((await request(app).post(`${API}/alerts/${alertId}/comments`).set(bearer(admin)).send({ body: 'Called cardholder: did not make this purchase.' })).status).toBe(201);
    const up = await request(app).post(`${API}/alerts/${alertId}/evidence?filename=call-screenshot.png`).set(bearer(admin)).set('Content-Type', 'application/octet-stream').send(png);
    expect(up.status).toBe(201);
  });

  test('6. a rescore adds to the history without changing the original', async () => {
    scoreWithML.mockResolvedValue(ml(0.97));
    const r = await request(app).post(`${API}/admin/transactions/${txnId}/rescore`).set(bearer(admin)).send({ reason: 'verify with the current model' });
    expect(r.status).toBe(201);
    expect(r.body.applied).toBe(false);
    const hist = await request(app).get(`${API}/admin/transactions/${txnId}/decision-history`).set(bearer(admin));
    expect(hist.body.chain).toMatchObject({ valid: true, records: 2 });
    const decisions = hist.body.timeline.filter((t) => t.kind === 'decision');
    expect(decisions.map((d) => d.decision.decision_type)).toEqual(['original', 'rescore']);
    expect(decisions[0].decision.fraud_score).toBeCloseTo(93, 0);
  });

  test('7. resolve as confirmed fraud with a reason and the money outcome', async () => {
    const res = await request(app).patch(`${API}/alerts/${alertId}/resolve`).set(bearer(admin))
      .send({ verdict: 'confirmed_fraud', reason: 'stolen_card', note: 'Card reported stolen.', loss_amount: 6200, recovered_amount: 1500 });
    expect(res.status).toBe(200);
    expect(res.body.alert).toMatchObject({ resolved: 1, status: 'resolved', verdict: 'confirmed_fraud', resolution_reason: 'stolen_card', loss_amount: 6200, recovered_amount: 1500, claimed_by: null });
  });

  test('8. the customer disputes the charge and the dispute is worked to a result', async () => {
    const open = await request(app).post(`${API}/disputes`).set(bearer(customer)).send({ transaction_id: txnId, reason: 'I did not authorise this.' });
    expect(open.status).toBe(201);
    disputeId = open.body.dispute.id;
    expect((await request(app).post(`${API}/disputes`).set(bearer(other)).send({ transaction_id: txnId })).status).toBeGreaterThanOrEqual(400);
    expect((await request(app).patch(`${API}/disputes/${disputeId}`).set(bearer(customer)).send({ status: 'won' })).status).toBe(403); // only staff decide
    const ev = await request(app).patch(`${API}/disputes/${disputeId}`).set(bearer(admin)).send({ status: 'evidence_submitted', note: 'Cardholder statement and call record attached.' });
    expect(ev.status).toBe(200);
    const won = await request(app).patch(`${API}/disputes/${disputeId}`).set(bearer(admin)).send({ status: 'won', note: 'Issuer accepted.', version: ev.body.dispute.version });
    expect(won.body.dispute.status).toBe('won');
    expect((await request(app).patch(`${API}/disputes/${disputeId}`).set(bearer(admin)).send({ status: 'lost' })).status).toBe(400); // a closed dispute stays closed
  });

  test('9. everything that happened is in one auditable timeline', async () => {
    await new Promise((r) => setTimeout(r, 100)); // audit writes are fire-and-forget
    const hist = await request(app).get(`${API}/admin/transactions/${txnId}/decision-history`).set(bearer(admin));
    const actions = hist.body.timeline.filter((t) => t.kind === 'audit').map((t) => t.action);
    for (const expected of ['alerts.claim', 'alerts.status_change', 'alerts.comment', 'alerts.evidence_add', 'decisions.rescore_recorded', 'alerts.resolve', 'disputes.open', 'disputes.transition']) {
      expect(actions).toContain(expected);
    }
    const resolve = hist.body.timeline.find((t) => t.action === 'alerts.resolve');
    expect(resolve.details.after).toMatchObject({ resolved: true, verdict: 'confirmed_fraud', reason: 'stolen_card' });
    expect(JSON.stringify(hist.body)).not.toMatch(/password|accessToken|refreshToken|Bearer /i);
  });

  test('10. team metrics reflect the case; stats and dispute totals agree', async () => {
    const m = (await request(app).get(`${API}/alerts/metrics?days=1`).set(bearer(admin))).body;
    expect(m.resolved.confirmed_fraud).toBeGreaterThanOrEqual(1);
    expect(m.amounts.loss).toBeGreaterThanOrEqual(6200);
    expect(m.amounts.recovered).toBeGreaterThanOrEqual(1500);
    const disputes = await request(app).get(`${API}/disputes`).set(bearer(admin));
    expect(disputes.body.disputes.find((d) => d.id === disputeId).status).toBe('won');
    state.done = true;
  });

  test('11. logout ends the session: the refresh token is dead', async () => {
    const login = await request(app).post(`${API}/auth/login`).send({ username: 'journey_cust', password: PW });
    await request(app).post(`${API}/auth/logout`).send({ refreshToken: login.body.refreshToken });
    expect((await request(app).post(`${API}/auth/refresh`).send({ refreshToken: login.body.refreshToken })).status).toBe(401);
  });
});
