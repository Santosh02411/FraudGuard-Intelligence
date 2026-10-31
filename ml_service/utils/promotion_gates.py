"""
Automated promotion gates
============================
Evidence about a registry version, computed by the service that owns the
artifacts. Each gate is:

    { id, title, status: pass | fail | warn | insufficient,
      hard: True  -> a failure can never be waved through (integrity,
                     compatibility: promoting would be unsafe, not merely
                     unproven),
      detail }

The backend adds the gates that need its database (labelled production
outcomes for a shadow model) and turns the result into an approval workflow.
Gates never load a pickle until artifact integrity has passed.
"""

import json
import math
import os

import numpy as np
import pandas as pd

from utils import artifacts
from utils.feature_engineering import engineer_features, align_columns

MIN_TEST_PR_AUC = float(os.environ.get("PROMOTION_MIN_PR_AUC", "0.30"))
MAX_TEST_ECE = float(os.environ.get("PROMOTION_MAX_ECE", "0.05"))
REQUIRED_METRIC_PATHS = [
    ("evaluation.protocol", "evaluation protocol recorded"),
    ("evaluation.dataset", "dataset labelled (synthetic / real)"),
    ("evaluation.test_calibrated.pr_auc", "test PR-AUC (calibrated)"),
    ("evaluation.test_calibrated.ece", "test calibration error (ECE)"),
    ("evaluation.test_calibrated.review_capacity", "precision/recall at review capacity"),
    ("evaluation.test_calibrated.pr_auc_95ci", "PR-AUC confidence interval"),
]

# A representative serving row: every raw field the backend's feature builder sends.
SMOKE_ROW = {
    "amount": 120.0, "category": "retail", "location": "New York, US", "card_type": "credit",
    "hour": 14, "day_of_week": 2, "distance_from_home": 3.0, "geo_distance_from_last_km": 1.0,
    "time_since_last_transaction_minutes": 240.0, "ratio_to_median_purchase_price": 1.1,
    "spending_zscore": 0.2, "repeat_retailer": 1, "used_chip": 0, "used_pin_number": 0,
    "online_order": 1, "velocity_last_hour": 1, "is_new_device": 0, "ip_status": "known",
}


def _gate(gid, title, status, detail="", hard=False, data=None):
    g = {"id": gid, "title": title, "status": status, "hard": hard, "detail": detail}
    if data is not None:
        g["data"] = data
    return g


def _dig(d, path):
    cur = d
    for part in path.split("."):
        if not isinstance(cur, dict) or part not in cur:
            return None
        cur = cur[part]
    return cur


def evaluate_version(registry_dir, version, incumbent=None, include_comparison=False):
    vdir = os.path.join(registry_dir, version)
    gates = []
    if not os.path.isdir(vdir):
        return [_gate("exists", "Version exists in registry", "fail", f"no such version: {version}", hard=True)]

    # 1. Artifact integrity (hard)
    integrity = artifacts.verify(vdir)
    bad = [c for c in integrity["checks"] if not c["ok"]]
    gates.append(_gate(
        "artifact_integrity", "Artifact integrity (hashes, manifest, signature)",
        "pass" if integrity["ok"] else "fail",
        "all artifact hashes match the training-time manifest" + (" and the manifest is signed" if integrity["signed"] else " (manifest unsigned: tamper-evident only)")
        if integrity["ok"] else "; ".join(f"{c['name']}: {c['detail']}" for c in bad),
        hard=True,
        data={"signed": integrity["signed"], "checks": len(integrity["checks"])},
    ))
    if not integrity["ok"]:
        # Nothing below may touch the pickles of an unverified version.
        return gates

    manifest = integrity["manifest"]
    with open(os.path.join(vdir, "feature_columns.json")) as f:
        columns = json.load(f)
    with open(os.path.join(vdir, "metrics.json")) as f:
        metrics = json.load(f)
    with open(os.path.join(vdir, "metadata.json")) as f:
        metadata = json.load(f)

    # 2. Runtime compatibility (hard)
    compat = artifacts.runtime_compatibility(manifest)
    gates.append(_gate(
        "runtime_compat", "Runtime compatibility (scikit-learn / xgboost / numpy)",
        "pass" if compat["ok"] else "fail",
        "; ".join(compat["problems"]) if compat["problems"] else ("trained and serving library versions match" + (f" ({'; '.join(compat['notes'])})" if compat["notes"] else "")),
        hard=True, data=compat,
    ))

    # 3. Feature schema (hard): can the serving pipeline produce every column?
    served = list(engineer_features(pd.DataFrame([SMOKE_ROW])).columns)
    unsatisfiable = [c for c in columns if not (c in served or c.split("_", 1)[0] in {"category", "location", "card", "ip"})]
    inc_cols = None
    if incumbent and os.path.exists(os.path.join(registry_dir, incumbent, "feature_columns.json")):
        with open(os.path.join(registry_dir, incumbent, "feature_columns.json")) as f:
            inc_cols = json.load(f)
    schema_detail = f"{len(columns)} features, schema hash {manifest['feature_schema_sha256'][:12]}"
    status = "pass"
    if unsatisfiable:
        status, schema_detail = "fail", f"columns the serving pipeline cannot produce: {unsatisfiable}"
    elif inc_cols is not None and inc_cols != columns:
        added, removed = sorted(set(columns) - set(inc_cols)), sorted(set(inc_cols) - set(columns))
        status = "warn"
        schema_detail = f"differs from incumbent {incumbent} (added {added[:6]}, removed {removed[:6]}) — one-hot categories may differ; confirm the backend sends every raw field"
    gates.append(_gate("feature_schema", "Feature schema matches the serving pipeline", status, schema_detail, hard=(status == "fail")))

    # 4. Loads and scores a smoke row sanely (hard) — safe now: integrity passed.
    try:
        import joblib
        model = joblib.load(os.path.join(vdir, "model.pkl"))
        scaler = joblib.load(os.path.join(vdir, "scaler.pkl"))
        cal_path = os.path.join(vdir, "calibrator.pkl")
        calibrator = joblib.load(cal_path) if os.path.exists(cal_path) else None
        X = align_columns(engineer_features(pd.DataFrame([SMOKE_ROW])), columns)
        raw = float(model.predict_proba(scaler.transform(X))[0][1])
        cal = float(calibrator.predict(np.array([raw]))[0]) if calibrator is not None else raw
        ok = all(math.isfinite(v) and 0.0 <= v <= 1.0 for v in (raw, cal))
        gates.append(_gate("smoke_score", "Loads and produces a valid probability", "pass" if ok else "fail",
                           f"smoke row scored raw={raw:.4f} calibrated={cal:.4f}" if ok else f"invalid output raw={raw} calibrated={cal}", hard=True))
    except Exception as e:  # noqa: BLE001
        calibrator = None
        gates.append(_gate("smoke_score", "Loads and produces a valid probability", "fail", f"{type(e).__name__}: {e}", hard=True))

    # 5. Calibrated (hard): the meaning of a score depends on it.
    gates.append(_gate(
        "calibrated", "Probability calibrator present",
        "pass" if os.path.exists(os.path.join(vdir, "calibrator.pkl")) else "fail",
        "scores are calibrated probabilities" if os.path.exists(os.path.join(vdir, "calibrator.pkl"))
        else "no calibrator: risk thresholds and the meaning of 'a score of 80' would not hold",
        hard=True,
    ))

    # 6. Required evaluation metrics present and acceptable
    missing = [label for path, label in REQUIRED_METRIC_PATHS if _dig(metrics, path) is None]
    if missing:
        gates.append(_gate("required_metrics", "Required evaluation metrics present", "fail",
                           f"missing: {', '.join(missing)} (trained before the evaluation protocol existed?)", hard=True))
    else:
        pr, ece = _dig(metrics, "evaluation.test_calibrated.pr_auc"), _dig(metrics, "evaluation.test_calibrated.ece")
        protocol = _dig(metrics, "evaluation.protocol")
        problems = []
        if protocol == "random_split_naive":
            problems.append("evaluated with a naive random split")
        if pr < MIN_TEST_PR_AUC:
            problems.append(f"test PR-AUC {pr:.3f} below minimum {MIN_TEST_PR_AUC}")
        if ece > MAX_TEST_ECE:
            problems.append(f"test ECE {ece:.3f} above maximum {MAX_TEST_ECE}")
        gates.append(_gate("required_metrics", "Required evaluation metrics present and acceptable",
                           "fail" if problems else "pass",
                           "; ".join(problems) if problems else f"protocol {protocol}; test PR-AUC {pr:.3f}, ECE {ece:.4f}; dataset: {_dig(metrics, 'evaluation.dataset')}",
                           hard=bool(problems), data={"dataset": _dig(metrics, "evaluation.dataset"), "protocol": protocol}))

    # 7. Challenger vs incumbent on the same labelled benchmark
    if incumbent and incumbent != version and include_comparison:
        from evaluation import compare
        try:
            report = compare.compare_versions(registry_dir, version, incumbent)
            status = {"fail": "fail", "pass": "pass", "pass_better": "pass"}[report["verdict"]]
            gates.append(_gate(
                "benchmark_comparison", f"Challenger vs incumbent {incumbent} on one labelled benchmark", status,
                "; ".join(report["verdict_reasons"]) + (" [SYNTHETIC benchmark]" if report["benchmark"]["synthetic"] else ""),
                hard=False, data=report,
            ))
        except Exception as e:  # noqa: BLE001
            gates.append(_gate("benchmark_comparison", f"Challenger vs incumbent {incumbent} on one labelled benchmark", "insufficient", f"could not run: {e}"))
    elif incumbent and incumbent != version:
        gates.append(_gate("benchmark_comparison", f"Challenger vs incumbent {incumbent} on one labelled benchmark", "insufficient",
                           "not run (request it with compare=true)"))
    return gates


def summarize(gates):
    hard_fail = [g["id"] for g in gates if g["hard"] and g["status"] == "fail"]
    soft = [g["id"] for g in gates if g["status"] in ("fail", "insufficient") and not g["hard"]]
    return {"blocked": bool(hard_fail), "hard_failures": hard_fail, "needs_acknowledgement": soft}
