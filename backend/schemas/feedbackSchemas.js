const { z } = require('zod');
const id = z.coerce.number().int().positive();
const note = (min = 10) => z.string().trim().min(min, `Add a note (at least ${min} characters)`).max(1000);
module.exports = {
  idParams: z.object({ id }),
  listQuery: z.object({ status: z.enum(['proposed', 'verified', 'rejected', 'withdrawn']).optional(), limit: z.coerce.number().int().min(1).max(200).default(50), offset: z.coerce.number().int().min(0).default(0) }),
  proposeBody: z.object({ transaction_id: id, label: z.enum(['fraud', 'legitimate']), evidence_note: note(10) }).strict(),
  decisionBody: z.object({ note: note(5) }).strict(),
  datasetBody: z.object({ note: note(10), presumed_negatives_per_label: z.number().int().min(0).max(10).default(3), maturity_days: z.number().int().min(7).max(365).default(30) }).strict(),
  runBody: z.object({ dataset_id: id, note: note(10) }).strict(),
};
