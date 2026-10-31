/**
 * Sweeps models/webhookRepository.js's webhook_retry_queue on an
 * interval and retries whatever's due (feature: retries that survive a
 * restart). This is what actually makes the persistent queue in
 * services/webhookService.js meaningful — a row sitting in the table
 * does nothing by itself; something has to periodically look for due
 * rows and act on them. Started from server.js on boot (not app.js —
 * see that file's comment on the app/server split), and deliberately
 * NOT started under NODE_ENV=test, where tests call sweepOnce()
 * directly for determinism instead of waiting on a real timer.
 */

const config = require('../config/env');
const logger = require('../config/logger');
const webhookRepository = require('../models/webhookRepository');
const webhookService = require('./webhookService');

let intervalHandle = null;
let sweeping = false; // guards against an overlapping sweep if one run takes longer than the interval

async function sweepOnce() {
  if (sweeping) return;
  sweeping = true;
  try {
    const due = await webhookRepository.dueRetries();
    for (const row of due) {
      // Sequential, not Promise.all — a burst of many due retries
      // shouldn't fire as one thundering herd of concurrent outbound
      // requests; the next tick picks up whatever this one didn't reach
      // if the queue is large enough for it to matter.
      await webhookService.retryDelivery(row)
        .catch((err) => logger.error('Webhook retry sweep: one delivery threw unexpectedly', { queueId: row.id, webhookId: row.webhook_id, error: err.message }));
    }
  } catch (err) {
    logger.error('Webhook retry sweep failed', { error: err.message });
  } finally {
    sweeping = false;
  }
}

function start() {
  if (intervalHandle) return; // already running — start() is safe to call more than once
  intervalHandle = setInterval(() => { sweepOnce().catch(() => {}); }, config.webhookRetrySweepIntervalMs);
  // Don't let this timer alone keep the Node process alive (e.g. during
  // a graceful shutdown that's otherwise idle) — matches how a
  // background interval like this is expected to behave.
  intervalHandle.unref?.();
}

function stop() {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}

module.exports = { start, stop, sweepOnce };
