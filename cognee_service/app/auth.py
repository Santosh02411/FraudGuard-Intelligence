"""
Service-to-service authentication.

Only the FraudGuard Node backend talks to this service; browsers never do. The
backend presents ``X-Cognee-Service-Key``. Same philosophy as ml_service/utils/auth.py:

* fail closed: no key configured -> 503, never "open";
* constant-time comparison;
* the explicit local-development opt-out (COGNEE_AUTH_DISABLED=true) is refused at
  startup in staging/production (see config.validate_auth_config).
"""
from __future__ import annotations

from fastapi import Header, HTTPException, Request

from app.config import Settings, keys_match


def make_dependency(settings: Settings):
    def require_service_key(request: Request, x_cognee_service_key: str | None = Header(default=None)) -> None:
        if settings.auth_disabled:
            return
        if not settings.api_key:
            raise HTTPException(503, "Service authentication is not configured")
        if not x_cognee_service_key:
            raise HTTPException(401, "Missing credentials", headers={"WWW-Authenticate": "ApiKey"})
        if not keys_match(x_cognee_service_key, settings.api_key):
            raise HTTPException(403, "Invalid credentials")

    return require_service_key
