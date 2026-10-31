/**
 * Self-service API key management (feature: service-to-service auth).
 * Any logged-in user can create keys for their own account — the same
 * ownership model as webhooks (routes/webhooks.js): a "merchant" in
 * this app is a user account, and a key acts on that account's behalf
 * without requiring the account's password. Admins can see (but not
 * create on behalf of) every user's keys, for support/audit purposes.
 */

const express = require('express');
const router = express.Router();
const apiKeyRepository = require('../models/apiKeyRepository');
const apiKeyService = require('../services/apiKeyService');
const { authMiddleware } = require('../middleware/auth');
const { AppError, asyncHandler } = require('../middleware/errorHandler');
const { validate } = require('../middleware/validate');
const apiKeySchemas = require('../schemas/apiKeySchemas');
const { audit } = require('../middleware/auditLog');
const config = require('../config/env');

function sanitize(key) {
  // Never echo key_hash back, even to the owner — the whole point of
  // hashing at rest is that a read (including a legitimate one over
  // this endpoint) can't reconstruct the usable credential.
  const { key_hash: _hash, ...rest } = key;
  return rest;
}

// POST /api/api-keys - create a new API key for the caller's own account
router.post('/', authMiddleware, validate({ body: apiKeySchemas.create }), asyncHandler(async (req, res) => {
  const { name, scopes, expiresInDays } = req.body;
  const rawKey = apiKeyService.generateApiKey();
  const keyHash = apiKeyService.hashApiKey(rawKey);
  const keyPrefix = apiKeyService.displayPrefix(rawKey);

  // expiresInDays: 0 means "no default configured" (see config/env.js),
  // not "no expiration" — the request body value always wins when given.
  const effectiveDays = expiresInDays ?? (config.apiKeyDefaultExpiresDays || undefined);
  const expiresAt = effectiveDays ? new Date(Date.now() + effectiveDays * 24 * 60 * 60 * 1000).toISOString() : null;

  const { lastInsertRowid: id } = await apiKeyRepository.create({
    userId: req.user.id, name, keyHash, keyPrefix, scopes, createdBy: req.user.id, expiresAt,
  });

  audit({ req, userId: req.user.id, username: req.user.username, action: 'api_key.created', targetType: 'api_key', targetId: id, outcome: 'success', details: { name, scopes, expiresAt } });

  res.status(201).json({
    id,
    name,
    key: rawKey, // shown exactly once — never retrievable again
    prefix: keyPrefix,
    scopes,
    expires_at: expiresAt,
    created_at: new Date().toISOString(),
    warning: 'This is the only time the full API key will be shown. Store it securely — it cannot be retrieved again, only revoked and replaced.',
  });
}));

// GET /api/api-keys - list the caller's own keys, or (admin, without
// ?mine=true) everyone's. `mine=true` lets an admin explicitly ask for
// just their own — used by the self-service Settings page so an admin's
// personal settings view never mixes in other users' keys; the admin-only
// "Integrations" panel is what calls this without the param.
router.get('/', authMiddleware, asyncHandler(async (req, res) => {
  const onlyMine = req.user.role !== 'admin' || req.query.mine === 'true';
  const keys = onlyMine ? await apiKeyRepository.forUser(req.user.id) : await apiKeyRepository.allWithUsername();
  res.json({ apiKeys: keys.map(sanitize) });
}));

// DELETE /api/api-keys/:id - revoke a key (owner or admin)
router.delete('/:id', authMiddleware, validate({ params: apiKeySchemas.idParam }), asyncHandler(async (req, res) => {
  const key = await apiKeyRepository.findById(req.params.id);
  if (!key) throw AppError.notFound('API key not found');
  if (req.user.role !== 'admin' && key.user_id !== req.user.id) throw AppError.forbidden('Not authorized');
  if (key.revoked_at) return res.json({ message: 'API key already revoked' });

  await apiKeyRepository.revoke(req.params.id);
  audit({ req, userId: req.user.id, username: req.user.username, action: 'api_key.revoked', targetType: 'api_key', targetId: key.id, outcome: 'success', details: { name: key.name } });

  res.json({ message: 'API key revoked' });
}));

module.exports = router;
