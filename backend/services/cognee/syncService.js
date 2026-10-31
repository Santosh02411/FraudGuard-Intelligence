/**
 * Incremental synchronisation: FraudGuard -> Cognee memory.
 *
 * What gets sent on a run
 *   1. records whose previous attempt FAILED (so a transient outage is healed automatically);
 *   2. NEW transactions (id above the stored cursor, inside the lookback window);
 *   3. already-seen transactions that can still change (they have an alert, a dispute, or belong to an
 *      investigation) - re-projected and sent only if their content hash changed (verdict, status,
 *      notes, outcome, dispute...);
 *   4. new/changed investigations, plus any member transactions Cognee has not seen yet, so the
 *      case->transaction links can always be built.
 *
 * Duplicate prevention
 *   - every sent record's SHA-256 content hash is stored in cognee_sync_records; an identical record
 *     is skipped, never re-sent;
 *   - the Cognee side is independently idempotent (deterministic node ids / content-addressed docs),
 *     so even a retried or replayed batch cannot create duplicates.
 *
 * Failure behaviour
 *   - the cursor only advances past a batch once that batch was fully recorded (synced or marked failed),
 *     so an outage mid-run never skips records;
 *   - a per-record failure marks that record `failed` and the run continues.
 *
 * Only one run executes at a time (in-process flag + a `running` row with a staleness timeout).
 */
const db = require('../../config/database');
const config = require('../../config/env');
const logger = require('../../config/logger');
const client = require('./client');
const projector = require('./projector');

const STALE_RUN_MS = 20 * 60 * 1000;
const RESCAN_PAGE = 500;
let inProcess = false;
let timer = null;

const now = () => new Date().toISOString();
const marks = (n) => Array.from({ length: n }, () => '?').join(',');

class SyncBusyError extends Error { constructor() { super('A synchronisation run is already in progress'); this.code = 'busy'; } }

async function getCursor(sourceType) {
  const row = await db.get('SELECT last_id FROM cognee_sync_cursor WHERE source_type = ?', [sourceType]);
  return Number(row?.last_id || 0);
}
async function setCursor(sourceType, lastId) {
  await db.run(
    `INSERT INTO cognee_sync_cursor (source_type, last_id, updated_at) VALUES (?, ?, ?)
     ON CONFLICT (source_type) DO UPDATE SET last_id = excluded.last_id, updated_at = excluded.updated_at`,
    [sourceType, lastId, now()]);
}

async function storedHashes(sourceType, ids) {
  const map = new Map();
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500).map(String);
    const rows = await db.all(
      `SELECT source_id, content_hash, status FROM cognee_sync_records WHERE source_type = ? AND source_id IN (${marks(chunk.length)})`,
      [sourceType, ...chunk]);
    for (const r of rows) map.set(String(r.source_id), r);
  }
  return map;
}
const isUnchanged = (stored, record) => Boolean(stored && stored.status === 'synced' && stored.content_hash === record.content_hash);

async function recordOutcome(sourceType, sourceId, hash, result) {
  const ts = now();
  const ok = result.status === 'ingested';
  const err = ok ? null : String(result.error || 'ingest failed').slice(0, 500);
  await db.run(
    `INSERT INTO cognee_sync_records (source_type, source_id, content_hash, status, narrative_status, attempts, last_error, first_synced_at, last_synced_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (source_type, source_id) DO UPDATE SET
       content_hash = excluded.content_hash, status = excluded.status, narrative_status = excluded.narrative_status,
       attempts = CASE WHEN excluded.status = 'synced' THEN 0 ELSE cognee_sync_records.attempts + 1 END,
       last_error = excluded.last_error,
       first_synced_at = COALESCE(cognee_sync_records.first_synced_at, excluded.first_synced_at),
       last_synced_at = CASE WHEN excluded.status = 'synced' THEN excluded.last_synced_at ELSE cognee_sync_records.last_synced_at END,
       updated_at = excluded.updated_at`,
    [sourceType, String(sourceId), hash, ok ? 'synced' : 'failed', result.narrative || null, ok ? 0 : 1, err, ok ? ts : null, ok ? ts : null, ts]);
}

/** Build the ordered work list for one run. Pure selection + projection; nothing is sent here. */
async function collectWork({ mode, force, cap }) {
  const lookbackDays = config.cognee.lookbackDays;
  const includeSynthetic = config.cognee.includeSynthetic;
  const txWork = new Map();   // id -> { record, isNew }
  const invWork = new Map();
  let scanned = 0; let skipped = 0; let moreRemaining = false;
  const room = () => cap - txWork.size - invWork.size;

  const consider = async (ids, project, work, type, isNew) => {
    const records = await project(ids);
    const stored = await storedHashes(type, [...records.keys()]);
    for (const id of ids) {
      const record = records.get(id);
      if (!record) continue;
      scanned += 1;
      if (!force && isUnchanged(stored.get(String(id)), record)) { skipped += 1; continue; }
      if (work.has(id)) continue;
      work.set(id, { record, isNew });
    }
  };

  // 1) retry previously failed records
  const failed = await db.all("SELECT source_type, source_id FROM cognee_sync_records WHERE status = 'failed' ORDER BY updated_at ASC LIMIT ?", [Math.min(100, cap)]);
  const failedTx = failed.filter((f) => f.source_type === 'transaction').map((f) => Number(f.source_id));
  const failedInv = failed.filter((f) => f.source_type === 'investigation').map((f) => Number(f.source_id));
  if (failedTx.length) await consider(failedTx, projector.projectTransactions, txWork, 'transaction', false);
  if (failedInv.length) await consider(failedInv, projector.projectInvestigations, invWork, 'investigation', false);

  // 2) new transactions after the cursor
  const startCursor = mode === 'full' ? 0 : await getCursor('transaction');
  let cursor = startCursor;
  while (room() > 0) {
    const ids = await projector.newTransactionIds({ afterId: cursor, limit: Math.min(RESCAN_PAGE, room()), lookbackDays, includeSynthetic });
    if (!ids.length) break;
    await consider(ids, projector.projectTransactions, txWork, 'transaction', true);
    cursor = ids[ids.length - 1];
  }
  if (room() <= 0) moreRemaining = true;

  // 3) rescan seen transactions that can still change
  if (room() > 0) {
    let after = 0;
    for (;;) {
      const ids = await projector.rescanTransactionIds({ uptoId: startCursor, afterScanId: after, limit: RESCAN_PAGE, lookbackDays, includeSynthetic });
      if (!ids.length) break;
      await consider(ids, projector.projectTransactions, txWork, 'transaction', false);
      after = ids[ids.length - 1];
      if (room() <= 0) { moreRemaining = true; break; }
    }
  }

  // 4) investigations (+ members Cognee has not seen)
  if (room() > 0) {
    const ids = await projector.investigationIds({ afterId: 0, limit: 2000 });
    for (let i = 0; i < ids.length; i += 200) await consider(ids.slice(i, i + 200), projector.projectInvestigations, invWork, 'investigation', false);
  }
  const memberIds = new Set();
  for (const { record } of invWork.values()) for (const t of record.transaction_ids || []) memberIds.add(Number(t));
  const unseenMembers = [...memberIds].filter((id) => !txWork.has(id));
  if (unseenMembers.length) {
    const seen = await storedHashes('transaction', unseenMembers);
    const missing = unseenMembers.filter((id) => !(seen.get(String(id)) && seen.get(String(id)).status === 'synced'));
    if (missing.length) await consider(missing, projector.projectTransactions, txWork, 'transaction', false);
  }
  return { txWork, invWork, scanned, skipped, moreRemaining, startCursor };
}

async function runSync({ mode = 'incremental', trigger = 'manual', actor = null, force = false, maxRecords } = {}) {
  if (!client.isConfigured()) throw new client.CogneeError('not_configured', 'Cognee is not configured. Set COGNEE_SERVICE_URL and COGNEE_SERVICE_API_KEY on the backend.', 503);
  // Check-and-set with NO await in between, so two simultaneous requests cannot both pass.
  if (inProcess) throw new SyncBusyError();
  inProcess = true;
  try {
    const staleBefore = new Date(Date.now() - STALE_RUN_MS).toISOString();
    await db.run("UPDATE cognee_sync_runs SET status = 'abandoned', finished_at = ? WHERE status = 'running' AND started_at < ?", [now(), staleBefore]);
    const active = await db.get("SELECT id FROM cognee_sync_runs WHERE status = 'running'");
    if (active) throw new SyncBusyError(); // another instance is syncing
  } catch (err) {
    inProcess = false;
    throw err;
  }
  const cap = Math.max(1, Math.min(maxRecords || config.cognee.maxPerRun, 5000));
  const { lastInsertRowid } = await db.insert(
    'INSERT INTO cognee_sync_runs (trigger_kind, mode, actor, status, started_at) VALUES (?, ?, ?, ?, ?)', [trigger, mode, actor, 'running', now()]);
  const runId = Number(lastInsertRowid);
  const tally = { scanned: 0, ingested: 0, skipped: 0, failed: 0, morePending: false };
  let finalStatus = 'completed'; let errorMessage = null;

  try {
    const { txWork, invWork, scanned, skipped, moreRemaining, startCursor } = await collectWork({ mode, force, cap });
    tally.scanned = scanned; tally.skipped = skipped; tally.morePending = moreRemaining;

    // Order: non-new tx, new tx ascending (cursor moves monotonically), then investigations.
    const txItems = [...txWork.entries()].map(([id, v]) => ({ id, ...v }));
    txItems.sort((a, b) => (Number(a.isNew) - Number(b.isNew)) || (a.id - b.id));
    const invItems = [...invWork.entries()].map(([id, v]) => ({ id, ...v }));
    const batches = [];
    const size = config.cognee.batchSize;
    for (let i = 0; i < txItems.length; i += size) batches.push({ transactions: txItems.slice(i, i + size), investigations: [] });
    for (let i = 0; i < invItems.length; i += size) batches.push({ transactions: [], investigations: invItems.slice(i, i + size) });

    let cursor = startCursor;
    const storedCursor = await getCursor('transaction');
    for (const batch of batches) {
      const payload = { transactions: batch.transactions.map((x) => x.record), investigations: batch.investigations.map((x) => x.record) };
      const response = await client.post('/v1/ingest', payload, { timeoutMs: config.cognee.ingestTimeoutMs });
      const byKey = new Map((response.results || []).map((r) => [r.source_key, r]));
      for (const item of [...batch.transactions.map((x) => ({ ...x, type: 'transaction' })), ...batch.investigations.map((x) => ({ ...x, type: 'investigation' }))]) {
        const result = byKey.get(`${item.type}:${item.id}`) || { status: 'failed', error: 'no result returned for record' };
        await recordOutcome(item.type, item.id, item.record.content_hash, result);
        if (result.status === 'ingested') tally.ingested += 1; else tally.failed += 1;
        if (item.type === 'transaction' && item.isNew) cursor = Math.max(cursor, item.id);
      }
      if (cursor > storedCursor) await setCursor('transaction', cursor); // never moves backwards, even in a full re-scan
    }
    if (tally.failed > 0) finalStatus = 'completed_with_errors';
  } catch (err) {
    finalStatus = 'failed';
    errorMessage = String(err.message || err).slice(0, 500);
    logger.error('Cognee sync failed', { runId, error: errorMessage, code: err.code });
  } finally {
    inProcess = false;
    await db.run(
      'UPDATE cognee_sync_runs SET status = ?, finished_at = ?, scanned = ?, ingested = ?, skipped_unchanged = ?, failed = ?, more_pending = ?, error = ? WHERE id = ?',
      [finalStatus, now(), tally.scanned, tally.ingested, tally.skipped, tally.failed, tally.morePending ? 1 : 0, errorMessage, runId]);
  }
  const result = { runId, status: finalStatus, mode, trigger, scanned: tally.scanned, ingested: tally.ingested, skippedUnchanged: tally.skipped, failed: tally.failed, morePending: tally.morePending, error: errorMessage };
  if (finalStatus === 'failed') throw Object.assign(new client.CogneeError('sync_failed', errorMessage, 502), { result });
  return result;
}

async function recentRuns(limit = 10) {
  const rows = await db.all('SELECT * FROM cognee_sync_runs ORDER BY id DESC LIMIT ?', [Math.max(1, Math.min(limit, 50))]);
  return rows.map((r) => ({
    id: Number(r.id), trigger: r.trigger_kind, mode: r.mode, actor: r.actor, status: r.status, startedAt: r.started_at, finishedAt: r.finished_at,
    scanned: Number(r.scanned), ingested: Number(r.ingested), skippedUnchanged: Number(r.skipped_unchanged), failed: Number(r.failed),
    morePending: Boolean(Number(r.more_pending)), error: r.error,
  }));
}

async function syncStatus() {
  const counts = await db.all('SELECT source_type, status, COUNT(*) AS n FROM cognee_sync_records GROUP BY source_type, status');
  const summary = { transaction: { synced: 0, failed: 0 }, investigation: { synced: 0, failed: 0 } };
  for (const c of counts) if (summary[c.source_type]) summary[c.source_type][c.status] = Number(c.n);
  const cursor = await getCursor('transaction');
  const lb = projector.lookbackClause('t.created_at', config.cognee.lookbackDays);
  const pendingNew = await db.get(
    `SELECT COUNT(*) AS n FROM transactions t WHERE t.id > ? AND ${lb.sql} ${config.cognee.includeSynthetic ? '' : 'AND t.is_synthetic = 0'}`, [cursor, ...lb.params]);
  const last = (await recentRuns(1))[0] || null;
  const lastOk = await db.get("SELECT finished_at FROM cognee_sync_runs WHERE status IN ('completed', 'completed_with_errors') ORDER BY id DESC LIMIT 1");
  return {
    running: inProcess,
    scheduler: { enabled: Boolean(timer), intervalMs: config.cognee.syncIntervalMs },
    records: summary,
    pendingNewTransactions: Number(pendingNew?.n || 0),
    lastRun: last,
    lastSuccessfulSyncAt: lastOk?.finished_at || null,
  };
}

function startScheduler() {
  if (timer || !client.isConfigured() || config.cognee.syncIntervalMs <= 0) return false;
  timer = setInterval(() => {
    runSync({ trigger: 'scheduler', actor: 'system:scheduler' }).catch((err) => {
      if (err.code !== 'busy') logger.warn('Scheduled Cognee sync failed', { error: err.message, code: err.code });
    });
  }, config.cognee.syncIntervalMs);
  timer.unref();
  logger.info('Cognee sync scheduler started', { intervalMs: config.cognee.syncIntervalMs });
  return true;
}
function stopScheduler() { if (timer) { clearInterval(timer); timer = null; } }

module.exports = { runSync, recentRuns, syncStatus, startScheduler, stopScheduler, SyncBusyError, _internals: { collectWork, getCursor } };
