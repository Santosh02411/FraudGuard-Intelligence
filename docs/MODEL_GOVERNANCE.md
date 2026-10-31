# Model promotion governance

Changing which model scores real transactions is a controlled change. This
document describes what the system enforces, what each check does and does
not prove, and how to operate it.

## Principle

**Shadow-score agreement is not evidence that a challenger is more accurate.**
Two models can agree on every transaction and both be wrong. Agreement is
reported (ML Ops tab) because it is useful for spotting a challenger that
behaves very differently, but it is **not a gate** and nothing in the workflow
counts it as proof. Evidence of accuracy needs **labels**: a labelled
benchmark, and analyst verdicts on real transactions.

## Flow

1. **Train** – `python3 train_model.py` writes `models/registry/vN/` plus a
   signed/hashed `manifest.json`. It **never** activates the version (only the
   very first model on a fresh install is activated, as bootstrap).
2. **Request** – an admin names a version, writes a reason (≥ 20 chars, kept
   permanently), confirms the checklist, and the gates run (Admin → Model
   Changes, or `POST /api/admin/ml/change-requests`).
3. **Approve** – a *different* admin reviews the stored gate report,
   acknowledges every `insufficient` / `warn` gate by id, adds a note.
4. **Apply** – immediately after approval: hard gates are re-run now, the
   serving model must still be the one the request was made against, and the ML
   service re-verifies artifact integrity at the switch. The pointer file is
   written atomically with actor/reason/previous version.
5. **Watch** – rollback triggers run on stored production data; a rollback is
   the same workflow (own checklist, no challenger-evidence gates).

Every request is a row in `model_change_requests` that is never deleted:
who asked, who decided, when, why, from/to version, checklist, the gate report
at request time **and** at apply time, acknowledged gates, apply result.
`GET /api/admin/ml/change-requests` is the promotion history.

## Gates

| Gate | Kind | What it checks |
|---|---|---|
| `artifact_integrity` | hard | every artifact's sha256 matches the training-time manifest; feature-schema hash; HMAC signature when `MODEL_SIGNING_KEY` is set. Nothing is unpickled before this passes. |
| `runtime_compat` | hard | scikit-learn / xgboost / numpy minor versions match those the model was trained with |
| `feature_schema` | hard / warn | the serving pipeline can produce every column; warns if columns differ from the incumbent |
| `smoke_score` | hard | loads and returns a finite probability in [0,1] for a representative row |
| `calibrated` | hard | a calibrator exists (risk thresholds assume calibrated probabilities) |
| `required_metrics` | hard | evaluation protocol, dataset label, test PR-AUC with CI, ECE and capacity metrics present; PR-AUC ≥ `PROMOTION_MIN_PR_AUC`, ECE ≤ `PROMOTION_MAX_ECE`; naive random-split evaluation rejected |
| `benchmark_comparison` | blocking on fail | challenger and incumbent scored **on the same frozen labelled benchmark**, paired bootstrap on PR-AUC and recall@1%/2% review capacity, ECE, and recall per fraud pattern |
| `outcome_evidence` | blocking on fail | challenger's recorded shadow probabilities vs. the incumbent's on real alerts with analyst verdicts |

* **Hard** failures cannot be requested at all.
* A **fail** of `benchmark_comparison` or `outcome_evidence` (challenger is
  worse on labels) also cannot be waved through.
* `insufficient` / `warn` gates can be approved only with an explicit,
  per-gate acknowledgement that is stored.

### The comparison rule (stated, not a feeling)

Fail if the lower 95 % bound of the paired difference (challenger − incumbent)
is below −0.01 PR-AUC, or below −2 points recall at 1 % / 2 % review capacity;
or ECE worsens beyond the allowance; or any fraud pattern with ≥ 20 positives
loses more than 5 points of recall. `pass_better` only if the PR-AUC advantage
is clear. Margins are in `ml_service/evaluation/compare.py`.

### What the evidence does and does not prove

* **The default benchmark is synthetic** (`ml_service/benchmark/`, own seed,
  with a late shift in fraud behaviour). It can reject a regression on the
  patterns our generator produces; it cannot show accuracy on real fraud.
  The gate says so, and a *pass* on a synthetic benchmark is downgraded to a
  `warn` that needs acknowledgement. Set `PROMOTION_BENCHMARK_PATH` to a
  labelled export of real reviewed transactions to make this meaningful.
* **Outcome evidence is selection-biased.** Only alerted transactions get
  verdicts, and alerts exist because the *incumbent* flagged them. It can show
  a challenger ranks flagged cases worse; it cannot show a challenger catches
  fraud the incumbent misses. It needs ≥ `MODEL_OUTCOME_MIN_LABELLED` (100)
  labelled alerts with ≥ 20 of each outcome, otherwise it is `insufficient`.
  Analyst verdicts are themselves imperfect.
* **Integrity ≠ trustworthiness.** Without `MODEL_SIGNING_KEY` the manifest
  detects accidents and casual tampering only (whoever can edit a pickle can
  regenerate an unsigned manifest). With the key (kept outside the registry),
  a forged manifest does not verify. It does not protect against someone who
  holds the key, or a malicious model produced by the real training job.
* v1/v2 predate manifests and cannot be loaded; v3 was adopted with
  `python -m utils.artifacts --adopt` (attests integrity from adoption time,
  not training time, and says so in the manifest).

## Rollback triggers

Computed from stored real traffic (`is_synthetic = 0`) for the serving version
over `MODEL_HEALTH_WINDOW_MINUTES` (since the switch if more recent), with
sample floors so noise cannot trigger anything:

| Trigger | Critical when |
|---|---|
| `latency_p95` | p95 ML call latency > `MODEL_HEALTH_MAX_P95_MS` |
| `fallback_rate` | share of transactions the ML service did not score > `MODEL_HEALTH_MAX_FALLBACK_RATE` (cannot tell an outage from a bad model) |
| `score_distribution` | PSI of served scores vs. the version's training-time score histogram ≥ `MODEL_HEALTH_MAX_PSI` |
| `confirmed_outcomes` | Wilson 95 % **upper** bound of the precision of the model's flags among reviewed alerts < `MODEL_HEALTH_MIN_PRECISION` (verdicts lag) |

Default on a critical breach: record it in `model_health_events` and
**recommend** a rollback. `MODEL_AUTO_ROLLBACK=true` makes the system roll back
itself to the version the last workflow promotion replaced; it appears in the
promotion history under the system actor with the trigger as the reason. It is
opt-in because an automatic action on the decision path should be a conscious
choice. `GET /api/admin/ml/health` shows the current state.

## Four-eyes and self-approval

The requester cannot approve. `MODEL_CHANGE_ALLOW_SELF_APPROVAL=true` exists for
single-operator demos only, marks the decision `[SELF-APPROVED]`, and is
**refused at startup in production**.

## ML monitoring persistence

Drift buffer, shadow-comparison log and the selected shadow version are stored
in SQLite (`MONITOR_DB_PATH`, default `models/monitor.db`) and restored on
startup, per model version. Limits: needs a persistent disk; one ML instance
owns the file (several replicas would need a shared store behind
`utils/monitor_store.py`). The active-version pointer and registry live in
`models/` and need the same persistent disk.

## Operating it

```bash
cd ml_service
export MODEL_SIGNING_KEY=$(openssl rand -hex 32)   # keep outside the registry
python3 train_model.py --notes "monthly retrain"    # candidate, not serving
# Admin UI → ML Ops: set it as shadow model so it scores real traffic
# Admin UI → Model Changes: request → second admin approves
```
