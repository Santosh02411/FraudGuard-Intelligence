const { z } = require('zod');
const idParams = z.object({ id: z.coerce.number().int().positive() });
const listQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  min_band: z.enum(['medium', 'high']).optional(),
});
module.exports = { idParams, listQuery };
