"""
Configuration for the FraudGuard Cognee memory service.

Cognee reads most of its settings from the process environment *when it is
imported*, so ``apply_cognee_defaults()`` must run before ``import cognee``
anywhere in this package (``app/bootstrap.py`` does exactly that).

Nothing here hard-codes a credential. Every secret comes from the environment.
"""
from __future__ import annotations

import hmac
import os
from dataclasses import dataclass

PROTECTED_ENVS = {"production", "staging"}
MIN_KEY_LENGTH = 32


def _env(name: str, default: str = "") -> str:
    return os.environ.get(name, default).strip()


def _bool(name: str, default: bool = False) -> bool:
    raw = _env(name)
    if not raw:
        return default
    return raw.lower() in ("1", "true", "yes", "on")


def _int(name: str, default: int, lo: int, hi: int) -> int:
    try:
        value = int(_env(name) or default)
    except ValueError:
        value = default
    return max(lo, min(value, hi))


def service_env() -> str:
    return _env("COGNEE_SERVICE_ENV", "development").lower()


def apply_cognee_defaults() -> None:
    """Set Cognee defaults that suit a single-tenant, service-account deployment.

    ``setdefault`` only: an operator's explicit environment always wins.
    """
    # This service is the only client of its Cognee stores and sits behind its own
    # service key on a private network, so Cognee's per-user multi-tenancy adds
    # nothing here. Operators can override this.
    os.environ.setdefault("ENABLE_BACKEND_ACCESS_CONTROL", "false")
    os.environ.setdefault("REQUIRE_AUTHENTICATION", "false")
    # Session memory is for chat agents; this service stores records, not sessions.
    os.environ.setdefault("CACHING", "false")
    os.environ.setdefault("COGNEE_LOGGING_LEVEL", "WARNING")
    data_dir = _env("COGNEE_DATA_DIR")
    if data_dir:
        os.environ.setdefault("DATA_ROOT_DIRECTORY", os.path.join(data_dir, "data"))
        os.environ.setdefault("SYSTEM_ROOT_DIRECTORY", os.path.join(data_dir, "system"))


@dataclass(frozen=True)
class Settings:
    env: str
    dataset: str
    api_key: str
    auth_disabled: bool
    max_batch: int
    op_timeout_s: int
    cognify_timeout_s: int
    cognify_debounce_s: int
    narratives_enabled: bool
    state_dir: str
    warmup_timeout_s: int = 120

    @property
    def llm_configured(self) -> bool:
        """True when Cognee has a usable LLM (hosted key, or a local provider)."""
        provider = _env("LLM_PROVIDER").lower()
        if provider in ("ollama", "custom", "llama_cpp"):
            return True
        return bool(_env("LLM_API_KEY"))

    @property
    def embedding_provider(self) -> str:
        explicit = _env("EMBEDDING_PROVIDER")
        if explicit:
            return explicit
        return "openai" if _env("LLM_API_KEY") or _env("EMBEDDING_API_KEY") else "fastembed (local)"


def load_settings() -> Settings:
    state_dir = _env("COGNEE_DATA_DIR") or os.path.join(os.getcwd(), ".cognee_state")
    return Settings(
        env=service_env(),
        dataset=_env("COGNEE_DATASET", "fraudguard-intelligence") or "fraudguard-intelligence",
        api_key=_env("COGNEE_SERVICE_API_KEY"),
        auth_disabled=_bool("COGNEE_AUTH_DISABLED"),
        max_batch=_int("COGNEE_MAX_BATCH", 100, 1, 500),
        op_timeout_s=_int("COGNEE_OP_TIMEOUT_S", 60, 5, 600),
        cognify_timeout_s=_int("COGNEE_COGNIFY_TIMEOUT_S", 900, 30, 7200),
        cognify_debounce_s=_int("COGNEE_COGNIFY_DEBOUNCE_S", 5, 0, 600),
        narratives_enabled=_bool("COGNEE_ENABLE_NARRATIVES", True),
        state_dir=state_dir,
        warmup_timeout_s=_int("COGNEE_WARMUP_TIMEOUT_S", 120, 5, 1800),
    )


def validate_auth_config(settings: Settings) -> None:
    """Refuse to boot with an unsafe production configuration."""
    if settings.env not in PROTECTED_ENVS:
        return
    problems = []
    if settings.auth_disabled:
        problems.append("COGNEE_AUTH_DISABLED=true is not allowed in staging/production")
    if len(settings.api_key) < MIN_KEY_LENGTH:
        problems.append(f"COGNEE_SERVICE_API_KEY must be set and at least {MIN_KEY_LENGTH} characters")
    if problems:
        raise RuntimeError("Unsafe Cognee service configuration: " + "; ".join(problems))


def keys_match(provided: str | None, expected: str) -> bool:
    if not provided or not expected:
        return False
    return hmac.compare_digest(provided.encode(), expected.encode())
