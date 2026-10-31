"""
Run the REAL Cognee service with the offline test stand-ins (no network / no API keys needed).

For local verification and CI only: it swaps the embedding model and LLM call for deterministic
fakes (see tests/offline_harness.py). Everything else is the production code path.

    python -m tests.run_offline_server            # serves on 127.0.0.1:8765
"""
import os
import tempfile

os.environ.setdefault("COGNEE_DATA_DIR", tempfile.mkdtemp(prefix="fg-cognee-e2e-"))
os.environ.setdefault("COGNEE_SERVICE_ENV", "test")
os.environ.setdefault("COGNEE_SERVICE_API_KEY", "e2e-service-key-0123456789abcdef0123456789")
os.environ.setdefault("COGNEE_DATASET", "fraudguard-e2e")
os.environ.setdefault("COGNEE_COGNIFY_DEBOUNCE_S", "0")
os.environ.update({"EMBEDDING_PROVIDER": "openai", "EMBEDDING_MODEL": "openai/text-embedding-3-small", "EMBEDDING_DIMENSIONS": "64",
                   "EMBEDDING_API_KEY": "x", "LLM_API_KEY": "offline-test", "COGNEE_SKIP_CONNECTION_TEST": "true", "COGNEE_LOGGING_LEVEL": "ERROR"})

import app.bootstrap  # noqa: E402,F401
import cognee  # noqa: E402,F401
from tests import offline_harness  # noqa: E402

offline_harness.install_embeddings()
offline_harness.install_llm()

import uvicorn  # noqa: E402
from app.main import create_app  # noqa: E402
from app.config import load_settings  # noqa: E402

if __name__ == "__main__":
    uvicorn.run(create_app(load_settings()), host="127.0.0.1", port=int(os.environ.get("PORT", "8765")), log_level="warning")
