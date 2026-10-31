"""Authorization tests for the ML service (run: cd ml_service && python -m pytest tests -q).

Proves: anonymous callers and callers holding only the *service* key cannot
reach any model-management route; wrong keys are rejected; the admin key
works; the service fails closed when a key isn't configured; and an unsafe
production config refuses to boot.
"""
import importlib
import os

import pytest
from fastapi.testclient import TestClient

SERVICE_KEY = "s" * 40
ADMIN_KEY = "a" * 40

PREDICT_BODY = {"amount": 50.0, "category": "grocery", "location": "New York, US"}

SERVICE_ROUTES = [
    ("get", "/metrics"), ("get", "/model/versions"), ("get", "/model/drift"),
    ("get", "/model/shadow/status"), ("post", "/predict"),
]
ADMIN_ROUTES = [
    ("post", "/model/reload"), ("post", "/model/rollback"), ("post", "/model/drift/reset"),
    ("post", "/model/shadow/set"), ("post", "/model/shadow/clear"), ("post", "/model/shadow/promote"),
]


def _call(client, method, path, headers=None):
    kwargs = {"headers": headers or {}}
    if method == "post":
        kwargs["json"] = PREDICT_BODY if path == "/predict" else {"version": "v1"}
    return getattr(client, method)(path, **kwargs)


@pytest.fixture()
def client(monkeypatch):
    monkeypatch.setenv("ML_SERVICE_API_KEY", SERVICE_KEY)
    monkeypatch.setenv("ML_ADMIN_API_KEY", ADMIN_KEY)
    monkeypatch.delenv("ML_AUTH_DISABLED", raising=False)
    monkeypatch.delenv("ML_ENV", raising=False)
    import app as app_module
    with TestClient(app_module.app) as c:
        yield c


def test_health_is_open_and_leaks_no_model_details(client):
    r = client.get("/health")
    assert r.status_code == 200
    assert set(r.json().keys()) == {"status"}


@pytest.mark.parametrize("method,path", SERVICE_ROUTES + ADMIN_ROUTES)
def test_anonymous_callers_are_rejected_everywhere(client, method, path):
    assert _call(client, method, path).status_code == 401


@pytest.mark.parametrize("method,path", SERVICE_ROUTES + ADMIN_ROUTES)
def test_wrong_keys_are_rejected(client, method, path):
    headers = {"X-ML-Api-Key": "wrong" * 8, "X-ML-Admin-Key": "wrong" * 8}
    assert _call(client, method, path, headers).status_code == 403


@pytest.mark.parametrize("method,path", ADMIN_ROUTES)
def test_service_key_cannot_manage_models(client, method, path):
    """The key the backend uses to score transactions must NOT be able to
    promote/roll back/reload models or change shadow config."""
    r = _call(client, method, path, {"X-ML-Api-Key": SERVICE_KEY})
    assert r.status_code == 401


@pytest.mark.parametrize("method,path", SERVICE_ROUTES)
def test_admin_key_is_not_a_service_key(client, method, path):
    assert _call(client, method, path, {"X-ML-Admin-Key": ADMIN_KEY}).status_code == 401


def test_service_key_can_score_and_read_monitoring(client):
    h = {"X-ML-Api-Key": SERVICE_KEY}
    assert client.post("/predict", json=PREDICT_BODY, headers=h).status_code == 200
    assert client.get("/model/versions", headers=h).status_code == 200
    assert client.get("/model/shadow/status", headers=h).status_code == 200


def test_admin_key_reaches_admin_routes(client):
    h = {"X-ML-Admin-Key": ADMIN_KEY}
    assert client.post("/model/shadow/clear", headers=h).status_code == 200
    assert client.post("/model/reload", headers=h).status_code == 200
    # authorized, but there is no shadow model to promote -> a business error, not an auth error
    assert client.post("/model/shadow/promote", headers=h).status_code not in (401, 403)


def test_fails_closed_when_a_key_is_not_configured(monkeypatch, client):
    monkeypatch.delenv("ML_SERVICE_API_KEY")
    assert client.post("/predict", json=PREDICT_BODY, headers={"X-ML-Api-Key": ""}).status_code == 503
    assert client.post("/predict", json=PREDICT_BODY, headers={"X-ML-Api-Key": "anything"}).status_code == 503


def test_explicit_dev_opt_out_disables_auth(monkeypatch, client):
    monkeypatch.setenv("ML_AUTH_DISABLED", "true")
    assert client.post("/predict", json=PREDICT_BODY).status_code == 200


class TestProductionBootGuard:
    def _validate(self, monkeypatch, **env):
        for k in ("ML_ENV", "ML_AUTH_DISABLED", "ML_SERVICE_API_KEY", "ML_ADMIN_API_KEY"):
            monkeypatch.delenv(k, raising=False)
        for k, v in env.items():
            monkeypatch.setenv(k, v)
        from utils import auth
        importlib.reload(auth)
        auth.validate_auth_config()

    def test_production_without_keys_refuses_to_boot(self, monkeypatch):
        with pytest.raises(RuntimeError, match="ML_SERVICE_API_KEY"):
            self._validate(monkeypatch, ML_ENV="production")

    def test_production_rejects_auth_disabled(self, monkeypatch):
        with pytest.raises(RuntimeError, match="ML_AUTH_DISABLED"):
            self._validate(monkeypatch, ML_ENV="production", ML_AUTH_DISABLED="true",
                           ML_SERVICE_API_KEY=SERVICE_KEY, ML_ADMIN_API_KEY=ADMIN_KEY)

    def test_production_rejects_short_or_identical_keys(self, monkeypatch):
        with pytest.raises(RuntimeError, match="at least 32"):
            self._validate(monkeypatch, ML_ENV="production", ML_SERVICE_API_KEY="short", ML_ADMIN_API_KEY=ADMIN_KEY)
        with pytest.raises(RuntimeError, match="must be different"):
            self._validate(monkeypatch, ML_ENV="production", ML_SERVICE_API_KEY=SERVICE_KEY, ML_ADMIN_API_KEY=SERVICE_KEY)

    def test_production_with_good_keys_boots(self, monkeypatch):
        self._validate(monkeypatch, ML_ENV="production", ML_SERVICE_API_KEY=SERVICE_KEY, ML_ADMIN_API_KEY=ADMIN_KEY)
