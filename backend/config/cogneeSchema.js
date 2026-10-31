/**
 * Cognee integration bookkeeping (migration). Additive only - no existing table or column is touched.
 *
 *   cognee_sync_records  one row per FraudGuard record that has been sent to Cognee. `content_hash`
 *                        is the SHA-256 of the exact minimised projection that was sent, so an
 *                        unchanged record is never re-ingested (duplicate prevention) and a changed
 *                        one is detected without comparing timestamps across formats.
 *   cognee_sync_runs     the ingestion activity log shown on the dashboard.
 *   cognee_sync_cursor   high-water mark of the highest transaction/investigation id already seen,
 *                        so a scheduled run does not re-scan the whole history.
 *
 * The earlier prototype's `cognee_sync_state` table (a single created_at cursor) is superseded and
 * left untouched; nothing reads it any more and it is safe to drop.
 */
const db = require('./database');

const SQLITE_DDL = `
  CREATE TABLE IF NOT EXISTS cognee_sync_records (
    source_type TEXT NOT NULL,
    source_id TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    status TEXT NOT NULL,
    narrative_status TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    first_synced_at TEXT,
    last_synced_at TEXT,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (source_type, source_id)
  );
  CREATE TABLE IF NOT EXISTS cognee_sync_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    trigger_kind TEXT NOT NULL,
    mode TEXT NOT NULL,
    actor TEXT,
    status TEXT NOT NULL,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    scanned INTEGER NOT NULL DEFAULT 0,
    ingested INTEGER NOT NULL DEFAULT 0,
    skipped_unchanged INTEGER NOT NULL DEFAULT 0,
    failed INTEGER NOT NULL DEFAULT 0,
    more_pending INTEGER NOT NULL DEFAULT 0,
    error TEXT
  );
  CREATE TABLE IF NOT EXISTS cognee_sync_cursor (
    source_type TEXT PRIMARY KEY,
    last_id INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL
  );
`;
const PG_DDL = SQLITE_DDL.replace(/INTEGER PRIMARY KEY AUTOINCREMENT/g, 'SERIAL PRIMARY KEY');

const INDEXES = [
  'CREATE INDEX IF NOT EXISTS idx_cognee_records_status ON cognee_sync_records(status)',
  'CREATE INDEX IF NOT EXISTS idx_cognee_runs_started ON cognee_sync_runs(started_at)',
];

async function initCogneeSchema() {
  await db.exec(db.dialect === 'postgres' ? PG_DDL : SQLITE_DDL);
  for (const ix of INDEXES) await db.exec(ix);
}

module.exports = { initCogneeSchema };
