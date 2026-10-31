/**
 * Schema for the fraud-decision audit trail.
 *
 *  rule_set_versions  every distinct configuration of the hard rules, so a decision can say
 *                     "decided under rule-set 7" and an investigator can see what 7 contained.
 *  decision_records   APPEND-ONLY history of fraud decisions per transaction (original + rescores).
 *  legal_holds        stops retention from deleting a transaction's decision history.
 *  retention_runs     proof of every retention run (dry or real).
 *  retention_gate     a one-row switch that the retention job (and only it) flips, inside its own
 *                     database transaction, to let the append-only triggers permit DELETE and the
 *                     redaction of snapshot columns.
 *
 * Append-only is enforced by DATABASE TRIGGERS, not by application convention: an UPDATE or DELETE
 * on decision_records / audit_logs fails even from a buggy route or a stray script. (A database
 * superuser can still drop the triggers — see docs/DECISION_AUDIT.md for what this does and does
 * not protect against.) `created_at` columns are TEXT holding an ISO timestamp so the exact value
 * is part of each record's hash.
 */
const db = require('./database');

const SQLITE_DDL = `
  CREATE TABLE IF NOT EXISTS rule_set_versions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    parent_id INTEGER NOT NULL DEFAULT 0,
    hash TEXT NOT NULL,
    config TEXT NOT NULL,
    note TEXT,
    created_by INTEGER,
    created_at TEXT NOT NULL,
    UNIQUE (parent_id, hash)
  );
  CREATE TABLE IF NOT EXISTS decision_records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    transaction_id INTEGER NOT NULL,
    seq INTEGER NOT NULL,
    decision_type TEXT NOT NULL,
    applied INTEGER NOT NULL DEFAULT 1,
    origin TEXT NOT NULL DEFAULT 'live',
    decision_source TEXT NOT NULL,
    scoring_method TEXT NOT NULL,
    model_version TEXT,
    model_name TEXT,
    model_probability REAL,
    raw_probability REAL,
    calibrated INTEGER,
    ruleset_version INTEGER,
    ruleset_hash TEXT,
    policy_version INTEGER,
    thresholds TEXT NOT NULL,
    fraud_score REAL NOT NULL,
    risk_level TEXT NOT NULL,
    is_fraud INTEGER NOT NULL,
    reasons TEXT NOT NULL,
    hard_flags TEXT,
    shap TEXT,
    feature_snapshot TEXT,
    features_sha256 TEXT,
    shap_sha256 TEXT,
    context TEXT NOT NULL,
    engine_version TEXT NOT NULL,
    actor_user_id INTEGER,
    actor_username TEXT,
    reason TEXT,
    prev_hash TEXT,
    record_hash TEXT NOT NULL,
    redacted_at TEXT,
    created_at TEXT NOT NULL,
    UNIQUE (transaction_id, seq),
    FOREIGN KEY (transaction_id) REFERENCES transactions(id)
  );
  CREATE TABLE IF NOT EXISTS legal_holds (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    transaction_id INTEGER NOT NULL,
    reason TEXT NOT NULL,
    placed_by INTEGER,
    placed_at TEXT NOT NULL,
    released_by INTEGER,
    released_at TEXT
  );
  CREATE TABLE IF NOT EXISTS retention_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ran_at TEXT NOT NULL,
    actor TEXT NOT NULL,
    dry_run INTEGER NOT NULL,
    policy TEXT NOT NULL,
    results TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS retention_gate (id INTEGER PRIMARY KEY CHECK (id = 1), unlocked INTEGER NOT NULL DEFAULT 0);
  INSERT OR IGNORE INTO retention_gate (id, unlocked) VALUES (1, 0);
`;

const SQLITE_TRIGGERS = [
  `CREATE TRIGGER IF NOT EXISTS trg_decision_no_delete BEFORE DELETE ON decision_records
     WHEN (SELECT unlocked FROM retention_gate WHERE id = 1) = 0
     BEGIN SELECT RAISE(ABORT, 'decision_records is append-only'); END`,
  // Updates are only ever allowed while the gate is open AND only to the redactable columns.
  `CREATE TRIGGER IF NOT EXISTS trg_decision_no_update BEFORE UPDATE ON decision_records
     WHEN (SELECT unlocked FROM retention_gate WHERE id = 1) = 0
       OR NEW.id IS NOT OLD.id OR NEW.transaction_id IS NOT OLD.transaction_id OR NEW.seq IS NOT OLD.seq
       OR NEW.decision_type IS NOT OLD.decision_type OR NEW.applied IS NOT OLD.applied OR NEW.origin IS NOT OLD.origin
       OR NEW.decision_source IS NOT OLD.decision_source OR NEW.scoring_method IS NOT OLD.scoring_method
       OR NEW.model_version IS NOT OLD.model_version OR NEW.model_probability IS NOT OLD.model_probability
       OR NEW.ruleset_version IS NOT OLD.ruleset_version OR NEW.policy_version IS NOT OLD.policy_version
       OR NEW.thresholds IS NOT OLD.thresholds OR NEW.fraud_score IS NOT OLD.fraud_score
       OR NEW.risk_level IS NOT OLD.risk_level OR NEW.is_fraud IS NOT OLD.is_fraud OR NEW.reasons IS NOT OLD.reasons
       OR NEW.hard_flags IS NOT OLD.hard_flags OR NEW.features_sha256 IS NOT OLD.features_sha256
       OR NEW.shap_sha256 IS NOT OLD.shap_sha256 OR NEW.context IS NOT OLD.context
       OR NEW.actor_user_id IS NOT OLD.actor_user_id OR NEW.reason IS NOT OLD.reason
       OR NEW.prev_hash IS NOT OLD.prev_hash OR NEW.record_hash IS NOT OLD.record_hash OR NEW.created_at IS NOT OLD.created_at
     BEGIN SELECT RAISE(ABORT, 'decision_records is append-only'); END`,
  `CREATE TRIGGER IF NOT EXISTS trg_audit_no_update BEFORE UPDATE ON audit_logs
     BEGIN SELECT RAISE(ABORT, 'audit_logs is append-only'); END`,
  `CREATE TRIGGER IF NOT EXISTS trg_audit_no_delete BEFORE DELETE ON audit_logs
     WHEN (SELECT unlocked FROM retention_gate WHERE id = 1) = 0
     BEGIN SELECT RAISE(ABORT, 'audit_logs is append-only; only the retention job may delete'); END`,
];

const PG_DDL = `
  CREATE TABLE IF NOT EXISTS rule_set_versions (
    id SERIAL PRIMARY KEY,
    parent_id INTEGER NOT NULL DEFAULT 0,
    hash TEXT NOT NULL,
    config TEXT NOT NULL,
    note TEXT,
    created_by INTEGER,
    created_at TEXT NOT NULL,
    UNIQUE (parent_id, hash)
  );
  CREATE TABLE IF NOT EXISTS decision_records (
    id SERIAL PRIMARY KEY,
    transaction_id INTEGER NOT NULL REFERENCES transactions(id),
    seq INTEGER NOT NULL,
    decision_type TEXT NOT NULL,
    applied INTEGER NOT NULL DEFAULT 1,
    origin TEXT NOT NULL DEFAULT 'live',
    decision_source TEXT NOT NULL,
    scoring_method TEXT NOT NULL,
    model_version TEXT,
    model_name TEXT,
    model_probability DOUBLE PRECISION,
    raw_probability DOUBLE PRECISION,
    calibrated INTEGER,
    ruleset_version INTEGER,
    ruleset_hash TEXT,
    policy_version INTEGER,
    thresholds TEXT NOT NULL,
    fraud_score DOUBLE PRECISION NOT NULL,
    risk_level TEXT NOT NULL,
    is_fraud INTEGER NOT NULL,
    reasons TEXT NOT NULL,
    hard_flags TEXT,
    shap TEXT,
    feature_snapshot TEXT,
    features_sha256 TEXT,
    shap_sha256 TEXT,
    context TEXT NOT NULL,
    engine_version TEXT NOT NULL,
    actor_user_id INTEGER,
    actor_username TEXT,
    reason TEXT,
    prev_hash TEXT,
    record_hash TEXT NOT NULL,
    redacted_at TEXT,
    created_at TEXT NOT NULL,
    UNIQUE (transaction_id, seq)
  );
  CREATE TABLE IF NOT EXISTS legal_holds (
    id SERIAL PRIMARY KEY,
    transaction_id INTEGER NOT NULL,
    reason TEXT NOT NULL,
    placed_by INTEGER,
    placed_at TEXT NOT NULL,
    released_by INTEGER,
    released_at TEXT
  );
  CREATE TABLE IF NOT EXISTS retention_runs (
    id SERIAL PRIMARY KEY,
    ran_at TEXT NOT NULL,
    actor TEXT NOT NULL,
    dry_run INTEGER NOT NULL,
    policy TEXT NOT NULL,
    results TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS retention_gate (id INTEGER PRIMARY KEY CHECK (id = 1), unlocked INTEGER NOT NULL DEFAULT 0);
  INSERT INTO retention_gate (id, unlocked) VALUES (1, 0) ON CONFLICT (id) DO NOTHING;
`;

const PG_FUNCTIONS = [
  `CREATE OR REPLACE FUNCTION fg_decision_guard() RETURNS trigger AS $$
   DECLARE gate_open boolean;
   BEGIN
     SELECT (unlocked = 1) INTO gate_open FROM retention_gate WHERE id = 1;
     IF TG_OP = 'DELETE' THEN
       IF gate_open THEN RETURN OLD; END IF;
       RAISE EXCEPTION 'decision_records is append-only';
     END IF;
     IF gate_open AND (to_jsonb(NEW) - 'feature_snapshot' - 'shap' - 'redacted_at') = (to_jsonb(OLD) - 'feature_snapshot' - 'shap' - 'redacted_at') THEN
       RETURN NEW;
     END IF;
     RAISE EXCEPTION 'decision_records is append-only';
   END $$ LANGUAGE plpgsql`,
  `CREATE OR REPLACE FUNCTION fg_audit_guard() RETURNS trigger AS $$
   DECLARE gate_open boolean;
   BEGIN
     IF TG_OP = 'DELETE' THEN
       SELECT (unlocked = 1) INTO gate_open FROM retention_gate WHERE id = 1;
       IF gate_open THEN RETURN OLD; END IF;
       RAISE EXCEPTION 'audit_logs is append-only; only the retention job may delete';
     END IF;
     RAISE EXCEPTION 'audit_logs is append-only';
   END $$ LANGUAGE plpgsql`,
];
const PG_TRIGGERS = [
  'DROP TRIGGER IF EXISTS trg_decision_guard ON decision_records',
  'CREATE TRIGGER trg_decision_guard BEFORE UPDATE OR DELETE ON decision_records FOR EACH ROW EXECUTE FUNCTION fg_decision_guard()',
  'DROP TRIGGER IF EXISTS trg_audit_guard ON audit_logs',
  'CREATE TRIGGER trg_audit_guard BEFORE UPDATE OR DELETE ON audit_logs FOR EACH ROW EXECUTE FUNCTION fg_audit_guard()',
];

const INDEXES = [
  'CREATE INDEX IF NOT EXISTS idx_decision_records_created ON decision_records(created_at)',
  'CREATE INDEX IF NOT EXISTS idx_decision_records_txn ON decision_records(transaction_id, seq)',
  'CREATE INDEX IF NOT EXISTS idx_legal_holds_txn ON legal_holds(transaction_id)',
  'CREATE INDEX IF NOT EXISTS idx_audit_logs_created ON audit_logs(created_at)',
];

async function initDecisionAuditSchema() {
  if (db.dialect === 'postgres') {
    await db.exec(PG_DDL);
    for (const fn of PG_FUNCTIONS) await db.exec(fn);
    for (const t of PG_TRIGGERS) await db.exec(t);
  } else {
    await db.exec(SQLITE_DDL);
    for (const t of SQLITE_TRIGGERS) await db.exec(t);
  }
  for (const ix of INDEXES) await db.exec(ix);
}

module.exports = { initDecisionAuditSchema };
