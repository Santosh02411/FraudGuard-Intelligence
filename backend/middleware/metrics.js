/**
 * Prometheus-style metrics (feature: observability). A dedicated
 * registry (not the global default) so requiring this module twice in
 * tests doesn't throw on duplicate metric registration — each test
 * file's module registry gets its own Registry instance, same reasoning
 * as everything else in this app being per-file-isolated in tests.
 *
 * Mounted unauthenticated at GET /metrics (see app.js), outside /api —
 * this matches standard Prometheus scrape-endpoint convention (an
 * internal scraper, not a browser client, hits this) and keeps it out
 * of the versioned API surface entirely. In a real deployment this
 * endpoint would typically be reachable only from an internal network,
 * not the public internet — see the README's Observability section.
 */

const client = require('prom-client');

const register = new client.Registry();
client.collectDefaultMetrics({ register }); // process CPU, memory, event loop lag, GC, etc.

const httpRequestsTotal = new client.Counter({
  name: 'fraudguard_http_requests_total',
  help: 'Total HTTP requests, labeled by method, route, and status code.',
  labelNames: ['method', 'route', 'status'],
  registers: [register],
});

const httpRequestDurationSeconds = new client.Histogram({
  name: 'fraudguard_http_request_duration_seconds',
  help: 'HTTP request duration in seconds, labeled by method, route, and status code.',
  labelNames: ['method', 'route', 'status'],
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [register],
});

const transactionsScoredTotal = new client.Counter({
  name: 'fraudguard_transactions_scored_total',
  help: 'Total transactions scored by the fraud engine, labeled by risk level and scoring method.',
  labelNames: ['risk_level', 'scoring_method'],
  registers: [register],
});

const alertsCreatedTotal = new client.Counter({
  name: 'fraudguard_alerts_created_total',
  help: 'Total fraud alerts created, labeled by risk level.',
  labelNames: ['risk_level'],
  registers: [register],
});

const webhookDeliveriesTotal = new client.Counter({
  name: 'fraudguard_webhook_deliveries_total',
  help: 'Total outbound webhook delivery attempts, labeled by success.',
  labelNames: ['success'],
  registers: [register],
});

/**
 * Express middleware — records every request's method/route/status and
 * duration. Uses req.route?.path (the matched route pattern, e.g.
 * "/:id/resolve") rather than req.originalUrl, so a transaction id or
 * alert id in the URL doesn't explode this into one label series per
 * unique id ever requested — that's the standard reason to avoid raw
 * paths in Prometheus labels.
 */
function httpMetricsMiddleware(req, res, next) {
  const start = process.hrtime.bigint();
  res.on('finish', () => {
    const durationSeconds = Number(process.hrtime.bigint() - start) / 1e9;
    // req.baseUrl + req.route.path reconstructs the mount-aware pattern
    // (e.g. "/api/v1/alerts" + "/:id/resolve"); falls back to a fixed
    // label for anything that never matched a route (404s), so those
    // don't fragment into one series per bogus path either.
    const route = req.route ? `${req.baseUrl}${req.route.path}` : 'unmatched';
    const labels = { method: req.method, route, status: res.statusCode };
    httpRequestsTotal.inc(labels);
    httpRequestDurationSeconds.observe(labels, durationSeconds);
  });
  next();
}

module.exports = {
  register,
  httpMetricsMiddleware,
  transactionsScoredTotal,
  alertsCreatedTotal,
  webhookDeliveriesTotal,
};
