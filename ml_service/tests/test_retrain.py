"""Controlled retraining from verified labels: lineage check, size guards, candidate-only, single run at a time."""
import hashlib
import json
import os
import shutil
import time

import pandas as pd
import pytest
from fastapi.testclient import TestClient

from generate_dataset import generate

SERVICE_KEY, ADMIN_KEY = "s" * 40, "a" * 40
SVC, ADM = {"X-ML-Api-Key": SERVICE_KEY}, {"X-ML-Admin-Key": ADMIN_KEY}
REAL_REGISTRY = "models/registry"


@pytest.fixture()
def env(monkeypatch, tmp_path):
    if not os.path.exists(os.path.join(REAL_REGISTRY, "v3", "manifest.json")):
        pytest.skip("registry v3 with manifest not present")
    reg = tmp_path / "registry"
    shutil.copytree(os.path.join(REAL_REGISTRY, "v3"), reg / "v3")
    cur = tmp_path / "current.json"
    cur.write_text(json.dumps({"version": "v3"}))
    monkeypatch.setenv("ML_SERVICE_API_KEY", SERVICE_KEY)
    monkeypatch.setenv("ML_ADMIN_API_KEY", ADMIN_KEY)
    for k in ("ML_AUTH_DISABLED", "ML_ENV", "MODEL_SIGNING_KEY", "ML_ALLOW_UNVERIFIED_MODELS"):
        monkeypatch.delenv(k, raising=False)
    import app as m
    import train_model as tm
    from utils import monitor_store
    for mod in (m, tm):
        monkeypatch.setattr(mod, "REGISTRY_DIR", str(reg))
        monkeypatch.setattr(mod, "CURRENT_VERSION_PATH", str(cur))
    monkeypatch.setattr(tm, "TRAINING_LOG_PATH", str(tmp_path / "training_log.json"))
    monkeypatch.chdir(tmp_path)  # reports/<version> plots land in the tmp dir
    monitor_store.reset_for_tests(str(tmp_path / "monitor.db"))
    m.STATE["shadow_version"] = None
    m.RETRAIN.clear(); m.RETRAIN.update(state="idle")
    with TestClient(m.app) as c:
        yield c, m, reg, cur
    monitor_store.reset_for_tests()


def payload(df, **o):
    csv = df.to_csv(index=False)
    return {"dataset_csv": csv, "dataset_sha256": hashlib.sha256(csv.encode()).hexdigest(),
            "dataset_info": {"label_policy": "second_person_verified"}, "notes": "test retrain", "requested_by": "tester", **o}


@pytest.fixture(scope="module")
def small_df():
    df = generate(n_users=250, days=45, fraud_prob=0.05)
    return df


def test_requires_the_admin_key(env, small_df):
    c, *_ = env
    assert c.post("/model/retrain", json=payload(small_df), headers=SVC).status_code in (401, 403)
    assert c.post("/model/retrain", json=payload(small_df)).status_code in (401, 403)


def test_refuses_a_dataset_whose_hash_does_not_match(env, small_df):
    c, *_ = env
    p = payload(small_df)
    p["dataset_sha256"] = "0" * 64
    r = c.post("/model/retrain", json=p, headers=ADM)
    assert r.status_code == 422 and "sha256" in r.json()["detail"]


def test_refuses_missing_columns_and_tiny_datasets(env, small_df):
    c, *_ = env
    r = c.post("/model/retrain", json=payload(small_df.drop(columns=["spending_zscore"])), headers=ADM)
    assert r.status_code == 422 and "missing required columns" in r.json()["detail"]
    r = c.post("/model/retrain", json=payload(small_df.head(50)), headers=ADM)
    assert r.status_code == 422 and "too small" in r.json()["detail"]


def test_trains_a_candidate_only_and_records_lineage(env, small_df):
    c, m, reg, cur = env
    r = c.post("/model/retrain", json=payload(small_df), headers=ADM)
    assert r.status_code == 202, r.text
    assert r.json()["note"].startswith("Trains a CANDIDATE only")
    for _ in range(240):
        st = c.get("/model/retrain/status", headers=SVC).json()
        if st["state"] != "running":
            break
        time.sleep(1)
    assert st["state"] == "succeeded", st
    assert st["bootstrap_activated"] is False
    v = st["version"]
    meta = json.load(open(reg / v / "metadata.json"))
    assert meta["status"] == "candidate" and meta["dataset"] == "verified_labels"
    assert meta["dataset_info"]["sha256"] == payload(small_df)["dataset_sha256"]
    assert json.load(open(cur))["version"] == "v3"  # the serving version did not change
    metrics = json.load(open(reg / v / "metrics.json"))
    assert "selection-biased" in metrics["evaluation"]["disclaimer"]


def test_only_one_run_at_a_time(env, small_df):
    c, m, *_ = env
    assert m._RETRAIN_LOCK.acquire(blocking=False)
    try:
        r = c.post("/model/retrain", json=payload(small_df), headers=ADM)
        assert r.status_code == 409
    finally:
        m._RETRAIN_LOCK.release()
