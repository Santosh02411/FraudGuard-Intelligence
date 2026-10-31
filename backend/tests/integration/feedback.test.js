/** Verified feedback labels -> immutable dataset -> approved retraining run (candidate only). */
jest.mock('../../models/mlClient', () => ({ ...jest.requireActual('../../models/mlClient'), scoreWithML: jest.fn().mockRejectedValue(new Error('ml down')) }));
jest.mock('../../services/mlAdminClient');
const crypto = require('crypto');
const request = require('supertest');
const app = require('../../app');
const db = require('../../config/database');
const config = require('../../config/env');
const mlAdminClient = require('../../services/mlAdminClient');
const { initSchema } = require('../../config/schema');

const API = '/api/v1';
const A = (t) => ({ Authorization: `Bearer ${t}` });
let admin1; let admin2; let user; let userId; let seq = 0;
const txIds = [];

async function login(name, password = 'Str0ng!Passw0rd1') {
  return (await request(app).post(`${API}/auth/login`).send({ username: name, password })).body.accessToken;
}
async function mkUser(name, role) {
  const password = 'Str0ng!Passw0rd1';
  await request(app).post(`${API}/auth/register`).send({ username: name, email: `${name}@example.com`, password });
  if (role) await db.run('UPDATE users SET role = ? WHERE username = ?', [role, name]);
  return login(name, password);
}
async function mkTxn(token, amount = 30, location = 'New York, US') {
  seq += 1;
  const r = await request(app).post(`${API}/transactions`).set(A(token)).set('User-Agent', `fb-${seq % 3}`).set('X-Forwarded-For', `198.18.0.${seq % 250}`)
    .send({ amount, merchant: 'Corner Cafe', category: 'food', location, card_type: 'debit' });
  expect(r.status).toBe(201);
  return r.body.transaction.id;
}
const propose = (token, transaction_id, label) => request(app).post(`${API}/feedback/labels`).set(A(token)).send({ transaction_id, label, evidence_note: 'Customer called; confirmed outcome' });
const verify = (token, id) => request(app).post(`${API}/feedback/labels/${id}/verify`).set(A(token)).send({ note: 'Checked the evidence' });

beforeAll(async () => {
  await initSchema();
  config.feedback.minPerClass = 3; config.feedback.minRows = 12; // small fixture; production defaults are 20 / 200
  admin1 = await login('admin', 'admin123');
  admin2 = await mkUser('fb_admin2', 'admin');
  user = await mkUser('fb_user');
  userId = (await db.get("SELECT id FROM users WHERE username = 'fb_user'")).id;
  for (let i = 0; i < 24; i += 1) txIds.push(await mkTxn(user, 20 + i));
});

describe('label workflow', () => {
  let labelId;
  test('admin only', async () => {
    expect((await request(app).get(`${API}/feedback/labels`)).status).toBe(401);
    expect((await request(app).get(`${API}/feedback/labels`).set(A(user))).status).toBe(403);
  });

  test('propose -> self-verification refused -> a second investigator verifies; event log is kept', async () => {
    const p = await propose(admin1, txIds[0], 'fraud');
    expect(p.status).toBe(201); labelId = p.body.label.id;
    const self = await verify(admin1, labelId);
    expect(self.status).toBe(409); expect(self.body.details.code).toBe('SELF_VERIFICATION');
    const ok = await verify(admin2, labelId);
    expect(ok.status).toBe(200); expect(ok.body.label).toMatchObject({ status: 'verified', reviewed_by: expect.any(Number) });
    const ev = await request(app).get(`${API}/feedback/labels/${labelId}/events`).set(A(admin1));
    expect(ev.body.events.map((e) => e.kind)).toEqual(['proposed', 'verified']);
  });

  test('one live label per transaction; a decided label cannot be decided twice; withdraw frees the slot', async () => {
    const dup = await propose(admin2, txIds[0], 'legitimate');
    expect(dup.status).toBe(409); expect(dup.body.details.code).toBe('ALREADY_LABELLED');
    const again = await verify(admin2, labelId);
    expect(again.status).toBe(409); expect(again.body.details.code).toBe('NOT_PENDING');
    const w = await request(app).post(`${API}/feedback/labels/${labelId}/withdraw`).set(A(admin2)).send({ note: 'Entered against the wrong transaction' });
    expect(w.body.label.status).toBe('withdrawn');
    const re = await propose(admin2, txIds[0], 'fraud');
    expect(re.status).toBe(201);
    expect((await verify(admin1, re.body.label.id)).status).toBe(200);
  });

  test('unknown transaction 404; simulator transactions are refused; bad input 400', async () => {
    expect((await propose(admin1, 99999999, 'fraud')).status).toBe(404);
    const synthetic = await db.insert("INSERT INTO transactions (user_id, amount, merchant, category, location, card_type, is_synthetic) VALUES (?, 5, 'x', 'food', 'New York, US', 'debit', 1)", [userId]);
    const r = await propose(admin1, Number(synthetic.lastInsertRowid), 'fraud');
    expect(r.status).toBe(422); expect(r.body.details.code).toBe('SYNTHETIC');
    expect((await request(app).post(`${API}/feedback/labels`).set(A(admin1)).send({ transaction_id: txIds[1], label: 'maybe', evidence_note: 'long enough note' })).status).toBe(400);
    expect((await request(app).post(`${API}/feedback/labels`).set(A(admin1)).send({ transaction_id: txIds[1], label: 'fraud', evidence_note: 'short' })).status).toBe(400);
  });

  test('imports analyst verdicts as PROPOSED labels only', async () => {
    const hi = await request(app).post(`${API}/transactions`).set(A(user)).set('User-Agent', 'fb-hi').set('X-Forwarded-For', '198.18.1.1')
      .send({ amount: 100, merchant: 'DarkNet Market', category: 'electronics', location: 'New York, US', card_type: 'credit' });
    const alert = await db.get('SELECT id FROM alerts WHERE transaction_id = ?', [hi.body.transaction.id]);
    expect(alert).toBeTruthy();
    const res = await request(app).patch(`${API}/alerts/${alert.id}/resolve`).set(A(admin1)).send({ verdict: 'confirmed_fraud', reason: 'stolen_card', note: 'Confirmed with the customer' });
    expect(res.status).toBe(200);
    const imp = await request(app).post(`${API}/feedback/labels/import-outcomes`).set(A(admin1));
    expect(imp.body.proposed).toBeGreaterThanOrEqual(1);
    const list = await request(app).get(`${API}/feedback/labels?status=proposed`).set(A(admin1));
    const row = list.body.labels.find((l) => l.transaction_id === hi.body.transaction.id);
    expect(row).toMatchObject({ label: 'fraud', source: 'alert_verdict', status: 'proposed' });
    await request(app).post(`${API}/feedback/labels/${row.id}/reject`).set(A(admin2)).send({ note: 'Keep this one out of training' });
  });
});

describe('dataset and retraining run', () => {
  let datasetId; let runId;

  test('too few verified labels: readiness says what is missing and the dataset is refused', async () => {
    const rd = await request(app).get(`${API}/feedback/retraining/readiness`).set(A(admin1));
    expect(rd.body).toMatchObject({ ready: false, verified_fraud: 1 });
    const r = await request(app).post(`${API}/feedback/retraining/datasets`).set(A(admin1)).send({ note: 'First attempt at a dataset' });
    expect(r.status).toBe(422); expect(r.body.details.code).toBe('NOT_ENOUGH_LABELS');
  });

  test('builds an immutable, hashed dataset: verified rows plus clearly-marked presumed-legitimate rows', async () => {
    for (let i = 1; i < 4; i += 1) { const p = await propose(admin1, txIds[i], 'fraud'); await verify(admin2, p.body.label.id); }
    for (let i = 4; i < 8; i += 1) { const p = await propose(admin2, txIds[i], 'legitimate'); await verify(admin1, p.body.label.id); }
    // make some unlabelled transactions "mature" so they can serve as presumed-legitimate
    await db.run("UPDATE transactions SET created_at = '2026-01-05 10:00:00' WHERE id IN (" + txIds.slice(8, 20).join(',') + ')');
    const r = await request(app).post(`${API}/feedback/retraining/datasets`).set(A(admin1)).send({ note: 'Dataset for the autumn retrain', presumed_negatives_per_label: 2, maturity_days: 30 });
    expect(r.status).toBe(201);
    const d = r.body.dataset; datasetId = d.id;
    expect(d.composition).toMatchObject({ verified_fraud: 4, verified_legitimate: 4, verified_rows: 8 });
    expect(d.composition.presumed_legitimate_rows).toBeGreaterThan(0);
    expect(d.composition.bias_note).toMatch(/selection|over-represent/i);
    const dl = await request(app).get(`${API}/feedback/retraining/datasets/${datasetId}/download`).set(A(admin1));
    expect(dl.status).toBe(200);
    expect(crypto.createHash('sha256').update(dl.text).digest('hex')).toBe(d.content_sha256);
    expect(dl.headers['x-content-sha256']).toBe(d.content_sha256);
    const [header, ...lines] = dl.text.trim().split('\n');
    expect(header.split(',')).toEqual(expect.arrayContaining(['is_fraud', 'label_source', 'fraud_pattern', 'timestamp', 'spending_zscore']));
    expect(lines).toHaveLength(d.n_rows);
    expect(lines.filter((l) => l.includes('presumed')).length).toBe(d.composition.presumed_legitimate_rows);
    expect(dl.text).not.toMatch(/198\.18\.|fb-\d/); // no IPs or fingerprints in training data
  });

  test('a run needs a different administrator to approve; only one open run at a time', async () => {
    const q = await request(app).post(`${API}/feedback/retraining/runs`).set(A(admin1)).send({ dataset_id: datasetId, note: 'Autumn retrain from verified labels' });
    expect(q.status).toBe(201); runId = q.body.run.id;
    const second = await request(app).post(`${API}/feedback/retraining/runs`).set(A(admin2)).send({ dataset_id: datasetId, note: 'Duplicate request attempt' });
    expect(second.status).toBe(409); expect(second.body.details.code).toBe('RUN_IN_PROGRESS');
    const startEarly = await request(app).post(`${API}/feedback/retraining/runs/${runId}/start`).set(A(admin1));
    expect(startEarly.status).toBe(409);
    const self = await request(app).post(`${API}/feedback/retraining/runs/${runId}/approve`).set(A(admin1)).send({ note: 'Approving my own' });
    expect(self.body.details.code).toBe('SELF_APPROVAL');
    const ok = await request(app).post(`${API}/feedback/retraining/runs/${runId}/approve`).set(A(admin2)).send({ note: 'Composition looks fine' });
    expect(ok.body.run.status).toBe('approved');
  });

  test('start sends the hashed dataset to the ML service; success yields a CANDIDATE and points at the promotion workflow', async () => {
    const ds = await request(app).get(`${API}/feedback/retraining/datasets/${datasetId}`).set(A(admin1));
    mlAdminClient.startRetrain.mockResolvedValue({ state: 'running' });
    mlAdminClient.retrainStatus.mockResolvedValue({ state: 'running', dataset_sha256: ds.body.dataset.content_sha256 });
    const s = await request(app).post(`${API}/feedback/retraining/runs/${runId}/start`).set(A(admin1));
    expect(s.status).toBe(202); expect(s.body.run.status).toBe('running');
    const sent = mlAdminClient.startRetrain.mock.calls[0][0];
    expect(sent.dataset_sha256).toBe(ds.body.dataset.content_sha256);
    expect(sent.dataset_info.label_policy).toBe('second_person_verified');
    expect((await request(app).post(`${API}/feedback/retraining/runs/${runId}/start`).set(A(admin1))).status).toBe(409); // cannot start twice

    mlAdminClient.retrainStatus.mockResolvedValue({ state: 'succeeded', version: 'v9', dataset_sha256: ds.body.dataset.content_sha256, pr_auc: 0.7 });
    const done = await request(app).get(`${API}/feedback/retraining/runs/${runId}`).set(A(admin1));
    expect(done.body.run).toMatchObject({ status: 'candidate_ready', candidate_version: 'v9' });
    expect(done.body.next_step).toMatch(/NOT serving/);
  });

  test('an ML failure is recorded, frees the slot, and a run whose dataset hash does not match is not trusted', async () => {
    const q = await request(app).post(`${API}/feedback/retraining/runs`).set(A(admin2)).send({ dataset_id: datasetId, note: 'Second attempt, ML will fail' });
    expect(q.status).toBe(201);
    const id = q.body.run.id;
    await request(app).post(`${API}/feedback/retraining/runs/${id}/approve`).set(A(admin1)).send({ note: 'Fine to run' });
    mlAdminClient.startRetrain.mockRejectedValue(new Error('ML service is unreachable'));
    mlAdminClient.retrainStatus.mockResolvedValue({ state: 'idle' });
    const s = await request(app).post(`${API}/feedback/retraining/runs/${id}/start`).set(A(admin2));
    expect(s.body.run).toMatchObject({ status: 'failed' });
    expect(s.body.run.error).toMatch(/unreachable/);

    const q2 = await request(app).post(`${API}/feedback/retraining/runs`).set(A(admin1)).send({ dataset_id: datasetId, note: 'Third attempt, hash mismatch' });
    expect(q2.status).toBe(201);
    await request(app).post(`${API}/feedback/retraining/runs/${q2.body.run.id}/approve`).set(A(admin2)).send({ note: 'Fine to run' });
    mlAdminClient.startRetrain.mockResolvedValue({ state: 'running' });
    mlAdminClient.retrainStatus.mockResolvedValue({ state: 'succeeded', version: 'v10', dataset_sha256: 'f'.repeat(64) });
    const mm = await request(app).post(`${API}/feedback/retraining/runs/${q2.body.run.id}/start`).set(A(admin1));
    expect(mm.body.run.status).toBe('running');
    expect(mm.body.run.ml_status_mismatch).toBe(true);
  });

  test('actions are audited', async () => {
    await new Promise((r) => setTimeout(r, 300));
    const rows = await db.all("SELECT DISTINCT action FROM audit_logs WHERE action LIKE 'feedback.%'");
    expect(rows.map((r) => r.action)).toEqual(expect.arrayContaining(['feedback.label_proposed', 'feedback.label_verify', 'feedback.dataset_built', 'feedback.retrain_approve', 'feedback.retrain_started']));
  });
});
