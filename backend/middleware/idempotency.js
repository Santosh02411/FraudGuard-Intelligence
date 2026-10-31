/**
 * Idempotency keys on POST /transactions (feature: safe retries).
 * ====================================================================
 * Opt-in via an `Idempotency-Key` request header — the same pattern
 * Stripe uses. Without this, a network timeout after the server
 * already processed a submission (but before the client saw the
 * response) leaves the client unable to tell "did that go through?"
 * from "did that fail?" — the only safe move is to retry, and without
 * an idempotency key, retrying a POST double-submits the transaction.
 *
 * Semantics (scoped per user, so two different accounts can reuse the
 * same key value without colliding):
 *   - No header at all → pass through untouched, business as usual.
 *   - Same key + same request body, already completed → replay the
 *     original response verbatim (2xx or error) instead of
 *     reprocessing.
 *   - Same key + DIFFERENT request body → 409, since silently
 *     returning the old response for a materially different request
 *     would be actively wrong, not just unhelpful.
 *   - Same key, a request with it is still mid-flight (concurrent
 *     retry, not sequential) → 409 "already in progress" rather than
 *     letting both proceed and double-submit.
 *
 * Must run AFTER auth (needs req.user) and AFTER body validation (needs
 * the coerced/normalized req.body, so two requests that are the same
 * modulo e.g. "50" vs 50 hash identically) — see routes/transactions.js
 * for the actual ordering.
 */

const crypto = require('crypto');
const idempotencyRepository = require('../models/idempotencyRepository');
const config = require('../config/env');
const logger = require('../config/logger');
const { AppError, asyncHandler } = require('./errorHandler');

function hashBody(body) {
  return crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex');
}

const ALREADY_IN_PROGRESS = 'A request with this idempotency key is already being processed. Retry shortly.';

const idempotency = asyncHandler(async (req, res, next) => {
  const key = req.headers['idempotency-key'];
  if (!key) return next(); // opt-in — most callers (the frontend) don't send one

  if (typeof key !== 'string' || key.length < 1 || key.length > 255) {
    throw AppError.badRequest('Idempotency-Key header must be a non-empty string up to 255 characters');
  }

  const requestHash = hashBody(req.body);
  let existing = await idempotencyRepository.find(req.user.id, key);

  // Lazily expire — no cleanup job needed for this to be correct, just
  // to keep old rows from accumulating forever (acceptable for a
  // project this size; a real deployment would also prune expired rows
  // periodically).
  if (existing && new Date(existing.expires_at).getTime() < Date.now()) {
    await idempotencyRepository.remove(existing.id).catch(() => {});
    existing = null;
  }

  let rowId = null;
  if (existing) {
    if (existing.status === 'pending') {
      // Pending normally means a concurrent request is still working. But if
      // its worker died the reservation would block this key until expiry,
      // so a reservation older than the stale window can be taken over —
      // compare-and-set, so only one retry wins it.
      const takenOver = existing.request_hash === requestHash
        && await idempotencyRepository.takeOverStale(existing.id, { requestHash, staleAfterMs: config.idempotencyPendingStaleMs });
      if (!takenOver) throw AppError.conflict(ALREADY_IN_PROGRESS);
      rowId = existing.id;
    } else {
      if (existing.request_hash !== requestHash) {
        throw AppError.conflict('This idempotency key was already used with a different request body.');
      }
      res.set('Idempotent-Replay', 'true');
      return res.status(existing.response_status).json(JSON.parse(existing.response_body));
    }
  }

  if (rowId === null) {
    const expiresAt = new Date(Date.now() + config.idempotencyKeyTtlHours * 60 * 60 * 1000).toISOString();
    let reserved;
    try {
      // The UNIQUE (user_id, idempotency_key) constraint is what makes this
      // safe: of any number of simultaneous requests with the same key,
      // exactly one INSERT succeeds. The application-level lookup above is
      // only a fast path.
      reserved = await idempotencyRepository.reserve({ userId: req.user.id, key, requestHash, expiresAt });
    } catch (err) {
      if (idempotencyRepository.isUniqueViolation(err)) {
        // Lost a race to a concurrent request presenting the same key —
        // not a sequential retry, a genuinely simultaneous one.
        throw AppError.conflict(ALREADY_IN_PROGRESS);
      }
      throw err;
    }
    rowId = reserved.lastInsertRowid;
  }

  // Handlers that persist their work in a database transaction complete the
  // key INSIDE that transaction (so "work done" and "key completed" commit
  // together) and set this so the fallback below doesn't repeat it.
  req.idempotencyRowId = rowId;
  req.idempotencyCompletedInTx = false;
  // Intercept the handler's eventual res.json() call to persist the
  // response against this key — only for 2xx (an unexpected 500 isn't
  // safe to permanently cache as "the" answer for this key; deleting
  // the reservation instead lets a retry go through cleanly once
  // whatever broke is fixed).
  const originalJson = res.json.bind(res);
  res.json = (body) => {
    if (res.statusCode >= 200 && res.statusCode < 300) {
      if (req.idempotencyCompletedInTx) return originalJson(body);
      idempotencyRepository.complete(rowId, res.statusCode, JSON.stringify(body))
        .catch((err) => logger.error('Failed to persist idempotent response', { key, error: err.message }));
    } else {
      idempotencyRepository.remove(rowId)
        .catch((err) => logger.error('Failed to clean up idempotency reservation', { key, error: err.message }));
    }
    return originalJson(body);
  };

  next();
});

module.exports = { idempotency };
