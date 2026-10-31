/** Relationship & fraud-ring analysis (admin only). See services/relationshipService.js. */
const express = require('express');
const { z } = require('zod');
const router = express.Router();
const rel = require('../services/relationshipService');
const { authMiddleware, adminMiddleware } = require('../middleware/auth');
const { AppError, asyncHandler } = require('../middleware/errorHandler');
const { validate } = require('../middleware/validate');
const { audit } = require('../middleware/auditLog');

router.use(authMiddleware, adminMiddleware);

const days = z.coerce.number().int().min(1).max(365).optional();
const listQuery = z.object({ days, minScore: z.coerce.number().min(0).max(100).default(0), limit: z.coerce.number().int().min(1).max(100).default(25) });
const idParams = z.object({ id: z.string().regex(/^c\d+$/, 'invalid cluster id') });
const graphQuery = z.object({
  transactionId: z.coerce.number().int().positive().optional(),
  userId: z.coerce.number().int().positive().optional(),
  depth: z.coerce.number().int().min(1).max(2).default(1),
}).refine((q) => Boolean(q.transactionId) !== Boolean(q.userId), { message: 'Provide exactly one of transactionId or userId' });

router.get('/clusters', validate({ query: listQuery }), asyncHandler(async (req, res) => {
  res.json(await rel.clusters({ days: req.query.days, minScore: req.query.minScore, limit: req.query.limit }));
}));

router.get('/clusters/:id', validate({ params: idParams, query: z.object({ days }) }), asyncHandler(async (req, res) => {
  const c = await rel.clusterById(req.params.id, { days: req.query.days });
  if (!c) throw AppError.notFound('Cluster not found (clusters are recomputed from live data; ids can change when accounts merge or separate)');
  res.json(c);
}));

router.get('/signals', validate({ query: z.object({ days }) }), asyncHandler(async (req, res) => {
  res.json(await rel.accountSignals({ days: req.query.days }));
}));

router.get('/graph', validate({ query: graphQuery }), asyncHandler(async (req, res) => {
  const g = await rel.graph({ transactionId: req.query.transactionId, userId: req.query.userId, depth: req.query.depth });
  if (!g) throw AppError.notFound('Transaction or account not found');
  // looking up an account's network is itself sensitive: leave a trail
  audit({ req, userId: req.user.id, username: req.user.username, action: 'relationships.graph_view', targetType: req.query.transactionId ? 'transaction' : 'user', targetId: req.query.transactionId || req.query.userId, outcome: 'success', details: { depth: req.query.depth, nodes: g.nodes.length, truncated: g.truncated } });
  res.json(g);
}));

module.exports = router;
