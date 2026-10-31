/**
 * API key authentication (feature: service-to-service auth). See
 * services/apiKeyService.js for key generation/hashing and
 * routes/apiKeys.js for the self-service management endpoints.
 */

const apiKeyRepository = require('../models/apiKeyRepository');
const userRepository = require('../models/userRepository');
const apiKeyService = require('../services/apiKeyService');
const { authMiddleware } = require('./auth');
const { AppError, asyncHandler } = require('./errorHandler');

const apiKeyMiddleware = asyncHandler(async (req, res, next) => {
  const key = req.headers['x-api-key'];
  if (!key || typeof key !== 'string') throw AppError.unauthorized('No API key provided');

  const record = await apiKeyRepository.findByHash(apiKeyService.hashApiKey(key));
  if (!record || record.revoked_at) throw AppError.unauthorized('Invalid or revoked API key');
  if (record.expires_at && new Date(record.expires_at).getTime() < Date.now()) {
    throw AppError.unauthorized('This API key has expired');
  }

  const user = await userRepository.findById(record.user_id);
  if (!user) throw AppError.unauthorized('Invalid API key');

  req.user = user;
  req.apiKey = { id: record.id, name: record.name, scopes: record.scopes };
  req.authMethod = 'api_key';
  // Fire-and-forget — a slow write here must never add latency to the
  // actual request, and losing an occasional last_used_at update isn't
  // worth blocking on.
  apiKeyRepository.touchLastUsed(record.id).catch(() => {});

  next();
});

/**
 * Role-gate by API key scope, the same shape as middleware/auth.js's
 * requireRole. Only applies to API-key-authenticated requests — a
 * normal logged-in user's JWT session isn't scope-limited, since scopes
 * exist specifically to let an API key holder be handed less access
 * than the full account it belongs to.
 */
function requireScope(scope) {
  return (req, res, next) => {
    if (req.authMethod === 'api_key' && !req.apiKey.scopes.includes(scope)) {
      throw AppError.forbidden(`This API key does not have the '${scope}' scope`);
    }
    next();
  };
}

/**
 * Accepts EITHER a JWT bearer token (a logged-in human's session) OR an
 * API key (X-API-Key header, a service integration's own credential) —
 * whichever the caller presents. Used on the routes a merchant's
 * backend actually needs to call (submitting/reading transactions),
 * not blanket-applied everywhere: the dashboard-style endpoints (alerts
 * case management, admin) stay JWT-only, since those are human
 * workflows an API key has no business driving.
 */
function flexibleAuth(req, res, next) {
  if (req.headers['x-api-key']) return apiKeyMiddleware(req, res, next);
  return authMiddleware(req, res, next);
}

module.exports = { apiKeyMiddleware, requireScope, flexibleAuth };
