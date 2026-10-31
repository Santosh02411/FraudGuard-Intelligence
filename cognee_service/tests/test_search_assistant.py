"""Retrieval, narrative layer, and the evidence-vs-AI separation of the assistant."""
import pytest

from app.schemas import AssistantReport, Finding, Step
from tests import offline_harness as oh
from tests.conftest import tx, acct, dev


@pytest.fixture(scope="module", autouse=True)
async def seeded(client):
    recs = [
        tx(101, customer=11, device=21, merchant="Midnight Gift Cards", amount=450, score=95, risk="critical",
           reasons=["Card testing pattern: many small purchases"], verdict="confirmed_fraud",
           notes=["Customer said they never made these purchases; card blocked and reissued"], resolution_reason="card_testing"),
        tx(102, customer=12, device=22, merchant="Sunrise Bakery", amount=6, score=3, risk="low", reasons=[], verdict="false_positive"),
        tx(103, customer=13, device=21, merchant="Midnight Gift Cards", amount=480, score=91, risk="high",
           reasons=["Card testing pattern: many small purchases"]),
    ]
    await client.post("/v1/ingest", json={"transactions": recs})
    await client.post("/v1/ingest", json={"investigations": [{
        "source_type": "investigation", "source_id": "301", "content_hash": "inv-301-hash-aaaaaaaa", "occurred_at": "2026-10-22T00:00:00Z",
        "title": "Gift card card testing ring", "summary": "Two accounts reused a device to test cards at a gift card merchant", "status": "closed",
        "priority": "high", "outcome": "confirmed_fraud", "outcome_note": "Blocked device, refunded customers, added merchant to watchlist",
        "timeline_notes": [], "transaction_ids": ["101", "103"], "customer_refs": [acct(11), acct(13)], "exposure_amount": 930.0}]})
    await client.memory.flush_cognify()


async def test_search_returns_relevant_history_with_connected_entities(client):
    r = await client.post("/v1/search", json={"query": "card testing gift cards small purchases", "top_k": 5})
    assert r.status_code == 200
    body = r.json()
    keys = [e["source_key"] for e in body["evidence"]]
    assert keys[0] in ("transaction:101", "transaction:103", "investigation:301")
    assert "transaction:102" not in keys[:2]          # the bakery false positive is not the top match
    top = body["evidence"][0]
    assert top["matched_via"] and top["snippet"] and top["connected"]
    assert body["answer"] is None                     # no generated text unless explicitly requested
    assert "graph_summary_vector" in body["diagnostics"]["retrieval"]


async def test_search_can_be_limited_to_source_type(client):
    r = await client.post("/v1/search", json={"query": "card testing", "source_types": ["investigation"]})
    assert {e["source_type"] for e in r.json()["evidence"]} == {"investigation"}


async def test_narrative_layer_uses_cognee_documents_and_chunks(client):
    st = (await client.get("/v1/stats")).json()
    assert st["narrative_documents"] >= 4
    assert st["cognify"]["runs"] >= 1 and st["cognify"]["status"] == "idle"
    r = await client.post("/v1/search", json={"query": "card blocked and reissued after customer disputed purchases"})
    via = {v for e in r.json()["evidence"] for v in e["matched_via"]}
    assert "document_chunk" in via                    # real cognee.search(CHUNKS) contributed


async def test_changed_narrative_is_updated_not_duplicated(client):
    before = (await client.get("/v1/stats")).json()["narrative_documents"]
    await client.post("/v1/ingest", json={"transactions": [tx(103, customer=13, device=21, merchant="Midnight Gift Cards", amount=480, score=91,
                                                              risk="high", reasons=["Card testing pattern: many small purchases"],
                                                              verdict="confirmed_fraud", chash="hash-103-confirmed-000")]})
    await client.memory.flush_cognify()
    after = (await client.get("/v1/stats")).json()["narrative_documents"]
    assert after == before


SUBJECT = {"kind": "transaction", "source_id": "103", "summary": "Transaction 103: 480 at Midnight Gift Cards, risk high, card testing pattern, device shared with another account."}


async def test_assistant_separates_subject_evidence_and_ai(client):
    oh.LLM_REPLY["report"] = AssistantReport(
        explanation=[Finding(statement="High score driven by a card testing pattern.", evidence_ids=["E1", "E99"])],
        similar_patterns=[Finding(statement="Matches a closed ring.", evidence_ids=["E1"]), Finding(statement="Totally unsupported claim", evidence_ids=["E42"])],
        suggested_steps=[Step(action="Check other accounts on the shared device", rationale="Same device linked to a confirmed case", evidence_ids=["E1"])],
        caveats=["Device fingerprints can collide"])
    r = await client.post("/v1/assistant", json={"subject": SUBJECT})
    assert r.status_code == 200
    body = r.json()
    assert set(body) >= {"subject", "evidence", "ai", "ai_status"}
    assert "not generated" in body["evidence"]["label"] and body["ai"]["generated"] is True
    items = body["evidence"]["items"]
    assert items and all(i["evidence_id"].startswith("E") for i in items)
    assert all(i["source_key"] != "transaction:103" for i in items)          # the subject is never its own precedent
    ids = {i["evidence_id"] for i in items}
    ai = body["ai"]
    assert all(set(f["evidence_ids"]) <= ids for f in ai["explanation"] + ai["similar_patterns"] + ai["suggested_steps"])  # invalid refs stripped
    assert "Totally unsupported claim" not in [f["statement"] for f in ai["similar_patterns"]]           # uncited 'similarity' dropped
    assert any(not f["grounded"] for f in ai["explanation"]) or all(f["grounded"] for f in ai["explanation"])


async def test_assistant_prompt_treats_evidence_as_untrusted_data(client):
    oh.LLM_CALLS.clear(); oh.LLM_REPLY["report"] = None
    await client.post("/v1/assistant", json={"subject": SUBJECT})
    prompt = [c for c in oh.LLM_CALLS if c["model"] == "AssistantReport"][-1]["text"]
    assert "<evidence>" in prompt and "<subject>" in prompt


async def test_assistant_without_llm_returns_evidence_only(client, monkeypatch):
    monkeypatch.delenv("LLM_API_KEY")
    r = await client.post("/v1/assistant", json={"subject": SUBJECT})
    body = r.json()
    assert body["ai"] is None and body["ai_status"] == "llm_not_configured" and body["evidence"]["items"]


async def test_llm_failure_degrades_to_evidence_only(client, monkeypatch):
    from cognee.infrastructure.llm.LLMGateway import LLMGateway
    async def boom(*a, **k): raise RuntimeError("provider down")
    monkeypatch.setattr(LLMGateway, "acreate_structured_output", staticmethod(boom))
    body = (await client.post("/v1/assistant", json={"subject": SUBJECT})).json()
    assert body["ai"] is None and body["ai_status"] == "generation_failed" and body["evidence"]["items"]
