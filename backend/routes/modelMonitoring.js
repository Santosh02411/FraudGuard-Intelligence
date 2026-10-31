/**
 * Persistent model monitoring (admin): overview, operational metrics, drift snapshots by window/segment,
 * alerts (open/acknowledge), thresholds, and an on-demand run. See services/driftMonitorService.js.
 */
const express = require('express');
const router = express.Router();
const service = require('../services/driftMonitorService');
const settingsService = require('../services/monitoringSettings');
const { authMiddleware, adminMiddleware } = require('../middleware/auth');
const { AppError, asyncHandler } = require('../middleware/errorHandler');
const { validate } = require('../middleware/validate');
const schemas = require('../schemas/monitoringSchemas');
const { audit } = require('../middleware/auditLog');

router.use(authMiddleware, adminMiddleware);

router.get('/overview', asyncHandler(async (req, res) => res.json(await service.overview())));

router.get('/operations', validate({ query: schemas.opsQuery }), asyncHandler(async (req, res) => res.json(await service.operations({ hours: req.query.hours }))));

router.get('/snapshots', validate({ query: schemas.snapshotsQuery }), asyncHandler(async (req, res) => res.json({ snapshots: await service.snapshots(req.query) })));

router.get('/segments', validate({ query: schemas.segmentsQuery }), asyncHandler(async (req, res) => res.json({ window: req.query.window, segments: await service.segments(req.query.window) })));

router.get('/alerts', validate({ query: schemas.alertsQuery }), asyncHandler(async (req, res) => {
  res.json({ alerts: await service.openAlerts({ includeResolved: req.query.state === 'all', limit: req.query.limit }), interpretation: service.INTERPRETATION });
}));

router.post('/alerts/:id/acknowledge', validate({ params: schemas.idParams, body: schemas.ackBody }), asyncHandler(async (req, res) => {
  const r = await service.acknowledge(req.params.id, { note: req.body.note, userId: req.user.id });
  if (r.error === 'NOT_FOUND') throw AppError.notFound('Alert not found');
  if (r.error) { const e = AppError.conflict(r.error === 'ALREADY_RESOLVED' ? 'This alert has already cleared' : 'This alert was already acknowledged'); e.details = { code: r.error }; throw e; }
  audit({ req, userId: req.user.id, username: req.user.username, action: 'model_monitoring.acknowledge', targetType: 'model_health_event', targetId: req.params.id, outcome: 'success', details: { note: req.body.note } });
  res.json({ acknowledged: true });
}));

router.get('/settings', asyncHandler(async (req, res) => {
  const s = await settingsService.get();
  res.json({ ...s, defaults: settingsService.defaults(), ranges: settingsService.RANGES });
}));

router.put('/settings', validate({ body: schemas.settingsBody }), asyncHandler(async (req, res) => {
  const { note, ...patch } = req.body;
  const current = await settingsService.get();
  const next = { ...current.settings, ...patch };
  const problems = settingsService.validate(next);
  if (problems.length) throw AppError.badRequest('Invalid monitoring settings', problems);
  await settingsService.save(next, req.user.id);
  audit({ req, userId: req.user.id, username: req.user.username, action: 'model_monitoring.settings', targetType: 'monitoring_settings', targetId: 0, outcome: 'success', details: { before: current.settings, after: next, note } });
  res.json({ ...(await settingsService.get()), defaults: settingsService.defaults() });
}));

// Evaluate now (the timer does this hourly by default). Calls the ML service for drift; fails soft per scope.
router.post('/run', asyncHandler(async (req, res) => {
  const summary = await service.runOnce();
  audit({ req, userId: req.user.id, username: req.user.username, action: 'model_monitoring.run', targetType: 'model_monitoring', targetId: 0, outcome: summary.errors.length ? 'failure' : 'success', details: { snapshots: summary.snapshots, alerts_opened: summary.alerts_opened, errors: summary.errors.slice(0, 5) } });
  res.json(summary);
}));

module.exports = router;
