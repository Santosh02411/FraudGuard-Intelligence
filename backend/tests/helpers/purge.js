/** Tests that wipe transactions must also clear the append-only decision history, via the retention gate. */
const db = require('../../config/database');
const { withRetentionGate } = require('../../models/decisionRepository');

async function deleteTransactions(where = '1=1', params = []) {
  await withRetentionGate(async () => {
    await db.run(`DELETE FROM decision_records WHERE transaction_id IN (SELECT id FROM transactions WHERE ${where})`, params);
    await db.run(`DELETE FROM transactions WHERE ${where}`, params);
  });
}
module.exports = { deleteTransactions };
