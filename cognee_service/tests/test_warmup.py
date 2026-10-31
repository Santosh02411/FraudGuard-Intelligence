"""While the embedding model is still warming up, requests answer 503 + Retry-After quickly, then succeed once ready."""
import asyncio
import time

from tests.conftest import tx


async def test_requests_during_warmup_get_503_then_succeed_when_ready(client, monkeypatch):
    mem = client.memory
    real_state = dict(mem._embed)
    gate = asyncio.Event()

    async def slow_warmup():
        mem._embed.update(state="warming", error=None, attempted_at=time.monotonic())
        await gate.wait()
        mem._embed.update(state="ready", error=None)

    monkeypatch.setattr(mem, "_embed", {"state": "not_started", "error": None, "attempted_at": 0.0})
    mem._warm_task = asyncio.create_task(slow_warmup())
    started = time.monotonic()
    r = await client.post("/v1/ingest", json={"transactions": [tx(950)]})
    assert r.status_code == 503 and r.headers["retry-after"] == "30" and "warming" in r.json()["detail"]
    assert time.monotonic() - started < 6                      # bounded wait (grace period), never hangs

    gate.set(); await mem._warm_task                           # the model finishes loading
    ok = await client.post("/v1/ingest", json={"transactions": [tx(950)]})
    assert ok.status_code == 200 and ok.json()["ingested"] == 1
    mem._embed.update(real_state)
