/** Persistent model monitoring: per-inference log, windowed/segmented drift snapshots, settings, and alert lifecycle columns. */
const db = require('./database');
const { addColumn } = require('./verificationSchema');

const SQLITE_DDL = `
  CREATE TABLE IF NOT EXISTS model_inference_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    transaction_id INTEGER,
    created_at TEXT NOT NULL,
    model_version TEXT,
    outcome TEXT NOT NULL,
    latency_ms INTEGER,
    score REAL,
    features TEXT,
    missing TEXT,
    unseen TEXT,
    seg_category TEXT,
    seg_amount_band TEXT,
    seg_card_type TEXT,
    seg_device TEXT
  );
  CREATE TABLE IF NOT EXISTS drift_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL,
    model_version TEXT NOT NULL,
    window_label TEXT NOT NULL,
    window_start TEXT NOT NULL,
    window_end TEXT NOT NULL,
    segment_dim TEXT NOT NULL,
    segment_value TEXT NOT NULL,
    n INTEGER NOT NULL,
    status TEXT NOT NULL,
    max_psi REAL,
    feature_psi TEXT,
    score_psi REAL,
    score_mean REAL,
    score_high_rate REAL,
    ops TEXT,
    quality TEXT
  );
  CREATE TABLE IF NOT EXISTS monitoring_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_by INTEGER,
    updated_at TEXT NOT NULL
  );
`;
const PG_DDL = SQLITE_DDL.replace(/INTEGER PRIMARY KEY AUTOINCREMENT/g, 'SERIAL PRIMARY KEY');

async function initMonitoringSchema() {
  await db.exec(db.dialect === 'postgres' ? PG_DDL : SQLITE_DDL);
  await db.exec('CREATE INDEX IF NOT EXISTS idx_inference_log_time ON model_inference_log(created_at)');
  await db.exec('CREATE INDEX IF NOT EXISTS idx_inference_log_version ON model_inference_log(model_version, created_at)');
  await db.exec('CREATE INDEX IF NOT EXISTS idx_drift_snapshots_scope ON drift_snapshots(window_label, segment_dim, segment_value, id)');
  await db.exec('CREATE INDEX IF NOT EXISTS idx_drift_snapshots_time ON drift_snapshots(created_at)');
  // alert lifecycle on the EXISTING model_health_events table (one alert store, not a second one)
  await addColumn('model_health_events', 'scope', 'TEXT');
  await addColumn('model_health_events', 'kind', 'TEXT');
  await addColumn('model_health_events', 'last_seen_at', 'TEXT');
  await addColumn('model_health_events', 'resolved_at', 'TEXT');
  await addColumn('model_health_events', 'acknowledged_by', 'INTEGER');
  await addColumn('model_health_events', 'acknowledged_at', 'TEXT');
  await addColumn('model_health_events', 'ack_note', 'TEXT');
  await db.exec('CREATE INDEX IF NOT EXISTS idx_model_health_open ON model_health_events(trigger_name, scope, resolved_at)');
}

module.exports = { initMonitoringSchema };
