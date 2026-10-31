/**
 * Investigations ("cases"): a unit of work that groups related alerts/transactions.
 * Named `investigations` in code to avoid colliding with the per-alert workflow
 * (alertCaseRepository / caseSchema.js); the UI calls them Cases.
 */
const db = require('./database');

const SQLITE_DDL = `
  CREATE TABLE IF NOT EXISTS investigations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    summary TEXT,
    status TEXT NOT NULL DEFAULT 'open',
    priority TEXT NOT NULL DEFAULT 'medium',
    outcome TEXT,
    outcome_note TEXT,
    assigned_to INTEGER REFERENCES users(id),
    created_by INTEGER REFERENCES users(id),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    closed_at TEXT,
    closed_by INTEGER,
    version INTEGER NOT NULL DEFAULT 1
  );
  CREATE TABLE IF NOT EXISTS investigation_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    investigation_id INTEGER NOT NULL REFERENCES investigations(id),
    item_type TEXT NOT NULL,
    item_id INTEGER NOT NULL,
    added_by INTEGER,
    added_at TEXT NOT NULL,
    UNIQUE (investigation_id, item_type, item_id)
  );
  CREATE TABLE IF NOT EXISTS investigation_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    investigation_id INTEGER NOT NULL REFERENCES investigations(id),
    kind TEXT NOT NULL,
    actor_id INTEGER,
    actor_username TEXT,
    summary TEXT NOT NULL,
    details TEXT,
    created_at TEXT NOT NULL
  );
`;
const PG_DDL = SQLITE_DDL.replace(/INTEGER PRIMARY KEY AUTOINCREMENT/g, 'SERIAL PRIMARY KEY');

const INDEXES = [
  'CREATE INDEX IF NOT EXISTS idx_inv_status ON investigations(status, priority)',
  'CREATE INDEX IF NOT EXISTS idx_inv_assignee ON investigations(assigned_to, status)',
  'CREATE INDEX IF NOT EXISTS idx_inv_items_ref ON investigation_items(item_type, item_id)',
  'CREATE INDEX IF NOT EXISTS idx_inv_events ON investigation_events(investigation_id, id)',
  // An alert or transaction belongs to at most ONE investigation, so two investigators
  // can't build competing cases around the same evidence without noticing.
  'CREATE UNIQUE INDEX IF NOT EXISTS uq_inv_item_once ON investigation_items(item_type, item_id)',
];

async function initInvestigationSchema() {
  await db.exec(db.dialect === 'postgres' ? PG_DDL : SQLITE_DDL);
  for (const ix of INDEXES) await db.exec(ix);
}

module.exports = { initInvestigationSchema };
