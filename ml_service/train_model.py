"""
FraudGuard - Model Training, Evaluation & Versioning
=======================================================
Trains and compares 3 models (Logistic Regression, Random Forest,
XGBoost), handles class imbalance (class_weight + SMOTE), and writes the
result as a NEW VERSION in the model
registry (models/registry/vN/) rather than overwriting a single file in
place. A new version is only ever a CANDIDATE: it is never activated by the
training job. Promotion goes through the approval workflow (gates, same-
dataset comparison with the incumbent on labels, a second person's approval).
Only the very first model on a fresh install is activated automatically.

Evaluation protocol (evaluation/protocol.py — shared with the validation
harness so what is evaluated is what ships):
    * CHRONOLOGICAL split 60/20/20 (train < validation < test in time),
      with training/validation rows purged when a fraud episode straddles
      a boundary. `--split random` reproduces the old naive split.
    * The winning model is chosen on VALIDATION PR-AUC, never on test.
    * A probability calibrator is fitted on VALIDATION rows only; the
      served `fraud_probability` is the calibrated value, so a score of
      80 means "~80 in 100 transactions scored like this were fraud in
      the validation population" (see docs/MODEL_VALIDATION.md).
    * The test set is scored once, for reporting.
    * THE DATA IS SYNTHETIC. Every metric written to the registry is
      labelled as such.

Registry layout:
    models/registry/v1/
        model.pkl
        scaler.pkl
        calibrator.pkl          <- raw model score -> calibrated probability
        feature_columns.json
        background_sample.npy   <- for SHAP explainer at serving time
        metrics.json
        metadata.json           <- version, trained_at, dataset info, promoted?
    models/registry/v2/
        ...
    models/current_version.json <- {"version": "v3"}  <- which one the API loads
    models/training_log.json    <- append-only history of every training run

Run:
    python3 train_model.py                  # saves a CANDIDATE (never serves it)
"""

import argparse
import json
import os
import time
from datetime import datetime, timezone

import joblib
import numpy as np
import pandas as pd
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

from sklearn.metrics import (
    precision_score, recall_score, f1_score, roc_auc_score,
    average_precision_score, confusion_matrix, classification_report,
    roc_curve, precision_recall_curve,
)

from evaluation import metrics as M
from evaluation.protocol import fit_select_calibrate, recommend_thresholds, score
from evaluation.splits import chronological_split, random_split
from utils.feature_engineering import engineer_features, CATEGORY_COLS
from utils.drift import compute_baseline_stats, DRIFT_HIGH_SCORE
from utils import artifacts

DATA_PATH = "data/transactions.csv"
REGISTRY_DIR = "models/registry"
CURRENT_VERSION_PATH = "models/current_version.json"
TRAINING_LOG_PATH = "models/training_log.json"
RANDOM_STATE = 42
SCORE_HIST_EDGES = [0, 1, 2, 5, 10, 20, 50, 100.0001]
EVALUATION_PROTOCOL = "chronological_purged_val_selected_val_calibrated_v2"
SYNTHETIC_DISCLAIMER = ("SYNTHETIC-DATA RESULTS: these metrics come from ml_service/generate_dataset.py, not real transactions. "
                        "They validate the pipeline, not real-world fraud-detection accuracy.")


def load_data(path=None):
    df = pd.read_csv(path or DATA_PATH)
    X = engineer_features(df)
    y = df["is_fraud"].values
    return df, X, y


def evaluate(name, y_test, y_prob):
    y_pred = (y_prob >= 0.5).astype(int)
    cm = confusion_matrix(y_test, y_pred)
    metrics = {
        "precision": round(precision_score(y_test, y_pred, zero_division=0), 4),
        "recall": round(recall_score(y_test, y_pred, zero_division=0), 4),
        "f1_score": round(f1_score(y_test, y_pred, zero_division=0), 4),
        "roc_auc": round(roc_auc_score(y_test, y_prob), 4),
        "pr_auc": round(average_precision_score(y_test, y_prob), 4),
        "confusion_matrix": {
            "true_negative": int(cm[0][0]), "false_positive": int(cm[0][1]),
            "false_negative": int(cm[1][0]), "true_positive": int(cm[1][1]),
        },
        "classification_report": classification_report(y_test, y_pred, output_dict=True, zero_division=0),
    }
    print(f"\n=== {name} ===")
    print(f"Precision: {metrics['precision']}  Recall: {metrics['recall']}  "
          f"F1: {metrics['f1_score']}  ROC-AUC: {metrics['roc_auc']}  PR-AUC: {metrics['pr_auc']}")
    print(f"Confusion matrix -> TN:{cm[0][0]} FP:{cm[0][1]} FN:{cm[1][0]} TP:{cm[1][1]}")
    return metrics


def next_version() -> str:
    os.makedirs(REGISTRY_DIR, exist_ok=True)
    existing = [d for d in os.listdir(REGISTRY_DIR) if d.startswith("v") and d[1:].isdigit()]
    nums = [int(d[1:]) for d in existing] or [0]
    return f"v{max(nums) + 1}"


def current_promoted_metrics():
    if not os.path.exists(CURRENT_VERSION_PATH):
        return None
    with open(CURRENT_VERSION_PATH) as f:
        current = json.load(f)
    metrics_path = os.path.join(REGISTRY_DIR, current["version"], "metrics.json")
    if not os.path.exists(metrics_path):
        return None
    with open(metrics_path) as f:
        data = json.load(f)
    # Versions trained before the protocol change were scored on a random
    # split (and selected on test), so their PR-AUC is not comparable.
    protocol = data.get("evaluation", {}).get("protocol", "random_split_legacy")
    return data["results"][data["best_model"]]["pr_auc"], protocol


def append_training_log(entry: dict):
    log = []
    if os.path.exists(TRAINING_LOG_PATH):
        with open(TRAINING_LOG_PATH) as f:
            log = json.load(f)
    log.append(entry)
    with open(TRAINING_LOG_PATH, "w") as f:
        json.dump(log, f, indent=2)


LABELED_DISCLAIMER = ("LABEL-DERIVED RESULTS: trained and evaluated on analyst-verified outcomes from this deployment. Labels come from "
                      "reviewed alerts and disputes (plus optional presumed-legitimate samples), so they are selection-biased toward what "
                      "the previous model flagged. Metrics describe agreement with those labels, not accuracy on all traffic.")


def train_and_evaluate(notes: str = "", split: str = "chronological", data_path: str | None = None, dataset_info: dict | None = None):
    """`dataset_info` (optional) replaces the 'synthetic' labelling when training on verified feedback labels; it is
    recorded in the version's metadata so the lineage of every candidate is auditable."""
    print("Loading & engineering features...")
    df, X, y = load_data(data_path)
    dataset_label = (dataset_info or {}).get("kind", "synthetic")
    disclaimer = LABELED_DISCLAIMER if dataset_info else SYNTHETIC_DISCLAIMER
    feature_columns = list(X.columns)
    print(f"Dataset: {len(X)} rows, {len(feature_columns)} features, fraud rate {y.mean():.4%}")

    if split == "chronological":
        train_idx, val_idx, test_idx, split_info = chronological_split(
            df, "timestamp", user_col="user_synthetic_id")
    else:
        train_idx, val_idx, test_idx, split_info = random_split(df)
    print(f"Split ({split_info['split']}): {split_info['rows']}  fraud: {split_info['fraud']}")

    # --- fit on TRAIN, choose on VALIDATION, calibrate on VALIDATION ---
    fit = fit_select_calibrate(X, y, train_idx, val_idx)
    best_name = fit["best"]
    print(f"Validation PR-AUC by model: {fit['val_pr_auc']} -> selected {best_name}")
    print(f"Calibrator: {fit['calibrator'].describe()}")

    # --- score TEST once, for reporting ---
    test_pos = df.index.get_indexer(test_idx)
    y_test = y[test_pos]
    X_test = X.loc[test_idx]
    results, roc_data, pr_data, y_probs = {}, {}, {}, {}
    for name in fit["models"]:
        raw, _ = score(fit, X_test, model_name=name)
        # Legacy per-model block (precision/recall/... at a raw 0.5 cut) kept
        # so existing consumers of metrics.json keep working. NOTE these are
        # computed on RAW model output, which is a ranking, not a probability.
        results[name] = evaluate(name, y_test, raw)
        y_probs[name] = raw
        roc_data[name] = roc_curve(y_test, raw)
        pr_data[name] = precision_recall_curve(y_test, raw)
    new_pr_auc = results[best_name]["pr_auc"]
    best_model = fit["models"][best_name]
    scaler, calibrator = fit["scaler"], fit["calibrator"]
    best_raw, best_cal = score(fit, X_test)
    print(f"\n>>> Selected on validation: {best_name} (TEST PR-AUC={new_pr_auc})")

    evaluation = {
        "dataset": dataset_label,
        "dataset_info": dataset_info,
        "disclaimer": disclaimer,
        "protocol": EVALUATION_PROTOCOL if split == "chronological" else "random_split_naive",
        "split": split_info,
        "model_selected_on": "validation PR-AUC (not test)",
        "validation_pr_auc_by_model": fit["val_pr_auc"],
        "calibration": calibrator.describe(),
        "test_calibrated": M.summary(y_test, best_cal),
        "test_raw_model_output": {k: v for k, v in M.summary(y_test, best_raw).items() if k in ("pr_auc", "brier", "ece")},
        "recommended_thresholds": recommend_thresholds(fit["val_y"], fit["val_calibrated"]),
        "score_meaning": ("fraud_score = calibrated probability of fraud x 100, estimated on a held-out validation "
                          f"population with a {calibrator.describe()['validation_fraud_rate']:.2%} fraud rate. "
                          "It is a probability, not a decision: risk levels come from the admin-configurable risk policy."),
    }

    # --- Version + save to registry ---
    version = next_version()
    version_dir = os.path.join(REGISTRY_DIR, version)
    os.makedirs(version_dir, exist_ok=True)

    joblib.dump(best_model, os.path.join(version_dir, "model.pkl"))
    joblib.dump(scaler, os.path.join(version_dir, "scaler.pkl"))
    joblib.dump(calibrator, os.path.join(version_dir, "calibrator.pkl"))
    with open(os.path.join(version_dir, "feature_columns.json"), "w") as f:
        json.dump(feature_columns, f, indent=2)
    with open(os.path.join(version_dir, "metrics.json"), "w") as f:
        json.dump({"best_model": best_name, "results": results, "evaluation": evaluation}, f, indent=2, default=float)

    # Background sample for SHAP explainer at serving time (small, scaled).
    # SHAP explains the RAW model output; calibration is a monotone map of it,
    # so the direction and ranking of each factor's effect are unchanged.
    X_train_scaled = scaler.transform(X.loc[train_idx])
    bg_idx = np.random.RandomState(RANDOM_STATE).choice(len(X_train_scaled), size=min(100, len(X_train_scaled)), replace=False)
    np.save(os.path.join(version_dir, "background_sample.npy"), X_train_scaled[bg_idx])

    # --- Drift baseline (utils/drift.py) ---
    # The distribution this version was trained on, plus the CALIBRATED score
    # distribution on held-out test rows (what the API actually serves).
    one_hot_prefixes = tuple(f"{c}_" for c in CATEGORY_COLS)
    binary_flag_cols = [
        "repeat_retailer", "is_new_device", "is_high_risk_category",
        "is_high_risk_location", "is_night_txn", "is_rapid_succession",
    ]
    binary_features = [c for c in feature_columns if c in binary_flag_cols or c.startswith(one_hot_prefixes)]
    numeric_features = [c for c in feature_columns if c not in binary_features]
    best_scores = best_cal * 100
    score_stats = {
        "mean": float(np.mean(best_scores)),
        "std": float(np.std(best_scores)) or 1.0,
        "high_risk_rate": float(np.mean(best_scores >= DRIFT_HIGH_SCORE)),
        # Histogram of served (calibrated) scores on held-out rows; rollback
        # triggers compare the live distribution against this.
        "hist_edges": SCORE_HIST_EDGES,
        "hist": [float(v) for v in np.histogram(best_scores, bins=SCORE_HIST_EDGES)[0] / max(len(best_scores), 1)],
    }
    baseline_stats = compute_baseline_stats(X, numeric_features, binary_features, score_stats=score_stats)
    with open(os.path.join(version_dir, "baseline_stats.json"), "w") as f:
        json.dump(baseline_stats, f, indent=2)

    # --- Promotion is NOT decided here ---
    # Training only produces a CANDIDATE. Making a version the one the API
    # serves goes through the promotion workflow (gates + a different person's
    # approval, recorded with reason): backend /api/admin/ml/change-requests.
    # The single exception is the very first model on a fresh install, which
    # has no incumbent to compare with (bootstrap).
    prev = current_promoted_metrics()
    prev_pr_auc, prev_protocol = prev if prev else (None, None)
    bootstrap = prev is None and not os.path.exists(CURRENT_VERSION_PATH)
    promote = bootstrap
    metadata = {
        "version": version,
        "trained_at": datetime.now(timezone.utc).isoformat(),
        "best_model_type": best_name,
        "pr_auc": new_pr_auc,
        "incumbent_pr_auc_at_training": prev_pr_auc,
        "status": "bootstrap_active" if bootstrap else "candidate",
        "n_rows": len(X),
        "n_features": len(feature_columns),
        "fraud_rate": round(float(y.mean()), 4),
        "dataset": dataset_label,
        "dataset_info": dataset_info,
        "evaluation_protocol": evaluation["protocol"],
        "calibration": calibrator.describe(),
        "recommended_thresholds": evaluation["recommended_thresholds"],
        "notes": notes,
    }
    with open(os.path.join(version_dir, "metadata.json"), "w") as f:
        json.dump(metadata, f, indent=2)

    # Integrity manifest over every artifact (written LAST, after all files exist).
    manifest = artifacts.write_manifest(version_dir, version, feature_columns, extra={
        "trained_by": "train_model.py", "evaluation_protocol": evaluation["protocol"],
    })

    if bootstrap:
        with open(CURRENT_VERSION_PATH, "w") as f:
            json.dump({"version": version, "promoted_at": metadata["trained_at"], "bootstrap": True}, f, indent=2)
        print(f">>> {version} is the first model: activated as bootstrap (no incumbent).")
    else:
        print(f">>> {version} saved as a CANDIDATE (TEST PR-AUC {new_pr_auc}; incumbent {prev_pr_auc}). "
              f"It is NOT serving. Request promotion through the model change workflow "
              f"(signed manifest: {'yes' if 'signature' in manifest else 'no - set MODEL_SIGNING_KEY'}).")

    append_training_log(metadata)

    # --- Plots (saved per-version so history is preserved) ---
    reports_dir = os.path.join("reports", version)
    os.makedirs(reports_dir, exist_ok=True)
    _plot_confusion_matrices(results, reports_dir)
    _plot_roc_pr_curves(roc_data, pr_data, results, reports_dir)
    _plot_calibration(y_test, best_raw, best_cal, reports_dir)
    if hasattr(fit["models"]["xgboost"], "feature_importances_"):
        _plot_feature_importance(fit["models"]["xgboost"], feature_columns, reports_dir)

    print(f"\nSaved version {version} -> {version_dir}/")
    print(f"Saved plots -> {reports_dir}/")
    return version, promote, metadata


def _plot_calibration(y_true, raw, calibrated, out_dir, bins=10):
    """Reliability diagram: predicted vs observed fraud rate, before/after calibration."""
    fig, ax = plt.subplots(figsize=(5.5, 5))
    ax.plot([0, 1], [0, 1], "k--", alpha=0.4, label="perfectly calibrated")
    for name, p in (("raw model output", raw), ("calibrated", calibrated)):
        edges = np.quantile(p, np.linspace(0, 1, bins + 1))
        xs, ys = [], []
        for lo, hi in zip(edges[:-1], edges[1:]):
            m = (p >= lo) & (p <= hi)
            if m.sum() > 0:
                xs.append(p[m].mean()); ys.append(np.asarray(y_true)[m].mean())
        ax.plot(xs, ys, marker="o", label=name)
    ax.set_xlabel("Mean predicted probability"); ax.set_ylabel("Observed fraud rate")
    ax.set_title("Reliability (synthetic test set)"); ax.legend(fontsize=8)
    plt.tight_layout(); plt.savefig(os.path.join(out_dir, "calibration.png"), dpi=120); plt.close()


def _plot_confusion_matrices(results, out_dir):
    fig, axes = plt.subplots(1, 3, figsize=(15, 4))
    for ax, (name, res) in zip(axes, results.items()):
        cm = res["confusion_matrix"]
        matrix = np.array([[cm["true_negative"], cm["false_positive"]],
                            [cm["false_negative"], cm["true_positive"]]])
        ax.imshow(matrix, cmap="Blues")
        ax.set_title(name.replace("_", " ").title())
        ax.set_xticks([0, 1]); ax.set_xticklabels(["Pred Legit", "Pred Fraud"])
        ax.set_yticks([0, 1]); ax.set_yticklabels(["Actual Legit", "Actual Fraud"])
        for i in range(2):
            for j in range(2):
                ax.text(j, i, matrix[i, j], ha="center", va="center", fontsize=12)
    plt.tight_layout()
    plt.savefig(os.path.join(out_dir, "confusion_matrices.png"), dpi=120)
    plt.close()


def _plot_roc_pr_curves(roc_data, pr_data, results, out_dir):
    fig, (ax1, ax2) = plt.subplots(1, 2, figsize=(12, 5))
    for name, (fpr, tpr, _) in roc_data.items():
        ax1.plot(fpr, tpr, label=f"{name} (AUC={results[name]['roc_auc']})")
    ax1.plot([0, 1], [0, 1], "k--", alpha=0.3)
    ax1.set_xlabel("False Positive Rate"); ax1.set_ylabel("True Positive Rate")
    ax1.set_title("ROC Curves"); ax1.legend(fontsize=8)

    for name, (prec, rec, _) in pr_data.items():
        ax2.plot(rec, prec, label=f"{name} (PR-AUC={results[name]['pr_auc']})")
    ax2.set_xlabel("Recall"); ax2.set_ylabel("Precision")
    ax2.set_title("Precision-Recall Curves"); ax2.legend(fontsize=8)
    plt.tight_layout()
    plt.savefig(os.path.join(out_dir, "roc_pr_curves.png"), dpi=120)
    plt.close()


def _plot_feature_importance(model, feature_columns, out_dir, top_n=15):
    importances = model.feature_importances_
    idx = np.argsort(importances)[-top_n:]
    plt.figure(figsize=(8, 6))
    plt.barh([feature_columns[i] for i in idx], importances[idx])
    plt.title("XGBoost - Top Feature Importances")
    plt.tight_layout()
    plt.savefig(os.path.join(out_dir, "feature_importance.png"), dpi=120)
    plt.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--notes", type=str, default="", help="Free-text note for the training log")
    parser.add_argument("--split", choices=["chronological", "random"], default="chronological",
                         help="chronological (default, leakage-safe) or the old naive random split")
    args = parser.parse_args()
    train_and_evaluate(notes=args.notes, split=args.split)
