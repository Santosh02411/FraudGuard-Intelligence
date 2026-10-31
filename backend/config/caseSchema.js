/**
 * Alert case management schema: columns added to `alerts`, plus comments and evidence.
 * Idempotent on both dialects (fresh Postgres, and SQLite dev databases created earlier).
 */
const db = require('./database');

const ALERT_COLUMNS = [
  ['severity', 'severity TEXT'],
  ['due_at', 'due_at TEXT'],
  ['escalation_level', 'escalation_level INTEGER NOT NULL DEFAULT 0'],
  ['escalated_at', 'escalated_at TEXT'],
  ['claimed_by', 'claimed_by INTEGER'],
  ['claim_expires_at', 'claim_expires_at TEXT'],
  ['resolution_reason', 'resolution_reason TEXT'],
  ['prevented_amount', 'prevented_amount DOUBLE PRECISION'],
  ['recovered_amount', 'recovered_amount DOUBLE PRECISION'],
  ['loss_amount', 'loss_amount DOUBLE PRECISION'],
];

const SQLITE_DDL = `
  CREATE TABLE IF NOT EXISTS alert_comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    alert_id INTEGER NOT NULL REFERENCES alerts(id),
    author_id INTEGER,
    author_username TEXT,
    body TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS alert_evidence (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    alert_id INTEGER NOT NULL REFERENCES alerts(id),
    uploaded_by INTEGER,
    uploaded_by_username TEXT,
    filename TEXT NOT NULL,
    content_type TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    sha256 TEXT NOT NULL,
    description TEXT,
    content BLOB NOT NULL,
    created_at TEXT NOT NULL
  );
`;
const PG_DDL = SQLITE_DDL
  .replace(/INTEGER PRIMARY KEY AUTOINCREMENT/g, 'SERIAL PRIMARY KEY')
  .replace('content BLOB NOT NULL', 'content BYTEA NOT NULL');

const INDEXES = [
  'CREATE INDEX IF NOT EXISTS idx_alert_comments_alert ON alert_comments(alert_id, id)',
  'CREATE INDEX IF NOT EXISTS idx_alert_evidence_alert ON alert_evidence(alert_id, id)',
  'CREATE INDEX IF NOT EXISTS idx_alerts_due ON alerts(resolved, due_at)',
];

async function initCaseSchema() {
  for (const [name, ddl] of ALERT_COLUMNS) {
    if (db.dialect === 'postgres') {
      await db.exec(`ALTER TABLE alerts ADD COLUMN IF NOT EXISTS ${ddl}`);
    } else {
      const cols = (await db.all('PRAGMA table_info(alerts)')).map((c) => c.name);
      if (!cols.includes(name)) await db.exec(`ALTER TABLE alerts ADD COLUMN ${ddl}`);
    }
  }
  await db.exec(db.dialect === 'postgres' ? PG_DDL : SQLITE_DDL);
  for (const ix of INDEXES) await db.exec(ix);
  await require('../models/alertCaseRepository').backfillCaseFields();
}

module.exports = { initCaseSchema };
