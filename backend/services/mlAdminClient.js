/**
 * ML Admin Client
 * =================
 * Thin wrapper around the ML service's model-monitoring endpoints
 * (drift report, shadow/canary deployment) — mirrors models/mlClient.js's
 * pattern (fetch + timeout + typed error) but for the admin-facing
 * model-ops surface rather than the per-transaction scoring path.
 * routes/admin.js proxies through this instead of the frontend calling
 * ml_service directly, so the ML service never needs to be reachable
 * from the browser (same reasoning as every other backend/db access).
 */

const config = require("../config/env");
const { AppError } = require("../middleware/errorHandler");

const ML_SERVICE_URL = config.mlServiceUrl;
const ML_TIMEOUT_MS = config.mlServiceTimeoutMs;

// Read-only monitoring calls carry only the service key; calls that CHANGE
// model state (admin: true) additionally carry the separate admin key, which
// the ML service requires for them — so a leaked/over-broad service key
// can't reload, roll back, promote or reconfigure models.
function authHeaders(admin) {
  return {
    ...(config.mlServiceApiKey
      ? { "X-ML-Api-Key": config.mlServiceApiKey }
      : {}),
    ...(admin && config.mlAdminApiKey
      ? { "X-ML-Admin-Key": config.mlAdminApiKey }
      : {}),
  };
}

async function callMlService(
  path,
  { method = "GET", body, admin = false, timeoutMs } = {},
) {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    timeoutMs || ML_TIMEOUT_MS,
  );
  try {
    const response = await fetch(`${ML_SERVICE_URL}${path}`, {
      method,
      headers: {
        ...(body ? { "Content-Type": "application/json" } : {}),
        ...authHeaders(admin),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    const data = await response.json().catch(() => ({}));
    if (
      response.status === 401 ||
      response.status === 403 ||
      (response.status === 503 && /not configured/i.test(data.detail || ""))
    ) {
      // Our credentials to the ML service are missing/wrong — an ops
      // problem, not something the admin who clicked the button did.
      throw AppError.serviceUnavailable(
        "ML service rejected the backend's credentials — check ML_SERVICE_API_KEY / ML_ADMIN_API_KEY",
      );
    }
    if (!response.ok) {
      throw AppError.badRequest(
        data.detail || `ML service returned ${response.status}`,
        data,
      );
    }
    return data;
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw AppError.serviceUnavailable(
      "ML service is unreachable — is ml_service running?",
    );
  } finally {
    clearTimeout(timeout);
  }
}

const getDrift = () => callMlService("/model/drift");
const resetDrift = () =>
  callMlService("/model/drift/reset", { method: "POST", admin: true });
// Drift of a caller-selected batch (a window / a segment) against the active baseline; stateless on the ML side.
const evaluateDrift = ({ rows, scores, version }) =>
  callMlService("/model/drift/evaluate", {
    method: "POST",
    body: { rows, scores, version },
    timeoutMs: 31000,
  });
// Controlled retraining: trains a CANDIDATE from a hashed dataset. Never activates anything. Large payload, so a long timeout.
const startRetrain = (body) =>
  callMlService("/model/retrain", {
    method: "POST",
    body,
    admin: true,
    timeoutMs: 120000,
  });
const retrainStatus = () => callMlService("/model/retrain/status");
const getShadowStatus = () => callMlService("/model/shadow/status");
const setShadow = (version) =>
  callMlService("/model/shadow/set", {
    method: "POST",
    body: { version },
    admin: true,
  });
const clearShadow = () =>
  callMlService("/model/shadow/clear", { method: "POST", admin: true });
const listVersions = () => callMlService("/model/versions");
// Model governance. `compare` runs the labelled same-benchmark comparison (slow: tens of seconds).
const getGates = (version, { incumbent, compare = false } = {}) => {
  const q = new URLSearchParams();
  if (incumbent) q.set("incumbent", incumbent);
  if (compare) q.set("compare", "true");
  const qs = q.toString();
  return callMlService(
    `/model/versions/${encodeURIComponent(version)}/gates${qs ? `?${qs}` : ""}`,
    { timeoutMs: compare ? 180000 : undefined },
  );
};
const getBaseline = () => callMlService("/model/baseline");
// The only call that changes which model serves. The ML service re-verifies the artifacts itself.
const activate = ({ version, reason, actor, changeId, kind }) =>
  callMlService("/model/activate", {
    method: "POST",
    admin: true,
    body: {
      version,
      reason,
      actor: actor || "",
      change_id: changeId ?? null,
      kind,
    },
  });

module.exports = {
  callMlService,
  startRetrain,
  retrainStatus,
  evaluateDrift,
  getDrift,
  resetDrift,
  getShadowStatus,
  setShadow,
  clearShadow,
  listVersions,
  getGates,
  getBaseline,
  activate,
};
