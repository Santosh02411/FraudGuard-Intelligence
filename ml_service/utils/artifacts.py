"""
Model artifact integrity
===========================
Model files are Python pickles, and unpickling executes code. Before the
service (or a comparison job) loads a registry version it therefore checks
the version against a MANIFEST written at training time:

  * sha256 of every artifact file  -> detects corruption and edits made after
    training (a swapped model.pkl, a hand-edited calibrator or metrics file);
  * the feature schema hash        -> the model and the serving pipeline must
    agree on the exact input columns;
  * the library versions it was trained with -> pickles are only reliably
    loadable by the same scikit-learn / xgboost / numpy minor version;
  * optionally an HMAC-SHA256 signature (MODEL_SIGNING_KEY) over all of the
    above. With a key configured, someone who can write to the registry but
    does not hold the key cannot produce a manifest that verifies.

What this does NOT protect against: an attacker who holds the signing key
(or who can change MODEL_SIGNING_KEY on the host), or a malicious model
produced by the legitimate training job. Without MODEL_SIGNING_KEY the
manifest detects accidents and casual tampering only — anyone who can edit
the pickle can also regenerate the unsigned manifest.
"""

import hashlib
import hmac
import json
import os
import platform
import sys
from datetime import datetime, timezone

MANIFEST_NAME = "manifest.json"
MANIFEST_FORMAT = 1
# Files that make up a version. manifest.json itself is excluded.
ARTIFACT_FILES = [
    "model.pkl", "scaler.pkl", "calibrator.pkl", "feature_columns.json",
    "metrics.json", "metadata.json", "baseline_stats.json", "background_sample.npy",
]
REQUIRED_FILES = ["model.pkl", "scaler.pkl", "feature_columns.json", "metrics.json", "metadata.json"]


def _sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def signing_key():
    key = os.environ.get("MODEL_SIGNING_KEY", "")
    return key.encode() if key else None


def feature_schema_hash(columns):
    return hashlib.sha256(json.dumps(list(columns)).encode()).hexdigest()


def runtime_versions():
    out = {"python": platform.python_version()}
    for mod in ("sklearn", "xgboost", "numpy", "pandas", "joblib"):
        try:
            out[mod] = __import__(mod).__version__
        except Exception:  # pragma: no cover - optional libs
            out[mod] = None
    return out


def _canonical(manifest):
    body = {k: v for k, v in manifest.items() if k != "signature"}
    return json.dumps(body, sort_keys=True, separators=(",", ":")).encode()


def build_manifest(version_dir, version, feature_columns, extra=None):
    files = {}
    for name in ARTIFACT_FILES:
        path = os.path.join(version_dir, name)
        if os.path.exists(path):
            files[name] = _sha256(path)
    manifest = {
        "format": MANIFEST_FORMAT,
        "version": version,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "files": files,
        "feature_count": len(feature_columns),
        "feature_schema_sha256": feature_schema_hash(feature_columns),
        "runtime": runtime_versions(),
        **(extra or {}),
    }
    key = signing_key()
    if key:
        manifest["signature"] = {"alg": "HMAC-SHA256", "value": hmac.new(key, _canonical(manifest), hashlib.sha256).hexdigest()}
    return manifest


def write_manifest(version_dir, version, feature_columns, extra=None):
    manifest = build_manifest(version_dir, version, feature_columns, extra)
    with open(os.path.join(version_dir, MANIFEST_NAME), "w") as f:
        json.dump(manifest, f, indent=2)
    return manifest


def read_manifest(version_dir):
    path = os.path.join(version_dir, MANIFEST_NAME)
    if not os.path.exists(path):
        return None
    with open(path) as f:
        return json.load(f)


def verify(version_dir, require_signature=None):
    """Returns {ok, signed, checks:[{name, ok, detail}]}. Never loads a pickle."""
    checks = []

    def add(name, ok, detail=""):
        checks.append({"name": name, "ok": bool(ok), "detail": detail})

    manifest = read_manifest(version_dir)
    if manifest is None:
        add("manifest_present", False, "no manifest.json — version predates integrity manifests and cannot be verified")
        return {"ok": False, "signed": False, "manifest": None, "checks": checks}
    add("manifest_present", True)

    for name in REQUIRED_FILES:
        add(f"required_file:{name}", os.path.exists(os.path.join(version_dir, name)), "" if os.path.exists(os.path.join(version_dir, name)) else "missing")

    for name, expected in manifest.get("files", {}).items():
        path = os.path.join(version_dir, name)
        if not os.path.exists(path):
            add(f"sha256:{name}", False, "file listed in manifest is missing")
            continue
        actual = _sha256(path)
        add(f"sha256:{name}", actual == expected, "" if actual == expected else "hash mismatch — file changed since training")
    # A file present on disk but absent from the manifest was added afterwards.
    for name in ARTIFACT_FILES:
        if os.path.exists(os.path.join(version_dir, name)) and name not in manifest.get("files", {}):
            add(f"unlisted:{name}", False, "artifact exists but is not in the manifest")

    try:
        with open(os.path.join(version_dir, "feature_columns.json")) as f:
            cols = json.load(f)
        add("feature_schema_hash", feature_schema_hash(cols) == manifest.get("feature_schema_sha256"), "feature_columns.json does not match the manifest")
    except Exception as e:
        add("feature_schema_hash", False, str(e))

    key = signing_key()
    sig = manifest.get("signature")
    need_sig = key is not None if require_signature is None else require_signature
    if sig:
        if key is None:
            add("signature", not need_sig, "manifest is signed but no MODEL_SIGNING_KEY is configured to verify it")
        else:
            expected = hmac.new(key, _canonical(manifest), hashlib.sha256).hexdigest()
            add("signature", hmac.compare_digest(expected, sig.get("value", "")), "signature does not verify with MODEL_SIGNING_KEY")
    else:
        add("signature", not need_sig, "unsigned manifest while a signing key is configured" if need_sig else "unsigned (tamper-evident only)")

    return {"ok": all(c["ok"] for c in checks), "signed": bool(sig), "manifest": manifest, "checks": checks}


def runtime_compatibility(manifest):
    """scikit-learn / xgboost / numpy pickles need the same minor version."""
    now = runtime_versions()
    trained = (manifest or {}).get("runtime", {})
    problems, notes = [], []
    for lib in ("sklearn", "xgboost", "numpy"):
        a, b = trained.get(lib), now.get(lib)
        if a is None or b is None:
            notes.append(f"{lib}: version not recorded")
            continue
        if a.split(".")[:2] != b.split(".")[:2]:
            problems.append(f"{lib} trained with {a}, serving with {b}")
    if trained.get("python") and trained["python"].split(".")[:2] != now["python"].split(".")[:2]:
        notes.append(f"python trained with {trained['python']}, serving with {now['python']}")
    return {"ok": not problems, "problems": problems, "notes": notes, "trained": trained, "serving": now}


def adopt(version_dir):
    """Writes a manifest for a version trained BEFORE manifests existed.
    This attests only that the files are what they are NOW — it cannot prove
    they are unchanged since training — and the manifest says so."""
    if read_manifest(version_dir) is not None:
        raise ValueError("version already has a manifest; refusing to overwrite it")
    with open(os.path.join(version_dir, "feature_columns.json")) as f:
        cols = json.load(f)
    version = os.path.basename(os.path.normpath(version_dir))
    return write_manifest(version_dir, version, cols, extra={
        "adopted": True,
        "adopted_note": "legacy version: manifest written after the fact; integrity is attested from adoption time, not training time",
    })


if __name__ == "__main__":  # python -m utils.artifacts [--adopt] models/registry/v3
    args = [a for a in sys.argv[1:] if a != "--adopt"]
    if "--adopt" in sys.argv:
        adopt(args[0])
    result = verify(args[0])
    print(json.dumps({k: v for k, v in result.items() if k != "manifest"}, indent=2))
    sys.exit(0 if result["ok"] else 1)
