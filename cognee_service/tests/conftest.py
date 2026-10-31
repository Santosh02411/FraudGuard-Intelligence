import os
import tempfile

_TMP = tempfile.mkdtemp(prefix="fg-cognee-test-")
os.environ.update({
    "COGNEE_DATA_DIR": _TMP,
    "COGNEE_SERVICE_ENV": "test",
    "COGNEE_SERVICE_API_KEY": "test-service-key-0123456789abcdef0123456789",
    "COGNEE_DATASET": "fraudguard-test",
    "COGNEE_COGNIFY_DEBOUNCE_S": "0",
    "EMBEDDING_PROVIDER": "openai", "EMBEDDING_MODEL": "openai/text-embedding-3-small",
    "EMBEDDING_DIMENSIONS": "64", "EMBEDDING_API_KEY": "x", "LLM_API_KEY": "test-llm-key",
    "COGNEE_SKIP_CONNECTION_TEST": "true", "COGNEE_LOGGING_LEVEL": "ERROR", "LOG_LEVEL": "ERROR",
})

import app.bootstrap  # noqa: E402,F401
import cognee  # noqa: E402,F401
from tests import offline_harness  # noqa: E402

offline_harness.install_embeddings()
offline_harness.install_llm()

import httpx  # noqa: E402
import pytest  # noqa: E402
import pytest_asyncio  # noqa: E402

from app.config import load_settings  # noqa: E402
from app.main import create_app  # noqa: E402

KEY = os.environ["COGNEE_SERVICE_API_KEY"]
H = {"X-Cognee-Service-Key": KEY}


def acct(n): return f"acct_{n:020x}"
def dev(n): return f"dev_{n:020x}"


def tx(sid, *, customer=1, merchant="Acme Electronics", device=None, amount=120.0, score=50, risk="medium",
       reasons=("Unusual amount",), verdict=None, notes=(), chash=None, **extra):
    rec = {
        "source_type": "transaction", "source_id": str(sid), "content_hash": chash or f"hash-{sid}-0000000000",
        "occurred_at": "2026-10-20T10:00:00Z", "customer_ref": acct(customer), "merchant": merchant,
        "category": "electronics", "location": "Lagos", "amount": amount, "fraud_score": score, "risk_level": risk,
        "scoring_method": "xgboost", "flagged": risk in ("high", "critical"), "detection_reasons": list(reasons),
        "verdict": verdict, "analyst_notes": list(notes),
    }
    if device is not None:
        rec["device_ref"] = dev(device)
    rec.update(extra)
    return rec


@pytest_asyncio.fixture(scope="session")
async def client():
    app = create_app(load_settings())
    async with app.router.lifespan_context(app):
        # Embedding warm-up runs in the background and requests fail fast with 503 until it finishes (see
        # CogneeMemory.ensure_embeddings). On a slow/busy machine that can exceed the request grace period, so wait here -
        # otherwise the first test would race the warm-up. Production clients get the same effect from retrying.
        import asyncio
        await asyncio.wait_for(asyncio.shield(app.state.memory._warm_task), 120)
        assert app.state.memory._embed["state"] == "ready"
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://cognee.test", headers=H) as c:
            c.memory = app.state.memory
            yield c
