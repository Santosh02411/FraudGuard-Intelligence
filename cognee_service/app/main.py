"""FastAPI surface of the Cognee memory service. Every /v1 route requires the service key."""
from __future__ import annotations

import json
import logging
from contextlib import asynccontextmanager
from typing import Optional

import app.bootstrap  # noqa: F401
from fastapi import Depends, FastAPI, HTTPException, Query, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from pydantic import ValidationError

from app import __version__
from app.assistant import investigate
from app.auth import make_dependency
from app.config import Settings, load_settings, validate_auth_config
from app.memory import CogneeMemory, EmbeddingsUnavailable
from app.sanitize import ForbiddenFieldError, reject_forbidden_keys
from app.schemas import AssistantRequest, IngestRequest, SearchRequest

log = logging.getLogger("fraudguard.cognee")
MAX_BODY_BYTES = 8 * 1024 * 1024


def create_app(settings: Optional[Settings] = None, memory: Optional[CogneeMemory] = None) -> FastAPI:
    settings = settings or load_settings()
    validate_auth_config(settings)
    mem = memory or CogneeMemory(settings)
    protected = settings.env in ("production", "staging")

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        await mem.start()
        yield
        await mem.stop()

    app = FastAPI(
        title="FraudGuard Cognee Memory Service", version=__version__, lifespan=lifespan,
        docs_url=None if protected else "/docs", redoc_url=None, openapi_url=None if protected else "/openapi.json",
    )
    app.state.memory = mem
    auth = make_dependency(settings)

    def _invalid(exc):
        # Only location + message: pydantic's default payload echoes the submitted value, which could be sensitive.
        errors = [{"loc": [str(p) for p in e.get("loc", [])], "msg": e.get("msg")} for e in exc.errors()]
        return JSONResponse(status_code=422, content={"detail": "Invalid request", "errors": errors})

    @app.exception_handler(RequestValidationError)
    async def _validation(_: Request, exc: RequestValidationError):
        return _invalid(exc)

    @app.exception_handler(EmbeddingsUnavailable)
    async def _embeddings(_: Request, exc: EmbeddingsUnavailable):
        return JSONResponse(status_code=503, content={"detail": str(exc)}, headers={"Retry-After": "30"})

    @app.exception_handler(ValidationError)
    async def _model_validation(_: Request, exc: ValidationError):
        return _invalid(exc)

    async def guarded_json(request: Request) -> dict:
        raw = await request.body()
        if len(raw) > MAX_BODY_BYTES:
            raise HTTPException(413, "Request body too large")
        try:
            body = json.loads(raw or b"{}")
        except ValueError:
            raise HTTPException(400, "Body must be valid JSON")
        try:
            reject_forbidden_keys(body)
        except ForbiddenFieldError as exc:
            raise HTTPException(422, str(exc))
        return body

    @app.get("/health")
    async def liveness():  # unauthenticated liveness probe; exposes nothing about the data
        return {"status": "ok", "service": "fraudguard-cognee", "version": __version__}

    @app.get("/v1/health", dependencies=[Depends(auth)])
    async def health():
        return await mem.health()

    @app.get("/v1/stats", dependencies=[Depends(auth)])
    async def stats():
        return await mem.stats()

    @app.post("/v1/ingest", dependencies=[Depends(auth)])
    async def ingest(request: Request):
        body = await guarded_json(request)
        req = IngestRequest.model_validate(body)
        try:
            return await mem.ingest(req)
        except ValueError as exc:
            raise HTTPException(413, str(exc))

    @app.post("/v1/search", dependencies=[Depends(auth)])
    async def search(request: Request):
        req = SearchRequest.model_validate(await guarded_json(request))
        return await mem.search(req.query, req.top_k, list(req.source_types), req.include_answer)

    @app.get("/v1/entities", dependencies=[Depends(auth)])
    async def entities(type: Optional[str] = Query(default=None, pattern="^(Transaction|Investigation|Customer|Merchant|Device|FraudPattern)$"),
                       q: Optional[str] = Query(default=None, max_length=100), limit: int = Query(default=25, ge=1, le=100),
                       offset: int = Query(default=0, ge=0), suspicious_only: bool = False):
        return await mem.entities(type, q, limit, offset, suspicious_only)

    @app.get("/v1/entities/{entity_id}/related", dependencies=[Depends(auth)])
    async def related(entity_id: str, depth: int = Query(default=1, ge=1, le=2), limit: int = Query(default=60, ge=5, le=150)):
        result = await mem.related(entity_id, depth, limit)
        if result is None:
            raise HTTPException(404, "Entity not found")
        return result

    @app.post("/v1/assistant", dependencies=[Depends(auth)])
    async def assistant(request: Request):
        req = AssistantRequest.model_validate(await guarded_json(request))
        return await investigate(mem, req)

    return app


def app_factory() -> FastAPI:  # uvicorn --factory app.main:app_factory
    return create_app()
