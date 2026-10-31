"""
Shared feature engineering for FraudGuard's ML fraud model.

CRITICAL: this module is imported by BOTH train_model.py and app.py
(the serving API) so the exact same transformation is applied at
training time and prediction time (avoids train/serve skew).

All sequential/behavioral features (velocity, time-since-last,
spending z-score, geo-distance-from-last, is_new_device) are expected to
already be computed by the CALLER (train_model.py reads them straight
from the dataset; the Node backend's mlClient.js computes them from the
user's transaction history before calling /predict) — this module only
does the final numeric/categorical assembly, so both sides share one
definition of "what the model actually sees."
"""

import numpy as np
import pandas as pd

CATEGORY_COLS = ["category", "location", "card_type", "ip_status"]

NUMERIC_COLS = [
    "amount",
    "distance_from_home",
    "geo_distance_from_last_km",
    "time_since_last_transaction_minutes",
    "ratio_to_median_purchase_price",
    "spending_zscore",
    "repeat_retailer",
    "velocity_last_hour",
    "is_new_device",
    "hour",
    "day_of_week",
]
# NOTE: used_chip / used_pin_number / online_order are intentionally
# EXCLUDED from the model's feature set. This app is card-not-present
# only — every live transaction sends online_order=1, used_chip=0,
# used_pin_number=0 as hardcoded constants (see mlClient.js) — so these
# fields carry zero discriminative information once deployed. An earlier
# version of this pipeline fed them to the model anyway; because training
# data had them genuinely varying (and correlated with the fraud label),
# the model learned a "signal" from a feature that never actually varies
# in production, which silently biased every real prediction. Lesson:
# a feature can only be predictive in serving if it's actually free to
# vary in serving.

HIGH_RISK_CATEGORIES = {"crypto", "gambling", "wire_transfer"}
HIGH_RISK_LOCATIONS = {"Unknown", "Anonymous Proxy", "Lagos, NG"}


def engineer_features(df: pd.DataFrame) -> pd.DataFrame:
    """Adds a few derived numeric flags, then one-hot encodes categoricals.
    Returns a numeric-only DataFrame ready for model input.
    """
    df = df.copy()

    df["is_high_risk_category"] = df["category"].isin(HIGH_RISK_CATEGORIES).astype(int)
    df["is_high_risk_location"] = df["location"].isin(HIGH_RISK_LOCATIONS).astype(int)
    df["is_night_txn"] = df["hour"].apply(lambda h: 1 if (h <= 5 or h >= 23) else 0)
    df["log_amount"] = np.log1p(df["amount"])
    # A burst of activity right after the previous transaction is itself
    # a strong fraud signal (card testing).
    df["is_rapid_succession"] = (df["time_since_last_transaction_minutes"] < 5).astype(int)

    engineered_numeric = NUMERIC_COLS + [
        "is_high_risk_category", "is_high_risk_location", "is_night_txn",
        "log_amount", "is_rapid_succession",
    ]

    one_hot = pd.get_dummies(df[CATEGORY_COLS], prefix=CATEGORY_COLS)
    features = pd.concat([df[engineered_numeric], one_hot], axis=1)
    return features


def align_columns(features: pd.DataFrame, expected_columns: list) -> pd.DataFrame:
    """Ensures a features frame has exactly the columns the model was
    trained on (adds missing one-hot columns as 0, drops unseen ones,
    orders them consistently). Needed because a single incoming
    transaction won't naturally produce every one-hot category column.
    """
    for col in expected_columns:
        if col not in features.columns:
            features[col] = 0
    return features[expected_columns]
