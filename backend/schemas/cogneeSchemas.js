const { z } = require('zod');

const ENTITY_TYPES = ['Transaction', 'Investigation', 'Customer', 'Merchant', 'Device', 'FraudPattern'];

const syncBody = z.object({
  mode: z.enum(['incremental', 'full']).default('incremental'),
  force: z.boolean().default(false),               // re-send even when the content hash is unchanged
  maxRecords: z.coerce.number().int().min(1).max(5000).optional(),
}).strict();

const searchBody = z.object({
  query: z.string().trim().min(2).max(1000),
  topK: z.coerce.number().int().min(1).max(25).default(8),
  sourceTypes: z.array(z.enum(['transaction', 'investigation'])).max(2).default([]),
  includeAnswer: z.boolean().default(false),
}).strict();

const assistantBody = z.object({
  kind: z.enum(['transaction', 'investigation']),
  id: z.coerce.number().int().positive(),
  question: z.string().trim().min(2).max(1000).optional(),
  topK: z.coerce.number().int().min(1).max(15).default(8),
}).strict();

const entitiesQuery = z.object({
  type: z.enum(ENTITY_TYPES).optional(),
  q: z.string().trim().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).default(0),
  suspiciousOnly: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
});

const relatedParams = z.object({ id: z.string().trim().min(8).max(64).regex(/^[A-Za-z0-9-]+$/) });
const relatedQuery = z.object({ depth: z.coerce.number().int().min(1).max(2).default(1) });
const runsQuery = z.object({ limit: z.coerce.number().int().min(1).max(50).default(10) });

module.exports = { syncBody, searchBody, assistantBody, entitiesQuery, relatedParams, relatedQuery, runsQuery, ENTITY_TYPES };
