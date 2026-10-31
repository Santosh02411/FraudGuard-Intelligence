/**
 * The ML service is a dependency that WILL misbehave. These tests run the REAL mlClient against a stub
 * HTTP server that hangs, errors, lies, and drops connections, and assert the guarantee: a transaction
 * is always decided (rule-engine fallback), quickly, and the failure is recorded for audit.
 */
const http = require('http');
const request = require('supertest');

let stub; let stubPort; let behaviour = 'ok'; let calls = 0;
let app; let db; let token; let n = 0;
const API = '/api/v1';

function startStub() {
  return new Promise((resolve) => {
    stub = http.createServer((req, res) => {
      if (req.url.startsWith('/health')) { res.end('{}'); return; }
      calls += 1;
      req.resume();
      req.on('end', () => {
        switch (behaviour) {
          case 'ok': res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ fraud_score: 5, fraud_probability: 0.05, calibrated: true, model_used: 'xgb', model_version: 'stub-1', top_factors: [] })); break;
          case 'hang': break; // never answers
          case '500': res.statusCode = 500; res.end('boom'); break;
          case 'garbage': res.end('<html>not json</html>'); break;
          case 'empty-json': res.setHeader('content-type', 'application/json'); res.end('{}'); break;
          case 'bad-score': res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ fraud_score: 'high', fraud_probability: null })); break;
          case 'out-of-range': res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ fraud_score: 450, fraud_probability: 4.5 })); break;
          case 'reset': req.socket.destroy(); break;
          default: res.end('{}');
        }
      });
    });
    stub.listen(0, '127.0.0.1', () => { stubPort = stub.address().port; resolve(); });
  });
}

beforeAll(async () => {
  await startStub();
  process.env.ML_SERVICE_URL = `http://127.0.0.1:${stubPort}`;
  process.env.ML_SERVICE_TIMEOUT_MS = '400';
  app = require('../../app');
  db = require('../../config/database');
  await require('../../config/schema').initSchema();
  await request(app).post(`${API}/auth/register`).send({ username: 'mlf', email: 'mlf@example.com', password: 'Str0ng!Passw0rd1' });
  token = (await request(app).post(`${API}/auth/login`).send({ username: 'mlf', password: 'Str0ng!Passw0rd1' })).body.accessToken;
});
afterAll(async () => { stub.closeAllConnections?.(); await new Promise((r) => stub.close(r)); });
beforeEach(() => { calls = 0; });

async function post(body = {}) {
  n += 1;
  const t0 = Date.now();
  const res = await request(app).post(`${API}/transactions`).set('Authorization', `Bearer ${token}`).set('User-Agent', `mlf${n}`)
    .send({ amount: 50, merchant: 'Cafe', category: 'food', location: 'New York, US', card_type: 'credit', ...body });
  return { res, ms: Date.now() - t0 };
}
const decision = async (txnId) => db.get('SELECT decision_source, scoring_method, context FROM decision_records WHERE transaction_id = ?', [txnId]);

test('healthy ML: scored by the model', async () => {
  behaviour = 'ok';
  const { res } = await post();
  expect(res.status).toBe(201);
  expect(res.body.analysis.scoring_method).toMatch(/ml/);
  expect(res.body.analysis.model_version).toBe('stub-1');
});

test('ML hangs: the request is still decided by the rule engine, within the timeout budget', async () => {
  behaviour = 'hang';
  const { res, ms } = await post();
  expect(res.status).toBe(201);
  expect(res.body.analysis.scoring_method).toBe('rule_engine_fallback');
  expect(ms).toBeLessThan(2500); // 400 ms timeout + processing; not the 30 s a hung socket would otherwise cost
  const d = await decision(res.body.transaction.id);
  expect(d.decision_source).toBe('fallback');
  expect(JSON.parse(d.context).ml.status).toBe('unavailable');
});

test.each(['500', 'garbage', 'empty-json', 'bad-score', 'out-of-range', 'reset'])('ML misbehaves (%s): fallback, never an invalid score', async (mode) => {
  behaviour = mode;
  const { res } = await post();
  expect(res.status).toBe(201);
  expect(res.body.analysis.scoring_method).toBe('rule_engine_fallback');
  expect(Number.isFinite(res.body.analysis.fraud_score)).toBe(true);
  expect(res.body.analysis.fraud_score).toBeGreaterThanOrEqual(0);
  expect(res.body.analysis.fraud_score).toBeLessThanOrEqual(100);
  expect(['low', 'medium', 'high']).toContain(res.body.analysis.risk_level);
  expect(calls).toBeGreaterThan(0);
});

test('a burst of transactions during an ML outage all complete, none hang the server', async () => {
  behaviour = 'hang';
  const t0 = Date.now();
  const results = await Promise.all(Array.from({ length: 15 }, () => post()));
  expect(results.every((r) => r.res.status === 201)).toBe(true);
  expect(Date.now() - t0).toBeLessThan(6000); // concurrent timeouts overlap; they do not queue serially
});

test('recovery: when ML returns, scoring goes back to the model without a restart', async () => {
  behaviour = 'ok';
  const { res } = await post();
  expect(res.body.analysis.model_version).toBe('stub-1');
});

test('rescoring is refused (not faked) while ML is down', async () => {
  behaviour = 'ok';
  await request(app).post(`${API}/auth/register`).send({ username: 'mlf2', email: 'mlf2@example.com', password: 'Str0ng!Passw0rd1' });
  const t2 = (await request(app).post(`${API}/auth/login`).send({ username: 'mlf2', password: 'Str0ng!Passw0rd1' })).body.accessToken;
  const created = { body: (await request(app).post(`${API}/transactions`).set('Authorization', `Bearer ${t2}`).set('User-Agent', 'fresh-dev').send({ amount: 20, merchant: 'Cafe', category: 'food', location: 'New York, US', card_type: 'credit' })).body };
  behaviour = '500';
  const admin = (await request(app).post(`${API}/auth/login`).send({ username: 'admin', password: 'admin123' })).body.accessToken;
  const r = await request(app).post(`${API}/admin/transactions/${created.body.transaction.id}/rescore`).set('Authorization', `Bearer ${admin}`).send({ reason: 'ML is down, should refuse' });
  expect(r.status).toBe(503);
  const count = Number((await db.get('SELECT COUNT(*) n FROM decision_records WHERE transaction_id = ?', [created.body.transaction.id])).n);
  expect(count).toBe(1);
});

// Last on purpose: a hard-rule fraud decision puts this test IP on the dynamic blacklist for everything after it.
test('hard rules still decide while ML is down', async () => {
  behaviour = 'hang';
  const { res } = await post({ amount: 99999, category: 'crypto', location: 'Lagos, NG', card_type: 'prepaid' });
  expect(res.status).toBe(201);
  expect(['high', 'medium']).toContain(res.body.analysis.risk_level);
});
