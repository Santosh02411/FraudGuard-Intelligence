const { z } = require('zod');
const { MODES, ACTIONS } = require('../models/verificationPolicy');

const actions = z.object({ low: z.enum(ACTIONS), medium: z.enum(ACTIONS), high: z.enum(ACTIONS) });
const policyFields = {
  mode: z.enum(MODES),
  actions,
  min_amount: z.number().min(0).nullable().optional(),
  ttl_seconds: z.number().int(),
};
const previewBody = z.object({ ...policyFields, days: z.number().int().min(1).max(180).optional() });
const policyBody = z.object({
  ...policyFields,
  note: z.string().trim().min(10, 'Explain the change (at least 10 characters)').max(500),
  // switching ON enforcement changes real outcomes for real accounts, so it must be said out loud
  confirm_enforce: z.boolean().optional(),
});
const windowQuery = z.object({ days: z.coerce.number().int().min(1).max(365).default(30) });
const challengesQuery = z.object({ status: z.enum(['pending', 'verified', 'failed', 'abandoned', 'expired']).optional(), limit: z.coerce.number().int().min(1).max(200).default(50) });

module.exports = { previewBody, policyBody, windowQuery, challengesQuery };
