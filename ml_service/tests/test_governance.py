"""Model governance on the ML side: artifact integrity, gates, activation,
persistent monitoring, and the labelled challenger-vs-incumbent comparison.

Runs against a COPY of the registry in a temp dir (never the real one).
"""
import json
import os
import shutil

import joblib
import numpy as np
import pandas as pd
import pytest
from fastapi.testclient import TestClient

from utils import artifacts, monitor_store

SERVICE_KEY, ADMIN_KEY = "s" * 40, "a" * 40
SVC = {"X-ML-Api-Key": SERVICE_KEY}
ADM = {"X-ML-Admin-Key": ADMIN_KEY}
TXN = {"amount": 50.0, "category": "grocery", "location": "New York, US"}
REAL_REGISTRY = "models/registry"


@pytest.fixture(scope="module")
def have_versions():
    for v in ("v3", "v4"):
        if not os.path.exists(os.path.join(REAL_REGISTRY, v, "manifest.json")):
            pytest.skip(f"registry {v} with manifest not present")


@pytest.fixture()
def env(monkeypatch, tmp_path, have_versions):
    reg = tmp_path / "registry"
    for v in ("v3", "v4"):
        shutil.copytree(os.path.join(REAL_REGISTRY, v), reg / v)
    (tmp_path / "current.json").write_text(json.dumps({"version": "v3"}))
    monkeypatch.setenv("ML_SERVICE_API_KEY", SERVICE_KEY)
    monkeypatch.setenv("ML_ADMIN_API_KEY", ADMIN_KEY)
    monkeypatch.delenv("ML_AUTH_DISABLED", raising=False)
    monkeypatch.delenv("ML_ENV", raising=False)
    monkeypatch.delenv("MODEL_SIGNING_KEY", raising=False)
    monkeypatch.delenv("ML_ALLOW_UNVERIFIED_MODELS", raising=False)
    import app as m
    monkeypatch.setattr(m, "REGISTRY_DIR", str(reg))
    monkeypatch.setattr(m, "CURRENT_VERSION_PATH", str(tmp_path / "current.json"))
    monitor_store.reset_for_tests(str(tmp_path / "monitor.db"))
    m.STATE["shadow_version"] = None
    with TestClient(m.app) as c:
        yield c, m, reg, tmp_path
    monitor_store.reset_for_tests()


def test_manifest_verifies_and_detects_tampering(env):
    c, m, reg, _ = env
    assert artifacts.verify(str(reg / "v4"))["ok"]
    with open(reg / "v4" / "calibrator.pkl", "ab") as f:
        f.write(b"\0")
    bad = artifacts.verify(str(reg / "v4"))
    assert not bad["ok"]
    assert any(ch["name"] == "sha256:calibrator.pkl" and not ch["ok"] for ch in bad["checks"])


def test_signed_manifest_rejects_forged_manifest(env, monkeypatch):
    _, _, reg, _ = env
    monkeypatch.setenv("MODEL_SIGNING_KEY", "k" * 32)
    artifacts.write_manifest(str(reg / "v4"), "v4", json.load(open(reg / "v4" / "feature_columns.json")))
    assert artifacts.verify(str(reg / "v4"))["ok"]
    # attacker edits a pickle and regenerates the manifest WITHOUT the key
    monkeypatch.setenv("MODEL_SIGNING_KEY", "x" * 32)
    with open(reg / "v4" / "model.pkl", "ab") as f:
        f.write(b"\0")
    artifacts.write_manifest(str(reg / "v4"), "v4", json.load(open(reg / "v4" / "feature_columns.json")))
    monkeypatch.setenv("MODEL_SIGNING_KEY", "k" * 32)
    r = artifacts.verify(str(reg / "v4"))
    assert not r["ok"] and any(ch["name"] == "signature" and not ch["ok"] for ch in r["checks"])


def test_tampered_version_cannot_be_activated_and_incumbent_keeps_serving(env):
    c, m, reg, tmp = env
    with open(reg / "v4" / "model.pkl", "ab") as f:
        f.write(b"tamper")
    r = c.post("/model/activate", headers=ADM, json={"version": "v4", "reason": "test"})
    assert r.status_code == 409 and "integrity" in r.json()["detail"]
    assert m.STATE["version"] == "v3"
    assert json.loads((tmp / "current.json").read_text())["version"] == "v3"
    assert c.post("/predict", headers=SVC, json=TXN).json()["model_version"] == "v3"
    gates = c.get("/model/versions/v4/gates", headers=SVC).json()
    assert gates["summary"]["blocked"] and "artifact_integrity" in gates["summary"]["hard_failures"]
    # nothing after the integrity gate was computed (no pickle of the bad version is touched)
    assert [g["id"] for g in gates["gates"]] == ["artifact_integrity"]


def test_version_without_manifest_is_refused(env):
    c, m, reg, _ = env
    os.remove(reg / "v4" / "manifest.json")
    assert c.post("/model/activate", headers=ADM, json={"version": "v4", "reason": "x"}).status_code == 409
    assert c.post("/model/shadow/set", headers=ADM, json={"version": "v4"}).status_code == 409


def test_activate_and_rollback_record_actor_reason_and_previous(env):
    c, m, _, tmp = env
    r = c.post("/model/activate", headers=ADM, json={"version": "v4", "reason": "approved change #7", "actor": "alice", "change_id": 7})
    assert r.status_code == 200 and r.json()["previous_version"] == "v3"
    ptr = json.loads((tmp / "current.json").read_text())
    assert ptr["version"] == "v4" and ptr["previous"] == "v3" and ptr["actor"] == "alice" and ptr["change_id"] == 7
    assert c.post("/predict", headers=SVC, json=TXN).json()["model_version"] == "v4"
    rb = c.post("/model/activate", headers=ADM, json={"version": "v3", "reason": "latency", "kind": "rollback"})
    assert rb.status_code == 200 and m.STATE["version"] == "v3"
    assert c.post("/model/activate", headers=ADM, json={"version": "v9", "reason": "x"}).status_code == 404


def test_activation_endpoint_needs_admin_key(env):
    c, *_ = env
    body = {"version": "v4", "reason": "x"}
    assert c.post("/model/activate", json=body).status_code == 401
    assert c.post("/model/activate", headers=SVC, json=body).status_code in (401, 403)
    assert c.get("/model/versions/v4/gates").status_code == 401


def test_shadow_promote_is_disabled(env):
    c, *_ = env
    assert c.post("/model/shadow/promote", headers=ADM).status_code == 410


def test_gates_pass_for_good_candidate_and_comparison_is_opt_in(env):
    c, *_ = env
    g = c.get("/model/versions/v4/gates", params={"incumbent": "v3"}, headers=SVC).json()
    status = {x["id"]: x["status"] for x in g["gates"]}
    for gid in ("artifact_integrity", "runtime_compat", "feature_schema", "smoke_score", "calibrated", "required_metrics"):
        assert status[gid] == "pass", g
    assert status["benchmark_comparison"] == "insufficient"          # not run unless asked
    assert not g["summary"]["blocked"] and g["summary"]["needs_acknowledgement"] == ["benchmark_comparison"]


def test_monitoring_state_survives_a_restart(env):
    c, m, _, tmp = env
    for _ in range(12):
        assert c.post("/predict", headers=SVC, json=TXN).status_code == 200
    assert len(m.STATE["live_buffer"]) == 12
    assert c.post("/model/shadow/set", headers=ADM, json={"version": "v4"}).status_code == 200
    for _ in range(5):
        out = c.post("/predict", headers=SVC, json=TXN).json()
    assert out["shadow"]["version"] == "v4" and 0 <= out["shadow"]["fraud_probability"] <= 1
    # simulate a process restart: wipe memory, rerun startup
    from collections import deque
    m.STATE["live_buffer"], m.STATE["score_buffer"] = deque(maxlen=2000), deque(maxlen=2000)
    m.STATE["shadow_comparisons"] = deque(maxlen=1000)
    m.STATE["shadow_version"] = None
    m.startup()
    assert len(m.STATE["live_buffer"]) == 17
    assert m.STATE["shadow_version"] == "v4"
    assert c.get("/model/shadow/status", headers=SVC).json()["n_compared"] == 5


def test_drift_reset_and_shadow_clear_also_clear_the_store(env):
    c, m, *_ = env
    for _ in range(4):
        c.post("/predict", headers=SVC, json=TXN)
    c.post("/model/drift/reset", headers=ADM)
    assert monitor_store.load_live("v3", 100) == []
    c.post("/model/shadow/set", headers=ADM, json={"version": "v4"})
    c.post("/predict", headers=SVC, json=TXN)
    c.post("/model/shadow/clear", headers=ADM)
    assert monitor_store.load_shadow("v3", "v4", 100) == [] and monitor_store.get_kv("shadow_version") is None


def test_monitoring_is_per_version(env):
    c, m, *_ = env
    for _ in range(3):
        c.post("/predict", headers=SVC, json=TXN)
    c.post("/model/activate", headers=ADM, json={"version": "v4", "reason": "x"})
    assert len(m.STATE["live_buffer"]) == 0          # v4 has its own (empty) monitoring window
    c.post("/model/activate", headers=ADM, json={"version": "v3", "reason": "x", "kind": "rollback"})
    assert len(m.STATE["live_buffer"]) == 3          # v3's window came back


# ---- the labelled comparison -------------------------------------------------

@pytest.fixture()
def small_benchmark(tmp_path, monkeypatch):
    src = "benchmark/promotion_benchmark.csv"
    if not os.path.exists(src):
        pytest.skip("benchmark not generated")
    df = pd.read_csv(src)
    sample = pd.concat([df[df.is_fraud == 1].sample(300, random_state=1), df[df.is_fraud == 0].sample(14000, random_state=1)])
    p = tmp_path / "bench.csv"
    sample.to_csv(p, index=False)
    monkeypatch.setenv("PROMOTION_BENCHMARK_PATH", str(p))
    return str(p)


def _make_bad_candidate(reg, base="v3", name="v5"):
    """A model that ranks every transaction the same: it must NOT be promotable."""
    from sklearn.dummy import DummyClassifier
    shutil.copytree(reg / base, reg / name)
    os.remove(reg / name / "manifest.json")
    cols = json.load(open(reg / name / "feature_columns.json"))
    X, y = np.zeros((20, len(cols))), np.array([0] * 19 + [1])
    joblib.dump(DummyClassifier(strategy="prior").fit(X, y), reg / name / "model.pkl")
    meta = json.load(open(reg / name / "metadata.json"))
    json.dump({**meta, "version": name}, open(reg / name / "metadata.json", "w"))
    artifacts.write_manifest(str(reg / name), name, cols)


def test_comparison_uses_labels_and_rejects_a_regressing_challenger(env, small_benchmark):
    c, m, reg, _ = env
    _make_bad_candidate(reg)
    g = c.get("/model/versions/v5/gates", params={"incumbent": "v3", "compare": "true"}, headers=SVC).json()
    cmp_gate = next(x for x in g["gates"] if x["id"] == "benchmark_comparison")
    assert cmp_gate["status"] == "fail", cmp_gate
    rep = cmp_gate["data"]
    assert rep["verdict"] == "fail" and rep["benchmark"]["fraud_rows"] == 300
    assert rep["challenger"]["pr_auc"] < rep["incumbent"]["pr_auc"] - 0.3
    assert rep["paired_differences"]["pr_auc"]["ci95"][1] < 0
    assert any("PR-AUC" in r for r in rep["verdict_reasons"])


def test_comparison_of_identical_models_is_not_called_better(env, small_benchmark):
    c, *_ = env
    g = c.get("/model/versions/v4/gates", params={"incumbent": "v3", "compare": "true"}, headers=SVC).json()
    rep = next(x for x in g["gates"] if x["id"] == "benchmark_comparison")["data"]
    assert rep["verdict"] in ("pass", "pass_better")
    assert abs(rep["paired_differences"]["pr_auc"]["mean"]) < 0.01
