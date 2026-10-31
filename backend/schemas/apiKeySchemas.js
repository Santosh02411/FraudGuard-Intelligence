const { z } = require('zod');

// Kept intentionally small — one scope per resource/action this app
// actually has an integration surface for. A merchant backend calling
// POST /transactions needs 'transactions:write'; a dashboard-style
// integration that only checks status needs 'transactions:read'.
const SCOPES = ['transactions:write', 'transactions:read'];

const create = z.object({
  name: z.string().trim().min(1, 'name is required').max(100),
  scopes: z.array(z.enum(SCOPES)).min(1, 'at least one scope is required').default(SCOPES),
  // Feature: API key expiration policy. Omit for no expiration (or the
  // server-configured default — see API_KEY_DEFAULT_EXPIRES_DAYS). 0
  // is rejected rather than silently meaning "never expires" — that
  // ambiguity is exactly the kind of thing an expiration feature
  // should never leave implicit.
  expiresInDays: z.number().int().positive().max(3650, 'expiresInDays must be 3650 (10 years) or fewer').optional(),
});

const idParam = z.object({
  id: z.coerce.number().int().positive(),
});

module.exports = { create, idParam, SCOPES };
