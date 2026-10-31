/**
 * Centralized error handling.
 * ==============================
 * Replaces scattered try/catch + manual res.status().json() calls
 * throughout routes with three pieces:
 *
 *   1. AppError — a typed "operational" error (bad input, not found,
 *      unauthorized, etc). Routes/repositories throw these instead of
 *      constructing a response directly.
 *   2. asyncHandler — wraps an async route handler so a thrown/rejected
 *      error is forwarded to Express's error pipeline via next(err)
 *      instead of becoming an unhandled rejection. Express 4 doesn't do
 *      this automatically for async handlers.
 *   3. errorHandler — the single Express error-handling middleware
 *      (registered last in server.js) that turns any error — AppError,
 *      a Zod validation error, or an unexpected bug — into one
 *      consistent JSON shape, logs it appropriately, and never leaks a
 *      stack trace to the client outside development.
 */

const config = require('../config/env');
const logger = require('../config/logger');

class AppError extends Error {
  constructor(message, statusCode = 500, details = undefined) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.isOperational = true; // expected/handled, vs. a genuine bug
    if (details) this.details = details;
    Error.captureStackTrace(this, AppError);
  }
}

// Convenience constructors for the errors routes raise most often.
AppError.badRequest = (message, details) => new AppError(message, 400, details);
AppError.unauthorized = (message = 'Unauthorized') => new AppError(message, 401);
AppError.forbidden = (message = 'Forbidden') => new AppError(message, 403);
AppError.notFound = (message = 'Not found') => new AppError(message, 404);
AppError.conflict = (message) => new AppError(message, 409);
// 423 Locked — account lockout (see routes/auth.js). Distinct from 401
// (bad credentials) and 429 (rate limited): this specifically means "the
// credentials might even be correct, but this account is temporarily
// locked out," which the frontend should render differently than either.
AppError.locked = (message) => new AppError(message, 423);
// 503 — a downstream dependency (e.g. the ML service) is unreachable.
// Distinct from a 500: this isn't a bug in this service, it's the other
// one being down, which the frontend/caller should be able to tell apart.
AppError.serviceUnavailable = (message = 'Service unavailable') => new AppError(message, 503);

/** Wraps an async Express handler so rejected promises reach the error middleware. */
function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

/** Final error-handling middleware — registered last, after all routes. */
function errorHandler(err, req, res, next) { // eslint-disable-line no-unused-vars
  const isDev = config.isDev;

  // Zod validation errors (thrown by middleware/validate.js) — shape them
  // into a helpful, field-level response rather than a generic 500.
  if (err.name === 'ZodError') {
    return res.status(400).json({
      error: 'Validation failed',
      details: err.issues.map((i) => ({ field: i.path.join('.'), message: i.message })),
    });
  }

  if (err instanceof AppError) {
    if (!err.isOperational || err.statusCode >= 500) {
      logger.error(err.message, { statusCode: err.statusCode, requestId: req.requestId, stack: isDev ? err.stack : undefined });
    }
    return res.status(err.statusCode).json({
      error: err.message,
      ...(err.details ? { details: err.details } : {}),
      ...(req.requestId ? { requestId: req.requestId } : {}),
    });
  }

  // Errors from Express-ecosystem middleware (body-parser, multer, etc.)
  // set err.status/err.statusCode by convention — e.g. malformed JSON in
  // a request body is a 400, not a server-side failure. Honor that
  // convention for anything in the 4xx range; treat anything else as
  // unexpected and fall through to the 500 branch below.
  const conventionalStatus = err.status || err.statusCode;
  if (conventionalStatus && conventionalStatus >= 400 && conventionalStatus < 500) {
    return res.status(conventionalStatus).json({ error: err.message || 'Bad request', requestId: req.requestId });
  }

  // Unexpected/unhandled error — log full detail server-side, never leak
  // internals (stack trace, driver error text) to the client.
  logger.error('Unhandled error', { message: err.message, stack: err.stack, requestId: req.requestId });
  res.status(500).json({
    error: 'Internal server error',
    requestId: req.requestId,
    ...(isDev ? { message: err.message, stack: err.stack } : {}),
  });
}

module.exports = { AppError, asyncHandler, errorHandler };
