const express = require('express');
const config = require('../../config/env');

const router = express.Router();

router.use('/auth', require('../auth'));
router.use('/transactions', require('../transactions'));
router.use('/alerts', require('../alerts'));
router.use('/admin', require('../admin'));
router.use('/investigations', require('../investigations'));
router.use('/model-monitoring', require('../modelMonitoring'));
router.use('/verification', require('../verification'));
router.use('/rule-proposals', require('../ruleProposals'));
router.use('/customer-profiles', require('../customerProfiles'));
router.use('/feedback', require('../feedback'));
router.use('/relationships', require('../relationships'));
router.use('/api-keys', require('../apiKeys'));
router.use('/webhooks', require('../webhooks'));
router.use('/disputes', require('../disputes'));
router.use('/events', require('../events'));
router.use('/cognee-memory', require('../cogneeMemory'));

// GET /api/v1/system/status — any signed-in user. Drives the top-bar "ML service ok/down" pill.
const { authMiddleware } = require('../../middleware/auth');
const { asyncHandler } = require('../../middleware/errorHandler');
router.get('/system/status', authMiddleware, asyncHandler(async (req, res) => {
  res.json({ api_version: 'v1', ml: await require('../../services/mlStatus').getMlStatus() });
}));

// GET /api/v1/health (also reachable, unversioned, at /api/health — see server.js)
router.get('/health', (req, res) => res.json({
  status: 'ok',
  env: config.env,
  api_version: 'v1',
  time: new Date().toISOString(),
}));

// GET /api/v1/health/ready — READINESS: can this instance do its job? Needs the database; the ML service being
// down is reported but does not fail readiness, because scoring degrades to the rule engine instead of stopping.
router.get('/health/ready', async (req, res) => {
  const checks = { database: 'ok', ml_service: 'unknown' };
  let ready = true;
  try {
    await require('../../config/database').get('SELECT 1 AS ok');
  } catch (err) {
    checks.database = 'unavailable';
    ready = false;
    require('../../config/logger').error('Readiness check: database unavailable', { error: err.message });
  }
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 1000);
    const r = await fetch(`${config.mlServiceUrl}/health`, { signal: ctrl.signal });
    clearTimeout(t);
    checks.ml_service = r.ok ? 'ok' : 'degraded';
  } catch {
    checks.ml_service = 'unavailable (rule-engine fallback active)';
  }
  res.status(ready ? 200 : 503).json({ status: ready ? 'ready' : 'not_ready', checks, time: new Date().toISOString() });
});

module.exports = router;
