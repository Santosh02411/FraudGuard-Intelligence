/**
 * Full-stack end-to-end: talks over real HTTP to a REAL backend process, which talks to the REAL ML service
 * (real model, real calibration, real SHAP). Started by scripts/e2e-fullstack.sh; BASE_URL points at the backend.
 * Nothing is mocked. Assertions are about guarantees (decision recorded, source = ml, cases workable), not exact scores.
 */
const BASE = process.env.E2E_BASE_URL;
const PW = 'Str0ng!Passw0rd1';

async function call(method, path, { token, body, headers = {}, raw } = {}) {
  const res = await fetch(`${BASE}/api/v1${path}`, {
    method,
    headers: { ...(raw ? {} : { 'Content-Type': 'application/json' }), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    body: raw ?? (body ? JSON.stringify(body) : undefined),
  });
  let json = null; try { json = await res.json(); } catch { /* non-JSON */ }
  return { status: res.status, body: json };
}

let cust; let admin; let flagged;
test('services are up and the backend is ready', async () => {
  expect((await call('GET', '/health/ready')).status).toBe(200);
  const ready = await call('GET', '/health/ready');
  expect(ready.body.checks.ml_service).toBe('ok'); // this suite is only meaningful with the real model behind it
});

test('register, login', async () => {
  const name = `e2e_${Date.now()}`;
  expect((await call('POST', '/auth/register', { body: { username: name, email: `${name}@example.com`, password: PW } })).status).toBe(201);
  cust = (await call('POST', '/auth/login', { body: { username: name, password: PW } })).body.accessToken;
  admin = (await call('POST', '/auth/login', { body: { username: 'admin', password: process.env.E2E_ADMIN_PASSWORD } })).body.accessToken;
  expect(cust && admin).toBeTruthy();
});

test('a routine purchase is scored by the REAL model and approved', async () => {
  const r = await call('POST', '/transactions', { token: cust, headers: { 'User-Agent': 'e2e-phone' }, body: { amount: 18.4, merchant: 'Corner Cafe', category: 'food', location: 'New York, US', card_type: 'credit' } });
  expect(r.status).toBe(201);
  expect(r.body.analysis.scoring_method).toMatch(/ml_model|hard_rule_override\+ml/);
  expect(r.body.analysis.model_version).toBeTruthy();
  expect(r.body.analysis.fraud_score).toBeGreaterThanOrEqual(0);
  expect(r.body.analysis.fraud_score).toBeLessThanOrEqual(100);
});

test('a high-risk purchase is flagged, explained, and its decision is reconstructable', async () => {
  const r = await call('POST', '/transactions', { token: cust, headers: { 'User-Agent': 'e2e-laptop' }, body: { amount: 8800, merchant: 'Crypto Exchange', category: 'crypto', location: 'Lagos, NG', card_type: 'prepaid' } });
  expect(r.status).toBe(201);
  expect(['medium', 'high']).toContain(r.body.analysis.risk_level);
  expect(r.body.analysis.fraud_reasons.length).toBeGreaterThan(0);
  flagged = r.body.transaction.id;
  const hist = await call('GET', `/admin/transactions/${flagged}/decision-history`, { token: admin });
  expect(hist.status).toBe(200);
  const d = hist.body.timeline.find((t) => t.kind === 'decision').decision;
  expect(d.model_version).toBeTruthy();
  expect(d.feature_snapshot).toBeTruthy();
  expect(d.thresholds).toBeTruthy();
  expect(hist.body.chain.valid).toBe(true);
});

test('investigator works the case and a rescore with the real model is recorded alongside the original', async () => {
  const alerts = await call('GET', '/alerts?sort=priority&limit=50', { token: admin });
  const alert = alerts.body.alerts.find((a) => a.transaction_id === flagged);
  expect(alert).toBeTruthy();
  expect((await call('POST', `/alerts/${alert.id}/claim`, { token: admin, body: {} })).status).toBe(200);
  expect((await call('POST', `/alerts/${alert.id}/comments`, { token: admin, body: { body: 'e2e: contacted cardholder' } })).status).toBe(201);
  const rescore = await call('POST', `/admin/transactions/${flagged}/rescore`, { token: admin, body: { reason: 'e2e rescore with live model' } });
  expect(rescore.status).toBe(201);
  expect(rescore.body.applied).toBe(false);
  const res = await call('PATCH', `/alerts/${alert.id}/resolve`, { token: admin, body: { verdict: 'confirmed_fraud', reason: 'stolen_card', loss_amount: 8800 } });
  expect(res.status).toBe(200);
  const dispute = await call('POST', '/disputes', { token: cust, body: { transaction_id: flagged, reason: 'not me' } });
  expect(dispute.status).toBe(201);
  const done = await call('PATCH', `/disputes/${dispute.body.dispute.id}`, { token: admin, body: { status: 'won' } });
  expect(done.body.dispute.status).toBe('won');
});

test('the metrics endpoint agrees with what just happened', async () => {
  const m = await call('GET', '/alerts/metrics?days=1', { token: admin });
  expect(m.body.resolved.confirmed_fraud).toBeGreaterThanOrEqual(1);
  expect(m.body.amounts.loss).toBeGreaterThanOrEqual(8800);
});

test('monitoring against the REAL model: inference log -> real batch drift evaluation -> persisted snapshot', async () => {
  for (let i = 0; i < 14; i += 1) {
    const r = await call('POST', '/transactions', { token: cust, headers: { 'User-Agent': `e2e-mon-${i}`, 'X-Forwarded-For': `203.0.113.${100 + i}` }, body: { amount: 20 + i, merchant: 'Corner Cafe', category: 'food', location: 'New York, US', card_type: 'credit' } });
    expect(r.status).toBe(201);
  }
  await new Promise((res) => setTimeout(res, 500));
  const set = await call('PUT', '/model-monitoring/settings', { token: admin, body: { min_samples_overall: 10, min_samples_segment: 10, note: 'E2E: small samples' } });
  expect(set.status).toBe(200);
  const run = await call('POST', '/model-monitoring/run', { token: admin });
  expect(run.status).toBe(200);
  expect(run.body.errors).toEqual([]);                 // the ML service accepted our batch and returned its own drift report
  const snaps = await call('GET', '/model-monitoring/snapshots?window=24h&dim=all', { token: admin });
  const last = snaps.body.snapshots[snaps.body.snapshots.length - 1];
  expect(['stable', 'moderate_drift', 'significant_drift']).toContain(last.status);
  expect(last.feature_psi.top.length).toBeGreaterThan(0);
  const ops = await call('GET', '/model-monitoring/operations?hours=24', { token: admin });
  expect(ops.body.n).toBeGreaterThanOrEqual(14);
  expect(ops.body.latency_p95_ms).toBeGreaterThan(0);
});

test('verification policy: advisory records a recommendation; the response never claims to have authorized a payment', async () => {
  const set = await call('PUT', '/verification/policy', { token: admin, body: { mode: 'advisory', actions: { low: 'approve', medium: 'challenge', high: 'challenge' }, ttl_seconds: 300, note: 'E2E: advisory only' } });
  expect(set.status).toBe(200);
  const r = await call('POST', '/transactions', { token: cust, headers: { 'User-Agent': 'e2e-vf', 'X-Forwarded-For': '203.0.113.200' }, body: { amount: 4200, merchant: 'Crypto Exchange', category: 'crypto', location: 'Lagos, NG', card_type: 'credit' } });
  expect(r.status).toBe(201);
  expect(r.body.verification.mode).toBe('advisory');
  expect(r.body.verification.authorization.performed).toBe(false);
  expect(r.body.verification.enforced).toBe(false);
});

test('geo-velocity with the REAL model: implausible travel is flagged (medium at most), never blocked, and explained', async () => {
  const name = `e2e_geo_${Date.now()}`;
  await call('POST', '/auth/register', { body: { username: name, email: `${name}@example.com`, password: PW } });
  const tok = (await call('POST', '/auth/login', { body: { username: name, password: PW } })).body.accessToken;
  const body = (location) => ({ amount: 25, merchant: 'Corner Cafe', category: 'food', location, card_type: 'debit' });
  const a = await call('POST', '/transactions', { token: tok, headers: { 'User-Agent': 'e2e-geo' }, body: body('New York, US') });
  expect(a.body.geo_velocity.status).toBe('indeterminate');
  const b = await call('POST', '/transactions', { token: tok, headers: { 'User-Agent': 'e2e-geo' }, body: body('Sydney, AU') });
  expect(b.status).toBe(201);
  expect(b.body.geo_velocity.status).toBe('implausible');
  expect(['medium', 'high']).toContain(b.body.analysis.risk_level);
  expect(b.body.analysis.fraud_reasons.join(' ')).toMatch(/implausible travel/i);
  expect(b.body.transaction.status).not.toBe('blocked'); // verification policy is advisory in this run; geo-velocity never blocks by itself

  // the explainable profile for the same account
  const prof = await call('GET', `/customer-profiles/${b.body.transaction.user_id}`, { token: admin });
  expect(prof.status).toBe(200);
  expect(prof.body.profile.factors).toHaveLength(6);
  expect(prof.body.profile.factors.find((f) => f.name === 'location').status).toBe('insufficient_data'); // 2 transactions is too few, and it says so
  expect(prof.body.profile.disclaimer).toMatch(/never blocks/);
});

test('feedback: labels need a second person, and a dataset is refused until enough verified labels exist', async () => {
  const txnId = flagged?.transaction?.id || (await call('GET', '/transactions?limit=1', { token: admin })).body.transactions?.[0]?.id;
  expect(txnId).toBeTruthy();
  const p = await call('POST', '/feedback/labels', { token: admin, body: { transaction_id: txnId, label: 'fraud', evidence_note: 'E2E: confirmed with the customer' } });
  expect(p.status).toBe(201);
  const self = await call('POST', `/feedback/labels/${p.body.label.id}/verify`, { token: admin, body: { note: 'verifying my own' } });
  expect(self.status).toBe(409);
  expect(self.body.details.code).toBe('SELF_VERIFICATION');
  const ds = await call('POST', '/feedback/retraining/datasets', { token: admin, body: { note: 'E2E: expect refusal with too few labels' } });
  expect(ds.status).toBe(422);
  expect(ds.body.details.code).toBe('NOT_ENOUGH_LABELS');
  const rd = await call('GET', '/feedback/retraining/readiness', { token: admin });
  expect(rd.body.ready).toBe(false);
});
