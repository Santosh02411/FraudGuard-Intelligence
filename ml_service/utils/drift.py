"""
Feature & Score Drift Monitoring
===================================
Tracks whether the distribution of incoming production traffic has
drifted away from the distribution the currently-active model was
trained on, using Population Stability Index (PSI) — the standard
metric for this in production ML/credit-risk systems, chosen
specifically because it stays meaningful with NO ground-truth labels
for live traffic (which we never have in real time here — a
transaction's true fraud/not-fraud label, if it ever arrives at all,
comes later via an analyst's alert resolution, not at prediction time).
PR-AUC and the other metrics in metrics.json answer "how good was the
model on held-out TRAINING data"; this answers a different question —
"does live traffic still look like the data it was trained on at all."

This module is imported by BOTH train_model.py (to compute and save
`baseline_stats.json` once per trained version) and app.py (to compare
live traffic against that baseline on demand via GET /model/drift) —
same reasoning as feature_engineering.py being shared between train and
serve: one definition, used both places, so they can't drift apart from
each other.

PSI interpretation (industry rule of thumb):
    < 0.1     -> no significant population change
    0.1-0.25  -> moderate shift, worth a look
    >= 0.25   -> significant shift, investigation/retraining warranted
"""

import numpy as np

# Score at/above which a transaction counts as "high-risk" for the drift
# comparison. Scores are calibrated probabilities x 100; this is a monitoring
# reference point, NOT the policy threshold (that lives in the backend's
# admin-configurable risk policy).
DRIFT_HIGH_SCORE = 50

NUM_BINS = 10
PSI_MODERATE = 0.1
PSI_SIGNIFICANT = 0.25


def compute_baseline_stats(df, numeric_features, binary_features, score_stats=None):
    """Called once at training time (train_model.py), on the full
    engineered training dataset.

    - Numeric (continuous) features: quantile-bin edges + the
      training-set proportion of rows in each bin.
    - Binary/one-hot features (always 0/1): just the training-set mean
      (proportion of 1s) — PSI on a 2-valued feature reduces to
      comparing two proportions, so full histogram binning would be
      needless ceremony.
    - `score_stats`, if provided, is the trained model's own predicted-
      probability distribution on its held-out test set (mean, std,
      high-risk rate) — see train_model.py — so live prediction scores
      can be compared against it too, not just the input features.
    """
    stats = {"numeric": {}, "binary": {}}
    for col in numeric_features:
        if col not in df.columns:
            continue
        values = df[col].astype(float).values
        edges = np.unique(np.quantile(values, np.linspace(0, 1, NUM_BINS + 1)))
        if len(edges) < 3:
            continue  # degenerate/near-constant feature: not worth drift-tracking
        counts, _ = np.histogram(values, bins=edges)
        proportions = (counts / max(counts.sum(), 1)).tolist()
        stats["numeric"][col] = {"edges": edges.tolist(), "proportions": proportions}
    for col in binary_features:
        if col not in df.columns:
            continue
        stats["binary"][col] = {"mean": float(df[col].astype(float).mean())}
    if score_stats:
        stats["score"] = score_stats
    return stats


def _psi_numeric(edges, baseline_props, live_values, eps=1e-4):
    live_values = np.asarray(live_values, dtype=float)
    counts, _ = np.histogram(live_values, bins=edges)
    live_props = counts / max(counts.sum(), 1)
    psi = 0.0
    for b, l in zip(baseline_props, live_props):
        b = max(b, eps)
        l = max(l, eps)
        psi += (l - b) * np.log(l / b)
    return float(psi)


def _psi_binary(baseline_mean, live_values, eps=1e-4):
    live_mean = float(np.mean(live_values)) if len(live_values) else baseline_mean
    b1, b0 = max(baseline_mean, eps), max(1 - baseline_mean, eps)
    l1, l0 = max(live_mean, eps), max(1 - live_mean, eps)
    return float((l1 - b1) * np.log(l1 / b1) + (l0 - b0) * np.log(l0 / b0))


def compute_drift_report(baseline_stats, live_rows_df, live_scores=None):
    """`live_rows_df`: a DataFrame of engineered (post feature-alignment,
    pre-scaling) rows collected from recent /predict calls — see app.py's
    STATE["live_buffer"]. `live_scores`: the corresponding fraud_score
    (0-100) values, for the separate score-distribution comparison.
    """
    feature_psi = {}
    for col, b in baseline_stats.get("numeric", {}).items():
        if col not in live_rows_df.columns:
            continue
        feature_psi[col] = round(_psi_numeric(b["edges"], b["proportions"], live_rows_df[col].values), 4)
    for col, b in baseline_stats.get("binary", {}).items():
        if col not in live_rows_df.columns:
            continue
        feature_psi[col] = round(_psi_binary(b["mean"], live_rows_df[col].values), 4)

    flagged = {k: v for k, v in feature_psi.items() if v >= PSI_MODERATE}
    significant = {k: v for k, v in feature_psi.items() if v >= PSI_SIGNIFICANT}
    status = "significant_drift" if significant else ("moderate_drift" if flagged else "stable")

    report = {
        "status": status,
        "n_samples": len(live_rows_df),
        "feature_psi": feature_psi,
        "flagged_features": flagged,
    }

    score_baseline = baseline_stats.get("score")
    if score_baseline and live_scores is not None and len(live_scores) > 0:
        live_scores = np.asarray(live_scores, dtype=float)
        report["score_drift"] = {
            "baseline_mean_score": round(score_baseline["mean"], 2),
            "live_mean_score": round(float(np.mean(live_scores)), 2),
            "baseline_high_risk_rate": round(score_baseline["high_risk_rate"], 4),
            "live_high_risk_rate": round(float(np.mean(live_scores >= DRIFT_HIGH_SCORE)), 4),
        }

    return report
