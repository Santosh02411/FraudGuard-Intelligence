const { z } = require('zod');

// '*' is a wildcard subscribing to every event this app fires — kept
// as an explicit option rather than "omit events to mean all," since
// an implicit "everything" is easy to get by accident and hard to
// notice later.
const EVENTS = [
  'transaction.flagged',
  // Step-up auth hook (feature: step-up authentication) — see
  // routes/transactions.js. A merchant only needs to subscribe to
  // step_up_required to opt IN to the hold-for-verification flow at
  // all; the other two are optional but let an integration react to the
  // outcome without polling GET .../step-up.
  'transaction.step_up_required',
  'transaction.step_up_verified',
  'transaction.step_up_failed',
  'transaction.step_up_abandoned',
  'transaction.step_up_expired',
  // risk-based verification policy (enforce mode) refused the transaction outright
  'transaction.declined',
  '*',
];

const urlSchema = z.string().trim().url('url must be a valid URL').refine(
  (url) => url.startsWith('https://') || url.startsWith('http://'),
  'url must use http:// or https://'
);

const create = z.object({
  url: urlSchema,
  events: z.array(z.enum(EVENTS)).min(1, 'at least one event is required').default(['transaction.flagged']),
});

const update = z.object({
  url: urlSchema.optional(),
  events: z.array(z.enum(EVENTS)).min(1).optional(),
  active: z.boolean().optional(),
});

const idParam = z.object({
  id: z.coerce.number().int().positive(),
});

module.exports = { create, update, idParam, EVENTS };
