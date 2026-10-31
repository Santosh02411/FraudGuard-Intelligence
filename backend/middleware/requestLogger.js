/**
 * Structured HTTP request logging — replaces morgan/console.log with
 * one structured log line per request (method, path, status, duration,
 * user id when authenticated, a correlation id). Assigns req.requestId
 * early so downstream error logs (middleware/errorHandler.js) can be
 * tied back to the exact request that caused them.
 */

const crypto = require('crypto');
const logger = require('../config/logger');

function requestLogger(req, res, next) {
  const start = process.hrtime.bigint();
  req.requestId = req.headers['x-request-id'] || crypto.randomUUID();
  res.setHeader('X-Request-Id', req.requestId);

  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
    const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'http';
    logger.log(level, 'request', {
      requestId: req.requestId,
      method: req.method,
      path: req.originalUrl,
      status: res.statusCode,
      durationMs: Math.round(durationMs * 100) / 100,
      userId: req.user?.id,
      ip: req.ip,
    });
  });

  next();
}

module.exports = requestLogger;
