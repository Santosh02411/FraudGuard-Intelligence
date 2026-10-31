/**
 * HTTP client for the Cognee memory service (cognee_service/).
 *
 * - Authenticates every call with the server-side service key (X-Cognee-Service-Key).
 * - Per-request timeout; transient failures (network error, timeout, HTTP 429/5xx) are retried with
 *   exponential backoff + jitter. 4xx responses are never retried - they will not succeed on a retry.
 *   Every call this module makes is idempotent (ingest upserts deterministic ids), so retrying is safe.
 * - Errors are normalised to CogneeError{code,status} so callers/routes can map them to HTTP responses
 *   without leaking the upstream body.
 */
const config = require('../../config/env');
const logger = require('../../config/logger');

class CogneeError extends Error {
  constructor(code, message, status) { super(message); this.name = 'CogneeError'; this.code = code; this.status = status; }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isConfigured = () => Boolean(config.cognee.serviceUrl);

async function request(method, path, body, { timeoutMs = config.cognee.requestTimeoutMs, retries = config.cognee.maxRetries } = {}) {
  if (!isConfigured()) throw new CogneeError('not_configured', 'Cognee is not configured. Set COGNEE_SERVICE_URL and COGNEE_SERVICE_API_KEY on the backend.', 503);
  if (!config.cognee.serviceApiKey && !config.isDev && !config.isTest) {
    throw new CogneeError('not_configured', 'COGNEE_SERVICE_API_KEY is not set.', 503);
  }
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${config.cognee.serviceUrl}${path}`, {
        method,
        headers: { 'Content-Type': 'application/json', ...(config.cognee.serviceApiKey ? { 'X-Cognee-Service-Key': config.cognee.serviceApiKey } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await response.text();
      let parsed = {};
      try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = {}; }
      if (response.ok) return parsed;
      const detail = typeof parsed.detail === 'string' ? parsed.detail : 'Cognee service returned an error';
      if (response.status === 401 || response.status === 403) throw Object.assign(new CogneeError('auth_failed', 'The backend is not authorised to use the Cognee service (check COGNEE_SERVICE_API_KEY).', 502), { retryable: false });
      if (response.status === 503 && /not ready/i.test(detail)) {
        // The service is up but still loading its embedding model (first start / slow machine). Retried below; if it is
        // still loading after the retries, the next scheduled sync simply tries again.
        lastError = new CogneeError('warming_up', 'Cognee is still starting (its embedding model is not ready yet). Try again in a minute.', 503);
        lastError.retryable = true;
      } else if (response.status === 429 || response.status >= 500) {
        lastError = new CogneeError('upstream', `Cognee service error (HTTP ${response.status})`, 502);
        lastError.retryable = true;
      } else {
        throw Object.assign(new CogneeError(response.status === 404 ? 'not_found' : 'rejected', detail, [404, 413].includes(response.status) ? response.status : 422), { retryable: false });
      }
    } catch (err) {
      if (err instanceof CogneeError && err.retryable === false) throw err;
      if (!(err instanceof CogneeError)) {
        lastError = err.name === 'AbortError'
          ? new CogneeError('timeout', `Cognee service did not respond within ${timeoutMs} ms`, 504)
          : new CogneeError('unreachable', 'Cognee service is unreachable', 503);
        lastError.retryable = true;
      }
    } finally {
      clearTimeout(timer);
    }
    if (attempt < retries) {
      const delay = Math.round(config.cognee.retryBaseMs * (2 ** attempt) * (0.75 + Math.random() * 0.5));
      logger.warn('Cognee request failed, retrying', { path, attempt: attempt + 1, code: lastError.code, delayMs: delay });
      await sleep(delay);
    }
  }
  throw lastError;
}

const get = (path, opts) => request('GET', path, undefined, opts);
const post = (path, body, opts) => request('POST', path, body, opts);

module.exports = { CogneeError, isConfigured, request, get, post };
