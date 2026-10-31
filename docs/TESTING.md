# Testing & CI

The goal is system guarantees, not feature coverage: the tests target the failure modes that hurt most (wrong money decisions, auth bypass, lost/duplicated writes, outages).

## Layers

| Layer | Where | Run | What it proves |
|---|---|---|---|
| Unit / integration | `backend/tests/{unit,integration,...}` | `npm test` | Rules, auth, RBAC, scoring, alerts/cases, disputes, audit (≈514 tests) |
| Outcomes, cases, relationships | `backend/tests/integration/{modelPerformance,investigations,relationships}.test.js`, `frontend/src/pages/{ModelPerformance,Cases,Relationships}Page.test.js` | `npx jest tests/integration/<file>` | Metric maths on known confusion matrices, one-case-per-alert under a race (SQLite and PostgreSQL), identifier hygiene (private/popular IPs never link), live-scoring safeguards, CSV injection |
| Failure | `backend/tests/failure/` | `npx jest tests/failure` | ML hang/500/garbage/NaN/out-of-range/reset → safe fallback, never a 5xx; DB down → readiness 503, clean errors, rollback, idempotent retry; expired/forged/revoked credentials of every kind |
| In-process E2E | `backend/tests/e2e/journey.test.js` | `npx jest tests/e2e` | register → login → transaction → flagged alert → claim → comment/evidence → rescore → resolve with amounts → dispute → audit timeline → metrics → logout |
| Full-stack E2E | `backend/tests/e2e-fullstack/` | `npm run test:e2e:fullstack` | Same journey against the **real ML service** and a **real backend process** over HTTP |
| Performance | `backend/tests/perf/` | `npm run test:perf` | 300 concurrent transactions (exactly-once, no duplicate alerts/chains, p95 budget), 60 racing idempotent retries, racing resolves, 20k-transaction user + 50k-row table hot paths |
| Postgres | `backend/scripts/test-postgres.sh [files]` | `npm run test:postgres` | Real row locks / unique-index races |
| ML service | `ml_service/tests` | `python -m pytest --cov` | Model, auth, drift, calibration |
| Frontend | `frontend/src/**/*.test.js` | `npm run test:coverage` | Components/pages with mocked API |

Webhook retry behaviour is covered in `tests/integration/integrationSurface.test.js`.

## Coverage thresholds (fail the run when violated)

- Backend global: lines 90 / statements 88 / functions 88 / branches 70 (files with their own entry are excluded from global by Jest).
- Per-file for critical code: `middleware/auth.js`, `apiKeyAuth.js`, `models/fraudEngine.js`, `mlClient.js`, `riskPolicy.js`, `routes/auth.js`, `routes/transactions.js`, `routes/alerts.js`, `services/transactionPipeline.js` (see `backend/package.json`). Thresholds sit just below measured values (e.g. auth.js is 100%), so a regression is caught while normal edits are not blocked.
- Frontend global ≈ 57/52/49/59 (measured 61/56/51/59 — a floor, not a goal). ML: 45% (measured 51%; includes training scripts).

## Performance budgets

Budgets are loose, to catch order-of-magnitude regressions (e.g. a lost index), not noise. Measured on a dev sandbox (SQLite): concurrent p95 ≈ 1 s for 300 requests; scoring for a 20k-history user p95 ≈ 175 ms; alert queue p95 ≈ 12 ms. CI sets `PERF_BUDGET_SCALE=2`. Results are written to `backend/perf-results/*.json`.

## CI (`.github/workflows/ci.yml`)

Jobs: `backend` (lint, tests, coverage gate), `backend-postgres` (fresh DB per suite group), `ml-service`, `frontend` (lint, tests, coverage, production build), `e2e` (full stack), `performance`, and `ready-to-deploy` which `needs:` all of them — make any deploy job depend on it. Each job writes a test/coverage/perf table to the run's step summary and uploads JUnit/coverage/perf artifacts.

## Known limits

- The workflow was validated as YAML and its commands were run locally, but **has not run on real GitHub runners**; expect a first-run fix or two (e.g. Postgres client availability, runner speed vs. budgets).
- Postgres suites share a database; run them per group (as CI does) rather than all at once.
- No browser-driven UI E2E: the E2E layers drive the HTTP API, not the React UI.
- Audit writes are fire-and-forget, so tests poll for audit rows.
- Perf numbers are machine-dependent.

## Rule lab, verification, monitoring (items 14-16)
Backend: `ruleProposals.test.js` (16), `verification.test.js` (18), `modelMonitoring.test.js` (18, ML client mocked). Frontend: `RuleLabPage`, `VerificationPage`, `ModelHealthPanel` tests. ML: `ml_service/tests/test_monitoring.py`. The full-stack E2E additionally runs a monitoring pass against the real model and checks the advisory verification response. Per-file coverage thresholds for the new modules are in `backend/package.json`.

## Profiles, geo-velocity, feedback (items 17-19)
Backend: `unit/geoVelocity`, `unit/customerProfile`, `integration/geoVelocity`, `integration/customerProfiles`, `integration/feedback` (also run on Postgres). ML: `tests/test_retrain.py` (hash check, size guards, candidate-only, single run; trains a small real model). Frontend: `CustomerProfilesPage`, `FeedbackPage`. The full-stack E2E adds a geo-velocity check against the real model and the label/dataset guard rails. The retraining E2E deliberately does not train, so it never writes a candidate into the real registry.
