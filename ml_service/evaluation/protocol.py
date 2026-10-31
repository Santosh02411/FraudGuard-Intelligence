"""
The one fit -> select -> calibrate -> score protocol, used by the production
training script AND every evaluation experiment, so they cannot drift apart.

Rules it enforces (each fixes a leak found in the original pipeline):
  * Candidate models are fitted on TRAIN rows only.
  * The winning model is chosen on VALIDATION PR-AUC — never on the test set
    (choosing on test makes the reported test score optimistic).
  * The probability calibrator is fitted on VALIDATION rows only.
  * TEST rows are scored exactly once, at the end.
"""

import numpy as np

from evaluation.metrics import pr_auc
from utils.modeling import ProbabilityCalibrator, fit_candidates


def fit_select_calibrate(X, y, train_idx, val_idx):
    y = np.asarray(y)
    pos = {k: i for i, k in enumerate(X.index)}
    tr = np.array([pos[i] for i in train_idx])
    va = np.array([pos[i] for i in val_idx])

    scaler, models = fit_candidates(X.iloc[tr], y[tr])
    Xv = scaler.transform(X.iloc[va])
    val_raw = {name: m.predict_proba(Xv)[:, 1] for name, m in models.items()}
    val_pr_auc = {name: round(pr_auc(y[va], p), 4) for name, p in val_raw.items()}
    best = max(val_pr_auc, key=val_pr_auc.get)

    calibrator = ProbabilityCalibrator().fit(val_raw[best], y[va])
    return {
        "scaler": scaler, "models": models, "best": best,
        "val_pr_auc": val_pr_auc, "calibrator": calibrator,
        "val_raw": val_raw[best], "val_calibrated": calibrator.predict(val_raw[best]),
        "val_y": y[va],
    }


def score(fit, X, model_name=None):
    """Returns (raw_probability, calibrated_probability) for rows of X."""
    name = model_name or fit["best"]
    raw = fit["models"][name].predict_proba(fit["scaler"].transform(X))[:, 1]
    return raw, fit["calibrator"].predict(raw)


def recommend_thresholds(y_val, p_val, review_capacity_frac=0.02, high_precision_target=0.80):
    """PROPOSED starting thresholds derived from the validation set — a
    starting point for operators, not a business decision.

      medium (send to review): the lowest score whose flag rate fits the
          assumed analyst capacity (review_capacity_frac of volume).
      high (treat as fraud):  the lowest score at which validation precision
          reaches `high_precision_target`.
    Returned in SCORE units (probability x 100), the unit the API uses.
    """
    y_val = np.asarray(y_val).astype(int)
    p_val = np.asarray(p_val, dtype=float)
    n = len(y_val)
    k = max(1, int(round(review_capacity_frac * n)))
    medium = float(np.sort(p_val)[::-1][k - 1])

    high = None
    for t in np.unique(np.round(p_val, 4)):
        m = p_val >= t
        if m.sum() >= 20 and y_val[m].mean() >= high_precision_target:
            high = float(t)
            break
    if high is None or high <= medium:
        high = min(1.0, max(medium * 2, medium + 0.1))
    return {
        "medium": round(medium * 100, 1), "high": round(high * 100, 1),
        "basis": f"medium = score at {review_capacity_frac:.0%} review capacity on the validation set; "
                 f"high = lowest score with >= {high_precision_target:.0%} validation precision",
    }
