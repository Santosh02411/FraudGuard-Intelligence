"""Strict request/response models. Unknown fields are rejected (extra='forbid')."""
from __future__ import annotations

import re
from typing import Literal, Optional

from pydantic import BaseModel, ConfigDict, Field, field_validator

REF_RE = re.compile(r"^(acct|dev)_[a-f0-9]{16,40}$")


class Strict(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


class TransactionRecord(Strict):
    source_type: Literal["transaction"] = "transaction"
    source_id: str = Field(min_length=1, max_length=64, pattern=r"^[A-Za-z0-9_.:-]+$")
    content_hash: str = Field(min_length=16, max_length=128)
    occurred_at: str = Field(max_length=40)
    customer_ref: str = Field(description="HMAC pseudonym, e.g. acct_<hex>")
    merchant: str = Field(min_length=1, max_length=120)
    category: str = Field(default="unknown", max_length=60)
    location: str = Field(default="unknown", max_length=100)
    amount: float = Field(ge=0)
    currency: str = Field(default="unspecified", max_length=16)
    fraud_score: float = Field(ge=0, le=100)
    risk_level: Literal["low", "medium", "high", "critical", "unknown"] = "unknown"
    scoring_method: str = Field(default="unknown", max_length=40)
    model_version: Optional[str] = Field(default=None, max_length=40)
    flagged: bool = False
    detection_reasons: list[str] = Field(default_factory=list, max_length=20)
    model_factors: list[str] = Field(default_factory=list, max_length=10)
    device_ref: Optional[str] = None
    alert_status: Optional[str] = Field(default=None, max_length=30)
    verdict: Optional[str] = Field(default=None, max_length=30)
    resolution_reason: Optional[str] = Field(default=None, max_length=200)
    analyst_notes: list[str] = Field(default_factory=list, max_length=10)
    prevented_amount: Optional[float] = Field(default=None, ge=0)
    recovered_amount: Optional[float] = Field(default=None, ge=0)
    loss_amount: Optional[float] = Field(default=None, ge=0)
    dispute_status: Optional[str] = Field(default=None, max_length=30)
    investigation_id: Optional[str] = Field(default=None, max_length=64)

    @field_validator("customer_ref", "device_ref")
    @classmethod
    def _pseudonymous_only(cls, v):
        if v is not None and not REF_RE.match(v):
            raise ValueError("must be a pseudonymous reference (acct_<hex> / dev_<hex>), never a raw identifier")
        return v


class InvestigationRecord(Strict):
    source_type: Literal["investigation"] = "investigation"
    source_id: str = Field(min_length=1, max_length=64, pattern=r"^[A-Za-z0-9_.:-]+$")
    content_hash: str = Field(min_length=16, max_length=128)
    occurred_at: str = Field(max_length=40)
    title: str = Field(min_length=1, max_length=200)
    summary: Optional[str] = Field(default=None, max_length=2000)
    status: str = Field(max_length=30)
    priority: str = Field(max_length=20)
    outcome: Optional[str] = Field(default=None, max_length=30)
    outcome_note: Optional[str] = Field(default=None, max_length=2000)
    timeline_notes: list[str] = Field(default_factory=list, max_length=25)
    transaction_ids: list[str] = Field(default_factory=list, max_length=500)
    customer_refs: list[str] = Field(default_factory=list, max_length=200)
    exposure_amount: Optional[float] = Field(default=None, ge=0)
    closed_at: Optional[str] = Field(default=None, max_length=40)

    @field_validator("customer_refs")
    @classmethod
    def _refs(cls, v):
        for ref in v:
            if not REF_RE.match(ref):
                raise ValueError("customer_refs must be pseudonymous references")
        return v


class IngestRequest(Strict):
    transactions: list[TransactionRecord] = Field(default_factory=list)
    investigations: list[InvestigationRecord] = Field(default_factory=list)


class RecordResult(BaseModel):
    source_key: str
    status: Literal["ingested", "failed"]
    narrative: Literal["stored", "queued", "skipped_no_llm", "disabled", "failed"] = "disabled"
    error: Optional[str] = None


class IngestResponse(BaseModel):
    ingested: int
    failed: int
    results: list[RecordResult]
    cognify: dict


class SearchRequest(Strict):
    query: str = Field(min_length=2, max_length=1000)
    top_k: int = Field(default=8, ge=1, le=25)
    source_types: list[Literal["transaction", "investigation"]] = Field(default_factory=list)
    include_answer: bool = False


class SubjectContext(Strict):
    """Facts about the record being investigated, supplied by the backend from FraudGuard's database.

    These are *current record facts*, kept separate from *retrieved memory* and from *AI output*.
    """
    kind: Literal["transaction", "investigation"]
    source_id: str = Field(min_length=1, max_length=64)
    summary: str = Field(min_length=1, max_length=4000)
    customer_ref: Optional[str] = None
    merchant: Optional[str] = Field(default=None, max_length=120)
    device_ref: Optional[str] = None


class AssistantRequest(Strict):
    subject: SubjectContext
    question: Optional[str] = Field(default=None, max_length=1000)
    top_k: int = Field(default=8, ge=1, le=15)


class Finding(BaseModel):
    statement: str = Field(max_length=800)
    evidence_ids: list[str] = Field(default_factory=list)


class Step(BaseModel):
    action: str = Field(max_length=400)
    rationale: str = Field(default="", max_length=600)
    evidence_ids: list[str] = Field(default_factory=list)


class AssistantReport(BaseModel):
    """Schema the LLM must fill. Every item may cite evidence ids (E1, E2, ...)."""
    explanation: list[Finding] = Field(default_factory=list, max_length=6)
    similar_patterns: list[Finding] = Field(default_factory=list, max_length=6)
    suggested_steps: list[Step] = Field(default_factory=list, max_length=8)
    caveats: list[str] = Field(default_factory=list, max_length=4)
