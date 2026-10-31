const { z } = require('zod');

const num = z.number().finite();
const settingsBody = z.object({
  enabled: z.boolean().optional(),
  windows_hours: z.array(z.number().int()).optional(),
  psi_warn: num.optional(), psi_critical: num.optional(),
  score_psi_warn: num.optional(), score_psi_critical: num.optional(),
  missing_rate_warn: num.optional(), missing_rate_critical: num.optional(),
  min_samples_overall: num.optional(), min_samples_segment: num.optional(), min_reviewed_for_quality: num.optional(),
  quality_decline_confidence: z.boolean().optional(),
  max_segments_per_dimension: num.optional(),
  note: z.string().trim().min(10, 'Explain the change (at least 10 characters)').max(500),
}).strict();
const snapshotsQuery = z.object({
  window: z.string().regex(/^\d+[hd]$/).optional(),
  dim: z.enum(['all', 'category', 'amount_band', 'card_type', 'device', 'quality']).default('all'),
  value: z.string().min(1).max(100).default('all'),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});
const segmentsQuery = z.object({ window: z.string().regex(/^\d+[hd]$/) });
const alertsQuery = z.object({ state: z.enum(['open', 'all']).default('open'), limit: z.coerce.number().int().min(1).max(200).default(50) });
const idParams = z.object({ id: z.coerce.number().int().positive() });
const ackBody = z.object({ note: z.string().trim().min(5, 'Add a short note (at least 5 characters)').max(500) });
const opsQuery = z.object({ hours: z.coerce.number().int().min(1).max(720).default(24) });

module.exports = { settingsBody, snapshotsQuery, segmentsQuery, alertsQuery, idParams, ackBody, opsQuery };
