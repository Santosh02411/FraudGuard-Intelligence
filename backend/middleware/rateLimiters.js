/**
 * Rate limiting (express-rate-limit).
 * ======================================
 * A fraud-detection app that doesn't rate-limit its own auth and
 * transaction-scoring endpoints is asking to have its login form
 * brute-forced or its ML scoring pipeline hammered for free. Three tiers:
 *
 *   - authLimiter        — strict. Register/login are the highest-value
 *     target for credential stuffing/brute force.
 *   - transactionLimiter  — moderate. Protects the fraud-scoring pipeline
 *     (which calls out to the ML service) from being used as a cheap
 *     DoS vector, while staying generous enough for legitimate bursts.
 *     Keyed per-API-key when the caller authenticated with one (see
 *     middleware/apiKeyAuth.js), so one service integration's traffic
 *     never shares a bucket with unrelated callers on the same IP.
 *   - generalLimiter      — loose, applied to every route as defense in
 *     depth even where a specific limiter isn't warranted.
 *
 * Limits are configurable via env vars (config/env.js) so staging/
 * production can tune them without a code change.
 *
 * NOTE ON SCALING: the default in-memory store is fine for a single
 * process. Running multiple instances behind a load balancer needs a
 * shared store (e.g. `rate-limit-redis`) or each instance enforces its
 * own independent limit, effectively multiplying the real ceiling by
 * the instance count.
 */

const rateLimit = require('express-rate-limit');
const config = require('../config/env');
const { AppError } = require('./errorHandler');

function makeLimiter({ windowMs, max, message, keyGenerator }) {
  return rateLimit({
    windowMs,
    max,
    standardHeaders: true, // adds RateLimit-* response headers
    legacyHeaders: false,
    keyGenerator,
    handler: (req, res, next) => next(new AppError(message, 429)),
  });
}

const authLimiter = makeLimiter({
  windowMs: config.rateLimit.authWindowMin * 60 * 1000,
  max: config.rateLimit.authMax,
  message: 'Too many authentication attempts. Please try again later.',
});

// Keyed by API key when the request is authenticated with one (feature:
// per-API-key rate limiting) — otherwise every server calling through
// one merchant's API key would share a single IP-wide bucket with every
// *other* caller on that same IP, which is both too generous (one loud
// key can't be throttled independently) and too strict (unrelated
// traffic from the same IP eats into a key's allowance). Falls back to
// IP for ordinary browser-session traffic, which has no key to key by.
const transactionLimiter = makeLimiter({
  windowMs: config.rateLimit.transactionsWindowMin * 60 * 1000,
  max: config.rateLimit.transactionsMax,
  message: 'Too many transactions submitted. Please slow down.',
  keyGenerator: (req) => (req.apiKey ? `apikey:${req.apiKey.id}` : req.ip),
});

const generalLimiter = makeLimiter({
  windowMs: 60 * 1000,
  max: 300,
  message: 'Too many requests. Please try again later.',
});

// Cognee memory (admin-only). Sync and LLM-backed calls are costly, so they get their own, per-user buckets.
const cogneeSyncLimiter = makeLimiter({
  windowMs: 60 * 1000, max: config.rateLimit.cogneeSyncMax, message: 'Too many synchronisation requests. Please wait a minute.',
  keyGenerator: (req) => `cognee-sync:${req.user?.id ?? req.ip}`,
});
const cogneeQueryLimiter = makeLimiter({
  windowMs: 60 * 1000, max: config.rateLimit.cogneeQueryMax, message: 'Too many memory queries. Please slow down.',
  keyGenerator: (req) => `cognee-query:${req.user?.id ?? req.ip}`,
});

module.exports = { authLimiter, transactionLimiter, generalLimiter, cogneeSyncLimiter, cogneeQueryLimiter };
