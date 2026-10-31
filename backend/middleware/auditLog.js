/**
 * Thin wrapper around models/auditLogRepository.js: routes call this
 * instead of inserting directly, so a logging failure (DB hiccup, bad
 * JSON, whatever) can never take down the actual request it's
 * documenting — an audit trail that could crash the thing it's
 * auditing would be worse than no audit trail.
 */

const auditLogRepository = require('../models/auditLogRepository');
const logger = require('../config/logger');

/**
 * @param {object} opts
 * @param {import('express').Request} [opts.req] - used for ip_address; omit for
 *   contexts with no request (there are none yet, but keeps this reusable).
 * @param {number|null} [opts.userId]
 * @param {string|null} [opts.username]
 * @param {string} opts.action - dot-namespaced, e.g. 'auth.login', 'alerts.resolve'
 * @param {string} [opts.targetType] - e.g. 'alert', 'user'
 * @param {number} [opts.targetId]
 * @param {'success'|'failure'|'denied'} [opts.outcome]
 * @param {object} [opts.details] - JSON-serializable extra context
 */
async function audit({ req, userId = null, username = null, action, targetType, targetId, outcome = 'success', details }) {
  try {
    await auditLogRepository.insert({
      userId,
      username,
      action,
      targetType,
      targetId,
      outcome,
      ipAddress: req?.ip,
      details,
    });
  } catch (err) {
    // Never let an audit-log write failure break the request it's
    // documenting — but do surface it loudly, since a silently broken
    // audit trail is its own kind of incident.
    logger.error('Audit log write failed', { action, error: err.message });
  }
}

module.exports = { audit };
