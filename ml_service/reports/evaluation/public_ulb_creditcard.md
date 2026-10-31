# Model evaluation — public ULB credit-card fraud (real)

> **REAL-DATA RESULTS on a public dataset (ULB/Worldline credit-card fraud, Sept 2013, 2 days). Features are anonymised, so the production model is NOT what is evaluated — the modelling protocol and model families are. Not a measurement of FraudGuard's own accuracy on your traffic.**

Data: `data/public/creditcard.csv` — 284,807 rows, fraud rate 0.173%. Run time 239.0 s.

## A_random_split_naive_baseline

**Split:** random (naive baseline) — rows {'train': 170884, 'validation': 56961, 'test': 56962}, fraud {'train': 307, 'validation': 79, 'test': 106}
**Model chosen on validation PR-AUC:** xgboost {'logistic_regression': 0.6959, 'random_forest': 0.8092, 'xgboost': 0.8171}  
**Calibrator:** sigmoid fitted on 56,961 validation rows (79 frauds).

#### test — calibrated probability

56,962 rows, 106 fraud (0.186%). **PR-AUC 0.7451** (95% CI 0.6606–0.8161; a random ranking would score 0.0019) · ROC-AUC 0.9666 · Brier 0.00068 · ECE 0.00025

| Flag if score ≥ | Flagged | Flag rate | Precision | Recall | False-positive rate | FP | FN |
|---|---|---|---|---|---|---|---|
| 0.05 | 126 | 0.22% | 0.6667 | 0.7925 | 0.074% | 42 | 22 |
| 0.10 | 103 | 0.18% | 0.767 | 0.7453 | 0.042% | 24 | 27 |
| 0.20 | 90 | 0.16% | 0.8333 | 0.7075 | 0.026% | 15 | 31 |
| 0.40 | 82 | 0.14% | 0.878 | 0.6792 | 0.018% | 10 | 34 |
| 0.70 | 75 | 0.13% | 0.9067 | 0.6415 | 0.012% | 7 | 38 |

Fixed review capacity (analysts can only look at the top X% by score):

| Review top | Reviewed | Precision @ capacity | Recall @ capacity | Fraud caught | Fraud missed |
|---|---|---|---|---|---|
| 0.1% | 57 | 0.8947 | 0.4811 | 51 | 55 |
| 0.2% | 142 | 0.5915 | 0.7925 | 84 | 22 |
| 0.5% | 285 | 0.3193 | 0.8585 | 91 | 15 |
| 1.0% | 570 | 0.1632 | 0.8774 | 93 | 13 |

Raw (uncalibrated) model output on the same rows: PR-AUC 0.7694, Brier 0.00189, **ECE 0.00292** → after calibration ECE 0.00025, Brier 0.00068.

Reliability (calibrated):

| Predicted bin | n | Mean predicted | Observed fraud rate | Frauds |
|---|---|---|---|---|
| 0.00-0.01 | 56615 | 0.0002 | 0.0002 | 14 |
| 0.01-0.02 | 154 | 0.0139 | 0.026 | 4 |
| 0.02-0.05 | 67 | 0.0297 | 0.0597 | 4 |
| 0.05-0.10 | 23 | 0.0714 | 0.2174 | 5 |
| 0.10-0.20 | 13 | 0.1382 | 0.3077 | 4 |
| 0.20-0.40 | 8 | 0.3083 | 0.375 | 3 |
| 0.40-0.60 | 4 | 0.4522 | 0.25 | 1 |
| 0.60-0.80 | 5 | 0.6897 | 1 | 5 |
| 0.80-1.00 | 73 | 0.9036 | 0.9041 | 66 |

**Proposed thresholds (score units, from validation):** medium ≥ 1.1, high ≥ 10.3 — medium = score at 0% review capacity on the validation set; high = lowest score with >= 80% validation precision.

## B_chronological

**Split:** chronological by Time — rows {'train': 170884, 'validation': 56961, 'test': 56962}, fraud {'train': 360, 'validation': 57, 'test': 75}
**Model chosen on validation PR-AUC:** logistic_regression {'logistic_regression': 0.7615, 'random_forest': 0.7584, 'xgboost': 0.7471}  
**Calibrator:** sigmoid fitted on 56,961 validation rows (57 frauds).

#### test — calibrated probability

56,962 rows, 75 fraud (0.132%). **PR-AUC 0.7804** (95% CI 0.6931–0.8691; a random ranking would score 0.0013) · ROC-AUC 0.9834 · Brier 0.00047 · ECE 0.00032

| Flag if score ≥ | Flagged | Flag rate | Precision | Recall | False-positive rate | FP | FN |
|---|---|---|---|---|---|---|---|
| 0.05 | 90 | 0.16% | 0.6556 | 0.7867 | 0.054% | 31 | 16 |
| 0.10 | 73 | 0.13% | 0.7397 | 0.72 | 0.033% | 19 | 21 |
| 0.20 | 73 | 0.13% | 0.7397 | 0.72 | 0.033% | 19 | 21 |
| 0.40 | 61 | 0.11% | 0.8525 | 0.6933 | 0.016% | 9 | 23 |
| 0.70 | 50 | 0.09% | 0.98 | 0.6533 | 0.002% | 1 | 26 |

Fixed review capacity (analysts can only look at the top X% by score):

| Review top | Reviewed | Precision @ capacity | Recall @ capacity | Fraud caught | Fraud missed |
|---|---|---|---|---|---|
| 0.1% | 57 | 0.9123 | 0.6933 | 52 | 23 |
| 0.2% | 142 | 0.4296 | 0.8133 | 61 | 14 |
| 0.5% | 285 | 0.2246 | 0.8533 | 64 | 11 |
| 1.0% | 570 | 0.114 | 0.8667 | 65 | 10 |

Raw (uncalibrated) model output on the same rows: PR-AUC 0.7485, Brier 0.03598, **ECE 0.09642** → after calibration ECE 0.00032, Brier 0.00047.

Reliability (calibrated):

| Predicted bin | n | Mean predicted | Observed fraud rate | Frauds |
|---|---|---|---|---|
| 0.00-0.01 | 56804 | 0.0002 | 0.0002 | 13 |
| 0.01-0.02 | 38 | 0.0139 | 0.0526 | 2 |
| 0.02-0.05 | 30 | 0.0351 | 0.0333 | 1 |
| 0.05-0.10 | 17 | 0.0715 | 0.2941 | 5 |
| 0.10-0.20 | 0 | — | — | 0 |
| 0.20-0.40 | 12 | 0.3047 | 0.1667 | 2 |
| 0.40-0.60 | 8 | 0.4831 | 0.125 | 1 |
| 0.60-0.80 | 7 | 0.6937 | 0.8571 | 6 |
| 0.80-1.00 | 46 | 0.8494 | 0.9783 | 45 |

##### Segments by transaction context

| Segment | Rows | Frauds | PR-AUC | Precision @ review thr. | Recall @ review thr. | Precision @ 2% capacity |
|---|---|---|---|---|---|---|
| amount_under_10 | 21786 | 45 | 0.8495 | 0.7083 | 0.7556 | 0.1881 |
| amount_10_to_100 | 25081 | 15 | 0.7815 | 1 | 0.7333 | 0.0518 |
| amount_100_to_1000 | 9560 | 13 | 0.7579 | 0.8889 | 0.6154 | 0.1042 |
| amount_1000_plus | 535 | 2 | too few fraud cases (<5) to report metrics | — | — | — |


**Proposed thresholds (score units, from validation):** medium ≥ 0.5, high ≥ 40.2 — medium = score at 0% review capacity on the validation set; high = lowest score with >= 80% validation precision.

## Limitations

- Only ~2 days of data; the test window is the final 20% (~9.6 hours) with a small number of frauds, so every metric carries a wide confidence interval (shown).
- Anonymised PCA features: the production model's features (velocity, geo-distance, device/IP novelty) do not exist here, so this does not validate that model.
- No customer, merchant or device identifiers: new-customer, unseen-merchant, account-takeover and per-user leakage tests are impossible on this dataset.
- Data is from 2013 European card-present/online mix; fraud tactics and base rates have changed. Treat as a sanity check of the method, not a benchmark of today's fraud.
- Calibration is only valid for a population with this dataset's fraud rate (0.17%); a different base rate shifts true probabilities.
