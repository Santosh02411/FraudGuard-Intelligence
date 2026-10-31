/**
 * Challenger ("shadow") scores per real transaction.
 * =====================================================
 * Agreement between a shadow model and the incumbent says nothing about
 * which one is RIGHT. Recording the challenger's probability next to each
 * transaction lets it later be scored against analyst verdicts
 * (services/modelEvaluationService.js). Only real, non-synthetic traffic is
 * recorded.
 */
const db = require('../config/database');

async function record(transactionId, analysis) {
  const shadow = analysis?.shadow;
  if (!shadow || typeof shadow.fraud_probability !== 'number') return null;
  const { changes } = await db.run(
    `INSERT INTO shadow_scores (transaction_id, shadow_version, shadow_probability, incumbent_version, incumbent_probability)
     VALUES (?, ?, ?, ?, ?) ON CONFLICT (transaction_id, shadow_version) DO NOTHING`,
    [transactionId, String(shadow.version), shadow.fraud_probability, analysis.model_version ?? null, analysis.model_probability ?? null]
  );
  return changes === 1;
}

/** Shadow scores joined to analyst verdicts, for outcome evaluation. */
async function labelledFor(shadowVersion, { days = 30 } = {}) {
  const cutoff = new Date(Date.now() - days * 86400000).toISOString();
  return db.all(
    `SELECT s.transaction_id, s.shadow_probability, s.incumbent_probability, s.incumbent_version,
            t.risk_level, t.fraud_score, a.verdict
       FROM shadow_scores s
       JOIN transactions t ON t.id = s.transaction_id
       LEFT JOIN alerts a ON a.transaction_id = t.id
      WHERE s.shadow_version = ? AND t.is_synthetic = 0 AND ${db.dialect === 'postgres' ? 's.created_at >= ?::timestamptz' : 'datetime(s.created_at) >= datetime(?)'}`,
    [String(shadowVersion), cutoff]
  );
}

async function countFor(shadowVersion) {
  const row = await db.get('SELECT COUNT(*) AS n FROM shadow_scores WHERE shadow_version = ?', [String(shadowVersion)]);
  return Number(row.n);
}

module.exports = { record, labelledFor, countFor };
