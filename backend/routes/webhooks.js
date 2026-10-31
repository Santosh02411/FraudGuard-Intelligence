/**
 * Self-service outbound webhook management (feature: webhook
 * notifications). Same per-user ownership model as API keys
 * (routes/apiKeys.js): a user registers a URL to be notified at, and
 * services/webhookService.js fires it when their own transactions trip
 * the medium/high-risk threshold. Admins can see (but not create on
 * behalf of) every user's webhooks, for support/audit purposes.
 */

const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const webhookRepository = require('../models/webhookRepository');
const { authMiddleware } = require('../middleware/auth');
const { AppError, asyncHandler } = require('../middleware/errorHandler');
const { validate } = require('../middleware/validate');
const webhookSchemas = require('../schemas/webhookSchemas');
const { audit } = require('../middleware/auditLog');

function generateSecret() {
  return crypto.randomBytes(24).toString('hex');
}

// POST /api/webhooks - register a new webhook for the caller's own account
router.post('/', authMiddleware, validate({ body: webhookSchemas.create }), asyncHandler(async (req, res) => {
  const { url, events } = req.body;
  const secret = generateSecret();

  const { lastInsertRowid: id } = await webhookRepository.create({ userId: req.user.id, url, secret, events });

  audit({ req, userId: req.user.id, username: req.user.username, action: 'webhook.created', targetType: 'webhook', targetId: id, outcome: 'success', details: { url, events } });

  res.status(201).json({
    id,
    url,
    events,
    active: true,
    secret, // shown exactly once — needed to verify the X-FraudGuard-Signature header on every delivery, never retrievable again
    created_at: new Date().toISOString(),
    warning: 'This is the only time the signing secret will be shown. Store it securely — use it to verify the X-FraudGuard-Signature header on every delivery.',
  });
}));

// GET /api/webhooks - list the caller's own webhooks, or (admin, without
// ?mine=true) everyone's — same reasoning as GET /api/api-keys.
router.get('/', authMiddleware, asyncHandler(async (req, res) => {
  const onlyMine = req.user.role !== 'admin' || req.query.mine === 'true';
  const webhooks = onlyMine ? await webhookRepository.forUser(req.user.id) : await webhookRepository.allWithUsername();
  // secret is never re-exposed after creation, same reasoning as API keys.
  res.json({ webhooks: webhooks.map(({ secret: _secret, ...rest }) => rest) });
}));

// PATCH /api/webhooks/:id - update url/events/active (owner or admin)
router.patch('/:id', authMiddleware, validate({ params: webhookSchemas.idParam, body: webhookSchemas.update }), asyncHandler(async (req, res) => {
  const webhook = await webhookRepository.findById(req.params.id);
  if (!webhook) throw AppError.notFound('Webhook not found');
  if (req.user.role !== 'admin' && webhook.user_id !== req.user.id) throw AppError.forbidden('Not authorized');

  await webhookRepository.update(req.params.id, req.body);
  audit({ req, userId: req.user.id, username: req.user.username, action: 'webhook.updated', targetType: 'webhook', targetId: webhook.id, outcome: 'success', details: req.body });

  const updated = await webhookRepository.findById(req.params.id);
  const { secret: _secret, ...rest } = updated;
  res.json({ webhook: rest });
}));

// DELETE /api/webhooks/:id - remove a webhook (owner or admin)
router.delete('/:id', authMiddleware, validate({ params: webhookSchemas.idParam }), asyncHandler(async (req, res) => {
  const webhook = await webhookRepository.findById(req.params.id);
  if (!webhook) throw AppError.notFound('Webhook not found');
  if (req.user.role !== 'admin' && webhook.user_id !== req.user.id) throw AppError.forbidden('Not authorized');

  await webhookRepository.remove(req.params.id);
  audit({ req, userId: req.user.id, username: req.user.username, action: 'webhook.deleted', targetType: 'webhook', targetId: webhook.id, outcome: 'success', details: { url: webhook.url } });

  res.json({ message: 'Webhook deleted' });
}));

// GET /api/webhooks/:id/deliveries - recent delivery attempts (owner or admin) —
// lets an integrator see whether their endpoint is actually receiving events
// without needing server log access.
router.get('/:id/deliveries', authMiddleware, validate({ params: webhookSchemas.idParam }), asyncHandler(async (req, res) => {
  const webhook = await webhookRepository.findById(req.params.id);
  if (!webhook) throw AppError.notFound('Webhook not found');
  if (req.user.role !== 'admin' && webhook.user_id !== req.user.id) throw AppError.forbidden('Not authorized');

  const deliveries = await webhookRepository.deliveriesForWebhook(req.params.id);
  res.json({ deliveries });
}));

module.exports = router;
