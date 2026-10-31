/**
 * HTTPS enforcement (feature: HTTPS enforcement). Only active in
 * staging/production — local dev has no TLS terminator in front of it,
 * and enforcing here too would just break `npm run dev`.
 *
 * Relies on `app.set('trust proxy', ...)` (see server.js) being
 * configured correctly for the deployment, since the app itself almost
 * never terminates TLS directly — a reverse proxy/load balancer does,
 * and forwards `X-Forwarded-Proto: https` for the original request.
 * `req.secure` already accounts for that once trust proxy is set.
 */

const config = require('../config/env');

function httpsEnforce(req, res, next) {
  if (!(config.isStaging || config.isProd)) return next();
  if (req.secure) return next();

  // Browsers can safely be redirected for GET/HEAD; for anything with a
  // body (POST/PATCH/etc.) a redirect would silently drop or mangle it
  // in some clients, so reject outright and tell the caller to fix its
  // scheme instead.
  if (req.method === 'GET' || req.method === 'HEAD') {
    return res.redirect(301, `https://${req.headers.host}${req.originalUrl}`);
  }
  return res.status(400).json({ error: 'HTTPS is required' });
}

module.exports = httpsEnforce;
