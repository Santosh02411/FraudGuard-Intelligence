import React, { useState, useEffect, useCallback } from "react";
import { api } from "../context/AuthContext";
import { useAuth } from "../context/AuthContext";
import {
  ScrollText,
  Download,
  Code2,
  Webhook,
  Trash2,
  ShieldOff,
  ShieldCheck,
  ShieldAlert,
  Network,
  Cpu,
  Users,
  Plus,
  X,
  RefreshCw,
  Pencil,
  Eye,
  SlidersHorizontal,
} from "lucide-react";
import { LoadingState, ErrorState } from "../components/ui/States";
import { downloadBlobResponse } from "../utils/download";
import PageHeading from "../components/ui/PageHeading";
import StatCard from "../components/ui/StatCard";
import RiskPolicyPanel from "../components/admin/RiskPolicyPanel";
import ModelChangesPanel from "../components/admin/ModelChangesPanel";

const TABS = [
  { key: "overview", label: "Overview", icon: Users },
  { key: "rules", label: "Fraud Rules", icon: ShieldAlert },
  { key: "rings", label: "Fraud Rings", icon: Network },
  { key: "mlops", label: "ML Ops", icon: Cpu },
  { key: "modelchanges", label: "Model Changes", icon: Cpu },
  { key: "policy", label: "Risk Policy", icon: SlidersHorizontal },
  { key: "integrations", label: "Integrations", icon: Code2 },
  { key: "audit", label: "Audit Trail", icon: ScrollText },
];

const RULE_TYPES = [
  "blacklist_merchant",
  "blacklist_location",
  "blacklist_device",
  "blacklist_ip",
  "amount_cap",
];
const RULE_TYPE_LABEL = {
  blacklist_merchant: "Blacklist: Merchant",
  blacklist_location: "Blacklist: Location",
  blacklist_device: "Blacklist: Device",
  blacklist_ip: "Blacklist: IP",
  amount_cap: "Amount Cap",
};

const RING_RISK_STYLE = {
  high: "bg-red-500/15 text-red-400",
  watch: "bg-yellow-500/15 text-yellow-400",
  low: "bg-gray-500/15 text-gray-400",
};

const DRIFT_STATUS_STYLE = {
  stable: "bg-green-500/15 text-green-400",
  moderate_drift: "bg-yellow-500/15 text-yellow-400",
  significant_drift: "bg-red-500/15 text-red-400",
  insufficient_data: "bg-gray-500/15 text-gray-400",
};

export default function AdminPage() {
  const { user } = useAuth();
  const [activeTab, setActiveTab] = useState("overview");

  const [stats, setStats] = useState(null);
  const [users, setUsers] = useState([]);
  const [auditLogs, setAuditLogs] = useState([]);
  const [apiKeys, setApiKeys] = useState([]);
  const [webhooks, setWebhooks] = useState([]);
  const [fraudRules, setFraudRules] = useState([]);
  const [fraudRings, setFraudRings] = useState([]);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState("");
  const [error, setError] = useState("");
  const [exportingAudit, setExportingAudit] = useState(false);

  // Fraud rules — new-rule form (feature: admin rule builder).
  const [showRuleForm, setShowRuleForm] = useState(false);
  const [ruleForm, setRuleForm] = useState({
    rule_type: "blacklist_merchant",
    value: "",
    threshold: "",
    reason: "",
  });
  const [ruleFormError, setRuleFormError] = useState("");
  const [ruleFormBusy, setRuleFormBusy] = useState(false);
  const [ruleBusyId, setRuleBusyId] = useState(null);

  // Rule impact preview (feature: rule impact preview) — a dry-run
  // against transactions already on file, shown before the rule
  // actually exists. Cleared whenever the candidate rule's own fields
  // change, since a stale preview from a different value/threshold
  // would be actively misleading rather than just outdated.
  const [preview, setPreview] = useState(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState("");

  // In-place edit of an existing rule's value/threshold/reason
  // (rule_type itself is immutable — see adminSchemas.fraudRuleUpdateBody,
  // which doesn't accept it — so editing keeps the same type as create).
  const [editingRuleId, setEditingRuleId] = useState(null);
  const [editRuleForm, setEditRuleForm] = useState({
    value: "",
    threshold: "",
    reason: "",
  });
  const [editRuleError, setEditRuleError] = useState("");
  const [editRuleBusy, setEditRuleBusy] = useState(false);

  // ML Ops — lazy-loaded on tab activation, with its own error state, so
  // ml_service being unreachable never blocks the rest of the admin panel
  // (mirrors mlAdminClient.js's own "service unavailable" handling).
  const [mlLoaded, setMlLoaded] = useState(false);
  const [mlLoading, setMlLoading] = useState(false);
  const [mlError, setMlError] = useState("");
  const [mlVersions, setMlVersions] = useState([]);
  const [mlActiveVersion, setMlActiveVersion] = useState(null);
  const [mlDrift, setMlDrift] = useState(null);
  const [mlShadow, setMlShadow] = useState(null);
  const [mlBusy, setMlBusy] = useState("");
  const [shadowVersionInput, setShadowVersionInput] = useState("");

  const showMessage = (text) => {
    setMsg(text);
    setTimeout(() => setMsg(""), 3100);
  };

  const loadData = useCallback(() => {
    setLoading(true);
    setError("");
    Promise.all([
      api.get("/admin/stats"),
      api.get("/admin/users"),
      api.get("/admin/audit-logs", { params: { page: 1, limit: 25 } }),
      api.get("/api-keys"), // no ?mine=true — admin sees every user's, for oversight
      api.get("/webhooks"),
      api.get("/admin/fraud-rules"),
      api.get("/admin/fraud-rings"),
    ])
      .then(([sRes, uRes, aRes, kRes, wRes, frRes, ringRes]) => {
        setStats(sRes.data);
        setUsers(uRes.data.users);
        setAuditLogs(aRes.data.logs);
        setApiKeys(kRes.data.apiKeys);
        setWebhooks(wRes.data.webhooks);
        setFraudRules(frRes.data.rules);
        setFraudRings(ringRes.data.rings);
      })
      .catch((err) => {
        setError(err.response?.data?.error || "Failed to load admin panel");
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const loadMlOps = useCallback(() => {
    setMlLoading(true);
    setMlError("");
    Promise.all([
      api.get("/admin/ml/versions"),
      api.get("/admin/ml/drift"),
      api.get("/admin/ml/shadow/status"),
    ])
      .then(([vRes, dRes, sRes]) => {
        setMlVersions(vRes.data.versions);
        setMlActiveVersion(vRes.data.active);
        setMlDrift(dRes.data);
        setMlShadow(sRes.data);
      })
      .catch((err) => {
        setMlError(err.response?.data?.error || "ML service is unreachable");
      })
      .finally(() => {
        // Set even on failure — the auto-load effect below only fires
        // while !mlLoaded, so this is what stops it from retrying in a
        // loop on every render; ErrorState's Retry button still calls
        // loadMlOps() directly regardless of this flag.
        setMlLoaded(true);
        setMlLoading(false);
      });
  }, []);

  useEffect(() => {
    if (activeTab === "mlops" && !mlLoaded && !mlLoading) loadMlOps();
  }, [activeTab, mlLoaded, mlLoading, loadMlOps]);

  const changeRole = async (userId, newRole) => {
    try {
      await api.patch(`/admin/users/${userId}/role`, { role: newRole });
      showMessage(`Role updated to ${newRole}`);
      loadData();
    } catch (err) {
      showMessage(err.response?.data?.error || "Failed to update role");
    }
  };

  const revokeApiKey = async (id) => {
    await api.delete(`/api-keys/${id}`);
    setApiKeys((prev) =>
      prev.map((k) =>
        k.id === id ? { ...k, revoked_at: new Date().toISOString() } : k,
      ),
    );
  };

  const toggleWebhookActive = async (webhook) => {
    await api.patch(`/webhooks/${webhook.id}`, { active: !webhook.active });
    setWebhooks((prev) =>
      prev.map((w) =>
        w.id === webhook.id ? { ...w, active: !webhook.active } : w,
      ),
    );
  };

  const exportAuditLog = async () => {
    setExportingAudit(true);
    try {
      const res = await api.get("/admin/audit-logs/export", {
        responseType: "blob",
      });
      downloadBlobResponse(res, "audit-logs.csv");
    } catch (err) {
      showMessage("Failed to export audit log");
    } finally {
      setExportingAudit(false);
    }
  };

  // --- Fraud rules (feature: admin rule builder) ---

  const submitRuleForm = async (e) => {
    e.preventDefault();
    setRuleFormBusy(true);
    setRuleFormError("");
    try {
      const body = {
        rule_type: ruleForm.rule_type,
        reason: ruleForm.reason || undefined,
      };
      if (ruleForm.rule_type === "amount_cap")
        body.threshold = Number(ruleForm.threshold);
      else body.value = ruleForm.value;

      const { data } = await api.post("/admin/fraud-rules", body);
      setFraudRules((prev) => [...prev, data.rule]);
      setShowRuleForm(false);
      setRuleForm({
        rule_type: "blacklist_merchant",
        value: "",
        threshold: "",
        reason: "",
      });
      setPreview(null);
    } catch (err) {
      setRuleFormError(err.response?.data?.error || "Failed to create rule");
    } finally {
      setRuleFormBusy(false);
    }
  };

  // A form-field change makes any prior preview stale — clear it so the
  // admin never sees an impact number for a rule they've since edited.
  const updateRuleForm = (changes) => {
    setRuleForm((f) => ({ ...f, ...changes }));
    setPreview(null);
    setPreviewError("");
  };

  const previewRuleImpact = async () => {
    setPreviewLoading(true);
    setPreviewError("");
    setPreview(null);
    try {
      const body = { rule_type: ruleForm.rule_type };
      if (ruleForm.rule_type === "amount_cap")
        body.threshold = Number(ruleForm.threshold);
      else body.value = ruleForm.value;

      const { data } = await api.post("/admin/fraud-rules/preview", body);
      setPreview(data);
    } catch (err) {
      setPreviewError(
        err.response?.data?.error || "Failed to preview this rule",
      );
    } finally {
      setPreviewLoading(false);
    }
  };

  const toggleRuleEnabled = async (rule) => {
    setRuleBusyId(rule.id);
    try {
      const { data } = await api.patch(`/admin/fraud-rules/${rule.id}`, {
        enabled: !rule.enabled,
      });
      // The PATCH response comes straight from a plain findById (no
      // username join, unlike the list endpoint) — merge over the
      // existing row instead of replacing it, so updated_by_username
      // doesn't disappear from the table until the next full reload.
      setFraudRules((prev) =>
        prev.map((r) => (r.id === rule.id ? { ...r, ...data.rule } : r)),
      );
    } catch (err) {
      showMessage(err.response?.data?.error || "Failed to update rule");
    } finally {
      setRuleBusyId(null);
    }
  };

  const deleteRule = async (rule) => {
    setRuleBusyId(rule.id);
    try {
      await api.delete(`/admin/fraud-rules/${rule.id}`);
      setFraudRules((prev) => prev.filter((r) => r.id !== rule.id));
    } catch (err) {
      showMessage(err.response?.data?.error || "Failed to delete rule");
    } finally {
      setRuleBusyId(null);
    }
  };

  const startEditingRule = (rule) => {
    setEditingRuleId(rule.id);
    setEditRuleForm({
      value: rule.rule_type === "amount_cap" ? "" : rule.value,
      threshold: rule.rule_type === "amount_cap" ? String(rule.threshold) : "",
      reason: rule.reason || "",
    });
    setEditRuleError("");
  };

  const submitEditRule = async (rule) => {
    setEditRuleBusy(true);
    setEditRuleError("");
    try {
      const body = { reason: editRuleForm.reason || undefined };
      if (rule.rule_type === "amount_cap")
        body.threshold = Number(editRuleForm.threshold);
      else body.value = editRuleForm.value;

      const { data } = await api.patch(`/admin/fraud-rules/${rule.id}`, body);
      setFraudRules((prev) =>
        prev.map((r) => (r.id === rule.id ? { ...r, ...data.rule } : r)),
      );
      setEditingRuleId(null);
    } catch (err) {
      setEditRuleError(err.response?.data?.error || "Failed to update rule");
    } finally {
      setEditRuleBusy(false);
    }
  };

  // --- ML Ops (feature: drift monitoring + shadow/canary deployment) ---

  const resetDrift = async () => {
    setMlBusy("reset-drift");
    try {
      await api.post("/admin/ml/drift/reset");
      const { data } = await api.get("/admin/ml/drift");
      setMlDrift(data);
    } catch (err) {
      showMessage(err.response?.data?.error || "Failed to reset drift buffer");
    } finally {
      setMlBusy("");
    }
  };

  const setShadow = async (e) => {
    e.preventDefault();
    setMlBusy("set-shadow");
    setMlError("");
    try {
      await api.post("/admin/ml/shadow/set", { version: shadowVersionInput });
      const { data } = await api.get("/admin/ml/shadow/status");
      setMlShadow(data);
      setShadowVersionInput("");
    } catch (err) {
      showMessage(err.response?.data?.error || "Failed to set shadow model");
    } finally {
      setMlBusy("");
    }
  };

  const clearShadow = async () => {
    setMlBusy("clear-shadow");
    try {
      const { data } = await api.post("/admin/ml/shadow/clear");
      setMlShadow({ active: false, ...data });
    } catch (err) {
      showMessage(err.response?.data?.error || "Failed to clear shadow model");
    } finally {
      setMlBusy("");
    }
  };

  if (loading)
    return (
      <div className="p-4 sm:p-8 max-w-7xl mx-auto">
        <LoadingState label="Loading admin panel..." />
      </div>
    );

  if (error)
    return (
      <div className="p-4 sm:p-8 max-w-7xl mx-auto">
        <ErrorState message={error} onRetry={loadData} />
      </div>
    );

  return (
    <div className="p-4 sm:p-8 max-w-7xl mx-auto">
      <div className="mb-6 sm:mb-8">
        <PageHeading
          icon={Users}
          title="Admin Panel"
          subtitle="System administration and monitoring"
        />
      </div>

      {msg && (
        <div className="mb-4 bg-purple-500/10 border border-purple-500/30 text-purple-300 rounded-lg px-4 py-3 text-sm">
          {msg}
        </div>
      )}

      <div className="flex items-center gap-1 mb-6 overflow-x-auto pb-1">
        {TABS.map((tab) => {
          const Icon = tab.icon;
          return (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium whitespace-nowrap transition-colors ${
                activeTab === tab.key
                  ? "bg-purple-600 text-white"
                  : "text-gray-300 hover:text-white hover:bg-white/10"
              }`}
            >
              <Icon size={15} /> {tab.label}
            </button>
          );
        })}
      </div>

      {activeTab === "overview" && (
        <>
          <div className="stagger grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
            <StatCard title="Total Users" value={stats?.total_users ?? 0} />
            <StatCard
              title="System Transactions"
              value={stats?.total_transactions ?? 0}
            />
            <StatCard
              title="Active Alerts"
              value={stats?.active_alerts ?? 0}
              color="text-yellow-400"
            />
            <StatCard
              title="System Fraud Rate"
              value={`${stats?.system_fraud_rate ?? 0}%`}
              color={
                stats?.system_fraud_rate > 15
                  ? "text-red-400"
                  : "text-orange-400"
              }
            />
          </div>

          <div className="bg-[#111820] border border-white/10 rounded-xl">
            <div className="p-6 border-b border-white/10">
              <h2 className="text-lg font-semibold text-white">
                User Management
              </h2>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-white/10 text-gray-400 text-sm">
                    <th className="text-left px-6 py-3">Username</th>
                    <th className="text-left px-6 py-3">Email</th>
                    <th className="text-left px-6 py-3">Role</th>
                    <th className="text-left px-6 py-3">Total Transactions</th>
                    <th className="text-left px-6 py-3">Fraud Rate</th>
                    <th className="text-left px-6 py-3">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {users.length === 0 ? (
                    <tr>
                      <td
                        colSpan={6}
                        className="px-6 py-8 text-center text-gray-500"
                      >
                        No users found
                      </td>
                    </tr>
                  ) : (
                    users.map((u) => (
                      <tr
                        key={u.id}
                        className="border-b border-white/5 hover:bg-white/5 transition-colors"
                      >
                        <td className="px-6 py-4 text-white font-medium">
                          {u.username}
                          {u.is_demo && (
                            <span
                              title="Seeded demo account — not a real customer"
                              className="ml-2 align-middle text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-400 border border-amber-500/20"
                            >
                              Demo
                            </span>
                          )}
                        </td>
                        <td className="px-6 py-4 text-gray-300">{u.email}</td>
                        <td className="px-6 py-4">
                          <span
                            className={`px-2 py-0.5 rounded text-xs font-semibold ${
                              u.role === "admin"
                                ? "bg-purple-600 text-white"
                                : "bg-white/10 text-gray-300"
                            }`}
                          >
                            {u.role}
                          </span>
                        </td>
                        <td className="px-6 py-4 text-gray-300">
                          {u.total_transactions}
                        </td>
                        <td className="px-6 py-4">
                          <span
                            className={
                              u.fraud_rate > 0
                                ? "text-orange-400"
                                : "text-green-400"
                            }
                          >
                            {u.fraud_rate}%
                          </span>
                        </td>
                        <td className="px-6 py-4">
                          {u.id === user?.id ? (
                            <span className="text-gray-500 text-sm">You</span>
                          ) : u.role === "user" ? (
                            <button
                              onClick={() => changeRole(u.id, "admin")}
                              className="bg-blue-600 hover:bg-blue-700 text-white px-3 py-1.5 rounded text-sm transition-colors"
                            >
                              Promote
                            </button>
                          ) : (
                            <button
                              onClick={() => changeRole(u.id, "user")}
                              className="bg-gray-600 hover:bg-gray-700 text-white px-3 py-1.5 rounded text-sm transition-colors"
                            >
                              Demote
                            </button>
                          )}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

      {activeTab === "rules" && (
        <div className="bg-[#111820] border border-white/10 rounded-xl">
          <div className="p-6 border-b border-white/10 flex items-center gap-2 flex-wrap">
            <ShieldAlert size={18} className="text-purple-400" />
            <h2 className="text-lg font-semibold text-white">Fraud Rules</h2>
            <span className="text-gray-500 text-sm">
              — admin-editable blacklists and amount cap, takes effect on the
              next transaction scored
            </span>
            <button
              onClick={() => {
                setShowRuleForm((v) => !v);
                setRuleFormError("");
                setPreview(null);
                setPreviewError("");
              }}
              className="ml-auto flex items-center gap-2 bg-purple-600 hover:bg-purple-700 text-white px-3 py-1.5 rounded-lg text-sm transition-colors"
            >
              {showRuleForm ? <X size={14} /> : <Plus size={14} />}{" "}
              {showRuleForm ? "Cancel" : "Add Rule"}
            </button>
          </div>

          {showRuleForm && (
            <form
              onSubmit={submitRuleForm}
              className="p-6 border-b border-white/10 bg-black/20"
            >
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-4">
                <div>
                  <label className="block text-xs text-gray-400 mb-1">
                    Rule Type
                  </label>
                  <select
                    value={ruleForm.rule_type}
                    onChange={(e) =>
                      updateRuleForm({ rule_type: e.target.value })
                    }
                    className="w-full bg-[#0a0f14] border border-white/20 rounded-lg px-3 py-2 text-sm text-white"
                  >
                    {RULE_TYPES.map((t) => (
                      <option key={t} value={t}>
                        {RULE_TYPE_LABEL[t]}
                      </option>
                    ))}
                  </select>
                </div>
                {ruleForm.rule_type === "amount_cap" ? (
                  <div>
                    <label className="block text-xs text-gray-400 mb-1">
                      Threshold ($)
                    </label>
                    <input
                      type="number"
                      step="0.01"
                      min="0.01"
                      required
                      value={ruleForm.threshold}
                      onChange={(e) =>
                        updateRuleForm({ threshold: e.target.value })
                      }
                      placeholder="10000"
                      className="w-full bg-[#0a0f14] border border-white/20 rounded-lg px-3 py-2 text-sm text-white"
                    />
                  </div>
                ) : (
                  <div>
                    <label className="block text-xs text-gray-400 mb-1">
                      Value
                    </label>
                    <input
                      type="text"
                      required
                      maxLength={255}
                      value={ruleForm.value}
                      onChange={(e) =>
                        updateRuleForm({ value: e.target.value })
                      }
                      placeholder={
                        ruleForm.rule_type === "blacklist_ip"
                          ? "203.0.113.5"
                          : ruleForm.rule_type === "blacklist_device"
                            ? "device fingerprint hash"
                            : "exact match text"
                      }
                      className="w-full bg-[#0a0f14] border border-white/20 rounded-lg px-3 py-2 text-sm text-white"
                    />
                  </div>
                )}
              </div>
              <div className="mb-4">
                <label className="block text-xs text-gray-400 mb-1">
                  Reason (optional)
                </label>
                <input
                  type="text"
                  maxLength={500}
                  value={ruleForm.reason}
                  onChange={(e) => updateRuleForm({ reason: e.target.value })}
                  placeholder="Why this rule exists"
                  className="w-full bg-[#0a0f14] border border-white/20 rounded-lg px-3 py-2 text-sm text-white"
                />
              </div>

              {previewError && (
                <p className="text-red-400 text-xs mb-3">{previewError}</p>
              )}
              {preview && (
                <div
                  className={`mb-4 rounded-lg p-3 border ${preview.matched_count > 0 ? "bg-yellow-500/10 border-yellow-500/30" : "bg-green-500/10 border-green-500/30"}`}
                >
                  <p
                    className={`text-sm font-medium ${preview.matched_count > 0 ? "text-yellow-300" : "text-green-400"}`}
                  >
                    {preview.matched_count === 0
                      ? "This rule would not have matched any transaction on file."
                      : `This rule would have matched ${preview.matched_count} transaction${preview.matched_count === 1 ? "" : "s"} on file.`}
                  </p>
                  {preview.sample.length > 0 && (
                    <ul className="mt-2 space-y-1">
                      {preview.sample.map((t) => (
                        <li key={t.id} className="text-xs text-gray-400">
                          #{t.id} — {t.merchant} — $
                          {Number(t.amount).toFixed(2)} —{" "}
                          {new Date(t.created_at).toLocaleDateString()}
                        </li>
                      ))}
                    </ul>
                  )}
                  {preview.matched_count > preview.sample.length && (
                    <p className="text-xs text-gray-500 mt-1">
                      Showing the {preview.sample.length} most recent matches.
                    </p>
                  )}
                </div>
              )}

              {ruleFormError && (
                <p className="text-red-400 text-xs mb-3">{ruleFormError}</p>
              )}
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={previewRuleImpact}
                  disabled={
                    previewLoading ||
                    (ruleForm.rule_type === "amount_cap"
                      ? !ruleForm.threshold
                      : !ruleForm.value)
                  }
                  className="flex items-center gap-2 bg-white/5 hover:bg-white/10 disabled:opacity-40 text-gray-200 px-4 py-2 rounded-lg text-sm transition-colors"
                >
                  <Eye size={14} />{" "}
                  {previewLoading ? "Checking..." : "Preview Impact"}
                </button>
                <button
                  type="submit"
                  disabled={ruleFormBusy}
                  className="bg-purple-600 hover:bg-purple-700 disabled:opacity-50 text-white px-4 py-2 rounded-lg text-sm transition-colors"
                >
                  {ruleFormBusy ? "Creating..." : "Create Rule"}
                </button>
              </div>
            </form>
          )}

          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-white/10 text-gray-400 text-sm">
                  <th className="text-left px-6 py-3">Type</th>
                  <th className="text-left px-6 py-3">Value / Threshold</th>
                  <th className="text-left px-6 py-3">Reason</th>
                  <th className="text-left px-6 py-3">Updated By</th>
                  <th className="text-left px-6 py-3">Status</th>
                  <th className="text-left px-6 py-3">Actions</th>
                </tr>
              </thead>
              <tbody>
                {fraudRules.length === 0 ? (
                  <tr>
                    <td
                      colSpan={6}
                      className="px-6 py-8 text-center text-gray-500"
                    >
                      No fraud rules configured
                    </td>
                  </tr>
                ) : (
                  fraudRules.map((rule) => (
                    <React.Fragment key={rule.id}>
                      <tr className="border-b border-white/5 hover:bg-white/5 transition-colors">
                        <td className="px-6 py-3 text-white text-sm">
                          {RULE_TYPE_LABEL[rule.rule_type] || rule.rule_type}
                        </td>
                        <td className="px-6 py-3 text-gray-300 text-sm font-mono">
                          {rule.rule_type === "amount_cap"
                            ? `$${Number(rule.threshold).toLocaleString()}`
                            : rule.value}
                        </td>
                        <td className="px-6 py-3 text-gray-400 text-sm max-w-xs truncate">
                          {rule.reason || "—"}
                        </td>
                        <td className="px-6 py-3 text-gray-400 text-sm">
                          {rule.updated_by_username || "—"}
                        </td>
                        <td className="px-6 py-3">
                          <span
                            className={`px-2 py-0.5 rounded text-xs font-semibold ${rule.enabled ? "bg-green-500/20 text-green-400" : "bg-gray-500/20 text-gray-400"}`}
                          >
                            {rule.enabled ? "Enabled" : "Disabled"}
                          </span>
                        </td>
                        <td className="px-6 py-3">
                          <div className="flex items-center gap-2">
                            <button
                              onClick={() =>
                                editingRuleId === rule.id
                                  ? setEditingRuleId(null)
                                  : startEditingRule(rule)
                              }
                              disabled={ruleBusyId === rule.id}
                              className="text-gray-400 hover:text-white disabled:opacity-50 transition-colors"
                              title="Edit value/threshold/reason"
                            >
                              <Pencil size={14} />
                            </button>
                            <button
                              onClick={() => toggleRuleEnabled(rule)}
                              disabled={ruleBusyId === rule.id}
                              className="text-gray-400 hover:text-white disabled:opacity-50 transition-colors"
                              title={rule.enabled ? "Disable" : "Enable"}
                            >
                              {rule.enabled ? (
                                <ShieldOff size={14} />
                              ) : (
                                <ShieldCheck size={14} />
                              )}
                            </button>
                            <button
                              onClick={() => deleteRule(rule)}
                              disabled={ruleBusyId === rule.id}
                              className="text-gray-400 hover:text-red-400 disabled:opacity-50 transition-colors"
                              title="Delete permanently"
                            >
                              <Trash2 size={14} />
                            </button>
                          </div>
                        </td>
                      </tr>
                      {editingRuleId === rule.id && (
                        <tr className="border-b border-white/5 bg-black/20">
                          <td colSpan={6} className="px-6 py-4">
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-3">
                              {rule.rule_type === "amount_cap" ? (
                                <div>
                                  <label className="block text-xs text-gray-400 mb-1">
                                    Threshold ($)
                                  </label>
                                  <input
                                    type="number"
                                    step="0.01"
                                    min="0.01"
                                    required
                                    value={editRuleForm.threshold}
                                    onChange={(e) =>
                                      setEditRuleForm((f) => ({
                                        ...f,
                                        threshold: e.target.value,
                                      }))
                                    }
                                    className="w-full bg-[#0a0f14] border border-white/20 rounded-lg px-3 py-2 text-sm text-white"
                                  />
                                </div>
                              ) : (
                                <div>
                                  <label className="block text-xs text-gray-400 mb-1">
                                    Value
                                  </label>
                                  <input
                                    type="text"
                                    required
                                    maxLength={255}
                                    value={editRuleForm.value}
                                    onChange={(e) =>
                                      setEditRuleForm((f) => ({
                                        ...f,
                                        value: e.target.value,
                                      }))
                                    }
                                    className="w-full bg-[#0a0f14] border border-white/20 rounded-lg px-3 py-2 text-sm text-white"
                                  />
                                </div>
                              )}
                              <div>
                                <label className="block text-xs text-gray-400 mb-1">
                                  Reason
                                </label>
                                <input
                                  type="text"
                                  maxLength={500}
                                  value={editRuleForm.reason}
                                  onChange={(e) =>
                                    setEditRuleForm((f) => ({
                                      ...f,
                                      reason: e.target.value,
                                    }))
                                  }
                                  className="w-full bg-[#0a0f14] border border-white/20 rounded-lg px-3 py-2 text-sm text-white"
                                />
                              </div>
                            </div>
                            {editRuleError && (
                              <p className="text-red-400 text-xs mb-3">
                                {editRuleError}
                              </p>
                            )}
                            <div className="flex items-center gap-2">
                              <button
                                onClick={() => submitEditRule(rule)}
                                disabled={editRuleBusy}
                                className="bg-purple-600 hover:bg-purple-700 disabled:opacity-50 text-white px-4 py-2 rounded-lg text-sm transition-colors"
                              >
                                {editRuleBusy ? "Saving..." : "Save Changes"}
                              </button>
                              <button
                                onClick={() => setEditingRuleId(null)}
                                className="text-gray-400 hover:text-white text-sm px-3 py-2 transition-colors"
                              >
                                Cancel
                              </button>
                            </div>
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {activeTab === "rings" && (
        <div className="bg-[#111820] border border-white/10 rounded-xl">
          <div className="p-6 border-b border-white/10">
            <div className="flex items-center gap-2">
              <Network size={18} className="text-purple-400" />
              <h2 className="text-lg font-semibold text-white">Fraud Rings</h2>
            </div>
            <p className="text-gray-500 text-sm mt-0.5">
              Clusters of accounts linked by a shared device fingerprint or IP
              address — catches coordinated activity a single-transaction check
              would miss.
            </p>
          </div>
          {fraudRings.length === 0 ? (
            <p className="px-6 py-8 text-center text-gray-500">
              No clusters of 2+ accounts detected
            </p>
          ) : (
            <div className="divide-y divide-white/5">
              {fraudRings.map((ring) => (
                <div key={ring.ring_id} className="p-6">
                  <div className="flex flex-wrap items-center gap-2 mb-2">
                    <span
                      className={`text-[10px] font-semibold uppercase px-2 py-0.5 rounded-full ${RING_RISK_STYLE[ring.risk]}`}
                    >
                      {ring.risk} risk
                    </span>
                    <span className="text-white text-sm font-medium">
                      {ring.size} accounts
                    </span>
                    <span className="text-gray-500 text-xs">
                      {ring.shared_device_count} shared device(s) &middot;{" "}
                      {ring.shared_ip_count} shared IP(s)
                    </span>
                  </div>
                  <div className="flex flex-wrap gap-1.5 mb-2">
                    {ring.members.map((m) => (
                      <span
                        key={m.user_id}
                        className={`text-xs px-2 py-0.5 rounded-full ${
                          ring.confirmed_fraud_members.includes(m.username)
                            ? "bg-red-500/15 text-red-400"
                            : "bg-white/5 text-gray-300"
                        }`}
                      >
                        {m.username}
                      </span>
                    ))}
                  </div>
                  {ring.confirmed_fraud_members.length > 0 && (
                    <p className="text-red-400 text-xs">
                      Includes confirmed-fraud account(s):{" "}
                      {ring.confirmed_fraud_members.join(", ")}
                    </p>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {activeTab === "policy" && <RiskPolicyPanel onMessage={showMessage} />}
      {activeTab === "modelchanges" && (
        <ModelChangesPanel onMessage={showMessage} />
      )}

      {activeTab === "mlops" && (
        <div className="space-y-6">
          {mlLoading ? (
            <div className="bg-[#111820] border border-white/10 rounded-xl">
              <LoadingState label="Loading model ops..." />
            </div>
          ) : mlError ? (
            <div className="bg-[#111820] border border-white/10 rounded-xl">
              <ErrorState message={mlError} onRetry={loadMlOps} />
            </div>
          ) : (
            <>
              <div className="bg-[#111820] border border-white/10 rounded-xl">
                <div className="p-6 border-b border-white/10 flex items-center gap-2 flex-wrap">
                  <Cpu size={18} className="text-purple-400" />
                  <h2 className="text-lg font-semibold text-white">
                    Model Registry
                  </h2>
                  <button
                    onClick={loadMlOps}
                    className="ml-auto flex items-center gap-2 bg-white/5 hover:bg-white/10 text-gray-300 px-3 py-1.5 rounded-lg text-sm transition-colors"
                  >
                    <RefreshCw size={14} /> Refresh
                  </button>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full">
                    <thead>
                      <tr className="border-b border-white/10 text-gray-400 text-sm">
                        <th className="text-left px-6 py-3">Version</th>
                        <th className="text-left px-6 py-3">Model Type</th>
                        <th
                          className="text-left px-6 py-3"
                          title="Measured on held-out SYNTHETIC data (chronological split). Not a measure of accuracy on real traffic."
                        >
                          PR-AUC (synthetic data)
                        </th>
                        <th className="text-left px-6 py-3">Trained</th>
                        <th className="text-left px-6 py-3">Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {mlVersions.length === 0 ? (
                        <tr>
                          <td
                            colSpan={5}
                            className="px-6 py-8 text-center text-gray-500"
                          >
                            No trained versions in the registry
                          </td>
                        </tr>
                      ) : (
                        mlVersions.map((v) => (
                          <tr
                            key={v.version}
                            className="border-b border-white/5 hover:bg-white/5 transition-colors"
                          >
                            <td className="px-6 py-3 text-white font-mono text-sm">
                              {v.version}
                            </td>
                            <td className="px-6 py-3 text-gray-300 text-sm">
                              {v.best_model_type}
                            </td>
                            <td className="px-6 py-3 text-gray-300 text-sm">
                              {v.pr_auc}
                            </td>
                            <td className="px-6 py-3 text-gray-400 text-sm">
                              {v.trained_at
                                ? new Date(v.trained_at).toLocaleDateString()
                                : "—"}
                            </td>
                            <td className="px-6 py-3">
                              {v.version === mlActiveVersion && (
                                <span className="px-2 py-0.5 rounded text-xs font-semibold bg-purple-600 text-white">
                                  Active
                                </span>
                              )}
                              {v.version === mlShadow?.shadow_version && (
                                <span className="ml-1 px-2 py-0.5 rounded text-xs font-semibold bg-blue-500/20 text-blue-400">
                                  Shadow
                                </span>
                              )}
                            </td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              </div>

              <div className="bg-[#111820] border border-white/10 rounded-xl p-6">
                <div className="flex items-center gap-2 mb-4 flex-wrap">
                  <h2 className="text-lg font-semibold text-white">
                    Drift Monitoring
                  </h2>
                  {mlDrift?.status && (
                    <span
                      className={`text-[10px] font-semibold uppercase px-2 py-0.5 rounded-full ${DRIFT_STATUS_STYLE[mlDrift.status]}`}
                    >
                      {mlDrift.status.replace("_", " ")}
                    </span>
                  )}
                  <button
                    onClick={resetDrift}
                    disabled={mlBusy === "reset-drift"}
                    className="ml-auto flex items-center gap-2 bg-white/5 hover:bg-white/10 disabled:opacity-50 text-gray-300 px-3 py-1.5 rounded-lg text-sm transition-colors"
                  >
                    {mlBusy === "reset-drift" ? "Resetting..." : "Reset Buffer"}
                  </button>
                </div>
                {mlDrift?.status === "insufficient_data" ? (
                  <p className="text-gray-400 text-sm">
                    Not enough live traffic yet ({mlDrift.n_samples} of{" "}
                    {mlDrift.min_required} samples needed) — the active model
                    version ({mlDrift.version}) hasn't scored enough recent
                    transactions to compare.
                  </p>
                ) : mlDrift ? (
                  <>
                    <p className="text-gray-400 text-sm mb-3">
                      {mlDrift.n_samples} live samples compared against training
                      baseline (version {mlDrift.version})
                    </p>
                    {Object.keys(mlDrift.flagged_features || {}).length > 0 ? (
                      <div className="mb-3">
                        <p className="text-gray-300 text-sm font-medium mb-1">
                          Flagged features (PSI):
                        </p>
                        <div className="flex flex-wrap gap-1.5">
                          {Object.entries(mlDrift.flagged_features).map(
                            ([feature, psi]) => (
                              <span
                                key={feature}
                                className="text-xs px-2 py-0.5 rounded-full bg-yellow-500/15 text-yellow-400 font-mono"
                              >
                                {feature}: {psi}
                              </span>
                            ),
                          )}
                        </div>
                      </div>
                    ) : (
                      <p className="text-green-400 text-sm mb-3">
                        No features show meaningful drift.
                      </p>
                    )}
                    {mlDrift.score_drift && (
                      <div className="grid grid-cols-2 gap-3 text-sm">
                        <div className="bg-black/20 rounded-lg p-3">
                          <p className="text-gray-500 text-xs mb-1">
                            Mean Fraud Score
                          </p>
                          <p className="text-white">
                            {mlDrift.score_drift.baseline_mean_score} →{" "}
                            {mlDrift.score_drift.live_mean_score}
                          </p>
                        </div>
                        <div className="bg-black/20 rounded-lg p-3">
                          <p className="text-gray-500 text-xs mb-1">
                            High-Risk Rate
                          </p>
                          <p className="text-white">
                            {(
                              mlDrift.score_drift.baseline_high_risk_rate * 100
                            ).toFixed(1)}
                            % →{" "}
                            {(
                              mlDrift.score_drift.live_high_risk_rate * 100
                            ).toFixed(1)}
                            %
                          </p>
                        </div>
                      </div>
                    )}
                  </>
                ) : (
                  <p className="text-gray-500 text-sm">
                    No drift data available.
                  </p>
                )}
              </div>

              <div className="bg-[#111820] border border-white/10 rounded-xl p-6">
                <h2 className="text-lg font-semibold text-white mb-4">
                  Shadow / Canary Deployment
                </h2>
                {mlShadow?.active ? (
                  <div>
                    <p className="text-gray-300 text-sm mb-3">
                      Shadow version{" "}
                      <span className="font-mono text-white">
                        {mlShadow.shadow_version}
                      </span>{" "}
                      ({mlShadow.shadow_model_type}) is scoring every live
                      transaction alongside primary{" "}
                      <span className="font-mono text-white">
                        {mlShadow.primary_version}
                      </span>{" "}
                      ({mlShadow.primary_model_type}), compared on{" "}
                      {mlShadow.n_compared} transaction(s) so far.
                    </p>
                    {mlShadow.n_compared > 0 && (
                      <div className="grid grid-cols-3 gap-3 text-sm mb-4">
                        <div className="bg-black/20 rounded-lg p-3">
                          <p className="text-gray-500 text-xs mb-1">
                            Risk-Level Agreement
                          </p>
                          <p className="text-white">
                            {(mlShadow.risk_level_agreement_rate * 100).toFixed(
                              1,
                            )}
                            %
                          </p>
                        </div>
                        <div className="bg-black/20 rounded-lg p-3">
                          <p className="text-gray-500 text-xs mb-1">
                            Mean Score Diff
                          </p>
                          <p className="text-white">
                            {mlShadow.mean_absolute_score_diff}
                          </p>
                        </div>
                        <div className="bg-black/20 rounded-lg p-3">
                          <p className="text-gray-500 text-xs mb-1">
                            Shadow Scored Higher
                          </p>
                          <p className="text-white">
                            {(mlShadow.pct_shadow_scored_higher * 100).toFixed(
                              1,
                            )}
                            %
                          </p>
                        </div>
                      </div>
                    )}
                    <p className="text-xs text-gray-500 mb-3">
                      Agreement with the primary model shows the two behave
                      alike, not that the shadow model is more accurate.
                      Promotion is judged on gates, a labelled comparison and
                      confirmed outcomes, and needs a second admin&apos;s
                      approval.
                    </p>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => setActiveTab("modelchanges")}
                        className="bg-green-600 hover:bg-green-700 text-white px-4 py-2 rounded-lg text-sm transition-colors"
                      >
                        Request promotion…
                      </button>
                      <button
                        onClick={clearShadow}
                        disabled={mlBusy === "clear-shadow"}
                        className="bg-white/5 hover:bg-white/10 disabled:opacity-50 text-gray-300 px-4 py-2 rounded-lg text-sm transition-colors"
                      >
                        {mlBusy === "clear-shadow" ? "Clearing..." : "Clear"}
                      </button>
                    </div>
                  </div>
                ) : (
                  <form
                    onSubmit={setShadow}
                    className="flex flex-wrap items-end gap-3"
                  >
                    <div>
                      <label className="block text-xs text-gray-400 mb-1">
                        Registry version to shadow-score (e.g. v2)
                      </label>
                      <input
                        type="text"
                        required
                        pattern="v\d+"
                        title="e.g. v1, v2"
                        value={shadowVersionInput}
                        onChange={(e) => setShadowVersionInput(e.target.value)}
                        placeholder="v2"
                        className="bg-[#0a0f14] border border-white/20 rounded-lg px-3 py-2 text-sm text-white font-mono w-32"
                      />
                    </div>
                    <button
                      type="submit"
                      disabled={mlBusy === "set-shadow"}
                      className="bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white px-4 py-2 rounded-lg text-sm transition-colors"
                    >
                      {mlBusy === "set-shadow"
                        ? "Starting..."
                        : "Start Shadow Scoring"}
                    </button>
                  </form>
                )}
              </div>
            </>
          )}
        </div>
      )}

      {activeTab === "integrations" && (
        <div className="bg-[#111820] border border-white/10 rounded-xl">
          <div className="p-6 border-b border-white/10">
            <h2 className="text-lg font-semibold text-white">Integrations</h2>
            <p className="text-gray-500 text-sm mt-0.5">
              Every user's API keys and webhooks — self-service on their own
              Settings page, visible here for oversight.
            </p>
          </div>
          <div className="grid grid-cols-1 lg:grid-cols-2 divide-y lg:divide-y-0 lg:divide-x divide-white/5">
            <div>
              <div className="px-6 py-3 flex items-center gap-2 text-gray-300 text-sm font-medium border-b border-white/5">
                <Code2 size={14} /> API Keys
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <tbody>
                    {apiKeys.length === 0 ? (
                      <tr>
                        <td className="px-6 py-6 text-center text-gray-500">
                          No API keys
                        </td>
                      </tr>
                    ) : (
                      apiKeys.map((k) => (
                        <tr
                          key={k.id}
                          className="border-b border-white/5 last:border-0 hover:bg-white/5 transition-colors"
                        >
                          <td className="px-6 py-3">
                            <p className="text-white">{k.name}</p>
                            <p className="text-gray-500 text-xs">
                              <code>{k.key_prefix}...</code> &middot;{" "}
                              {k.username}
                            </p>
                          </td>
                          <td className="px-6 py-3 text-right">
                            {k.revoked_at ? (
                              <span className="text-gray-500 text-xs">
                                Revoked
                              </span>
                            ) : (
                              <button
                                onClick={() => revokeApiKey(k.id)}
                                className="text-gray-400 hover:text-red-400 transition-colors"
                                title="Revoke"
                              >
                                <Trash2 size={14} />
                              </button>
                            )}
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
            <div>
              <div className="px-6 py-3 flex items-center gap-2 text-gray-300 text-sm font-medium border-b border-white/5">
                <Webhook size={14} /> Webhooks
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <tbody>
                    {webhooks.length === 0 ? (
                      <tr>
                        <td className="px-6 py-6 text-center text-gray-500">
                          No webhooks
                        </td>
                      </tr>
                    ) : (
                      webhooks.map((w) => (
                        <tr
                          key={w.id}
                          className="border-b border-white/5 last:border-0 hover:bg-white/5 transition-colors"
                        >
                          <td className="px-6 py-3 min-w-0">
                            <p className="text-white truncate">{w.url}</p>
                            <p className="text-gray-500 text-xs">
                              {w.username} &middot;{" "}
                              {w.active ? (
                                <span className="text-green-400">active</span>
                              ) : (
                                <span className="text-gray-500">paused</span>
                              )}
                            </p>
                          </td>
                          <td className="px-6 py-3 text-right shrink-0">
                            <button
                              onClick={() => toggleWebhookActive(w)}
                              className="text-gray-400 hover:text-white transition-colors"
                              title={w.active ? "Pause" : "Activate"}
                            >
                              {w.active ? (
                                <ShieldOff size={14} />
                              ) : (
                                <ShieldCheck size={14} />
                              )}
                            </button>
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </div>
      )}

      {activeTab === "audit" && (
        <div className="bg-[#111820] border border-white/10 rounded-xl">
          <div className="p-6 border-b border-white/10 flex items-center gap-2 flex-wrap">
            <ScrollText size={18} className="text-purple-400" />
            <h2 className="text-lg font-semibold text-white">Audit Trail</h2>
            <span className="text-gray-500 text-sm">
              — who did what, and when
            </span>
            <button
              onClick={exportAuditLog}
              disabled={exportingAudit}
              className="ml-auto flex items-center gap-2 bg-white/5 hover:bg-white/10 disabled:opacity-50 text-gray-300 px-3 py-1.5 rounded-lg text-sm transition-colors"
            >
              <Download size={14} />{" "}
              {exportingAudit ? "Exporting..." : "Export CSV"}
            </button>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-white/10 text-gray-400 text-sm">
                  <th className="text-left px-6 py-3">When</th>
                  <th className="text-left px-6 py-3">Actor</th>
                  <th className="text-left px-6 py-3">Action</th>
                  <th className="text-left px-6 py-3">Target</th>
                  <th className="text-left px-6 py-3">Outcome</th>
                  <th className="text-left px-6 py-3">Details</th>
                </tr>
              </thead>
              <tbody>
                {auditLogs.length === 0 ? (
                  <tr>
                    <td
                      colSpan={6}
                      className="px-6 py-8 text-center text-gray-500"
                    >
                      No audit events yet
                    </td>
                  </tr>
                ) : (
                  auditLogs.map((log) => (
                    <tr
                      key={log.id}
                      className="border-b border-white/5 hover:bg-white/5 transition-colors"
                    >
                      <td className="px-6 py-3 text-gray-400 text-sm whitespace-nowrap">
                        {new Date(log.created_at).toLocaleString()}
                      </td>
                      <td className="px-6 py-3 text-white text-sm">
                        {log.username || "unknown"}
                      </td>
                      <td className="px-6 py-3 text-gray-300 text-sm font-mono">
                        {log.action}
                      </td>
                      <td className="px-6 py-3 text-gray-400 text-sm">
                        {log.target_type
                          ? `${log.target_type} #${log.target_id}`
                          : "—"}
                      </td>
                      <td className="px-6 py-3">
                        <span
                          className={`px-2 py-0.5 rounded text-xs font-semibold ${
                            log.outcome === "success"
                              ? "bg-green-500/20 text-green-400"
                              : log.outcome === "denied"
                                ? "bg-red-500/20 text-red-400"
                                : "bg-yellow-500/20 text-yellow-400"
                          }`}
                        >
                          {log.outcome}
                        </span>
                      </td>
                      <td className="px-6 py-3 text-gray-500 text-xs font-mono max-w-xs truncate">
                        {Object.keys(log.details || {}).length
                          ? JSON.stringify(log.details)
                          : ""}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
