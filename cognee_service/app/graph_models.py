"""
Typed fraud-intelligence graph, expressed as Cognee ``DataPoint`` models.

Relationships are *derived from FraudGuard records*, never inferred by an LLM, so the
graph is deterministic, reproducible and idempotent:

    Transaction --made_by------> Customer          (customer account, pseudonymised)
    Transaction --at_merchant--> Merchant
    Transaction --from_device--> Device            (pseudonymised device fingerprint)
    Transaction --exhibits_pattern--> FraudPattern (normalised detection reason)
    Investigation --investigates--> Transaction    (written as a plain edge, see memory.py)

In FraudGuard a *customer* and an *account* are the same row (``users``); the data model has
no separate bank-account table, so one ``Customer`` node represents "customer account".

IMPORTANT - why shared nodes carry identity only
-------------------------------------------------
``add_data_points`` upserts nodes by id, overwriting their properties. A Customer, Merchant,
Device or FraudPattern node is rebuilt (as a nested object) by *every* transaction that
references it, so these nodes hold nothing but the identity that is identical every time.
Anything that can change over time (is this device suspicious? how many cases does this
customer have?) is computed at read time from the graph instead of being stored.
"""
from __future__ import annotations

import uuid
from typing import Optional

from cognee.low_level import DataPoint

# Fixed namespace => identical ids for identical keys across runs, restarts and hosts.
_NAMESPACE = uuid.UUID("6f1d3a52-7b0e-4c6a-9c53-3f6e1f0b9a11")


def node_id(kind: str, key: str) -> uuid.UUID:
    return uuid.uuid5(_NAMESPACE, f"{kind}:{key}")


class Customer(DataPoint):
    label: str
    metadata: dict = {"index_fields": ["label"]}


class Merchant(DataPoint):
    label: str
    metadata: dict = {"index_fields": ["label"]}


class Device(DataPoint):
    label: str
    metadata: dict = {"index_fields": ["label"]}


class FraudPattern(DataPoint):
    label: str
    metadata: dict = {"index_fields": ["label"]}


class Transaction(DataPoint):
    label: str                      # "transaction:123" - the stable source key
    summary: str                    # natural-language record, embedded for semantic search
    source_id: str
    occurred_at: str
    amount: float
    category: str
    location: str
    risk_level: str
    fraud_score: float
    flagged: bool
    verdict: Optional[str] = None
    alert_status: Optional[str] = None
    resolution_reason: Optional[str] = None
    investigation_id: Optional[str] = None
    made_by: Customer
    at_merchant: Merchant
    from_device: Optional[Device] = None
    exhibits_pattern: list[FraudPattern] = []
    metadata: dict = {"index_fields": ["summary"]}


class Investigation(DataPoint):
    label: str                      # "investigation:42"
    summary: str
    source_id: str
    occurred_at: str
    title: str
    status: str
    priority: str
    outcome: Optional[str] = None
    transaction_count: int = 0
    metadata: dict = {"index_fields": ["summary"]}


STRUCTURED_TYPES = ("Transaction", "Investigation", "Customer", "Merchant", "Device", "FraudPattern")
SEARCHABLE_COLLECTIONS = {
    "transaction": "Transaction_summary",
    "investigation": "Investigation_summary",
}
