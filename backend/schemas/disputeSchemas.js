const { z } = require('zod');

// POST /api/disputes body
const openBody = z.object({
  transaction_id: z.coerce.number().int().positive(),
  // Optional override for a PARTIAL dispute (e.g. only part of a
  // multi-item order was disputed) — defaults to the transaction's full
  // amount if omitted (see routes/disputes.js).
  amount_disputed: z.coerce.number().positive().optional(),
  reason: z.string().trim().min(1).max(500).optional(),
});

// PATCH /api/disputes/:id body — advances the lifecycle by one step.
const transitionBody = z.object({
  status: z.enum(['evidence_submitted', 'won', 'lost'], {
    errorMap: () => ({ message: 'status must be one of: evidence_submitted, won, lost' }),
  }),
  note: z.string().trim().max(2000).optional(),
  version: z.number().int().positive().optional(), // optimistic locking: the dispute version the caller last saw
});

const idParam = z.object({ id: z.coerce.number().int().positive() });

const listQuery = z.object({
  status: z.enum(['opened', 'evidence_submitted', 'won', 'lost']).optional(),
});

module.exports = { openBody, transitionBody, idParam, listQuery };
