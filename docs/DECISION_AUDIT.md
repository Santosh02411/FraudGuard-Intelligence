# Decision auditability

Goal: an investigator can reconstruct **exactly why a transaction was flagged**, long after the model, rules and thresholds have changed.

## What is recorded for every decision (`decision_records`)

| Evidence | Where |
|---|---|
| Model name/version, raw and calibrated probability, calibrated yes/no | `model_*`, `raw_probability`, `calibrated` |
| Rule-set version + content hash (`rule_set_versions` keeps every distinct configuration) | `ruleset_version`, `ruleset_hash` |
| Decision thresholds **copied** at decision time (risk-policy version, or the fixed rule-engine 40/70 for fallback, or "fixed by hard rule") | `thresholds`, `policy_version` |
| Source of the result: `ml`, `hard_rule`, or `fallback` (+ the exact `scoring_method`, e.g. `ml_model+calibration_floor+network_watch`) | `decision_source`, `scoring_method` |
| Feature snapshot the model received, with its SHA-256 | `feature_snapshot`, `features_sha256` |
| Reasons, hard-rule flags, SHAP factors | `reasons`, `hard_flags`, `shap` |
| Context: ML error/latency if it fell back, rule-engine score, calibration guard, network-signal *counts* | `context` |
| Who/why for rescores | `actor_*`, `reason` |

The original decision is `seq 1`, written **in the same database transaction** as the transaction row (`services/transactionPipeline.js`).

## Rescoring never overwrites

`POST /api/v1/admin/transactions/:id/rescore {reason, apply?}` appends `seq n` (`decision_type = rescore`).
It sends the **stored feature snapshot** to the **current** model and applies the **current** rules/policy. By default it is recorded only (`applied = 0`) and the transaction keeps its decision; `apply: true` makes it effective (alert created if newly flagged, audit entry with before/after). It is refused (503) if the ML service is down, so a fallback result is never passed off as a rescore.

## Append-only + tamper evidence

* Database **triggers** (SQLite and Postgres) reject `UPDATE`/`DELETE` on `decision_records` and `audit_logs`. Only the retention job (or the demo reset / tests) opens the retention gate, and even then only snapshot/SHAP redaction and deletion are permitted — never edits to a decision's content.
* Each record has `record_hash = sha256(fields + prev_hash)`, chained per transaction. `GET .../decision-history` and `.../decision-history/verify` recompute it. Hashes cover the *digest* of the snapshot/SHAP, so redaction does not break the chain.

**Limits (be honest about them):** a database superuser can drop the triggers and recompute hashes; the chain is per transaction and is tamper-*evident* only if hashes are also exported/anchored somewhere the attacker cannot reach. Transactions that predate this feature get a lazily created baseline record marked `origin = backfill`: the original inputs, rule-set version and thresholds were **not** captured then and are not invented now. Rescore blacklists use *current* fraud knowledge.

## Investigator and admin changes

Audit entries now carry `before`/`after` values (alert resolve/assign, dispute transitions, rule create/update/delete, role changes, risk-policy changes, rescores, legal holds, retention runs). Free-text notes are *not* copied into the audit trail (only `hasNote`). `GET /api/v1/admin/transactions/:id/decision-history` returns one merged, time-ordered timeline of decisions and these actions.

## What is deliberately not logged

Passwords, tokens, API keys, cookies, OTP/challenge values, authorization headers: `auditLogRepository.sanitizeDetails` redacts such keys (any depth), JWT/bearer/long-hex-looking values, and truncates long strings. Feature snapshots hold behavioural features only — **no raw IP, device fingerprint, name or email** (only derived `is_new_device` / `ip_status`); network context is stored as counts. `audit_logs.ip_address` (the request's IP) is still stored for the audit trail and is covered by the audit retention window.

## Retention (`services/retentionService.js`)

| Setting | Default | Effect |
|---|---|---|
| `SNAPSHOT_REDACTION_DAYS` | 400 | feature snapshot + SHAP blanked, `redacted_at` set; record, reasons, versions, thresholds, hash remain |
| `DECISION_RETENTION_DAYS` | 2555 | a transaction's decision history is deleted only when **all** its records are older |
| `AUDIT_RETENTION_DAYS` | 2555 | audit rows older than this are deleted |
| `RETENTION_AUTO_RUN` / `RETENTION_INTERVAL_HOURS` | false / 24 | scheduled runs are off unless enabled |

Transactions under an active **legal hold** (`POST/DELETE /admin/transactions/:id/legal-holds`) or with an **open dispute** are never touched. `POST /admin/retention/run` is a dry run by default; a real run needs `dry_run:false` and a reason. Every run (dry or real) is stored in `retention_runs` with counts and a digest. Note: choose retention windows with your legal/compliance team; the defaults are placeholders, not advice.
