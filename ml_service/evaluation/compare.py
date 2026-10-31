"""
Challenger vs incumbent on the SAME labelled dataset
========================================================
Shadow-score agreement says two models behave alike, not which one is right.
This compares a candidate registry version with the incumbent on one
labelled benchmark that both are scored on, row for row, using
LABELS:

  * PR-AUC for each, and the PAIRED bootstrap difference (resampling the same
    rows for both models, so the comparison is not blurred by sampling noise);
  * recall and precision at fixed analyst review capacity (top 1% / 2%);
  * false-positive rate at the reference review threshold;
  * calibration (ECE) of each;
  * recall per fraud pattern (stolen card / account takeover / shifted), so a
    candidate that gains on average by giving up a whole fraud type is caught.

The verdict is a stated rule, not a feeling (see `decide`):
  fail         challenger is worse than the incumbent by more than the margin
  pass         non-inferior on every check
  pass_better  non-inferior AND its PR-AUC advantage is statistically clear

The benchmark must not have been used to train either model. The default is a
frozen synthetic file (benchmark/promotion_benchmark.csv, own seed, with a late
shift in fraud behaviour). It is SYNTHETIC: it can reject a regression, but it
cannot prove accuracy on real traffic. Point PROMOTION_BENCHMARK_PATH at a
labelled export of real reviewed transactions (same columns as the training
CSV) to make this meaningful.
"""

import json
import os

import joblib
import numpy as np
import pandas as pd

from evaluation import metrics as M
from utils import artifacts
from utils.feature_engineering import engineer_features, align_columns

DEFAULT_BENCHMARK = "benchmark/promotion_benchmark.csv"
REFERENCE_THRESHOLD = 0.10     # probability: the default review threshold (score 10)
CAPACITIES = (0.01, 0.02)

# Non-inferiority margins (absolute).
PR_AUC_MARGIN = 0.01
RECALL_MARGIN = 0.02
SEGMENT_RECALL_MARGIN = 0.05
ECE_ALLOWANCE = 0.01
ECE_FLOOR = 0.02
MIN_SEGMENT_POSITIVES = 20


def benchmark_path():
    return os.environ.get("PROMOTION_BENCHMARK_PATH", DEFAULT_BENCHMARK)


def load_version(registry_dir, version, require_integrity=True):
    """Loads a registry version for SCORING ONLY. Verifies the manifest first,
    because loading a pickle executes code."""
    version_dir = os.path.join(registry_dir, version)
    if require_integrity:
        report = artifacts.verify(version_dir)
        if not report["ok"]:
            failed = [c["name"] for c in report["checks"] if not c["ok"]]
            raise ValueError(f"{version}: integrity check failed ({', '.join(failed)}) — refusing to load")
    with open(os.path.join(version_dir, "feature_columns.json")) as f:
        cols = json.load(f)
    cal_path = os.path.join(version_dir, "calibrator.pkl")
    return {
        "version": version,
        "model": joblib.load(os.path.join(version_dir, "model.pkl")),
        "scaler": joblib.load(os.path.join(version_dir, "scaler.pkl")),
        "calibrator": joblib.load(cal_path) if os.path.exists(cal_path) else None,
        "columns": cols,
    }


def score_dataset(loaded, X):
    aligned = align_columns(X.copy(), loaded["columns"])
    raw = loaded["model"].predict_proba(loaded["scaler"].transform(aligned))[:, 1]
    cal = loaded["calibrator"].predict(raw) if loaded["calibrator"] is not None else raw
    return raw, cal


def _recall_at(y, p, frac):
    return M.capacity_point(y, p, frac)["recall_at_capacity"] or 0.0


def _paired_bootstrap(y, p_a, p_b, fn, n_boot, seed):
    """Distribution of fn(b) - fn(a) over resamples of the SAME rows."""
    rng = np.random.RandomState(seed)
    n = len(y)
    diffs = []
    for _ in range(n_boot):
        idx = rng.randint(0, n, n)
        yb = y[idx]
        if yb.sum() == 0:
            continue
        diffs.append(fn(yb, p_b[idx]) - fn(yb, p_a[idx]))
    diffs = np.asarray(diffs)
    return {
        "mean": float(diffs.mean()), "ci95": [float(np.percentile(diffs, 2.5)), float(np.percentile(diffs, 97.5))],
        "n_boot": int(len(diffs)),
    }


def _psi(a, b, bins=10, eps=1e-4):
    edges = np.unique(np.quantile(a, np.linspace(0, 1, bins + 1)))
    if len(edges) < 3:
        return 0.0
    ca, _ = np.histogram(a, bins=edges)
    cb, _ = np.histogram(np.clip(b, edges[0], edges[-1]), bins=edges)
    pa, pb = np.maximum(ca / ca.sum(), eps), np.maximum(cb / cb.sum(), eps)
    return float(np.sum((pb - pa) * np.log(pb / pa)))


def _model_block(y, p_cal, p_raw, calibrated):
    return {
        "calibrated": calibrated,
        "pr_auc": round(M.pr_auc(y, p_cal), 4),
        "pr_auc_ci95": M.bootstrap_ci(M.pr_auc, y, p_cal, n_boot=200, seed=1),
        "ece": round(M.expected_calibration_error(y, p_cal), 5) if calibrated else None,
        "at_capacity": {f"{int(c * 100)}%": {k: round(v, 4) if isinstance(v, float) else v for k, v in M.capacity_point(y, p_cal, c).items()} for c in CAPACITIES},
        "at_reference_threshold": {k: round(v, 5) if isinstance(v, float) else v for k, v in M.operating_point(y, p_cal, REFERENCE_THRESHOLD).items()} if calibrated else None,
        "raw_pr_auc": round(M.pr_auc(y, p_raw), 4),
    }


def decide(report):
    """The stated non-inferiority rule. Returns (status, reasons[])."""
    reasons, fail = [], False
    d = report["paired_differences"]
    lo = d["pr_auc"]["ci95"][0]
    if lo < -PR_AUC_MARGIN:
        fail = True
        reasons.append(f"PR-AUC: challenger may be worse by up to {-lo:.3f} (> margin {PR_AUC_MARGIN})")
    for key in ("recall@1%", "recall@2%"):
        lo = d[key]["ci95"][0]
        if lo < -RECALL_MARGIN:
            fail = True
            reasons.append(f"{key}: challenger may catch up to {-lo:.1%} less fraud at the same review capacity (> margin {RECALL_MARGIN:.0%})")
    ch, inc = report["challenger"], report["incumbent"]
    if ch["ece"] is not None and ch["ece"] > max(ECE_FLOOR, (inc["ece"] or 0) + ECE_ALLOWANCE):
        fail = True
        reasons.append(f"calibration: challenger ECE {ch['ece']} is worse than allowed")
    for seg, s in report["by_fraud_pattern"].items():
        if s["n_fraud"] >= MIN_SEGMENT_POSITIVES and s["recall_delta"] < -SEGMENT_RECALL_MARGIN:
            fail = True
            reasons.append(f"fraud pattern '{seg}': recall {s['challenger_recall']:.1%} vs {s['incumbent_recall']:.1%} (drop > {SEGMENT_RECALL_MARGIN:.0%})")
    if fail:
        return "fail", reasons
    if d["pr_auc"]["ci95"][0] > 0:
        return "pass_better", ["challenger's PR-AUC advantage is statistically clear and no check regressed"]
    return "pass", ["non-inferior on every check (not clearly better)"]


def compare_versions(registry_dir, challenger, incumbent, path=None, n_boot=300, seed=0):
    path = path or benchmark_path()
    if not os.path.exists(path):
        raise FileNotFoundError(f"benchmark dataset not found: {path}")
    df = pd.read_csv(path)
    y = df["is_fraud"].values.astype(int)
    if y.sum() < 50:
        raise ValueError("benchmark has too few fraud rows to compare models reliably")
    X = engineer_features(df)

    ch, inc = load_version(registry_dir, challenger), load_version(registry_dir, incumbent)
    ch_raw, ch_p = score_dataset(ch, X)
    in_raw, in_p = score_dataset(inc, X)

    report = {
        "benchmark": {
            "path": path, "rows": int(len(df)), "fraud_rows": int(y.sum()), "fraud_rate": round(float(y.mean()), 4),
            "synthetic": os.path.basename(path).startswith("promotion_benchmark") and "PROMOTION_BENCHMARK_PATH" not in os.environ,
            "note": "Labelled hold-out neither model was trained on. Synthetic unless PROMOTION_BENCHMARK_PATH points at real reviewed transactions.",
        },
        "challenger_version": challenger, "incumbent_version": incumbent,
        "challenger": _model_block(y, ch_p, ch_raw, ch["calibrator"] is not None),
        "incumbent": _model_block(y, in_p, in_raw, inc["calibrator"] is not None),
    }
    # Ranking comparisons use whichever scale each model has; ranks are what
    # PR-AUC and capacity metrics see, and calibration is monotone.
    report["paired_differences"] = {
        "pr_auc": _paired_bootstrap(y, in_p, ch_p, M.pr_auc, n_boot, seed),
        "recall@1%": _paired_bootstrap(y, in_p, ch_p, lambda yy, pp: _recall_at(yy, pp, 0.01), n_boot, seed),
        "recall@2%": _paired_bootstrap(y, in_p, ch_p, lambda yy, pp: _recall_at(yy, pp, 0.02), n_boot, seed),
    }
    report["score_distribution_psi"] = round(_psi(in_p, ch_p), 4)
    report["flag_rate_at_reference_threshold"] = {
        "incumbent": round(float((in_p >= REFERENCE_THRESHOLD).mean()), 5),
        "challenger": round(float((ch_p >= REFERENCE_THRESHOLD).mean()), 5),
    }

    segs = {}
    if "fraud_pattern" in df.columns:
        k = max(1, int(round(0.02 * len(df))))
        ch_flag = ch_p >= np.sort(ch_p)[::-1][k - 1]
        in_flag = in_p >= np.sort(in_p)[::-1][k - 1]
        for pat in sorted(set(df["fraud_pattern"]) - {"legit"}):
            m = (df["fraud_pattern"] == pat).values & (y == 1)
            n = int(m.sum())
            if n == 0:
                continue
            c_r, i_r = float(ch_flag[m].mean()), float(in_flag[m].mean())
            segs[pat] = {"n_fraud": n, "challenger_recall": round(c_r, 4), "incumbent_recall": round(i_r, 4), "recall_delta": round(c_r - i_r, 4)}
    report["by_fraud_pattern"] = segs
    report["recall_by_pattern_basis"] = "share of that pattern's fraud inside each model's top 2% by score"

    report["verdict"], report["verdict_reasons"] = decide(report)
    report["rule"] = {
        "pr_auc_margin": PR_AUC_MARGIN, "recall_margin": RECALL_MARGIN, "segment_recall_margin": SEGMENT_RECALL_MARGIN,
        "ece_allowance": ECE_ALLOWANCE, "min_segment_positives": MIN_SEGMENT_POSITIVES,
        "statement": "fail if the lower 95% bound of the paired PR-AUC or recall@capacity difference is below -margin, "
                     "calibration worsens beyond the allowance, or any fraud pattern with enough positives loses more recall than allowed.",
    }
    if not report["incumbent"]["calibrated"]:
        report["notes"] = ["incumbent is uncalibrated: ranking metrics are comparable, probability calibration is not"]
    return report
