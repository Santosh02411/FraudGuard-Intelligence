"""An unavailable embedding model must degrade gracefully, never freeze the service."""
import asyncio
import dataclasses
import time

import app.memory as memmod
from app.config import load_settings
from tests.conftest import tx


async def test_unready_embeddings_fail_fast_with_503_while_the_service_stays_responsive(client, monkeypatch):
    mem = client.memory
    monkeypatch.setattr(mem, "_embed", {"state": "failed", "error": "OSError: model download blocked", "attempted_at": time.monotonic()})
    monkeypatch.setattr(mem, "_warm_task", None)

    started = time.monotonic()
    ing = await client.post("/v1/ingest", json={"transactions": [tx(800)]})
    sea = await client.post("/v1/search", json={"query": "anything at all"})
    assert ing.status_code == 503 and sea.status_code == 503
    assert ing.headers.get("retry-after") == "30"
    assert "not ready" in ing.json()["detail"]

    health = (await client.get("/v1/health")).json()
    assert health["status"] == "degraded"
    assert health["embeddings"]["state"] == "failed" and "download blocked" in health["embeddings"]["error"]
    assert health["checks"]["vector_store"]["ok"] is False
    assert (await client.get("/health")).status_code == 200            # liveness unaffected
    assert (await client.get("/v1/stats")).status_code == 200            # graph-only reads still work
    assert time.monotonic() - started < 5                                # nothing waited on the broken embedder


async def test_a_blocking_embedding_warmup_does_not_freeze_the_event_loop(monkeypatch):
    settings = dataclasses.replace(load_settings(), warmup_timeout_s=1)

    def blocking_engine():           # what an unreachable model download looks like: a long synchronous call
        time.sleep(3)
        return object()

    monkeypatch.setattr(memmod, "get_vector_engine", blocking_engine)
    mem = memmod.CogneeMemory(settings)
    ticks = 0

    async def ticker():
        nonlocal ticks
        while True:
            await asyncio.sleep(0.05)
            ticks += 1

    t = asyncio.create_task(ticker())
    await mem._warm_embeddings()
    t.cancel()
    assert mem._embed["state"] == "failed"
    assert ticks >= 10               # the loop kept running during the ~1 s warm-up (a frozen loop gives ~0)


async def test_recovered_embeddings_are_picked_up_without_a_restart(client, monkeypatch):
    mem = client.memory
    monkeypatch.setattr(mem, "_embed", {"state": "failed", "error": "x", "attempted_at": time.monotonic() - 60})
    monkeypatch.setattr(mem, "_warm_task", None)
    r = await client.post("/v1/search", json={"query": "card testing small purchases"})   # triggers a retry; engines work here
    assert r.status_code in (200, 503)
    await asyncio.sleep(0.5)
    assert mem._embed["state"] == "ready"
    assert (await client.post("/v1/search", json={"query": "card testing small purchases"})).status_code == 200
