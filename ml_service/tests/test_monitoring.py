"""Feature-quality reporting on /predict and batch drift evaluation (the backend's persistent drift snapshots call this)."""
import json
import os
import shutil

import pytest
from fastapi.testclient import TestClient

from utils import monitor_store

SERVICE_KEY, ADMIN_KEY = "s" * 40, "a" * 40
SVC = {"X-ML-Api-Key": SERVICE_KEY}
REAL_REGISTRY = "models/registry"


@pytest.fixture()
def client(monkeypatch, tmp_path):
    if not os.path.exists(os.path.join(REAL_REGISTRY, "v3", "manifest.json")):
        pytest.skip("registry v3 with manifest not present")
    reg = tmp_path / "registry"
    shutil.copytree(os.path.join(REAL_REGISTRY, "v3"), reg / "v3")
    (tmp_path / "current.json").write_text(json.dumps({"version": "v3"}))
    monkeypatch.setenv("ML_SERVICE_API_KEY", SERVICE_KEY)
    monkeypatch.setenv("ML_ADMIN_API_KEY", ADMIN_KEY)
    for k in ("ML_AUTH_DISABLED", "ML_ENV", "MODEL_SIGNING_KEY", "ML_ALLOW_UNVERIFIED_MODELS"):
        monkeypatch.delenv(k, raising=False)
    import app as m
    monkeypatch.setattr(m, "REGISTRY_DIR", str(reg))
    monkeypatch.setattr(m, "CURRENT_VERSION_PATH", str(tmp_path / "current.json"))
    monitor_store.reset_for_tests(str(tmp_path / "monitor.db"))
    m.STATE["shadow_version"] = None
    with TestClient(m.app) as c:
        yield c, m
    monitor_store.reset_for_tests()


def row(**o):
    return {"amount": 50.0, "category": "grocery", "location": "New York, US", "card_type": "credit", "hour": 14, "day_of_week": 2,
            "distance_from_home": 1.0, "geo_distance_from_last_km": 0.0, "time_since_last_transaction_minutes": 600.0,
            "ratio_to_median_purchase_price": 1.0, "spending_zscore": 0.1, "repeat_retailer": 1, "velocity_last_hour": 0, "is_new_device": 0, "ip_status": "known", **o}


def test_predict_reports_defaulted_inputs_and_unseen_categories(client):
    c, _ = client
    r = c.post("/predict", headers=SVC, json={"amount": 10.0, "category": "grocery", "location": "New York, US"})
    assert r.status_code == 200
    q = r.json()["feature_quality"]
    assert "hour" in q["defaulted"] and "velocity_last_hour" in q["defaulted"]
    assert "amount" not in q["defaulted"] and q["unseen_categories"] == {}

    full = c.post("/predict", headers=SVC, json=row()).json()["feature_quality"]
    assert "hour" not in full["defaulted"]

    odd = c.post("/predict", headers=SVC, json=row(category="space_tourism")).json()["feature_quality"]
    assert odd["unseen_categories"] == {"category": "space_tourism"}


def test_drift_evaluate_is_stateless_and_flags_a_shifted_batch(client):
    c, m = client
    before = len(m.STATE["live_buffer"])
    calm = [row(amount=20 + (i % 30), velocity_last_hour=i % 2) for i in range(120)]
    shifted = [row(amount=9000 + i, category="crypto", location="Anonymous Proxy", velocity_last_hour=9, is_new_device=1, ip_status="new") for i in range(120)]
    a = c.post("/model/drift/evaluate", headers=SVC, json={"rows": calm, "version": "v3"}).json()
    b = c.post("/model/drift/evaluate", headers=SVC, json={"rows": shifted, "scores": [80.0] * 120, "version": "v3"}).json()
    assert len(m.STATE["live_buffer"]) == before            # never mutates the live buffers
    assert b["status"] in ("moderate_drift", "significant_drift")
    assert max(b["feature_psi"].values()) > max(a["feature_psi"].values())
    assert b["score_drift"]["live_high_risk_rate"] == 1.0
    assert b["n_samples"] == 120


def test_drift_evaluate_refuses_other_versions_and_bad_input(client):
    c, _ = client
    assert c.post("/model/drift/evaluate", headers=SVC, json={"rows": [row()], "version": "v9"}).status_code == 409
    assert c.post("/model/drift/evaluate", headers=SVC, json={"rows": [row()], "scores": [1.0, 2.0]}).status_code == 422
    assert c.post("/model/drift/evaluate", headers=SVC, json={"rows": []}).status_code == 422
    assert c.post("/model/drift/evaluate", json={"rows": [row()]}).status_code in (401, 403)


def test_unseen_category_rows_are_counted_in_batch(client):
    c, _ = client
    rows = [row(category="space_tourism") for _ in range(3)] + [row() for _ in range(2)]
    r = c.post("/model/drift/evaluate", headers=SVC, json={"rows": rows}).json()
    assert r["unseen_category_rows"] == {"category": 3}
