const request = require('supertest');
const app = require('../../app');
const { initSchema } = require('../../config/schema');

beforeAll(async () => {
  await initSchema();
});

const API = '/api/v1';

async function registerAndLogin(username) {
  const password = 'Str0ng!Passw0rd1';
  await request(app).post(`${API}/auth/register`).send({ username, email: `${username}@example.com`, password });
  const res = await request(app).post(`${API}/auth/login`).send({ username, password });
  return res.body.accessToken;
}

async function loginAdmin() {
  const res = await request(app).post(`${API}/auth/login`).send({ username: 'admin', password: 'admin123' });
  return res.body.accessToken;
}

// Every account in this file needs its own User-Agent/IP — otherwise
// every request shares supertest's default identifiers, which the
// fraud-ring/network-risk signal treats as one shared device+IP across
// every account created in this file, escalating scores unpredictably
// as the file's test count grows (see tests/integration/stepUp.test.js's
// header for the full explanation).
function postBulk(token, transactions, id) {
  return request(app).post(`${API}/transactions/bulk`)
    .set('Authorization', `Bearer ${token}`)
    .set('User-Agent', `ua-bulk-${id}`).set('X-Forwarded-For', `203.0.113.${id}`)
    .send({ transactions });
}

const LOW_RISK = { amount: 20, merchant: 'Corner Cafe', category: 'food', location: 'New York, US', card_type: 'credit' };
const HIGH_RISK = { amount: 5000, merchant: 'Some Shop', category: 'electronics', location: 'Lagos, NG', card_type: 'prepaid' };

describe('POST /transactions/bulk', () => {
  test('requires authentication', async () => {
    const res = await request(app).post(`${API}/transactions/bulk`).send({ transactions: [LOW_RISK] });
    expect(res.status).toBe(401);
  });

  test('rejects an empty array', async () => {
    const token = await registerAndLogin('bulk_empty');
    const res = await postBulk(token, [], 1);
    expect(res.status).toBe(400);
  });

  test('rejects more than 50 rows', async () => {
    const token = await registerAndLogin('bulk_toomany');
    const res = await postBulk(token, Array(51).fill(LOW_RISK), 2);
    expect(res.status).toBe(400);
  });

  test('a malformed row fails the whole request — nothing is created', async () => {
    const token = await registerAndLogin('bulk_malformed');
    const res = await postBulk(token, [LOW_RISK, { ...LOW_RISK, category: 'not-a-real-category' }], 3);
    expect(res.status).toBe(400);

    const list = await request(app).get(`${API}/transactions`).set('Authorization', `Bearer ${token}`);
    expect(list.body.transactions.length).toBe(0);
  });

  test('scores a mix of low and high risk rows, with a per-row result and an accurate summary', async () => {
    const token = await registerAndLogin('bulk_mixed');
    const res = await postBulk(token, [LOW_RISK, HIGH_RISK, LOW_RISK], 4);

    expect(res.status).toBe(201);
    expect(res.body.summary.total).toBe(3);
    expect(res.body.summary.completed).toBe(3);
    expect(res.body.summary.held_for_step_up).toBe(0);
    expect(res.body.summary.failed).toBe(0);
    // At least the HIGH_RISK row is flagged — the third row may also
    // trend riskier than the first purely from being 3rd-in-a-row (see
    // the velocity test below), so this doesn't assert an exact count.
    expect(res.body.summary.flagged).toBeGreaterThanOrEqual(1);
    expect(res.body.results).toHaveLength(3);
    expect(res.body.results[0].analysis.risk_level).toBe('low'); // first-ever transaction, no history yet
    expect(res.body.results[1].analysis.risk_level).toBe('high');
    expect(res.body.results[1].transaction.merchant).toBe('Some Shop');
    expect(res.body.results.every(r => typeof r.index === 'number')).toBe(true);
  });

  test('flagged rows create real alerts, same as a single POST would', async () => {
    const token = await registerAndLogin('bulk_alerts');
    const res = await postBulk(token, [HIGH_RISK], 5);
    const txnId = res.body.results[0].transaction.id;

    const alerts = await request(app).get(`${API}/alerts`).set('Authorization', `Bearer ${token}`);
    expect(alerts.body.alerts.some(a => a.transaction_id === txnId)).toBe(true);
  });

  test('bulk import is audit-logged even for a human session (not just API-key callers)', async () => {
    const token = await registerAndLogin('bulk_audit');
    const adminToken = await loginAdmin();
    await postBulk(token, [LOW_RISK, LOW_RISK], 6);

    const logs = await request(app).get(`${API}/admin/audit-logs`).query({ action: 'transactions.bulk_create' }).set('Authorization', `Bearer ${adminToken}`);
    expect(logs.status).toBe(200);
    const entry = logs.body.logs.find(l => l.username === 'bulk_audit');
    expect(entry).toBeDefined();
    expect(entry.details.rowCount).toBe(2);
  });

  test('a subscribed webhook still routes a medium-risk row into step-up, counted in the summary', async () => {
    const token = await registerAndLogin('bulk_stepup');
    await request(app).post(`${API}/webhooks`).set('Authorization', `Bearer ${token}`)
      .send({ url: 'https://example.com/hook', events: ['transaction.step_up_required'] });

    // Same medium-risk recipe as tests/integration/stepUp.test.js: amount
    // over the $1,500 threshold (+20) plus a high-risk category (+25) = 45.
    const MEDIUM_RISK = { amount: 2000, merchant: 'Bet365', category: 'gambling', location: 'New York, US', card_type: 'credit' };
    const res = await postBulk(token, [MEDIUM_RISK], 7);

    expect(res.status).toBe(201);
    expect(res.body.summary.held_for_step_up).toBe(1);
    expect(res.body.results[0].transaction.status).toBe('pending_step_up');
    expect(res.body.results[0].step_up.required).toBe(true);
  });

  test('rows are scored in order, each seeing the ones before it in the same batch', async () => {
    // Five transactions in quick succession from the same new account is
    // itself a velocity signal the rule-engine fallback picks up on — so
    // later rows in one batch should trend riskier than the first.
    const token = await registerAndLogin('bulk_velocity');
    const res = await postBulk(token, Array(5).fill(LOW_RISK), 8);

    expect(res.status).toBe(201);
    expect(res.body.results).toHaveLength(5);
    const lastScore = res.body.results[4].analysis.fraud_score;
    const firstScore = res.body.results[0].analysis.fraud_score;
    expect(lastScore).toBeGreaterThanOrEqual(firstScore);
  });
});
