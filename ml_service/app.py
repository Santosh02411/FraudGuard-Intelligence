"""
FraudGuard - ML Scoring Service (FastAPI) v2
================================================
Loads whichever model version is currently PROMOTED in the registry
(models/current_version.json -> models/registry/vN/) and serves:

    POST /predict          - score one transaction, with SHAP explainability
    GET  /health            - service + model status
    GET  /metrics            - evaluation metrics for the active version
    GET  /model/versions     - every version in the registry + which is active
    POST /model/reload       - hot-reload the currently-promoted version
                                (e.g. after train_model.py promotes a new one)
    POST /model/rollback     - force-activate a specific older version

Run:
    uvicorn app:app --host 0.0.0.0 --port 8001 --reload
"""

import hashlib
import io
import json
import os
import tempfile
import threading
from collections import deque
from datetime import datetime, timezone

import joblib
import numpy as np
import pandas as pd
import shap
from fastapi import Depends, FastAPI, HTTPException, Query
from pydantic import BaseModel, Field

from utils.feature_engineering import engineer_features, align_columns, CATEGORY_COLS
from utils.drift import compute_drift_report
from utils.auth import require_service_key, require_admin_key, validate_auth_config
from utils import artifacts, monitor_store, promotion_gates

# Fail fast on an unsafe production config (see utils/auth.py) BEFORE the
# app object exists, so a misconfigured deploy never starts serving.
validate_auth_config()

# Interactive docs/schema are an unauthenticated map of the admin surface;
# only expose them outside staging/production.
_PROTECTED_ENV = os.environ.get("ML_ENV", "development").strip().lower() in ("production", "staging")
app = FastAPI(
    title="FraudGuard ML Service", version="2.0.0",
    docs_url=None if _PROTECTED_ENV else "/docs",
    redoc_url=None,
    openapi_url=None if _PROTECTED_ENV else "/openapi.json",
)

REGISTRY_DIR = "models/registry"
CURRENT_VERSION_PATH = "models/current_version.json"

# How many recent /predict calls' engineered feature rows (and scores) to
# keep for drift/shadow reporting. The deques are the hot path; every entry is
# ALSO written to utils/monitor_store.py (SQLite on MONITOR_DB_PATH) and the
# deques are rebuilt from it on startup, so a restart no longer erases drift
# monitoring or the evidence gathered about a shadow model.
LIVE_BUFFER_MAXLEN = 2000
SHADOW_COMPARISON_MAXLEN = 1000
MIN_DRIFT_SAMPLES = 30

STATE = {
    "model": None,
    "scaler": None,
    "calibrator": None,
    "feature_columns": None,
    "metrics": None,
    "metadata": None,
    "explainer": None,
    "version": None,
    # --- Drift monitoring (feature: model drift monitoring) ---
    "baseline_stats": None,
    "live_buffer": deque(maxlen=LIVE_BUFFER_MAXLEN),   # engineered feature rows
    "score_buffer": deque(maxlen=LIVE_BUFFER_MAXLEN),  # corresponding fraud_score values
    # --- Shadow/canary deployment (feature: shadow model deployment) ---
    # A second model version scored in PARALLEL on the same live traffic,
    # purely for comparison — it never influences fraud_score/risk_level
    # in the response. See /model/shadow/* endpoints below.
    "shadow_model": None,
    "shadow_scaler": None,
    "shadow_calibrator": None,
    "shadow_feature_columns": None,
    "shadow_metadata": None,
    "shadow_version": None,
    "shadow_comparisons": deque(maxlen=SHADOW_COMPARISON_MAXLEN),
}


ALLOW_UNVERIFIED = os.environ.get("ML_ALLOW_UNVERIFIED_MODELS", "").lower() in ("1", "true", "yes")


def _require_verified(version: str):
    """Model files are pickles; unpickling runs code. Never load a version
    whose artifacts do not match their training-time manifest. Raises
    PermissionError with the failed checks."""
    version_dir = os.path.join(REGISTRY_DIR, version)
    if not os.path.isdir(version_dir):
        raise FileNotFoundError(f"No such model version in registry: {version}")
    if ALLOW_UNVERIFIED:
        return None
    report = artifacts.verify(version_dir)
    if not report["ok"]:
        failed = "; ".join(f"{c['name']}: {c['detail'] or 'failed'}" for c in report["checks"] if not c["ok"])
        raise PermissionError(f"{version} failed integrity verification ({failed})")
    compat = artifacts.runtime_compatibility(report["manifest"])
    if not compat["ok"]:
        raise PermissionError(f"{version} is not runtime-compatible: {'; '.join(compat['problems'])}")
    return report


def _write_current(version: str, **extra):
    """Atomic write of the active-version pointer."""
    from datetime import datetime, timezone
    tmp = CURRENT_VERSION_PATH + ".tmp"
    os.makedirs(os.path.dirname(CURRENT_VERSION_PATH) or ".", exist_ok=True)
    with open(tmp, "w") as f:
        json.dump({"version": version, "activated_at": datetime.now(timezone.utc).isoformat(), **extra}, f, indent=2)
    os.replace(tmp, CURRENT_VERSION_PATH)


def _read_current():
    if not os.path.exists(CURRENT_VERSION_PATH):
        return None
    with open(CURRENT_VERSION_PATH) as f:
        return json.load(f)


def _restore_monitoring():
    """Rebuilds the in-memory buffers for the ACTIVE version (and the shadow
    selection) from the persistent store after a start or a version switch."""
    v = STATE["version"]
    live = monitor_store.load_live(v, LIVE_BUFFER_MAXLEN) if v else []
    STATE["score_buffer"] = deque((s for s, _ in live), maxlen=LIVE_BUFFER_MAXLEN)
    STATE["live_buffer"] = deque((f for _, f in live), maxlen=LIVE_BUFFER_MAXLEN)
    if STATE["shadow_version"]:
        STATE["shadow_comparisons"] = deque(
            monitor_store.load_shadow(v, STATE["shadow_version"], SHADOW_COMPARISON_MAXLEN), maxlen=SHADOW_COMPARISON_MAXLEN)


def _clear_shadow_state(persist=True):
    if persist and STATE["shadow_version"]:
        monitor_store.clear_shadow(STATE["version"], STATE["shadow_version"])
        monitor_store.set_kv("shadow_version", None)
    STATE.update({
        "shadow_model": None, "shadow_scaler": None, "shadow_calibrator": None,
        "shadow_feature_columns": None, "shadow_metadata": None, "shadow_version": None,
    })
    STATE["shadow_comparisons"] = deque(maxlen=SHADOW_COMPARISON_MAXLEN)


def _load_calibrator(version_dir: str):
    path = os.path.join(version_dir, "calibrator.pkl")
    return joblib.load(path) if os.path.exists(path) else None


def _calibrate(calibrator, raw_prob: float) -> float:
    if calibrator is None:
        return raw_prob
    return float(calibrator.predict([raw_prob])[0])


def _risk_label(score: float, medium: float, high: float) -> str:
    return "high" if score >= high else "medium" if score >= medium else "low"


def _load_version(version: str):
    _require_verified(version)
    version_dir = os.path.join(REGISTRY_DIR, version)

    model = joblib.load(os.path.join(version_dir, "model.pkl"))
    scaler = joblib.load(os.path.join(version_dir, "scaler.pkl"))
    with open(os.path.join(version_dir, "feature_columns.json")) as f:
        feature_columns = json.load(f)
    with open(os.path.join(version_dir, "metrics.json")) as f:
        metrics = json.load(f)
    with open(os.path.join(version_dir, "metadata.json")) as f:
        metadata = json.load(f)
    background = np.load(os.path.join(version_dir, "background_sample.npy"))
    # Calibrator maps the model's raw score to a calibrated probability
    # (train_model.py fits it on a held-out validation slice). Versions trained
    # before calibration existed have none -> served as-is and flagged
    # `calibrated: false` so consumers know the score is NOT a probability.
    calibrator = _load_calibrator(version_dir)

    # shap.Explainer auto-selects TreeExplainer/LinearExplainer/etc. based
    # on the model type — same call works for LogisticRegression,
    # RandomForest, and XGBoost.
    explainer = shap.Explainer(model.predict_proba, background)

    # Drift baseline is optional — older registry versions trained before
    # this feature existed won't have one; GET /model/drift handles that
    # gracefully (see below) instead of failing to load the model at all.
    baseline_stats = None
    baseline_path = os.path.join(version_dir, "baseline_stats.json")
    if os.path.exists(baseline_path):
        with open(baseline_path) as f:
            baseline_stats = json.load(f)

    STATE.update({
        "model": model, "scaler": scaler, "calibrator": calibrator, "feature_columns": feature_columns,
        "metrics": metrics, "metadata": metadata, "explainer": explainer,
        "version": version, "baseline_stats": baseline_stats,
    })
    # Monitoring is per version: traffic scored by the OLD model says nothing
    # about the new one's baseline. Restores what was persisted for THIS version.
    if STATE["shadow_version"] == version:   # shadow became primary
        _clear_shadow_state()
    _restore_monitoring()
    print(f"Loaded model version {version} ({metadata['best_model_type']}, "
          f"PR-AUC={metadata['pr_auc']})")


def _load_current():
    if not os.path.exists(CURRENT_VERSION_PATH):
        print("WARNING: no current_version.json found. Run train_model.py first.")
        return
    with open(CURRENT_VERSION_PATH) as f:
        current = json.load(f)
    _load_version(current["version"])


def _load_shadow_version(version: str):
    """Loads a registry version into the SHADOW slot, separate from the
    primary model — scored in parallel on every /predict call, but never
    read for the served fraud_score/risk_level. See the module-level
    STATE comment above for why."""
    if version == STATE["version"]:
        raise ValueError("Shadow version must differ from the active primary version")
    _require_verified(version)
    version_dir = os.path.join(REGISTRY_DIR, version)

    model = joblib.load(os.path.join(version_dir, "model.pkl"))
    scaler = joblib.load(os.path.join(version_dir, "scaler.pkl"))
    with open(os.path.join(version_dir, "feature_columns.json")) as f:
        feature_columns = json.load(f)
    with open(os.path.join(version_dir, "metadata.json")) as f:
        metadata = json.load(f)

    STATE.update({
        "shadow_model": model, "shadow_scaler": scaler,
        "shadow_calibrator": _load_calibrator(version_dir),
        "shadow_feature_columns": feature_columns, "shadow_metadata": metadata,
        "shadow_version": version,
    })
    monitor_store.set_kv("shadow_version", version)
    STATE["shadow_comparisons"] = deque(monitor_store.load_shadow(STATE["version"], version, SHADOW_COMPARISON_MAXLEN), maxlen=SHADOW_COMPARISON_MAXLEN)
    print(f"Shadow model set to version {version} ({metadata['best_model_type']}) "
          f"— scoring every prediction in parallel, not affecting decisions")


@app.on_event("startup")
def startup():
    try:
        _load_current()
    except Exception as e:
        print(f"WARNING: failed to load model at startup (serving NOTHING rather than an unverified model): {e}")
    sv = monitor_store.get_kv("shadow_version")
    if sv and STATE["version"]:
        try:
            _load_shadow_version(sv)
        except Exception as e:
            print(f"WARNING: could not restore shadow version {sv}: {e}")
            monitor_store.set_kv("shadow_version", None)


class TransactionIn(BaseModel):
    amount: float
    category: str
    location: str
    card_type: str = Field(default="credit")
    hour: int = Field(default=12, ge=0, le=23)
    day_of_week: int = Field(default=0, ge=0, le=6)
    distance_from_home: float = 0.0
    geo_distance_from_last_km: float = 0.0
    time_since_last_transaction_minutes: float = 1440.0
    ratio_to_median_purchase_price: float = 1.0
    spending_zscore: float = 0.0
    repeat_retailer: int = 0
    used_chip: int = 0
    used_pin_number: int = 0
    online_order: int = 1
    velocity_last_hour: int = 0
    is_new_device: int = 0
    ip_status: str = Field(default="known")  # known | new | unknown


def _fields_set(model) -> set:
    """Names the CALLER actually sent (pydantic v1 and v2)."""
    return set(getattr(model, "model_fields_set", None) or getattr(model, "__fields_set__", set()))


def _feature_quality(txn: "TransactionIn", feature_columns) -> dict:
    """What the model silently filled in for this request.

    `defaulted`: optional inputs the caller did not send, so the schema default was used instead of a real value.
    `unseen_categories`: categorical values the model never saw in training; their one-hot column does not exist,
    so the value contributes nothing and the request is scored as if the category were absent.
    """
    sent = _fields_set(txn)
    defaulted = sorted(n for n in TransactionIn.model_fields if n not in sent) if hasattr(TransactionIn, "model_fields") \
        else sorted(n for n in TransactionIn.__fields__ if n not in sent)
    cols = set(feature_columns or [])
    unseen = {}
    values = txn.dict()
    for c in CATEGORY_COLS:
        if f"{c}_{values.get(c)}" not in cols:
            unseen[c] = values.get(c)
    return {"defaulted": defaulted, "unseen_categories": unseen}


@app.get("/health")
def health():
    # Liveness only — deliberately unauthenticated (Docker/Render probes) and
    # therefore deliberately free of model version/type details; those are
    # behind the service key at /model/versions.
    return {"status": "ok" if STATE["model"] is not None else "model_not_loaded"}


@app.get("/metrics", dependencies=[Depends(require_service_key)])
def metrics():
    if STATE["metrics"] is None:
        raise HTTPException(503, "Metrics not available. Train the model first.")
    return {"version": STATE["version"], **STATE["metrics"]}


@app.get("/model/versions", dependencies=[Depends(require_service_key)])
def list_versions():
    if not os.path.isdir(REGISTRY_DIR):
        return {"versions": [], "active": None}
    versions = []
    for name in sorted(os.listdir(REGISTRY_DIR)):
        meta_path = os.path.join(REGISTRY_DIR, name, "metadata.json")
        if os.path.exists(meta_path):
            with open(meta_path) as f:
                versions.append(json.load(f))
    return {"versions": versions, "active": STATE["version"]}


@app.post("/model/reload", dependencies=[Depends(require_admin_key)])
def reload_model():
    """Re-reads current_version.json, VERIFIES the version and hot-swaps it."""
    try:
        _load_current()
        return {"status": "reloaded", "version": STATE["version"]}
    except PermissionError as e:
        raise HTTPException(409, str(e))
    except Exception as e:
        raise HTTPException(500, f"Reload failed: {e}")


class ActivateIn(BaseModel):
    version: str
    reason: str = Field(min_length=1, max_length=500)
    actor: str = Field(default="", max_length=120)
    change_id: int | None = None
    kind: str = Field(default="promote", pattern="^(promote|rollback)$")


@app.post("/model/activate", dependencies=[Depends(require_admin_key)])
def activate(body: ActivateIn):
    """The ONE way to change which version serves (promotion and rollback).
    Integrity and compatibility are re-verified here, at activation time —
    not trusted from an earlier check — then the pointer is switched
    atomically. The backend's approval workflow decides WHETHER; this only
    refuses unsafe artifacts. The pointer file records who/why for audit."""
    previous = STATE["version"]
    previous_pointer = _read_current()
    try:
        _load_version(body.version)
    except FileNotFoundError as e:
        raise HTTPException(404, str(e))
    except PermissionError as e:
        # _load_version touches STATE only after verification, so the old model is still serving.
        raise HTTPException(409, str(e))
    _write_current(body.version, previous=previous, reason=body.reason, actor=body.actor, change_id=body.change_id, kind=body.kind)
    return {"status": "activated", "version": body.version, "previous_version": previous, "previous_pointer": previous_pointer}


@app.get("/model/versions/{version}/gates", dependencies=[Depends(require_service_key)])
def version_gates(version: str, incumbent: str | None = None, compare: bool = False):
    """Automated promotion gates for a registry version (integrity,
    compatibility, schema, calibration, required metrics, and — with
    compare=true — a same-benchmark labelled comparison with `incumbent`)."""
    if not version.replace("_", "").replace("-", "").isalnum() or (incumbent and not incumbent.replace("_", "").replace("-", "").isalnum()):
        raise HTTPException(400, "invalid version name")
    inc = incumbent or STATE["version"]
    gates = promotion_gates.evaluate_version(REGISTRY_DIR, version, incumbent=inc, include_comparison=compare)
    return {"version": version, "incumbent": inc, "gates": gates, "summary": promotion_gates.summarize(gates)}


@app.get("/model/baseline", dependencies=[Depends(require_service_key)])
def model_baseline():
    """Score-distribution baseline of the ACTIVE version (for rollback triggers)."""
    if STATE["baseline_stats"] is None:
        return {"version": STATE["version"], "score": None}
    return {
        "version": STATE["version"],
        "score": (STATE["baseline_stats"] or {}).get("score"),
        "n_features_tracked": len((STATE["baseline_stats"] or {}).get("numeric", {})) + len((STATE["baseline_stats"] or {}).get("binary", {})),
    }


class RollbackIn(BaseModel):
    version: str


@app.post("/model/rollback", dependencies=[Depends(require_admin_key)])
def rollback(body: RollbackIn):
    """Direct rollback. Prefer the audited path (backend change request with
    kind=rollback -> /model/activate). Kept for emergencies; it still
    verifies artifacts before switching."""
    return activate(ActivateIn(version=body.version, reason="direct rollback via /model/rollback", kind="rollback"))


# --- Drift monitoring (feature: model drift monitoring — utils/drift.py) ---

@app.get("/model/drift", dependencies=[Depends(require_service_key)])
def drift_report():
    """Compares recent live traffic (STATE["live_buffer"]/["score_buffer"],
    populated by every /predict call below) against the distribution the
    active model version was trained on (STATE["baseline_stats"], written
    once by train_model.py). No ground-truth labels needed — see
    utils/drift.py's module docstring for why PSI is the right metric
    for that."""
    if STATE["model"] is None:
        raise HTTPException(503, "Model not loaded.")
    if STATE["baseline_stats"] is None:
        raise HTTPException(
            503,
            "No baseline stats saved for this model version — it was trained "
            "before drift monitoring existed. Retrain with the current "
            "train_model.py to generate models/registry/<version>/baseline_stats.json.",
        )

    n = len(STATE["live_buffer"])
    if n < MIN_DRIFT_SAMPLES:
        return {
            "status": "insufficient_data",
            "version": STATE["version"],
            "n_samples": n,
            "min_required": MIN_DRIFT_SAMPLES,
        }

    live_df = pd.DataFrame(list(STATE["live_buffer"]))
    report = compute_drift_report(STATE["baseline_stats"], live_df, list(STATE["score_buffer"]))
    report["version"] = STATE["version"]
    return report


class DriftEvaluateIn(BaseModel):
    rows: list[TransactionIn] = Field(..., min_length=1, max_length=5000)
    scores: list[float] | None = None          # served fraud_score (0-100) per row, for the score comparison
    version: str | None = None                 # the version these rows were scored by; refuse if it is not the active one


@app.post("/model/drift/evaluate", dependencies=[Depends(require_service_key)])
def drift_evaluate(body: DriftEvaluateIn):
    """Drift of a CALLER-SUPPLIED batch (a time window, a customer segment) against the active version's training
    baseline. Same engineering, alignment and PSI code as GET /model/drift — this is that report for rows the
    backend selected from its own durable log, so history and segments survive a restart of this service.
    Stateless: nothing here touches the live buffers.
    """
    if STATE["model"] is None:
        raise HTTPException(503, "Model not loaded.")
    if STATE["baseline_stats"] is None:
        raise HTTPException(503, "No baseline stats saved for this model version.")
    if body.version and body.version != STATE["version"]:
        raise HTTPException(409, f"Rows were scored by {body.version} but {STATE['version']} is active; drift against a different baseline would be meaningless.")
    if body.scores is not None and len(body.scores) != len(body.rows):
        raise HTTPException(422, "scores must have one value per row")

    df = pd.DataFrame([r.dict() for r in body.rows])
    features = align_columns(engineer_features(df), STATE["feature_columns"])
    report = compute_drift_report(STATE["baseline_stats"], features, body.scores)
    report["version"] = STATE["version"]
    cols = set(STATE["feature_columns"] or [])
    unseen = {}
    for c in CATEGORY_COLS:
        n = int(sum(1 for v in df[c] if f"{c}_{v}" not in cols))
        if n:
            unseen[c] = n
    report["unseen_category_rows"] = unseen
    return report


@app.post("/model/drift/reset", dependencies=[Depends(require_admin_key)])
def drift_reset():
    """Clears the live-traffic buffer without reloading the model —
    useful right after a deliberate traffic-mix change (e.g. a new
    merchant integration) so drift is measured against fresh behavior
    instead of a stale mix."""
    STATE["live_buffer"].clear()
    STATE["score_buffer"].clear()
    monitor_store.clear_live(STATE["version"])   # else a restart would bring the old traffic back
    return {"status": "reset", "version": STATE["version"]}


# --- Controlled retraining from verified feedback labels ---------------------------------------------------------
# The backend builds an immutable, hashed dataset from analyst-verified labels (second-person verified) and sends it
# here. This ONLY trains a CANDIDATE version: nothing is served or reloaded, and promotion still goes through the
# model change workflow (gates, same-dataset comparison, a different person's approval).
RETRAIN_MIN_ROWS = 200
RETRAIN_MIN_FRAUD = 20
RETRAIN_REQUIRED_COLUMNS = {
    "timestamp", "user_synthetic_id", "amount", "category", "location", "card_type", "hour", "day_of_week",
    "distance_from_home", "geo_distance_from_last_km", "time_since_last_transaction_minutes",
    "ratio_to_median_purchase_price", "spending_zscore", "velocity_last_hour", "repeat_retailer", "used_chip",
    "used_pin_number", "online_order", "is_new_device", "ip_status", "is_fraud",
}
def _utc_now():
    return datetime.now(timezone.utc).isoformat()


RETRAIN = {"state": "idle"}
_RETRAIN_LOCK = threading.Lock()


class RetrainIn(BaseModel):
    dataset_csv: str = Field(min_length=1, max_length=80_000_000)
    dataset_sha256: str = Field(pattern="^[0-9a-f]{64}$")
    dataset_info: dict
    notes: str = Field(min_length=1, max_length=500)
    requested_by: str = Field(default="", max_length=120)


def _run_retrain(csv_text: str, info: dict, notes: str):
    import train_model
    path = None
    try:
        fd, path = tempfile.mkstemp(suffix=".csv", prefix="fg_labels_")
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(csv_text)
        version, promoted, meta = train_model.train_and_evaluate(notes=notes, data_path=path, dataset_info=info)
        RETRAIN.update(state="succeeded", version=version, bootstrap_activated=bool(promoted), pr_auc=meta.get("pr_auc"),
                       n_rows=meta.get("n_rows"), fraud_rate=meta.get("fraud_rate"), finished_at=_utc_now(), error=None)
    except Exception as e:  # noqa: BLE001 - reported to the caller, never swallowed silently
        RETRAIN.update(state="failed", error=str(e)[:500], finished_at=_utc_now())
    finally:
        if path and os.path.exists(path):
            os.remove(path)
        _RETRAIN_LOCK.release()


@app.post("/model/retrain", dependencies=[Depends(require_admin_key)], status_code=202)
def retrain(body: RetrainIn):
    if hashlib.sha256(body.dataset_csv.encode("utf-8")).hexdigest() != body.dataset_sha256:
        raise HTTPException(422, "dataset_sha256 does not match the dataset received; refusing to train on data whose lineage cannot be verified.")
    try:
        df = pd.read_csv(io.StringIO(body.dataset_csv))
    except Exception as e:  # noqa: BLE001
        raise HTTPException(422, f"dataset is not valid CSV: {e}")
    missing = sorted(RETRAIN_REQUIRED_COLUMNS - set(df.columns))
    if missing:
        raise HTTPException(422, f"dataset is missing required columns: {missing}")
    n_fraud = int(df["is_fraud"].sum()) if len(df) else 0
    if len(df) < RETRAIN_MIN_ROWS or n_fraud < RETRAIN_MIN_FRAUD or (len(df) - n_fraud) < RETRAIN_MIN_FRAUD:
        raise HTTPException(422, f"dataset too small to train responsibly: {len(df)} rows, {n_fraud} fraud "
                                 f"(need >= {RETRAIN_MIN_ROWS} rows and >= {RETRAIN_MIN_FRAUD} of each class).")
    if not _RETRAIN_LOCK.acquire(blocking=False):
        raise HTTPException(409, "A retraining run is already in progress.")
    info = {**body.dataset_info, "kind": "verified_labels", "sha256": body.dataset_sha256, "rows": int(len(df)), "fraud_rows": n_fraud,
            "requested_by": body.requested_by}
    RETRAIN.clear()
    RETRAIN.update(state="running", dataset_sha256=body.dataset_sha256, started_at=_utc_now())
    threading.Thread(target=_run_retrain, args=(body.dataset_csv, info, body.notes), daemon=True).start()
    return {"state": "running", "dataset_sha256": body.dataset_sha256, "rows": int(len(df)), "fraud_rows": n_fraud,
            "note": "Trains a CANDIDATE only. It will not be served until promoted through the model change workflow."}


@app.get("/model/retrain/status", dependencies=[Depends(require_service_key)])
def retrain_status():
    return dict(RETRAIN)


# --- Shadow / canary deployment (feature: shadow model deployment) ---

class ShadowSetIn(BaseModel):
    version: str


@app.post("/model/shadow/set", dependencies=[Depends(require_admin_key)])
def set_shadow(body: ShadowSetIn):
    """Starts scoring every /predict call with `body.version` IN
    PARALLEL with the active primary model, purely for comparison —
    the shadow score never affects the response's fraud_score/risk_level.
    This is how a challenger model gets evaluated against real
    production traffic before anyone trusts it to make decisions, not
    just against the fixed held-out test set from training."""
    try:
        _load_shadow_version(body.version)
        return {"status": "shadow_active", "shadow_version": body.version, "primary_version": STATE["version"]}
    except FileNotFoundError as e:
        raise HTTPException(404, str(e))
    except PermissionError as e:
        raise HTTPException(409, str(e))
    except ValueError as e:
        raise HTTPException(400, str(e))


@app.post("/model/shadow/clear", dependencies=[Depends(require_admin_key)])
def clear_shadow():
    _clear_shadow_state()
    return {"status": "shadow_cleared"}


@app.get("/model/shadow/status", dependencies=[Depends(require_service_key)])
def shadow_status():
    if STATE["shadow_version"] is None:
        return {"active": False}

    comps = list(STATE["shadow_comparisons"])
    n = len(comps)
    base = {
        "active": True,
        "shadow_version": STATE["shadow_version"],
        "shadow_model_type": STATE["shadow_metadata"]["best_model_type"] if STATE["shadow_metadata"] else None,
        "primary_version": STATE["version"],
        "primary_model_type": STATE["metadata"]["best_model_type"] if STATE["metadata"] else None,
        "n_compared": n,
    }
    if n == 0:
        return base

    agreement_rate = sum(1 for c in comps if c["agree_risk_level"]) / n
    mean_abs_diff = sum(c["abs_score_diff"] for c in comps) / n
    pct_shadow_higher = sum(1 for c in comps if c["shadow_score"] > c["primary_score"]) / n
    return {
        **base,
        "risk_level_agreement_rate": round(agreement_rate, 4),
        "mean_absolute_score_diff": round(mean_abs_diff, 2),
        "pct_shadow_scored_higher": round(pct_shadow_higher, 4),
    }


@app.post("/model/shadow/promote", dependencies=[Depends(require_admin_key)])
def promote_shadow():
    """REMOVED as a promotion path. Shadow-score agreement says the two models
    behave alike, not that the challenger is more accurate; promoting on it
    would bypass the gates, the labelled comparison and the second approver.
    Use the change-request workflow (backend /api/admin/ml/change-requests)."""
    raise HTTPException(410, "Direct shadow promotion is disabled. Request promotion through the model change workflow "
                             "(gates + labelled comparison + a second person's approval).")


@app.post("/predict", dependencies=[Depends(require_service_key)])
def predict(
    txn: TransactionIn,
    medium: float = Query(10.0, ge=0, le=100, description="Reference review threshold (score units) — used ONLY to log shadow-model agreement"),
    high: float = Query(50.0, ge=0, le=100, description="Reference high-risk threshold (score units) — used ONLY to log shadow-model agreement"),
):
    """Returns a MODEL PROBABILITY, not a decision.

    `fraud_probability` is the calibrated estimate of P(fraud) (see
    docs/MODEL_VALIDATION.md); `raw_probability` is the uncalibrated model
    output (a ranking score). Turning the probability into low/medium/high
    or an action is a POLICY decision made by the backend from its
    admin-configurable risk policy — deliberately not here. `medium`/`high`
    query params only let the shadow-model comparison use the live policy.
    """
    if STATE["model"] is None:
        raise HTTPException(503, "Model not loaded. Run train_model.py, then restart/reload this service.")

    row = pd.DataFrame([txn.dict()])
    features = engineer_features(row)
    features = align_columns(features, STATE["feature_columns"])
    scaled = STATE["scaler"].transform(features)

    raw_prob = float(STATE["model"].predict_proba(scaled)[0][1])
    fraud_prob = _calibrate(STATE["calibrator"], raw_prob)
    score = round(fraud_prob * 100, 2)

    top_factors = _shap_top_factors(scaled, features.columns.tolist())

    # --- Drift monitoring: record this call's engineered features/score.
    # Best-effort — a buffering hiccup should never break a real scoring
    # response. ---
    try:
        feats = features.iloc[0].to_dict()
        STATE["live_buffer"].append(feats)
        STATE["score_buffer"].append(score)
        monitor_store.record_live(STATE["version"], score, feats, LIVE_BUFFER_MAXLEN)
    except Exception as e:
        print(f"Drift buffering failed (not affecting the served response): {e}")

    # --- Shadow/canary scoring: run the shadow model on the SAME input,
    # log the comparison, never let it touch the response. Also
    # best-effort for the same reason. ---
    shadow_out = None
    if STATE["shadow_model"] is not None:
        try:
            shadow_features = engineer_features(row)
            shadow_features = align_columns(shadow_features, STATE["shadow_feature_columns"])
            shadow_scaled = STATE["shadow_scaler"].transform(shadow_features)
            shadow_raw = float(STATE["shadow_model"].predict_proba(shadow_scaled)[0][1])
            shadow_score = round(_calibrate(STATE["shadow_calibrator"], shadow_raw) * 100, 2)
            STATE["shadow_comparisons"].append({
                "primary_score": score,
                "shadow_score": shadow_score,
                "abs_score_diff": abs(score - shadow_score),
                "agree_risk_level": _risk_label(shadow_score, medium, high) == _risk_label(score, medium, high),
            })
            monitor_store.record_shadow(STATE["version"], STATE["shadow_version"], score, shadow_score,
                                        _risk_label(shadow_score, medium, high) == _risk_label(score, medium, high), SHADOW_COMPARISON_MAXLEN)
            # Returned so the backend can store it next to the transaction and,
            # when the label arrives, judge the challenger on OUTCOMES.
            shadow_out = {"version": STATE["shadow_version"], "fraud_probability": round(shadow_score / 100, 4), "fraud_score": shadow_score}
        except Exception as e:
            print(f"Shadow scoring failed (not affecting the served response): {e}")

    return {
        "fraud_score": score,                      # = fraud_probability x 100
        "fraud_probability": round(fraud_prob, 4),  # calibrated P(fraud)
        "raw_probability": round(raw_prob, 4),      # uncalibrated model output (ranking only)
        "calibrated": STATE["calibrator"] is not None,
        "model_used": STATE["metadata"]["best_model_type"],
        "model_version": STATE["version"],
        "top_factors": top_factors,
        "shadow": shadow_out,
        "feature_quality": _feature_quality(txn, STATE["feature_columns"]),
    }


def _shap_top_factors(scaled_row, feature_names, top_n=5):
    """Runs the SHAP explainer for this single prediction and returns the
    features that pushed the score toward FRAUD the most (positive SHAP
    value for the fraud class), in human-readable form. This replaces
    naive weight*value heuristics with a real, theoretically-grounded
    attribution method — the same one used to explain individual
    predictions in production fraud systems.
    """
    try:
        shap_values = STATE["explainer"](scaled_row)
        # shap_values.values shape: (1, n_features, n_classes) for predict_proba-based explainer
        values = shap_values.values[0]
        if values.ndim == 2:
            values = values[:, 1]  # class 1 = fraud
        idx = np.argsort(values)[::-1][:top_n]
        return [
            {
                "feature": _humanize(feature_names[i]),
                "shap_value": round(float(values[i]), 4),
                "effect": "increased_risk" if values[i] > 0 else "decreased_risk",
            }
            for i in idx if abs(values[i]) > 1e-4
        ]
    except Exception as e:
        print(f"SHAP explanation failed: {e}")
        return []


def _humanize(name: str) -> str:
    return (
        name.replace("category_", "category: ")
            .replace("location_", "location: ")
            .replace("card_type_", "card type: ")
            .replace("ip_status_", "IP status: ")
            .replace("_", " ")
    )
