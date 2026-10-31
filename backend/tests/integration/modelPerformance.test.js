/** Model performance & outcome feedback: metric maths on hand-built outcomes, API access, export safety. */
jest.mock('../../models/mlClient');
const request = require('supertest');
const app = require('../../app');
const db = require('../../config/database');
const { initSchema } = require('../../config/schema');
const svc = require('../../services/modelPerformanceService');

const API = '/api/v1';
let admin; let userTok; let uid;
const DAY = 86400000;
const iso = (daysAgo) => new Date(Date.now() - daysAgo * DAY).toISOString();

async function txn({ daysAgo = 5, score = 10, risk = 'low', merchant = 'M', category = 'food', version = 'v1', verdict, alert = false, dispute = false, resolved }) {
  const { lastInsertRowid } = await db.insert(
    `INSERT INTO transactions (user_id, amount, merchant, category, location, card_type, fraud_score, risk_level, model_version, status, created_at, is_synthetic)
     VALUES (?, 50, ?, ?, 'NY', 'credit', ?, ?, ?, 'completed', ?, 0)`, [uid, merchant, category, score, risk, version, iso(daysAgo)]);
  if (alert || verdict) {
    await db.insert(`INSERT INTO alerts (transaction_id, user_id, message, risk_level, status, created_at, resolved, verdict) VALUES (?, ?, 'x', ?, ?, ?, ?, ?)`,
      [lastInsertRowid, uid, risk, verdict ? 'resolved' : 'open', iso(daysAgo), verdict ? 1 : (resolved ? 1 : 0), verdict || null]);
  }
  if (dispute) await db.insert(`INSERT INTO disputes (transaction_id, amount_disputed, reason) VALUES (?, 50, 'not me')`, [lastInsertRowid]);
  return lastInsertRowid;
}

beforeAll(async () => {
  await initSchema();
  admin = (await request(app).post(`${API}/auth/login`).send({ username: 'admin', password: 'admin123' })).body.accessToken;
  await request(app).post(`${API}/auth/register`).send({ username: 'mp_user', email: 'mp@example.com', password: 'Str0ng!Passw0rd1' });
  userTok = (await request(app).post(`${API}/auth/login`).send({ username: 'mp_user', password: 'Str0ng!Passw0rd1' })).body.accessToken;
  uid = (await db.get("SELECT id FROM users WHERE username='mp_user'")).id;
  await db.run("DELETE FROM alerts"); // isolate from other fixtures in this file's private DB
});

describe('metric maths', () => {
  test('classification: TP/FP/unreviewed/FN candidate/presumed TN/immature', () => {
    const maturity = 30 * DAY; const now = Date.now();
    const c = (r) => svc.classify({ created_at: iso(r.age || 1), ...r }, now, maturity);
    expect(c({ alert_id: 1, verdict: 'confirmed_fraud' })).toBe('TP');
    expect(c({ alert_id: 1, verdict: 'false_positive' })).toBe('FP');
    expect(c({ alert_id: 1 })).toBe('UNREVIEWED');
    expect(c({ dispute_id: 1 })).toBe('FN');
    expect(c({ age: 40 })).toBe('TN');
    expect(c({ age: 3 })).toBe('IMMATURE');
  });

  test('precision, recall, FPR and PR-AUC on a known confusion matrix', () => {
    const mk = (cls, score) => ({ cls, score });
    const items = [
      ...Array.from({ length: 8 }, () => mk('TP', 90)), ...Array.from({ length: 2 }, () => mk('FP', 60)),
      mk('FN', 5), mk('FN', 5), ...Array.from({ length: 88 }, () => mk('TN', 2)), mk('UNREVIEWED', 70),
    ];
    const m = svc.metricsFor(items);
    expect(m.precision).toBe(0.8);                      // 8 / (8+2)
    expect(m.recall_estimate).toBe(0.8);                // 8 / (8+2 candidates)
    expect(m.false_positive_rate_estimate).toBeCloseTo(2 / 90, 3);
    expect(m.unreviewed).toBe(1);
    expect(m.review_coverage).toBeCloseTo(10 / 11, 3);
    expect(m.pr_auc).toBeGreaterThan(m.pr_auc_baseline);
    expect(m.precision_ci[0]).toBeLessThan(0.8); expect(m.precision_ci[1]).toBeGreaterThan(0.8);
  });

  test('small or one-sided samples are flagged, never invented', () => {
    const m = svc.metricsFor([{ cls: 'TP', score: 90 }]);
    expect(m.low_sample).toBe(true);
    expect(m.pr_auc).toBeNull(); // no negatives -> undefined, not 1.0
    const none = svc.metricsFor([]);
    expect(none.precision).toBeNull(); expect(none.recall_estimate).toBeNull();
  });
});

describe('API', () => {
  beforeAll(async () => {
    // v1 (older, weaker): 4 TP, 6 FP.  v2 (newer): 9 TP, 1 FP.
    for (let i = 0; i < 4; i++) await txn({ daysAgo: 60, score: 85, risk: 'high', version: 'v1', verdict: 'confirmed_fraud', merchant: 'ShopA' });
    for (let i = 0; i < 6; i++) await txn({ daysAgo: 58, score: 75, risk: 'high', version: 'v1', verdict: 'false_positive', merchant: 'ShopA', category: 'travel' });
    for (let i = 0; i < 9; i++) await txn({ daysAgo: 20, score: 90, risk: 'critical', version: 'v2', verdict: 'confirmed_fraud', merchant: 'ShopB' });
    await txn({ daysAgo: 19, score: 70, risk: 'high', version: 'v2', verdict: 'false_positive', merchant: 'ShopB' });
    for (let i = 0; i < 3; i++) await txn({ daysAgo: 2, score: 72, risk: 'high', version: 'v2', alert: true, merchant: 'ShopB' }); // unreviewed
    for (let i = 0; i < 30; i++) await txn({ daysAgo: 45, score: 3, version: 'v1', merchant: 'Cafe' });                          // presumed legit
    await txn({ daysAgo: 10, score: 4, version: 'v2', dispute: true, merchant: '=HYPERLINK("http://evil","x")' });                // missed candidate + hostile name
  });

  test('admin only', async () => {
    expect((await request(app).get(`${API}/admin/model-performance`)).status).toBe(401);
    expect((await request(app).get(`${API}/admin/model-performance`).set('Authorization', `Bearer ${userTok}`)).status).toBe(403);
  });

  test('validates parameters', async () => {
    expect((await request(app).get(`${API}/admin/model-performance?days=1`).set('Authorization', `Bearer ${admin}`)).status).toBe(400);
    expect((await request(app).get(`${API}/admin/model-performance?format=xml`).set('Authorization', `Bearer ${admin}`)).status).toBe(400);
  });

  test('report: overall, backlog, breakdowns, versions, over time', async () => {
    const r = await request(app).get(`${API}/admin/model-performance?days=90`).set('Authorization', `Bearer ${admin}`);
    expect(r.status).toBe(200);
    const b = r.body;
    expect(b.overall.confirmed_fraud).toBe(13);
    expect(b.overall.false_positives).toBe(7);
    expect(b.overall.precision).toBeCloseTo(13 / 20, 3);
    expect(b.overall.missed_candidates).toBe(1);
    expect(b.feedback.unreviewed_predictions).toBe(3);
    expect(b.feedback.confirmed_outcomes).toBe(20);
    expect(b.over_time.length).toBeGreaterThanOrEqual(3);
    expect(b.breakdowns.merchant.find((m) => m.key === 'ShopB').confirmed_fraud).toBe(9);
    expect(b.breakdowns.category.map((c) => c.key)).toEqual(expect.arrayContaining(['food', 'travel']));
    expect(b.breakdowns.risk_band.map((c) => c.key)).toContain('critical');
    expect(b.breakdowns.customer_cohort.length).toBeGreaterThan(0);
    expect(b.caveats.length).toBeGreaterThan(3);
  });

  test('current vs previous model version', async () => {
    const b = (await request(app).get(`${API}/admin/model-performance?days=90`).set('Authorization', `Bearer ${admin}`)).body;
    expect(b.version_comparison.current).toBe('v2');
    expect(b.version_comparison.previous).toBe('v1');
    expect(b.version_comparison.delta.precision).toBeGreaterThan(0.4); // 0.9 vs 0.4
    // 10 reviewed cases per version: the intervals overlap, so we must NOT claim a significant difference
    expect(b.version_comparison.precision_difference_significant).toBe(false);
  });

  test('with enough reviewed cases a real precision gap is reported as significant', () => {
    const wilson = svc.wilson;
    const [lo1] = wilson(90, 100); const [, hi0] = wilson(40, 100);
    expect(lo1).toBeGreaterThan(hi0);
  });

  test('window excludes old data; synthetic rows never count', async () => {
    const b = (await request(app).get(`${API}/admin/model-performance?days=30`).set('Authorization', `Bearer ${admin}`)).body;
    expect(b.overall.confirmed_fraud).toBe(9); // only v2's recent ones
    await db.run("UPDATE transactions SET is_synthetic = 1 WHERE merchant = 'ShopB'");
    const c = (await request(app).get(`${API}/admin/model-performance?days=30`).set('Authorization', `Bearer ${admin}`)).body;
    expect(c.overall.confirmed_fraud).toBe(0);
    await db.run("UPDATE transactions SET is_synthetic = 0 WHERE merchant = 'ShopB'");
  });

  test('CSV export is audited and neutralises formula injection from customer-controlled names', async () => {
    const r = await request(app).get(`${API}/admin/model-performance?format=csv`).set('Authorization', `Bearer ${admin}`);
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toMatch(/text\/csv/);
    expect(r.text.split('\r\n')[0]).toMatch(/^Section,Key,transactions/);
    expect(r.text).toMatch(/merchant,ShopB/);
    expect(r.text).not.toMatch(/(^|,)=HYPERLINK/m);
    for (let i = 0; i < 20; i++) { // audit is fire-and-forget
      if (await db.get("SELECT id FROM audit_logs WHERE action = 'model_performance.export'")) break;
      await new Promise((res) => setTimeout(res, 50));
    }
    expect(await db.get("SELECT id FROM audit_logs WHERE action = 'model_performance.export'")).toBeTruthy();
  });
});
