const { z } = require('zod');
const { pagination } = require('./paginationSchema');
const { RULE_TYPES } = require('../models/fraudRuleRepository');

const id = z.coerce.number().int().positive();
const idParams = z.object({ id });
const version = z.number().int().positive().optional();

const ruleChange = z.union([
  z.object({
    op: z.literal('add'), rule_type: z.enum(RULE_TYPES), value: z.string().trim().min(1).max(255).optional(),
    threshold: z.coerce.number().positive().optional(), reason: z.string().trim().max(500).optional(),
  }).refine((c) => (c.rule_type === 'amount_cap' ? c.threshold !== undefined && c.value === undefined : c.value !== undefined && c.threshold === undefined),
    { message: 'amount_cap needs "threshold" only; blacklist_* needs "value" only' }),
  z.object({ op: z.literal('update'), rule_id: id, value: z.string().trim().min(1).max(255).optional(), threshold: z.coerce.number().positive().optional() })
    .refine((c) => c.value !== undefined || c.threshold !== undefined, { message: 'update needs value or threshold' }),
  z.object({ op: z.literal('enable'), rule_id: id }),
  z.object({ op: z.literal('disable'), rule_id: id }),
  z.object({ op: z.literal('delete'), rule_id: id }),
]);

const policyChange = z.object({
  medium_threshold: z.number().min(0).max(100),
  high_threshold: z.number().min(0).max(100),
  review_capacity_per_day: z.number().int().positive().nullable().optional(),
});

const sim = { days: z.coerce.number().int().min(1).max(365).optional(), maturity_days: z.coerce.number().int().min(1).max(180).optional() };

const createBody = z.object({
  title: z.string().trim().min(3).max(200),
  description: z.string().trim().max(2000).optional(),
  rule_changes: z.array(ruleChange).max(50).default([]),
  policy_change: policyChange.nullable().optional(),
});
const updateBody = z.object({
  title: z.string().trim().min(3).max(200).optional(),
  description: z.string().trim().max(2000).nullable().optional(),
  rule_changes: z.array(ruleChange).max(50).optional(),
  policy_change: policyChange.nullable().optional(),
  version,
});
const adhocBody = z.object({ rule_changes: z.array(ruleChange).max(50).default([]), policy_change: policyChange.nullable().optional(), ...sim });
const simulateBody = z.object({ ...sim });
const approveBody = z.object({ note: z.string().trim().max(500).optional(), version });
const reasonBody = z.object({ reason: z.string().trim().min(10, 'Explain why (at least 10 characters)').max(500) });
const listQuery = pagination.extend({ status: z.enum(['draft', 'approved', 'active', 'rolled_back', 'rejected']).optional() });

module.exports = { idParams, createBody, updateBody, adhocBody, simulateBody, approveBody, reasonBody, listQuery };
