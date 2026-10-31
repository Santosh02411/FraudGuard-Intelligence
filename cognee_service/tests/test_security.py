"""Service authentication and payload protection."""
import httpx
import pytest

from app.config import Settings, validate_auth_config
from app.sanitize import redact, reject_forbidden_keys, ForbiddenFieldError
from tests.conftest import tx, H


async def test_every_v1_route_requires_the_service_key(client):
    anon = httpx.AsyncClient(transport=client._transport, base_url="http://cognee.test")
    for method, path in [("get", "/v1/health"), ("get", "/v1/stats"), ("post", "/v1/search"), ("post", "/v1/ingest"),
                         ("post", "/v1/assistant"), ("get", "/v1/entities"), ("get", "/v1/entities/x/related")]:
        r = await getattr(anon, method)(path)
        assert r.status_code == 401, path
    bad = await anon.get("/v1/stats", headers={"X-Cognee-Service-Key": "wrong-key-wrong-key-wrong-key-0000"})
    assert bad.status_code == 403
    assert (await anon.get("/health")).status_code == 200      # liveness probe stays open and reveals nothing else
    assert "dataset" not in (await anon.get("/health")).text


def test_production_refuses_unsafe_auth_config():
    base = dict(env="production", dataset="d", api_key="", auth_disabled=False, max_batch=10, op_timeout_s=5,
                cognify_timeout_s=30, cognify_debounce_s=0, narratives_enabled=True, state_dir="/tmp")
    with pytest.raises(RuntimeError, match="COGNEE_SERVICE_API_KEY"):
        validate_auth_config(Settings(**base))
    with pytest.raises(RuntimeError, match="COGNEE_AUTH_DISABLED"):
        validate_auth_config(Settings(**{**base, "auth_disabled": True, "api_key": "k" * 40}))
    validate_auth_config(Settings(**{**base, "api_key": "k" * 40}))   # a proper key is accepted


@pytest.mark.parametrize("field", ["card_number", "cvv", "password", "api_key", "ip_address", "device_fingerprint", "email", "account_number", "access_token"])
async def test_credential_and_identifier_fields_are_rejected(client, field):
    rec = tx(900, customer=1)
    rec["analyst_notes"] = []
    body = {"transactions": [{**rec, field: "4111111111111111"}]}
    r = await client.post("/v1/ingest", json=body)
    assert r.status_code == 422, (field, r.text)


async def test_raw_identifiers_are_not_accepted_as_references(client):
    rec = tx(901)
    rec["customer_ref"] = "42"                       # a raw user id, not a pseudonym
    assert (await client.post("/v1/ingest", json={"transactions": [rec]})).status_code == 422
    rec = tx(902); rec["device_ref"] = "Mozilla/5.0"
    assert (await client.post("/v1/ingest", json={"transactions": [rec]})).status_code == 422


async def test_unknown_fields_are_rejected(client):
    assert (await client.post("/v1/ingest", json={"transactions": [{**tx(903), "surprise": 1}]})).status_code == 422


def test_redaction_covers_pii_and_secrets():
    text = ("Call +1 (415) 555-0100 or mail jane.doe@example.com; card 4111 1111 1111 1111; ip 203.0.113.9; "
            "ssn 123-45-6789; token sk_live_abcdef1234567890abcdef; jwt eyJhbGciOi.eyJzdWIiOiIx.SflKxwRJSMeKKF2QT4fw")
    out = redact(text)
    for leaked in ("415", "jane.doe", "4111", "203.0.113.9", "123-45-6789", "abcdef1234567890", "eyJhbGciOi"):
        assert leaked not in out, leaked


async def test_notes_are_redacted_before_they_reach_memory(client):
    await client.post("/v1/ingest", json={"transactions": [tx(910, customer=9, notes=["Customer jane@example.com paid with 4111 1111 1111 1111 from 198.51.100.7"])]})
    ev = (await client.post("/v1/search", json={"query": "customer paid with card from", "top_k": 25})).json()["evidence"]
    mine = [e for e in ev if e["source_key"] == "transaction:910"][0]["snippet"]
    assert "jane@example.com" not in mine and "4111" not in mine and "198.51.100.7" not in mine
    assert "[redacted" in mine


def test_forbidden_key_guard_is_recursive():
    with pytest.raises(ForbiddenFieldError):
        reject_forbidden_keys({"a": [{"b": {"cvv": "123"}}]})
    reject_forbidden_keys({"customer_ref": "acct_x", "device_ref": "dev_x"})


async def test_validation_errors_do_not_echo_submitted_values(client):
    r = await client.post("/v1/ingest", json={"transactions": [{**tx(904), "customer_ref": "raw-user-4242-secret"}]})
    assert r.status_code == 422 and "errors" in r.json()
    assert "raw-user-4242-secret" not in r.text
