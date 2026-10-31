"""
Downloads the public credit-card fraud dataset used by evaluation/run_public.py.

    cd ml_service && python3 -m evaluation.fetch_public_dataset
    # or, if you downloaded it yourself (e.g. from Kaggle/OpenML):
    python3 -m evaluation.fetch_public_dataset --path ~/Downloads/creditcard.csv

Dataset: "Credit Card Fraud Detection" — real European cardholder transactions
from two days in September 2013, 284,807 rows, 492 frauds (0.172%). Features
V1-V28 are PCA components (the originals are confidential), plus Time, Amount,
Class. Collected and analysed by Worldline and the Machine Learning Group of
Universite Libre de Bruxelles (ULB).
  * Canonical home: https://www.kaggle.com/datasets/mlg-ulb/creditcardfraud
    and https://www.openml.org/d/1597
  * Licence: Database Contents License (DbCL) v1.0 — confirm the terms at the
    canonical source before redistributing; this repo does NOT bundle the file.
  * Citation: Dal Pozzolo, Caelen, Johnson, Bontempi. "Calibrating Probability
    with Undersampling for Unbalanced Classification." IEEE SSCI 2015.

The file is checked for the published shape (284,807 x 31, 492 positives)
before it is accepted, so a truncated or substituted file fails loudly.
"""

import argparse
import hashlib
import os
import shutil
import sys
import urllib.request

import pandas as pd

DEST = "data/public/creditcard.csv"
# A public GitHub mirror of the Kaggle file; used only because the canonical
# hosts need an account. Shape is verified below regardless of source.
MIRROR_URL = "https://raw.githubusercontent.com/nsethi31/Kaggle-Data-Credit-Card-Fraud-Detection/master/creditcard.csv"
EXPECTED = {"rows": 284807, "cols": 31, "frauds": 492}


def verify(path):
    df = pd.read_csv(path)
    got = {"rows": len(df), "cols": df.shape[1], "frauds": int(df["Class"].sum())}
    if got != EXPECTED:
        raise SystemExit(f"Unexpected dataset shape {got}, expected {EXPECTED} — refusing to use {path}")
    sha = hashlib.sha256(open(path, "rb").read()).hexdigest()
    print(f"OK: {got}  sha256={sha}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--path", help="use a file you already downloaded instead of fetching")
    args = ap.parse_args()
    os.makedirs(os.path.dirname(DEST), exist_ok=True)
    if args.path:
        shutil.copy(args.path, DEST)
    else:
        print(f"Downloading from {MIRROR_URL} ...")
        urllib.request.urlretrieve(MIRROR_URL, DEST)
    verify(DEST)
    print(f"Saved -> {DEST}")


if __name__ == "__main__":
    sys.exit(main())
