# Rule simulation, risk-based verification, persistent monitoring

## 14. Rule Lab (`/rule-lab`, API `/api/v1/rule-proposals`, admin only)
A proposal is a set of rule changes (add/update/enable/disable/delete) and/or a risk-policy change.
Lifecycle: `draft -> simulated -> approved -> active -> rolled_back` (or `rejected`).
- **Simulate**: replays historical, non-synthetic transactions through the *current* and the *proposed* configuration (`hard rules` + policy level from the stored model probability). Flagged = hard-rule hit OR level != low. Reports flagged counts, newly/no-longer flagged, and a confusion matrix with Wilson intervals where analyst/outcome labels exist.
- **Approve** needs a fresh simulation (`STALE_SIMULATION`) and a different admin (`SELF_APPROVAL`; dev-only override `RULE_APPROVAL_ALLOW_SELF`).
- **Activate** re-checks the base (`STALE_BASE`) and applies rules + policy atomically. **Rollback** applies the inverse patch; `ROLLBACK_CONFLICT` if later edits touched the same rules.
- `RULE_CHANGES_REQUIRE_PROPOSAL=true` makes direct edits to `/fraud-rules` and `/risk-policy` return 409 `PROPOSAL_REQUIRED`.

**Limits**: the dynamic device/IP reputation list and relationship overrides are not replayed. Unflagged, unreviewed traffic is *presumed* legitimate, so false-positive/negative estimates are biased and are labelled as such in the report.

## 15. Risk-based verification (`/verification`, API `/api/v1/verification`)
Modes: `off`, `advisory` (record the recommendation only), `enforce` (needs `confirm_enforce`). Per risk band: low = approve; medium = approve|challenge; high = approve|challenge|decline. Optional `min_amount`, challenge TTL.
- Outcomes recorded per challenge: `verified`, `failed`, `abandoned`, `expired`; each is one DB transaction with compare-and-set, so a challenge resolves once. Re-use returns 409 `CHALLENGE_REPLAY` / `CHALLENGE_EXPIRED` and is counted in `replay_attempts`.
- A background sweep expires overdue challenges (`VERIFICATION_SWEEP_INTERVAL_MS`).
- `GET /effectiveness` reports completion/failure/abandon rates, time-to-complete, and amounts held/blocked vs. later-confirmed fraud. **These are observational, not causal.**
- **Separation from payments**: FraudGuard recommends and records. Responses carry `authorization.performed: false`; no payment is ever authorized or captured here. The live-feed simulator (`is_synthetic`) never creates challenges. Enforce without a webhook channel degrades to approve (`no_verification_channel`).

## 16. Persistent drift monitoring (`/model-monitoring`, shown on Model Performance -> "Health & drift")
- Every real scoring attempt is written to `model_inference_log` (no PII; amount band, category, card type, device class, latency, ML error kind, missing features, fallback flag).
- The monitor (`MONITORING_INTERVAL_MS`, or `POST /run`) sends each window x segment batch to the ML service's `POST /model/drift/evaluate` (reusing the existing training baseline and PSI code) and persists results in `drift_snapshots`.
- Alerts reuse `model_health_events` (open -> updated -> superseded/cleared, acknowledge). Thresholds and minimum sample sizes live in `monitoring_settings`.
- Operations view: missing features, prediction failures, latency p50/p95, fallback rate.
- Quality: once outcome labels exist, 30-day quality snapshots are stored; `quality_decline` opens only if Wilson intervals do not overlap an earlier (>= 7 day) snapshot.
- Drift alerts state that input drift is a warning, not proof of lower accuracy, and attach quality evidence (`no_labels_yet` / `decline_observed` / `no_decline_observed`). Drift never triggers a rollback.

**Limits**: needs the ML service for feature PSI; labels lag and are selection-biased; small segments are skipped below the minimum sample; `fallback_rate` currently equals `failure_rate`; the ML service's own `monitor.db` is single-instance.
