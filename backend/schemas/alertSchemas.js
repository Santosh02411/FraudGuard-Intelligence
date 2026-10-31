const { z } = require('zod');

const resolveParams = z.object({
  id: z.coerce.number().int().positive(),
});

// PATCH /:id/resolve body — verdict is required, not optional: the whole
// point of this endpoint is to record an analyst's confirmed/false-positive
// call, not just flip a boolean. `confirmed_fraud` is what feeds the
// dynamic device/IP blacklist (see transactionRepository.fraudDeviceAndIpBlacklist)
// and would feed model retraining in a real system — `false_positive`
// explicitly removes that transaction from the blacklist signal even if
// the model originally scored it as fraud, closing the feedback loop the
// old resolve-as-boolean version couldn't.
const REASONS = ['customer_confirmed_legitimate', 'customer_confirmed_fraud', 'card_testing', 'account_takeover', 'stolen_card', 'merchant_error', 'duplicate_alert', 'rule_too_sensitive', 'insufficient_evidence', 'other'];
const amount = z.number().nonnegative().max(1e9);
const resolveBody = z.object({
  reason: z.enum(REASONS).optional(), // structured resolution reason (the UI requires it)
  prevented_amount: amount.optional(), recovered_amount: amount.optional(), loss_amount: amount.optional(), // admin only; see routes/alerts.js
  verdict: z.enum(['confirmed_fraud', 'false_positive'], {
    errorMap: () => ({ message: 'verdict must be "confirmed_fraud" or "false_positive"' }),
  }),
  note: z.string().trim().max(1000, 'Note must be 1000 characters or fewer').optional(),
  version: z.number().int().positive().optional(), // optimistic locking: the alert version the caller last saw
});

// PATCH /:id/assign body — assigneeId is nullable to support unassigning.
const assignBody = z.object({
  assigneeId: z.number().int().positive().nullable(),
  version: z.number().int().positive().optional(), // optimistic locking: the alert version the caller last saw
});

// PATCH /bulk-resolve body — same verdict/note shape as a single
// resolve, applied to a batch of alert ids in one request (feature:
// bulk actions). Capped at 100 per call: large enough for a real
// triage sweep, small enough that one request can't tie up the DB or
// blow past a reasonable request-body size.
const bulkResolveBody = z.object({
  alertIds: z.array(z.number().int().positive()).min(1, 'at least one alertId is required').max(100, 'at most 100 alertIds per request'),
  verdict: z.enum(['confirmed_fraud', 'false_positive'], {
    errorMap: () => ({ message: 'verdict must be "confirmed_fraud" or "false_positive"' }),
  }),
  note: z.string().trim().max(1000, 'Note must be 1000 characters or fewer').optional(),
  reason: z.enum(REASONS).optional(),
});

const ALERT_STATUSES = ['open', 'in_review', 'escalated', 'pending_info', 'resolved'];
const ALERT_RISK_LEVELS = ['medium', 'high'];

// GET / query filters, layered on top of the shared pagination schema
// (see routes/alerts.js) — every field optional, so existing callers that
// only send page/limit keep working unchanged.
const listQuery = z.object({
  status: z.enum(ALERT_STATUSES).optional(),
  riskLevel: z.enum(ALERT_RISK_LEVELS).optional(),
  merchant: z.string().trim().min(1).max(100).optional(),
  dateFrom: z.string().datetime({ offset: true }).or(z.string().date()).optional(),
  dateTo: z.string().datetime({ offset: true }).or(z.string().date()).optional(),
  amountMin: z.coerce.number().nonnegative().optional(),
  amountMax: z.coerce.number().nonnegative().optional(),
  assignedTo: z.coerce.number().int().positive().optional(),
  severity: z.enum(['critical', 'high', 'medium', 'low']).optional(),
  overdue: z.enum(['true', 'false']).optional(),
  unassigned: z.enum(['true', 'false']).optional(),
  sort: z.enum(['newest', 'priority']).optional(),
});

// ---- case management
const statusBody = z.object({
  status: z.enum(['open', 'in_review', 'escalated', 'pending_info']),
  version: z.number().int().positive().optional(),
});
const severityBody = z.object({ severity: z.enum(['critical', 'high', 'medium', 'low']), reason: z.string().trim().min(5).max(300), version: z.number().int().positive().optional() });
const claimBody = z.object({ force: z.boolean().optional(), reason: z.string().trim().min(5).max(300).optional() }).default({});
const releaseBody = claimBody;
const escalateBody = z.object({ reason: z.string().trim().min(5).max(300) });
const commentBody = z.object({ body: z.string().trim().min(1, 'Comment cannot be empty').max(2000) });
const outcomeBody = z.object({
  prevented_amount: amount.nullable().optional(), recovered_amount: amount.nullable().optional(), loss_amount: amount.nullable().optional(),
  version: z.number().int().positive().optional(),
});
const evidenceParams = z.object({ id: z.coerce.number().int().positive(), evidenceId: z.coerce.number().int().positive() });
const evidenceQuery = z.object({ filename: z.string().trim().min(1).max(200), description: z.string().trim().max(300).optional() });
const metricsQuery = z.object({ days: z.coerce.number().int().min(1).max(365).default(30) });

module.exports = { statusBody, severityBody, claimBody, releaseBody, escalateBody, commentBody, outcomeBody, evidenceParams, evidenceQuery, metricsQuery, RESOLUTION_REASONS: REASONS, resolveParams, resolveBody, assignBody, bulkResolveBody, listQuery, ALERT_STATUSES, ALERT_RISK_LEVELS };
