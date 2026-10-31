"""
FraudGuard - Retraining Pipeline
====================================
Orchestrates a full retrain cycle, the way you'd wire this into a cron
job / CI schedule in production:

    1. Generate fresh transaction data (optionally simulating fraud
       pattern DRIFT — new fraud behavior the current model has never
       seen, e.g. a shift toward gambling-category fraud).
    2. Train + evaluate all 3 models on it (train_model.py's logic).
    3. Compare the new best model's PR-AUC against the currently
       promoted version is done by the promotion workflow, not here.
    4. The candidate is saved but NOT served. Request promotion in the
       admin UI / POST /api/admin/ml/change-requests (gates, same-dataset
       comparison with the incumbent, second-person approval).

Run:
    python3 retrain_pipeline.py
    python3 retrain_pipeline.py --simulate-drift --notes "monthly retrain"
"""

import argparse
import sys

import requests

from generate_dataset import generate
from train_model import train_and_evaluate, DATA_PATH

import os

ML_SERVICE_URL = os.environ.get("ML_SERVICE_URL", "http://localhost:8001")
# /model/reload is a model-management call: it needs the ADMIN key (utils/auth.py).
ML_ADMIN_API_KEY = os.environ.get("ML_ADMIN_API_KEY", "")


def run(n_users: int, days: int, fraud_prob: float, simulate_drift: bool,
        notes: str):
    print("=" * 60)
    print("STEP 1/3 — Generating fresh transaction data")
    print("=" * 60)
    if simulate_drift:
        # Simulate fraud patterns shifting over time: fraud becomes more
        # frequent and skews further toward high-risk categories/locations.
        # A model trained only on the old distribution should degrade
        # here — that's the point of having a retraining pipeline at all.
        fraud_prob = fraud_prob * 1.6
        print(f"(drift simulation enabled — fraud_prob bumped to {fraud_prob:.4f})")
    df = generate(n_users, days, fraud_prob)
    df.to_csv(DATA_PATH, index=False)
    print(f"Generated {len(df)} rows, fraud rate {df['is_fraud'].mean():.4%}")

    print("\n" + "=" * 60)
    print("STEP 2/3 — Training & evaluating candidate models")
    print("=" * 60)
    version, promoted, metadata = train_and_evaluate(
        notes=notes or ("drift-simulated retrain" if simulate_drift else "scheduled retrain"),
    )

    print("\n" + "=" * 60)
    print("STEP 3/3 — Candidate saved (not serving)")
    print("=" * 60)
    if promoted:
        print(f"{version} is the first model and was activated as bootstrap.")
    else:
        print(f"{version} is a CANDIDATE. Promotion needs a change request and a second person's approval; "
              f"nothing was reloaded.")

    print("\nDone.")
    return version, promoted


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--n_users", type=int, default=3100)
    parser.add_argument("--days", type=int, default=90)
    parser.add_argument("--fraud_prob", type=float, default=0.015)
    parser.add_argument("--simulate-drift", action="store_true",
                         help="Simulate fraud patterns evolving, to demonstrate retraining actually matters")
    parser.add_argument("--notes", type=str, default="")
    args = parser.parse_args()

    try:
        run(args.n_users, args.days, args.fraud_prob, args.simulate_drift,
            args.notes)
    except Exception as e:
        print(f"Retraining pipeline FAILED: {e}")
        sys.exit(1)
