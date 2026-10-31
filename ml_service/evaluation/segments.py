"""
Segment definitions for stress-testing the model on the situations that
matter in fraud: brand-new customers, first-time merchants, account
takeovers and changed fraud patterns.

A headline PR-AUC averages over mostly-easy cases and hides exactly these.
"""

import numpy as np
import pandas as pd

from evaluation import metrics as M


def add_context(df, user_col="user_synthetic_id", ts_col="timestamp"):
    """Adds `user_txn_index` (0 for a user's very first transaction)."""
    df = df.copy()
    df["_ts"] = pd.to_datetime(df[ts_col], format="ISO8601")
    df = df.sort_values([user_col, "_ts"], kind="stable")
    df["user_txn_index"] = df.groupby(user_col).cumcount()
    return df.sort_index().drop(columns="_ts")


def feature_segments(df):
    """Segments defined by what the TRANSACTION looks like (rows in the
    segment are evaluated with their own legit + fraud mix)."""
    return {
        "new_customer_first_3_txns": (df["user_txn_index"] < 3).to_numpy(),
        "first_time_merchant_for_user": (df["repeat_retailer"] == 0).to_numpy(),
        "established_customer_known_merchant": ((df["user_txn_index"] >= 3) & (df["repeat_retailer"] == 1)).to_numpy(),
        "night_hours_23_to_05": df["hour"].apply(lambda h: h <= 5 or h >= 23).to_numpy(),
    }


def fraud_type_segments(df):
    """Segments defined by the KIND OF FRAUD (ground truth known only
    because the data is synthetic). Evaluated as: how many of these
    specific frauds does the model catch, with ALL legit rows as negatives."""
    return {
        "standard_stolen_card": (df["fraud_pattern"] == "standard").to_numpy(),
        "account_takeover_known_device_and_ip": (df["fraud_pattern"] == "account_takeover").to_numpy(),
        "shifted_low_and_slow": (df["fraud_pattern"] == "shifted").to_numpy(),
    }


def evaluate_feature_segments(df, y, p, threshold, capacity_frac=0.02):
    out = {}
    for name, mask in feature_segments(df).items():
        ys, ps = np.asarray(y)[mask], np.asarray(p)[mask]
        if len(ys) == 0 or ys.sum() < 5:
            out[name] = {"n": int(mask.sum()), "n_fraud": int(ys.sum()), "note": "too few fraud cases (<5) to report metrics"}
            continue
        out[name] = {
            "n": int(mask.sum()), "n_fraud": int(ys.sum()),
            "fraud_rate": round(float(ys.mean()), 4),
            "pr_auc": round(M.pr_auc(ys, ps), 4),
            "at_review_threshold": M.operating_point(ys, ps, threshold),
            "at_capacity": M.capacity_point(ys, ps, capacity_frac),
        }
    return out


def evaluate_fraud_type_segments(df, y, p, threshold):
    y = np.asarray(y)
    p = np.asarray(p)
    legit = y == 0
    out = {}
    for name, mask in fraud_type_segments(df).items():
        n_fraud = int(mask.sum())
        if n_fraud < 5:
            out[name] = {"n_fraud": n_fraud, "note": "too few cases (<5) in this split to report"}
            continue
        sel = mask | legit
        flagged = p[mask] >= threshold
        out[name] = {
            "n_fraud": n_fraud,
            "recall_at_review_threshold": round(float(flagged.mean()), 4),
            "median_score": round(float(np.median(p[mask])), 4),
            "pr_auc_vs_all_legit": round(M.pr_auc(mask[sel].astype(int), p[sel]), 4),
        }
    return out
