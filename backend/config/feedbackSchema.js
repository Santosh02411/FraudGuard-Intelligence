/** Feedback labels (second-person verified), immutable training-dataset snapshots, and gated retraining runs. */
const db = require('./database');

const SQLITE_DDL = `
  CREATE TABLE IF NOT EXISTS label_feedback (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    transaction_id INTEGER NOT NULL REFERENCES transactions(id),
    label TEXT NOT NULL,
    source TEXT NOT NULL,
    source_ref INTEGER,
    evidence_note TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'proposed',
    proposed_by INTEGER,
    proposed_at TEXT NOT NULL,
    reviewed_by INTEGER,
    reviewed_at TEXT,
    review_note TEXT,
    version INTEGER NOT NULL DEFAULT 1
  );
  CREATE TABLE IF NOT EXISTS label_feedback_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    label_id INTEGER NOT NULL REFERENCES label_feedback(id),
    kind TEXT NOT NULL,
    actor_id INTEGER,
    actor_username TEXT,
    summary TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS retraining_datasets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_by INTEGER,
    created_at TEXT NOT NULL,
    note TEXT NOT NULL,
    params TEXT NOT NULL,
    composition TEXT NOT NULL,
    content_sha256 TEXT NOT NULL,
    n_rows INTEGER NOT NULL,
    csv TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS retraining_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    dataset_id INTEGER NOT NULL REFERENCES retraining_datasets(id),
    status TEXT NOT NULL DEFAULT 'pending_approval',
    requested_by INTEGER,
    requested_at TEXT NOT NULL,
    request_note TEXT NOT NULL,
    decided_by INTEGER,
    decided_at TEXT,
    decision_note TEXT,
    started_at TEXT,
    finished_at TEXT,
    candidate_version TEXT,
    ml_result TEXT,
    error TEXT,
    version INTEGER NOT NULL DEFAULT 1
  );
`;
const PG_DDL = SQLITE_DDL.replace(/INTEGER PRIMARY KEY AUTOINCREMENT/g, 'SERIAL PRIMARY KEY');

async function initFeedbackSchema() {
  await db.exec(db.dialect === 'postgres' ? PG_DDL : SQLITE_DDL);
  // One live label per transaction; withdrawing/rejecting frees the slot. One open retraining run at a time.
  await db.exec("CREATE UNIQUE INDEX IF NOT EXISTS ux_label_feedback_active ON label_feedback(transaction_id) WHERE status IN ('proposed','verified')");
  await db.exec("CREATE UNIQUE INDEX IF NOT EXISTS ux_retraining_open ON retraining_runs((1)) WHERE status IN ('pending_approval','approved','running')");
  await db.exec('CREATE INDEX IF NOT EXISTS idx_label_feedback_status ON label_feedback(status, id)');
  await db.exec('CREATE INDEX IF NOT EXISTS idx_label_feedback_events ON label_feedback_events(label_id, id)');
}

module.exports = { initFeedbackSchema };
