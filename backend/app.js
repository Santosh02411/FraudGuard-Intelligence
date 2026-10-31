/**
 * The Express app itself — middleware + routes, nothing else. Split out
 * from server.js so tests (see tests/integration/*.test.js) can
 * `require('../../app')` and drive it with Supertest directly, without
 * a real listening socket, Socket.io, or the initSchema/listen
 * bootstrapping sequence. server.js is the thin runtime wrapper around
 * this: it adds the http.Server, Socket.io, schema init, and
 * process-level error handlers.
 */

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const config = require('./config/env');
const requestLogger = require('./middleware/requestLogger');
const httpsEnforce = require('./middleware/httpsEnforce');
const metrics = require('./middleware/metrics');
const { generalLimiter } = require('./middleware/rateLimiters');
const { AppError, errorHandler } = require('./middleware/errorHandler');

const app = express();

// This app almost never terminates TLS itself — a reverse proxy/load
// balancer in front of it does, and forwards `X-Forwarded-*` headers for
// the original request. Trusting the first proxy hop makes req.ip,
// req.secure, and the rate limiters (keyed by IP) reflect the real
// client instead of the proxy, and is what httpsEnforce.js relies on.
app.set('trust proxy', 1);

app.use(httpsEnforce); // no-op outside staging/production — see the file
app.use(helmet({
  // Helmet's default CSP is designed for HTML pages (script-src,
  // style-src, etc.) — this is a JSON API with no HTML to protect, so
  // the default policy just adds noise/false confidence. Every other
  // helmet default (HSTS, X-Content-Type-Options, X-Frame-Options,
  // Referrer-Policy, etc.) still applies.
  contentSecurityPolicy: false,
}));
app.use(cors({
  // No wildcard — only these exact origins (config/env.js's
  // CORS_ALLOWED_ORIGINS) get CORS headers; anything else's browser
  // fetch is blocked client-side. `credentials: true` since the
  // frontend sends the JWT via Authorization header (not cookies), but
  // some browsers still gate custom headers on this being set correctly
  // alongside a non-wildcard origin.
  origin(origin, callback) {
    // No Origin header at all (curl, server-to-server, mobile apps) —
    // there's nothing to check against, so let it through; CORS is a
    // browser-enforced concept and doesn't apply to that traffic anyway.
    if (!origin || config.corsAllowedOrigins.includes(origin)) return callback(null, true);
    callback(AppError.forbidden('Not allowed by CORS'));
  },
  credentials: true,
}));
app.use(express.json());
app.use(requestLogger);
app.use(metrics.httpMetricsMiddleware);
app.use(generalLimiter); // per-route limiters (auth, transactions) layer on top of this

// GET /metrics — Prometheus scrape endpoint (feature: observability).
// Deliberately unauthenticated (standard Prometheus convention — the
// scraper is usually an internal service, not a browser) and outside
// /api entirely, so it's never mistaken for part of the versioned API
// surface. See middleware/metrics.js and the README's Observability
// section for what's exposed and the network-exposure caveat.
app.get('/metrics', async (req, res) => {
  res.set('Content-Type', metrics.register.contentType);
  res.send(await metrics.register.metrics());
});

// Routes
// ----------------------------------------------------------------------
// API versioning: every route lives under /api/v1/*. `/api/v1` is the
// one true mount — see routes/v1/index.js, which wires up auth/
// transactions/alerts/admin and its own /health. `/api/*` (unversioned)
// is kept mounted to the exact same v1 router as a backward-compatible
// alias, so existing clients built against the pre-versioning paths
// don't break; new clients should target /api/v1 explicitly. When a v2
// introduces breaking changes, add routes/v2/ and repoint the /api
// alias deliberately instead of leaving it silently pinned to v1.
const v1Router = require('./routes/v1');
app.use('/api/v1', v1Router);
app.use('/api', v1Router);

// 404 handler
app.use((req, res, next) => next(AppError.notFound('Route not found')));

// Centralized error handler — must be registered last
app.use(errorHandler);

module.exports = app;
