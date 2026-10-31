const { z } = require('zod');

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

/**
 * Shared `?page=&limit=` query schema for list endpoints. Coerces the
 * (string) query params to integers, applies sane defaults, and caps
 * `limit` so a caller can't force an unbounded table scan.
 */
const pagination = z.object({
  page: z.coerce.number().int('page must be an integer').positive('page must be >= 1').default(1),
  limit: z.coerce.number().int('limit must be an integer').positive('limit must be >= 1')
    .max(MAX_LIMIT, `limit must be <= ${MAX_LIMIT}`).default(DEFAULT_LIMIT),
});

/** Builds the `pagination` block returned alongside a page of results. */
function paginationMeta({ page, limit, total }) {
  const totalPages = total === 0 ? 0 : Math.ceil(total / limit);
  return {
    page,
    limit,
    total,
    total_pages: totalPages,
    has_next: page < totalPages,
    has_prev: page > 1,
  };
}

module.exports = { pagination, paginationMeta, DEFAULT_LIMIT, MAX_LIMIT };
