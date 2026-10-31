# Model validation, calibration and decision policy

This document says what has and has not been validated about FraudGuard's
fraud model, and what a fraud score means. Read it before quoting any
accuracy figure.

## 1. Headline caveat

**The production model is trained on synthetic data.** Every accuracy number
for it (PR-AUC ≈ 0.95 etc.) is a *synthetic-data result*: it measures how well
the model recovers fraud patterns that our own generator wrote, not how well
it would catch real fraud. The ML Ops tab, `metrics.json` and the reports
label these numbers accordingly.

What *is* independent: the evaluation **method** was also run on a real public
dataset (section 4), which shows the protocol behaves sensibly on real data
and how much worse real fraud is (PR-AUC ≈ 0.75–0.78 vs ≈ 0.95).

## 2. Protocol

| Concern | What we do |
|---|---|
| Time leakage | Chronological 60/20/20 split by timestamp. Train < validation < test in time. |
| Fraud-scenario leakage | Fraud *episodes* (same user, gap ≤ 24 h) are never split across a boundary; straddling episodes are purged. |
| User leakage | Experiment C holds out 20 % of users entirely (never seen in training or validation). |
| Model selection | Chosen on **validation** PR-AUC. The test set is scored once. |
| Calibration | `ProbabilityCalibrator` (isotonic if ≥ 200 validation positives, else sigmoid), fitted on **validation only**. |
| Metrics | PR-AUC with bootstrap 95 % CI, ROC-AUC, Brier, ECE, precision, recall, false-positive rate, FP/FN counts, precision/recall at fixed review capacity (top 0.5 %–5 % by score), reliability tables. |
| Segments | Known vs unseen users; first 3 transactions of unseen users (cold start); first-time merchant for the user, repeat retailer and established-customer segments; by fraud type (stolen card vs account takeover on a known device and IP). |
| Pattern shift | Experiment D: train on old fraud patterns, test on a later period where fraud becomes "low and slow". |

Run it yourself:

```bash
cd ml_service
python3 evaluation/run_synthetic.py        # synthetic experiments A–D → reports/evaluation/synthetic.{json,md}
python3 evaluation/fetch_public_dataset.py # downloads the public ULB dataset (not bundled)
python3 evaluation/run_public.py           # → reports/evaluation/public_ulb_creditcard.{json,md}
```

Retraining (`python3 train_model.py`) uses the same protocol. A candidate
trained under a different protocol than the incumbent is **not** promoted
automatically (`--force-promote` required), because the numbers are not
comparable.

## 3. Synthetic-data results (labelled as such)

| Experiment | PR-AUC (95 % CI) | Notes |
|---|---|---|
| A. random split (naive baseline) | 0.943 (0.924–0.959) | The generator has no temporal structure, so random splitting is *not* visibly inflated here. On real data it can be. |
| B. chronological, purged | 0.954 (0.936–0.971) | Headline synthetic number. |
| C. known users, future | 0.954 (0.932–0.974) | |
| C. **unseen users** | 0.945 (0.896–0.982) | 76 frauds; wide interval. |
| C2. **first 3 txns of unseen users** | 0.909 (0.814–0.979) | 28 frauds only; indicative. At 2 % review capacity: precision 0.69, recall 0.89. |
| D. **fraud-pattern shift** | **0.021** (0.018–0.025) | Random is 0.014. The model essentially fails on a pattern it never saw. |

Findings worth acting on:

* **Pattern shift breaks detection.** Experiment D is the most important
  result: trained on old behaviour, the model is near random on "low and slow"
  fraud. Calibration error also rises (ECE 0.001 → 0.013), so *outcome-based*
  calibration monitoring (section 6) would notice, but the feature-based drift
  monitor would not, because the inputs look normal. Plan for retraining and
  for hard rules as a backstop.
* **Raw model output is not a probability.** Class weights/SMOTE inflate it
  (raw ECE 0.016, calibrated 0.0005). Only the calibrated value is served as
  the score.
* **Hard-rule precision is 100 % on synthetic data by construction** (the
  generator plants the blacklisted merchants/locations in fraud). It says
  nothing about real rule precision; the system measures this live (section 6).

## 4. Real public data: ULB credit-card fraud

Dataset: ULB / Worldline "Credit Card Fraud Detection" (Dal Pozzolo et al.),
284,807 transactions over 2 days, 0.173 % fraud, anonymised PCA features,
licensed under the Open Database License (DbCL). It is **not bundled** with
this repository; `fetch_public_dataset.py` downloads it and prints the licence
and citation.

| Split | PR-AUC (95 % CI) | ECE raw → calibrated |
|---|---|---|
| Random | 0.745 (0.661–0.816) | 0.0029 → 0.0003 |
| Chronological | 0.780 (0.693–0.869) | 0.0964 → 0.0003 |

What this does and does not show:

* It validates the **protocol** (chronological splitting, validation-only
  calibration) and shows realistic fraud is much harder than our synthetic data.
* It does **not** validate FraudGuard's production model: the features are
  anonymised, so velocity / geo / device features do not exist here.
* It **cannot** test new users, unseen merchants or account takeover, because
  the dataset has no customer, merchant or device identifiers.
* Two days, 75 test frauds: intervals are wide. 2013 European data; not a
  benchmark of current fraud.

**What is still missing:** a dataset with customer/merchant/device identifiers
and real timestamps would be needed to test the segments in section 2 on real
data. Until FraudGuard is run on real labelled traffic, treat the synthetic
numbers as a regression test, not a promise.

## 5. What a score means

`fraud_score = calibrated P(fraud) × 100`, estimated on a held-out validation
population with a ≈ 1.5 % fraud rate.

* A score of 80 means: among comparable transactions in that validation
  population, about 80 in 100 were fraud.
* It is a probability for **that base rate**. If real traffic has a much
  different fraud rate, true probabilities shift; this is why section 6 exists.
* Three things are kept apart:

| Layer | Field | Meaning |
|---|---|---|
| Model probability | `model_probability`, `fraud_score` | Calibrated P(fraud). No decision. |
| Policy decision | `risk_level`, `is_fraud`, `policy_version` | Thresholds applied to the score. Admin-configurable, versioned. |
| Confirmed outcome | `alerts.verdict` (`confirmed_fraud` / `false_positive`), disputes | What an analyst concluded. Never written by the model. |

The ML service no longer returns a risk level; the backend applies the active
policy. Models without a calibrator serve the raw score with
`calibrated: false`, and the system does not claim a probabilistic meaning for it.

## 6. Thresholds and monitoring

**Risk policy** (`risk_policy` table, Admin → Risk Policy): a review threshold
(`medium_threshold`), a fraud threshold (`high_threshold`) and an optional
review capacity per day. Bounds and minimum gap are enforced server-side; a
change note (≥ 10 characters) is mandatory; each save is a new, append-only
version, audited with before/after values; every transaction records the
`policy_version` that decided it. Admin-only.

Default policy: review at score ≥ 10 (a one-in-ten chance of fraud), fraud at ≥ 50.
The v3 validation set suggests review ≥ 4.1 and fraud ≥ 16.7 (2 % review
capacity, 80 % precision) which are looser; operators should choose using the
simulator and their real review capacity rather than relying on defaults.

**Threshold simulator** (`POST /api/admin/risk-policy/simulate`): replays
recent history under candidate thresholds and reports flagged volume,
confirmed fraud caught/missed, legitimate transactions flagged, and whether it
exceeds review capacity. Limitation, stated in the API response: only flagged
transactions get verdicts, so labels exist only at or above the lowest alert
score. Lowering a threshold below that line reports volume but **cannot**
estimate precision for the newly flagged rows, and the response warns about it.

**Calibration monitor** (`GET /api/admin/risk-policy/calibration`): per score
band, predicted probability vs observed confirmed-fraud rate with Wilson 95 %
intervals. Status: `insufficient_data` (< 30 reviewed alerts or no band with
≥ 20), `consistent`, or `drifting`. Customer disputes on unflagged
transactions are reported as weak evidence of missed fraud, never as proof.

**Hard-rule overrides** bypass the model and are evaluated separately:
precision per decision path, and how many overrides the model alone would not
have flagged. The rule-engine fallback keeps its own fixed 40/70 rule-point
bands, independent of the policy.

## 7. Known limitations

* No real-world labelled data on FraudGuard's own features has been used.
* Synthetic fraud is generated by the same author as the detector; shift
  results show fragility, not real-world robustness.
* Verdict-based monitoring suffers selection bias (only flagged transactions
  are reviewed) and analyst error.
* Calibration depends on the base rate; recalibrate when fraud prevalence changes.
