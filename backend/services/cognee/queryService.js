/**
 * Read side of the Cognee integration: historical search, entities/graph, health and the
 * investigation assistant.
 *
 * Every answer keeps three layers apart so an investigator can tell fact from memory from model output:
 *   subject  - current facts about the record under investigation, read from FraudGuard's own database;
 *   evidence - historical records retrieved from Cognee, each cross-checked against the live record
 *              (does it still exist? is the memory's verdict out of date?);
 *   ai       - generated suggestions, only present when an LLM is configured, with validated citations.
 */
const db = require('../../config/database');
const config = require('../../config/env');
const client = require('./client');
const projector = require('./projector');
const sync = require('./syncService');

async function liveContext(items) {
  const txIds = items.filter((e) => e.source_type === 'transaction').map((e) => Number(e.source_id)).filter(Number.isFinite);
  const invIds = items.filter((e) => e.source_type === 'investigation').map((e) => Number(e.source_id)).filter(Number.isFinite);
  const marks = (n) => Array.from({ length: n }, () => '?').join(',');
  const tx = new Map(); const inv = new Map();
  if (txIds.length) {
    const rows = await db.all(
      `SELECT t.id, t.risk_level, t.fraud_score, a.id AS alert_id, a.status AS alert_status, a.verdict
       FROM transactions t LEFT JOIN alerts a ON a.transaction_id = t.id WHERE t.id IN (${marks(txIds.length)})`, txIds);
    rows.forEach((r) => tx.set(String(r.id), r));
  }
  if (invIds.length) {
    const rows = await db.all(`SELECT id, status, outcome, priority FROM investigations WHERE id IN (${marks(invIds.length)})`, invIds);
    rows.forEach((r) => inv.set(String(r.id), r));
  }
  return items.map((e) => {
    if (e.source_type === 'transaction') {
      const live = tx.get(String(e.source_id));
      if (!live) return { ...e, live: { exists: false } };
      const memVerdict = e.properties?.verdict ?? null;
      return { ...e, live: {
        exists: true, url: `/transactions/${e.source_id}`, riskLevel: live.risk_level, fraudScore: Number(live.fraud_score),
        alertId: live.alert_id ? Number(live.alert_id) : null, alertStatus: live.alert_status || null, verdict: live.verdict || null,
        memoryOutOfDate: (live.verdict || null) !== memVerdict,
      } };
    }
    const live = inv.get(String(e.source_id));
    if (!live) return { ...e, live: { exists: false } };
    return { ...e, live: { exists: true, url: `/cases/${e.source_id}`, status: live.status, outcome: live.outcome || null, priority: live.priority,
      memoryOutOfDate: (live.outcome || null) !== (e.properties?.outcome ?? null) || live.status !== (e.properties?.status ?? live.status) } };
  });
}

async function search({ query, topK = 8, sourceTypes = [], includeAnswer = false }) {
  const result = await client.post('/v1/search', { query, top_k: topK, source_types: sourceTypes, include_answer: includeAnswer }, { timeoutMs: config.cognee.requestTimeoutMs * 2 });
  return {
    query,
    evidence: { label: 'Retrieved from Cognee memory - historical FraudGuard records, not generated', items: await liveContext(result.evidence || []) },
    answer: result.answer ? { ...result.answer, label: 'AI-generated summary of the retrieved graph - verify against the evidence' } : null,
    diagnostics: result.diagnostics,
  };
}

const entities = ({ type, q, limit, offset, suspiciousOnly }) => client.get(
  `/v1/entities?${new URLSearchParams({ limit, offset, ...(type ? { type } : {}), ...(q ? { q } : {}), ...(suspiciousOnly ? { suspicious_only: 'true' } : {}) })}`);
const related = (id, depth = 1) => client.get(`/v1/entities/${encodeURIComponent(id)}/related?depth=${depth}`);

async function health() {
  const base = { configured: client.isConfigured(), reachable: false, schedulerEnabled: config.cognee.syncIntervalMs > 0 };
  if (!base.configured) return { ...base, status: 'not_configured', message: 'Set COGNEE_SERVICE_URL and COGNEE_SERVICE_API_KEY, then restart the backend.' };
  try {
    const h = await client.get('/v1/health', { retries: 1, timeoutMs: 8000 });
    return { ...base, reachable: true, status: h.status, service: h };
  } catch (err) {
    return { ...base, status: 'unreachable', error: { code: err.code || 'error', message: err.message } };
  }
}

async function stats() {
  const [syncState, mem] = await Promise.all([
    sync.syncStatus(),
    client.get('/v1/stats', { retries: 1, timeoutMs: 15000 }).catch((err) => ({ unavailable: true, error: err.message })),
  ]);
  return { sync: syncState, memory: mem };
}

// ---------------------------------------------------------------- assistant
const money = (v) => (v === undefined || v === null ? 'n/a' : Number(v).toFixed(2));

function describeTransaction(r) {
  const lines = [
    `Transaction ${r.source_id}: ${money(r.amount)} at ${r.merchant} (${r.category}), location ${r.location}, ${r.occurred_at}.`,
    `Customer account ${r.customer_ref}. Device ${r.device_ref || 'not recorded'}.`,
    `Fraud risk ${r.risk_level} (score ${Math.round(r.fraud_score)}/100, ${r.scoring_method}${r.model_version ? ` model ${r.model_version}` : ''}); flagged: ${r.flagged ? 'yes' : 'no'}.`,
  ];
  if (r.detection_reasons?.length) lines.push(`Detection reasons: ${r.detection_reasons.join('; ')}.`);
  if (r.model_factors?.length) lines.push(`Top model factors: ${r.model_factors.join('; ')}.`);
  lines.push(`Alert status: ${r.alert_status || 'no alert'}; verdict: ${r.verdict || 'none yet'}${r.resolution_reason ? `; resolution reason: ${r.resolution_reason}` : ''}.`);
  if (r.analyst_notes?.length) lines.push(`Analyst notes: ${r.analyst_notes.join(' | ')}`);
  if (r.dispute_status) lines.push(`Dispute status: ${r.dispute_status}.`);
  if (r.investigation_id) lines.push(`Part of investigation ${r.investigation_id}.`);
  return lines.join('\n');
}

function describeInvestigation(r) {
  const lines = [`Investigation ${r.source_id}: "${r.title}" - status ${r.status}, priority ${r.priority}, outcome ${r.outcome || 'undecided'}.`];
  if (r.summary) lines.push(`Summary: ${r.summary}`);
  if (r.outcome_note) lines.push(`Outcome / remediation decision: ${r.outcome_note}`);
  if (r.timeline_notes?.length) lines.push(`Analyst timeline: ${r.timeline_notes.join(' | ')}`);
  lines.push(`Covers ${r.transaction_ids.length} transaction(s) across ${r.customer_refs.length} customer account(s); exposure ${money(r.exposure_amount)}.`);
  return lines.join('\n');
}

/** Returns null when the record does not exist. */
async function buildSubject(kind, id) {
  if (kind === 'transaction') {
    const rec = (await projector.projectTransactions([Number(id)])).get(Number(id));
    if (!rec) return null;
    return { kind, source_id: String(id), summary: describeTransaction(rec), customer_ref: rec.customer_ref, merchant: rec.merchant, device_ref: rec.device_ref };
  }
  const rec = (await projector.projectInvestigations([Number(id)])).get(Number(id));
  if (!rec) return null;
  return { kind, source_id: String(id), summary: describeInvestigation(rec) };
}

async function assist({ kind, id, question, topK = 8 }) {
  if (!client.isConfigured()) throw new client.CogneeError('not_configured', 'Cognee is not configured. Set COGNEE_SERVICE_URL and COGNEE_SERVICE_API_KEY on the backend.', 503);
  const subject = await buildSubject(kind, id);
  if (!subject) return null;
  const res = await client.post('/v1/assistant', { subject, question: question || undefined, top_k: topK }, { timeoutMs: config.cognee.requestTimeoutMs * 3 });
  res.evidence.items = await liveContext(res.evidence.items || []);
  res.subject = { ...res.subject, label: 'Current FraudGuard record facts (from the database, pseudonymised)' };
  return res;
}

module.exports = { search, entities, related, health, stats, assist, buildSubject, liveContext, describeTransaction };
