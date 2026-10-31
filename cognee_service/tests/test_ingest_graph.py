"""Ingestion, graph construction, idempotency (real Cognee SDK; offline embeddings)."""
from tests.conftest import tx, acct, dev


async def post(client, body):
    r = await client.post("/v1/ingest", json=body)
    return r


async def test_ingest_builds_typed_graph_with_relationships(client):
    recs = [
        tx(1, customer=1, device=1, merchant="Lagos Crypto Exchange", score=92, risk="high",
           reasons=["Rapid velocity: 6 txns in 1h", "New device"], verdict="confirmed_fraud",
           notes=["Customer confirmed card stolen"]),
        tx(2, customer=2, device=1, merchant="Lagos Crypto Exchange", score=88, risk="high", reasons=["Rapid velocity: 5 txns in 1h"]),
        tx(3, customer=3, device=2, merchant="Corner Cafe", score=5, risk="low", reasons=[]),
    ]
    r = await post(client, {"transactions": recs})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["ingested"] == 3 and body["failed"] == 0

    ents = (await client.get("/v1/entities", params={"limit": 100})).json()
    types = {e["type"] for e in ents["entities"]}
    assert {"Transaction", "Customer", "Merchant", "Device", "FraudPattern"} <= types

    # relationships: transaction 1 connects to its customer, merchant, device and patterns
    tx1 = (await client.get("/v1/entities", params={"q": "transaction:1", "type": "Transaction"})).json()["entities"][0]
    rel = (await client.get(f"/v1/entities/{tx1['id']}/related")).json()
    relations = {(e["relation"]) for e in rel["edges"]}
    assert {"made_by", "at_merchant", "from_device", "exhibits_pattern"} <= relations
    labels = {n["label"] for n in rel["nodes"]}
    assert acct(1) in labels and "Lagos Crypto Exchange" in labels and dev(1) in labels
    # "Rapid velocity: 6 txns" and "...: 5 txns" normalise to ONE reusable pattern
    patterns = (await client.get("/v1/entities", params={"type": "FraudPattern"})).json()["entities"]
    assert sum(1 for p in patterns if p["label"] == "rapid velocity") == 1


async def test_shared_device_across_accounts_is_flagged_suspicious(client):
    ents = (await client.get("/v1/entities", params={"type": "Device", "suspicious_only": "true"})).json()
    labels = {e["label"]: e for e in ents["entities"]}
    assert dev(1) in labels and labels[dev(1)]["signals"]["accounts"] == 2
    assert dev(2) not in labels  # single account, no fraud: not suspicious


async def test_reingesting_same_record_does_not_duplicate_nodes_or_edges(client):
    await client.memory.flush_cognify()
    before = (await client.get("/v1/stats")).json()
    r = await post(client, {"transactions": [tx(1, customer=1, device=1, merchant="Lagos Crypto Exchange", score=92, risk="high",
                                                reasons=["Rapid velocity: 6 txns in 1h", "New device"], verdict="confirmed_fraud",
                                                notes=["Customer confirmed card stolen"])]})
    assert r.json()["ingested"] == 1
    await client.memory.flush_cognify()
    after = (await client.get("/v1/stats")).json()
    assert after["structured_entities"] == before["structured_entities"]
    assert after["structured_edges"] == before["structured_edges"]


async def test_updated_record_replaces_properties_in_place(client):
    await post(client, {"transactions": [tx(3, customer=3, device=2, merchant="Corner Cafe", score=5, risk="low", reasons=[],
                                            verdict="false_positive", chash="hash-3-changed-0000")]})
    nid = (await client.get("/v1/entities", params={"q": "transaction:3"})).json()["entities"][0]["id"]
    node = [n for n in (await client.get(f"/v1/entities/{nid}/related")).json()["nodes"] if n["id"] == nid][0]
    assert node["properties"]["verdict"] == "false_positive"
    txs = (await client.get("/v1/entities", params={"type": "Transaction", "limit": 100})).json()
    assert sum(1 for e in txs["entities"] if e["label"] == "transaction:3") == 1


async def test_investigation_links_to_member_transactions_and_prunes_removed(client):
    inv = {
        "source_type": "investigation", "source_id": "7", "content_hash": "inv-hash-7-aaaaaaaaaa", "occurred_at": "2026-10-21T00:00:00Z",
        "title": "Crypto exchange ring", "summary": "Two accounts, one device", "status": "closed", "priority": "high",
        "outcome": "confirmed_fraud", "outcome_note": "Blocked both accounts; reported to card network.",
        "timeline_notes": ["Linked device across accounts"], "transaction_ids": ["1", "2"], "customer_refs": [acct(1), acct(2)], "exposure_amount": 240.0,
    }
    assert (await post(client, {"investigations": [inv]})).json()["ingested"] == 1
    iid = (await client.get("/v1/entities", params={"type": "Investigation"})).json()["entities"][0]["id"]
    rel = (await client.get(f"/v1/entities/{iid}/related")).json()
    assert sum(1 for e in rel["edges"] if e["relation"] == "investigates") == 2

    inv2 = dict(inv, transaction_ids=["1"], content_hash="inv-hash-7-bbbbbbbbbb")
    await post(client, {"investigations": [inv2]})
    rel = (await client.get(f"/v1/entities/{iid}/related")).json()
    assert sum(1 for e in rel["edges"] if e["relation"] == "investigates") == 1


async def test_one_bad_record_does_not_sink_the_batch(client, monkeypatch):
    import app.memory as m
    real = m.add_data_points
    async def flaky(points, *a, **k):
        if any(getattr(p, "source_id", "") == "61" for p in points):
            raise RuntimeError("simulated store failure")
        return await real(points, *a, **k)
    monkeypatch.setattr(m, "add_data_points", flaky)
    r = await client.post("/v1/ingest", json={"transactions": [tx(60, customer=6), tx(61, customer=6), tx(62, customer=6)]})
    by = {x["source_key"]: x for x in r.json()["results"]}
    assert by["transaction:60"]["status"] == "ingested" and by["transaction:62"]["status"] == "ingested"
    assert by["transaction:61"]["status"] == "failed" and "simulated" in by["transaction:61"]["error"]
    assert r.json()["failed"] == 1


async def test_batch_size_limit(client):
    many = [tx(1000 + i) for i in range(101)]
    r = await client.post("/v1/ingest", json={"transactions": many})
    assert r.status_code == 413


async def test_backend_default_field_values_are_accepted(client):
    """Regression: the backend sends currency='unspecified'; schema limits once rejected it (HTTP 422)."""
    rec = tx(70, customer=7)
    rec["currency"] = "unspecified"
    r = await client.post("/v1/ingest", json={"transactions": [rec]})
    assert r.status_code == 200 and r.json()["ingested"] == 1
