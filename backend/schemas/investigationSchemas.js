const { z } = require('zod');
const { pagination } = require('./paginationSchema');
const repo = require('../models/investigationRepository');

const id = z.coerce.number().int().positive();
const ids = z.array(z.number().int().positive()).max(100);
const version = z.number().int().positive().optional(); // optimistic locking

const idParams = z.object({ id });
const itemParams = z.object({ id, type: z.enum(['alert', 'transaction']), itemId: id });

const createBody = z.object({
  title: z.string().trim().min(3).max(200),
  summary: z.string().trim().max(2000).optional(),
  priority: z.enum(repo.PRIORITIES).optional(),
  assignedTo: z.number().int().positive().optional(),
  alertIds: ids.default([]),
  transactionIds: ids.default([]),
}).refine((b) => b.alertIds.length + b.transactionIds.length > 0, { message: 'Provide at least one alert or transaction' });

const updateBody = z.object({
  title: z.string().trim().min(3).max(200).optional(),
  summary: z.string().trim().max(2000).nullable().optional(),
  priority: z.enum(repo.PRIORITIES).optional(),
  version,
});
const itemsBody = z.object({ alertIds: ids.default([]), transactionIds: ids.default([]), version })
  .refine((b) => b.alertIds.length + b.transactionIds.length > 0, { message: 'Provide at least one alert or transaction' });
const removeQuery = z.object({ version: z.coerce.number().int().positive().optional() });
const assignBody = z.object({ assigneeId: z.number().int().positive().nullable(), version });
const statusBody = z.object({ status: z.enum(['open', 'investigating', 'pending_info']), reason: z.string().trim().min(10).max(500).optional(), version });
const commentBody = z.object({ body: z.string().trim().min(1).max(2000) });
const closeBody = z.object({
  outcome: z.enum(repo.OUTCOMES),
  note: z.string().trim().min(10, 'Explain the outcome (at least 10 characters)').max(2000),
  resolve_alerts: z.boolean().default(false),
  version,
});
const listQuery = pagination.extend({
  status: z.enum(repo.STATUSES).optional(),
  priority: z.enum(repo.PRIORITIES).optional(),
  assignedTo: z.coerce.number().int().positive().optional(),
  unassigned: z.enum(['true', 'false']).optional(),
  q: z.string().trim().max(100).optional(),
});
const byItemQuery = z.object({ type: z.enum(['alert', 'transaction']), id });

module.exports = { idParams, itemParams, createBody, updateBody, itemsBody, removeQuery, assignBody, statusBody, commentBody, closeBody, listQuery, byItemQuery };
