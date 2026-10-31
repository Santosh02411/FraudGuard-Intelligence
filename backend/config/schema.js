/**
 * Schema initialization — creates tables/indexes for whichever dialect
 * config/database.js connected to, and seeds the default admin user.
 */

const bcrypt = require('bcryptjs');
const db = require('../config/database');
const config = require('./env');
const logger = require('./logger');
const fraudRuleRepository = require('../models/fraudRuleRepository');

const SQLITE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'user',
    failed_login_attempts INTEGER NOT NULL DEFAULT 0,
    locked_until DATETIME,
    email_verified INTEGER NOT NULL DEFAULT 0,
    email_verification_token_hash TEXT,
    email_verification_expires_at DATETIME,
    password_reset_token_hash TEXT,
    password_reset_expires_at DATETIME,
    totp_secret TEXT,
    totp_enabled INTEGER NOT NULL DEFAULT 0,
    totp_backup_codes TEXT,
    deleted_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    amount REAL NOT NULL,
    merchant TEXT NOT NULL,
    category TEXT NOT NULL,
    location TEXT NOT NULL,
    card_type TEXT NOT NULL,
    device_fingerprint TEXT,
    ip_address TEXT,
    is_fraud INTEGER NOT NULL DEFAULT 0,
    fraud_score REAL NOT NULL DEFAULT 0,
    risk_level TEXT NOT NULL DEFAULT 'low',
    fraud_reasons TEXT DEFAULT '[]',
    scoring_method TEXT DEFAULT 'rule_engine',
    model_version TEXT,
    hard_flag_triggered TEXT,
    shap_explanation TEXT DEFAULT '[]',
    plain_language_explanation TEXT,
    -- Model probability vs. policy decision vs. confirmed outcome, kept in
    -- three separate places (see models/riskPolicyRepository.js):
    --   model_probability = the ML model's CALIBRATED P(fraud), 0-1 (NULL when
    --                       the ML model did not score this transaction);
    --   risk_level/is_fraud/fraud_score = the POLICY decision, made with the
    --                       thresholds in force (policy_version) + rule overrides;
    --   alerts.verdict    = the confirmed OUTCOME, set later by an analyst.
    model_probability REAL,
    policy_version INTEGER,
    ml_latency_ms INTEGER,
    is_synthetic INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS alerts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    transaction_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    message TEXT NOT NULL,
    risk_level TEXT NOT NULL,
    resolved INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'open',
    verdict TEXT,
    resolution_note TEXT,
    assigned_to INTEGER,
    resolved_by INTEGER,
    resolved_at DATETIME,
    version INTEGER NOT NULL DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (transaction_id) REFERENCES transactions(id),
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (assigned_to) REFERENCES users(id),
    FOREIGN KEY (resolved_by) REFERENCES users(id)
  );


  -- Versioned, append-only risk thresholds (see models/riskPolicyRepository.js).
  -- Changing a threshold INSERTS a new version; old rows are never edited, so
  -- every transaction's policy_version still points at the exact thresholds
  -- that produced its decision. Thresholds are in SCORE units (calibrated
  -- probability x 100). No rows = the built-in defaults apply (version 0).
  -- Persistent, ordered real-time event log (see models/realtimeEventRepository.js).
  -- The autoincrement id IS the replay cursor. 'simulation' events are stored
  -- with source='simulation' and are never delivered as live transactions.
  CREATE TABLE IF NOT EXISTS realtime_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_type TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'live',
    user_id INTEGER,
    risk_level TEXT,
    payload TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- Model change workflow + history (see models/modelChangeRepository.js).
  CREATE TABLE IF NOT EXISTS model_change_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    action TEXT NOT NULL,
    target_version TEXT NOT NULL,
    from_version TEXT,
    status TEXT NOT NULL DEFAULT 'pending_approval',
    reason TEXT NOT NULL,
    checklist TEXT NOT NULL DEFAULT '{}',
    gate_report TEXT,
    gate_report_at_apply TEXT,
    acknowledged_gates TEXT,
    requested_by INTEGER,
    requested_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    decided_by INTEGER,
    decided_at DATETIME,
    decision_note TEXT,
    applied_at DATETIME,
    apply_result TEXT,
    version INTEGER NOT NULL DEFAULT 1,
    FOREIGN KEY (requested_by) REFERENCES users(id),
    FOREIGN KEY (decided_by) REFERENCES users(id)
  );

  -- Runtime rollback-trigger evaluations (see services/modelHealthService.js).
  CREATE TABLE IF NOT EXISTS model_health_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    model_version TEXT,
    trigger_name TEXT NOT NULL,
    severity TEXT NOT NULL,
    details TEXT NOT NULL DEFAULT '{}',
    action_taken TEXT NOT NULL DEFAULT 'none',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- Challenger scores recorded per real transaction, so a shadow model can
  -- later be judged against analyst verdicts, not just agreement with the incumbent.
  CREATE TABLE IF NOT EXISTS shadow_scores (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    transaction_id INTEGER NOT NULL,
    shadow_version TEXT NOT NULL,
    shadow_probability REAL NOT NULL,
    incumbent_version TEXT,
    incumbent_probability REAL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (transaction_id, shadow_version),
    FOREIGN KEY (transaction_id) REFERENCES transactions(id)
  );

  CREATE TABLE IF NOT EXISTS risk_policy (
    version INTEGER PRIMARY KEY AUTOINCREMENT,
    medium_threshold REAL NOT NULL,
    high_threshold REAL NOT NULL,
    review_capacity_per_day INTEGER,
    note TEXT NOT NULL,
    created_by INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (created_by) REFERENCES users(id)
  );

  -- Configurable fraud rules (feature: admin rule builder — see
  -- models/fraudRuleRepository.js, fraudEngine.js's checkHardRules).
  -- Replaces the old hardcoded HARD_RULES_CONFIG constant: an admin can
  -- now add/edit/disable blacklist entries and the absolute amount cap
  -- from the Admin UI instead of a code deploy. Seeded once from the
  -- original hardcoded defaults so upgrading an existing install doesn't
  -- silently change scoring behavior (see fraudRuleRepository.seedDefaultsIfEmpty).
  -- "value" is used for blacklist_* rule types (the merchant/location/
  -- device/ip string); "threshold" is used for amount_cap (the dollar
  -- amount) — exactly one of the two is populated depending on rule_type,
  -- enforced at the application layer (schemas/adminSchemas.js), not by
  -- a CHECK constraint, so this stays portable across both dialects.
  CREATE TABLE IF NOT EXISTS fraud_rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    rule_type TEXT NOT NULL,
    value TEXT,
    threshold REAL,
    enabled INTEGER NOT NULL DEFAULT 1,
    reason TEXT,
    created_by INTEGER,
    updated_by INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (created_by) REFERENCES users(id),
    FOREIGN KEY (updated_by) REFERENCES users(id)
  );

  -- Chargeback/dispute lifecycle (feature: chargeback/dispute tracking —
  -- see models/disputeRepository.js). Separate from alerts.verdict
  -- ('confirmed_fraud'/'false_positive'), which is FraudGuard's OWN
  -- read on a transaction — a dispute tracks what actually happened
  -- financially with the card network, which can (and often does)
  -- disagree with that verdict. One dispute per transaction: opened ->
  -- evidence_submitted -> won|lost, enforced by disputeRepository's
  -- transition map, not a DB constraint (portability, same reasoning as
  -- fraud_rules above).
  CREATE TABLE IF NOT EXISTS disputes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    transaction_id INTEGER NOT NULL UNIQUE,
    status TEXT NOT NULL DEFAULT 'opened',
    amount_disputed REAL NOT NULL,
    reason TEXT,
    evidence_note TEXT,
    resolution_note TEXT,
    opened_by INTEGER,
    opened_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    evidence_submitted_at DATETIME,
    resolved_at DATETIME,
    updated_by INTEGER,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    version INTEGER NOT NULL DEFAULT 1,
    FOREIGN KEY (transaction_id) REFERENCES transactions(id),
    FOREIGN KEY (opened_by) REFERENCES users(id),
    FOREIGN KEY (updated_by) REFERENCES users(id)
  );

  -- Step-up authentication challenges (feature: step-up auth hook — see
  -- models/stepUpRepository.js). A medium-risk transaction from an
  -- account with a webhook subscribed to 'transaction.step_up_required'
  -- is held in 'pending_step_up' rather than completed immediately;
  -- this row is the challenge the calling merchant is expected to
  -- resolve (via their own OTP/3DS flow) before calling back into
  -- POST /api/transactions/:id/step-up/verify. See routes/transactions.js.
  CREATE TABLE IF NOT EXISTS step_up_challenges (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    transaction_id INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    method TEXT NOT NULL DEFAULT 'otp',
    challenge_token TEXT NOT NULL UNIQUE,
    expires_at DATETIME NOT NULL,
    verified_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (transaction_id) REFERENCES transactions(id)
  );

  -- Refresh tokens (see routes/auth.js, models/refreshTokenRepository.js).
  -- The token itself is never stored — only a SHA-256 hash of it, same
  -- reasoning as password hashing: a DB read (backup leak, SQL injection,
  -- etc) shouldn't hand over a usable credential.
  CREATE TABLE IF NOT EXISTS refresh_tokens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    token_hash TEXT UNIQUE NOT NULL,
    expires_at DATETIME NOT NULL,
    revoked_at DATETIME,
    replaced_by_id INTEGER,
    ip_address TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  -- Audit trail (see models/auditLogRepository.js, middleware/auditLog.js).
  -- user_id is nullable (e.g. a failed login on a username that doesn't
  -- exist has no user to attribute it to) and username is denormalized
  -- so the trail reads correctly even if the account is later renamed —
  -- an audit log should never silently rewrite history.
  CREATE TABLE IF NOT EXISTS audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    username TEXT,
    action TEXT NOT NULL,
    target_type TEXT,
    target_id INTEGER,
    outcome TEXT NOT NULL DEFAULT 'success',
    ip_address TEXT,
    details TEXT DEFAULT '{}',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  -- API keys (feature: service-to-service auth — see middleware/apiKeyAuth.js).
  -- The raw key is never stored, only its SHA-256 hash, same reasoning
  -- as refresh tokens/passwords. Acts "as" user_id (the account that
  -- created it) for authorization purposes, but every request made with
  -- it is traceable back to the key itself (id/name) rather than just
  -- the underlying user, which matters when a service integration needs
  -- its own credential lifecycle independent of a human's login session.
  CREATE TABLE IF NOT EXISTS api_keys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    key_hash TEXT UNIQUE NOT NULL,
    key_prefix TEXT NOT NULL,
    scopes TEXT NOT NULL DEFAULT '[]',
    created_by INTEGER,
    expires_at DATETIME,
    last_used_at DATETIME,
    revoked_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (created_by) REFERENCES users(id)
  );

  -- Outbound webhooks (feature: webhook notifications — see
  -- services/webhookService.js). "secret" is used to HMAC-sign every
  -- delivery so the receiving endpoint can verify a payload actually
  -- came from FraudGuard, the same pattern Stripe/GitHub webhooks use.
  CREATE TABLE IF NOT EXISTS webhooks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    url TEXT NOT NULL,
    secret TEXT NOT NULL,
    events TEXT NOT NULL DEFAULT '[]',
    active INTEGER NOT NULL DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  -- Delivery attempts for outbound webhooks — lets an integrator (or an
  -- admin debugging on their behalf) actually see whether a delivery
  -- succeeded, without needing server log access.
  CREATE TABLE IF NOT EXISTS webhook_deliveries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    webhook_id INTEGER NOT NULL,
    event TEXT NOT NULL,
    payload TEXT NOT NULL,
    response_status INTEGER,
    success INTEGER NOT NULL DEFAULT 0,
    attempt INTEGER NOT NULL DEFAULT 1,
    error TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (webhook_id) REFERENCES webhooks(id)
  );

  -- Idempotency keys (feature: safe retries on POST /transactions — see
  -- middleware/idempotency.js). Scoped per-user: two different accounts
  -- can reuse the same key value without colliding. "status" is
  -- 'pending' the instant a key is reserved (before the handler runs)
  -- and 'completed' once a response is cached, so a genuinely
  -- concurrent duplicate request (not just a sequential retry) gets a
  -- clear "already in progress" answer instead of double-processing.
  CREATE TABLE IF NOT EXISTS idempotency_keys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    idempotency_key TEXT NOT NULL,
    request_hash TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    response_status INTEGER,
    response_body TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    locked_at TEXT,
    expires_at DATETIME NOT NULL,
    UNIQUE (user_id, idempotency_key),
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  -- Persistent webhook retry queue (feature: retries that survive a
  -- restart). The first delivery attempt happens inline when dispatched
  -- (services/webhookService.js); if it fails, instead of only an
  -- in-memory setTimeout (lost on process restart), a row lands here.
  -- A periodic sweeper (services/webhookRetryWorker.js) picks up any
  -- row whose next_retry_at has passed, on every server instance that
  -- happens to be running — so a retry scheduled right before a deploy
  -- restart still eventually fires instead of silently vanishing.
  CREATE TABLE IF NOT EXISTS webhook_retry_queue (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    webhook_id INTEGER NOT NULL,
    event TEXT NOT NULL,
    payload TEXT NOT NULL,
    attempt INTEGER NOT NULL DEFAULT 1,
    next_retry_at DATETIME NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (webhook_id) REFERENCES webhooks(id)
  );

  CREATE INDEX IF NOT EXISTS idx_transactions_user_created ON transactions(user_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_transactions_is_fraud ON transactions(is_fraud) WHERE is_fraud = 1;
  CREATE INDEX IF NOT EXISTS idx_alerts_user_created ON alerts(user_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user ON refresh_tokens(user_id);
  CREATE INDEX IF NOT EXISTS idx_audit_logs_user_created ON audit_logs(user_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_audit_logs_target ON audit_logs(target_type, target_id);
  CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(key_hash);
  CREATE INDEX IF NOT EXISTS idx_api_keys_user ON api_keys(user_id);
  CREATE INDEX IF NOT EXISTS idx_webhooks_user ON webhooks(user_id);
  CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_webhook ON webhook_deliveries(webhook_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_idempotency_keys_expires ON idempotency_keys(expires_at);
  CREATE INDEX IF NOT EXISTS idx_webhook_retry_queue_next_retry ON webhook_retry_queue(next_retry_at);
  CREATE INDEX IF NOT EXISTS idx_fraud_rules_type_enabled ON fraud_rules(rule_type, enabled);
  CREATE INDEX IF NOT EXISTS idx_disputes_status ON disputes(status);
  CREATE INDEX IF NOT EXISTS idx_step_up_challenges_transaction ON step_up_challenges(transaction_id);
  CREATE INDEX IF NOT EXISTS idx_step_up_challenges_token ON step_up_challenges(challenge_token);
`;

const POSTGRES_SCHEMA = `
  CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'user',
    failed_login_attempts INTEGER NOT NULL DEFAULT 0,
    locked_until TIMESTAMPTZ,
    email_verified INTEGER NOT NULL DEFAULT 0,
    email_verification_token_hash TEXT,
    email_verification_expires_at TIMESTAMPTZ,
    password_reset_token_hash TEXT,
    password_reset_expires_at TIMESTAMPTZ,
    totp_secret TEXT,
    totp_enabled INTEGER NOT NULL DEFAULT 0,
    totp_backup_codes TEXT,
    deleted_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS transactions (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    amount REAL NOT NULL,
    merchant TEXT NOT NULL,
    category TEXT NOT NULL,
    location TEXT NOT NULL,
    card_type TEXT NOT NULL,
    device_fingerprint TEXT,
    ip_address TEXT,
    is_fraud INTEGER NOT NULL DEFAULT 0,
    fraud_score REAL NOT NULL DEFAULT 0,
    risk_level TEXT NOT NULL DEFAULT 'low',
    fraud_reasons TEXT DEFAULT '[]',
    scoring_method TEXT DEFAULT 'rule_engine',
    model_version TEXT,
    hard_flag_triggered TEXT,
    shap_explanation TEXT DEFAULT '[]',
    plain_language_explanation TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS alerts (
    id SERIAL PRIMARY KEY,
    transaction_id INTEGER NOT NULL REFERENCES transactions(id),
    user_id INTEGER NOT NULL REFERENCES users(id),
    message TEXT NOT NULL,
    risk_level TEXT NOT NULL,
    resolved INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'open',
    verdict TEXT,
    resolution_note TEXT,
    assigned_to INTEGER REFERENCES users(id),
    resolved_by INTEGER REFERENCES users(id),
    resolved_at TIMESTAMPTZ,
    version INTEGER NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
  );

  -- Persistent, ordered real-time event log (see models/realtimeEventRepository.js).
  -- The autoincrement id IS the replay cursor. 'simulation' events are stored
  -- with source='simulation' and are never delivered as live transactions.
  CREATE TABLE IF NOT EXISTS realtime_events (
    id SERIAL PRIMARY KEY,
    event_type TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'live',
    user_id INTEGER,
    risk_level TEXT,
    payload TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
  );

  -- Model change workflow + history (see models/modelChangeRepository.js).
  CREATE TABLE IF NOT EXISTS model_change_requests (
    id SERIAL PRIMARY KEY,
    action TEXT NOT NULL,
    target_version TEXT NOT NULL,
    from_version TEXT,
    status TEXT NOT NULL DEFAULT 'pending_approval',
    reason TEXT NOT NULL,
    checklist TEXT NOT NULL DEFAULT '{}',
    gate_report TEXT,
    gate_report_at_apply TEXT,
    acknowledged_gates TEXT,
    requested_by INTEGER REFERENCES users(id),
    requested_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    decided_by INTEGER REFERENCES users(id),
    decided_at TIMESTAMPTZ,
    decision_note TEXT,
    applied_at TIMESTAMPTZ,
    apply_result TEXT,
    version INTEGER NOT NULL DEFAULT 1,
    CONSTRAINT mcr_action_chk CHECK (action <> '')
  );

  -- Runtime rollback-trigger evaluations (see services/modelHealthService.js).
  CREATE TABLE IF NOT EXISTS model_health_events (
    id SERIAL PRIMARY KEY,
    model_version TEXT,
    trigger_name TEXT NOT NULL,
    severity TEXT NOT NULL,
    details TEXT NOT NULL DEFAULT '{}',
    action_taken TEXT NOT NULL DEFAULT 'none',
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
  );

  -- Challenger scores recorded per real transaction, so a shadow model can
  -- later be judged against analyst verdicts, not just agreement with the incumbent.
  CREATE TABLE IF NOT EXISTS shadow_scores (
    id SERIAL PRIMARY KEY,
    transaction_id INTEGER NOT NULL REFERENCES transactions(id),
    shadow_version TEXT NOT NULL,
    shadow_probability REAL NOT NULL,
    incumbent_version TEXT,
    incumbent_probability REAL,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (transaction_id, shadow_version)
  );

  CREATE TABLE IF NOT EXISTS risk_policy (
    version SERIAL PRIMARY KEY,
    medium_threshold DOUBLE PRECISION NOT NULL,
    high_threshold DOUBLE PRECISION NOT NULL,
    review_capacity_per_day INTEGER,
    note TEXT NOT NULL,
    created_by INTEGER REFERENCES users(id),
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS fraud_rules (
    id SERIAL PRIMARY KEY,
    rule_type TEXT NOT NULL,
    value TEXT,
    threshold REAL,
    enabled INTEGER NOT NULL DEFAULT 1,
    reason TEXT,
    created_by INTEGER REFERENCES users(id),
    updated_by INTEGER REFERENCES users(id),
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS disputes (
    id SERIAL PRIMARY KEY,
    transaction_id INTEGER NOT NULL UNIQUE REFERENCES transactions(id),
    status TEXT NOT NULL DEFAULT 'opened',
    amount_disputed REAL NOT NULL,
    reason TEXT,
    evidence_note TEXT,
    resolution_note TEXT,
    opened_by INTEGER REFERENCES users(id),
    opened_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    evidence_submitted_at TIMESTAMPTZ,
    resolved_at TIMESTAMPTZ,
    updated_by INTEGER REFERENCES users(id),
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    version INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS step_up_challenges (
    id SERIAL PRIMARY KEY,
    transaction_id INTEGER NOT NULL REFERENCES transactions(id),
    status TEXT NOT NULL DEFAULT 'pending',
    method TEXT NOT NULL DEFAULT 'otp',
    challenge_token TEXT NOT NULL UNIQUE,
    expires_at TIMESTAMPTZ NOT NULL,
    verified_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS refresh_tokens (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    token_hash TEXT UNIQUE NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    revoked_at TIMESTAMPTZ,
    replaced_by_id INTEGER,
    ip_address TEXT,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS audit_logs (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id),
    username TEXT,
    action TEXT NOT NULL,
    target_type TEXT,
    target_id INTEGER,
    outcome TEXT NOT NULL DEFAULT 'success',
    ip_address TEXT,
    details TEXT DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS api_keys (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    name TEXT NOT NULL,
    key_hash TEXT UNIQUE NOT NULL,
    key_prefix TEXT NOT NULL,
    scopes TEXT NOT NULL DEFAULT '[]',
    created_by INTEGER REFERENCES users(id),
    expires_at TIMESTAMPTZ,
    last_used_at TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS webhooks (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    url TEXT NOT NULL,
    secret TEXT NOT NULL,
    events TEXT NOT NULL DEFAULT '[]',
    active INTEGER NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS webhook_deliveries (
    id SERIAL PRIMARY KEY,
    webhook_id INTEGER NOT NULL REFERENCES webhooks(id),
    event TEXT NOT NULL,
    payload TEXT NOT NULL,
    response_status INTEGER,
    success INTEGER NOT NULL DEFAULT 0,
    attempt INTEGER NOT NULL DEFAULT 1,
    error TEXT,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS idempotency_keys (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    idempotency_key TEXT NOT NULL,
    request_hash TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    response_status INTEGER,
    response_body TEXT,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    locked_at TEXT,
    expires_at TIMESTAMPTZ NOT NULL,
    UNIQUE (user_id, idempotency_key)
  );

  CREATE TABLE IF NOT EXISTS webhook_retry_queue (
    id SERIAL PRIMARY KEY,
    webhook_id INTEGER NOT NULL REFERENCES webhooks(id),
    event TEXT NOT NULL,
    payload TEXT NOT NULL,
    attempt INTEGER NOT NULL DEFAULT 1,
    next_retry_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_transactions_user_created ON transactions(user_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_transactions_is_fraud ON transactions(is_fraud) WHERE is_fraud = 1;
  CREATE INDEX IF NOT EXISTS idx_alerts_user_created ON alerts(user_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_alerts_status ON alerts(status);
  CREATE INDEX IF NOT EXISTS idx_alerts_assigned_to ON alerts(assigned_to);
  CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user ON refresh_tokens(user_id);
  CREATE INDEX IF NOT EXISTS idx_audit_logs_user_created ON audit_logs(user_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_audit_logs_target ON audit_logs(target_type, target_id);
  CREATE INDEX IF NOT EXISTS idx_users_email_verification_token ON users(email_verification_token_hash);
  CREATE INDEX IF NOT EXISTS idx_users_password_reset_token ON users(password_reset_token_hash);
  CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(key_hash);
  CREATE INDEX IF NOT EXISTS idx_api_keys_user ON api_keys(user_id);
  CREATE INDEX IF NOT EXISTS idx_webhooks_user ON webhooks(user_id);
  CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_webhook ON webhook_deliveries(webhook_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_idempotency_keys_expires ON idempotency_keys(expires_at);
  CREATE INDEX IF NOT EXISTS idx_webhook_retry_queue_next_retry ON webhook_retry_queue(next_retry_at);
  CREATE INDEX IF NOT EXISTS idx_fraud_rules_type_enabled ON fraud_rules(rule_type, enabled);
  CREATE INDEX IF NOT EXISTS idx_disputes_status ON disputes(status);
  CREATE INDEX IF NOT EXISTS idx_step_up_challenges_transaction ON step_up_challenges(transaction_id);
  CREATE INDEX IF NOT EXISTS idx_step_up_challenges_token ON step_up_challenges(challenge_token);
`;

let initialized = false;

async function initSchema() {
  if (initialized) return;

  await db.exec(db.dialect === 'postgres' ? POSTGRES_SCHEMA : SQLITE_SCHEMA);

  if (db.dialect === 'postgres') {
    // Idempotent upgrade for Postgres databases created before these columns existed.
    await db.exec('ALTER TABLE transactions ADD COLUMN IF NOT EXISTS model_probability DOUBLE PRECISION');
    await db.exec('ALTER TABLE transactions ADD COLUMN IF NOT EXISTS policy_version INTEGER');
    await db.exec('ALTER TABLE transactions ADD COLUMN IF NOT EXISTS ml_latency_ms INTEGER');
    await db.exec('ALTER TABLE transactions ADD COLUMN IF NOT EXISTS is_synthetic INTEGER NOT NULL DEFAULT 0');
    await db.exec('ALTER TABLE alerts ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1');
    await db.exec('ALTER TABLE disputes ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1');
    await db.exec('ALTER TABLE idempotency_keys ADD COLUMN IF NOT EXISTS locked_at TEXT');
  }

  if (db.dialect === 'sqlite') {
    // Lightweight migration for SQLite dev DBs created before these
    // columns existed (Postgres deployments are always fresh, so this
    // only applies to the SQLite path).
    const cols = (await db.all("PRAGMA table_info(transactions)")).map((c) => c.name);
    const addColumnIfMissing = async (table, name, ddl) => {
      const tableCols = table === 'transactions' ? cols : (await db.all(`PRAGMA table_info(${table})`)).map((c) => c.name);
      if (!tableCols.includes(name)) {
        await db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
      }
    };
    await addColumnIfMissing('transactions', 'device_fingerprint', 'device_fingerprint TEXT');
    await addColumnIfMissing('transactions', 'ip_address', 'ip_address TEXT');
    await addColumnIfMissing('transactions', 'scoring_method', "scoring_method TEXT DEFAULT 'rule_engine'");
    await addColumnIfMissing('transactions', 'model_version', 'model_version TEXT');
    await addColumnIfMissing('transactions', 'hard_flag_triggered', 'hard_flag_triggered TEXT');
    await addColumnIfMissing('transactions', 'shap_explanation', "shap_explanation TEXT DEFAULT '[]'");
    // Plain-language explanation cache (feature: LLM-generated
    // explanations — see services/explanationService.js). Nullable and
    // generated lazily on first analyst view (GET /api/alerts/:id/explanation),
    // not at scoring time, so the 99% of transactions nobody ever looks
    // at don't pay for it.
    await addColumnIfMissing('transactions', 'plain_language_explanation', 'plain_language_explanation TEXT');
    await addColumnIfMissing('transactions', 'model_probability', 'model_probability REAL');
    await addColumnIfMissing('transactions', 'policy_version', 'policy_version INTEGER');
    await addColumnIfMissing('transactions', 'ml_latency_ms', 'ml_latency_ms INTEGER');
    await addColumnIfMissing('transactions', 'is_synthetic', 'is_synthetic INTEGER NOT NULL DEFAULT 0');
    await addColumnIfMissing('alerts', 'version', 'version INTEGER NOT NULL DEFAULT 1');
    await addColumnIfMissing('disputes', 'version', 'version INTEGER NOT NULL DEFAULT 1');
    await addColumnIfMissing('idempotency_keys', 'locked_at', 'locked_at TEXT');
    // Account lockout columns (feature: login attempt lockout, see routes/auth.js)
    await addColumnIfMissing('users', 'failed_login_attempts', 'failed_login_attempts INTEGER NOT NULL DEFAULT 0');
    await addColumnIfMissing('users', 'locked_until', 'locked_until DATETIME');
    // Account & auth columns (feature: email verification, password
    // reset, self-service profile management, TOTP 2FA — see
    // routes/auth.js and models/userRepository.js)
    await addColumnIfMissing('users', 'email_verified', 'email_verified INTEGER NOT NULL DEFAULT 0');
    await addColumnIfMissing('users', 'email_verification_token_hash', 'email_verification_token_hash TEXT');
    await addColumnIfMissing('users', 'email_verification_expires_at', 'email_verification_expires_at DATETIME');
    await addColumnIfMissing('users', 'password_reset_token_hash', 'password_reset_token_hash TEXT');
    await addColumnIfMissing('users', 'password_reset_expires_at', 'password_reset_expires_at DATETIME');
    await addColumnIfMissing('users', 'totp_secret', 'totp_secret TEXT');
    await addColumnIfMissing('users', 'totp_enabled', 'totp_enabled INTEGER NOT NULL DEFAULT 0');
    await addColumnIfMissing('users', 'totp_backup_codes', 'totp_backup_codes TEXT');
    // Account deletion (feature: self-service data export + account
    // deletion — see routes/auth.js DELETE /me). Anonymized, not
    // hard-deleted — see that route's comment on why transactions/
    // alerts are retained even after account closure.
    await addColumnIfMissing('users', 'deleted_at', 'deleted_at DATETIME');
    // Service-to-service auth (feature: API key expiration policy —
    // see routes/apiKeys.js). Nullable: existing keys created before
    // this feature keep working with no expiry, matching the "opt-in,
    // never silently break something that worked" migration pattern
    // used throughout this file.
    await addColumnIfMissing('api_keys', 'expires_at', 'expires_at DATETIME');
    // Alert case-management columns (feature: verdict/note/assignment — see models/alertRepository.js)
    await addColumnIfMissing('alerts', 'status', "status TEXT NOT NULL DEFAULT 'open'");
    await addColumnIfMissing('alerts', 'verdict', 'verdict TEXT');
    await addColumnIfMissing('alerts', 'resolution_note', 'resolution_note TEXT');
    await addColumnIfMissing('alerts', 'assigned_to', 'assigned_to INTEGER');
    await addColumnIfMissing('alerts', 'resolved_by', 'resolved_by INTEGER');
    await addColumnIfMissing('alerts', 'resolved_at', 'resolved_at DATETIME');
    // Backfill status for any pre-existing rows from before this column
    // existed, so old resolved alerts don't sit inconsistently at the
    // 'open' default forever.
    await db.exec("UPDATE alerts SET status = 'resolved' WHERE resolved = 1 AND status = 'open'");
    // These indexes reference columns added by the migration above, so
    // they can only be created after it runs — doing this in the main
    // SQLITE_SCHEMA block would fail on a pre-existing SQLite DB where
    // CREATE TABLE IF NOT EXISTS is a no-op and the columns don't exist
    // yet at that point in exec(). Fresh SQLite DBs already have the
    // columns from SQLITE_SCHEMA above, so this is just redundant (and
    // IF NOT EXISTS-safe) for them.
    await db.exec('CREATE INDEX IF NOT EXISTS idx_alerts_status ON alerts(status)');
    await db.exec('CREATE INDEX IF NOT EXISTS idx_alerts_assigned_to ON alerts(assigned_to)');
    await db.exec('CREATE INDEX IF NOT EXISTS idx_users_email_verification_token ON users(email_verification_token_hash)');
    await db.exec('CREATE INDEX IF NOT EXISTS idx_users_password_reset_token ON users(password_reset_token_hash)');
  }


  // One alert per transaction, enforced by the database. Older databases may
  // already contain duplicates (created by a double submit); keep the earliest
  // alert of each transaction so the unique index can be created.
  const dupes = await db.run('DELETE FROM alerts WHERE id NOT IN (SELECT MIN(id) FROM alerts GROUP BY transaction_id)');
  if (dupes.changes > 0) logger.warn('Removed duplicate alerts before enforcing uniqueness', { removed: dupes.changes });
  await db.exec('CREATE UNIQUE INDEX IF NOT EXISTS uq_alerts_transaction ON alerts(transaction_id)');
  await db.exec('CREATE INDEX IF NOT EXISTS idx_realtime_events_user ON realtime_events(user_id, id)');
  await db.exec('CREATE INDEX IF NOT EXISTS idx_model_change_requests_status ON model_change_requests(status)');
  // One OPEN change per action at a time: two admins cannot both have a promotion in flight.
  await db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS uq_model_change_open ON model_change_requests(action)
                 WHERE status IN ('pending_approval', 'approved', 'applying')`);
  await db.exec('CREATE INDEX IF NOT EXISTS idx_shadow_scores_version ON shadow_scores(shadow_version)');
  await db.exec('CREATE INDEX IF NOT EXISTS idx_model_health_events_created ON model_health_events(created_at)');
  await db.exec('CREATE INDEX IF NOT EXISTS idx_transactions_synthetic ON transactions(is_synthetic)');
  await require('./decisionAuditSchema').initDecisionAuditSchema();
  await require('./caseSchema').initCaseSchema();
  await require('./investigationSchema').initInvestigationSchema();
  await require('./ruleLifecycleSchema').initRuleLifecycleSchema();
  await require('./verificationSchema').initVerificationSchema();
  await require('./monitoringSchema').initMonitoringSchema();
  await require('./feedbackSchema').initFeedbackSchema();
  await require('./cogneeSchema').initCogneeSchema();

  const admin = await db.get('SELECT id FROM users WHERE username = ?', ['admin']);
  if (!admin) {
    if (config.adminPassword) {
      // Bootstrapped directly, NOT through schemas/authSchemas.js's
      // password-strength rules (routes/auth.js's registration path) —
      // intentional, since this only ever runs with the operator-supplied
      // ADMIN_PASSWORD env var (or the documented "admin123" dev default),
      // not with attacker-controlled input.
      const hash = bcrypt.hashSync(config.adminPassword, 10);
      await db.insert(
        'INSERT INTO users (username, email, password, role) VALUES (?, ?, ?, ?)',
        ['admin', 'admin@frauddetection.com', hash, 'admin']
      );
      logger.info('Admin user created', { username: 'admin', usingDefaultPassword: config.isDev || config.isTest });
    } else {
      // Staging/production with no ADMIN_PASSWORD set: skip creating a
      // default admin rather than falling back to a known credential.
      // Set ADMIN_PASSWORD and restart to bootstrap one.
      logger.warn('No admin user exists and ADMIN_PASSWORD is not set — skipping default admin creation. Set ADMIN_PASSWORD and restart to bootstrap one.');
    }
  }

  // Configurable fraud rules (feature: admin rule builder) — seed once
  // from the original hardcoded HARD_RULES_CONFIG defaults so upgrading
  // an existing install doesn't silently change scoring behavior. Runs
  // after the admin bootstrap above so seeded rows can be attributed to
  // a real user id when one exists.
  const adminForSeed = await db.get('SELECT id FROM users WHERE username = ?', ['admin']);
  await fraudRuleRepository.seedDefaultsIfEmpty(adminForSeed?.id ?? null);

  initialized = true;
  logger.info('Database ready', { dialect: db.dialect, env: config.env });
}

module.exports = { initSchema };
