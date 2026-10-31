> **Reference copy.** This is the long original README (architecture, API reference, security, deployment, testing notes).
> Its "How to Run" and "Troubleshooting" sections are **out of date** - to run the app, use the short `README.md` in the repo root.

# 🛡️ FraudGuard — AI-Powered Fraud Detection System

A full-stack fraud detection web application with a React frontend and Node.js/Express backend using SQLite.

---

## 📋 Prerequisites

Make sure you have these installed before starting:

| Tool    | Version | Download                                       |
| ------- | ------- | ---------------------------------------------- |
| Node.js | 18+     | https://nodejs.org                             |
| npm     | 9+      | (comes with Node.js)                           |
| Python  | 3.10+   | https://python.org (needed for the ML service) |

Check your versions:

```bash
node --version   # should show v18.x.x or higher
npm --version    # should show 9.x.x or higher
python3 --version
```

---

## 📁 Project Structure

```
fraudguard/
├── backend/               ← Express API server
│   ├── config/
│   │   ├── database.js    ← SQLite/Postgres connection abstraction (see below)
│   │   └── schema.js      ← Dialect-specific DDL + migrations + admin seed
│   ├── models/
│   │   ├── userRepository.js       ← User data access
│   │   ├── transactionRepository.js← Transaction data access
│   │   ├── alertRepository.js      ← Alert data access
│   │   ├── refreshTokenRepository.js← Refresh token issue/rotate/revoke
│   │   ├── apiKeyRepository.js     ← API key data access
│   │   ├── webhookRepository.js    ← Webhook + delivery-log data access
│   │   ├── idempotencyRepository.js← Idempotency key storage + race-safety helper
│   │   ├── fraudEngine.js ← Hybrid engine: hard rules + ML + rule-engine fallback
│   │   ├── mlClient.js    ← Calls ML service, derives behavioral features from history
│   │   └── geo.js         ← Location coordinates + haversine (mirrors ml_service/utils/geo.py)
│   ├── services/
│   │   ├── cognee/         ← Optional Cognee memory: projector, pseudonymize, sanitize, client, syncService, queryService
│   │   ├── emailService.js  ← Verification/reset emails — SMTP or console-log in dev
│   │   ├── totpService.js   ← TOTP 2FA: secrets, QR codes, verification, backup codes
│   │   ├── apiKeyService.js ← API key generation/hashing
│   │   ├── csvService.js    ← Minimal hand-rolled CSV encoder (RFC 4180 quoting)
│   │   ├── webhookService.js← Signs + delivers outbound webhooks (first attempt + retry logic)
│   │   └── webhookRetryWorker.js← Sweeps the persistent retry queue on an interval
│   ├── schemas/            ← Zod input-validation schemas, one file per resource
│   ├── scripts/
│   │   ├── seedDemoData.js        ← Populates the DB with large-scale realistic demo data
│   │   ├── generateDemoTimeline.js← Per-user timelines + fraud scenario injection
│   │   └── demoVocabulary.js      ← Merchant/category/location vocabulary for demo data
│   ├── middleware/
│   │   ├── auth.js         ← JWT authentication
│   │   ├── apiKeyAuth.js   ← API key authentication + flexibleAuth (JWT or key)
│   │   ├── idempotency.js  ← Idempotency-Key handling for POST /transactions
│   │   ├── metrics.js      ← Prometheus registry + HTTP/business metric instrumentation
│   │   ├── validate.js     ← Zod request-validation middleware
│   │   └── errorHandler.js ← AppError class + centralized error-handling middleware
│   ├── routes/
│   │   ├── auth.js        ← Login/Register/MFA/password reset/email verification/self-service profile
│   │   ├── transactions.js← Submit & analyze transactions
│   │   ├── alerts.js      ← Fraud alerts
│   │   ├── admin.js       ← Admin panel endpoints
│   │   ├── apiKeys.js     ← Self-service API key management
│   │   └── webhooks.js    ← Self-service webhook management
│   ├── .env               ← Environment variables
│   ├── server.js          ← Main Express app
│   └── package.json
│
├── ml_service/            ← Python ML fraud-scoring microservice
│   ├── generate_dataset.py← Synthetic per-user sequential transaction generator
│   ├── train_model.py     ← Trains LR / RF / XGBoost; saves a versioned CANDIDATE + integrity manifest (never auto-promotes)
│   ├── retrain_pipeline.py← Orchestrates regenerate → train a candidate (promotion is a separate, approved workflow)
│   ├── app.py              ← FastAPI serving app (/predict with SHAP, /model/*, /health)
│   ├── utils/
│   │   ├── feature_engineering.py ← Shared train/serve feature assembly
│   │   └── geo.py          ← Location coordinates + haversine distance
│   ├── models/registry/    ← Versioned models (v1, v2, ...) + current_version.json
│   ├── reports/            ← Confusion matrices, ROC/PR curves, feature importance (per version)
│   └── README.md          ← Full methodology + IMPORTANT caveat, read this
│
├── frontend/              ← React app
│   ├── src/
│   │   ├── context/
│   │   │   └── AuthContext.js  ← Auth state + Axios setup
│   │   ├── components/
│   │   │   ├── AppLayout.js    ← Sidebar + top bar + per-page error boundary
│   │   │   └── Sidebar.js      ← Grouped navigation (admin-only items hidden for regular users)
│   │   ├── utils/
│   │   │   └── download.js     ← Shared blob/JSON download helpers (CSV + data exports)
│   │   ├── pages/
│   │   ├── CogneeMemoryPage.js   ← Admin-only AI Memory / Fraud Intelligence dashboard (components/memory/*)
│   │   │   ├── LoginPage.js       ← Login/Register/Forgot-password + inline MFA challenge step
│   │   │   ├── ResetPasswordPage.js
│   │   │   ├── VerifyEmailPage.js
│   │   │   ├── SettingsPage.js    ← Password/email/MFA + API keys + webhooks + data export/deletion
│   │   │   ├── DashboardPage.js
│   │   │   ├── NewTransactionPage.js  ← Transaction Simulator
│   │   │   ├── TransactionsPage.js    ← Searchable transaction history + CSV export
│   │   │   ├── TransactionDetailPage.js
│   │   │   ├── AlertsPage.js      ← Filters, bulk-select/resolve, CSV export
│   │   │   ├── AnalyticsPage.js
│   │   │   └── AdminPage.js       ← Users, audit trail (+ CSV export), Integrations panel
│   │   ├── App.js
│   │   ├── index.js
│   │   └── index.css
│   └── package.json
│
├── docs/                  ← Architecture/API documentation
│   ├── openapi.yaml                    ← OpenAPI 3.0 spec (see "API Docs & Postman")
│   ├── FraudGuard.postman_collection.json ← Ready-to-run Postman collection
│   └── METHODOLOGY.md                  ← Fraud-detection methodology & trade-offs write-up
│
└── README.md
```

---

## 🏗️ Architecture

High-level request flow — a client (browser or Postman) never talks to
the fraud engine or the database directly, only to the Express API:

```mermaid
flowchart LR
    subgraph Client
        FE["React Frontend\n(Dashboard, Simulator,\nAlerts, Analytics, Admin)"]
    end

    subgraph API["Node.js / Express API — backend/"]
        RT["REST Routes\n/api/v1/auth, /transactions,\n/alerts, /admin"]
        MW["Middleware\nauth (JWT) · validate (Zod)\nrate limit · audit log"]
        FEN["Fraud Engine\nfraudEngine.js\nhard rules → ML client → rule fallback"]
        WS["Socket.io Server\nsocketServer.js"]
    end

    subgraph MLSvc["ML Microservice — ml_service/ (FastAPI)"]
        ML["/predict\nmodel + SHAP explainer\nversioned registry"]
    end

    DB[("Database\nSQLite (dev) /\nPostgreSQL (prod)")]

    FE -- "HTTPS REST\nAuthorization: Bearer JWT" --> RT
    RT --> MW --> FEN
    FEN -- "Layer 2: HTTP\nscoreWithML()" --> ML
    FEN -- "reads/writes\ntransactions, alerts,\nusers, audit_logs" --> DB
    ML -. "fraud_score, risk_level,\nSHAP top_factors" .-> FEN
    FEN -. "scoring_method,\nfraud_reasons" .-> RT
    RT -- "transaction:new\nalert:new" --> WS
    WS -. "WebSocket push\n(no polling)" .-> FE

    style FE fill:#7c3aed,color:#fff
    style ML fill:#0d9488,color:#fff
    style DB fill:#1f2937,color:#fff
    style FEN fill:#b45309,color:#fff
```

**Why it's shaped this way:**

- **Frontend never scores anything itself** — it submits raw transaction
  fields and renders whatever `scoring_method`/`fraud_reasons`/
  `shap_explanation` the API returns. All fraud logic lives server-side,
  where a client can't tamper with it.
- **The fraud engine, not the ML service, is the source of truth.**
  `backend/models/fraudEngine.js` calls the ML service as one input among
  three (hard rules → ML → rule-engine fallback — see "How Fraud
  Detection Works" below) and is what actually decides the final
  `risk_level`. If `ml_service` is down, the API keeps working via the
  rule-engine fallback instead of failing the request.
- **A calibration guard backs up the model's blind spot.** The training
  data never contains a legitimate purchase more than ~6x a user's normal
  spend, so a tree model scores a 20-30x outlier from an otherwise clean
  session (known device/IP, home city) as low. `fraudEngine.js` therefore
  floors the score at **medium (40)** — never lowering a score the model
  already raised — when an amount is >= 8x the account's own median, when
  a purchase is >= 2,000 km from home at >= 4x normal spend, or (for
  accounts with < 3 transactions, which have no baseline) when the amount
  is >= $1,500. Such results carry `scoring_method: ml_model+calibration_floor`
  and the original model score in `ml_score_for_reference`.
- **Real-time is push, not poll** — the same request that persists a
  transaction also emits it over Socket.io, so the Dashboard/Alerts/Live
  Feed update instantly in every open tab (see "Real-Time Capability"
  below) instead of re-fetching on a timer.
- **The database is reached through one repository layer**
  (`backend/models/*Repository.js`) that abstracts SQLite vs. Postgres —
  see the next section — so nothing above it needs to know which one is
  running.

For the API-only view of this same flow (endpoints, auth, request/response
shapes), see `docs/openapi.yaml` and `docs/FraudGuard.postman_collection.json`
(details in "API Docs & Postman" below). For the fraud-detection
methodology itself — feature engineering, model choice, the hard-rules
override, and production trade-offs — see `docs/METHODOLOGY.md`.

---

## 🗄️ SQLite vs. PostgreSQL

The backend runs on **SQLite by default** and supports **PostgreSQL** as a
drop-in swap — same code, same routes, no rewrite needed to move from one
to the other.

**Why SQLite is the dev default, not what should run in production:**

- Single file, zero setup — `npm install && npm start` just works, nothing
  else to install or configure. Ideal for trying the project out locally.
- SQLite locks the whole database file on writes. Fine for one developer
  hitting the API from a browser tab; wrong for real concurrent traffic,
  where a fraud-scoring write on one request would block reads on every
  other request.
- No connection pooling, no replication, no built-in path to the managed
  hosting most teams actually deploy to (RDS, Cloud SQL, Render/Railway
  Postgres, etc).
- Amounts are stored as `REAL` (floating point) — fine for a demo, not
  for real financial reconciliation, where Postgres `NUMERIC` would be
  the correct production choice.

**Why Postgres for production:** row-level locking and MVCC so concurrent
writes don't block reads, connection pooling for a multi-instance
deployment, and real hosted options with backups/replicas/monitoring.

**How to switch:** set `DATABASE_URL` to a Postgres connection string —
that's it, nothing else changes:

```bash
# backend/.env
DATABASE_URL=postgresql://user:password@localhost:5432/fraudguard
```

Leave `DATABASE_URL` unset and the app runs on a local SQLite file
(`backend/fraudguard.db`) exactly as before. This works because
`backend/config/database.js` is the _only_ place that knows which
driver is in use — every route and model talks to `all()`/`get()`/
`run()`/`insert()` from that one module, never to `better-sqlite3` or
`pg` directly. Table DDL differs by dialect (`SERIAL` vs
`AUTOINCREMENT`, `TIMESTAMPTZ` vs `DATETIME`) and lives in
`backend/config/schema.js`; every actual query is written once with
`?` placeholders and auto-renumbered to Postgres's `$1, $2, ...` style
at runtime.

This was tested against a real local PostgreSQL instance during
development (register/login/transactions/admin/alerts, hard-rule fraud
blocking, RBAC) — not just written and assumed to work. One real
cross-dialect bug surfaced and got fixed in the process: Postgres
returns `COUNT()`/`SUM()` results as strings (BIGINT semantics, to
avoid JS precision loss), while SQLite returns native numbers — the
repository layer now normalizes these so callers get consistent types
either way.

---

## 🚦 Rate Limiting, 📝 Logging & 🌍 Environment Config

**Rate limiting** (`express-rate-limit`, `backend/middleware/rateLimiters.js`)
— a fraud-detection app that doesn't rate-limit its own auth and
transaction endpoints is asking to have its login form brute-forced or
its ML scoring pipeline hammered for free:

- `authLimiter` — strict, applied to `/api/auth/register` and `/login`
  (default: 10 requests / 15 min per IP) — brute-force/credential-stuffing
  protection.
- `transactionLimiter` — moderate, applied to `POST /api/transactions`
  (default: 60 / min per IP) — protects the ML scoring pipeline from
  being used as a cheap abuse vector while staying generous for real use.
- `generalLimiter` — loose, applied globally as defense in depth (300 / min).

All three are configurable via env vars (`RATE_LIMIT_*`, see
`.env.example`) without a code change. Exceeding a limit returns a 429
through the same centralized error handler as everything else. Note: the
default store is in-memory, fine for one process — running multiple
instances behind a load balancer needs a shared store (e.g.
`rate-limit-redis`) or each instance enforces its own independent limit.

**Structured logging** (Winston, `backend/config/logger.js`) replaces
`console.log`/`console.error` everywhere in the running service (the
demo seed script's own CLI progress output is the one intentional
exception — that's for a human watching the terminal, not shipped
service logs). Format depends on environment:

- **development** — colorized, human-readable single lines in the terminal.
- **staging/production** — structured JSON, one object per line, the
  shape you actually want when logs are shipped to CloudWatch/Datadog/ELK.

Every HTTP request gets one structured log line (`middleware/requestLogger.js`)
with method, path, status, duration, user id (if authenticated), and a
`requestId` — the same id is echoed in the `X-Request-Id` response header
and in any error JSON, so a user-reported error can be traced straight
to its server-side log line. Successful (2xx/3xx) requests log at the
`http` level, which sits below the default `info` level in
staging/production — so normal traffic doesn't flood production logs,
but you can see every request by setting `LOG_LEVEL=http` or `debug`.

**Environment-based config** (`backend/config/env.js`) is the _only_
place that reads `process.env` — every other module imports the parsed,
validated `config` object instead. It's validated once at startup with
Zod and **fails fast** with a clear error if something's wrong, instead
of the app limping along and breaking on the first request that needs
the missing value:

```
❌ Invalid environment configuration:
   - JWT_SECRET must be at least 32 characters in staging/production
   - DATABASE_URL must be set in staging/production — SQLite is dev-only
```

`NODE_ENV` (`development` / `staging` / `production` / `test`) drives
real behavioral differences, not just a label:

- Log level and format (above).
- Staging/production **require** `DATABASE_URL` (no SQLite) and a
  `JWT_SECRET` of at least 32 characters — the app won't start otherwise.
- The default admin account (`admin` / `admin123`) is only auto-created
  in development/test. In staging/production, an unset `ADMIN_PASSWORD`
  means **no default admin gets created at all** — a safer failure mode
  than silently shipping a known credential. Set `ADMIN_PASSWORD` and
  restart to bootstrap one.

And `.env` is no longer part of what ships in this repo/zip — it's
gitignored (`.gitignore`), and only `backend/.env.example` (documented,
no real secrets) is checked in. Copy it to `.env` for local dev;
staging/production get real values from the deploy platform's secret
manager, never a checked-in file.

---

## ✅ Input Validation & 🚦 Error Handling

**Validation** — every route that accepts a body or params is validated
with [Zod](https://zod.dev) (`backend/schemas/`, applied via
`backend/middleware/validate.js`) before the handler ever runs: wrong
types get coerced where reasonable (e.g. `"75.25"` → `75.25`), invalid
enums/formats are rejected with a field-level 400:

```json
{
  "error": "Validation failed",
  "details": [
    { "field": "email", "message": "Invalid email address" },
    { "field": "amount", "message": "Amount must be greater than 0" }
  ]
}
```

**Error handling** — routes no longer scatter `try/catch` + manual
`res.status().json()` everywhere. Instead:

- Async route handlers are wrapped in `asyncHandler` (`middleware/errorHandler.js`),
  which forwards any thrown/rejected error to Express's error pipeline
  instead of becoming an unhandled rejection (Express 4 doesn't do this
  automatically for async handlers).
- Routes throw a typed `AppError` (`AppError.notFound(...)`,
  `AppError.conflict(...)`, etc.) instead of building a response by hand.
- One centralized error middleware, registered last in `server.js`,
  turns any error — `AppError`, a Zod validation error, a conventional
  Express-ecosystem error (e.g. malformed JSON from `body-parser`, which
  sets `err.status`), or a genuine bug — into one consistent JSON shape,
  logs appropriately, and never leaks a stack trace outside development.

---

## 🔐 Production Safety

Two things are deliberately locked down because getting them wrong
affects **every** user, not just one:

### 1. The ML service is authenticated (and should be private)

Whoever can reach the model-management API can change which model makes
every fraud decision. So `ml_service/utils/auth.py` enforces two
**separate** credentials, sent only by the Node backend (the browser never
talks to the ML service):

| Credential                         | Header           | Grants                                                                                                                  |
| ---------------------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `ML_SERVICE_API_KEY` (service key) | `X-ML-Api-Key`   | `/predict`, `/metrics`, `/model/versions`, `/model/drift`, `/model/shadow/status`                                       |
| `ML_ADMIN_API_KEY` (admin key)     | `X-ML-Admin-Key` | `/model/reload`, `/model/activate`, `/model/rollback`, `/model/drift/reset`, `/model/shadow/set`, `/model/shadow/clear` |

- The service key **cannot** promote/roll back/reload models, and the admin
  key is not a scoring key (tests prove both, plus that anonymous callers
  get `401` and wrong keys `403` on every protected route).
- **Fails closed:** a missing key returns `503`, never "open". Local dev can
  opt out explicitly with `ML_AUTH_DISABLED=true`.
- **Refuses to boot unsafely:** with `ML_ENV=production|staging` the ML
  service exits at startup unless both keys are set (>= 32 chars,
  different) and `ML_AUTH_DISABLED` is off; it also hides `/docs`.
  The backend likewise requires the keys and an explicit `ML_SERVICE_URL`.
- Only `/health` is open (liveness probe) and it returns just `status`.
- **Network restriction is separate from the keys:** run the ML service on
  a private network (`render.yaml` uses a private service; `docker-compose.yml`
  doesn't publish its port). Don't rely on keys alone.
- Rotate keys by changing both services' env and restarting.

Tests: `cd ml_service && pip install -r requirements-dev.txt && python -m pytest tests -q`
and `backend/tests/unit/mlCredentials.test.js`.

### 2. Demo data is kept out of real deployments

Seeded demo accounts share a **publicly known password**, so:

- `SEED_ON_BOOT=true` is **rejected at startup** when `NODE_ENV` is
  `staging`/`production` (`render.yaml` no longer sets it). The seeder
  itself also refuses to run there (`npm run seed` can't be aimed at a real
  DB by accident). A throwaway demo deployment must opt in explicitly with
  `ALLOW_DEMO_SEED_IN_PRODUCTION=true` **and** a strong `DEMO_USER_PASSWORD`.
  Keep demo and production in separate environments.
- Demo accounts live on the reserved domain `@demo.fraudguard.io`; real
  sign-ups (and email changes) on that domain are rejected, the admin user
  list shows a **Demo** badge (`is_demo`), and `npm run seed:reset` removes
  only those accounts.
- Seeding is idempotent: restarts never add demo records (tested).
- A weak `ADMIN_PASSWORD` (< 12 chars or a well-known default) is rejected in
  production.

Tests: `backend/tests/unit/productionSafety.test.js`,
`backend/tests/integration/demoData.test.js`.

### 3. Database persistence & backups (verify before real users)

The code can't verify this for you: use a managed Postgres plan that is not
time-limited, confirm automated backups/point-in-time recovery are enabled,
and do a **test restore**. SQLite (the dev default) lives on a single
volume with no backups — never use it in production (the backend already
requires `DATABASE_URL` there). Render's `free` Postgres is evaluation-only.

---

## 🚀 How to Run (Step by Step)

### Step 0 — Start the ML service (optional but recommended)

```bash
cd ml_service
pip install -r requirements.txt
python3 generate_dataset.py
python3 train_model.py
# The ML service FAILS CLOSED: it needs credentials (see "Production
# Safety" below). For local development, pick one:
#   (a) no keys, explicit opt-out:   ML_AUTH_DISABLED=true uvicorn app:app --port 8001
#   (b) keys, like production:       set ML_SERVICE_API_KEY and ML_ADMIN_API_KEY
#       (same values in backend/.env) and run: uvicorn app:app --port 8001
ML_AUTH_DISABLED=true uvicorn app:app --host 127.0.0.1 --port 8001
```

> Keep this terminal open too. If you skip this step, the app still
> works — it automatically falls back to the rule engine (see
> `scoring_method` in each response).

### Step 1 — Install backend dependencies

Open a terminal, navigate to the project folder, then:

```bash
cd backend
npm install
```

### Step 2 — Start the backend server

```bash
# Still inside the backend/ folder:
npm start
```

You should see:

```
✅ Admin user created: admin / admin123
🛡️  FraudGuard Backend running on http://localhost:5000
📊 API: http://localhost:5000/api/health
```

> ✅ Keep this terminal open. The backend must stay running.

---

### Step 2.5 — Seed realistic demo data (optional but recommended)

The app starts with an empty database — nothing to look at on the
dashboard until you manually add transactions one at a time. Instead,
seed it with a large volume of realistic transaction history across
several demo users, generated the same way `ml_service`'s training data
is: per-user timelines with injected fraud patterns (card testing,
geo-hopping, velocity bursts, account takeover), each scored through the
**real** hybrid engine (hard rules + ML + SHAP) as it's inserted — not
separately faked numbers.

```bash
# Still inside the backend/ folder (in a new terminal, or after Step 2):
npm run seed
```

This creates ~12 demo users (password `demo1234`) with ~60 days of
history each. Options:

```bash
npm run seed -- --users=20 --days=90   # more users / longer history
npm run seed:reset                      # wipe previous demo data first
```

Log in as `admin` / `admin123` to see everything across all users, or as
any seeded user (e.g. check the console output for a generated username)
to see one person's view.

---

### Step 3 — Install frontend dependencies

Open a **second terminal**, navigate to the project folder, then:

```bash
cd frontend
npm install
```

> ⚠️ This takes 2–5 minutes the first time. That's normal.

### Step 4 — Start the frontend

```bash
# Still inside the frontend/ folder:
npm start
```

Your browser should automatically open at **http://localhost:3100**

---

## 🔐 Login Credentials

### Admin Account (pre-created automatically)

- **Username:** `admin`
- **Password:** `admin123`

  Bootstrapped directly by `config/schema.js` on first startup, not
  through the registration endpoint — it's exempt from the password
  strength rules below (see "Security" section) so this documented
  convenience credential keeps working. Change `ADMIN_PASSWORD` before
  deploying anywhere real.

### Create New Accounts

Click **Register** on the login page to create a regular user account.
Passwords must be at least 8 characters with an uppercase letter, a
lowercase letter, a number, and a symbol — see "Security" below.

---

## 🧪 How to Test the App

### Test a Safe Transaction

1. Log in → click **Transaction Simulator**
2. Fill in:
   - Amount: `50`
   - Merchant: `Starbucks`
   - Category: `food`
   - Location: `New York, US`
   - Card Type: `credit`
3. Click **Run Through Fraud Engine**
4. ✅ You'll see: "Transaction looks safe." with a low fraud score

### Test a Fraud Transaction

1. Go to **Transaction Simulator**
2. Fill in:
   - Amount: `3500`
   - Merchant: `CryptoExchange Pro`
   - Category: `crypto`
   - Location: `Unknown`
   - Card Type: `prepaid`
3. Click **Run Through Fraud Engine**
4. 🚨 You'll see: "Fraud detected!" with a high fraud score, a SHAP
   feature-contribution chart, and reasons listed

### Use a scenario preset

Click any card in the **Scenario Library** (e.g. "Prepaid Card Burst")
to auto-populate a realistic named pattern, or **Fuzz random fields**
for a fully random one.

### Test the account/auth flows

No real email provider is required for any of this locally — with no
`SMTP_HOST` configured, every verification/reset email is logged to the
backend's console instead of sent, so you can copy the link straight
out of the terminal:

- **Forgot password:** Login page → "Forgot password?" → enter an
  email → check the backend console for the logged reset link.
- **Email verification:** happens automatically on registration (check
  the console for the link); a banner on **Account Settings** also
  offers to resend it if unverified.
- **2FA:** log in → **Account Settings** (the icon next to your
  username) → "Set Up 2FA" → scan the QR code with any authenticator
  app (Google Authenticator, Authy, 1Password, etc.) → enter the
  6-digit code to confirm. Save the backup codes shown once. Log out
  and back in to see the new 2FA challenge step.
- **Bulk-resolve alerts:** on the **Alerts** page, check a few open
  alerts (or "Select all on this page"), add an optional note, and
  click **Confirm Fraud** or **Mark False Positive** in the bar that
  appears — all selected alerts resolve in one request.
- **CSV export:** **Transactions**, **Alerts**, and (admin) the
  **Admin** page's Audit Trail each have an **Export CSV** button that
  respects whatever filters are currently active.
- **Data export & account deletion:** **Account Settings** → "Export My
  Data (JSON)" downloads everything the app holds about your account;
  the "Danger Zone" below it deletes (anonymizes) it.
- **API keys & webhooks:** **Account Settings** → create an API key or
  webhook (each secret is shown once). Try
  `curl -H "X-API-Key: <key>" http://localhost:5000/api/v1/transactions`
  to call the API without logging in. Admins additionally see every
  user's keys/webhooks on the **Admin** page's Integrations panel.
- **Metrics:** `curl http://localhost:5000/metrics` — Prometheus text
  format, no auth required.

---

## ✅ Automated Testing & CI

Everything below is automated (Jest/Supertest/React Testing Library) —
distinct from the manual click-through above.

### Backend (`backend/`)

```bash
cd backend
npm install
npm test              # unit + integration
npm run test:unit     # just backend/tests/unit/
npm run test:integration  # just backend/tests/integration/
npm run test:coverage # with a coverage report (backend/coverage/)
npm run lint
```

- **`tests/unit/fraudEngine.test.js`** — the single most important thing
  in this app to test. Covers `checkHardRules` (blacklists, the absolute
  amount cap, the dynamic device/IP blacklist), `analyzeTransaction` (the
  rule-engine scorer — every amount band, high-risk merchant/category/
  location, velocity windows, score capping at 100, risk-level
  thresholds), and `analyzeTransactionHybrid` (hard-rule overrides beat
  the ML score no matter what; the ML-available path; the ML-unavailable
  rule-engine fallback; reason deduplication). `models/mlClient.js` is
  mocked, so these tests never make a network call and never depend on
  `ml_service` actually running.
- **`tests/integration/*.test.js`** — Supertest against the real Express
  app (`backend/app.js`, the same app `server.js` runs — just without the
  `http.listen`/Socket.io bootstrap, so tests can drive it directly)
  wired to a real SQLite database: `auth.test.js` (password strength,
  account lockout, refresh-token rotation and reuse detection, logout),
  `transactions.test.js` (scoring, pagination, the `/api` ↔ `/api/v1`
  alias), `alerts.test.js` (ownership checks, view/resolve, the audit
  trail those actions leave behind), `admin.test.js` (RBAC enforcement +
  its audit log, role changes + the session revocation they trigger).
- Each test file gets its own private in-memory SQLite database
  (`SQLITE_PATH=':memory:'`, set in `tests/setup/testEnv.js`) — nothing
  persists between runs, and test files never see each other's data.

### Frontend (`frontend/`)

```bash
cd frontend
npm install
npm test        # interactive watch mode
npm run test:ci # single run, CI mode
npm run lint
```

- **`components/AppLayout.test.js`** — sidebar groups and role-based visibility (admin-only links
  hidden for regular users), open-alert badge, mobile drawer, sign-out, crash containment.
- **`pages/DashboardPage.test.js`** — totals, queue health, 14-day volume buckets, detection-layer
  breakdown, paging cap, empty state, pushed updates.
- **`pages/LoginPage.test.js`** — login/register mode toggling, form
  submission, and error display (including joining every failed
  password-strength rule from the backend into one readable message).
- **`pages/AlertsPage.test.js`** — loading/empty states, resolving an
  alert, pagination controls, and error handling — with the API client
  and socket connection mocked, so these never hit a real backend.

### More than unit tests

Failure-injection, E2E (in-process and full-stack with the real ML service), concurrency/large-history performance tests, coverage thresholds, and the CI pipeline are described in [docs/TESTING.md](docs/TESTING.md). Quick commands (from `backend/`): `npm run test:coverage`, `npm run test:perf`, `npm run test:e2e:fullstack`, `npm run test:postgres`.

### CI (`.github/workflows/ci.yml`)

Jobs: backend (lint, tests, coverage thresholds), backend on PostgreSQL, ML service, frontend (lint, tests, production build), full-stack E2E, performance budgets, and a final `ready-to-deploy` gate. Results and coverage are published to each run's summary and as artifacts. The workflow has not yet run on real GitHub runners.

Model performance against confirmed outcomes, multi-alert cases, and relationship/fraud-ring analysis: [docs/OUTCOMES_CASES_RELATIONSHIPS.md](docs/OUTCOMES_CASES_RELATIONSHIPS.md).

Investigation workflow (assignment leases, SLAs/escalation, evidence, outcomes): [docs/CASE_MANAGEMENT.md](docs/CASE_MANAGEMENT.md).

---

## 📊 Features

| Feature                              | Description                                                                                                                                                                                                                                                                             |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Dashboard**                        | Live stats (totals, fraud rate), queue health (open alerts, overdue past SLA for admins, avg score, model p95 latency), 14-day volume chart, "which detection layer decided" breakdown, recent transactions                                                                             |
| **Try demo**                         | One click on the sign-in/register screen opens a self-contained demo (`/demo/`) with pre-loaded sample data - see below                                                                                                                                                                 |
| **Transaction Simulator**            | Submit transactions manually or via realistic named scenarios; instant fraud analysis with a SHAP feature-contribution chart                                                                                                                                                            |
| **Bulk Transaction Import**          | Paste or upload a CSV of up to 50 transactions and score them all in one request, with client-side validation and a per-row results view                                                                                                                                                |
| **Transactions**                     | Full searchable/filterable transaction history (merchant, category, risk level, amount range, date range) with a permalink detail page per transaction                                                                                                                                  |
| **Fraud Alerts**                     | View, filter, bulk-resolve, assign, and resolve high/medium risk alerts with a `confirmed_fraud`/`false_positive` verdict and note — not just a boolean toggle. Each alert also has a one-click plain-language (LLM-generated, cached) explanation and, for admins, its own audit trail |
| **In-App Notifications**             | A notification bell in the navbar shows recent alerts with a live-updating unseen badge, fed by the same WebSocket stream the Alerts page uses — click to view, "seen" state is per-account                                                                                             |
| **Disputes (Case Management)**       | Open a chargeback/dispute directly or from a transaction's detail page; admins track it through `opened → evidence_submitted → won/lost`, with a financial-summary rollup and CSV export                                                                                                |
| **Step-Up Authentication**           | A medium-risk transaction can be held pending an external OTP/3DS-style verification (opt in per webhook) instead of completing immediately — the Simulator can walk through the whole hold/resolve loop                                                                                |
| **Admin Rule Builder & Fraud Rings** | Admin-editable blacklists (merchant/location/device/IP) and an amount cap, evaluated ahead of the ML model, with a dry-run impact preview before you turn one on; plus detection of account clusters sharing a device fingerprint or IP                                                 |
| **SAR-Style Compliance Reports**     | Export a PDF or CSV bundling an alert's transaction, reasoning, network/dispute status, and audit trail — an internal review document, not a completed regulatory filing                                                                                                                |
| **ML Model Ops**                     | Admin view of the trained-model registry, feature/score drift monitoring against a live-traffic baseline, and shadow/canary deployment to compare a new model version on real traffic before promoting it                                                                               |
| **Analytics**                        | Bar charts and pie charts of transaction volume, risk distribution, and category breakdown                                                                                                                                                                                              |
| **Admin Panel**                      | View all users, their stats, promote/demote user roles, and an Integrations panel for every user's API keys/webhooks                                                                                                                                                                    |
| **Account Settings**                 | Self-service password/email change, email verification, TOTP two-factor authentication with backup codes, self-service API key/webhook management (with per-event subscriptions), and a data export/account deletion "Danger Zone"                                                      |
| **Real-Time Alerts**                 | Dashboard, Alerts, the notification bell, and the Live Feed all update instantly over WebSocket — no polling                                                                                                                                                                            |
| **Live Transaction Feed**            | Admin-controlled simulation streams synthetic transactions through the real fraud engine so you can watch detection happen live                                                                                                                                                         |
| **API Keys & Webhooks**              | Service-to-service auth (`X-API-Key`, with optional expiration and per-key rate limiting) for integrating without a human session, plus signed outbound webhooks — fired on medium/high-risk transactions and step-up events, with retries that survive a server restart                |
| **CSV Export**                       | Transactions, Alerts, Disputes, and (admin) the Audit Trail can all be exported as CSV, respecting whatever filters are active                                                                                                                                                          |
| **Data Export & Deletion**           | Self-service "download everything this app holds about you" (JSON) and account deletion — anonymized, not hard-deleted, so fraud history survives account closure                                                                                                                       |
| **Observability**                    | `GET /metrics` — Prometheus-format process and business metrics (requests, transactions scored, alerts created, webhook deliveries) — see "Observability" below                                                                                                                         |
| **Security**                         | Password strength rules, account lockout, rotating refresh tokens, forgot/reset password, email verification, TOTP 2FA, RBAC, idempotent transaction submission, and a full audit trail — see "Security" below                                                                          |
| **Docker & Deployment**              | Dockerfile per service + docker-compose for one-command local setup; Render/Vercel/Netlify configs included — see "Deployment" below                                                                                                                                                    |

---

## 🔴 Real-Time Capability

FraudGuard pushes fraud events over a WebSocket connection (Socket.io)
instead of making the frontend poll a REST endpoint on a timer — the
same way a real fraud system surfaces a flag the moment it's scored,
not whenever the next poll happens to land.

**Delivery is "push + recoverable"** (details in the header of
`backend/realtime/socketServer.js`):

- **Persistent event ids.** Every real event is written to
  `realtime_events` in the _same database transaction_ as the change it
  describes (an event exists iff the change committed) and is pushed with
  that row's id.
- **Reconnection recovery.** The client remembers the highest id seen. On
  reconnect, and whenever the server's periodic `events:head` heartbeat is
  ahead of it, it calls `GET /api/events?after=<id>` (cursor-paginated,
  `limit` ≤ 500) and replays what it missed in order, skipping ids it already
  received live. If the retained log no longer reaches back far enough
  (`gap: true`) pages reload their data instead of trusting a partial replay.
- **Backpressure.** A socket whose outgoing buffer exceeds
  `REALTIME_MAX_SOCKET_BUFFER` is disconnected rather than growing server
  memory; the client reconnects and pages through the missed events.
- **Filtering.** Clients `subscribe` to topics (`transaction`, `alert`,
  `simulation`) and a minimum risk tier (`all|medium|high`).
- **Multiple instances.** Set `REDIS_URL` to enable the Socket.IO Redis
  adapter so room emits reach sockets on every instance. Without it rooms
  are per-process and only a single backend instance is correct (a startup
  error is logged if Redis is configured but unreachable).
- **Authorisation** is derived from the authenticated identity: a user only
  joins their own rooms, admins also see every user's events; the replay
  endpoint enforces the same rule in SQL.
- **Synthetic events are never confused with real ones.** Simulator events
  go only to the `simulation-feed` room, carry `source: 'simulation'`,
  `synthetic: true`, `id: null`, are never stored or replayed, and the
  simulator's database rows are `is_synthetic = 1` and attributed to demo
  users only. The Live Feed page labels every row "Simulated".

| Event                        | Payload                                                          | When                                       |
| ---------------------------- | ---------------------------------------------------------------- | ------------------------------------------ |
| `transaction:new`            | `{ id, type, transaction, analysis?, source:'live' }`            | a real transaction is scored               |
| `alert:new`                  | `{ id, type, alert, source:'live' }`                             | a transaction scores medium/high risk      |
| `simulation:transaction`     | `{ transaction, analysis, stats, source:'simulation', id:null }` | the Live Feed simulation generates one     |
| `simulation:status`          | `{ running, ... }`                                               | the simulation starts/stops                |
| `sync:hello` / `events:head` | `{ head, oldest_available }`                                     | on connect / heartbeat, for loss detection |
| `events:lagged`              | `{ reason }`                                                     | the server is dropping a slow consumer     |

Run the real-time and concurrency suites against a real PostgreSQL and a
real Redis with `npm run test:postgres` (needs PostgreSQL binaries).

### Concurrency and data integrity

- `UNIQUE (user_id, idempotency_key)` is enforced by the database; a
  duplicate in flight gets the original response (or `409` while pending) and
  stale pending keys are taken over with compare-and-set.
- Transaction, fraud decision, alert, step-up challenge, idempotency
  completion and realtime events commit **in one database transaction**
  (`services/transactionPipeline.js`); events, webhooks and metrics are
  published only after commit. A unique index allows one alert per
  transaction.
- Alerts, disputes and model-change requests use **optimistic locking**:
  send the `version` you loaded (body or `If-Match`); a stale write gets
  `409 VERSION_CONFLICT` with the current state, which the UI shows.
- These are exercised with genuinely concurrent HTTP requests in
  `backend/tests/concurrency/` on SQLite and PostgreSQL.

### Live Transaction Feed simulation

The **Live Feed** page (`/live-feed`) shows synthetic transactions
streaming through the _real_ fraud engine — same hybrid hard-rules/ML/
rule-engine pipeline as a real submission, just with generated input
data. Admins can start/stop it and tune two parameters:

| Endpoint                           | Auth  | Body                           | Description                                                                                            |
| ---------------------------------- | ----- | ------------------------------ | ------------------------------------------------------------------------------------------------------ |
| `POST /api/admin/simulation/start` | Admin | `{ intervalMs?, fraudRatio? }` | Start generating transactions. `intervalMs`: 500–15000 (default 2500). `fraudRatio`: 0–1 (default 0.2) |
| `POST /api/admin/simulation/stop`  | Admin | —                              | Stop the simulation                                                                                    |
| `GET /api/admin/simulation/status` | Admin | —                              | Current run state + counters                                                                           |

Every simulated transaction is attributed to a real (non-admin) demo
user account, persisted exactly like a live submission, and broadcast
to the `simulation-feed` room — so any logged-in user can watch it,
while only admins can control it.

---

## 🔍 How Fraud Detection Works

FraudGuard uses a genuine **hybrid engine** — the way Stripe Radar / PayPal
actually do it — not just an ML model with a fallback. See
`ml_service/README.md` for full details.

1. **Hard rules (can override the ML score)** — `backend/models/fraudEngine.js`
   → `checkHardRules()`: a static blacklist of known-bad merchants/locations,
   an absolute $10,000 amount cap that always forces manual review, and a
   **dynamic blacklist** — any device fingerprint or IP address seen on a
   previously confirmed-fraud transaction (from any user) is automatically
   hard-flagged. If any of these fire, the transaction is forced to
   `risk_level: "high"` regardless of what the model says.
2. **ML model (primary probabilistic score)** — `ml_service/` trains and
   compares Logistic Regression, Random Forest, and XGBoost, handling
   class imbalance via SMOTE + class weights, and promotes the best model
   by validation PR-AUC into a **versioned registry** (`models/registry/vN/`; candidates only, see [docs/MODEL_GOVERNANCE.md](docs/MODEL_GOVERNANCE.md)). Every
   prediction comes with a real **SHAP explanation** (not a heuristic
   approximation) showing which features pushed the score up or down.
   Features include transaction velocity, time-since-last-transaction,
   spending-pattern deviation (z-score), geo-distance between consecutive
   transactions (haversine), and device/IP fingerprinting — all derived
   from the user's actual transaction history server-side.
3. **Rule engine (fallback only)** — the original threshold scorer. Used
   only if the ML service is unreachable, so the app degrades gracefully
   instead of breaking.

**Score → Risk Level.** The ML score is a **calibrated probability of fraud ×
100** (a score of 80 ≈ 80 in 100 similar validation transactions were fraud).
Risk levels are a separate, admin-configurable **risk policy** applied by the
backend (Admin → Risk Policy; default review ≥ 10, fraud ≥ 50; versioned,
audited, with a threshold simulator and a calibration monitor). The model
probability, the policy decision and the confirmed analyst outcome are stored
separately. The rule-engine fallback keeps fixed 40/70 rule-point bands.
See **[`docs/MODEL_VALIDATION.md`](docs/MODEL_VALIDATION.md)**.

Each transaction response includes `scoring_method` (`"ml_model"`,
`"hard_rule_override"`, `"hard_rule_override+ml"`, or
`"rule_engine_fallback"`) plus `shap_explanation` so you can see exactly
which layer decided and why.

**Retraining pipeline:** `ml_service/retrain_pipeline.py` regenerates
data and trains + evaluates all 3 models, saving a **candidate**.
Nothing is promoted automatically: promotion and rollback are requests that
pass automated gates and need a different admin's approval — see
[docs/MODEL_GOVERNANCE.md](docs/MODEL_GOVERNANCE.md).

> ⚠️ The ML model is trained on a **synthetic** dataset. Its accuracy figures
> are synthetic-data results and are labelled as such. The evaluation protocol
> (chronological split, user holdout, validation-fitted calibration) is also run
> on the public ULB credit-card dataset, where PR-AUC is ≈ 0.75–0.78. A
> simulated shift in fraud pattern drops synthetic PR-AUC to near random. Read
> [`docs/MODEL_VALIDATION.md`](docs/MODEL_VALIDATION.md) before quoting any number.

> 📄 For the full narrative — why hybrid over pure ML, the precision/
> recall trade-offs behind the risk thresholds, and the feature-leakage
> bug this project actually found and fixed — see
> **[`docs/METHODOLOGY.md`](docs/METHODOLOGY.md)**. That's the doc
> written for "walk me through how this works" in an interview; this
> README section is the summary.

---

## 📚 API Docs & Postman

Two machine-readable artifacts, both under `docs/` and kept in sync with
the actual route/schema code (not hand-typed separately from it):

- **`docs/openapi.yaml`** — OpenAPI 3.0 spec for every route in the
  "API Endpoints" table above: request/response schemas (matching
  `backend/schemas/*.js`), auth requirements, status codes, and the
  exact enum values the API accepts (categories, locations, card types).
  Import it into [Swagger UI](https://editor.swagger.io/),
  [Redoc](https://redocly.github.io/redoc/), or Postman/Insomnia's
  "Import → OpenAPI" to browse it or generate a client from it.
- **`docs/FraudGuard.postman_collection.json`** — a ready-to-run Postman
  collection generated from that same spec (`openapi-to-postmanv2`), then
  hand-tuned so it actually works out of the box instead of needing
  tokens pasted in manually:
  - **Login is pre-filled** with the seeded `admin`/`admin123` demo
    credentials.
  - Running **Login**, **Register**, or **Refresh** auto-captures the
    returned `accessToken`/`refreshToken` into collection variables
    (`bearerToken`, `refreshToken`) via a test script — every other
    request already references `{{bearerToken}}` through collection-level
    Bearer auth, so nothing needs to be copy-pasted between requests.
    **Logout** clears both back out.
  - **Submit a transaction** ships with an example body (crypto category,
    prepaid card, unknown location) tuned to actually trip risk factors,
    so the first request you run returns a non-trivial `fraud_score` and
    `shap_explanation` instead of a boring "looks safe."

  Import: Postman → **Import** → select the file → set the `baseUrl`
  collection variable if your backend isn't on the default
  `http://localhost:5000/api/v1`.

---

## 🔒 Security

### Passwords & account lockout

New passwords (`POST /api/auth/register`) must be at least 8 characters
and include an uppercase letter, a lowercase letter, a number, and a
symbol — enforced by `schemas/authSchemas.js`, with every failing rule
reported at once (not just the first).

Login attempts are tracked per account (`users.failed_login_attempts`).
After `LOGIN_MAX_ATTEMPTS` (default 5) consecutive failures, the account
is locked for `LOGIN_LOCKOUT_MINUTES` (default 15) — `POST /api/auth/login`
returns `423 Locked` for both correct and incorrect passwords while
locked, so a locked-out attacker learns nothing new. A successful login
resets the counter.

### Access + refresh tokens

`POST /api/auth/login` (and `/register`, `/refresh`) return two tokens
instead of one long-lived JWT:

- **Access token** — a JWT, short-lived (`JWT_ACCESS_EXPIRES_IN`, default
  `15m`). Sent as `Authorization: Bearer <token>` on every request;
  `middleware/auth.js` verifies it exactly like before.
- **Refresh token** — a long-lived (`REFRESH_TOKEN_EXPIRES_DAYS`, default
  30 days), high-entropy random value. Only its SHA-256 hash is ever
  stored (`refresh_tokens` table) — the same reasoning as bcrypt for
  passwords. Used only to call `POST /api/auth/refresh` for a new pair.

Refresh tokens **rotate** on every use: each `/refresh` call revokes the
presented token and issues a new one, linked via `replaced_by_id`. If an
already-revoked (i.e. already-rotated-out) token is ever presented again,
that's a signal it may have been stolen and replayed — the server
responds by revoking _every_ active refresh token for that account, not
just the reused one. `POST /api/auth/logout` revokes a refresh token
server-side, so logging out actually ends the session rather than just
clearing local storage. The frontend (`context/AuthContext.js`) handles
all of this transparently: a `401` on an expired access token triggers
one silent refresh-and-retry; only an invalid/expired _refresh_ token
logs the user out.

### RBAC, audit-logged

Routes are gated with `middleware/auth.js`'s `requireRole(...roles)`
(`adminMiddleware` is just `requireRole('admin')`). Every access-denied
decision is written to the audit trail (`rbac.access_denied`, see
below) with the path, method, required role(s), and the actual role —
successful/permitted requests aren't separately logged here, since
`middleware/requestLogger.js`'s structured access log already covers
those at the same granularity as every other request.

A role change (`PATCH /api/admin/users/:id/role`) revokes every active
refresh token for the affected account, so a demoted admin can't keep
elevated access via a session opened before the demotion.

### Email verification

`POST /api/auth/register` sends a verification email
(`services/emailService.js`) with a random, high-entropy token — only
its SHA-256 hash is stored (`users.email_verification_token_hash`),
same reasoning as refresh tokens. **Verification is not required to use
the app** — an unverified account can log in and do everything a
verified one can; this is a deliberate choice (many real products work
the same way) rather than an oversight, so it doesn't need documenting
as a gap. `POST /api/auth/verify-email` (public — the token itself is
the credential) completes it; `POST /api/auth/resend-verification`
(authenticated) sends a fresh one if the link expired
(`EMAIL_VERIFICATION_EXPIRES_HOURS`, default 24h).

### Forgot / reset password

`POST /api/auth/forgot-password` always returns the same generic
message regardless of whether the email exists, so it can't be used to
enumerate accounts — but only sends an email
(`PASSWORD_RESET_EXPIRES_MINUTES`, default 30m) when it does.
`POST /api/auth/reset-password` completes it and, like a self-service
password change below, revokes every refresh token for the account —
resetting a password is (by definition) regaining control of an
account, so every other session, including a possible attacker's,
should have to re-authenticate.

### Self-service profile management

A logged-in user can change their own credentials without needing an
admin: `PATCH /api/auth/password` and `PATCH /api/auth/email` both
require the _current_ password to confirm (an active session/access
token alone isn't enough — the same reasoning as disabling MFA below).
Changing your password revokes every other refresh token and
re-issues a fresh pair for the current session (so you aren't logged
out by your own change); changing your email resets
`email_verified` back to `0` and sends a new verification email to the
new address.

### MFA / Two-Factor Authentication (TOTP)

Standard RFC 6238 TOTP (`services/totpService.js`, via
[otplib](https://github.com/yeojz/otplib)) — compatible with Google
Authenticator, Authy, 1Password, etc. Setup is a three-step,
enrollment-then-confirm flow so a typo'd/unscanned secret can never
lock an account out of its own login:

1. `POST /api/auth/mfa/setup` generates a secret (stored as _pending_,
   not yet required at login) and returns it plus a QR code
   (`otpauthUrl` + a base64 PNG data URL) for the frontend to render.
2. `POST /api/auth/mfa/enable` requires one valid 6-digit code from the
   app to actually turn 2FA on — proving the secret was scanned/entered
   correctly — and returns 8 single-use backup codes in plaintext
   **exactly once** (only bcrypt hashes are ever persisted, same as
   passwords). Enabling revokes every refresh token for the account
   (forcing every other session to re-authenticate with MFA now
   required) and immediately re-issues a fresh pair for _this_ session.
3. `POST /api/auth/mfa/disable` requires the current password.

With 2FA enabled, `POST /api/auth/login` no longer returns tokens
directly after a correct password — it returns `{ mfaRequired: true,
mfaToken }`, a short-lived (`MFA_CHALLENGE_EXPIRES_MINUTES`, default
5m) JWT with a distinct `type: 'mfa_challenge'` that `middleware/auth.js`
explicitly rejects if presented as a real access token (so it can never
be mistaken for a session credential even though it's signed with the
same secret). `POST /api/auth/login/mfa` completes login with either a
TOTP code or a backup code (single-use — consumed on success).

### Audit trail

The `audit_logs` table (`models/auditLogRepository.js`) records who did
what, to what, when, and with what outcome — `auth.login` (success/
failure/locked, with a reason), `auth.login_password_verified`
(the MFA-pending intermediate step), `auth.register`, `auth.refresh`,
`auth.refresh_reuse_detected`, `auth.logout`,
`auth.password_reset_requested`, `auth.password_reset`,
`auth.password_changed`, `auth.email_changed`, `auth.email_verified`,
`auth.email_verification_resent`, `auth.mfa_setup_started`,
`auth.mfa_enabled`, `auth.mfa_disabled`, `auth.data_exported`,
`auth.account_deleted`, `admin.role_change`, `admin.audit_logs_export`,
`rbac.access_denied`, `alerts.view`, `alerts.resolve`,
`alerts.bulk_resolve`, `alerts.assign`, `alerts.export`,
`transactions.export`, `transactions.create_via_api_key`,
`api_key.created`, `api_key.revoked`, `webhook.created`,
`webhook.updated`, and `webhook.deleted`. Writes go through
`middleware/auditLog.js`, which never lets a logging failure break the
request it's documenting.

Admins can browse it via `GET /api/admin/audit-logs` (filterable by
`action`, `targetType`, `targetId`, `userId`, paginated) — also visible
as an "Audit Trail" table on the Admin page — or pull the full
view/resolve history for one specific alert via
`GET /api/admin/audit-logs/alert/:id`, which is the direct answer to
"who viewed/resolved this alert, and when."

### Integration surface: API keys, webhooks, idempotency

Everything above this point assumes a human with a password. A real
integration — a merchant's own backend calling this fraud API — needs a
different shape of access:

- **API keys** (`middleware/apiKeyAuth.js`, `routes/apiKeys.js`) — a
  service credential (`fg_live_...`, only its SHA-256 hash ever
  stored, same as passwords/refresh tokens) that acts on behalf of the
  account that created it, without ever touching that account's
  password. Self-service: `POST /api/api-keys` creates one (shown in
  plaintext exactly once), scoped to `transactions:write` and/or
  `transactions:read`, with an optional `expiresInDays` — a key with no
  expiry keeps working until explicitly revoked; an expired one is
  rejected the same as a revoked one (`middleware/apiKeyAuth.js` checks
  both). `GET /api/api-keys?mine=true` scopes the list to just the
  caller's own keys even for an admin (who otherwise sees everyone's) —
  that split is what lets the self-service Settings page and the
  admin-only Integrations panel (Admin Panel, above) share one endpoint
  without leaking data between them.

  `GET /api/transactions*` and `POST /api/transactions` accept
  **either** a JWT bearer token or an `X-API-Key` header
  (`flexibleAuth`) — everything else (alerts, admin) stays JWT-only,
  since those are human workflows a service credential has no business
  driving. Every transaction created via a key is audit-logged with the
  key's id and name (`transactions.create_via_api_key`), separately
  from the key's own `last_used_at`. `POST /api/transactions`'s rate
  limit is keyed **per API key** when one is presented (`apikey:<id>`),
  not shared across every caller on the same IP — a merchant's backend
  making high call volume from one server doesn't get throttled
  alongside unrelated traffic from that same IP, and one noisy key
  can't eat another key's allowance.

- **Outbound webhooks** (`services/webhookService.js`,
  `services/webhookRetryWorker.js`, `routes/webhooks.js`) — register a
  URL to receive a signed HTTP POST the moment one of your transactions
  scores medium/high risk (the same condition that creates an alert),
  instead of having to poll REST or hold a WebSocket connection open.
  Every delivery is HMAC-SHA256 signed
  (`X-FraudGuard-Signature: t=<unix_ts>,v1=<hex>`, the same
  construction Stripe uses) with a secret shown once at registration,
  and logged (`GET /api/webhooks/:id/deliveries`) so you can actually
  see whether your endpoint is receiving events. **Dispatch is
  fire-and-forget** — a slow or broken receiving endpoint never adds
  latency to the transaction API call that triggered it.

  Retries **survive a restart**: the first attempt happens inline, but
  a failure queues a row in `webhook_retry_queue` (exponential backoff,
  `WEBHOOK_MAX_RETRIES` attempts, default 3) instead of only an
  in-memory timer — a `setTimeout` a deploy or crash would silently
  drop along with every other pending retry. `webhookRetryWorker.js`
  sweeps due rows on an interval (`WEBHOOK_RETRY_SWEEP_INTERVAL_MS`,
  default 10s) on whichever server instance happens to be running one,
  so a retry queued right before a restart still eventually fires.

- **Idempotency keys** (`middleware/idempotency.js`) — an optional
  `Idempotency-Key` header on `POST /api/transactions` makes a network
  retry safe. Same key + same body within the TTL
  (`IDEMPOTENCY_KEY_TTL_HOURS`, default 24h) replays the original
  response (`Idempotent-Replay: true` header) instead of reprocessing;
  same key + a _different_ body returns `409`, since silently
  returning a stale answer for a materially different request would be
  actively wrong, not just unhelpful; a key still mid-flight
  (genuinely concurrent, not sequential) also returns `409` rather than
  letting both requests through — enforced by a
  `UNIQUE(user_id, idempotency_key)` DB constraint, not just an
  in-memory check, so it holds even across multiple server processes.

- **CORS** is locked to an explicit allow-list (`CORS_ALLOWED_ORIGINS`,
  comma-separated) — no wildcard. Defaults to `http://localhost:3100`
  (the CRA dev server) in development/test only; staging/production
  must set it explicitly or the app refuses to start. Socket.io uses the
  same allow-list.
- **[helmet](https://helmetjs.github.io/)** sets the standard hardening
  headers (HSTS, `X-Content-Type-Options`, `X-Frame-Options`,
  `Referrer-Policy`, etc.) on every response. Its default Content-Security-Policy
  is disabled — that's an HTML-page concern and this is a JSON API.
- **HTTPS is enforced** in staging/production (`middleware/httpsEnforce.js`):
  `GET`/`HEAD` requests over plain HTTP are redirected, anything else is
  rejected with `400`. A no-op in development, since local dev has no
  TLS terminator in front of it. Assumes a reverse proxy terminates TLS
  and forwards `X-Forwarded-Proto` — `app.set('trust proxy', 1)` in
  `server.js` is what makes `req.secure` reflect that correctly.

### Bulk actions & CSV export

`PATCH /api/alerts/bulk-resolve` resolves up to 100 alerts in one
request with the same verdict/note (`models/alertRepository.js`'s
`bulkResolve` — a single `UPDATE ... WHERE id IN (...)`, not a loop of
individual resolves). It's all-or-nothing: if any id in the batch is
missing or not owned by the caller, the _whole_ batch is rejected and
nothing is touched — a bulk action silently succeeding for 8 of 10
requested alerts is a worse failure mode than making the caller retry.
The Alerts page's "Select all on this page" + bulk action bar drives
this endpoint.

`GET /api/transactions/export`, `GET /api/alerts/export`, and (admin
only) `GET /api/admin/audit-logs/export` return CSV, respecting the
exact same filters and role-based scoping as their JSON list
counterparts, capped at 10,000 rows per request. CSV encoding is
hand-rolled (`services/csvService.js`) rather than a dependency — RFC
4180 field quoting is a handful of lines.

### Self-service data export & account deletion

`GET /api/auth/me/export` returns a JSON bundle of everything this app
holds about the caller's account — profile, transactions, alerts, their
own audit-trail entries, and API key/webhook metadata (never secrets or
hashes) — capped per section so one request can't pull an unbounded
amount of data.

`DELETE /api/auth/me` (password-confirmed) **anonymizes rather than
hard-deletes**: username/email/password are scrambled to an
unguessable placeholder (freeing the originals for a future
registration), every refresh token/API key/webhook tied to the account
is revoked, and `userRepository.findById` — the lookup every
authenticated request goes through — excludes anonymized accounts, so
even an already-issued, still-unexpired access token stops working on
its very next request. Transactions and alerts are deliberately **not**
deleted or reassigned: this app's own dynamic fraud blacklist
(`transactionRepository.fraudDeviceAndIpBlacklist`) and audit trail
depend on that history surviving account closure — losing it the
moment someone closes their account would be a real fraud-prevention
regression, not a privacy improvement. See
`models/userRepository.js`'s `anonymize()` for the full reasoning.

### Observability

`GET /metrics` (unauthenticated, mounted outside `/api` entirely — see
`middleware/metrics.js`) exposes Prometheus text-exposition format:
default Node.js process metrics (CPU, memory, event-loop lag, GC) plus
four app-specific counters/histograms —
`fraudguard_http_requests_total` and `_http_request_duration_seconds`
(labeled by method, matched route _pattern_ — not the literal URL, so a
transaction id doesn't fragment this into one series per request — and
status), `fraudguard_transactions_scored_total` (by risk level and
scoring method), `fraudguard_alerts_created_total` (by risk level), and
`fraudguard_webhook_deliveries_total` (by success). In a real
deployment this endpoint would typically sit behind an internal
network boundary, reachable by a Prometheus scraper but not the public
internet — this project doesn't add that restriction itself, since it
depends entirely on where you deploy it.

---

### Rule simulation, risk-based verification, drift monitoring

Admins can replay history against a proposed rule set before it goes live (Rule Lab), configure advisory or enforced step-up verification per risk band (FraudGuard only recommends and records; it never authorizes payments), and monitor persistent drift and model health. Details and limitations: [docs/RULES_VERIFICATION_MONITORING.md](docs/RULES_VERIFICATION_MONITORING.md).

### Customer profiles, geo-velocity, feedback labels and retraining

Explainable per-account risk profiles (analyst aid only), an uncertainty-aware impossible-travel check that can raise low to medium but never block, and a verified-label pipeline that freezes labels into a hashed dataset and trains a _candidate_ model under two-person approval. Details and limitations: [docs/PROFILES_GEO_FEEDBACK.md](docs/PROFILES_GEO_FEEDBACK.md).

## 🛠️ API Endpoints

> This table is a quick-reference. For the full request/response schemas,
> validation rules, and error shapes, see the OpenAPI spec and Postman
> collection in "API Docs & Postman" below — that's the version worth
> importing into a tool, not retyping from this table.

All protected routes require `Authorization: Bearer <token>` header.

**Versioning:** every route is served under `/api/v1/*`. The unversioned
`/api/*` paths (used in the table below for brevity) still work — they're
mounted as an alias to the same `v1` routes — but new integrations should
target `/api/v1` explicitly, since a future breaking change will land in
`/api/v2` while `/api` gets repointed deliberately rather than silently
following it. `GET /api/v1/health` (also reachable at `/api/health`)
reports the running `api_version`.

| Method   | Endpoint                                                            | Auth                       | Description                                                                                                                            |
| -------- | ------------------------------------------------------------------- | -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| POST     | `/api/auth/register`                                                | None                       | Create account (password strength enforced; sends a verification email)                                                                |
| POST     | `/api/auth/login`                                                   | None                       | Login. Returns `{ accessToken, refreshToken, user }` — or, if the account has MFA enabled, `{ mfaRequired: true, mfaToken }`           |
| POST     | `/api/auth/login/mfa`                                               | None (MFA challenge token) | Completes login with a TOTP or backup code                                                                                             |
| POST     | `/api/auth/refresh`                                                 | None (refresh token)       | Exchange a refresh token for a new pair (rotates it)                                                                                   |
| POST     | `/api/auth/logout`                                                  | None (refresh token)       | Revoke a refresh token server-side                                                                                                     |
| GET      | `/api/auth/me`                                                      | User                       | Get current user                                                                                                                       |
| POST     | `/api/auth/forgot-password`                                         | None                       | Request a password reset email (generic response either way)                                                                           |
| POST     | `/api/auth/reset-password`                                          | None (reset token)         | Complete a password reset; revokes every session                                                                                       |
| POST     | `/api/auth/verify-email`                                            | None (verification token)  | Verify an email address                                                                                                                |
| POST     | `/api/auth/resend-verification`                                     | User                       | Send a fresh verification email                                                                                                        |
| PATCH    | `/api/auth/password`                                                | User                       | Change your own password (requires current password; revokes other sessions)                                                           |
| PATCH    | `/api/auth/email`                                                   | User                       | Change your own email (requires current password; re-verification required)                                                            |
| POST     | `/api/auth/mfa/setup`                                               | User                       | Start TOTP 2FA setup — returns a secret + QR code                                                                                      |
| POST     | `/api/auth/mfa/enable`                                              | User                       | Confirm setup with a 6-digit code — returns one-time backup codes                                                                      |
| POST     | `/api/auth/mfa/disable`                                             | User                       | Disable TOTP 2FA (requires current password)                                                                                           |
| GET      | `/api/auth/me/export`                                               | User                       | Download a JSON bundle of everything this app holds about your account                                                                 |
| DELETE   | `/api/auth/me`                                                      | User                       | Delete (anonymize) your own account — requires current password                                                                        |
| GET      | `/api/transactions`                                                 | User or API key            | List/search transactions (paginated + filterable — see below)                                                                          |
| POST     | `/api/transactions`                                                 | User or API key            | Create + analyze transaction. Accepts an optional `Idempotency-Key` header — see below                                                 |
| GET      | `/api/transactions/:id`                                             | User or API key            | View a single transaction's full record, incl. SHAP explanation (audit-logged)                                                         |
| GET      | `/api/transactions/stats`                                           | User or API key            | Dashboard statistics                                                                                                                   |
| GET      | `/api/transactions/export`                                          | User or API key            | CSV export (same filters as the list endpoint)                                                                                         |
| POST     | `/api/transactions/bulk`                                            | User or API key            | Score up to 50 transactions in one request — same alerts/webhooks/step-up eligibility as a single POST, per-row results                |
| GET      | `/api/transactions/:id/step-up`                                     | User                       | Poll a held transaction's step-up challenge status (404 if it was never held)                                                          |
| POST     | `/api/transactions/:id/step-up/verify`                              | User                       | Resolve a pending step-up challenge with `success`/`failure`                                                                           |
| GET      | `/api/alerts`                                                       | User                       | List/search alerts (paginated + filterable — see below)                                                                                |
| GET      | `/api/alerts/:id`                                                   | User                       | View a single alert (audit-logged)                                                                                                     |
| GET      | `/api/alerts/:id/explanation`                                       | User                       | Plain-language (LLM-generated, template fallback) one-sentence explanation, cached after the first request                             |
| GET      | `/api/alerts/export`                                                | User                       | CSV export (same filters as the list endpoint)                                                                                         |
| PATCH    | `/api/alerts/:id/resolve`                                           | User                       | Resolve an alert with a `confirmed_fraud`/`false_positive` verdict + optional note (audit-logged)                                      |
| PATCH    | `/api/alerts/bulk-resolve`                                          | User                       | Resolve up to 100 alerts in one request, all-or-nothing (audit-logged)                                                                 |
| PATCH    | `/api/alerts/:id/assign`                                            | Admin                      | Assign/unassign an alert to an admin analyst (audit-logged)                                                                            |
| POST     | `/api/disputes`                                                     | User                       | Open a dispute/chargeback on your own transaction (admin may open on a user's behalf); one open dispute per transaction (audit-logged) |
| GET      | `/api/disputes`                                                     | User                       | List disputes — admins see every case (optionally `?status=`), everyone else sees only their own                                       |
| GET      | `/api/disputes/export`                                              | User                       | CSV export (same `?status=` filter and ownership scoping as the list endpoint)                                                         |
| GET      | `/api/disputes/:id`                                                 | User                       | View a single dispute (owner or admin)                                                                                                 |
| PATCH    | `/api/disputes/:id`                                                 | Admin                      | Advance a dispute's lifecycle: `opened → evidence_submitted → won/lost` (audit-logged)                                                 |
| GET      | `/api/disputes/financial-summary`                                   | Admin                      | Rollup: amounts won/lost/pending and win rate over resolved cases                                                                      |
| GET      | `/api/admin/stats`                                                  | Admin                      | System-wide stats                                                                                                                      |
| GET      | `/api/admin/users`                                                  | Admin                      | All users list                                                                                                                         |
| PATCH    | `/api/admin/users/:id/role`                                         | Admin                      | Change user role (audit-logged, revokes their sessions)                                                                                |
| GET      | `/api/admin/audit-logs`                                             | Admin                      | Browse the audit trail (filter by action/target/user)                                                                                  |
| GET      | `/api/admin/audit-logs/export`                                      | Admin                      | CSV export (same filters as the list endpoint)                                                                                         |
| GET      | `/api/admin/audit-logs/alert/:id`                                   | Admin                      | Full view/resolve history for one alert                                                                                                |
| GET      | `/api/admin/fraud-rules`                                            | Admin                      | List admin-editable blacklists (merchant/location/device/IP) and the amount cap                                                        |
| POST     | `/api/admin/fraud-rules`                                            | Admin                      | Create a rule — takes effect on the next transaction scored (audit-logged)                                                             |
| POST     | `/api/admin/fraud-rules/preview`                                    | Admin                      | Dry-run a candidate rule against transactions on file — count + sample of what it would have matched, creates nothing                  |
| PATCH    | `/api/admin/fraud-rules/:id`                                        | Admin                      | Update value/threshold/reason, or enable/disable a rule (audit-logged)                                                                 |
| DELETE   | `/api/admin/fraud-rules/:id`                                        | Admin                      | Permanently delete a rule (audit-logged)                                                                                               |
| GET      | `/api/admin/fraud-rings`                                            | Admin                      | Detect clusters of accounts sharing a device fingerprint or IP                                                                         |
| GET      | `/api/admin/alerts/:id/sar-report`                                  | Admin                      | Export a SAR-style compliance report for an alert (`?format=pdf`\|`csv`) — not a completed regulatory filing                           |
| GET      | `/api/admin/ml/versions`                                            | Admin                      | List every trained model version in the registry                                                                                       |
| GET      | `/api/admin/ml/drift`                                               | Admin                      | Feature/score drift report for the active model version                                                                                |
| POST     | `/api/admin/ml/drift/reset`                                         | Admin                      | Clear the live-traffic buffer used for drift comparison                                                                                |
| GET      | `/api/admin/ml/shadow/status`                                       | Admin                      | Current shadow/canary deployment status                                                                                                |
| POST     | `/api/admin/ml/shadow/set`                                          | Admin                      | Start shadow-scoring a registry version alongside the primary                                                                          |
| POST     | `/api/admin/ml/shadow/clear`                                        | Admin                      | Stop shadow-scoring                                                                                                                    |
| GET      | `/api/admin/risk-policy`                                            | Admin                      | Active risk policy, history, limits and what a score means                                                                             |
| PUT      | `/api/admin/risk-policy`                                            | Admin                      | Save new thresholds as a new audited version (note required)                                                                           |
| POST     | `/api/admin/risk-policy/simulate`                                   | Admin                      | Dry-run candidate thresholds: missed fraud, legitimate flagged, volume                                                                 |
| GET      | `/api/admin/risk-policy/calibration`                                | Admin                      | Predicted vs observed fraud rate per score band; hard-rule paths evaluated separately                                                  |
| POST     | `/api/admin/ml/shadow/promote`                                      | Admin                      | **Disabled (410)** — use the change workflow                                                                                           |
| GET/POST | `/api/admin/ml/change-requests`                                     | Admin                      | Promotion history / request a promotion or rollback (runs the gates)                                                                   |
| POST     | `/api/admin/ml/change-requests/:id/approve` \| `reject` \| `cancel` | Admin                      | Second-admin approval (applies the change), rejection, requester cancel                                                                |
| GET      | `/api/admin/ml/gates/:version`, `/ml/outcome-evaluation/:version`   | Admin                      | Gate dry-run; challenger vs incumbent on analyst verdicts                                                                              |
| GET/POST | `/api/admin/ml/health`, `/ml/health/evaluate`                       | Admin                      | Rollback triggers for the serving model                                                                                                |
| GET      | `/api/events?after=<cursor>`                                        | User                       | Replay real-time events missed while disconnected (cursor-paginated)                                                                   |
| POST     | `/api/api-keys`                                                     | User                       | Create an API key for your own account (shown once; optional `expiresInDays`)                                                          |
| GET      | `/api/api-keys`                                                     | User                       | List your own API keys (admin sees everyone's; `?mine=true` forces own-only)                                                           |
| DELETE   | `/api/api-keys/:id`                                                 | User                       | Revoke an API key (owner or admin)                                                                                                     |
| POST     | `/api/webhooks`                                                     | User                       | Register a webhook (signing secret shown once)                                                                                         |
| GET      | `/api/webhooks`                                                     | User                       | List your own webhooks (admin sees everyone's; `?mine=true` forces own-only)                                                           |
| PATCH    | `/api/webhooks/:id`                                                 | User                       | Update a webhook's URL/events/active state                                                                                             |
| DELETE   | `/api/webhooks/:id`                                                 | User                       | Remove a webhook                                                                                                                       |
| GET      | `/api/webhooks/:id/deliveries`                                      | User                       | Recent delivery attempts for a webhook                                                                                                 |
| POST     | `/api/admin/simulation/start`                                       | Admin                      | Start the live transaction feed simulation                                                                                             |
| POST     | `/api/admin/simulation/stop`                                        | Admin                      | Stop the simulation                                                                                                                    |
| GET      | `/api/admin/simulation/status`                                      | Admin                      | Current simulation run state                                                                                                           |
| GET      | `/metrics`                                                          | None                       | Prometheus metrics — see "Observability" above. Not under `/api`                                                                       |

**Real-time:** the backend also runs a Socket.io server on the same
port — see "Real-Time Capability" below for connection details, rooms,
and events.

**Pagination:** `GET /api/transactions` and `GET /api/alerts` accept
`?page=` (default `1`) and `?limit=` (default `20`, max `100`) query
params. Each response includes a `pagination` object alongside the data:

```json
{
  "transactions": [
    /* ... */
  ],
  "pagination": {
    "page": 1,
    "limit": 20,
    "total": 143,
    "total_pages": 8,
    "has_next": true,
    "has_prev": false
  }
}
```

**Filtering:** both list endpoints also accept filter query params, all
optional and combinable:

- `GET /api/transactions?merchant=&category=&riskLevel=&dateFrom=&dateTo=&amountMin=&amountMax=`
- `GET /api/alerts?status=&riskLevel=&merchant=&dateFrom=&dateTo=&amountMin=&amountMax=&assignedTo=`

**Case management (alerts):** `alerts.status` moves through
`open → in_review → resolved` — assigning an alert (`PATCH
/api/alerts/:id/assign`) auto-transitions `open → in_review`;
unassigning moves it back to `open`. Resolving requires a `verdict` of
`confirmed_fraud` or `false_positive` (not just a boolean) plus an
optional `note` — this is what
`transactionRepository.fraudDeviceAndIpBlacklist` actually reads to
decide whether a transaction's device/IP belongs on the dynamic
blacklist (see `docs/METHODOLOGY.md`): `confirmed_fraud` adds it
regardless of the model's original score, and `false_positive`
explicitly removes it even if the model originally flagged it —
closing the analyst feedback loop instead of leaving it purely
model-driven.

**Case management (disputes):** a dispute tracks something distinct
from an alert's `verdict` — what actually happened financially with
the card network once a charge was formally contested, which can
diverge from FraudGuard's own fraud call (a transaction FraudGuard
never flagged can still be disputed, and one FraudGuard correctly
flagged as fraud can still be lost at chargeback for lack of
evidence). Any account owner can open a dispute on their own
transaction — either directly from the Disputes page (pick from your
own undisputed transactions) or from that transaction's own detail
page — or an admin on the user's behalf; a transaction can have at
most one open dispute at a time. From there, `status` moves through
`opened → evidence_submitted → won`/`lost`, though `evidence_submitted`
is optional — a case may also resolve straight from `opened` to
`won`/`lost` (e.g. the contest window simply expires). Advancing the
status is admin-only, the same "we reviewed the evidence, here's the
outcome" reasoning as alert resolution being admin-only.
`GET /api/disputes/financial-summary` gives admins total exposure and
a win rate over resolved cases. See
`backend/models/disputeRepository.js`'s header for the full state
machine.

**Step-up authentication:** when a transaction scores medium risk
_and_ the account has a webhook subscribed to
`transaction.step_up_required` (or `*` — configurable per webhook
under Account Settings → Webhooks), FraudGuard holds the transaction
(`status: "pending_step_up"`) instead of completing it, and the
create-transaction response carries a `step_up` challenge. FraudGuard
never runs the actual OTP/3DS flow itself — that's the merchant's own
flow; `POST /api/transactions/:id/step-up/verify` is where it reports
back `success` (completes the transaction) or `failure` (blocks it).
The Simulator page renders this as a "Step-Up Verification Required"
panel with buttons that simulate the customer completing that flow, so
the whole loop is visible without a real OTP provider configured. See
`backend/models/stepUpRepository.js`.

**Admin rule builder:** `/api/admin/fraud-rules` lets admins maintain
blacklists (merchant/location/device/IP, exact match) and a single
global amount cap, independent of the ML model — these are evaluated
first, in `fraudEngine.js`'s `checkHardRules`, and can force
`risk_level: "high"` regardless of what the model would have scored.
A handful of defaults are seeded automatically once an admin account
exists. Disabling a rule (`enabled: false`) is the usual way to turn
it off without losing its configuration; deleting is permanent.
Before turning one on, `POST /api/admin/fraud-rules/preview` (feature:
rule impact preview) dry-runs the same rule_type/value/threshold
against transactions already on file — creates nothing, just returns
how many it would have matched and a sample — so an overly broad
blacklist entry or too-low an amount cap gets caught before it starts
generating alerts, not after. The Admin Panel's "Add Rule" form has a
Preview Impact button for exactly this.

**Fraud ring detection:** `/api/admin/fraud-rings` groups accounts
that share a device fingerprint or IP address across _any_ of their
transactions — no fraud confirmation required to appear, since the
point is surfacing a coordinated cluster before it's confirmed, not
after. `risk` is `high` when the cluster includes a confirmed-fraud
account or is large, `watch` for a mid-size cluster with no confirmed
fraud yet, and `low` otherwise. See `backend/models/networkRepository.js`.

**SAR-style exportable reports:** `GET /api/admin/alerts/:id/sar-report`
(`?format=pdf` or `csv`) bundles a transaction, why it was flagged,
its network/dispute status, and its full audit trail into one
document — the internal review document a compliance team would
otherwise assemble by hand. It is explicitly **not** a completed
regulatory filing (e.g. FinCEN Form 111), and says so in its own
footer. See `backend/services/sarReportService.js`.

**ML model ops:** `/api/admin/ml/*` is a thin proxy to the Python
ml_service's own model-management endpoints (returns 503 if
ml_service isn't reachable). `GET /versions` lists everything in the
registry; `GET /drift` compares a buffer of recently-scored live
transactions against the active version's training-time baseline
(per-feature PSI plus mean-score/high-risk-rate drift), reporting
`insufficient_data` until enough live traffic has accumulated.
Shadow/canary deployment (`/shadow/set|status|clear`) scores
every live transaction with both the primary and a shadow version
simultaneously — only the primary's score is ever used, but the
shadow's score is recorded for comparison, so a new version's behavior
on real traffic can be evaluated before it goes live. See
`backend/services/mlAdminClient.js` and `ml_service/app.py`.

**Plain-language alert explanations:** `GET /api/alerts/:id/explanation`
generates a single sentence explaining why an alert fired — an LLM
call if one's configured, otherwise a template built from the
transaction's own `fraud_reasons`, so the endpoint always returns
something. Generated once per alert and cached on the row; available
to the alert's owner, not just admins. See
`backend/services/explanationService.js`.

**Service-to-service auth:** `GET /api/transactions*` and
`POST /api/transactions` also accept an `X-API-Key` header instead of
`Authorization: Bearer`. Create one for your own account under Account
Settings → API Keys, or `POST /api/api-keys` — see "Integration
surface" under Security below for scopes and how it's stored.

**Idempotency:** `POST /api/transactions` accepts an optional
`Idempotency-Key` header so a network retry can't double-submit —
see "Integration surface" under Security below.

**Bulk transaction import:** `POST /api/transactions/bulk` scores up
to 50 transactions in a single request — the ops-tool counterpart to
submitting one transaction at a time. Each row runs through the exact
same pipeline as a single `POST /api/transactions` (same alerts,
webhooks, live feed, and step-up eligibility), and rows are scored in
order so later rows see the velocity/history effects of earlier ones
in the same batch. A malformed row fails the whole request before
anything is created; a row that throws _during_ scoring (rare) is
reported per-row instead of failing the rest of the batch. The
frontend's Bulk Import page (paste or upload a CSV, client-side
validated against the same field rules before it's sent) is the UI
for this. See `routes/transactions.js`'s `scoreAndCreateTransaction`,
shared with the single-transaction endpoint.

**CSV export:** `GET /api/transactions/export`, `GET /api/alerts/export`,
`GET /api/disputes/export`, and `GET /api/admin/audit-logs/export`
accept the same filter query params as their list counterparts and
return `text/csv` with a `Content-Disposition: attachment` header,
capped at 10,000 rows (disputes has no such cap — its own list isn't
paginated either). See "Bulk actions & CSV export" under Security
above.

---

## ⚙️ Configuration

Edit `backend/.env` to change settings:

```env
PORT=5000                          # Backend port (default 5000)
JWT_SECRET=your_secret_here        # Change this in production!
NODE_ENV=development

# Optional — see "SQLite vs. PostgreSQL" above
DATABASE_URL=postgresql://user:password@localhost:5432/fraudguard
DB_POOL_MAX=10

# Optional — see "Security" above for what each of these does
JWT_ACCESS_EXPIRES_IN=15m
REFRESH_TOKEN_EXPIRES_DAYS=30
LOGIN_MAX_ATTEMPTS=5
LOGIN_LOCKOUT_MINUTES=15
CORS_ALLOWED_ORIGINS=http://localhost:3100  # required (no default) in staging/production

# Optional — email verification, password reset, MFA (see "Security" above)
FRONTEND_URL=http://localhost:3100          # used to build emailed links
EMAIL_VERIFICATION_EXPIRES_HOURS=24
PASSWORD_RESET_EXPIRES_MINUTES=30
MFA_CHALLENGE_EXPIRES_MINUTES=5

# Optional in dev/test (emails are logged instead of sent without these) —
# required (no default) in staging/production, see services/emailService.js
SMTP_HOST=smtp.sendgrid.net
SMTP_PORT=587
SMTP_USER=apikey
SMTP_PASS=your_smtp_password

# Optional — API keys, webhooks, idempotency (see "Integration surface" above)
IDEMPOTENCY_KEY_TTL_HOURS=24
WEBHOOK_TIMEOUT_MS=5000
WEBHOOK_MAX_RETRIES=3
WEBHOOK_RETRY_SWEEP_INTERVAL_MS=10000
API_KEY_DEFAULT_EXPIRES_DAYS=0     # 0 = keys never expire unless expiresInDays is set per-key
```

By default (no `DATABASE_URL`), the database file (`fraudguard.db`) is
created automatically in the `backend/` folder on first run — no setup
needed. Set `DATABASE_URL` to point at Postgres instead.

See `backend/.env.example` for the full list of variables with inline
explanations.

---

## 🐳 Running with Docker

Every service (`backend`, `frontend`, `ml_service`) has its own
`Dockerfile`, and `docker-compose.yml` at the repo root wires all three
together:

```bash
docker compose up --build
```

- **frontend** → http://localhost:3100
- **backend** → http://localhost:5000 (health check: `/api/v1/health`)
- **ml_service** → internal only (not published to your host; reachable by the backend over the compose network, and key-protected)

This uses SQLite (a named volume, `backend_data`, so the database
survives `docker compose down` / restarts) and — see `SEED_ON_BOOT`
below — auto-populates realistic demo data on first boot, so the app
isn't empty the moment it comes up.

A few things worth knowing about this setup:

- It's a **local/demo topology**, not a production deployment shape —
  see "Deployment" below for actually shipping each service somewhere
  with real Postgres, real secrets, and a real domain.
- The frontend's `REACT_APP_API_URL`/`REACT_APP_SOCKET_URL` are baked
  into the static JS bundle **at build time** (that's how Create React
  App env vars work) — `docker-compose.yml` passes them as build args
  pointing at `localhost:5000`, since the browser (not the frontend
  container) is what actually calls the backend. Rebuild the frontend
  image (`docker compose build frontend`) if you change where the
  backend lives.
- `backend`'s Dockerfile is a two-stage build: a builder stage with the
  toolchain `better-sqlite3` needs to compile its native binding, and a
  slim runtime stage that just copies the compiled `node_modules` over —
  keeps the shipped image smaller without needing a separate
  install step.
- To seed manually instead of (or in addition to) `SEED_ON_BOOT`:
  `docker compose exec backend npm run seed` (or `npm run seed:reset`
  to wipe and redo it).
- To run just one service — e.g. iterating on the backend against the
  frontend running natively — `docker compose up ml_service backend`
  and point a locally-run `npm start` in `frontend/` at
  `http://localhost:5000`.

**Not independently build-tested end-to-end** — this environment
doesn't have a Docker daemon available to actually run `docker compose
up` against. The backend/frontend/ml_service application code itself
_has_ been run and verified (see "Automated Testing & CI" above and the
extensive manual verification throughout this project's history); what
hasn't been verified is the container build/orchestration layer itself.
Worth a real `docker compose up --build` before relying on this for
anything beyond local evaluation — if something's off, the likely
culprits are Dockerfile base-image versions drifting or a Compose
schema change since this was written.

---

## 🚀 Deployment

**I can't produce a live, working public link myself** — I have no way
to actually deploy anything or verify a deployed URL responds. What
follows is a deployment-ready setup (Dockerfiles, a Render Blueprint, a
Vercel config, and a Netlify config, all included in this repo) plus
the steps to actually deploy them; someone with accounts on these
platforms can be live in well under 15 minutes by following it. None of
these configs have been tested against a live deploy — treat them as a
strong starting point, not a guarantee, and check the relevant
platform's current docs if a step doesn't match what you see in its
dashboard.

### Backend + ML service → Render (or Railway)

**Render**, using the included `render.yaml` Blueprint (repo root):

1. Push this repo to GitHub.
2. Render dashboard → **New** → **Blueprint** → point it at the repo.
   It reads `render.yaml` and provisions `fraudguard-backend`,
   `fraudguard-ml-service`, and a managed Postgres database
   (`fraudguard-db`) together.
3. `render.yaml` leaves a few values for you to fill in in the
   dashboard rather than guessing at them (`CORS_ALLOWED_ORIGINS`,
   `ML_SERVICE_URL`, `ADMIN_PASSWORD`) — see the comments at the top of
   that file for why each one is deployment-specific.
4. Deploy `fraudguard-ml-service` first, copy its public URL from the
   Render dashboard, and set that as `fraudguard-backend`'s
   `ML_SERVICE_URL`.

**Railway** works too, without a blueprint file: New Project → Deploy
from GitHub repo → point it at `backend/` (it auto-detects the
Dockerfile) → add a Postgres plugin → set the same env vars `render.yaml`
lists (`JWT_SECRET`, `DATABASE_URL` from the Postgres plugin,
`CORS_ALLOWED_ORIGINS`, `ML_SERVICE_URL`, etc). Repeat for `ml_service/`
as a second service in the same project.

### Frontend → Vercel or Netlify

Both configs are in `frontend/` already (`vercel.json`, `netlify.toml`).

**Vercel**: New Project → import the repo → set **Root Directory** to
`frontend` → set build-time env vars `REACT_APP_API_URL` (your deployed
backend's URL + `/api/v1`) and `REACT_APP_SOCKET_URL` (the same backend
URL, no path) in the project's Environment Variables settings, since
CRA bakes these in at build time, not read at runtime → Deploy.

**Netlify**: New site from Git → same idea — base directory `frontend`,
build command `npm run build`, publish directory `build`, and the same
two `REACT_APP_*` env vars set in Site Settings before building.

### After both are deployed

Go back to the backend's `CORS_ALLOWED_ORIGINS` and set it to the
frontend's real deployed origin (e.g. `https://fraudguard.vercel.app`)
— the app deliberately refuses cross-origin requests from anywhere
else in staging/production (see "Security" above), so this step isn't
optional.

---

## 🎬 Try demo (sign-in screen)

The sign-in / register screen has a **Try demo** button. It opens `/demo/`, a self-contained page (served from
`frontend/public/demo/`) that runs entirely in the browser on pre-loaded synthetic data: the same screens as the app
(dashboard, simulator with scenarios, alerts, cases, rule lab, model health, AI Memory, ...). It needs no account and never
touches the real database or API, so nothing a visitor does there is saved; _Exit demo_ returns to the sign-in screen.
Its fraud engine is a JavaScript port of the real one with a synthetic stand-in for the ML model, so scores illustrate the
behaviour rather than reproduce your trained model's numbers.

- Source: `demo/` (original page in `fraudguard-demo.base.html`, AI Memory in `src/`). After changing anything there run
  `python demo/build_demo.py` (or `npm run demo:build` at the repo root): it rewrites both `demo/fraudguard-demo.html`
  (standalone, open directly) and `frontend/public/demo/index.html` (what the app serves).
- Hosting: the demo is a plain static file. nginx (`try_files $uri $uri/ /index.html`), Vercel and Netlify serve existing
  files before applying the SPA rewrite, so `/demo/` works without extra configuration.

**Want pre-loaded data in the _real_ app instead?** Seed the database (next section): the real dashboard then shows the
same kind of content (volume chart, alert queue, cases) computed from real records.

## 🌱 Seeding Demo Data

Two ways to get realistic data instead of an empty app:

1. **`SEED_ON_BOOT=true`** (env var) — the backend seeds automatically
   the first time it starts with no demo data present, and no-ops on
   every boot after that (so restarts don't keep appending more). This
   is what `docker-compose.yml` uses by default, and it's the natural
   choice for "fresh deploy should just have data" on Render/Railway —
   set it as an env var there too.
2. **Manually, any time**: `cd backend && npm run seed` (or
   `npm run seed:reset` to wipe previous demo data and redo it, or
   `node scripts/seedDemoData.js --users=20 --days=90` for more of it).

Either way, every seeded transaction runs through the exact same
`analyzeTransactionHybrid` scoring pipeline a real submission does
(backdated to its own simulated timestamp) — see
`backend/scripts/seedDemoData.js`'s top comment. Seeded users log in
with password `demo1234`; log in as `admin`/`admin123` to see
everything across all of them at once.

---

## 🐛 Troubleshooting

**"Port 5000 already in use"**

```bash
# Mac/Linux:
lsof -ti:5000 | xargs kill
# Windows:
netstat -ano | findstr :5000
taskkill /PID <PID> /F
```

**"Cannot find module" error in backend**

```bash
cd backend && npm install
```

**`better-sqlite3` fails to build in a network-restricted environment**
`better-sqlite3` compiles a native module on install (via `node-gyp`),
which needs to download Node.js headers from `nodejs.org`. On a normal
machine or CI runner with unrestricted internet access this just works.
If you're building behind a firewall/proxy that blocks `nodejs.org`
specifically (uncommon, but it happened in this project's own sandboxed
build/verification environment), point `node-gyp` at the Node headers
that ship with your system's Node install instead of fetching them:

```bash
npm install --nodedir=/usr/include/node   # path varies by OS/install method
```

`npm install` and `npm ci` are otherwise identical here — this isn't an
`npm ci`-specific issue, just a native-module-with-no-cached-headers one.

**Frontend shows blank page or API errors**

- Make sure the backend is running first (Step 2)
- Check the backend terminal for error messages
- Make sure you're at http://localhost:3100, not 5000

**Login says "Invalid credentials"**

- Default admin: `admin` / `admin123`
- On SQLite: delete `backend/fraudguard.db` and restart the backend to reset
- On Postgres: `DROP` and recreate the tables, or drop the database and let `initSchema()` recreate them on next start

**Using Postgres and getting connection errors**

- Confirm the Postgres server is running and `DATABASE_URL` in `backend/.env` is correct
- The app creates tables automatically on first start — no manual migration step needed, but the database itself (e.g. `fraudguard`) must already exist (`createdb fraudguard`)

**npm install is very slow**

- This is normal for the first install (downloading ~200MB of packages)
- Wait 5 minutes before assuming something is wrong

---

## 📦 Tech Stack

**Backend:** Node.js, Express, better-sqlite3 (dev) / pg (production), Zod, bcryptjs, jsonwebtoken, otplib, nodemailer, qrcode, prom-client, Socket.io, helmet  
**ML service:** Python, FastAPI, scikit-learn, XGBoost, SHAP, imbalanced-learn  
**Frontend:** React 18, React Router v6, Recharts, Lucide React, Tailwind CSS, Axios, Socket.io-client  
**Testing:** Jest, Supertest, React Testing Library  
**CI:** GitHub Actions  
**DevOps:** Docker + Docker Compose, Render Blueprint, Vercel/Netlify configs  
**Docs:** Mermaid architecture diagram, OpenAPI 3.0 spec, Postman collection — see "API Docs & Postman" above

## Decision auditability

Every fraud decision stores its model version, rule-set version, thresholds, feature snapshot and source (ML / hard rule / fallback) in an append-only, hash-chained history; rescoring appends instead of overwriting; investigator/admin changes are audited with before/after values; retention is configurable with legal holds. See [docs/DECISION_AUDIT.md](docs/DECISION_AUDIT.md).

---

## 🧠 Cognee Fraud Intelligence Memory (optional)

FraudGuard can remember its past transactions, investigations and outcomes in a [Cognee](https://docs.cognee.ai) knowledge graph, and let investigators search that history in plain language, explore connected entities, and ask an assistant to explain a suspicious record using similar past cases.

It is **additive and optional**: the fraud scoring engine, ML models, SHAP explanations, database tables and authentication are untouched, and Cognee is never used to make or change a fraud decision. With `COGNEE_SERVICE_URL` unset, nothing in this section runs.

### Architecture

```
 FraudGuard DB ──read-only SELECTs──▶  backend/services/cognee/            cognee_service/  (Python, official Cognee SDK)
 (transactions, alerts, comments,      projector  → minimise + pseudonymise   app/main.py     FastAPI, service-key auth
  disputes, investigations)            syncService→ content-hash dedup,       app/memory.py   cognee.add / cognify / search /
                                                    cursor, retries, lock                      update + add_data_points
 Browser ─JWT + admin role─▶ routes/cogneeMemory.js ─X-Cognee-Service-Key─▶  app/assistant.py LLM suggestions (optional)
 (never sees any key)         rate limits, audit log                          Cognee stores: graph + vector + relational (COGNEE_DATA_DIR)
```

Why a separate Python service: Cognee's dependency tree is large and must not constrain `ml_service`'s pinned scikit/xgboost/shap stack, and Cognee's default stores are embedded single-writer databases (run it with **one** worker). The browser never talks to it; only the backend does, with a service key, on a private network.

### What is remembered

| Layer                | Built from                                                                                                                                                                                                       | Needs an LLM? | Used for                                                                                                                    |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- | --------------------------------------------------------------------------------------------------------------------------- |
| **Structured graph** | Records, deterministically (no LLM inference): `Transaction —made_by→ Customer`, `—at_merchant→ Merchant`, `—from_device→ Device`, `—exhibits_pattern→ FraudPattern`, `Investigation —investigates→ Transaction` | No            | Entities, relationships, suspicious-device detection, semantic search over each record's embedded summary                   |
| **Narrative memory** | A natural-language document per transaction/case, stored with `cognee.add`, processed by `cognee.cognify`, replaced in place with `cognee.update`                                                                | **Yes**       | Document-chunk search (`SearchType.CHUNKS`), optional graph-completion summary, richer entity extraction from analyst notes |

In FraudGuard a _customer_ and an _account_ are the same row (`users`), so one `Customer` node represents "customer account". A _suspicious device_ is computed at read time: shared by two or more accounts, or tied to a confirmed-fraud transaction. Device fingerprints are User-Agent hashes (see `docs/METHODOLOGY.md`), so this is a lead for a human, not proof.

### Setup

1. **Start the Cognee service**
   ```bash
   cd cognee_service
   python -m venv .venv && source .venv/bin/activate
   pip install -r requirements.txt
   cp .env.example .env            # set COGNEE_SERVICE_API_KEY (>= 32 chars) and LLM_API_KEY
   set -a; source .env; set +a
   uvicorn app.main:app_factory --factory --host 127.0.0.1 --port 8002 --workers 1
   ```
   **Windows (PowerShell)** - run each line separately:
   ```powershell
   cd cognee_service
   python -m venv .venv
   .\.venv\Scripts\Activate.ps1
   python -m pip install -r requirements.txt
   $env:COGNEE_SERVICE_API_KEY = "<at least 32 random characters>"
   $env:LLM_API_KEY = "<your LLM key>"
   uvicorn app.main:app_factory --factory --host 127.0.0.1 --port 8002 --workers 1
   ```
   (If activation is blocked: `Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass`. Use `python -m pip`, not bare
   `pip`, so packages go to the same Python you run.) Python 3.10-3.14 is supported by Cognee.
   Or with Docker: `COGNEE_SERVICE_URL=http://cognee_service:8002 LLM_API_KEY=sk-... docker compose --profile cognee up`.
2. **Point the backend at it** (`backend/.env`):
   ```env
   COGNEE_SERVICE_URL=http://127.0.0.1:8002
   COGNEE_SERVICE_API_KEY=<same value as the service>
   COGNEE_PSEUDONYM_SECRET=<random, >= 16 chars, different from JWT_SECRET>
   ```
   Restart the backend. Sign in as an administrator and open **AI Memory** (`/fraud-intelligence`), check the health banner, then click **Sync now**.
3. **Provider choices.** `LLM_PROVIDER` / `LLM_MODEL` / `LLM_API_KEY` and `EMBEDDING_*` are Cognee's own variables (any LiteLLM provider, e.g. Anthropic or a local Ollama). With no LLM key the service still runs the structured layer and tells you so on `/v1/health`; with no API keys at all, Cognee uses a local fastembed embedding model (a ~70 MB one-time download). If you change the embedding model or dimensions after data exists, clear `COGNEE_DATA_DIR` and run a forced full sync.

**First start:** the service loads its embedding model in the background (with a local model the first run downloads ~70 MB).
Until it is ready, `/v1/health` reports `embeddings.state: warming` and ingest/search answer `503` ("not ready"); the backend
retries, shows "Cognee is still starting" if it is still loading, and the scheduled sync simply tries again - no action needed.

All variables are documented in `backend/.env.example` and `cognee_service/.env.example`. In staging/production the backend refuses to boot with `COGNEE_SERVICE_URL` set but a short service key or a missing/JWT-reused pseudonym secret, and the service refuses to boot without a >= 32-character key.

### Synchronisation and duplicate prevention

`POST /sync` (and the scheduler, every `COGNEE_SYNC_INTERVAL_MS`, default 5 min) sends only what changed:

1. records whose previous attempt **failed** (an outage heals itself);
2. **new** transactions above a stored cursor (inside `COGNEE_SYNC_LOOKBACK_DAYS`);
3. already-synced transactions that can still change (they have an alert, a dispute, or belong to a case) — re-projected and sent **only if their content hash changed** (verdict, status, notes, outcome, dispute…);
4. new/changed investigations, plus any member transactions Cognee hasn't seen, so links can be built.

Every sent record's SHA-256 is stored in `cognee_sync_records`; an identical record is never re-sent. The Cognee side is independently idempotent (deterministic node ids; documents replaced by label), so a replayed batch cannot create duplicates. The cursor only advances after a batch is fully recorded, a failing record is marked `failed` without stopping the run, only one run executes at a time, and `COGNEE_SYNC_MAX_PER_RUN` bounds a run (the response says `morePending`). `mode: "full"` re-checks the whole lookback window (still skipping unchanged records); `force: true` re-sends everything.

Database changes are additive (`backend/config/cogneeSchema.js`, created automatically at startup, idempotent): `cognee_sync_records`, `cognee_sync_runs`, `cognee_sync_cursor`. The earlier prototype's `cognee_sync_state` table is no longer used and can be dropped.

### Security and privacy

- **Read-only**: the integration only `SELECT`s from FraudGuard tables.
- **Pseudonymised**: customer accounts and devices become keyed HMAC-SHA256 references (`acct_…`, `dev_…`) via `COGNEE_PSEUDONYM_SECRET`.
- **Excluded**: IP addresses, emails, card type/numbers, passwords, tokens, API keys, 2FA data, evidence files. Analyst notes are redacted for emails, phone numbers, card-like numbers, IPs, SSN-like numbers and tokens; set `COGNEE_INCLUDE_ANALYST_NOTES=false` to send none.
- **Defence in depth**: the Python service rejects (HTTP 422) any payload containing credential-like or direct-identifier field names, accepts only pseudonymous references, and redacts free text again.
- **Access**: every endpoint requires the existing JWT **and** the `admin` role; the service key and any LLM/embedding key live only on the servers; sync/search/assistant are rate-limited per admin; actions are audit-logged (query text is never logged).
- **Prompt-injection**: retrieved text is untrusted — the assistant delimits it, instructs the model to treat it as data, requires schema-valid output with no tools, drops "similar pattern" claims that cite no real evidence, and strips citations to evidence ids that were never retrieved.
- Pseudonymisation is **not** anonymisation. Transaction facts can be re-identifying in combination; restrict access to the Cognee data directory, configure retention, and get approval before syncing production financial data. The configured LLM/embedding provider processes the synced text under its own terms.

### API (backend, base `/api/v1/cognee-memory`, admin only)

| Method & path                                                             | Purpose                                                                                                                                                                                                                                    |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /health`                                                             | Service reachability, graph/vector store checks, LLM and narrative-layer status (200 even when the service is down, with `status: "unreachable"` / `"not_configured"`)                                                                     |
| `GET /stats`                                                              | Memory statistics (entities by type, relationships, suspicious devices, narrative documents, semantic-indexing state) + synchronisation state                                                                                              |
| `POST /sync` `{mode?: "incremental"\|"full", force?, maxRecords?}`        | Synchronise FraudGuard → Cognee. `409` if a run is already in progress                                                                                                                                                                     |
| `GET /sync/runs?limit=`                                                   | Recent ingestion activity                                                                                                                                                                                                                  |
| `POST /search` `{query, topK?, sourceTypes?, includeAnswer?}`             | Natural-language search. Returns `evidence` (retrieved records, each cross-checked against the live record and flagged `memoryOutOfDate` if it changed since sync) and, only if requested and an LLM exists, a labelled generated `answer` |
| `GET /entities?type=&q=&suspiciousOnly=&limit=&offset=`                   | Graph entities                                                                                                                                                                                                                             |
| `GET /entities/:id/related?depth=1\|2`                                    | Entity neighbourhood (nodes + edges)                                                                                                                                                                                                       |
| `POST /assistant` `{kind: "transaction"\|"investigation", id, question?}` | Investigation assistant (below). `404` for unknown records                                                                                                                                                                                 |
| `GET /status`                                                             | Compact status (kept for backward compatibility)                                                                                                                                                                                           |

Errors: `400` validation, `401/403` auth/role, `404`, `409` sync busy, `429` rate limit, `502` Cognee service error or key mismatch, `503` not configured or unreachable, `504` timeout.

The Python service exposes the same operations under `/v1/*` (`ingest`, `search`, `entities`, `entities/{id}/related`, `assistant`, `stats`, `health`) protected by `X-Cognee-Service-Key`, plus an unauthenticated `/health` liveness probe that reveals nothing.

### The assistant: facts, evidence and AI are kept apart

Every `/assistant` response has three separately labelled parts: **`subject`** — current facts read from FraudGuard's database (pseudonymised); **`evidence`** — historical records retrieved from Cognee, ids `E1…En`, never including the record itself; and **`ai`** — generated explanation, similar patterns and suggested steps, each item citing evidence ids (`grounded: false` if it cites none). With no LLM configured, or if the LLM call fails, `ai` is `null` with an `ai_status` explaining why, and the evidence is still returned. The UI renders the three layers in visibly different blocks.

### Tests

```bash
# Python service — real Cognee SDK, graph + vector stores and pipelines; embeddings and the LLM call are
# deterministic offline stand-ins (cognee_service/tests/offline_harness.py, test-only)
cd cognee_service && pip install -r requirements-dev.txt && pytest

# Backend (sync, dedup, projection, pseudonymisation, security, routes — against a recorded service double)
cd backend && npm test

# Frontend dashboard
cd frontend && npm run test:ci

# Live contract test: real backend <-> real service. Offline stand-ins:
#   (cd cognee_service && python -m tests.run_offline_server)
cd backend && COGNEE_E2E_URL=http://127.0.0.1:8765 npm run test:e2e:cognee
# ...or point COGNEE_E2E_URL / COGNEE_E2E_KEY at a service running with your real LLM + embedding keys.
```

### Interactive demo

`demo/fraudguard-demo.html` is a standalone browser demo (no install) with an **AI Memory** page. Offline it uses an in-browser
engine with the same records, pseudonyms, hashes and graph (TF-IDF retrieval, no LLM - its assistant section is labelled
_Computed_, not _AI-generated_); it can optionally connect to a live backend to use real Cognee. See `demo/README.md`.

### Known limitations

- **Real model behaviour is only as good as your configured LLM/embeddings.** The offline stand-ins prove the plumbing, not retrieval quality or the wording of generated text; run the live test with your keys before relying on it.
- **Deletions are not propagated**: if a source record is deleted, its node stays in memory. Removing a transaction from a case does prune the link.
- **Scale**: entity/graph reads load the graph snapshot into memory (cached ~3 s) — fine for tens of thousands of nodes, not millions. Already-synced alert/dispute/case-linked transactions are re-checked by hash on every run.
- **Single instance**: run one scheduler and one service worker; the run lock is a database row with a staleness timeout, not a distributed lock.
- **No currency** is stored by FraudGuard, so amounts are sent as `unspecified`.
- Embedded Cognee stores have a single writer; for multi-writer deployments configure Cognee's Postgres/Neo4j backends (see Cognee docs) — not exercised here.
- Cognee search is an investigative aid, not a fraud decision or compliance determination.
