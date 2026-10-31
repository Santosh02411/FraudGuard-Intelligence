/** Customer risk profiles (admin): an explainable analyst aid. See services/customerProfileService.js. */
const express = require('express');
const router = express.Router();
const service = require('../services/customerProfileService');
const { authMiddleware, adminMiddleware } = require('../middleware/auth');
const { AppError, asyncHandler } = require('../middleware/errorHandler');
const { validate } = require('../middleware/validate');
const schemas = require('../schemas/customerProfileSchemas');
const { audit } = require('../middleware/auditLog');

router.use(authMiddleware, adminMiddleware);

router.get('/', validate({ query: schemas.listQuery }), asyncHandler(async (req, res) => {
  res.json({ ...(await service.topRisk({ limit: req.query.limit, minBand: req.query.min_band || null })), weights: service.WEIGHTS, bands: service.BANDS });
}));

router.get('/:id', validate({ params: schemas.idParams }), asyncHandler(async (req, res) => {
  const profile = await service.getProfile(req.params.id);
  if (!profile) throw AppError.notFound('User not found');
  // Viewing a person's risk profile is itself a sensitive access, so it is audited.
  audit({ req, userId: req.user.id, username: req.user.username, action: 'customer_profile.view', targetType: 'user', targetId: req.params.id, outcome: 'success' });
  res.json({ profile, weights: service.WEIGHTS, bands: service.BANDS });
}));

module.exports = router;
