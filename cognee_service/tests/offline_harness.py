"""
TEST-ONLY offline stand-ins, so the suite runs with no network and no API keys.

Only two *external model calls* are replaced:
  * the embedding model  -> deterministic hashed bag-of-words vectors (real vector math, real
    LanceDB store, real ranking by similarity);
  * the LLM structured-output call -> a deterministic function.
Everything else (graph store, vector store, pipelines, add/cognify/search/update, DataPoint
upserts) is the real Cognee SDK. Nothing here is imported by the service itself.
"""
import hashlib
import importlib
import math
import re
import sys

DIM = 64


def embed_one(text):
    v = [0.0] * DIM
    for tok in re.findall(r"[a-z0-9_]+", str(text).lower()):
        v[int(hashlib.md5(tok.encode()).hexdigest(), 16) % DIM] += 1.0
    n = math.sqrt(sum(x * x for x in v)) or 1.0
    return [x / n for x in v]


class _Tokenizer:
    model_input_limit = 8192
    max_completion_tokens = 8192

    def extract_tokens(self, text): return str(text).split()
    def count_tokens(self, text): return len(str(text).split())
    def trim_text_to_max_completion_tokens(self, text, max_tokens=None): return text


class HashEmbeddingEngine:
    mock = False

    def __init__(self):
        self.dimensions = DIM
        self.max_completion_tokens = 8192
        self.tokenizer = _Tokenizer()

    async def embed_text(self, text):
        from cognee.infrastructure.databases.vector.embeddings.EmbeddingEngine import EmbeddingResult
        texts = text if isinstance(text, list) else [text]
        return EmbeddingResult([embed_one(t) for t in texts], tokens=sum(len(str(t).split()) for t in texts))

    def get_vector_size(self): return DIM
    def get_batch_size(self): return 32
    async def input_limit(self): return 8192


def install_embeddings():
    name = "cognee.infrastructure.databases.vector.embeddings.get_embedding_engine"
    importlib.import_module(name)
    engine = HashEmbeddingEngine()
    sys.modules[name].create_embedding_engine = lambda *a, **k: engine


LLM_CALLS = []   # lets tests assert what the (fake) LLM was asked
LLM_REPLY = {"report": None}


def install_llm():
    from cognee.infrastructure.llm.LLMGateway import LLMGateway

    async def fake(text_input, system_prompt, response_model, **kwargs):
        name = response_model.__name__
        LLM_CALLS.append({"model": name, "text": str(text_input)})
        if name == "KnowledgeGraph":
            return response_model(nodes=[], edges=[])
        if name == "SummarizedContent":
            return response_model(summary=str(text_input)[:200], description=str(text_input)[:200])
        if name == "AssistantReport" and LLM_REPLY["report"] is not None:
            return LLM_REPLY["report"]
        try:
            return response_model()
        except Exception:
            return response_model.model_construct()

    LLMGateway.acreate_structured_output = staticmethod(fake)
