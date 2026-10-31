/**
 * Risk-based verification administration: the policy (which risk bands get which action), a read-only preview of
 * a candidate policy on recent history, the effectiveness report, and the recent challenge log. Admin-only.
 */
const express = require('express');
const router = express.Router();
const repo = require('../models/verificationPolicyRepository');
const vp = require('../models/verificationPolicy');
const service = require('../services/verificationService');
const { authMiddleware, adminMiddleware } = require('../middleware/auth');
const { AppError, asyncHandler } = require('../middleware/errorHandler');
const { validate } = require('../middleware/validate');
const schemas = require('../schemas/verificationSchemas');
const { audit } = require('../middleware/auditLog');

router.use(authMiddleware, adminMiddleware);

function assertValid(body) {
  const problems = vp.validate(body);
  if (problems.length) throw AppError.badRequest('Invalid verification policy', problems);
}

router.get('/policy', asyncHandler(async (req, res) => {
  const [active, history] = await Promise.all([repo.getActive(), repo.history(20)]);
  res.json({
    active, history, defaults: vp.DEFAULT_POLICY, limits: vp.LIMITS, allowed_actions: vp.ALLOWED, modes: vp.MODES,
    separation: 'FraudGuard records and recommends an action and holds/blocks the transaction in its own records. It never authorizes or moves a payment — your payment system does that. The live-feed demo simulator never creates challenges.',
  });
}));

router.put('/policy', validate({ body: schemas.policyBody }), asyncHandler(async (req, res) => {
  assertValid(req.body);
  if (req.body.mode === 'enforce' && req.body.confirm_enforce !== true) {
    const e = AppError.badRequest('Enforce mode changes real outcomes (transactions are held or blocked). Resend with confirm_enforce: true.');
    e.details = { code: 'CONFIRM_ENFORCE_REQUIRED' };
    throw e;
  }
  const previous = await repo.getActive();
  const same = previous.mode === req.body.mode && JSON.stringify(previous.actions) === JSON.stringify(req.body.actions)
    && (previous.min_amount ?? null) === (req.body.min_amount ?? null) && previous.ttl_seconds === req.body.ttl_seconds;
  if (same) throw AppError.badRequest('These settings are identical to the policy already in force');
  const policy = await repo.create({ ...req.body, min_amount: req.body.min_amount ?? null, createdBy: req.user.id });
  audit({ req, userId: req.user.id, username: req.user.username, action: 'verification_policy.update', targetType: 'verification_policy', targetId: policy.version, outcome: 'success',
    details: { previous: { version: previous.version, mode: previous.mode, actions: previous.actions, min_amount: previous.min_amount, ttl_seconds: previous.ttl_seconds }, new: { version: policy.version, mode: policy.mode, actions: policy.actions, min_amount: policy.min_amount, ttl_seconds: policy.ttl_seconds }, note: req.body.note } });
  res.json({ message: 'Verification policy updated', policy, previous });
}));

router.post('/policy/preview', validate({ body: schemas.previewBody }), asyncHandler(async (req, res) => {
  assertValid(req.body);
  const { days, ...policy } = req.body;
  res.json(await service.previewPolicy({ ...policy, min_amount: policy.min_amount ?? null }, { days }));
}));

router.get('/effectiveness', validate({ query: schemas.windowQuery }), asyncHandler(async (req, res) => {
  res.json(await service.effectiveness({ days: req.query.days }));
}));

router.get('/challenges', validate({ query: schemas.challengesQuery }), asyncHandler(async (req, res) => {
  res.json({ challenges: await service.recentChallenges(req.query) });
}));

// Run the expiry sweep on demand (the timer does this anyway; useful after an outage or from a cron).
router.post('/sweep', asyncHandler(async (req, res) => {
  const result = await service.sweepExpired();
  audit({ req, userId: req.user.id, username: req.user.username, action: 'verification.sweep', targetType: 'verification', targetId: 0, outcome: 'success', details: result });
  res.json(result);
}));

module.exports = router;
