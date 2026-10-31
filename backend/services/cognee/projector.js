/**
 * Read-only projection of FraudGuard records into minimised "memory records".
 *
 * - Only SELECTs. This module never writes to FraudGuard tables.
 * - Direct identifiers are replaced by pseudonyms (see pseudonymize.js); IP addresses, emails,
 *   card types, credentials and raw device fingerprints are never selected into the output.
 *   (device_fingerprint IS read - solely to be turned into a pseudonymous device reference.)
 * - Free text (analyst notes, reasons, merchants) is redacted.
 * - Each record carries `content_hash`: SHA-256 of its canonical JSON. Identical content => identical
 *   hash => the sync service skips it.
 */
const crypto = require('crypto');
const db = require('../../config/database');
const config = require('../../config/env');
const { accountRef, deviceRef } = require('./pseudonymize');
const { redact } = require('./sanitize');

const toIso = (v) => {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString();
  const s = String(v);
  return new Date(s.includes('T') ? s : `${s.replace(' ', 'T')}Z`).toISOString();
};
const num = (v) => (v === null || v === undefined ? null : Number(v));
const marks = (n) => Array.from({ length: n }, () => '?').join(',');

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.keys(value).sort().reduce((acc, k) => { if (value[k] !== undefined) acc[k] = canonical(value[k]); return acc; }, {});
  }
  return value;
}
const hashOf = (record) => crypto.createHash('sha256').update(JSON.stringify(canonical(record))).digest('hex');

/** Lookback filter that tolerates both 'YYYY-MM-DD HH:MM:SS' (DB default) and ISO-8601 stored text. */
function lookbackClause(column, days) {
  const cutoff = new Date(Date.now() - days * 86400000);
  const sqlite = cutoff.toISOString().replace('T', ' ').slice(0, 19);
  return { sql: `(${column} >= ? OR ${column} >= ?)`, params: [sqlite, cutoff.toISOString()] };
}

const parseJson = (v, fallback) => {
  if (Array.isArray(v)) return v;
  if (typeof v !== 'string' || !v) return fallback;
  try { const p = JSON.parse(v); return p ?? fallback; } catch { return fallback; }
};

function detectionReasons(row) {
  const reasons = parseJson(row.fraud_reasons, []).map((r) => redact(r, 160)).filter(Boolean);
  const hard = parseJson(row.hard_flag_triggered, null);
  const hardList = Array.isArray(hard) ? hard : (typeof row.hard_flag_triggered === 'string' && row.hard_flag_triggered && !hard ? [row.hard_flag_triggered] : (typeof hard === 'string' ? [hard] : []));
  for (const h of hardList) reasons.unshift(`Hard rule: ${redact(h, 140)}`);
  return [...new Set(reasons)].slice(0, 20);
}

function modelFactors(row) {
  return parseJson(row.shap_explanation, [])
    .filter((f) => f && f.effect === 'increased_risk' && f.feature)
    .slice(0, 4).map((f) => `${redact(f.feature, 80)} (increased risk)`);
}

// ---------------------------------------------------------------- candidate selection (ids only)

/** New transactions after the cursor (always need ingesting). */
async function newTransactionIds({ afterId, limit, lookbackDays, includeSynthetic }) {
  const lb = lookbackClause('t.created_at', lookbackDays);
  const rows = await db.all(
    `SELECT t.id FROM transactions t WHERE t.id > ? AND ${lb.sql} ${includeSynthetic ? '' : 'AND t.is_synthetic = 0'} ORDER BY t.id ASC LIMIT ?`,
    [afterId, ...lb.params, limit]);
  return rows.map((r) => Number(r.id));
}

/**
 * Already-seen transactions whose memory-relevant state can change afterwards: they have an alert
 * (verdict/status/notes), a dispute, or belong to an investigation. Re-projected and hash-compared.
 */
async function rescanTransactionIds({ uptoId, afterScanId, limit, lookbackDays, includeSynthetic }) {
  const lb = lookbackClause('t.created_at', lookbackDays);
  const rows = await db.all(
    `SELECT t.id FROM transactions t
     WHERE t.id <= ? AND t.id > ? AND ${lb.sql} ${includeSynthetic ? '' : 'AND t.is_synthetic = 0'}
       AND (EXISTS (SELECT 1 FROM alerts a WHERE a.transaction_id = t.id)
         OR EXISTS (SELECT 1 FROM disputes d WHERE d.transaction_id = t.id)
         OR EXISTS (SELECT 1 FROM investigation_items ii WHERE ii.item_type = 'transaction' AND ii.item_id = t.id))
     ORDER BY t.id ASC LIMIT ?`,
    [uptoId, afterScanId, ...lb.params, limit]);
  return rows.map((r) => Number(r.id));
}

async function investigationIds({ afterId = 0, limit }) {
  const rows = await db.all('SELECT id FROM investigations WHERE id > ? ORDER BY id ASC LIMIT ?', [afterId, limit]);
  return rows.map((r) => Number(r.id));
}

async function maxIds() {
  const t = await db.get('SELECT MAX(id) AS m FROM transactions');
  const i = await db.get('SELECT MAX(id) AS m FROM investigations');
  return { transaction: Number(t?.m || 0), investigation: Number(i?.m || 0) };
}

// ---------------------------------------------------------------- projections

async function projectTransactions(ids) {
  const out = new Map();
  if (!ids.length) return out;
  const rows = await db.all(
    `SELECT t.id, t.user_id, t.amount, t.merchant, t.category, t.location, t.device_fingerprint, t.is_fraud, t.fraud_score,
            t.risk_level, t.fraud_reasons, t.scoring_method, t.model_version, t.hard_flag_triggered, t.shap_explanation, t.created_at,
            a.id AS alert_id, a.status AS alert_status, a.verdict, a.resolution_note, a.resolution_reason,
            a.prevented_amount, a.recovered_amount, a.loss_amount,
            d.status AS dispute_status,
            (SELECT ii.investigation_id FROM investigation_items ii WHERE ii.item_type = 'transaction' AND ii.item_id = t.id LIMIT 1) AS investigation_id
     FROM transactions t
     LEFT JOIN alerts a ON a.transaction_id = t.id
     LEFT JOIN disputes d ON d.transaction_id = t.id
     WHERE t.id IN (${marks(ids.length)})`, ids);

  const alertIds = rows.map((r) => r.alert_id).filter((x) => x !== null && x !== undefined);
  const comments = new Map();
  if (config.cognee.includeAnalystNotes && alertIds.length) {
    const cs = await db.all(`SELECT alert_id, body FROM alert_comments WHERE alert_id IN (${marks(alertIds.length)}) ORDER BY id ASC`, alertIds);
    for (const c of cs) { if (!comments.has(c.alert_id)) comments.set(c.alert_id, []); comments.get(c.alert_id).push(c.body); }
  }

  for (const r of rows) {
    const notes = [];
    if (config.cognee.includeAnalystNotes) {
      if (r.resolution_note) notes.push(redact(r.resolution_note, 400));
      for (const body of (comments.get(r.alert_id) || []).slice(-8)) notes.push(redact(body, 400));
    }
    const record = {
      source_type: 'transaction',
      source_id: String(r.id),
      occurred_at: toIso(r.created_at),
      customer_ref: accountRef(r.user_id),
      merchant: redact(r.merchant, 120) || 'unknown',
      category: redact(r.category, 60) || 'unknown',
      location: redact(r.location, 100) || 'unknown',
      amount: Math.max(0, Number(r.amount) || 0),
      currency: 'unspecified', // FraudGuard stores no currency; never guess one
      fraud_score: Math.min(100, Math.max(0, Number(r.fraud_score) || 0)),
      risk_level: ['low', 'medium', 'high', 'critical'].includes(r.risk_level) ? r.risk_level : 'unknown',
      scoring_method: redact(r.scoring_method, 40) || 'unknown',
      model_version: r.model_version ? redact(r.model_version, 40) : null,
      flagged: Boolean(r.is_fraud),
      detection_reasons: detectionReasons(r),
      model_factors: modelFactors(r),
      device_ref: deviceRef(r.device_fingerprint),
      alert_status: r.alert_status || null,
      verdict: r.verdict || null,
      resolution_reason: r.resolution_reason ? redact(r.resolution_reason, 200) : null,
      analyst_notes: notes.filter(Boolean),
      prevented_amount: num(r.prevented_amount),
      recovered_amount: num(r.recovered_amount),
      loss_amount: num(r.loss_amount),
      dispute_status: r.dispute_status || null,
      investigation_id: r.investigation_id ? String(r.investigation_id) : null,
    };
    for (const k of Object.keys(record)) if (record[k] === null) delete record[k]; // schema fields are optional; omit nulls
    record.content_hash = hashOf(record);
    out.set(Number(r.id), record);
  }
  return out;
}

async function projectInvestigations(ids) {
  const out = new Map();
  if (!ids.length) return out;
  const invs = await db.all(`SELECT * FROM investigations WHERE id IN (${marks(ids.length)})`, ids);
  for (const inv of invs) {
    const items = await db.all("SELECT item_id FROM investigation_items WHERE investigation_id = ? AND item_type = 'transaction' ORDER BY item_id ASC LIMIT 500", [inv.id]);
    const txIds = items.map((i) => Number(i.item_id));
    const members = txIds.length
      ? await db.all(`SELECT id, user_id, amount FROM transactions WHERE id IN (${marks(txIds.length)})`, txIds) : [];
    const events = config.cognee.includeAnalystNotes
      ? await db.all("SELECT kind, summary FROM investigation_events WHERE investigation_id = ? ORDER BY id ASC LIMIT 200", [inv.id]) : [];
    const record = {
      source_type: 'investigation',
      source_id: String(inv.id),
      occurred_at: toIso(inv.created_at),
      title: redact(inv.title, 200) || `Investigation ${inv.id}`,
      summary: inv.summary ? redact(inv.summary, 1500) : null,
      status: inv.status,
      priority: inv.priority,
      outcome: inv.outcome || null,
      outcome_note: config.cognee.includeAnalystNotes && inv.outcome_note ? redact(inv.outcome_note, 1500) : null,
      timeline_notes: events.map((e) => `${e.kind}: ${redact(e.summary, 250)}`).slice(-25),
      transaction_ids: txIds.map(String),
      customer_refs: [...new Set(members.map((m) => accountRef(m.user_id)))].slice(0, 200),
      exposure_amount: members.reduce((s, m) => s + (Number(m.amount) || 0), 0),
      closed_at: inv.closed_at ? toIso(inv.closed_at) : null,
    };
    for (const k of Object.keys(record)) if (record[k] === null) delete record[k];
    record.content_hash = hashOf(record);
    out.set(Number(inv.id), record);
  }
  return out;
}

module.exports = {
  newTransactionIds, rescanTransactionIds, investigationIds, maxIds,
  projectTransactions, projectInvestigations, hashOf, lookbackClause, toIso,
};
