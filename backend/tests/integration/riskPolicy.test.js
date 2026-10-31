/**
 * Risk-policy admin API + the measurement tools operators use to tune it.
 */
jest.mock('../../models/mlClient');

const request = require('supertest');
const { deleteTransactions } = require('../helpers/purge');
const { scoreWithML } = require('../../models/mlClient');
const app = require('../../app');
const db = require('../../config/database');
const { initSchema } = require('../../config/schema');
const transactionRepository = require('../../models/transactionRepository');
const alertRepository = require('../../models/alertRepository');
const auditLogRepository = require('../../models/auditLogRepository');

const API = '/api/v1';
let adminToken;
let userToken;
let userId;

beforeAll(async () => {
  await initSchema();
  const login = await request(app).post(`${API}/auth/login`).send({ username: 'admin', password: 'admin123' });
  adminToken = login.body.accessToken;
  await request(app).post(`${API}/auth/register`).send({ username: 'rp_user', email: 'rp_user@example.com', password: 'Str0ng!Passw0rd1' });
  const u = await request(app).post(`${API}/auth/login`).send({ username: 'rp_user', password: 'Str0ng!Passw0rd1' });
  userToken = u.body.accessToken;
  userId = (await db.get('SELECT id FROM users WHERE username = ?', ['rp_user'])).id;
});

const asAdmin = (req) => req.set('Authorization', `Bearer ${adminToken}`);

describe('access control', () => {
  const routes = [
    ['get', '/admin/risk-policy'], ['put', '/admin/risk-policy'],
    ['post', '/admin/risk-policy/simulate'], ['get', '/admin/risk-policy/calibration'],
  ];
  test.each(routes)('%s %s: anonymous -> 401, ordinary user -> 403', async (method, path) => {
    expect((await request(app)[method](`${API}${path}`).send({})).status).toBe(401);
    expect((await request(app)[method](`${API}${path}`).set('Authorization', `Bearer ${userToken}`).send({})).status).toBe(403);
  });
});

describe('GET/PUT /admin/risk-policy', () => {
  test('before any change the built-in default (version 0) is in force', async () => {
    const res = await asAdmin(request(app).get(`${API}/admin/risk-policy`));
    expect(res.status).toBe(200);
    expect(res.body.active).toMatchObject({ version: 0, medium_threshold: 10, high_threshold: 50, source: 'default' });
    expect(res.body.score_meaning).toMatch(/calibrated probability/);
  });

  test('rejects invalid thresholds, a missing/short note, and no-op changes', async () => {
    const put = (body) => asAdmin(request(app).put(`${API}/admin/risk-policy`)).send(body);
    expect((await put({ medium_threshold: 0, high_threshold: 50, note: 'long enough note' })).status).toBe(400);
    expect((await put({ medium_threshold: 40, high_threshold: 42, note: 'long enough note' })).status).toBe(400);
    expect((await put({ medium_threshold: 10, high_threshold: 100, note: 'long enough note' })).status).toBe(400);
    expect((await put({ medium_threshold: 10, high_threshold: 50 })).status).toBe(400);
    expect((await put({ medium_threshold: 10, high_threshold: 50, note: 'short' })).status).toBe(400);
    const same = await put({ medium_threshold: 10, high_threshold: 50, note: 'no change really' });
    expect(same.status).toBe(400); // identical to the default in force
    expect((await asAdmin(request(app).get(`${API}/admin/risk-policy`))).body.history).toHaveLength(0);
  });

  test('saving creates an append-only new version, audited with before/after and the reason', async () => {
    const res = await asAdmin(request(app).put(`${API}/admin/risk-policy`)).send({
      medium_threshold: 20, high_threshold: 60, review_capacity_per_day: 40, note: 'Raise review bar: analysts overloaded',
    });
    expect(res.status).toBe(200);
    expect(res.body.policy).toMatchObject({ version: 1, medium_threshold: 20, high_threshold: 60, review_capacity_per_day: 40 });
    expect(res.body.previous.version).toBe(0);

    await asAdmin(request(app).put(`${API}/admin/risk-policy`)).send({ medium_threshold: 15, high_threshold: 55, note: 'Compromise after review' });
    const get = await asAdmin(request(app).get(`${API}/admin/risk-policy`));
    expect(get.body.active.version).toBe(2);
    expect(get.body.history.map((h) => h.version)).toEqual([2, 1]); // newest first, nothing overwritten
    expect(get.body.history[1]).toMatchObject({ medium_threshold: 20, high_threshold: 60 });

    await new Promise((r) => setTimeout(r, 80));
    const logs = await auditLogRepository.forTarget('risk_policy', 1);
    const entry = (logs.rows || logs).find((l) => l.action === 'risk_policy.update');
    expect(entry).toBeTruthy();
    expect(JSON.stringify(entry.details)).toMatch(/Raise review bar/);
  });
});

describe('transactions record probability, policy decision and policy version separately', () => {
  test('same model probability, different decision after a policy change', async () => {
    scoreWithML.mockResolvedValue({ fraud_score: 30, model_probability: 0.3, model_used: 'random_forest', model_version: 'v3', top_factors: [] });
    const post = () => request(app).post(`${API}/transactions`).set('Authorization', `Bearer ${userToken}`)
      .send({ amount: 25, merchant: 'Corner Cafe', category: 'food', location: 'New York, US', card_type: 'credit' });

    const before = await post(); // policy v2: medium 15 -> 30 is medium
    expect(before.body.transaction.risk_level).toBe('medium');
    expect(before.body.transaction.policy_version).toBe(2);
    expect(before.body.transaction.model_probability).toBeCloseTo(0.3);

    await asAdmin(request(app).put(`${API}/admin/risk-policy`)).send({ medium_threshold: 35, high_threshold: 70, note: 'Test: stricter review bar' });
    const after = await post();
    expect(after.body.transaction.risk_level).toBe('low');
    expect(after.body.transaction.policy_version).toBe(3);
    expect(after.body.transaction.model_probability).toBeCloseTo(0.3); // unchanged fact
  });
});

// ---- measurement: crafted history with known answers -----------------

async function addTxn({ p, method = 'ml_model', risk, verdict, alert = true, disputed = false }) {
  const { lastInsertRowid } = await transactionRepository.insert({
    user_id: userId, amount: 10, merchant: 'M', category: 'food', location: 'New York, US', card_type: 'credit',
    is_fraud: risk === 'high' ? 1 : 0, fraud_score: p * 100, risk_level: risk, fraud_reasons: [],
    scoring_method: method, model_version: 'v3', model_probability: p, policy_version: 0, status: 'completed',
  });
  if (alert) {
    const { lastInsertRowid: alertId } = await alertRepository.insert({ transaction_id: lastInsertRowid, user_id: userId, message: 'x', risk_level: risk });
    if (verdict) await db.run("UPDATE alerts SET verdict = ?, status = 'resolved', resolved = 1 WHERE id = ?", [verdict, alertId]);
  }
  if (disputed) {
    await db.run('INSERT INTO disputes (transaction_id, amount_disputed, reason) VALUES (?, 10, ?)', [lastInsertRowid, 'unauthorized']);
  }
}
const many = async (n, fn) => { for (let i = 0; i < n; i += 1) await fn(i); };

describe('simulate + calibration on a crafted reviewed history', () => {
  beforeAll(async () => {
    await db.run('DELETE FROM disputes');
    await db.run('DELETE FROM alerts');
    await deleteTransactions();
    await db.run('DELETE FROM risk_policy');
    // 20 @ score 90 (18 fraud / 2 legit), 20 @ 30 (6 / 14), 20 @ 12 (2 / 18)
    await many(20, (i) => addTxn({ p: 0.9, risk: 'high', verdict: i < 18 ? 'confirmed_fraud' : 'false_positive' }));
    await many(20, (i) => addTxn({ p: 0.3, risk: 'medium', verdict: i < 6 ? 'confirmed_fraud' : 'false_positive' }));
    await many(20, (i) => addTxn({ p: 0.12, risk: 'medium', verdict: i < 2 ? 'confirmed_fraud' : 'false_positive' }));
    // never flagged; one later disputed by the customer
    await many(5, (i) => addTxn({ p: 0.02, risk: 'low', alert: false, disputed: i === 0 }));
    // hard-rule overrides: the model said ~1% for all three (2 fraud, 1 legit)
    await many(3, (i) => addTxn({ p: 0.01, method: 'hard_rule_override+ml', risk: 'high', verdict: i < 2 ? 'confirmed_fraud' : 'false_positive' }));
  });

  const simulate = (body) => asAdmin(request(app).post(`${API}/admin/risk-policy/simulate`)).send({ days: 30, ...body });

  test('current policy (default 10/50) vs a candidate (20/60): exact missed-fraud / false-flag counts', async () => {
    const res = await simulate({ medium_threshold: 20, high_threshold: 60 });
    expect(res.status).toBe(200);
    const { current, candidate, delta, population } = res.body;
    expect(population).toMatchObject({ model_scored: 68, hard_rule_overrides: 3, confirmed_fraud: 28, false_positive: 35 });

    expect(current).toMatchObject({ flagged: 63, confirmed_fraud_caught: 28, false_positives: 35, confirmed_fraud_missed: 0, disputed_but_not_flagged: 1 });
    expect(candidate).toMatchObject({ flagged: 43, confirmed_fraud_caught: 26, false_positives: 17, confirmed_fraud_missed: 2 });
    expect(candidate.precision_of_reviewed_flags).toBeCloseTo(26 / 43, 3);
    expect(candidate.recall_of_confirmed_fraud).toBeCloseTo(26 / 28, 3);
    expect(delta).toEqual({ flagged: -20, confirmed_fraud_caught: -2, confirmed_fraud_missed: 2, false_positives: -18 });
    expect(res.body.warnings.join(' ')).not.toMatch(/never reviewed/); // 20 is above the label floor (12)
  });

  test('a sweep over thresholds is returned for plotting the trade-off', async () => {
    const res = await simulate({ medium_threshold: 20, high_threshold: 60 });
    const at = (t) => res.body.sweep.find((s) => s.medium_threshold === t);
    expect(at(10)).toMatchObject({ confirmed_fraud_caught: 28, confirmed_fraud_missed: 0 });
    expect(at(20).confirmed_fraud_missed).toBe(2);
    expect(at(50).confirmed_fraud_caught).toBe(20); // 18 model @90 + 2 override fraud
    expect(at(50).confirmed_fraud_missed).toBe(8);
    expect(at(1).labels_incomplete).toBe(true);
    expect(at(20).labels_incomplete).toBe(false);
  });

  test('lowering the threshold below the lowest reviewed score is flagged as unmeasurable, not guessed', async () => {
    const res = await simulate({ medium_threshold: 1, high_threshold: 60 });
    expect(res.body.label_coverage_floor_score).toBe(12);
    expect(res.body.candidate.newly_flagged_never_reviewed).toBe(5);
    expect(res.body.warnings.join(' ')).toMatch(/CANNOT be estimated/);
  });

  test('warns when the candidate would exceed review capacity, and when labels are scarce', async () => {
    const over = await simulate({ medium_threshold: 10, high_threshold: 50, review_capacity_per_day: 1 });
    expect(over.body.candidate.exceeds_review_capacity).toBe(true);
    expect(over.body.warnings.join(' ')).toMatch(/above the review capacity/);
  });

  test('rejects invalid candidate thresholds', async () => {
    expect((await simulate({ medium_threshold: 0, high_threshold: 50 })).status).toBe(400);
  });

  test('calibration report: predicted vs observed per score bucket, consistent where predictions hold', async () => {
    const res = await asAdmin(request(app).get(`${API}/admin/risk-policy/calibration?days=30`));
    expect(res.status).toBe(200);
    expect(res.body.reviewed_model_alerts).toBe(60);
    const bucket = (r) => res.body.buckets.find((b) => b.score_range === r);
    expect(bucket('80-100')).toMatchObject({ reviewed_alerts: 20, confirmed_fraud: 18, observed_fraud_rate: 0.9, consistent_with_prediction: true });
    expect(bucket('20-40')).toMatchObject({ reviewed_alerts: 20, confirmed_fraud: 6, consistent_with_prediction: true });
    expect(bucket('10-20')).toMatchObject({ reviewed_alerts: 20, confirmed_fraud: 2, consistent_with_prediction: true });
    expect(bucket('0-5').reviewed_alerts).toBe(0); // no labels below the review threshold
    expect(res.body.status).toBe('consistent');
    expect(res.body.coverage_note).toMatch(/from the review threshold upward/);
  });

  test('hard-rule overrides are evaluated separately from the model', async () => {
    const res = await asAdmin(request(app).get(`${API}/admin/risk-policy/calibration?days=30`));
    const paths = res.body.by_decision_path;
    expect(paths.hard_rule_override).toMatchObject({ alerts: 3, confirmed_fraud: 2, false_positives: 1 });
    expect(paths.hard_rule_override.precision_of_reviewed_alerts).toBeCloseTo(2 / 3, 3);
    expect(paths.model).toMatchObject({ alerts: 60, confirmed_fraud: 26, false_positives: 34 });
    expect(res.body.hard_rule_overrides).toMatchObject({
      overrides_with_alert: 3, model_would_not_have_flagged: 3, of_those_confirmed_fraud: 2, of_those_false_positives: 1,
    });
    expect(res.body.unflagged_model_scored_transactions).toMatchObject({ n: 5, customer_disputed: 1 });
  });

  test('when the score stops meaning what it says, the report says so', async () => {
    // 20 more score-90 alerts that turn out to be legitimate -> observed 18/40 = 45% vs predicted 90%
    await many(20, () => addTxn({ p: 0.9, risk: 'high', verdict: 'false_positive' }));
    const res = await asAdmin(request(app).get(`${API}/admin/risk-policy/calibration?days=30`));
    const top = res.body.buckets.find((b) => b.score_range === '80-100');
    expect(top.observed_fraud_rate).toBe(0.45);
    expect(top.consistent_with_prediction).toBe(false);
    expect(res.body.status).toBe('drifting');
  });

  test('with too few reviewed alerts it refuses to claim anything', async () => {
    await db.run('DELETE FROM alerts');
    const res = await asAdmin(request(app).get(`${API}/admin/risk-policy/calibration?days=30`));
    expect(res.body.status).toBe('insufficient_data');
  });
});
