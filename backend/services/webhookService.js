/**
 * Outbound webhooks (feature: webhook notifications). Without this,
 * finding out about a high-risk transaction meant polling REST or
 * holding a live WebSocket connection open — this pushes a signed HTTP
 * POST to a URL the account owner registered, the same integration
 * pattern Stripe/GitHub use for "call me when X happens."
 *
 * Delivery is fire-and-forget from the caller's perspective (see
 * `dispatch` below) — a slow or broken receiving endpoint must never
 * add latency to the transaction API that triggered it, and a webhook
 * failing to deliver is not a reason to fail the underlying request.
 *
 * Retry persistence (feature: retries that survive a restart): the
 * first delivery attempt happens inline, right here, the moment
 * dispatch() is called. If it fails, the retry is NOT scheduled with an
 * in-memory setTimeout (which a process restart — a deploy, a crash —
 * would silently lose along with every pending retry). Instead it's
 * written to the webhook_retry_queue table, and services/webhookRetryWorker.js
 * sweeps for due rows on an interval, on whichever server instance
 * happens to be running one. A retry queued right before a restart
 * still eventually fires after the process comes back up, because its
 * due-ness lives in the database, not in this process's memory.
 */

const crypto = require('crypto');
const config = require('../config/env');
const logger = require('../config/logger');
const webhookRepository = require('../models/webhookRepository');
const metrics = require('../middleware/metrics');

/**
 * HMAC-SHA256 over `${timestamp}.${payload}`, the same construction
 * Stripe uses — including the timestamp in the signed content (not just
 * alongside it) lets a receiver reject a replayed-but-otherwise-valid
 * payload if it also checks the timestamp is recent.
 */
function sign(secret, timestamp, payload) {
  return crypto.createHmac('sha256', secret).update(`${timestamp}.${payload}`).digest('hex');
}

async function attemptDelivery(webhook, event, payload) {
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = sign(webhook.secret, timestamp, payload);
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), config.webhookTimeoutMs);

  try {
    const response = await fetch(webhook.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-FraudGuard-Event': event,
        'X-FraudGuard-Signature': `t=${timestamp},v1=${signature}`,
      },
      body: payload,
      signal: controller.signal,
    });
    return { ok: response.ok, status: response.status, error: null };
  } catch (err) {
    // Network failure, DNS failure, timeout (AbortError), etc. — no
    // response to read a status from.
    return { ok: false, status: null, error: err.message };
  } finally {
    clearTimeout(timeoutId);
  }
}

/** exponential backoff: 2s, 4s, 8s, ... — shared by the inline first
 * retry-scheduling decision and the persistent-queue worker, so both
 * paths compute the same delay for the same attempt number. */
function backoffMs(attempt) {
  return 2 ** attempt * 1000;
}

/** Logs the outcome of one delivery attempt (webhook_deliveries — the
 * account owner's visible history) and records the metrics counter.
 * Shared by both the inline first attempt and the queue-driven retries
 * below, so "every attempt gets logged the same way" doesn't have to be
 * maintained in two places. */
async function recordAttempt(webhook, event, payload, attempt, result) {
  metrics.webhookDeliveriesTotal.inc({ success: String(result.ok) });
  return webhookRepository.logDelivery({
    webhookId: webhook.id, event, payload, responseStatus: result.status, success: result.ok, attempt, error: result.error,
  }).catch((err) => logger.error('Failed to record webhook delivery attempt', { webhookId: webhook.id, error: err.message }));
}

/**
 * The first delivery attempt for a freshly-dispatched event — inline,
 * not queued, so a webhook that's currently healthy gets its
 * notification with no artificial delay. On failure, queues a
 * persistent retry rather than an in-memory timer (see the module
 * comment above for why). Never throws — see dispatch()'s catch.
 */
async function deliverFirstAttempt(webhook, event, payload) {
  const result = await attemptDelivery(webhook, event, payload);
  await recordAttempt(webhook, event, payload, 1, result);

  if (!result.ok && config.webhookMaxRetries > 1) {
    const nextRetryAt = new Date(Date.now() + backoffMs(1)).toISOString();
    await webhookRepository.queueRetry({ webhookId: webhook.id, event, payload, attempt: 2, nextRetryAt })
      .catch((err) => logger.error('Failed to queue webhook retry', { webhookId: webhook.id, error: err.message }));
  } else if (!result.ok) {
    logger.warn('Webhook delivery exhausted retries', { webhookId: webhook.id, url: webhook.url, event, attempts: 1 });
  }
}

/**
 * Attempts one due row from the persistent retry queue (called by
 * services/webhookRetryWorker.js's sweep, never directly by dispatch()).
 * On success or final exhaustion, removes the row; otherwise reschedules
 * it in place with the next backoff delay and an incremented attempt
 * count. If the webhook was deleted or deactivated since this retry was
 * queued, drops it silently — there's no one left to deliver to.
 */
async function retryDelivery(queueRow) {
  const webhook = await webhookRepository.findById(queueRow.webhook_id);
  if (!webhook || !webhook.active) {
    return webhookRepository.removeRetryEntry(queueRow.id);
  }

  const result = await attemptDelivery(webhook, queueRow.event, queueRow.payload);
  await recordAttempt(webhook, queueRow.event, queueRow.payload, queueRow.attempt, result);

  if (result.ok) {
    return webhookRepository.removeRetryEntry(queueRow.id);
  }

  if (queueRow.attempt < config.webhookMaxRetries) {
    const nextRetryAt = new Date(Date.now() + backoffMs(queueRow.attempt)).toISOString();
    return webhookRepository.updateRetryEntry(queueRow.id, { attempt: queueRow.attempt + 1, nextRetryAt });
  }

  logger.warn('Webhook delivery exhausted retries', { webhookId: webhook.id, url: webhook.url, event: queueRow.event, attempts: queueRow.attempt });
  return webhookRepository.removeRetryEntry(queueRow.id);
}

/**
 * Looks up every active webhook the given user has subscribed to
 * `event` and fires the first attempt at all of them — never awaited by
 * callers (see routes/transactions.js), so a slow subscriber can't slow
 * down the request that triggered the event.
 */
function dispatch(userId, event, data) {
  const payload = JSON.stringify({ event, data, timestamp: new Date().toISOString() });

  webhookRepository.forUserAndEvent(userId, event)
    .then((webhooks) => {
      for (const webhook of webhooks) {
        deliverFirstAttempt(webhook, event, payload)
          .catch((err) => logger.error('Webhook dispatch threw unexpectedly', { webhookId: webhook.id, error: err.message }));
      }
    })
    .catch((err) => logger.error('Webhook lookup failed', { userId, event, error: err.message }));
}

module.exports = { dispatch, sign, retryDelivery, backoffMs };
