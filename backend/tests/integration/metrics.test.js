const request = require('supertest');
const app = require('../../app');
const { initSchema } = require('../../config/schema');

beforeAll(async () => {
  await initSchema();
});

const API = '/api/v1';
const STRONG_PASSWORD = 'Str0ng!Passw0rd1';

async function registerAndLogin(username) {
  await request(app).post(`${API}/auth/register`).send({ username, email: `${username}@example.com`, password: STRONG_PASSWORD });
  const res = await request(app).post(`${API}/auth/login`).send({ username, password: STRONG_PASSWORD });
  return res.body.accessToken;
}

describe('GET /metrics — observability', () => {
  test('is reachable without authentication', async () => {
    const res = await request(app).get('/metrics');
    expect(res.status).toBe(200);
  });

  test('is not under /api — it is not part of the versioned API surface', async () => {
    const underApi = await request(app).get('/api/v1/metrics');
    expect(underApi.status).toBe(404);
  });

  test('returns Prometheus text-exposition format', async () => {
    const res = await request(app).get('/metrics');
    expect(res.headers['content-type']).toMatch(/text\/plain/);
    expect(res.text).toMatch(/^# HELP/m);
    expect(res.text).toMatch(/^# TYPE/m);
  });

  test('includes default Node.js process metrics', async () => {
    const res = await request(app).get('/metrics');
    expect(res.text).toContain('process_cpu_user_seconds_total');
    expect(res.text).toContain('nodejs_eventloop_lag_seconds');
  });

  test('counts an HTTP request against fraudguard_http_requests_total, labeled by route and status', async () => {
    await request(app).get(`${API}/health`);
    const res = await request(app).get('/metrics');
    expect(res.text).toMatch(/fraudguard_http_requests_total\{[^}]*route="\/api\/v1\/health"[^}]*status="200"[^}]*\}\s+\d+/);
  });

  test('counts a scored transaction against fraudguard_transactions_scored_total, labeled by risk level', async () => {
    const token = await registerAndLogin('metrics_txn_user');
    await request(app).post(`${API}/transactions`).set('Authorization', `Bearer ${token}`)
      .send({ amount: 25, merchant: 'Metrics Cafe', category: 'grocery', location: 'New York, US', card_type: 'credit' });

    const res = await request(app).get('/metrics');
    expect(res.text).toMatch(/fraudguard_transactions_scored_total\{[^}]*risk_level="low"[^}]*\}\s+\d+/);
  });

  test('counts a created alert against fraudguard_alerts_created_total for a medium/high-risk transaction', async () => {
    const token = await registerAndLogin('metrics_alert_user');
    await request(app).post(`${API}/transactions`).set('Authorization', `Bearer ${token}`)
      .set('User-Agent', 'jest-metrics-alert')
      .set('X-Forwarded-For', '10.9.0.1')
      .send({ amount: 5000, merchant: 'Metrics Risky Merchant', category: 'electronics', location: 'Lagos, NG', card_type: 'prepaid' });

    const res = await request(app).get('/metrics');
    expect(res.text).toMatch(/fraudguard_alerts_created_total\{[^}]*risk_level="high"[^}]*\}\s+\d+/);
  });

  test('does not fragment into one label series per transaction id — the route label is the pattern, not the literal path', async () => {
    const token = await registerAndLogin('metrics_route_pattern_user');
    const txnRes = await request(app).post(`${API}/transactions`).set('Authorization', `Bearer ${token}`)
      .send({ amount: 10, merchant: 'Route Label Shop', category: 'grocery', location: 'New York, US', card_type: 'credit' });
    await request(app).get(`${API}/transactions/${txnRes.body.transaction.id}`).set('Authorization', `Bearer ${token}`);

    const res = await request(app).get('/metrics');
    // The matched Express route pattern, not the literal numeric id.
    expect(res.text).toMatch(/route="\/api\/v1\/transactions\/:id"/);
    expect(res.text).not.toContain(`/transactions/${txnRes.body.transaction.id}"`);
  });
});
