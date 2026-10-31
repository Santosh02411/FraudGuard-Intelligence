const jwt = require('jsonwebtoken');
const userRepository = require('../models/userRepository');
const config = require('../config/env');
const { AppError, asyncHandler } = require('./errorHandler');
const { audit } = require('./auditLog');

const authMiddleware = asyncHandler(async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    throw AppError.unauthorized('No token provided');
  }

  const token = authHeader.split(' ')[1];
  let decoded;
  try {
    decoded = jwt.verify(token, config.jwtSecret);
  } catch (err) {
    throw AppError.unauthorized('Invalid or expired token');
  }

  // Defense in depth: this app only ever issues one kind of JWT (the
  // short-lived access token — see routes/auth.js's signAccessToken).
  // Refresh tokens are deliberately NOT JWTs (opaque random values,
  // looked up by hash — see models/refreshTokenRepository.js), so this
  // can never fire today, but it means a future JWT-based token type
  // can't accidentally be accepted here just because it's signed with
  // the same secret.
  if (decoded.type !== 'access') {
    throw AppError.unauthorized('Invalid or expired token');
  }

  const user = await userRepository.findById(decoded.id);
  if (!user) throw AppError.unauthorized('User not found');

  req.user = user;
  next();
});

/**
 * Role-gate a route. `req.user` must already be set (i.e. this runs
 * after authMiddleware). Every denial is audit-logged (feature: RBAC
 * done properly, audit-logged) — not every grant, since logging every
 * successful request a role already permits would just duplicate
 * middleware/requestLogger.js's access log at higher volume for no
 * extra signal; a denial is the security-relevant event.
 */
function requireRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) {
      audit({
        req,
        userId: req.user.id,
        username: req.user.username,
        action: 'rbac.access_denied',
        targetType: 'route',
        outcome: 'denied',
        details: { path: req.originalUrl, method: req.method, requiredRoles: roles, actualRole: req.user.role },
      }); // fire-and-forget — audit() never throws, and a 403 shouldn't wait on it
      throw AppError.forbidden('Forbidden');
    }
    next();
  };
}

// Kept as a named export for the existing `adminMiddleware` call sites —
// just requireRole('admin') under the hood.
const adminMiddleware = requireRole('admin');

module.exports = { authMiddleware, adminMiddleware, requireRole };
