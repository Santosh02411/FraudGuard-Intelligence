"""
Evaluation metrics for a rare-event fraud classifier.

Accuracy and ROC-AUC are useless headline numbers at a ~1% fraud rate, so
everything here is about what an operations team actually experiences:
how many alerts do analysts get, what share of them are real, how much
fraud slips through, and how many good customers get flagged.
"""

import numpy as np
from sklearn.metrics import average_precision_score, brier_score_loss, roc_auc_score


def pr_auc(y, p):
    y = np.asarray(y)
    return float(average_precision_score(y, p)) if y.sum() > 0 else float("nan")


def operating_point(y, p, threshold):
    """Confusion-matrix metrics when everything with p >= threshold is flagged."""
    y = np.asarray(y).astype(int)
    flagged = np.asarray(p) >= threshold
    tp = int((flagged & (y == 1)).sum())
    fp = int((flagged & (y == 0)).sum())
    fn = int((~flagged & (y == 1)).sum())
    tn = int((~flagged & (y == 0)).sum())
    n = len(y)
    return {
        "threshold": float(threshold),
        "flagged": tp + fp,
        "flag_rate": round((tp + fp) / n, 6) if n else None,
        "precision": round(tp / (tp + fp), 4) if (tp + fp) else None,
        "recall": round(tp / (tp + fn), 4) if (tp + fn) else None,
        "false_positive_rate": round(fp / (fp + tn), 6) if (fp + tn) else None,
        "tp": tp, "fp": fp, "fn": fn, "tn": tn,
    }


def threshold_sweep(y, p, thresholds):
    return [operating_point(y, p, t) for t in thresholds]


def capacity_point(y, p, capacity_frac):
    """Review ONLY the highest-scored `capacity_frac` share of transactions
    (e.g. 0.01 = analysts can look at 1% of volume). Ties at the cutoff are
    broken by index order, so the review set is exactly k rows."""
    y = np.asarray(y).astype(int)
    p = np.asarray(p, dtype=float)
    n = len(y)
    k = max(1, int(round(capacity_frac * n)))
    order = np.argsort(-p, kind="stable")[:k]
    tp = int(y[order].sum())
    total_pos = int(y.sum())
    return {
        "capacity_frac": capacity_frac,
        "reviewed": k,
        "precision_at_capacity": round(tp / k, 4),
        "recall_at_capacity": round(tp / total_pos, 4) if total_pos else None,
        "fraud_caught": tp,
        "fraud_missed": total_pos - tp,
        "score_at_cutoff": round(float(p[order[-1]]), 6),
    }


def bootstrap_ci(metric_fn, y, p, n_boot=300, seed=0, alpha=0.05):
    """Percentile bootstrap CI. Fraud is rare, so test sets hold few
    positives and point estimates can be far less certain than they look —
    this makes that visible instead of implied."""
    y = np.asarray(y)
    p = np.asarray(p)
    rng = np.random.default_rng(seed)
    n = len(y)
    vals = []
    for _ in range(n_boot):
        idx = rng.integers(0, n, n)
        if y[idx].sum() == 0:
            continue
        vals.append(metric_fn(y[idx], p[idx]))
    if not vals:
        return [None, None]
    lo, hi = np.percentile(vals, [100 * alpha / 2, 100 * (1 - alpha / 2)])
    return [round(float(lo), 4), round(float(hi), 4)]


def calibration_table(y, p, edges=(0, 0.01, 0.02, 0.05, 0.1, 0.2, 0.4, 0.6, 0.8, 1.0001)):
    """Reliability table: within each predicted-probability bin, the mean
    prediction vs the observed fraud rate. A calibrated model has them equal."""
    y = np.asarray(y).astype(int)
    p = np.asarray(p, dtype=float)
    rows = []
    for lo, hi in zip(edges[:-1], edges[1:]):
        m = (p >= lo) & (p < hi)
        n = int(m.sum())
        rows.append({
            "bin": f"{lo:.2f}-{min(hi, 1.0):.2f}",
            "n": n,
            "mean_predicted": round(float(p[m].mean()), 4) if n else None,
            "observed_fraud_rate": round(float(y[m].mean()), 4) if n else None,
            "fraud_count": int(y[m].sum()) if n else 0,
        })
    return rows


def expected_calibration_error(y, p, n_bins=10):
    """ECE with equal-width bins (weighted mean |predicted - observed|)."""
    y = np.asarray(y).astype(int)
    p = np.asarray(p, dtype=float)
    bins = np.linspace(0, 1, n_bins + 1)
    ece = 0.0
    for lo, hi in zip(bins[:-1], bins[1:]):
        m = (p >= lo) & ((p < hi) if hi < 1 else (p <= hi))
        if m.any():
            ece += m.mean() * abs(p[m].mean() - y[m].mean())
    return round(float(ece), 5)


def summary(y, p, review_thresholds=(0.05, 0.1, 0.2, 0.4, 0.7), capacities=(0.005, 0.01, 0.02, 0.05)):
    """The full metric block reported for every evaluation."""
    y = np.asarray(y).astype(int)
    p = np.asarray(p, dtype=float)
    return {
        "n": int(len(y)),
        "n_fraud": int(y.sum()),
        "fraud_rate": round(float(y.mean()), 6),
        "pr_auc": round(pr_auc(y, p), 4),
        "pr_auc_95ci": bootstrap_ci(pr_auc, y, p),
        "roc_auc": round(float(roc_auc_score(y, p)), 4) if 0 < y.sum() < len(y) else None,
        "brier": round(float(brier_score_loss(y, np.clip(p, 0, 1))), 5),
        "ece": expected_calibration_error(y, p),
        "baseline_pr_auc_if_random": round(float(y.mean()), 4),
        "operating_points": threshold_sweep(y, p, review_thresholds),
        "review_capacity": [capacity_point(y, p, c) for c in capacities],
        "calibration": calibration_table(y, p),
    }
