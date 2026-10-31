/**
 * Controlled retraining from verified feedback labels.
 *
 *   verified labels --build--> immutable dataset snapshot (sha256) --request--> run:pending_approval
 *     --approve (a different person)--> approved --start--> running (ML service) --> candidate_ready | failed
 *
 * What this does NOT do: it never serves, activates or reloads a model. `candidate_ready` means the ML service saved a
 * CANDIDATE version; putting it in front of traffic is the existing model change workflow (gates, same-dataset
 * comparison, second-person approval): POST /api/admin/ml/change-requests.
 *
 * Training data honesty:
 *  - only labels that a second investigator verified are used as positives/negatives;
 *  - labels come from alerts the previous model/rules chose to surface, so they are SELECTION-BIASED. Optional
 *    "presumed legitimate" rows (mature, never alerted, never disputed) reduce that bias but are NOT verified
 *    labels: they are marked as such in the CSV and in the dataset's composition;
 *  - the feature values are the exact decision-time snapshot, so there is no leakage from later history;
 *  - simulator transactions are excluded; redacted snapshots are skipped and counted.
 */
const crypto = require('crypto');
const db = require('../config/database');
const config = require('../config/env');
const mlAdminClient = require('./mlAdminClient');
const { toMs } = require('../models/geoVelocity');

const now = () => new Date().toISOString();
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const OPEN = ['pending_approval', 'approved', 'running'];
const COLUMNS = ['transaction_id', 'user_synthetic_id', 'timestamp', 'amount', 'merchant', 'category', 'location', 'card_type', 'hour', 'day_of_week',
  'distance_from_home', 'geo_distance_from_last_km', 'time_since_last_transaction_minutes', 'ratio_to_median_purchase_price', 'spending_zscore',
  'velocity_last_hour', 'repeat_retailer', 'used_chip', 'used_pin_number', 'online_order', 'is_new_device', 'ip_status', 'is_fraud', 'fraud_pattern', 'label_source'];
const BIAS_NOTE = 'Verified labels come from reviewed alerts and disputes, so they over-represent what the previous model flagged. Presumed-legitimate rows are not verified.';

class RetrainError extends Error { constructor(code, message, extra = {}) { super(message); this.code = code; this.extra = extra; } }

const csvCell = (v) => {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
function seededShuffle(arr, seedHex) {
  let a = parseInt(seedHex.slice(0, 8), 16) >>> 0;
  const rnd = () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i -= 1) { const j = Math.floor(rnd() * (i + 1)); [out[i], out[j]] = [out[j], out[i]]; }
  return out;
}

function featureRow(r, fraud, pattern, source) {
  let f; try { f = JSON.parse(r.feature_snapshot); } catch { return null; }
  if (!f || typeof f !== 'object') return null;
  const need = ['amount', 'category', 'location', 'card_type', 'hour', 'day_of_week', 'distance_from_home', 'geo_distance_from_last_km', 'time_since_last_transaction_minutes',
    'ratio_to_median_purchase_price', 'spending_zscore', 'velocity_last_hour', 'repeat_retailer', 'is_new_device', 'ip_status'];
  if (need.some((k) => f[k] === undefined || f[k] === null)) return null;
  const ts = toMs(r.created_at);
  if (!Number.isFinite(ts)) return null;
  return [r.transaction_id, r.user_id, new Date(ts).toISOString(), f.amount, r.merchant, f.category, f.location, f.card_type, f.hour, f.day_of_week,
    f.distance_from_home, f.geo_distance_from_last_km, f.time_since_last_transaction_minutes, f.ratio_to_median_purchase_price, f.spending_zscore,
    f.velocity_last_hour, f.repeat_retailer, f.used_chip ?? 0, f.used_pin_number ?? 0, f.online_order ?? 1, f.is_new_device, f.ip_status, fraud, pattern, source];
}

const FEATURE_SQL = `SELECT t.id AS transaction_id, t.user_id, t.merchant, t.created_at, d.feature_snapshot
  FROM transactions t JOIN decision_records d ON d.transaction_id = t.id AND d.seq = (SELECT MIN(seq) FROM decision_records WHERE transaction_id = t.id)
  WHERE d.feature_snapshot IS NOT NULL AND d.redacted_at IS NULL`;

async function readiness() {
  const c = await db.all("SELECT label, COUNT(*) AS n FROM label_feedback WHERE status = 'verified' GROUP BY label");
  const n = { fraud: 0, legitimate: 0 };
  for (const r of c) n[r.label] = Number(r.n);
  const need = config.feedback.minPerClass;
  const missing = [];
  if (n.fraud < need) missing.push(`${need - n.fraud} more verified fraud label(s)`);
  if (n.legitimate < need) missing.push(`${need - n.legitimate} more verified legitimate label(s)`);
  return { verified_fraud: n.fraud, verified_legitimate: n.legitimate, minimum_per_class: need, minimum_rows: config.feedback.minRows, ready: missing.length === 0, missing, bias_note: BIAS_NOTE };
}

async function buildDataset({ actor, note, presumedPerLabel = 3, maturityDays = 30 }) {
  const rd = await readiness();
  if (!rd.ready) throw new RetrainError('NOT_ENOUGH_LABELS', `Not enough verified labels yet: need ${rd.missing.join(' and ')}`, { readiness: rd });

  const labelled = await db.all(`${FEATURE_SQL} AND t.id IN (SELECT transaction_id FROM label_feedback WHERE status = 'verified') ORDER BY t.id`);
  const labels = new Map((await db.all("SELECT transaction_id, label FROM label_feedback WHERE status = 'verified'")).map((r) => [Number(r.transaction_id), r.label]));
  const rows = []; let skipped = 0;
  for (const r of labelled) {
    const isFraud = labels.get(Number(r.transaction_id)) === 'fraud' ? 1 : 0;
    const row = featureRow(r, isFraud, isFraud ? 'verified_fraud' : 'verified_legit', 'verified');
    if (row) rows.push(row); else skipped += 1;
  }
  const nVerified = rows.length;

  let nPresumed = 0;
  if (presumedPerLabel > 0) {
    const cutoff = new Date(Date.now() - maturityDays * 86400000).toISOString().replace('T', ' ').slice(0, 19);
    const cand = await db.all(`${FEATURE_SQL} AND t.is_synthetic = 0 AND t.created_at < ?
      AND NOT EXISTS (SELECT 1 FROM alerts a WHERE a.transaction_id = t.id)
      AND NOT EXISTS (SELECT 1 FROM disputes x WHERE x.transaction_id = t.id)
      AND NOT EXISTS (SELECT 1 FROM label_feedback l WHERE l.transaction_id = t.id AND l.status IN ('proposed','verified'))
      ORDER BY t.id DESC LIMIT 20000`, [cutoff]);
    const want = Math.min(cand.length, presumedPerLabel * nVerified);
    const seed = sha256(JSON.stringify({ n: nVerified, last: rows.length ? rows[rows.length - 1][0] : 0, presumedPerLabel, maturityDays }));
    for (const r of seededShuffle(cand, seed).slice(0, want)) {
      const row = featureRow(r, 0, 'presumed_legit', 'presumed');
      if (row) { rows.push(row); nPresumed += 1; } else skipped += 1;
    }
  }

  const nFraud = rows.filter((r) => r[22] === 1).length;
  const composition = {
    rows: rows.length, verified_rows: nVerified, presumed_legitimate_rows: nPresumed, fraud_rows: nFraud, legitimate_rows: rows.length - nFraud,
    verified_fraud: rows.filter((r) => r[23] === 'verified_fraud').length, verified_legitimate: rows.filter((r) => r[23] === 'verified_legit').length,
    skipped_missing_or_redacted_features: skipped, fraud_rate: rows.length ? Number((nFraud / rows.length).toFixed(4)) : null,
    period: rows.length ? { from: rows.reduce((m, r) => (r[2] < m ? r[2] : m), rows[0][2]), to: rows.reduce((m, r) => (r[2] > m ? r[2] : m), rows[0][2]) } : null,
    bias_note: BIAS_NOTE,
  };
  const minRows = config.feedback.minRows;
  const minClass = config.feedback.minPerClass;
  if (rows.length < minRows || composition.verified_fraud < minClass || composition.verified_legitimate < minClass) {
    throw new RetrainError('DATASET_TOO_SMALL', `Dataset has ${rows.length} usable rows (${composition.verified_fraud} verified fraud, ${composition.verified_legitimate} verified legitimate); need at least ${minRows} rows and ${minClass} verified of each class.`, { composition });
  }
  rows.sort((a, b) => (a[2] < b[2] ? -1 : a[2] > b[2] ? 1 : a[0] - b[0]));
  const csv = `${COLUMNS.join(',')}\n${rows.map((r) => r.map(csvCell).join(',')).join('\n')}\n`;
  const params = { presumed_negatives_per_label: presumedPerLabel, maturity_days: maturityDays };
  const { lastInsertRowid } = await db.insert(
    'INSERT INTO retraining_datasets (created_by, created_at, note, params, composition, content_sha256, n_rows, csv) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [actor.id, now(), note, JSON.stringify(params), JSON.stringify(composition), sha256(csv), rows.length, csv]);
  return getDataset(lastInsertRowid);
}

const parse = (s, d = null) => { if (s === null || s === undefined) return d; try { return JSON.parse(s); } catch { return d; } };
async function getDataset(id, { withCsv = false } = {}) {
  const r = await db.get('SELECT * FROM retraining_datasets WHERE id = ?', [id]);
  if (!r) return null;
  const out = { id: Number(r.id), created_by: r.created_by, created_at: r.created_at, note: r.note, params: parse(r.params), composition: parse(r.composition), content_sha256: r.content_sha256, n_rows: Number(r.n_rows) };
  if (withCsv) out.csv = r.csv;
  return out;
}
async function listDatasets() {
  const rows = await db.all('SELECT id FROM retraining_datasets ORDER BY id DESC LIMIT 50');
  return Promise.all(rows.map((r) => getDataset(r.id)));
}

const normRun = (r) => r && ({ ...r, id: Number(r.id), dataset_id: Number(r.dataset_id), version: Number(r.version), ml_result: parse(r.ml_result) });
const getRun = async (id) => normRun(await db.get('SELECT * FROM retraining_runs WHERE id = ?', [id]));
async function listRuns() {
  return (await db.all('SELECT * FROM retraining_runs ORDER BY id DESC LIMIT 50')).map(normRun);
}

async function requestRun({ datasetId, note, actor }) {
  const ds = await getDataset(datasetId);
  if (!ds) throw new RetrainError('NOT_FOUND', 'Dataset not found');
  try {
    const { lastInsertRowid } = await db.insert('INSERT INTO retraining_runs (dataset_id, status, requested_by, requested_at, request_note) VALUES (?, ?, ?, ?, ?)', [datasetId, 'pending_approval', actor.id, now(), note]);
    return getRun(lastInsertRowid);
  } catch (e) {
    if (/unique|duplicate/i.test(e.message)) throw new RetrainError('RUN_IN_PROGRESS', 'Another retraining run is already pending, approved or running');
    throw e;
  }
}

async function transition(id, { from, to, actor, note, selfCheck }) {
  const run = await getRun(id);
  if (!run) throw new RetrainError('NOT_FOUND', 'Run not found');
  if (selfCheck && Number(run.requested_by) === Number(actor.id) && !config.feedback.allowSelfVerify) throw new RetrainError('SELF_APPROVAL', 'A different administrator must approve this run (four-eyes)');
  const r = await db.run('UPDATE retraining_runs SET status = ?, decided_by = ?, decided_at = ?, decision_note = ?, version = version + 1 WHERE id = ? AND status = ?', [to, actor.id, now(), note, id, from]);
  if (!r.changes) throw new RetrainError('BAD_STATE', `Run is not ${from}`, { current: (await getRun(id)).status });
  return getRun(id);
}
const approveRun = (id, actor, note) => transition(id, { from: 'pending_approval', to: 'approved', actor, note, selfCheck: true });
const rejectRun = (id, actor, note) => transition(id, { from: 'pending_approval', to: 'rejected', actor, note, selfCheck: false });
const cancelRun = async (id, actor, note) => {
  const run = await getRun(id);
  if (!run) throw new RetrainError('NOT_FOUND', 'Run not found');
  return transition(id, { from: run.status === 'approved' ? 'approved' : 'pending_approval', to: 'cancelled', actor, note, selfCheck: false });
};

async function startRun(id, actor) {
  const claim = await db.run("UPDATE retraining_runs SET status = 'running', started_at = ?, version = version + 1 WHERE id = ? AND status = 'approved'", [now(), id]);
  if (!claim.changes) {
    const cur = await getRun(id);
    throw new RetrainError(cur ? 'BAD_STATE' : 'NOT_FOUND', cur ? `Run is ${cur.status}; only an approved run can start` : 'Run not found');
  }
  const run = await getRun(id);
  const ds = await getDataset(run.dataset_id, { withCsv: true });
  try {
    const accepted = await mlAdminClient.startRetrain({
      dataset_csv: ds.csv, dataset_sha256: ds.content_sha256,
      dataset_info: { dataset_id: ds.id, composition: ds.composition, params: ds.params, label_policy: 'second_person_verified', run_id: id },
      notes: `Retrain from verified labels (dataset #${ds.id}, run #${id}): ${run.request_note}`.slice(0, 500), requested_by: actor.username,
    });
    await db.run('UPDATE retraining_runs SET ml_result = ? WHERE id = ?', [JSON.stringify({ accepted }), id]);
  } catch (e) {
    await db.run("UPDATE retraining_runs SET status = 'failed', finished_at = ?, error = ?, version = version + 1 WHERE id = ? AND status = 'running'", [now(), String(e.message).slice(0, 500), id]);
  }
  return refreshRun(id);
}

/** Pulls the ML service's status for a running run. Safe to call repeatedly. */
async function refreshRun(id) {
  const run = await getRun(id);
  if (!run || run.status !== 'running') return run;
  let st;
  try { st = await mlAdminClient.retrainStatus(); } catch { return { ...run, ml_status_unreachable: true }; }
  const ds = await getDataset(run.dataset_id);
  if (st.dataset_sha256 && st.dataset_sha256 !== ds.content_sha256) return { ...run, ml_status_mismatch: true };
  if (st.state === 'succeeded') {
    await db.run("UPDATE retraining_runs SET status = 'candidate_ready', finished_at = ?, candidate_version = ?, ml_result = ?, version = version + 1 WHERE id = ? AND status = 'running'", [now(), st.version, JSON.stringify(st), id]);
  } else if (st.state === 'failed') {
    await db.run("UPDATE retraining_runs SET status = 'failed', finished_at = ?, error = ?, ml_result = ?, version = version + 1 WHERE id = ? AND status = 'running'", [now(), st.error || 'training failed', JSON.stringify(st), id]);
  }
  return getRun(id);
}

const NEXT_STEP = 'The candidate is NOT serving. To use it, request promotion through POST /api/admin/ml/change-requests (gates, same-dataset comparison, second-person approval).';

module.exports = { RetrainError, COLUMNS, OPEN, NEXT_STEP, readiness, buildDataset, getDataset, listDatasets, getRun, listRuns, requestRun, approveRun, rejectRun, cancelRun, startRun, refreshRun };
