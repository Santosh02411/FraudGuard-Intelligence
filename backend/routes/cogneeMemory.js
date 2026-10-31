/**
 * Cognee fraud-intelligence memory API (admin / investigator only).
 *
 *   GET  /health                  integration health (service reachability, LLM / embeddings, stores)
 *   GET  /status                  compact status (kept for backward compatibility)
 *   GET  /stats                   memory statistics + synchronisation state
 *   POST /sync                    incremental (or full) synchronisation FraudGuard -> Cognee
 *   GET  /sync/runs               recent ingestion activity
 *   POST /search                  natural-language search over historical fraud intelligence
 *   GET  /entities                graph entities (customers, merchants, devices, patterns, cases, transactions)
 *   GET  /entities/:id/related    entity neighbourhood (nodes + edges)
 *   POST /assistant               investigation assistant for a transaction or a case
 *
 * Authentication: the existing JWT (authMiddleware) + role check (adminMiddleware) on every route.
 * The service key and any LLM/embedding key live on the server only and are never returned.
 * Audit log records who did what; query text is never written to logs (only its length).
 */
const express = require('express');
const { authMiddleware, adminMiddleware } = require('../middleware/auth');
const { asyncHandler, AppError } = require('../middleware/errorHandler');
const { validate } = require('../middleware/validate');
const { audit } = require('../middleware/auditLog');
const { cogneeSyncLimiter, cogneeQueryLimiter } = require('../middleware/rateLimiters');
const schemas = require('../schemas/cogneeSchemas');
const cognee = require('../services/cognee');

const router = express.Router();
router.use(authMiddleware, adminMiddleware);

const A = (req, action, targetId, details, outcome = 'success') =>
  audit({ req, userId: req.user.id, username: req.user.username, action, targetType: 'cognee_memory', targetId: String(targetId ?? 'dataset'), outcome, details });

/** Map integration errors to HTTP errors without leaking upstream bodies. */
function mapError(err) {
  if (err instanceof cognee.SyncBusyError) { const e = AppError.conflict(err.message); e.details = { code: 'sync_busy' }; return e; }
  if (err instanceof cognee.CogneeError) {
    const e = new AppError(err.message, err.status || 502);
    e.details = { code: err.code };
    return e;
  }
  return err;
}
const guarded = (fn) => asyncHandler(async (req, res, next) => { try { await fn(req, res, next); } catch (err) { throw mapError(err); } });

router.get('/health', guarded(async (req, res) => { res.json(await cognee.health()); }));

router.get('/status', guarded(async (req, res) => {
  const [health, stats] = await Promise.all([cognee.health(), cognee.stats().catch(() => null)]);
  res.json({
    configured: health.configured, connected: health.reachable, status: health.status, message: health.message || health.error?.message || null,
    dataset: stats?.memory?.dataset || null, lastSyncedAt: stats?.sync?.lastSuccessfulSyncAt || null,
  });
}));

router.get('/stats', guarded(async (req, res) => { res.json(await cognee.stats()); }));

router.post('/sync', cogneeSyncLimiter, validate({ body: schemas.syncBody }), guarded(async (req, res) => {
  try {
    const result = await cognee.runSync({ mode: req.body.mode, force: req.body.force, maxRecords: req.body.maxRecords, trigger: 'manual', actor: req.user.username });
    A(req, 'cognee_memory.sync', result.runId, { mode: result.mode, ingested: result.ingested, skippedUnchanged: result.skippedUnchanged, failed: result.failed });
    res.json(result);
  } catch (err) {
    A(req, 'cognee_memory.sync', 'dataset', { code: err.code }, 'failure');
    throw err;
  }
}));

router.get('/sync/runs', validate({ query: schemas.runsQuery }), guarded(async (req, res) => {
  res.json({ runs: await cognee.recentRuns(req.query.limit) });
}));

router.post('/search', cogneeQueryLimiter, validate({ body: schemas.searchBody }), guarded(async (req, res) => {
  const result = await cognee.search(req.body);
  A(req, 'cognee_memory.search', 'dataset', { queryLength: req.body.query.length, results: result.evidence.items.length });
  res.json(result);
}));

router.get('/entities', validate({ query: schemas.entitiesQuery }), guarded(async (req, res) => {
  res.json(await cognee.entities(req.query));
}));

router.get('/entities/:id/related', validate({ params: schemas.relatedParams, query: schemas.relatedQuery }), guarded(async (req, res) => {
  try {
    res.json(await cognee.related(req.params.id, req.query.depth));
  } catch (err) {
    if (err instanceof cognee.CogneeError && err.code === 'not_found') throw AppError.notFound('Entity not found');
    throw err;
  }
}));

router.post('/assistant', cogneeQueryLimiter, validate({ body: schemas.assistantBody }), guarded(async (req, res) => {
  const result = await cognee.assist(req.body);
  if (!result) throw AppError.notFound(`${req.body.kind === 'transaction' ? 'Transaction' : 'Case'} not found`);
  A(req, 'cognee_memory.assistant', `${req.body.kind}:${req.body.id}`, { aiStatus: result.ai_status, evidence: result.evidence.items.length, hasQuestion: Boolean(req.body.question) });
  res.json(result);
}));

module.exports = router;
