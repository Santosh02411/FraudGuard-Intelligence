const { z } = require('zod');

// Kept in sync with frontend/src/pages/NewTransactionPage.js and the ML
// model's training vocabulary (ml_service/generate_dataset.py) — see
// backend/models/fraudEngine.js's HIGH_RISK_LOCATIONS comment for why
// this needs to match exactly.
const CATEGORIES = ['grocery', 'food', 'electronics', 'travel', 'entertainment', 'utilities', 'clothing', 'health', 'crypto', 'gambling', 'wire_transfer'];
const LOCATIONS = ['New York, US', 'London, UK', 'Toronto, CA', 'Bengaluru, IN', 'Sydney, AU', 'Berlin, DE', 'Singapore, SG', 'Lagos, NG', 'Unknown', 'Anonymous Proxy'];
const CARD_TYPES = ['credit', 'debit', 'prepaid'];

const create = z.object({
  amount: z.coerce.number({ invalid_type_error: 'Amount must be a number' })
    .positive('Amount must be greater than 0')
    .max(1_000_000, 'Amount is unreasonably large'),
  merchant: z.string().trim().min(1, 'Merchant is required').max(100),
  category: z.enum(CATEGORIES, { errorMap: () => ({ message: `Category must be one of: ${CATEGORIES.join(', ')}` }) }),
  location: z.enum(LOCATIONS, { errorMap: () => ({ message: `Location must be one of: ${LOCATIONS.join(', ')}` }) }),
  card_type: z.enum(CARD_TYPES, { errorMap: () => ({ message: `Card type must be one of: ${CARD_TYPES.join(', ')}` }) }),
});

const idParam = z.object({
  id: z.coerce.number().int().positive(),
});

// POST /api/transactions/bulk body (feature: bulk transaction
// import/batch scoring). Each row is the exact same shape as a single
// POST /api/transactions — capped at 50 rows per request so one call
// can't be used to hammer the fraud-scoring pipeline (each row still
// costs a real ML/rule-engine call; see routes/transactions.js's
// scoreAndCreateTransaction).
const bulkCreate = z.object({
  transactions: z.array(create).min(1, 'At least one transaction is required').max(50, 'A single bulk request is capped at 50 transactions'),
});

// POST /api/transactions/:id/step-up/verify body (feature: step-up
// auth hook). The calling merchant's own OTP/3DS provider decided
// success/failure out-of-band; this call reports that outcome back.
const stepUpVerifyBody = z.object({
  challenge_token: z.string().trim().min(1),
  outcome: z.enum(['success', 'failure', 'abandoned'], { errorMap: () => ({ message: 'outcome must be "success", "failure" or "abandoned"' }) }),
});

const RISK_LEVELS = ['low', 'medium', 'high'];

// GET / query filters, layered on top of the shared pagination schema
// (see routes/transactions.js) — every field optional, so existing
// callers that only send page/limit keep working unchanged. This is the
// "ops tool" filter bar: narrow a transaction list by merchant, category,
// risk level, amount range, or date range instead of only paging through
// everything in reverse-chronological order.
const listQuery = z.object({
  merchant: z.string().trim().min(1).max(100).optional(),
  category: z.enum(CATEGORIES).optional(),
  riskLevel: z.enum(RISK_LEVELS).optional(),
  dateFrom: z.string().datetime({ offset: true }).or(z.string().date()).optional(),
  dateTo: z.string().datetime({ offset: true }).or(z.string().date()).optional(),
  amountMin: z.coerce.number().nonnegative().optional(),
  amountMax: z.coerce.number().nonnegative().optional(),
});

module.exports = { create, bulkCreate, idParam, listQuery, stepUpVerifyBody, CATEGORIES, LOCATIONS, CARD_TYPES, RISK_LEVELS };
