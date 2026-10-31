"""
Validation on REAL data: the public ULB/Worldline credit-card fraud dataset.

    cd ml_service
    python3 -m evaluation.fetch_public_dataset
    python3 -m evaluation.run_public

What this does and does NOT establish
-------------------------------------
This dataset has anonymised PCA features, so the PRODUCTION model (which uses
velocity / geo-distance / device features) cannot be applied to it. What is
evaluated is the same modelling PROTOCOL and model families — fit on train,
select on validation, calibrate on validation, score the test period once —
on genuinely real transactions. It tests whether the approach generalises
forward in time on real fraud, which synthetic data cannot.

It has NO customer or merchant identifiers, so the following requested
tests are IMPOSSIBLE here and are not reported: new customers, unseen
merchants, account takeovers, user-leakage across splits. (They are covered
only on synthetic data, clearly labelled.)
"""

import json
import os
import sys
import time

import numpy as np
import pandas as pd

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from evaluation import metrics as M
from evaluation.protocol import fit_select_calibrate, recommend_thresholds, score
from evaluation.report import render_markdown

DATA = "data/public/creditcard.csv"
OUT_DIR = "reports/evaluation"
REVIEW_THRESHOLD = 0.10

DISCLAIMER = ("REAL-DATA RESULTS on a public dataset (ULB/Worldline credit-card fraud, Sept 2013, 2 days). Features are "
              "anonymised, so the production model is NOT what is evaluated — the modelling protocol and model families are. "
              "Not a measurement of FraudGuard's own accuracy on your traffic.")


def log(m):
    print(f"[{time.strftime('%H:%M:%S')}] {m}", flush=True)


def features(df):
    X = df[[f"V{i}" for i in range(1, 29)]].copy()
    X["log_amount"] = np.log1p(df["Amount"])
    X["hour_of_day"] = (df["Time"] / 3600.0) % 24
    return X


def main():
    t0 = time.time()
    df = pd.read_csv(DATA).sort_values("Time", kind="stable").reset_index(drop=True)
    X, y = features(df), df["Class"].to_numpy()
    n = len(df)
    report = {"dataset": "public ULB credit-card fraud (real)", "disclaimer": DISCLAIMER, "data_file": DATA,
              "n_rows": n, "fraud_rate": round(float(y.mean()), 5), "experiments": {}}

    def split_info(name, tr, va, te):
        return {"split": name, "rows": {"train": len(tr), "validation": len(va), "test": len(te)},
                "fraud": {"train": int(y[tr].sum()), "validation": int(y[va].sum()), "test": int(y[te].sum())}}

    def run(label, tr, va, te, name):
        log(f"{label}: train {len(tr):,} / val {len(va):,} / test {len(te):,}")
        fit = fit_select_calibrate(X, y, tr, va)
        log(f"{label}: best on validation = {fit['best']} {fit['val_pr_auc']}")
        raw, cal = score(fit, X.loc[te])
        yt = y[te]
        block = {
            "split": split_info(name, tr, va, te),
            "model_selected_on_validation": fit["best"], "validation_pr_auc_by_model": fit["val_pr_auc"],
            "calibrator": fit["calibrator"].describe(),
            "test": {"raw_model_output": M.summary(yt, raw, capacities=(0.001, 0.0025, 0.005, 0.01)),
                     "calibrated": M.summary(yt, cal, capacities=(0.001, 0.0025, 0.005, 0.01))},
            "recommended_thresholds_from_validation": recommend_thresholds(fit["val_y"], fit["val_calibrated"], 0.005),
        }
        return fit, cal, yt, block

    # Random split (naive baseline) — rows are already time-sorted, so shuffle indices explicitly.
    rng = np.random.default_rng(42)
    perm = rng.permutation(n)
    c1, c2 = int(n * .6), int(n * .8)
    _, _, _, a = run("A random", X.index[perm[:c1]], X.index[perm[c1:c2]], X.index[perm[c2:]], "random (naive baseline)")
    report["experiments"]["A_random_split_naive_baseline"] = a

    # Chronological split.
    tr, va, te = X.index[:c1], X.index[c1:c2], X.index[c2:]
    fit, cal, yt, b = run("B chronological", tr, va, te, "chronological by Time")
    amt = df.loc[te, "Amount"].to_numpy()
    bands = {"amount_under_10": amt < 10, "amount_10_to_100": (amt >= 10) & (amt < 100),
             "amount_100_to_1000": (amt >= 100) & (amt < 1000), "amount_1000_plus": amt >= 1000}
    seg = {}
    for name, m in bands.items():
        ys, ps = yt[m], cal[m]
        if ys.sum() < 5:
            seg[name] = {"n": int(m.sum()), "n_fraud": int(ys.sum()), "note": "too few fraud cases (<5) to report metrics"}
        else:
            seg[name] = {"n": int(m.sum()), "n_fraud": int(ys.sum()), "fraud_rate": round(float(ys.mean()), 4),
                         "pr_auc": round(M.pr_auc(ys, ps), 4), "at_review_threshold": M.operating_point(ys, ps, REVIEW_THRESHOLD),
                         "at_capacity": M.capacity_point(ys, ps, 0.01)}
    b["segments_feature_defined"] = seg
    b["segment_review_threshold_used"] = REVIEW_THRESHOLD
    report["experiments"]["B_chronological"] = b

    report["limitations"] = [
        "Only ~2 days of data; the test window is the final 20% (~9.6 hours) with a small number of frauds, so every metric carries a wide confidence interval (shown).",
        "Anonymised PCA features: the production model's features (velocity, geo-distance, device/IP novelty) do not exist here, so this does not validate that model.",
        "No customer, merchant or device identifiers: new-customer, unseen-merchant, account-takeover and per-user leakage tests are impossible on this dataset.",
        "Data is from 2013 European card-present/online mix; fraud tactics and base rates have changed. Treat as a sanity check of the method, not a benchmark of today's fraud.",
        "Calibration is only valid for a population with this dataset's fraud rate (0.17%); a different base rate shifts true probabilities.",
    ]
    report["runtime_seconds"] = round(time.time() - t0, 1)
    os.makedirs(OUT_DIR, exist_ok=True)
    with open(os.path.join(OUT_DIR, "public_ulb_creditcard.json"), "w") as f:
        json.dump(report, f, indent=2, default=float)
    with open(os.path.join(OUT_DIR, "public_ulb_creditcard.md"), "w") as f:
        f.write(render_markdown(report))
    log(f"done in {report['runtime_seconds']}s")


if __name__ == "__main__":
    main()
