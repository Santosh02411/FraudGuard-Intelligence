# FraudGuard ML Service

Real machine-learning fraud scoring, served as a FastAPI microservice, wired
into the Node backend as a genuine **hybrid engine** — not just an ML model
bolted on next to the old rule engine.

> This is the implementation-level doc (file layout, training CLI, API
> reference). For the narrative version — why hybrid over pure ML, the
> precision/recall trade-offs behind the risk thresholds, and the
> feature-leakage bug covered in section 5 below, written for "walk me
> through how this works" in an interview — see
> [`../docs/METHODOLOGY.md`](../docs/METHODOLOGY.md).

## Authentication (read this before exposing the service)

Every endpoint except `GET /health` requires a key — see
[`utils/auth.py`](utils/auth.py) and the "Production Safety" section of the
top-level README.

- **Service key** (`ML_SERVICE_API_KEY`, header `X-ML-Api-Key`): `/predict`,
  `/metrics`, `/model/versions`, `/model/drift`, `/model/shadow/status`.
- **Admin key** (`ML_ADMIN_API_KEY`, header `X-ML-Admin-Key`): `/model/reload`,
  `/model/rollback`, `/model/drift/reset`, `/model/shadow/set`,
  `/model/shadow/clear`, `/model/shadow/promote`.
- Missing key config -> `503` (fails closed). `ML_AUTH_DISABLED=true` is a
  local-dev-only opt-out and is refused when `ML_ENV` is `production`/`staging`.
- `ML_ENV=production` also requires both keys (>= 32 chars, different) at
  startup and disables `/docs` / `/openapi.json`.
- Tests: `pip install -r requirements-dev.txt && python -m pytest tests -q`.

## Architecture

```
Node backend (routes/transactions.js)
        │
        ├─► analyzeTransactionHybrid()  [backend/models/fraudEngine.js]
        │        │
        │        ├─► Layer 1: checkHardRules()
        │        │     Explainable blacklist/threshold checks. If any hit,
        │        │     the transaction is forced high-risk — OVERRIDES the
        │        │     ML score, doesn't just ignore it. See below.
        │        │
        │        ├─► Layer 2: scoreWithML()  [mlClient.js] ──HTTP──►
        │        │     FastAPI (ml_service/app.py) ──► currently-promoted
        │        │     model (models/registry/, versioned)
        │        │     Returns fraud_score + SHAP-based top_factors.
        │        │
        │        └─► Layer 3: analyzeTransaction()  [rule engine]
        │              Fallback only — used if the ML service is down.
```

This mirrors how Stripe Radar / PayPal-style systems are actually built:
a fast deterministic rules layer for the clean-cut cases (sanctions lists,
absolute caps) that a probabilistic model should never be allowed to waive,
plus a statistical model for everything in between.

## 1. Feature engineering

All of the following are computed from the user's **real transaction
history** (not client-supplied — a client could lie about these):

| Feature                               | How it's computed                                                                                                                           |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `velocity_last_hour`                  | Count of the user's transactions in the last 60 minutes                                                                                     |
| `time_since_last_transaction_minutes` | Gap since their previous transaction                                                                                                        |
| `spending_zscore`                     | `(amount - rolling_mean) / rolling_std` of the user's own transaction history — spending-pattern deviation                                  |
| `ratio_to_median_purchase_price`      | Amount vs. the user's median spend                                                                                                          |
| `geo_distance_from_last_km`           | Haversine distance between this transaction's location and the user's previous one (`utils/geo.py` / `backend/models/geo.js`, kept in sync) |
| `distance_from_home`                  | Haversine distance from the user's most common ("home") location                                                                            |
| `is_new_device`                       | Device fingerprint (SHA-256 hash of the User-Agent header — see caveat below) not seen in the user's history                                |
| `ip_status`                           | `known` / `new` / `unknown` — has this IP been seen for this user before                                                                    |

**Device/IP fingerprinting caveat:** this uses a hashed User-Agent + raw
IP address as a lightweight fingerprint, not a real fingerprinting library.
In production you'd use something like FingerprintJS (canvas/WebGL/font/audio
signals) client-side and a proper IP intelligence service (MaxMind, IPQualityScore)
server-side for real proxy/VPN/datacenter detection. This is a legitimate
simplified version of the same signal — enough to demonstrate "have we
seen this device/IP for this user before" — but say so if asked in an
interview; don't claim it's production-grade device fingerprinting.

## 2. Hybrid engine: hard rules + ML

`backend/models/fraudEngine.js` → `checkHardRules()`:

- **Static blacklist** — known-bad merchants/locations (admin-maintained list; a real system would back this with its own DB table + admin UI).
- **Dynamic blacklist** — any device fingerprint or IP address that appeared on a transaction _already confirmed as fraud_ (from any user) is automatically hard-flagged on its next appearance.
- **Absolute amount cap** ($10,000) — always routed to manual review, no matter how low the model's score is.

If any hard rule fires, `scoring_method` is `"hard_rule_override"` (or
`"hard_rule_override+ml"` if the ML call also succeeded — the ML score is
still computed and returned as `ml_score_for_reference` for transparency,
it just doesn't get the final say). This is a real override, not a
fallback: a transaction can score 3% fraud probability from the model and
still get forced to `risk_level: "high"` if it trips the amount cap or a
blacklist hit.

## 3. Explainability — SHAP

`app.py` builds a `shap.Explainer` per model version at load time (using a
saved 100-row background sample from that version's training data) and
runs it on every `/predict` call. The response's `top_factors` are real
SHAP values — the same theoretically-grounded attribution method used to
explain individual predictions in production fraud systems — not a
heuristic weight×value approximation. `effect` tells you whether each
feature pushed the score toward fraud (`increased_risk`) or away from it.

The Node backend turns these into human-readable reasons (`"Model signal:
is new device (SHAP +0.015)"`) and merges them with the hard-rule reasons
and rule-engine reasons into one `fraud_reasons` list — plus the raw
`shap_explanation` array is stored per-transaction in SQLite for later
inspection.

## 4. Model versioning + retraining pipeline

`train_model.py` never overwrites a model in place. Every run creates a
new version in `models/registry/vN/` (model, scaler, feature columns,
metrics, SHAP background sample, metadata, and an integrity
`manifest.json`) as a **candidate**. Training never activates it: promotion
goes through the approval workflow (gates, a labelled comparison with the
incumbent on `benchmark/promotion_benchmark.csv`, a second admin's approval) —
see `docs/MODEL_GOVERNANCE.md`. Only the first model on a fresh install is
activated automatically. `--force-promote` no longer exists.

New endpoints: `GET /model/versions/{v}/gates`, `POST /model/activate` (admin
key; re-verifies integrity, switches atomically), `GET /model/baseline`.
`POST /model/shadow/promote` returns 410. The service refuses to load any
version whose files do not match their manifest. Drift/shadow monitoring state
is persisted in SQLite (`MONITOR_DB_PATH`).

```
models/
  current_version.json     <- {"version": "v3"} — which one the API loads
  training_log.json        <- append-only history of every training run
  registry/
    v1/ model.pkl  scaler.pkl  feature_columns.json  background_sample.npy  metrics.json  metadata.json
    v2/ ...
    v3/ ...
```

`retrain_pipeline.py` orchestrates a full cycle end-to-end — the way you'd
wire this into a cron job:

```bash
python3 retrain_pipeline.py --simulate-drift --notes "monthly retrain"
```

1. Regenerates transaction data (`--simulate-drift` bumps the fraud rate
   and skew to simulate fraud patterns evolving, so you can see the
   pipeline actually respond to that).
2. Trains + evaluates all 3 candidate models.
3. Promotes the new version only if it's genuinely better.
4. If promoted, calls `POST /model/reload` on the live service — **hot-swaps
   the model with zero downtime**, no restart needed.

API endpoints for managing versions directly:

- `GET /model/versions` — every version in the registry + which is active
- `POST /model/reload` — re-read `current_version.json` and hot-swap
- `POST /model/rollback {"version": "v1"}` — force-activate a specific
  older version (e.g. a bad promotion needs to be walked back)

## 5. Bug found & fixed: feature leakage from constants-in-production

Worth documenting because it's a real, easy-to-make mistake: an earlier
version of `generate_dataset.py` set `repeat_retailer` from whether the
transaction's _category_ was one of the user's declared preferred
categories — which for legit transactions was true almost by construction,
and for fraud was almost always false. That made it a near-perfect,
spurious predictor. Worse, `online_order`/`used_chip`/`used_pin_number`
varied in training data, but **this app is card-not-present only** —
`mlClient.js` sends `online_order: 1, used_chip: 0, used_pin_number: 0` as
hardcoded constants on every live request. The model still learned a
"signal" from them in training, and since serving never varies them, that
signal silently biased every real prediction the same direction.

Caught it because a completely benign **first-ever transaction** (grocery,
home location, no history) scored **99.97% fraud probability**. Fixed by:

- Computing `repeat_retailer` genuinely — same merchant appears in the
  user's actual last-20-transaction window (mirrors `mlClient.js` exactly),
  not a category-membership proxy.
- Removing `used_chip`/`used_pin_number`/`online_order` from the model's
  feature set entirely (`utils/feature_engineering.py` `NUMERIC_COLS`),
  since they're constants in this deployment and can't be predictive of
  anything.

Retraining after the fix dropped PR-AUC from ~0.99 to ~0.94 — that's the
honest number; the 0.99 was measuring how well the model exploited the
leak, not how well it detects fraud. **A metric that drops after fixing a
bug is a good sign, not a regression** — say so if asked, don't hide it.

General lesson worth remembering for any ML pipeline: a feature can only
be genuinely predictive in production if it's actually free to vary in
production. If a field is a constant at serving time, exclude it from
training too, or check that it's varying identically in both.

The dataset (`generate_dataset.py`) is **synthetically generated** by
simulating ~3,000 users' transaction sequences over 90 days, not
downloaded from Kaggle (no network access to Kaggle in this build
environment). It deliberately includes overlap between fraud and
legitimate patterns (some fraud uses a known device/IP — simulating
account takeover; some legit transactions are big-ticket purchases or
rapid bursts) so the model doesn't hit a suspicious 100% — current
numbers land around PR-AUC ~0.99, precision/recall ~0.97 on XGBoost.
Real fraud data is still messier than this; be ready to say so.

**To make this fully legitimate for submission/interviews:**

1. Get the real ULB "Credit Card Fraud Detection" dataset from Kaggle
   (needs a machine with Kaggle access — not available here).
2. Its columns are anonymized (`V1`...`V28` via PCA) plus `Time`/`Amount`/`Class`,
   so `utils/feature_engineering.py` would need to consume those directly
   instead of the categorical/behavioral schema used here.
3. Re-run `train_model.py` — the pipeline itself (SMOTE, class weights,
   evaluation, versioning) doesn't change, only the data-loading step.

I can do this swap for you if you download the CSV and upload it here.

## Running it

```bash
cd ml_service
pip install -r requirements.txt

python3 generate_dataset.py --n_users 3100 --days 90
python3 train_model.py --notes "initial baseline"
uvicorn app:app --host 0.0.0.0 --port 8001
```

Then start the Node backend as usual — `backend/.env` points
`ML_SERVICE_URL` at `http://localhost:8001`. If the ML service isn't
running, transactions still get scored via the rule-engine fallback
(`scoring_method` will say `"rule_engine_fallback"`).

## API reference

- `GET /health` → `{status, version, model_type}`
- `GET /metrics` → evaluation metrics for the active version
- `GET /model/versions` → full registry + active version
- `POST /model/reload` → hot-swap to whatever `current_version.json` says
- `POST /model/rollback {"version": "v1"}` → force-activate a version
- `POST /predict` → score one transaction:

```json
{
  "fraud_score": 100.0,
  "fraud_probability": 1.0,
  "risk_level": "high",
  "is_fraud": 1,
  "model_used": "xgboost",
  "model_version": "v1",
  "top_factors": [
    {
      "feature": "repeat retailer",
      "shap_value": 0.4922,
      "effect": "increased_risk"
    },
    {
      "feature": "is high risk category",
      "shap_value": 0.1055,
      "effect": "increased_risk"
    }
  ]
}
```

## Evaluation, calibration and serving (v3+)

- `train_model.py` uses a chronological, episode-purged 60/20/20 split, selects
  the model on validation PR-AUC, fits a `ProbabilityCalibrator` on validation
  only, and scores the test set once. Metrics are labelled `dataset: synthetic`.
- `/predict` returns `fraud_score` (calibrated probability × 100),
  `fraud_probability`, `raw_probability`, `calibrated`, `model_version`,
  `model_used` and `top_factors`. It no longer returns `risk_level` or
  `is_fraud`: the backend applies the admin-configurable risk policy. Versions
  without `calibrator.pkl` return the raw score with `calibrated: false`.
- Reproduce the experiments with `python3 evaluation/run_synthetic.py`, and
  `python3 evaluation/fetch_public_dataset.py && python3 evaluation/run_public.py`
  for the public ULB dataset (not bundled). See `docs/MODEL_VALIDATION.md`.
