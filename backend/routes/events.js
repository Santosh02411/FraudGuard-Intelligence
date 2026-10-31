/**
 * Event replay (see realtime/socketServer.js for the design).
 *
 *   GET /api/events?after=<cursor>&limit=&types=&min_risk=
 *        Real events strictly after `cursor`, oldest first, paginated. Use
 *        `next_cursor` for the following page while `has_more` is true.
 *        Visibility is decided in the query: a user sees only their own
 *        events, an admin sees all real events. Synthetic simulation events
 *        are never returned here — they are not stored.
 *        `gap: true` means events older than `oldest_available` were pruned
 *        since the caller's cursor: reload state instead of trusting replay.
 *   GET /api/events/head
 *        Latest event id (the cursor a freshly-loaded client should start from).
 */
const express = require('express');
const { z } = require('zod');
const router = express.Router();
const { authMiddleware } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/errorHandler');
const { validate } = require('../middleware/validate');
const realtimeEvents = require('../models/realtimeEventRepository');
const { getStatus } = require('../realtime/socketServer');

const listQuery = z.object({
  after: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(realtimeEvents.MAX_PAGE).default(realtimeEvents.DEFAULT_PAGE),
  types: z.string().optional().transform((v) => (v ? v.split(',').map((t) => t.trim()).filter(Boolean) : undefined))
    .refine((v) => !v || v.every((t) => ['transaction:new', 'alert:new'].includes(t)), { message: 'types must be transaction:new and/or alert:new' }),
  min_risk: z.enum(['all', 'medium', 'high']).optional(),
});

router.get('/', authMiddleware, validate({ query: listQuery }), asyncHandler(async (req, res) => {
  const { after, limit, types, min_risk: minRisk } = req.query;
  const page = await realtimeEvents.listFor(req.user, { afterId: after, limit, types, minRisk: minRisk === 'all' ? undefined : minRisk });
  res.json(page);
}));

router.get('/head', authMiddleware, asyncHandler(async (req, res) => {
  const { head, oldest } = await realtimeEvents.bounds();
  res.json({ head, oldest_available: oldest, transport: getStatus() });
}));

module.exports = router;
