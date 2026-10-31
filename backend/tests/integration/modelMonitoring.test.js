/** Persistent drift monitoring: durable log, windowed + segmented snapshots, alert lifecycle, operational metrics, quality context. */
jest.mock('../../models/mlClient');
jest.mock('../../services/mlAdminClient', () => ({
  listVersions: jest.fn(),
  getBaseline: jest.fn(),
  evaluateDrift: jest.fn(),
  getShadowStatus: jest.fn(),
}));
const request = require('supertest');
const app = require('../../app');
const db = require('../../config/database');
const { initSchema } = require('../../config/schema');
const ml = require('../../services/mlAdminClient');
const inferenceLog = require('../../services/inferenceLog');

const API = '/api/v1/model-monitoring';
const A = (t) => ({ Authorization: `Bearer ${t}` });
let admin; let userTok;

const BASELINE = { score: { hist: [0.5, 0.3, 0.1, 0.05, 0.05], hist_edges: [0, 10, 25, 50, 75, 100.0001] } };

// Fake ML drift: a batch of large amounts is "drifted", otherwise calm. Stands in for utils/drift.py (tested in ml_service/tests).
function fakeDrift({ rows, scores }) {
  const mean = rows.reduce((a, r) => a + r.amount, 0) / rows.length;
  const drifted = mean > 1000;
  return Promise.resolve({
    status: drifted ? 'significant_drift' : 'stable', n_samples: rows.length,
    feature_psi: drifted ? { amount: 0.42, log_amount: 0.31, velocity_last_hour: 0.02 } : { amount: 0.03, log_amount: 0.02, velocity_last_hour: 0.01 },
    score_drift: { baseline_mean_score: 8, live_mean_score: scores.reduce((a, b) => a + b, 0) / scores.length, baseline_high_risk_rate: 0.04, live_high_risk_rate: 0.05 },
    unseen_category_rows: {},
  });
}

let seq = 0;
// a score mix that roughly matches BASELINE.score.hist, so calm traffic has a small score PSI
const SCORE_MIX = [2, 3, 4, 5, 6, 7, 8, 9, 9.5, 1, 12, 14, 16, 18, 22, 24, 30, 60, 85, 55];
async function log({ minsAgo = 30, outcome = 'ok', amount = 40, score, category = 'food', card = 'credit', device = 'known_device', missing = [], unseen = {}, latency = 40, version = 'v3', band }) {
  seq += 1;
  score = score === undefined ? SCORE_MIX[seq % SCORE_MIX.length] : score;
  const at = new Date(Date.now() - minsAgo * 60000 - seq).toISOString();
  const features = { amount, category, velocity_last_hour: 0, is_new_device: device === 'new_device' ? 1 : 0 };
  await db.run(
    `INSERT INTO model_inference_log (transaction_id, created_at, model_version, outcome, latency_ms, score, features, missing, unseen, seg_category, seg_amount_band, seg_card_type, seg_device)
     VALUES (NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [at, outcome === 'ok' ? version : null, outcome, latency, outcome === 'ok' ? score : null, JSON.stringify(features), JSON.stringify(missing), JSON.stringify(unseen), category, band || inferenceLog.amountBand(amount), card, device]);
}
const many = (n, o) => Promise.all(Array.from({ length: n }, () => log(o)));
const clearLog = () => db.exec('DELETE FROM model_inference_log');
const alerts = async (state = 'open') => (await request(app).get(`${API}/alerts?state=${state}`).set(A(admin))).body.alerts;

beforeAll(async () => {
  await initSchema();
  admin = (await request(app).post('/api/v1/auth/login').send({ username: 'admin', password: 'admin123' })).body.accessToken;
  await request(app).post('/api/v1/auth/register').send({ username: 'mm_user', email: 'mm@example.com', password: 'Str0ng!Passw0rd1' });
  userTok = (await request(app).post('/api/v1/auth/login').send({ username: 'mm_user', password: 'Str0ng!Passw0rd1' })).body.accessToken;
  await request(app).put(`${API}/settings`).set(A(admin)).send({ min_samples_overall: 20, min_samples_segment: 12, score_psi_warn: 2, score_psi_critical: 5, note: 'Small samples for tests' });
});
beforeEach(() => {
  jest.clearAllMocks();
  ml.listVersions.mockResolvedValue({ active: 'v3' });
  ml.getBaseline.mockResolvedValue(BASELINE);
  ml.evaluateDrift.mockImplementation(fakeDrift);
  ml.getShadowStatus.mockResolvedValue({ active: false });
});

test('admin only', async () => {
  expect((await request(app).get(`${API}/overview`)).status).toBe(401);
  expect((await request(app).get(`${API}/overview`).set(A(userTok))).status).toBe(403);
  expect((await request(app).post(`${API}/run`).set(A(userTok))).status).toBe(403);
});

describe('durable inference log', () => {
  test('records success vs each failure class, missing/defaulted inputs, unseen categories and segments — without PII', () => {
    const base = { transactionId: 1, txn: { category: 'crypto', amount: 2500, card_type: 'debit' } };
    const ok = inferenceLog.buildRecord({ ...base, analysis: { model_version: 'v3', model_probability: 0.123, fraud_score: 12.3, scoring_method: 'ml_model', ml_latency_ms: 41, feature_snapshot: { amount: 2500, hour: NaN, is_new_device: 1 }, ml_feature_quality: { defaulted: ['day_of_week'], unseen_categories: { category: 'crypto' } } } });
    expect(ok).toMatchObject({ outcome: 'ok', model_version: 'v3', score: 12.3, seg_category: 'crypto', seg_amount_band: '2000_plus', seg_card_type: 'debit', seg_device: 'new_device' });
    expect(JSON.parse(ok.missing)).toEqual(['day_of_week', 'hour']);
    expect(JSON.parse(ok.unseen)).toEqual({ category: 'crypto' });
    for (const kind of ['timeout', 'unreachable', 'http_error', 'invalid_score']) {
      const f = inferenceLog.buildRecord({ ...base, analysis: { ml_error: 'x', ml_error_kind: kind, ml_latency_ms: 5000, feature_snapshot: { amount: 1 } } });
      expect(f).toMatchObject({ outcome: kind, model_version: null, score: null });
    }
    expect(JSON.stringify(ok)).not.toMatch(/ip_address|device_fingerprint|user_id/);
  });

  test('a real transaction writes a row (here: ML unavailable -> failure row), best-effort', async () => {
    const r = await request(app).post('/api/v1/transactions').set(A(userTok)).send({ amount: 30, merchant: 'Cafe', category: 'food', location: 'New York, US', card_type: 'credit' });
    expect(r.status).toBe(201);
    await new Promise((res) => setTimeout(res, 50));
    const row = await db.get('SELECT * FROM model_inference_log WHERE transaction_id = ?', [r.body.transaction.id]);
    expect(row).toBeTruthy();
    expect(row.outcome).not.toBe('ok');
    expect(row.seg_category).toBe('food');
  });
});

describe('operational metrics', () => {
  beforeAll(clearLog);
  test('latency, failure/fallback rates by kind, missing inputs and unseen categories, hourly series', async () => {
    await many(8, { latency: 30 }); await many(2, { latency: 400 });
    await many(2, { outcome: 'timeout', latency: 5000 }); await many(1, { outcome: 'http_error', latency: 20 });
    await many(3, { missing: ['hour'], unseen: { category: 'space_tourism' } });
    const o = (await request(app).get(`${API}/operations?hours=24`).set(A(admin))).body;
    expect(o.n).toBe(16); expect(o.prediction_failures).toBe(3);
    expect(o.failure_rate).toBeCloseTo(3 / 16, 4); expect(o.fallback_rate).toBeCloseTo(3 / 16, 4);
    expect(o.failures_by_kind).toEqual({ timeout: 2, http_error: 1 });
    expect(o.latency_p95_ms).toBeGreaterThanOrEqual(400);
    expect(o.missing_inferences).toBe(3);
    expect(o.top_missing_fields[0]).toMatchObject({ name: 'hour', count: 3 });
    expect(o.unseen_categories[0].name).toBe('category=space_tourism');
    expect(o.series.length).toBeGreaterThan(0);
  });
});

describe('snapshots, segments, alerts', () => {
  beforeEach(async () => { await clearLog(); await db.exec('DELETE FROM drift_snapshots'); await db.exec('DELETE FROM model_health_events'); });

  test('calm traffic: persisted stable snapshots, no alerts', async () => {
    await many(30, { amount: 40, category: 'food' }); await many(15, { amount: 60, category: 'grocery' });
    const s = (await request(app).post(`${API}/run`).set(A(admin))).body;
    expect(s.errors).toEqual([]); expect(s.snapshots).toBeGreaterThan(2);
    expect(await alerts()).toEqual([]);
    const snaps = (await request(app).get(`${API}/snapshots?window=24h&dim=all`).set(A(admin))).body.snapshots;
    expect(snaps).toHaveLength(1); expect(snaps[0]).toMatchObject({ status: 'stable', segment_dim: 'all', n: 45 });
    expect(snaps[0].feature_psi.top[0].feature).toBe('amount');
    const seg = (await request(app).get(`${API}/segments?window=24h`).set(A(admin))).body.segments;
    expect(seg.find((x) => x.segment_dim === 'category' && x.segment_value === 'food')).toMatchObject({ status: 'stable', n: 30 });
  });

  test('drift confined to one segment alerts for THAT segment (and overall only if it is large enough to move it)', async () => {
    await many(60, { amount: 40, category: 'food' });
    await many(14, { amount: 5000, category: 'crypto', score: 70 });
    const s = (await request(app).post(`${API}/run`).set(A(admin))).body;
    expect(s.alerts_opened).toBeGreaterThan(0);
    const open = await alerts();
    const seg = open.find((a) => a.scope === '24h|category=crypto' && a.trigger_name === 'drift_features');
    expect(seg).toBeTruthy();
    expect(seg.severity).toBe('critical');
    expect(seg.details.kind).toBe('input_shift');
    expect(seg.details.interpretation).toMatch(/not proof that accuracy has fallen/);
    expect(seg.details.top_features[0].feature).toBe('amount');
    expect(open.find((a) => a.scope === '24h|category=food')).toBeUndefined();
    expect(seg.action_taken).toBe('none');                        // monitoring never rolls a model back by itself
  });

  test('repeat runs update, not duplicate; recovery clears; acknowledgement is once-only', async () => {
    await many(14, { amount: 5000, category: 'crypto', score: 70 }); await many(40, { amount: 40, category: 'food' });
    await request(app).post(`${API}/run`).set(A(admin));
    const first = (await alerts()).filter((a) => a.trigger_name === 'drift_features' && a.scope === '24h|category=crypto');
    await request(app).post(`${API}/run`).set(A(admin));
    const second = (await alerts()).filter((a) => a.trigger_name === 'drift_features' && a.scope === '24h|category=crypto');
    expect(first).toHaveLength(1); expect(second).toHaveLength(1); expect(second[0].id).toBe(first[0].id);

    const ack = await request(app).post(`${API}/alerts/${first[0].id}/acknowledge`).set(A(admin)).send({ note: 'Looking into the crypto promo' });
    expect(ack.status).toBe(200);
    expect((await request(app).post(`${API}/alerts/${first[0].id}/acknowledge`).set(A(admin)).send({ note: 'again again' })).status).toBe(409);
    expect((await alerts()).find((a) => a.id === first[0].id)).toMatchObject({ acknowledged: true });

    await db.run("DELETE FROM model_inference_log WHERE seg_category = 'crypto'");
    await many(14, { amount: 45, category: 'crypto' });
    const s = (await request(app).post(`${API}/run`).set(A(admin))).body;
    expect(s.alerts_cleared).toBeGreaterThan(0);
    expect((await alerts()).find((a) => a.id === first[0].id)).toBeUndefined();
    const all = await alerts('all');
    expect(all.find((a) => a.id === first[0].id).resolved_at).toBeTruthy();
    expect((await request(app).post(`${API}/alerts/${first[0].id}/acknowledge`).set(A(admin)).send({ note: 'too late now' })).status).toBe(409);
  });

  test('too little data in a segment: no judgement, no alert; overall records insufficient_data', async () => {
    await many(5, { amount: 5000, category: 'crypto' });
    await request(app).post(`${API}/run`).set(A(admin));
    expect(await alerts()).toEqual([]);
    const snaps = (await request(app).get(`${API}/snapshots?window=24h&dim=all`).set(A(admin))).body.snapshots;
    expect(snaps[0].status).toBe('insufficient_data');
    expect(ml.evaluateDrift).not.toHaveBeenCalled();
  });

  test('windows are independent: old traffic drives the 7d window only', async () => {
    await many(30, { amount: 5000, category: 'crypto', minsAgo: 3 * 24 * 60 });   // 3 days ago
    await many(30, { amount: 40, category: 'food', minsAgo: 20 });
    await request(app).post(`${API}/run`).set(A(admin));
    const day = (await request(app).get(`${API}/snapshots?window=24h&dim=all`).set(A(admin))).body.snapshots[0];
    const week = (await request(app).get(`${API}/snapshots?window=7d&dim=all`).set(A(admin))).body.snapshots[0];
    expect(day.status).toBe('stable');
    expect(['moderate_drift', 'significant_drift']).toContain(week.status);
  });

  test('score-distribution drift has its own configurable thresholds', async () => {
    await request(app).put(`${API}/settings`).set(A(admin)).send({ score_psi_warn: 0.1, score_psi_critical: 0.25, note: 'Tighten score drift' });
    await many(30, { amount: 40, category: 'food', score: 95 });                  // everything scored very high vs a baseline of mostly low scores
    await request(app).post(`${API}/run`).set(A(admin));
    const a = (await alerts()).find((x) => x.trigger_name === 'drift_score' && x.scope === '24h|all=all');
    expect(a).toMatchObject({ severity: 'critical' });
    expect(a.details.live_mean_score).toBeCloseTo(95, 0);
    await request(app).put(`${API}/settings`).set(A(admin)).send({ score_psi_warn: 2, score_psi_critical: 5, note: 'Relax score drift again' });
  });

  test('missing/defaulted inputs raise a data-quality alert naming the fields', async () => {
    await many(30, { missing: ['hour', 'distance_from_home'], unseen: { category: 'space_tourism' } }); await many(10, {});
    await request(app).post(`${API}/run`).set(A(admin));
    const a = (await alerts()).find((x) => x.trigger_name === 'missing_features' && x.scope === '24h|all=all');
    expect(a).toMatchObject({ severity: 'critical', scope: '24h|all=all' });
    expect(a.details.top_missing_fields.map((f) => f.name)).toEqual(expect.arrayContaining(['hour', 'distance_from_home']));
    expect(a.details.kind).toBe('data_quality');
  });

  test('thresholds are configurable and persisted: raising the critical PSI downgrades severity; invalid settings are refused', async () => {
    await many(30, { amount: 5000, category: 'crypto', score: 70 });
    const bad = await request(app).put(`${API}/settings`).set(A(admin)).send({ psi_warn: 0.5, psi_critical: 0.2, note: 'inverted thresholds' });
    expect(bad.status).toBe(400);
    expect((await request(app).put(`${API}/settings`).set(A(admin)).send({ psi_warn: 0.1 })).status).toBe(400);   // note required
    const ok = await request(app).put(`${API}/settings`).set(A(admin)).send({ psi_critical: 0.6, note: 'Allow larger shifts' });
    expect(ok.status).toBe(200); expect(ok.body.settings.psi_critical).toBe(0.6);
    await request(app).post(`${API}/run`).set(A(admin));
    const a = (await alerts()).find((x) => x.trigger_name === 'drift_features' && x.scope === '24h|all=all');
    expect(a.severity).toBe('warn');                                                       // 0.42 is between 0.1 and 0.6
    await request(app).put(`${API}/settings`).set(A(admin)).send({ psi_critical: 0.25, note: 'Restore the default' });
  });

  test('ML service failure is reported, not fatal; no snapshot or alert is invented', async () => {
    await many(30, { amount: 40 });
    ml.evaluateDrift.mockRejectedValue(new Error('boom'));
    const s = (await request(app).post(`${API}/run`).set(A(admin))).body;
    expect(s.errors.join(' ')).toMatch(/boom/);
    expect(await alerts()).toEqual([]);
    ml.listVersions.mockRejectedValue(new Error('down'));
    const s2 = (await request(app).post(`${API}/run`).set(A(admin))).body;
    expect(s2.errors.join(' ')).toMatch(/unreachable/);
  });

  test('a model version change clears alerts about the previous version', async () => {
    await many(30, { amount: 5000, category: 'crypto', score: 70 });
    await request(app).post(`${API}/run`).set(A(admin));
    expect((await alerts()).length).toBeGreaterThan(0);
    ml.listVersions.mockResolvedValue({ active: 'v4' });
    await request(app).post(`${API}/run`).set(A(admin));
    expect((await alerts()).filter((a) => a.model_version === 'v3')).toEqual([]);
  });
});

describe('model quality once labels exist', () => {
  beforeEach(async () => { await clearLog(); await db.exec('DELETE FROM drift_snapshots'); await db.exec('DELETE FROM model_health_events'); await db.exec('UPDATE transactions SET is_synthetic = 1'); });

  async function labelled({ tp, fp }) {
    const uid = (await db.get("SELECT id FROM users WHERE username = 'admin'")).id;
    for (let i = 0; i < tp + fp; i += 1) {
      const isTp = i < tp;
      const { lastInsertRowid: id } = await db.insert(
        `INSERT INTO transactions (user_id, amount, merchant, category, location, card_type, fraud_score, risk_level, model_version, scoring_method, status, created_at, is_synthetic)
         VALUES (?, 100, 'M', 'food', 'NY', 'credit', 80, 'high', 'v3', 'ml_model', 'completed', ?, 0)`, [uid, new Date(Date.now() - 5 * 86400000).toISOString()]);
      await db.insert(`INSERT INTO alerts (transaction_id, user_id, message, risk_level, status, created_at, resolved, verdict) VALUES (?, ?, 'x', 'high', 'resolved', ?, 1, ?)`,
        [id, uid, new Date(Date.now() - 5 * 86400000).toISOString(), isTp ? 'confirmed_fraud' : 'false_positive']);
    }
  }

  test('too few reviewed alerts: quality is insufficient_data and drift alerts say there is no label evidence yet', async () => {
    await many(30, { amount: 5000, category: 'crypto', score: 70 });
    await request(app).post(`${API}/run`).set(A(admin));
    const q = (await request(app).get(`${API}/snapshots?dim=quality`).set(A(admin))).body.snapshots;
    expect(q[0].status).toBe('insufficient_data');
    const a = (await alerts()).find((x) => x.trigger_name === 'drift_features');
    expect(a.details.quality_evidence.status).toBe('no_labels_yet');
  });

  test('with enough labels, precision is tracked; a significant fall versus a week ago opens quality_decline and drift alerts reference it', async () => {
    await labelled({ tp: 9, fp: 31 });                      // precision 0.225
    const weekAgo = new Date(Date.now() - 8 * 86400000).toISOString();
    await db.insert(`INSERT INTO drift_snapshots (created_at, model_version, window_label, window_start, window_end, segment_dim, segment_value, n, status, quality)
      VALUES (?, 'v3', '30d', ?, ?, 'quality', 'all', 60, 'ok', ?)`, [weekAgo, weekAgo, weekAgo, JSON.stringify({ precision: 0.8, precision_ci: [0.68, 0.88], reviewed: 60 })]);
    await many(30, { amount: 5000, category: 'crypto', score: 70 });
    await request(app).post(`${API}/run`).set(A(admin));
    const q = (await request(app).get(`${API}/snapshots?dim=quality`).set(A(admin))).body.snapshots.pop();
    expect(q.status).toBe('ok'); expect(q.quality.precision).toBeCloseTo(9 / 40, 3); expect(q.quality.reviewed).toBe(40);
    const open = await alerts();
    expect(open.find((x) => x.trigger_name === 'quality_decline')).toMatchObject({ severity: 'warn', kind: 'accuracy' });
    expect(open.find((x) => x.trigger_name === 'drift_features').details.quality_evidence.status).toBe('decline_observed');
  });

  test('stable quality alongside drift is reported as no decline observed (drift is not proof of worse accuracy)', async () => {
    await labelled({ tp: 30, fp: 10 });
    await many(30, { amount: 5000, category: 'crypto', score: 70 });
    await request(app).post(`${API}/run`).set(A(admin));
    const a = (await alerts()).find((x) => x.trigger_name === 'drift_features');
    expect(a.details.quality_evidence).toMatchObject({ status: 'no_decline_observed', reviewed: 40 });
    expect((await alerts()).find((x) => x.trigger_name === 'quality_decline')).toBeUndefined();
  });
});

test('overview combines operations, latest drift per window, quality trend, open alerts and the interpretation', async () => {
  const o = (await request(app).get(`${API}/overview`).set(A(admin))).body;
  expect(o).toHaveProperty('operations'); expect(o).toHaveProperty('latest_drift'); expect(o).toHaveProperty('quality_trend'); expect(o).toHaveProperty('open_alerts');
  expect(o.interpretation).toMatch(/warning signal/);
  expect(Object.keys(o.latest_drift)).toEqual(['24h', '7d']);
  expect(o.settings.min_samples_overall).toBe(20);
});
