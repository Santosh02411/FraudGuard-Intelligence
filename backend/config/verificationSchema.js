/** Risk-based verification: versioned policy, per-challenge audit events, and the extra columns on transactions / step_up_challenges. */
const db = require('./database');

const SQLITE_DDL = `
  CREATE TABLE IF NOT EXISTS verification_policy (
    version INTEGER PRIMARY KEY AUTOINCREMENT,
    mode TEXT NOT NULL DEFAULT 'off',
    actions TEXT NOT NULL,
    min_amount REAL,
    ttl_seconds INTEGER NOT NULL,
    note TEXT NOT NULL,
    created_by INTEGER,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS verification_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    challenge_id INTEGER,
    transaction_id INTEGER NOT NULL,
    kind TEXT NOT NULL,
    actor TEXT,
    detail TEXT,
    created_at TEXT NOT NULL
  );
`;
const PG_DDL = SQLITE_DDL.replace(/INTEGER PRIMARY KEY AUTOINCREMENT/g, 'SERIAL PRIMARY KEY');

async function addColumn(table, name, ddl) {
  if (db.dialect === 'postgres') { await db.exec(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${name} ${ddl}`); return; }
  const cols = (await db.all(`PRAGMA table_info(${table})`)).map((c) => c.name);
  if (!cols.includes(name)) await db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${ddl}`);
}

async function initVerificationSchema() {
  await db.exec(db.dialect === 'postgres' ? PG_DDL : SQLITE_DDL);
  await addColumn('transactions', 'verification_action', 'TEXT');
  await addColumn('transactions', 'verification_mode', 'TEXT');
  await addColumn('transactions', 'verification_policy_version', 'INTEGER');
  await addColumn('transactions', 'verification_enforced', 'INTEGER');
  await addColumn('transactions', 'verification_note', 'TEXT');
  await addColumn('transactions', 'geo_velocity_status', 'TEXT');
  await addColumn('transactions', 'geo_distance_km', 'REAL');
  await addColumn('transactions', 'geo_required_kmh', 'REAL');
  await addColumn('step_up_challenges', 'policy_version', 'INTEGER');
  await addColumn('step_up_challenges', 'risk_level', 'TEXT');
  await addColumn('step_up_challenges', 'amount', 'REAL');
  await addColumn('step_up_challenges', 'resolved_at', 'TEXT');
  await addColumn('step_up_challenges', 'outcome_reason', 'TEXT');
  await addColumn('step_up_challenges', 'replay_attempts', 'INTEGER NOT NULL DEFAULT 0');
  await db.exec('CREATE INDEX IF NOT EXISTS idx_verification_events_txn ON verification_events(transaction_id, id)');
  await db.exec('CREATE INDEX IF NOT EXISTS idx_step_up_status_expiry ON step_up_challenges(status, expires_at)');
}

module.exports = { initVerificationSchema, addColumn };
