/**
 * Environment-based configuration.
 * ====================================
 * The single place that reads process.env. Every other module imports
 * the parsed `config` object from here instead of touching
 * `process.env` directly — that's what makes it possible to validate
 * everything once, at startup, and fail fast with a clear error instead
 * of discovering a missing/malformed var halfway through a request in
 * production.
 *
 * NODE_ENV drives environment-specific behavior:
 *   - development — verbose (debug) logs, SQLite is fine, a default
 *     admin password is allowed so `npm start` works with zero config.
 *   - staging / production — stricter: DATABASE_URL is required (no
 *     SQLite — see README's "SQLite vs PostgreSQL"), JWT_SECRET must be
 *     reasonably long, and there's no fallback admin password — you
 *     must set one explicitly or the app simply won't create a default
 *     admin account, rather than shipping a known-weak credential.
 *
 * `.env` is never committed (see .gitignore) — copy `.env.example` to
 * `.env` for local dev; staging/production supply real values through
 * the deploy platform's secret manager (Render/Railway/ECS/etc), not a
 * checked-in file.
 */

require("dotenv").config();
const { z } = require("zod");

const envSchema = z.object({
  NODE_ENV: z
    .enum(["development", "staging", "production", "test"])
    .default("development"),
  PORT: z.coerce.number().int().positive().default(5000),
  JWT_SECRET: z.string().min(1, "JWT_SECRET is required"),
  JWT_ACCESS_EXPIRES_IN: z.string().min(1).default("15m"),
  REFRESH_TOKEN_EXPIRES_DAYS: z.coerce.number().int().positive().default(30),
  DATABASE_URL: z.string().min(1).optional(),
  DB_POOL_MAX: z.coerce.number().int().positive().default(10),
  ML_SERVICE_URL: z.string().min(1).default("http://localhost:8001"),
  ML_SERVICE_TIMEOUT_MS: z.coerce.number().int().positive().default(2000),
  // Optional Cognee fraud-intelligence memory (see cognee_service/ and services/cognee/).
  // The backend talks ONLY to the Cognee memory service, authenticated with a service key;
  // neither that key nor any LLM/embedding key is ever sent to the browser.
  COGNEE_SERVICE_URL: z.string().url().optional(),
  COGNEE_SERVICE_API_KEY: z.string().min(1).optional(),
  // HMAC secret for customer/device pseudonyms. Rotating it re-keys every pseudonym (use a full re-sync after).
  COGNEE_PSEUDONYM_SECRET: z.string().min(16).optional(),
  COGNEE_SYNC_INTERVAL_MS: z.coerce.number().int().min(0).default(310000), // 0 = no scheduled sync
  COGNEE_SYNC_BATCH_SIZE: z.coerce.number().int().min(1).max(100).default(50),
  COGNEE_SYNC_MAX_PER_RUN: z.coerce
    .number()
    .int()
    .min(1)
    .max(5000)
    .default(500),
  COGNEE_SYNC_LOOKBACK_DAYS: z.coerce
    .number()
    .int()
    .min(1)
    .max(3650)
    .default(90),
  COGNEE_SYNC_INCLUDE_SYNTHETIC: z.enum(["true", "false"]).optional(), // default: true in dev/test, false in staging/production
  COGNEE_INCLUDE_ANALYST_NOTES: z.enum(["true", "false"]).default("true"),
  COGNEE_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1000).default(31000),
  COGNEE_INGEST_TIMEOUT_MS: z.coerce.number().int().min(1000).default(180000),
  COGNEE_MAX_RETRIES: z.coerce.number().int().min(0).max(6).default(3),
  COGNEE_RETRY_BASE_MS: z.coerce.number().int().min(0).default(500),
  // Backend -> ML service credentials (see ml_service/utils/auth.py).
  // Two separate keys: the service key lets the backend score
  // transactions and read monitoring data; the admin key is the only one
  // that can change which model is live. Required in staging/production.
  ML_SERVICE_API_KEY: z.string().min(1).optional(),
  ML_ADMIN_API_KEY: z.string().min(1).optional(),
  LOG_LEVEL: z.enum(["error", "warn", "info", "http", "debug"]).optional(),
  ADMIN_PASSWORD: z.string().min(1).optional(),
  RATE_LIMIT_AUTH_MAX: z.coerce.number().int().positive().default(10),
  RATE_LIMIT_AUTH_WINDOW_MIN: z.coerce.number().int().positive().default(15),
  RATE_LIMIT_TRANSACTIONS_MAX: z.coerce.number().int().positive().default(60),
  RATE_LIMIT_COGNEE_SYNC_MAX: z.coerce.number().int().positive().default(6), // per admin per minute
  RATE_LIMIT_COGNEE_QUERY_MAX: z.coerce.number().int().positive().default(30), // per admin per minute
  RATE_LIMIT_TRANSACTIONS_WINDOW_MIN: z.coerce
    .number()
    .int()
    .positive()
    .default(1),
  // Account lockout (see routes/auth.js, models/userRepository.js)
  LOGIN_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),
  LOGIN_LOCKOUT_MINUTES: z.coerce.number().int().positive().default(15),
  // Account & auth: email verification, password reset, MFA (see
  // routes/auth.js, services/emailService.js). FRONTEND_URL is used to
  // build the links inside verification/reset emails — must match
  // wherever the React app is actually served.
  FRONTEND_URL: z.string().min(1).default("http://localhost:3100"),
  EMAIL_VERIFICATION_EXPIRES_HOURS: z.coerce
    .number()
    .int()
    .positive()
    .default(24),
  PASSWORD_RESET_EXPIRES_MINUTES: z.coerce
    .number()
    .int()
    .positive()
    .default(30),
  MFA_CHALLENGE_EXPIRES_MINUTES: z.coerce.number().int().positive().default(5),
  // Idempotency keys on POST /transactions (see middleware/idempotency.js)
  IDEMPOTENCY_KEY_TTL_HOURS: z.coerce.number().int().positive().default(24),
  // A 'pending' idempotency reservation older than this is treated as
  // abandoned (its worker died) and may be taken over by a retry.
  IDEMPOTENCY_PENDING_STALE_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(120),
  // Real-time layer (see realtime/socketServer.js). REDIS_URL enables the
  // shared Socket.IO adapter, required when running more than one backend instance.
  REDIS_URL: z.string().min(1).optional(),
  // Model governance (services/modelGovernanceService.js, modelHealthService.js)
  MODEL_CHANGE_ALLOW_SELF_APPROVAL: z.enum(["true", "false"]).default("false"),
  // Risk-based verification (services/verificationService.js): how often due challenges are expired; 0 disables the timer
  GEO_VELOCITY_MODE: z.enum(["off", "advisory", "flag"]).default("flag"),
  VERIFICATION_SWEEP_INTERVAL_MS: z.coerce.number().int().min(0).default(31000),
  // Persistent model monitoring (services/driftMonitorService.js): evaluation cadence (0 disables the timer), alert email, retention
  MONITORING_INTERVAL_MS: z.coerce.number().int().min(0).default(3600000),
  MONITORING_EMAIL_ALERTS: z.enum(["true", "false"]).default("false"),
  INFERENCE_LOG_RETENTION_DAYS: z.coerce.number().int().min(1).default(35),
  DRIFT_SNAPSHOT_RETENTION_DAYS: z.coerce.number().int().min(1).default(365),
  // Rule lifecycle (models/ruleProposalRepository.js)
  FEEDBACK_ALLOW_SELF_VERIFY: z.enum(["true", "false"]).default("false"),
  FEEDBACK_MIN_VERIFIED_PER_CLASS: z.coerce.number().int().min(1).default(20),
  FEEDBACK_MIN_DATASET_ROWS: z.coerce.number().int().min(1).default(200),
  RULE_APPROVAL_ALLOW_SELF: z.enum(["true", "false"]).default("false"),
  RULE_CHANGES_REQUIRE_PROPOSAL: z.enum(["true", "false"]).default("false"),
  MODEL_AUTO_ROLLBACK: z.enum(["true", "false"]).default("false"),
  MODEL_HEALTH_INTERVAL_MS: z.coerce.number().int().min(0).default(60000),
  MODEL_HEALTH_WINDOW_MINUTES: z.coerce.number().int().positive().default(60),
  MODEL_HEALTH_MIN_SAMPLES: z.coerce.number().int().positive().default(50),
  MODEL_HEALTH_MAX_P95_MS: z.coerce.number().positive().default(1500),
  MODEL_HEALTH_MAX_FALLBACK_RATE: z.coerce.number().min(0).max(1).default(0.1),
  MODEL_HEALTH_MAX_PSI: z.coerce.number().positive().default(0.25),
  MODEL_HEALTH_MIN_PRECISION: z.coerce.number().min(0).max(1).default(0.25),
  MODEL_HEALTH_MIN_VERDICTS: z.coerce.number().int().positive().default(30),
  MODEL_OUTCOME_MIN_LABELLED: z.coerce.number().int().positive().default(100),
  MODEL_OUTCOME_MIN_FRAUD: z.coerce.number().int().positive().default(20),
  // Decision-audit retention (services/retentionService.js). Runs are dry-run unless RETENTION_AUTO_RUN=true.
  DECISION_RETENTION_DAYS: z.coerce.number().int().min(30).default(2555),
  AUDIT_RETENTION_DAYS: z.coerce.number().int().min(30).default(2555),
  SNAPSHOT_REDACTION_DAYS: z.coerce.number().int().min(7).default(400),
  RETENTION_AUTO_RUN: z.enum(["true", "false"]).default("false"),
  RETENTION_INTERVAL_HOURS: z.coerce.number().int().positive().default(24),
  // Alert case management (models/alertCaseRepository.js, services/alertEscalationService.js)
  ALERT_SLA_MINUTES_CRITICAL: z.coerce.number().int().positive().default(60),
  ALERT_SLA_MINUTES_HIGH: z.coerce.number().int().positive().default(240),
  ALERT_SLA_MINUTES_MEDIUM: z.coerce.number().int().positive().default(1440),
  ALERT_SLA_MINUTES_LOW: z.coerce.number().int().positive().default(4320),
  ALERT_CLAIM_TTL_MINUTES: z.coerce
    .number()
    .int()
    .positive()
    .max(240)
    .default(15),
  ALERT_ESCALATION_INTERVAL_MS: z.coerce.number().int().min(0).default(60000),
  ALERT_MAX_ESCALATION_LEVEL: z.coerce.number().int().min(1).max(5).default(3),
  RELATIONSHIP_WINDOW_DAYS: z.coerce.number().int().min(1).max(365).default(90),
  RELATIONSHIP_COMMON_MAX_ACCOUNTS: z.coerce
    .number()
    .int()
    .min(2)
    .max(100)
    .default(6),
  RELATIONSHIP_CACHE_TTL_MS: z.coerce.number().int().min(0).default(31000),
  RELATIONSHIP_BURST_WINDOW_MIN: z.coerce
    .number()
    .int()
    .min(1)
    .max(120)
    .default(10),
  RELATIONSHIP_BURST_MIN_TXNS: z.coerce.number().int().min(3).default(6),
  RELATIONSHIP_SMALL_AMOUNT: z.coerce.number().positive().default(5),
  RELATIONSHIP_SMALL_MIN_COUNT: z.coerce.number().int().min(3).default(5),
  RELATIONSHIP_SMALL_WINDOW_MIN: z.coerce
    .number()
    .int()
    .min(1)
    .max(1440)
    .default(60),
  RELATIONSHIP_HARD_OVERRIDE: z.enum(["true", "false"]).default("false"),
  EVIDENCE_MAX_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .max(10 * 1024 * 1024)
    .default(2 * 1024 * 1024),
  EVIDENCE_MAX_FILES_PER_ALERT: z.coerce.number().int().positive().default(20),
  REALTIME_RETENTION_HOURS: z.coerce.number().int().positive().default(72),
  REALTIME_HEARTBEAT_MS: z.coerce.number().int().positive().default(15000),
  REALTIME_MAX_SOCKET_BUFFER: z.coerce.number().int().positive().default(500),
  // Outbound webhooks (see services/webhookService.js)
  WEBHOOK_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),
  WEBHOOK_MAX_RETRIES: z.coerce.number().int().positive().default(3),
  // Persistent webhook retry queue (see services/webhookRetryWorker.js)
  WEBHOOK_RETRY_SWEEP_INTERVAL_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(10_000),
  // API keys: default expiration when the caller doesn't specify one
  // (see routes/apiKeys.js) — 0 means "no expiration by default."
  API_KEY_DEFAULT_EXPIRES_DAYS: z.coerce
    .number()
    .int()
    .nonnegative()
    .default(0),
  // SMTP is optional — see services/emailService.js. With none of these
  // set, emails are logged instead of sent, which is exactly right for
  // local dev (the verification/reset link shows up in the server
  // console) but must be set in staging/production (enforced below).
  SMTP_HOST: z.string().min(1).optional(),
  SMTP_PORT: z.coerce.number().int().positive().default(587),
  SMTP_SECURE: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  SMTP_FROM: z
    .string()
    .min(1)
    .default("FraudGuard <no-reply@fraudguard.local>"),
  // Comma-separated list of exact origins the API/Socket.io will accept
  // CORS/socket requests from. No wildcard — see the hardening check
  // below for why staging/production must set this explicitly.
  CORS_ALLOWED_ORIGINS: z.string().optional(),
  // Auto-seed demo data on boot if the DB has no demo users yet — for a
  // fresh deploy (Render/Railway/Docker) to show up with realistic data
  // instead of an empty dashboard. See scripts/seedDemoData.js.
  SEED_ON_BOOT: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  SEED_ON_BOOT_USERS: z.coerce.number().int().positive().default(12),
  SEED_ON_BOOT_DAYS: z.coerce.number().int().positive().default(45),
  // Demo seeding is refused in staging/production unless this explicit,
  // deliberately awkward override is set (see the hardening checks below
  // and scripts/seedDemoData.js). Seeded users get DEMO_USER_PASSWORD in
  // that case instead of the public default.
  ALLOW_DEMO_SEED_IN_PRODUCTION: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  DEMO_USER_PASSWORD: z.string().min(1).optional(),
  // Plain-language explanations (see services/explanationService.js).
  // Fully optional: with no key set, the service falls back to a
  // deterministic template-based explanation (same "degrade gracefully"
  // philosophy as ML_SERVICE_URL being unreachable falling back to the
  // rule engine — see fraudEngine.js's header comment). Never required
  // for the app to run.
  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_MODEL: z.string().min(1).default("claude-3-5-haiku-20241022"),
  LLM_TIMEOUT_MS: z.coerce.number().int().positive().default(4000),
  // Step-up auth hook (feature: step-up authentication) — how long a
  // merchant has to resolve an OTP/3DS challenge before it expires.
  STEP_UP_CHALLENGE_TTL_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(5 * 60 * 1000),
});

function fail(lines) {
  console.error("❌ Invalid environment configuration:");
  for (const line of lines) console.error(`   - ${line}`);
  process.exit(1);
}

let parsed;
try {
  // An empty `KEY=` line (as shipped in .env.example, or passed by docker-compose for unset variables) means "not set",
  // never "set to an empty value": drop empty strings for every optional text setting and for the Cognee settings.
  const rawEnv = { ...process.env };
  const isOptionalText = (k) => {
    const f = envSchema.shape?.[k];
    return f instanceof z.ZodOptional && f.unwrap() instanceof z.ZodString;
  };
  for (const k of Object.keys(rawEnv))
    if (rawEnv[k] === "" && (k.startsWith("COGNEE_") || isOptionalText(k)))
      delete rawEnv[k];
  parsed = envSchema.parse(rawEnv);
} catch (err) {
  fail(
    err.issues
      ? err.issues.map((i) => `${i.path.join(".")}: ${i.message}`)
      : [String(err)],
  );
}

const env = parsed.NODE_ENV;
const isDev = env === "development";
const isStaging = env === "staging";
const isProd = env === "production";
const isTest = env === "test";

// Hardening checks that go beyond basic type validation — only enforced
// outside development, so local/demo setup stays zero-friction.
if (isStaging || isProd) {
  const problems = [];
  if (parsed.JWT_SECRET.length < 32) {
    problems.push(
      "JWT_SECRET must be at least 32 characters in staging/production",
    );
  }
  if (!parsed.DATABASE_URL) {
    problems.push(
      "DATABASE_URL must be set in staging/production — SQLite is dev-only (see README)",
    );
  }
  if (!parsed.CORS_ALLOWED_ORIGINS || !parsed.CORS_ALLOWED_ORIGINS.trim()) {
    problems.push(
      "CORS_ALLOWED_ORIGINS must be set in staging/production — no wildcard origin outside development (see README's Security section)",
    );
  }
  if (!parsed.SMTP_HOST) {
    problems.push(
      "SMTP_HOST must be set in staging/production — without it, password-reset and verification emails are only logged to the console, never actually delivered (see services/emailService.js)",
    );
  }
  if (isProd && parsed.RULE_APPROVAL_ALLOW_SELF === "true") {
    problems.push(
      "RULE_APPROVAL_ALLOW_SELF must not be true in production — rule changes need a second person (four-eyes)",
    );
  }
  if (isProd && parsed.FEEDBACK_ALLOW_SELF_VERIFY === "true") {
    problems.push(
      "FEEDBACK_ALLOW_SELF_VERIFY must not be true in production — training labels and retraining runs need a second person (four-eyes)",
    );
  }
  if (isProd && parsed.MODEL_CHANGE_ALLOW_SELF_APPROVAL === "true") {
    problems.push(
      "MODEL_CHANGE_ALLOW_SELF_APPROVAL must not be true in production — model changes need a second person (four-eyes)",
    );
  }
  // --- ML service: authenticated, never the localhost default ---
  if (!process.env.ML_SERVICE_URL) {
    problems.push(
      "ML_SERVICE_URL must be set explicitly in staging/production (no localhost default) — and the ML service should be reachable only on a private network",
    );
  }
  const mlKey = parsed.ML_SERVICE_API_KEY || "";
  const mlAdminKey = parsed.ML_ADMIN_API_KEY || "";
  if (mlKey.length < 32)
    problems.push(
      "ML_SERVICE_API_KEY must be set (>= 32 characters) in staging/production",
    );
  if (mlAdminKey.length < 32)
    problems.push(
      "ML_ADMIN_API_KEY must be set (>= 32 characters) in staging/production",
    );
  if (mlKey && mlKey === mlAdminKey)
    problems.push("ML_SERVICE_API_KEY and ML_ADMIN_API_KEY must be different");

  // --- Cognee memory: authenticated service, dedicated pseudonym secret ---
  if (parsed.COGNEE_SERVICE_URL) {
    if ((parsed.COGNEE_SERVICE_API_KEY || "").length < 32)
      problems.push(
        "COGNEE_SERVICE_API_KEY must be set (>= 32 characters) when COGNEE_SERVICE_URL is configured in staging/production",
      );
    if (!parsed.COGNEE_PSEUDONYM_SECRET)
      problems.push(
        "COGNEE_PSEUDONYM_SECRET (>= 16 characters) must be set when COGNEE_SERVICE_URL is configured in staging/production — pseudonyms must not be keyed with JWT_SECRET",
      );
    else if (parsed.COGNEE_PSEUDONYM_SECRET === parsed.JWT_SECRET)
      problems.push("COGNEE_PSEUDONYM_SECRET must differ from JWT_SECRET");
  }

  // --- Demo data must never ride along into a real deployment ---
  if (parsed.SEED_ON_BOOT && !parsed.ALLOW_DEMO_SEED_IN_PRODUCTION) {
    problems.push(
      "SEED_ON_BOOT=true is not allowed in staging/production — it would create demo accounts with a publicly known password. Set SEED_ON_BOOT=false (or, for a throwaway demo deployment only, also set ALLOW_DEMO_SEED_IN_PRODUCTION=true)",
    );
  }
  if (parsed.SEED_ON_BOOT && parsed.ALLOW_DEMO_SEED_IN_PRODUCTION) {
    if (
      !parsed.DEMO_USER_PASSWORD ||
      parsed.DEMO_USER_PASSWORD.length < 12 ||
      parsed.DEMO_USER_PASSWORD === "demo1234"
    ) {
      problems.push(
        "DEMO_USER_PASSWORD (>= 12 characters, not the public default) is required when demo seeding is explicitly allowed outside development",
      );
    }
  }
  // A bootstrap admin with a guessable password is the same class of risk.
  if (
    parsed.ADMIN_PASSWORD &&
    (parsed.ADMIN_PASSWORD.length < 12 ||
      ["admin123", "password", "changeme"].includes(
        parsed.ADMIN_PASSWORD.toLowerCase(),
      ))
  ) {
    problems.push(
      "ADMIN_PASSWORD must be at least 12 characters and not a well-known default in staging/production",
    );
  }
  if (problems.length) fail(problems);
}

const defaultLogLevel = isProd ? "info" : isTest ? "error" : "debug";

// Dev/test get a single localhost origin for free (matches the CRA dev
// server default port) so `npm start` on both sides just works with zero
// config; staging/production must set CORS_ALLOWED_ORIGINS explicitly
// (enforced above) — there is deliberately no wildcard fallback there.
const corsAllowedOrigins = (
  parsed.CORS_ALLOWED_ORIGINS ||
  (isDev || isTest ? "http://localhost:3100" : "")
)
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

module.exports = {
  env,
  isDev,
  isStaging,
  isProd,
  isTest,
  port: parsed.PORT,
  jwtSecret: parsed.JWT_SECRET,
  jwtAccessExpiresIn: parsed.JWT_ACCESS_EXPIRES_IN,
  refreshTokenExpiresDays: parsed.REFRESH_TOKEN_EXPIRES_DAYS,
  databaseUrl: parsed.DATABASE_URL,
  dbPoolMax: parsed.DB_POOL_MAX,
  mlServiceUrl: parsed.ML_SERVICE_URL,
  mlServiceTimeoutMs: parsed.ML_SERVICE_TIMEOUT_MS,
  cognee: {
    serviceUrl: parsed.COGNEE_SERVICE_URL
      ? parsed.COGNEE_SERVICE_URL.replace(/\/+$/, "")
      : null,
    serviceApiKey: parsed.COGNEE_SERVICE_API_KEY || null,
    pseudonymSecret: parsed.COGNEE_PSEUDONYM_SECRET || parsed.JWT_SECRET,
    syncIntervalMs: parsed.COGNEE_SYNC_INTERVAL_MS,
    batchSize: parsed.COGNEE_SYNC_BATCH_SIZE,
    maxPerRun: parsed.COGNEE_SYNC_MAX_PER_RUN,
    lookbackDays: parsed.COGNEE_SYNC_LOOKBACK_DAYS,
    includeSynthetic: parsed.COGNEE_SYNC_INCLUDE_SYNTHETIC
      ? parsed.COGNEE_SYNC_INCLUDE_SYNTHETIC === "true"
      : !isProd,
    includeAnalystNotes: parsed.COGNEE_INCLUDE_ANALYST_NOTES === "true",
    requestTimeoutMs: parsed.COGNEE_REQUEST_TIMEOUT_MS,
    ingestTimeoutMs: parsed.COGNEE_INGEST_TIMEOUT_MS,
    maxRetries: parsed.COGNEE_MAX_RETRIES,
    retryBaseMs: parsed.COGNEE_RETRY_BASE_MS,
  },
  mlServiceApiKey: parsed.ML_SERVICE_API_KEY || null,
  mlAdminApiKey: parsed.ML_ADMIN_API_KEY || null,
  alertCases: {
    slaMinutes: {
      critical: parsed.ALERT_SLA_MINUTES_CRITICAL,
      high: parsed.ALERT_SLA_MINUTES_HIGH,
      medium: parsed.ALERT_SLA_MINUTES_MEDIUM,
      low: parsed.ALERT_SLA_MINUTES_LOW,
    },
    claimTtlMinutes: parsed.ALERT_CLAIM_TTL_MINUTES,
    escalationIntervalMs: parsed.ALERT_ESCALATION_INTERVAL_MS,
    maxEscalationLevel: parsed.ALERT_MAX_ESCALATION_LEVEL,
    evidenceMaxBytes: parsed.EVIDENCE_MAX_BYTES,
    evidenceMaxFiles: parsed.EVIDENCE_MAX_FILES_PER_ALERT,
  },
  relationships: {
    windowDays: parsed.RELATIONSHIP_WINDOW_DAYS,
    commonMaxAccounts: parsed.RELATIONSHIP_COMMON_MAX_ACCOUNTS,
    cacheTtlMs: parsed.RELATIONSHIP_CACHE_TTL_MS,
    burstWindowMin: parsed.RELATIONSHIP_BURST_WINDOW_MIN,
    burstMinTxns: parsed.RELATIONSHIP_BURST_MIN_TXNS,
    smallAmount: parsed.RELATIONSHIP_SMALL_AMOUNT,
    smallMinCount: parsed.RELATIONSHIP_SMALL_MIN_COUNT,
    smallWindowMin: parsed.RELATIONSHIP_SMALL_WINDOW_MIN,
    // A strong link to a confirmed-fraud account only ever ADDS risk by default; it never auto-decides.
    hardOverride: parsed.RELATIONSHIP_HARD_OVERRIDE === "true",
  },
  retention: {
    decisionDays: parsed.DECISION_RETENTION_DAYS,
    auditDays: parsed.AUDIT_RETENTION_DAYS,
    snapshotRedactionDays: parsed.SNAPSHOT_REDACTION_DAYS,
    autoRun: parsed.RETENTION_AUTO_RUN === "true",
    intervalHours: parsed.RETENTION_INTERVAL_HOURS,
  },
  monitoring: {
    intervalMs: parsed.MONITORING_INTERVAL_MS,
    emailAlerts: parsed.MONITORING_EMAIL_ALERTS === "true",
    inferenceRetentionDays: parsed.INFERENCE_LOG_RETENTION_DAYS,
    snapshotRetentionDays: parsed.DRIFT_SNAPSHOT_RETENTION_DAYS,
  },
  feedback: {
    allowSelfVerify: parsed.FEEDBACK_ALLOW_SELF_VERIFY === "true",
    minPerClass: parsed.FEEDBACK_MIN_VERIFIED_PER_CLASS,
    minRows: parsed.FEEDBACK_MIN_DATASET_ROWS,
  },
  geoVelocity: { mode: parsed.GEO_VELOCITY_MODE },
  verification: { sweepIntervalMs: parsed.VERIFICATION_SWEEP_INTERVAL_MS },
  ruleLifecycle: {
    allowSelfApproval: parsed.RULE_APPROVAL_ALLOW_SELF === "true",
    requireProposal: parsed.RULE_CHANGES_REQUIRE_PROPOSAL === "true",
  },
  modelGovernance: {
    allowSelfApproval: parsed.MODEL_CHANGE_ALLOW_SELF_APPROVAL === "true",
    autoRollback: parsed.MODEL_AUTO_ROLLBACK === "true",
    healthIntervalMs: parsed.MODEL_HEALTH_INTERVAL_MS,
    windowMinutes: parsed.MODEL_HEALTH_WINDOW_MINUTES,
    minSamples: parsed.MODEL_HEALTH_MIN_SAMPLES,
    maxP95Ms: parsed.MODEL_HEALTH_MAX_P95_MS,
    maxFallbackRate: parsed.MODEL_HEALTH_MAX_FALLBACK_RATE,
    maxPsi: parsed.MODEL_HEALTH_MAX_PSI,
    minPrecision: parsed.MODEL_HEALTH_MIN_PRECISION,
    minVerdicts: parsed.MODEL_HEALTH_MIN_VERDICTS,
    outcomeMinLabelled: parsed.MODEL_OUTCOME_MIN_LABELLED,
    outcomeMinFraud: parsed.MODEL_OUTCOME_MIN_FRAUD,
  },
  logLevel: parsed.LOG_LEVEL || defaultLogLevel,
  // No fallback outside dev/test — an unset ADMIN_PASSWORD in
  // staging/production means "don't auto-create a default admin",
  // not "use a known weak one." See config/schema.js.
  adminPassword: parsed.ADMIN_PASSWORD || (isDev || isTest ? "admin123" : null),
  rateLimit: {
    authMax: parsed.RATE_LIMIT_AUTH_MAX,
    authWindowMin: parsed.RATE_LIMIT_AUTH_WINDOW_MIN,
    transactionsMax: parsed.RATE_LIMIT_TRANSACTIONS_MAX,
    cogneeSyncMax: parsed.RATE_LIMIT_COGNEE_SYNC_MAX,
    cogneeQueryMax: parsed.RATE_LIMIT_COGNEE_QUERY_MAX,
    transactionsWindowMin: parsed.RATE_LIMIT_TRANSACTIONS_WINDOW_MIN,
  },
  loginLockout: {
    maxAttempts: parsed.LOGIN_MAX_ATTEMPTS,
    lockoutMinutes: parsed.LOGIN_LOCKOUT_MINUTES,
  },
  corsAllowedOrigins,
  seedOnBoot: parsed.SEED_ON_BOOT,
  seedOnBootUsers: parsed.SEED_ON_BOOT_USERS,
  seedOnBootDays: parsed.SEED_ON_BOOT_DAYS,
  allowDemoSeedInProduction: parsed.ALLOW_DEMO_SEED_IN_PRODUCTION,
  demoUserPassword: parsed.DEMO_USER_PASSWORD || null,
  frontendUrl: parsed.FRONTEND_URL,
  emailVerificationExpiresHours: parsed.EMAIL_VERIFICATION_EXPIRES_HOURS,
  passwordResetExpiresMinutes: parsed.PASSWORD_RESET_EXPIRES_MINUTES,
  mfaChallengeExpiresMinutes: parsed.MFA_CHALLENGE_EXPIRES_MINUTES,
  idempotencyKeyTtlHours: parsed.IDEMPOTENCY_KEY_TTL_HOURS,
  idempotencyPendingStaleMs: parsed.IDEMPOTENCY_PENDING_STALE_SECONDS * 1000,
  redisUrl: parsed.REDIS_URL,
  realtimeRetentionHours: parsed.REALTIME_RETENTION_HOURS,
  realtimeHeartbeatMs: parsed.REALTIME_HEARTBEAT_MS,
  realtimeMaxSocketBuffer: parsed.REALTIME_MAX_SOCKET_BUFFER,
  webhookTimeoutMs: parsed.WEBHOOK_TIMEOUT_MS,
  webhookMaxRetries: parsed.WEBHOOK_MAX_RETRIES,
  webhookRetrySweepIntervalMs: parsed.WEBHOOK_RETRY_SWEEP_INTERVAL_MS,
  apiKeyDefaultExpiresDays: parsed.API_KEY_DEFAULT_EXPIRES_DAYS,
  smtp: {
    host: parsed.SMTP_HOST || null,
    port: parsed.SMTP_PORT,
    secure: parsed.SMTP_SECURE,
    user: parsed.SMTP_USER || null,
    pass: parsed.SMTP_PASS || null,
    from: parsed.SMTP_FROM,
  },
  anthropicApiKey: parsed.ANTHROPIC_API_KEY || null,
  anthropicModel: parsed.ANTHROPIC_MODEL,
  llmTimeoutMs: parsed.LLM_TIMEOUT_MS,
  stepUpChallengeTtlMs: parsed.STEP_UP_CHALLENGE_TTL_MS,
};
