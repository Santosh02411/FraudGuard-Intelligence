"""
FraudMemory - the Cognee service module (initialisation, ingestion, graph construction, retrieval).

This is the only module that talks to the Cognee SDK. It is deliberately independent of the
fraud-scoring code: it receives already-minimised records from the FraudGuard backend and
never reads FraudGuard's database.

Two memory layers
-----------------
1. Structured graph (always on, no LLM needed): typed nodes/edges built deterministically
   from records with ``cognee.tasks.storage.add_data_points``. The natural-language summary
   of each Transaction/Investigation is embedded in Cognee's vector store, so it is
   searchable semantically. Re-ingesting a record upserts the same node ids (idempotent).
2. Narrative memory (needs an LLM): the same narrative is stored as a Cognee document with
   ``cognee.add`` and processed with ``cognee.cognify`` (entity extraction + chunk index),
   enabling ``SearchType.CHUNKS`` and graph-completion answers. A changed narrative is
   replaced in place with ``cognee.update``.

All Cognee writes happen under one process-wide lock: Cognee's default stores are embedded
(file-based) databases with a single writer. Run this service with ONE uvicorn worker.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import time
from collections import defaultdict, deque
from datetime import datetime, timezone
from typing import Any, Optional

import app.bootstrap  # noqa: F401  (sets Cognee env defaults BEFORE cognee is imported)
import cognee
from cognee import SearchType
from cognee.infrastructure.databases.graph import get_graph_engine
from cognee.infrastructure.databases.vector import get_vector_engine
from cognee.low_level import setup as cognee_setup
from cognee.tasks.ingestion.data_item import DataItem
from cognee.tasks.storage import add_data_points

from app import __version__
from app.config import Settings
from app.graph_models import (
    SEARCHABLE_COLLECTIONS,
    STRUCTURED_TYPES,
    Customer,
    Device,
    FraudPattern,
    Investigation,
    Merchant,
    Transaction,
    node_id,
)
from app.sanitize import redact
from app.schemas import (
    IngestRequest,
    IngestResponse,
    InvestigationRecord,
    RecordResult,
    TransactionRecord,
)

log = logging.getLogger("fraudguard.cognee")

SNAPSHOT_TTL_S = 3.0
MAX_SNAPSHOT_NODES = 200_000


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def pattern_label(reason: str) -> str:
    """Normalise a free-text detection reason into a reusable pattern name.

    Specific numbers are dropped so "Rapid velocity: 6 txns in 1h" and "...: 5 txns in 1h" are one pattern.
    FraudGuard's ML reasons look like "Model signal: <feature> (SHAP +0.123)": the feature IS the pattern, so it
    is kept - otherwise every ML-flagged transaction would share one meaningless "model signal" node.
    """
    text = redact(reason, 160).lower()
    m = re.match(r"\s*model signal:\s*([^(]+)", text)
    if m:
        feature = re.sub(r"[^a-z\s_-]", " ", m.group(1))
        feature = re.sub(r"\s+", " ", feature).strip()
        return ("model signal " + feature)[:80] if feature else "model signal"
    text = re.split(r"[:(\[]", text, maxsplit=1)[0]
    text = re.sub(r"[\d$€£.,%]+", " ", text)
    text = re.sub(r"[^a-z\s_-]", " ", text)
    text = re.sub(r"\s+", " ", text).strip()
    return text[:80] or "unspecified pattern"


def _money(v: Optional[float]) -> str:
    return f"{v:,.2f}" if v is not None else "n/a"


def transaction_summary(r: TransactionRecord) -> str:
    """The narrative for a transaction. All free text is redacted again here."""
    parts = [
        f"Transaction {r.source_id}: {_money(r.amount)} ({r.currency}) at {redact(r.merchant, 120)} "
        f"({redact(r.category, 60)}), location {redact(r.location, 100)}, on {r.occurred_at}.",
        f"Customer account {r.customer_ref}. Device {r.device_ref or 'not recorded'}.",
        f"Fraud risk {r.risk_level} (score {r.fraud_score:.0f}/100, scoring {r.scoring_method}"
        f"{' model ' + r.model_version if r.model_version else ''}); flagged: {'yes' if r.flagged else 'no'}.",
    ]
    if r.detection_reasons:
        parts.append("Detection reasons: " + "; ".join(redact(x, 160) for x in r.detection_reasons) + ".")
    if r.model_factors:
        parts.append("Top model factors: " + "; ".join(redact(x, 120) for x in r.model_factors) + ".")
    outcome = f"Analyst verdict: {r.verdict or 'none yet'}; alert status: {r.alert_status or 'no alert'}"
    if r.resolution_reason:
        outcome += f"; resolution reason: {redact(r.resolution_reason, 200)}"
    parts.append(outcome + ".")
    if r.analyst_notes:
        parts.append("Analyst notes: " + " | ".join(redact(n, 400) for n in r.analyst_notes))
    money = [f"{k} {_money(v)}" for k, v in (("prevented", r.prevented_amount), ("recovered", r.recovered_amount), ("loss", r.loss_amount)) if v is not None]
    if money:
        parts.append("Financial outcome: " + ", ".join(money) + ".")
    if r.dispute_status:
        parts.append(f"Dispute status: {r.dispute_status}.")
    if r.investigation_id:
        parts.append(f"Part of investigation {r.investigation_id}.")
    parts.append(f"Source key: transaction:{r.source_id}.")
    return "\n".join(parts)


def investigation_summary(r: InvestigationRecord) -> str:
    parts = [
        f'Investigation {r.source_id}: "{redact(r.title, 200)}" - status {r.status}, priority {r.priority}, '
        f"outcome {r.outcome or 'undecided'}.",
    ]
    if r.summary:
        parts.append("Summary: " + redact(r.summary, 1200))
    if r.outcome_note:
        parts.append("Outcome / remediation decision: " + redact(r.outcome_note, 1200))
    if r.timeline_notes:
        parts.append("Analyst timeline: " + " | ".join(redact(n, 300) for n in r.timeline_notes))
    parts.append(
        f"Covers {len(r.transaction_ids)} transaction(s) ({', '.join(r.transaction_ids[:20])}) "
        f"across {len(r.customer_refs)} customer account(s) ({', '.join(r.customer_refs[:10])})"
        + (f"; exposure {_money(r.exposure_amount)}." if r.exposure_amount is not None else ".")
    )
    parts.append(f"Source key: investigation:{r.source_id}.")
    return "\n".join(parts)


class EmbeddingsUnavailable(RuntimeError):
    """The embedding model / vector store is not ready (still downloading, misconfigured or unreachable)."""


class CogneeMemory:
    def __init__(self, settings: Settings):
        self.settings = settings
        self._write_lock = asyncio.Lock()
        self._snapshot: tuple[float, dict, list] | None = None
        self._state_path = os.path.join(settings.state_dir, "service_state.json")
        self._state: dict[str, Any] = {
            "last_ingest_at": None,
            "total_ingested": 0,
            "total_failed": 0,
            "cognify": {"status": "idle", "last_started_at": None, "last_finished_at": None, "last_error": None, "runs": 0},
        }
        self._cognify_task: asyncio.Task | None = None
        self._cognify_dirty = False
        self._started = False
        # Cognee builds its embedding + vector engines SYNCHRONOUSLY on first use (and a local model may need a
        # download). Done on the event loop, an unreachable/misconfigured embedder would freeze the whole service,
        # so it is warmed in a worker thread; requests fail fast with 503 until it is ready.
        self._embed: dict[str, Any] = {"state": "not_started", "error": None, "attempted_at": 0.0}
        self._warm_task: asyncio.Task | None = None

    # ------------------------------------------------------------------ lifecycle
    async def start(self) -> None:
        os.makedirs(self.settings.state_dir, exist_ok=True)
        self._load_state()
        await cognee_setup()
        self._warm_task = asyncio.create_task(self._warm_embeddings())
        self._started = True
        log.info("Cognee memory ready (cognee %s, dataset %s, llm=%s)", self.cognee_version(), self.settings.dataset, self.settings.llm_configured)

    async def _warm_embeddings(self) -> None:
        self._embed.update(state="warming", error=None, attempted_at=time.monotonic())

        def build():
            engine = get_vector_engine()
            getattr(engine, "has_collection")  # attribute access is what actually constructs the engines
            return True

        try:
            await asyncio.wait_for(asyncio.to_thread(build), self.settings.warmup_timeout_s)
            self._embed.update(state="ready", error=None)
        except Exception as exc:
            self._embed.update(state="failed", error=f"{type(exc).__name__}: {exc}"[:300])
            log.error("Embedding warm-up failed: %s", self._embed["error"])

    async def ensure_embeddings(self) -> None:
        """Raise EmbeddingsUnavailable unless the vector engine is ready; retry a failed warm-up at most every 30 s."""
        state = self._embed["state"]
        if state == "ready":
            return
        if state == "failed" and time.monotonic() - self._embed["attempted_at"] > 30:
            self._warm_task = asyncio.create_task(self._warm_embeddings())
        if self._warm_task and not self._warm_task.done() and state in ("not_started", "warming"):
            try:  # give a freshly started service a short grace period instead of failing immediately
                await asyncio.wait_for(asyncio.shield(self._warm_task), 3)
            except Exception:
                pass
        if self._embed["state"] != "ready":
            raise EmbeddingsUnavailable(f"Embedding model is not ready ({self._embed['state']}{': ' + self._embed['error'] if self._embed['error'] else ''})")

    async def stop(self) -> None:
        if self._warm_task and not self._warm_task.done():
            self._warm_task.cancel()
        if self._cognify_task and not self._cognify_task.done():
            self._cognify_task.cancel()
        self._save_state()

    @staticmethod
    def cognee_version() -> str:
        try:
            return str(cognee.get_cognee_version())
        except Exception:  # pragma: no cover - version helper is informational only
            return str(getattr(cognee, "__version__", "unknown"))

    def _load_state(self) -> None:
        try:
            with open(self._state_path, "r", encoding="utf-8") as fh:
                saved = json.load(fh)
            self._state.update({k: v for k, v in saved.items() if k in self._state})
            self._state["cognify"]["status"] = "idle"  # a restart cancels any in-flight run
        except FileNotFoundError:
            pass
        except (OSError, ValueError) as exc:
            log.warning("Ignoring unreadable service state: %s", exc)

    def _save_state(self) -> None:
        try:
            tmp = self._state_path + ".tmp"
            with open(tmp, "w", encoding="utf-8") as fh:
                json.dump(self._state, fh)
            os.replace(tmp, self._state_path)
        except OSError as exc:  # state is advisory; never fail a request over it
            log.warning("Could not persist service state: %s", exc)

    # ------------------------------------------------------------------ graph snapshot
    def _invalidate(self) -> None:
        self._snapshot = None

    async def _graph(self) -> tuple[dict[str, dict], list[tuple[str, str, str, dict]]]:
        """(nodes by id, edges) - cached briefly so dashboards don't re-read the whole graph."""
        now = time.monotonic()
        if self._snapshot and now - self._snapshot[0] < SNAPSHOT_TTL_S:
            return self._snapshot[1], self._snapshot[2]
        engine = await get_graph_engine()
        raw_nodes, raw_edges = await engine.get_graph_data()
        nodes = {str(nid): props for nid, props in raw_nodes[:MAX_SNAPSHOT_NODES]}
        edges = [(str(s), str(t), str(rel), props or {}) for s, t, rel, props in raw_edges]
        self._snapshot = (now, nodes, edges)
        return nodes, edges

    # ------------------------------------------------------------------ ingestion
    def _transaction_point(self, r: TransactionRecord) -> Transaction:
        customer = Customer(id=node_id("customer", r.customer_ref), label=r.customer_ref)
        merchant_name = redact(r.merchant, 120)
        merchant = Merchant(id=node_id("merchant", merchant_name.lower()), label=merchant_name)
        device = Device(id=node_id("device", r.device_ref), label=r.device_ref) if r.device_ref else None
        patterns, seen = [], set()
        for reason in r.detection_reasons:
            label = pattern_label(reason)
            if label not in seen:
                seen.add(label)
                patterns.append(FraudPattern(id=node_id("pattern", label), label=label))
        return Transaction(
            id=node_id("transaction", r.source_id),
            label=f"transaction:{r.source_id}",
            summary=transaction_summary(r),
            source_id=r.source_id,
            occurred_at=r.occurred_at,
            amount=r.amount,
            category=redact(r.category, 60),
            location=redact(r.location, 100),
            risk_level=r.risk_level,
            fraud_score=r.fraud_score,
            flagged=r.flagged,
            verdict=r.verdict,
            alert_status=r.alert_status,
            resolution_reason=redact(r.resolution_reason, 200) or None,
            investigation_id=r.investigation_id,
            made_by=customer,
            at_merchant=merchant,
            from_device=device,
            exhibits_pattern=patterns,
        )

    def _investigation_point(self, r: InvestigationRecord) -> Investigation:
        return Investigation(
            id=node_id("investigation", r.source_id),
            label=f"investigation:{r.source_id}",
            summary=investigation_summary(r),
            source_id=r.source_id,
            occurred_at=r.occurred_at,
            title=redact(r.title, 200),
            status=r.status,
            priority=r.priority,
            outcome=r.outcome,
            transaction_count=len(r.transaction_ids),
        )

    async def _write_points(self, points: list, keys: list[str]) -> dict[str, Optional[str]]:
        """Write DataPoints; on a batch failure retry one by one so a single bad record can't sink the rest."""
        errors: dict[str, Optional[str]] = {k: None for k in keys}
        if not points:
            return errors
        try:
            await asyncio.wait_for(add_data_points(points), self.settings.op_timeout_s * 2)
            return errors
        except Exception as exc:
            log.warning("Batch write failed (%s); retrying %d record(s) individually", exc, len(points))
        for key, point in zip(keys, points):
            try:
                await asyncio.wait_for(add_data_points([point]), self.settings.op_timeout_s)
            except Exception as exc:
                errors[key] = f"{type(exc).__name__}: {exc}"[:300]
        return errors

    @staticmethod
    def _edge_triplet(edge) -> tuple[str, str, str]:
        """Normalise the engine's edge shapes to (source_id, relationship, target_id).

        ``get_edges`` yields (source_node_dict, relationship_name, target_node_dict) on the
        embedded engine, while ``get_graph_data`` yields (source_id, target_id, relationship, props).
        """
        def ident(x):
            return str(x.get("id")) if isinstance(x, dict) else str(x)
        if len(edge) >= 4:
            return ident(edge[0]), str(edge[2]), ident(edge[1])
        return ident(edge[0]), str(edge[1]), ident(edge[2])

    async def _link_investigation(self, r: InvestigationRecord) -> int:
        """Create/refresh Investigation -> Transaction edges; drop edges to members that were removed."""
        engine = await get_graph_engine()
        inv_id = str(node_id("investigation", r.source_id))
        wanted = {str(node_id("transaction", tid)): tid for tid in r.transaction_ids}
        edges = [(inv_id, tx_id, "investigates", {"relationship_name": "investigates", "updated_at": _now()}) for tx_id in wanted]
        if edges:
            await engine.add_edges(edges)
        try:  # remove edges to transactions no longer in the case (best effort; engine support varies)
            from cognee.infrastructure.databases.provenance.delete_data import EdgeIdentity

            current = await engine.get_edges(inv_id)
            stale = []
            for edge in current:
                src, rel, tgt = self._edge_triplet(edge)
                if src == inv_id and rel == "investigates" and tgt not in wanted:
                    stale.append(EdgeIdentity(source_id=src, target_id=tgt, relationship_name=rel))
            if stale:
                await engine.delete_edge_triples(stale)
        except Exception as exc:
            log.info("Stale investigation edges were not pruned: %s", exc)
        return len(edges)

    async def _store_narratives(self, items: list[tuple[str, str, str]]) -> dict[str, str]:
        """items: (source_key, content_hash, text). Returns per-key status."""
        outcome: dict[str, str] = {}
        if not self.settings.narratives_enabled:
            return {k: "disabled" for k, _, _ in items}
        if not self.settings.llm_configured:
            return {k: "skipped_no_llm" for k, _, _ in items}
        ds = self.settings.dataset
        try:
            existing: dict[str, Any] = {}
            dataset_id = None
            for d in await cognee.datasets.list_datasets():
                if d.name == ds:
                    dataset_id = d.id
            if dataset_id is not None:
                for row in await cognee.datasets.list_data(dataset_id):
                    if getattr(row, "label", None):
                        existing[row.label] = row
            to_add: list[DataItem] = []
            for key, chash, text in items:
                meta = {"source_key": key, "content_hash": chash}
                row = existing.get(key)
                if row is None:
                    to_add.append(DataItem(data=text, label=key, external_metadata=meta, literal_text=True))
                    outcome[key] = "queued"
                    continue
                if (getattr(row, "external_metadata", None) or {}).get("content_hash") == chash:
                    outcome[key] = "stored"  # unchanged: nothing to do
                    continue
                await asyncio.wait_for(
                    cognee.update(data_id=row.id, data=text, dataset_id=dataset_id),
                    self.settings.cognify_timeout_s,
                )
                outcome[key] = "queued"
            if to_add:
                await asyncio.wait_for(cognee.add(to_add, dataset_name=ds, skip_connection_test=True), self.settings.op_timeout_s * 3)
            if any(v == "queued" for v in outcome.values()):
                self._schedule_cognify()
        except Exception as exc:
            log.warning("Narrative storage failed: %s", exc)
            for key, _, _ in items:
                outcome.setdefault(key, "failed")
            for key in list(outcome):
                if outcome[key] == "queued" and "to_add" in locals() and any(i.label == key for i in to_add):
                    outcome[key] = "failed"
        return outcome

    async def ingest(self, req: IngestRequest) -> IngestResponse:
        txs, invs = req.transactions, req.investigations
        if len(txs) + len(invs) > self.settings.max_batch:
            raise ValueError(f"Batch too large (max {self.settings.max_batch} records)")
        results: list[RecordResult] = []
        await self.ensure_embeddings()
        async with self._write_lock:
            # 1) transactions first so investigations can link to them
            tx_points = [self._transaction_point(r) for r in txs]
            tx_keys = [f"transaction:{r.source_id}" for r in txs]
            tx_errors = await self._write_points(tx_points, tx_keys)

            inv_points = [self._investigation_point(r) for r in invs]
            inv_keys = [f"investigation:{r.source_id}" for r in invs]
            inv_errors = await self._write_points(inv_points, inv_keys)
            for r, key in zip(invs, inv_keys):
                if inv_errors[key] is None:
                    try:
                        await self._link_investigation(r)
                    except Exception as exc:
                        inv_errors[key] = f"edge write failed: {type(exc).__name__}: {exc}"[:300]

            narrative_items = []
            for r, p, k in zip(txs, tx_points, tx_keys):
                if tx_errors[k] is None:
                    narrative_items.append((k, r.content_hash, p.summary))
            for r, p, k in zip(invs, inv_points, inv_keys):
                if inv_errors[k] is None:
                    narrative_items.append((k, r.content_hash, p.summary))
            narrative_status = await self._store_narratives(narrative_items) if narrative_items else {}
            self._invalidate()

        for k in tx_keys + inv_keys:
            err = tx_errors.get(k) or inv_errors.get(k)
            results.append(RecordResult(
                source_key=k,
                status="failed" if err else "ingested",
                narrative="disabled" if err else narrative_status.get(k, "disabled"),
                error=err,
            ))
        ok = sum(1 for x in results if x.status == "ingested")
        self._state["last_ingest_at"] = _now()
        self._state["total_ingested"] += ok
        self._state["total_failed"] += len(results) - ok
        self._save_state()
        return IngestResponse(ingested=ok, failed=len(results) - ok, results=results, cognify=self.cognify_status())

    # ------------------------------------------------------------------ cognify (narrative layer)
    def cognify_status(self) -> dict:
        s = dict(self._state["cognify"])
        s["enabled"] = self.settings.narratives_enabled and self.settings.llm_configured
        if not self.settings.llm_configured:
            s["status"] = "unavailable_no_llm"
        return s

    def _schedule_cognify(self) -> None:
        self._cognify_dirty = True
        if self._cognify_task is None or self._cognify_task.done():
            self._cognify_task = asyncio.create_task(self._cognify_loop())

    async def _cognify_loop(self) -> None:
        st = self._state["cognify"]
        try:
            await asyncio.sleep(self.settings.cognify_debounce_s)
            while self._cognify_dirty:
                self._cognify_dirty = False
                st.update(status="running", last_started_at=_now(), last_error=None)
                try:
                    async with self._write_lock:
                        await asyncio.wait_for(
                            cognee.cognify(datasets=[self.settings.dataset], raise_on_error=False),
                            self.settings.cognify_timeout_s,
                        )
                    st.update(status="idle", last_finished_at=_now(), runs=st["runs"] + 1)
                    self._invalidate()
                except asyncio.CancelledError:
                    raise
                except Exception as exc:
                    st.update(status="failed", last_finished_at=_now(), last_error=f"{type(exc).__name__}: {exc}"[:300])
                    log.error("cognify failed: %s", exc)
                    return
        finally:
            self._save_state()

    async def flush_cognify(self) -> None:
        """Wait for any scheduled/running cognify (used by tests and graceful shutdown)."""
        task = self._cognify_task
        if task and not task.done():
            await task

    # ------------------------------------------------------------------ retrieval
    @staticmethod
    def _source_of(props: dict) -> tuple[str, str]:
        label = str(props.get("label") or "")
        kind, _, sid = label.partition(":")
        return kind, sid

    def _connected(self, node_key: str, nodes: dict, edges: list, cap: int = 8) -> list[dict]:
        out = []
        for s, t, rel, _ in edges:
            if node_key not in (s, t):
                continue
            other = t if s == node_key else s
            props = nodes.get(other)
            if not props or props.get("type") not in STRUCTURED_TYPES:
                continue
            out.append({"id": other, "type": props.get("type"), "label": props.get("label"), "relation": rel, "direction": "out" if s == node_key else "in"})
            if len(out) >= cap:
                break
        return out

    def _evidence_from_node(self, nid: str, props: dict, distance: Optional[float], via: str, nodes: dict, edges: list) -> dict:
        kind, sid = self._source_of(props)
        return {
            "id": nid, "source_type": kind, "source_id": sid, "source_key": props.get("label"),
            "distance": distance,
            "relevance": None if distance is None else round(max(0.0, 1.0 - float(distance)), 4),
            "matched_via": [via],
            "snippet": str(props.get("summary") or "")[:900],
            "properties": {k: props.get(k) for k in ("risk_level", "fraud_score", "verdict", "alert_status", "status", "priority", "outcome", "amount", "occurred_at", "flagged", "investigation_id") if props.get(k) is not None},
            "connected": self._connected(nid, nodes, edges),
        }

    async def _vector_hits(self, query: str, top_k: int, kinds: list[str]) -> list[tuple[str, float]]:
        engine = get_vector_engine()
        hits: list[tuple[str, float]] = []
        for kind in kinds or list(SEARCHABLE_COLLECTIONS):
            collection = SEARCHABLE_COLLECTIONS[kind]
            try:
                if not await engine.has_collection(collection):
                    continue
                found = await asyncio.wait_for(engine.search(collection, query, limit=top_k), self.settings.op_timeout_s)
            except Exception as exc:
                log.warning("Vector search on %s failed: %s", collection, exc)
                continue
            hits.extend((str(h.id), float(h.score)) for h in found)
        return hits

    async def _chunk_hits(self, query: str, top_k: int) -> list[tuple[str, str, Optional[float]]]:
        """Narrative-layer retrieval through cognee.search(CHUNKS): (source_key, text, distance)."""
        if not (self.settings.narratives_enabled and self.settings.llm_configured) or not self._has_narratives():
            return []  # nothing has been cognified yet: the dataset does not exist, searching it would only error
        try:
            raw = await asyncio.wait_for(
                cognee.search(query_text=query, query_type=SearchType.CHUNKS, datasets=[self.settings.dataset], top_k=top_k),
                self.settings.op_timeout_s,
            )
        except Exception as exc:
            log.warning("CHUNKS search failed: %s", exc)
            return []
        rows = []
        for item in raw or []:
            payload = item
            if not isinstance(item, dict):
                payload = getattr(item, "search_result", None) or getattr(item, "__dict__", {})
            if isinstance(payload, list):
                rows.extend(payload)
            else:
                rows.append(payload)
        out = []
        for row in rows:
            if not isinstance(row, dict):
                continue
            meta = row.get("external_metadata")
            if isinstance(meta, str):
                try:
                    meta = json.loads(meta)
                except ValueError:
                    meta = {}
            key = (meta or {}).get("source_key")
            if key:
                out.append((str(key), str(row.get("text") or ""), row.get("score")))
        return out

    async def evidence(self, query: str, top_k: int, kinds: list[str] | None = None) -> list[dict]:
        """Retrieve historical evidence for ``query``. Pure retrieval - no generated text."""
        kinds = kinds or []
        await self.ensure_embeddings()
        nodes, edges = await self._graph()
        by_key: dict[str, dict] = {}
        for nid, dist in await self._vector_hits(query, top_k, kinds):
            props = nodes.get(nid)
            if not props:
                continue
            ev = self._evidence_from_node(nid, props, dist, "graph_summary_vector", nodes, edges)
            by_key[ev["source_key"]] = ev
        label_index = {p.get("label"): (nid, p) for nid, p in nodes.items() if p.get("type") in ("Transaction", "Investigation")}
        for key, text, dist in await self._chunk_hits(query, top_k):
            kind = key.partition(":")[0]
            if kinds and kind not in kinds:
                continue
            if key in by_key:
                if "document_chunk" not in by_key[key]["matched_via"]:
                    by_key[key]["matched_via"].append("document_chunk")
                continue
            if key in label_index:
                nid, props = label_index[key]
                ev = self._evidence_from_node(nid, props, dist if isinstance(dist, (int, float)) else None, "document_chunk", nodes, edges)
                by_key[key] = ev
        ranked = sorted(by_key.values(), key=lambda e: (e["distance"] is None, e["distance"] if e["distance"] is not None else 9))
        return ranked[:top_k]

    async def search(self, query: str, top_k: int = 8, kinds: list[str] | None = None, include_answer: bool = False) -> dict:
        evidence = await self.evidence(query, top_k, kinds)
        answer = None
        if include_answer and self.settings.llm_configured and self._has_narratives():
            try:
                raw = await asyncio.wait_for(
                    cognee.search(query_text=query, query_type=SearchType.GRAPH_COMPLETION, datasets=[self.settings.dataset], top_k=top_k),
                    self.settings.op_timeout_s * 2,
                )
                text = " ".join(str(x) for x in (raw or []))[:4000]
                answer = {"text": text, "generated": True, "source": "cognee.GRAPH_COMPLETION"} if text else None
            except Exception as exc:
                log.warning("GRAPH_COMPLETION failed: %s", exc)
        return {
            "query": query,
            "evidence": evidence,
            "answer": answer,
            "diagnostics": {
                "retrieval": ["graph_summary_vector"] + (["document_chunk"] if self.settings.llm_configured and self.settings.narratives_enabled else []),
                "narrative_layer": "available" if self.settings.llm_configured and self.settings.narratives_enabled else "unavailable_no_llm",
                "result_count": len(evidence),
            },
        }

    def _has_narratives(self) -> bool:
        return self._state["cognify"]["runs"] > 0

    # ------------------------------------------------------------------ entities / graph
    def _signals(self, nid: str, props: dict, nodes: dict, adjacency: dict[str, set[str]]) -> dict:
        sig: dict[str, Any] = {}
        kind = props.get("type")
        txs = [n for n in adjacency.get(nid, ()) if nodes.get(n, {}).get("type") == "Transaction"]
        if kind in ("Device", "Customer", "Merchant", "FraudPattern"):
            sig["transactions"] = len(txs)
            sig["confirmed_fraud"] = sum(1 for t in txs if nodes[t].get("verdict") == "confirmed_fraud")
            sig["flagged"] = sum(1 for t in txs if nodes[t].get("flagged"))
        if kind == "Device":
            customers = {c for t in txs for c in adjacency.get(t, ()) if nodes.get(c, {}).get("type") == "Customer"}
            sig["accounts"] = len(customers)
            sig["suspicious"] = len(customers) >= 2 or sig["confirmed_fraud"] > 0
        if kind == "Customer":
            sig["devices"] = len({d for t in txs for d in adjacency.get(t, ()) if nodes.get(d, {}).get("type") == "Device"})
        return sig

    @staticmethod
    def _adjacency(edges: list) -> dict[str, set[str]]:
        adj: dict[str, set[str]] = defaultdict(set)
        for s, t, _, _ in edges:
            adj[s].add(t)
            adj[t].add(s)
        return adj

    async def entities(self, entity_type: Optional[str], q: Optional[str], limit: int, offset: int, suspicious_only: bool = False) -> dict:
        nodes, edges = await self._graph()
        adjacency = self._adjacency(edges)
        rows = []
        needle = (q or "").strip().lower()
        for nid, props in nodes.items():
            t = props.get("type")
            if t not in STRUCTURED_TYPES:
                continue
            if entity_type and t != entity_type:
                continue
            if needle and needle not in str(props.get("label", "")).lower():
                continue
            sig = self._signals(nid, props, nodes, adjacency)
            if suspicious_only and not sig.get("suspicious"):
                continue
            rows.append({"id": nid, "type": t, "label": props.get("label"), "degree": len(adjacency.get(nid, ())), "signals": sig})
        rows.sort(key=lambda r: (-int(bool(r["signals"].get("suspicious"))), -r["degree"], str(r["label"])))
        return {"total": len(rows), "entities": rows[offset: offset + limit]}

    async def related(self, entity_id: str, depth: int = 1, limit: int = 60) -> Optional[dict]:
        nodes, edges = await self._graph()
        if entity_id not in nodes:
            return None
        adjacency = self._adjacency(edges)
        seen = {entity_id: 0}
        queue = deque([entity_id])
        while queue and len(seen) < limit:
            cur = queue.popleft()
            if seen[cur] >= depth:
                continue
            for nxt in sorted(adjacency.get(cur, ())):
                if nxt in seen or nodes.get(nxt, {}).get("type") not in STRUCTURED_TYPES:
                    continue
                seen[nxt] = seen[cur] + 1
                queue.append(nxt)
                if len(seen) >= limit:
                    break
        out_nodes = []
        for nid, lvl in seen.items():
            p = nodes[nid]
            out_nodes.append({"id": nid, "type": p.get("type"), "label": p.get("label"), "level": lvl, "signals": self._signals(nid, p, nodes, adjacency),
                              "properties": {k: p.get(k) for k in ("risk_level", "fraud_score", "verdict", "status", "outcome", "amount", "priority") if p.get(k) is not None}})
        out_edges = [{"source": s, "target": t, "relation": rel} for s, t, rel, _ in edges if s in seen and t in seen]
        return {"center": entity_id, "depth": depth, "truncated": len(seen) >= limit, "nodes": out_nodes, "edges": out_edges}

    # ------------------------------------------------------------------ stats / health
    async def stats(self) -> dict:
        nodes, edges = await self._graph()
        by_type: dict[str, int] = defaultdict(int)
        for props in nodes.values():
            by_type[str(props.get("type"))] += 1
        adjacency = self._adjacency(edges)
        suspicious = sum(1 for nid, p in nodes.items() if p.get("type") == "Device" and self._signals(nid, p, nodes, adjacency).get("suspicious"))
        docs = None
        try:
            for d in await cognee.datasets.list_datasets():
                if d.name == self.settings.dataset:
                    docs = len(await cognee.datasets.list_data(d.id))
        except Exception as exc:
            log.info("Could not count narrative documents: %s", exc)
        structured = {t: by_type.get(t, 0) for t in STRUCTURED_TYPES}
        structured_edges = sum(1 for s_, t_, _, _ in edges if nodes.get(s_, {}).get("type") in STRUCTURED_TYPES and nodes.get(t_, {}).get("type") in STRUCTURED_TYPES)
        return {
            "dataset": self.settings.dataset,
            "nodes_total": len(nodes),
            "edges_total": len(edges),
            "structured_edges": structured_edges,
            "structured_entities": structured,
            "extracted_entities": sum(c for t, c in by_type.items() if t not in STRUCTURED_TYPES and t in ("Entity",)),
            "suspicious_devices": suspicious,
            "narrative_documents": docs,
            "last_ingest_at": self._state["last_ingest_at"],
            "total_ingested": self._state["total_ingested"],
            "total_failed": self._state["total_failed"],
            "cognify": self.cognify_status(),
        }

    async def health(self) -> dict:
        checks: dict[str, dict] = {}

        async def probe(name: str, fn):
            started = time.monotonic()
            try:
                detail = await asyncio.wait_for(fn(), 10)
                checks[name] = {"ok": True, "ms": int((time.monotonic() - started) * 1000), **(detail or {})}
            except Exception as exc:
                checks[name] = {"ok": False, "error": f"{type(exc).__name__}: {exc}"[:200]}

        async def graph():
            engine = await get_graph_engine()
            return {"empty": bool(await engine.is_empty())}

        async def vector():
            await self.ensure_embeddings()
            engine = get_vector_engine()
            return {"collections": {c: bool(await engine.has_collection(c)) for c in SEARCHABLE_COLLECTIONS.values()}}

        await probe("graph_store", graph)
        await probe("vector_store", vector)
        ok = all(c["ok"] for c in checks.values())
        return {
            "status": "ok" if ok else "degraded",
            "service_version": __version__,
            "cognee_version": self.cognee_version(),
            "dataset": self.settings.dataset,
            "llm_configured": self.settings.llm_configured,
            "embedding_provider": self.settings.embedding_provider,
            "embeddings": {"state": self._embed["state"], "error": self._embed["error"]},
            "narrative_layer": "available" if (self.settings.llm_configured and self.settings.narratives_enabled) else "unavailable_no_llm" if self.settings.narratives_enabled else "disabled",
            "checks": checks,
        }
