"""
Shared model fitting + probability calibration.

Used by BOTH train_model.py (the production registry) and evaluation/
(the validation harness), so the model that gets evaluated is exactly the
model that gets shipped — not a look-alike.

Why calibration is its own step
-------------------------------
The candidates below are trained with class re-weighting (`class_weight`,
`scale_pos_weight`) and/or SMOTE oversampling. Those make the model pay
attention to the rare fraud class, but they also shift its raw output
away from a true probability: a raw score of 0.80 does NOT mean "80% of
such transactions are fraud". So the raw output is only used for RANKING,
and a monotone calibrator fitted on a held-out VALIDATION slice (never
the training rows, never the test rows) maps it to an estimated
probability of fraud under the validation population's fraud rate.
"""

import numpy as np
from imblearn.over_sampling import SMOTE
from sklearn.ensemble import RandomForestClassifier
from sklearn.isotonic import IsotonicRegression
from sklearn.linear_model import LogisticRegression
from sklearn.preprocessing import StandardScaler
from xgboost import XGBClassifier

RANDOM_STATE = 42

# Isotonic regression is flexible but needs enough positives to not just
# memorise noise; below this, fall back to the 2-parameter sigmoid (Platt).
MIN_POSITIVES_FOR_ISOTONIC = 200


class ProbabilityCalibrator:
    """Maps a model's raw fraud score in [0,1] to a calibrated probability.

    Fitted on validation data only. `method` is "isotonic" or "sigmoid";
    chosen automatically from the number of validation positives unless
    given explicitly. Picklable (lives in an importable module on purpose
    so joblib can load it inside app.py).
    """

    def __init__(self, method: str = "auto"):
        self.method = method
        self.fitted_method = None
        self.n_val = 0
        self.n_val_positives = 0
        self._iso = None
        self._platt = None

    @staticmethod
    def _logit(p):
        p = np.clip(np.asarray(p, dtype=float), 1e-6, 1 - 1e-6)
        return np.log(p / (1 - p)).reshape(-1, 1)

    def fit(self, raw_prob, y):
        raw_prob = np.asarray(raw_prob, dtype=float)
        y = np.asarray(y).astype(int)
        self.n_val, self.n_val_positives = int(len(y)), int(y.sum())
        method = self.method
        if method == "auto":
            method = "isotonic" if self.n_val_positives >= MIN_POSITIVES_FOR_ISOTONIC else "sigmoid"
        if method == "isotonic":
            self._iso = IsotonicRegression(out_of_bounds="clip", y_min=0.0, y_max=1.0)
            self._iso.fit(raw_prob, y)
        elif method == "sigmoid":
            self._platt = LogisticRegression(C=1e6, max_iter=1000)
            self._platt.fit(self._logit(raw_prob), y)
        else:
            raise ValueError(f"unknown calibration method: {method}")
        self.fitted_method = method
        return self

    def predict(self, raw_prob):
        raw_prob = np.asarray(raw_prob, dtype=float)
        if self.fitted_method == "isotonic":
            return np.clip(self._iso.predict(raw_prob), 0.0, 1.0)
        return self._platt.predict_proba(self._logit(raw_prob))[:, 1]

    def describe(self):
        return {
            "method": self.fitted_method,
            "fitted_on": "validation split (held out from training and from the test set)",
            "n_validation_rows": self.n_val,
            "n_validation_positives": self.n_val_positives,
            "validation_fraud_rate": round(self.n_val_positives / self.n_val, 6) if self.n_val else None,
        }


def fit_candidates(X_train, y_train):
    """Fits the 3 candidate models on TRAINING rows only.

    Returns (scaler, {name: fitted_model}). Probabilities from these models
    are raw rankings, not calibrated probabilities (see module docstring).
    """
    scaler = StandardScaler()
    X_scaled = scaler.fit_transform(X_train)
    y_train = np.asarray(y_train).astype(int)

    models = {}
    lr = LogisticRegression(max_iter=1000, class_weight="balanced", random_state=RANDOM_STATE)
    lr.fit(X_scaled, y_train)
    models["logistic_regression"] = lr

    rf = RandomForestClassifier(
        n_estimators=300, max_depth=12, class_weight="balanced_subsample",
        random_state=RANDOM_STATE, n_jobs=-1,
    )
    rf.fit(X_scaled, y_train)
    models["random_forest"] = rf

    X_smote, y_smote = SMOTE(random_state=RANDOM_STATE).fit_resample(X_scaled, y_train)
    neg, pos = np.bincount(y_train)
    xgb = XGBClassifier(
        n_estimators=400, max_depth=6, learning_rate=0.05, eval_metric="aucpr",
        scale_pos_weight=neg / pos, random_state=RANDOM_STATE, n_jobs=-1,
    )
    xgb.fit(X_smote, y_smote)
    models["xgboost"] = xgb
    return scaler, models
