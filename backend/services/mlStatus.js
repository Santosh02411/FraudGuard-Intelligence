/**
 * Lightweight "is the ML service up?" signal for the top-bar status pill.
 *
 * Calls the ML service's open /health endpoint (no credentials, no model details), with a short timeout, and caches the
 * answer for a few seconds so a busy dashboard cannot hammer it. It never throws: an unreachable service is just "down"
 * (the fraud engine itself already falls back to the rule engine in that case).
 */
const config = require('../config/env');

const TTL_MS = 15000;
const TIMEOUT_MS = 1500;
let cache = null;

async function getMlStatus({ force = false, now = Date.now() } = {}) {
  if (!force && cache && now - cache.at < TTL_MS) return cache.value;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const started = Date.now();
  let value;
  try {
    const res = await fetch(`${String(config.mlServiceUrl).replace(/\/+$/, '')}/health`, { signal: controller.signal });
    value = { status: res.ok ? 'ok' : 'down', latencyMs: Date.now() - started };
  } catch {
    value = { status: 'down', latencyMs: null };
  } finally {
    clearTimeout(timer);
  }
  value.checkedAt = new Date(now).toISOString();
  cache = { at: now, value };
  return value;
}

const _resetCacheForTests = () => { cache = null; };

module.exports = { getMlStatus, _resetCacheForTests };
