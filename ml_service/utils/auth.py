"""
Service-to-service authentication for the ML service.
=======================================================
Two separate credentials, so that holding the key that lets the backend
score transactions does NOT also let you change which model makes every
fraud decision:

  ML_SERVICE_API_KEY  ("service key")  sent as  X-ML-Api-Key
      -> /predict and the read-only monitoring endpoints (/metrics,
         /model/versions, /model/drift, /model/shadow/status)

  ML_ADMIN_API_KEY    ("admin key")    sent as  X-ML-Admin-Key
      -> everything that CHANGES model state: /model/reload,
         /model/rollback, /model/drift/reset, /model/shadow/set,
         /model/shadow/clear, /model/shadow/promote

Only the Node backend holds these; the browser never talks to this
service. /health stays open (it is the liveness probe for Docker/Render
and exposes no model details).

Fail-closed: if a key isn't configured the protected routes answer 503
rather than silently allowing everyone. Local development can opt out
explicitly with ML_AUTH_DISABLED=true — and that opt-out is refused at
startup when ML_ENV is staging/production.

Keys are compared with hmac.compare_digest (constant time).
"""

import hmac
import os

from fastapi import Header, HTTPException

MIN_KEY_LENGTH = 32
PROTECTED_ENVS = {"production", "staging"}


def _env() -> str:
    return os.environ.get("ML_ENV", "development").strip().lower()


def auth_disabled() -> bool:
    return os.environ.get("ML_AUTH_DISABLED", "").strip().lower() == "true"


def validate_auth_config() -> None:
    """Called once at startup. Raises RuntimeError on an unsafe config so a
    misconfigured production deploy refuses to boot instead of serving
    an unauthenticated model-management API."""
    if _env() not in PROTECTED_ENVS:
        return
    problems = []
    if auth_disabled():
        problems.append("ML_AUTH_DISABLED=true is not allowed when ML_ENV is staging/production")
    service_key = os.environ.get("ML_SERVICE_API_KEY", "")
    admin_key = os.environ.get("ML_ADMIN_API_KEY", "")
    if len(service_key) < MIN_KEY_LENGTH:
        problems.append(f"ML_SERVICE_API_KEY must be set and at least {MIN_KEY_LENGTH} characters")
    if len(admin_key) < MIN_KEY_LENGTH:
        problems.append(f"ML_ADMIN_API_KEY must be set and at least {MIN_KEY_LENGTH} characters")
    if service_key and service_key == admin_key:
        problems.append("ML_SERVICE_API_KEY and ML_ADMIN_API_KEY must be different")
    if problems:
        raise RuntimeError("Unsafe ML service configuration: " + "; ".join(problems))


def _check(provided, env_name: str, label: str) -> None:
    if auth_disabled():
        return
    expected = os.environ.get(env_name, "")
    if not expected:
        # Fail closed — never treat "no key configured" as "open".
        raise HTTPException(503, f"{label} authentication is not configured on the ML service")
    if not provided:
        raise HTTPException(401, "Missing credentials", headers={"WWW-Authenticate": "ApiKey"})
    if not hmac.compare_digest(provided.encode(), expected.encode()):
        raise HTTPException(403, "Invalid credentials")


def require_service_key(x_ml_api_key: str = Header(default=None)) -> None:
    _check(x_ml_api_key, "ML_SERVICE_API_KEY", "Service")


def require_admin_key(x_ml_admin_key: str = Header(default=None)) -> None:
    _check(x_ml_admin_key, "ML_ADMIN_API_KEY", "Admin")
