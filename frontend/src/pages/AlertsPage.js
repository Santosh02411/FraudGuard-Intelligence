import React, { useState, useEffect, useRef } from 'react';
import { api } from '../context/AuthContext';
import { useAuth } from '../context/AuthContext';
import { useSocket } from '../context/SocketContext';
import { Link } from 'react-router-dom';
import {
  AlertTriangle, CheckCircle, XCircle, RefreshCw, ChevronLeft, ChevronRight,
  Wifi, WifiOff, UserPlus, UserMinus, Filter, X, Download, Square, CheckSquare, FileText,
  Lightbulb, History, Briefcase, Clock, Lock,
} from 'lucide-react';
import { LoadingState, ErrorState, EmptyState } from '../components/ui/States';
import { downloadBlobResponse } from '../utils/download';
import PageHeading from '../components/ui/PageHeading';
import DotBadge from '../components/ui/DotBadge';
import CasePanel from '../components/alerts/CasePanel';
import CaseMetrics from '../components/alerts/CaseMetrics';
import CreateCaseButton from '../components/cases/CreateCaseButton';
import { REASON_LABEL, SEVERITY_STYLE, errorCode } from '../components/alerts/caseConstants';

const PAGE_SIZE = 20;
const EMPTY_FILTERS = { status: '', riskLevel: '', merchant: '', severity: '', overdue: '', sort: '' };

const STATUS_LABEL = { open: 'Open', in_review: 'In Review', escalated: 'Escalated', pending_info: 'Waiting for info', resolved: 'Resolved' };
const STATUS_STYLE = {
  open: 'bg-red-500/15 text-red-400',
  in_review: 'bg-blue-500/15 text-blue-400',
  escalated: 'bg-orange-500/15 text-orange-400',
  pending_info: 'bg-yellow-500/15 text-yellow-400',
  resolved: 'bg-gray-500/15 text-gray-400',
};
const STATUS_DOT = {
  open: 'bg-red-400',
  in_review: 'bg-blue-400',
  escalated: 'bg-orange-400',
  pending_info: 'bg-yellow-400',
  resolved: 'bg-gray-400',
};
const VERDICT_LABEL = { confirmed_fraud: 'Confirmed Fraud', false_positive: 'False Positive' };

function StatusBadge({ status }) {
  return (
    <DotBadge label={STATUS_LABEL[status]} colorClass={STATUS_STYLE[status]} dotClass={STATUS_DOT[status]} />
  );
}

export default function AlertsPage() {
  const { user } = useAuth();
  const { socket, connected, resyncToken } = useSocket();
  const [alerts, setAlerts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [pageInfo, setPageInfo] = useState(null);
  const [error, setError] = useState('');
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const [showFilters, setShowFilters] = useState(false);

  // Inline "resolve with verdict" form state — only one alert's form is
  // open at a time, tracked by id.
  const [resolvingId, setResolvingId] = useState(null);
  const [note, setNote] = useState('');
  const [resolveError, setResolveError] = useState('');
  const [openCaseId, setOpenCaseId] = useState(null);
  const [resolveReason, setResolveReason] = useState('');
  const [amounts, setAmounts] = useState({ loss: '', recovered: '', prevented: '' });
  const [busyId, setBusyId] = useState(null); // alert currently mid-request (resolve/assign)

  // Bulk actions (feature: bulk resolve) — a Set of selected alert ids,
  // scoped to the current page only (matches what's actually visible to
  // check/uncheck; selection intentionally does not persist across a
  // page change, since "select everything across every page" is a
  // different, riskier action than this UI offers).
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [bulkNote, setBulkNote] = useState('');
  const [bulkError, setBulkError] = useState('');
  const [bulkBusy, setBulkBusy] = useState(false);
  const [exporting, setExporting] = useState(false);

  // SAR-style compliance report export (feature: SAR-style exportable
  // reports — admin only). Only one alert's format menu is open at a
  // time, same pattern as resolvingId above.
  const [sarMenuId, setSarMenuId] = useState(null);
  const [sarBusyId, setSarBusyId] = useState(null);

  // Plain-language explanation (feature: LLM-generated plain-language
  // explanations) — one sentence per alert, fetched on demand and cached
  // both server-side (on the transaction row) and here (so re-toggling
  // open/closed doesn't re-fetch).
  const [explanations, setExplanations] = useState({}); // id -> text
  const [explainBusyId, setExplainBusyId] = useState(null);
  const [explainError, setExplainError] = useState({}); // id -> message
  const [openExplanationId, setOpenExplanationId] = useState(null);

  // Per-alert audit trail (admin only) — who viewed/assigned/resolved
  // this specific alert, and when.
  const [auditTrails, setAuditTrails] = useState({}); // id -> logs[]
  const [auditBusyId, setAuditBusyId] = useState(null);
  const [openAuditId, setOpenAuditId] = useState(null);

  const alertsRef = useRef([]);
  useEffect(() => { alertsRef.current = alerts; }, [alerts]);

  const loadAlerts = (targetPage = page, activeFilters = filters) => {
    setLoading(true);
    setError('');
    setSelectedIds(new Set());
    const params = { page: targetPage, limit: PAGE_SIZE };
    if (activeFilters.status) params.status = activeFilters.status;
    if (activeFilters.riskLevel) params.riskLevel = activeFilters.riskLevel;
    if (activeFilters.merchant) params.merchant = activeFilters.merchant;
    if (activeFilters.severity) params.severity = activeFilters.severity;
    if (activeFilters.overdue) params.overdue = 'true';
    if (activeFilters.sort) params.sort = activeFilters.sort;
    api.get('/alerts', { params })
      .then(res => {
        setAlerts(res.data.alerts);
        setPageInfo(res.data.pagination);
        setPage(targetPage);
      })
      .catch((err) => setError(err.response?.data?.error || 'Failed to load alerts'))
      .finally(() => setLoading(false));
  };

  useEffect(() => { loadAlerts(1, EMPTY_FILTERS); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Pushed the moment the backend creates an alert (see
  // realtime/socketServer.js) — no polling/refresh-button needed to see
  // it. Only the first page's list is spliced live; other pages just
  // get their total count bumped so paging math stays correct.
  useEffect(() => {
    if (!socket) return;
    const onAlert = ({ alert }) => {
      setPageInfo(prev => prev ? { ...prev, total: prev.total + 1, total_pages: Math.ceil((prev.total + 1) / PAGE_SIZE) } : prev);
      if (page === 1 && !filters.status && !filters.riskLevel && !filters.merchant) {
        setAlerts(prev => [alert, ...prev.filter(a => a.id !== alert.id)].slice(0, PAGE_SIZE));
      }
    };
    socket.on('alert:new', onAlert);
    // Case events (claims, escalations, status...) are admin-only: refresh just that row.
    const onCase = (evt) => {
      if (!alertsRef.current.some(a => a.id === evt.alert_id)) return;
      api.get(`/alerts/${evt.alert_id}`).then(r => setAlerts(prev => prev.map(a => (a.id === evt.alert_id ? { ...a, ...r.data.alert } : a)))).catch(() => {});
    };
    socket.on('alert:updated', onCase);
    return () => { socket.off('alert:new', onAlert); socket.off('alert:updated', onCase); };
  }, [socket, page, filters]);

  // The event log lost part of the history while we were offline: reload instead of trusting a partial replay.
  useEffect(() => { if (resyncToken > 0) loadAlerts(page, filters); }, [resyncToken]); // eslint-disable-line react-hooks/exhaustive-deps

  const applyFilters = (e) => {
    e.preventDefault();
    loadAlerts(1, filters);
  };

  const clearFilters = () => {
    setFilters(EMPTY_FILTERS);
    loadAlerts(1, EMPTY_FILTERS);
  };

  const startResolving = (id) => {
    setResolvingId(id);
    setNote('');
    setResolveReason('');
    setAmounts({ loss: '', recovered: '', prevented: '' });
    setResolveError('');
  };

  const submitResolve = async (id, verdict) => {
    setBusyId(id);
    setResolveError('');
    try {
      const current = alerts.find(a => a.id === id);
      const body = { verdict, note: note || undefined, reason: resolveReason || undefined, version: current?.version };
      if (user?.role === 'admin' && verdict === 'confirmed_fraud') {
        for (const [k, key] of [['loss', 'loss_amount'], ['recovered', 'recovered_amount'], ['prevented', 'prevented_amount']]) {
          if (amounts[k] !== '') body[key] = Number(amounts[k]);
        }
      }
      const { data } = await api.patch(`/alerts/${id}/resolve`, body);
      setAlerts(prev => prev.map(a => (a.id === id ? data.alert : a)));
      setResolvingId(null);
    } catch (err) {
      const conflict = err.response?.status === 409 && ['VERSION_CONFLICT', 'ALERT_LOCKED'].includes(errorCode(err));
      if (conflict) {
        // Another investigator changed this alert first: show their version, keep nothing silently overwritten.
        const latest = err.response.data.details.current;
        if (latest) setAlerts(prev => prev.map(a => (a.id === id ? latest : a)));
        setResolveError(errorCode(err) === 'ALERT_LOCKED'
          ? err.response.data.error
          : 'Someone else just updated this alert, so your change was not applied. Review the latest state and resolve again if it is still needed.');
      } else {
        setResolveError(err.response?.data?.error || 'Failed to resolve alert');
      }
    } finally {
      setBusyId(null);
    }
  };

  const toggleAssignToMe = async (alertItem) => {
    setBusyId(alertItem.id);
    try {
      const assigneeId = alertItem.assigned_to === user.id ? null : user.id;
      const { data } = await api.patch(`/alerts/${alertItem.id}/assign`, { assigneeId, version: alertItem.version });
      setAlerts(prev => prev.map(a => (a.id === alertItem.id ? data.alert : a)));
    } catch (err) {
      if (err.response?.status === 409 && err.response?.data?.details?.code === 'VERSION_CONFLICT') {
        const latest = err.response.data.details.current;
        if (latest) setAlerts(prev => prev.map(a => (a.id === alertItem.id ? latest : a)));
        setError('Someone else just updated this alert; showing the latest state.');
      } else {
        setError(err.response?.data?.error || 'Failed to update assignment');
      }
    } finally {
      setBusyId(null);
    }
  };

  // Only open/in_review alerts can be selected — a resolved one has
  // nothing left to bulk-resolve.
  const selectableAlerts = alerts.filter(a => a.status !== 'resolved');

  const toggleSelected = (id) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const allSelected = selectableAlerts.length > 0 && selectableAlerts.every(a => selectedIds.has(a.id));
  const toggleSelectAll = () => {
    setSelectedIds(allSelected ? new Set() : new Set(selectableAlerts.map(a => a.id)));
  };

  const bulkResolve = async (verdict) => {
    setBulkError('');
    setBulkBusy(true);
    try {
      const { data } = await api.patch('/alerts/bulk-resolve', { alertIds: [...selectedIds], verdict, note: bulkNote || undefined });
      setBulkNote('');
      loadAlerts(page); // also clears selection
      if (data.lockedCount) setBulkError(`${data.lockedCount} case(s) were skipped because another investigator is working on them.`);
    } catch (err) {
      setBulkError(err.response?.data?.error || 'Failed to resolve the selected alerts');
    } finally {
      setBulkBusy(false);
    }
  };

  const exportCsv = async () => {
    setExporting(true);
    try {
      const params = {};
      if (filters.status) params.status = filters.status;
      if (filters.riskLevel) params.riskLevel = filters.riskLevel;
      if (filters.merchant) params.merchant = filters.merchant;
      if (filters.severity) params.severity = filters.severity;
      if (filters.overdue) params.overdue = 'true';
      const res = await api.get('/alerts/export', { params, responseType: 'blob' });
      downloadBlobResponse(res, 'alerts.csv');
    } catch (err) {
      setError('Failed to export alerts');
    } finally {
      setExporting(false);
    }
  };

  // SAR-style compliance report (feature: SAR-style exportable reports —
  // admin only). Pulls together the transaction, why it was flagged, its
  // network/dispute status, and its full audit trail into one document —
  // NOT a completed regulatory filing (see backend/services/
  // sarReportService.js), just the internal review document a compliance
  // team would otherwise assemble by hand.
  const downloadSarReport = async (alertId, format) => {
    setSarBusyId(alertId);
    try {
      const res = await api.get(`/admin/alerts/${alertId}/sar-report`, { params: { format }, responseType: 'blob' });
      downloadBlobResponse(res, `sar-report-alert-${alertId}.${format}`);
      setSarMenuId(null);
    } catch (err) {
      setError('Failed to generate the SAR report');
    } finally {
      setSarBusyId(null);
    }
  };

  const toggleExplanation = async (alertId) => {
    if (openExplanationId === alertId) {
      setOpenExplanationId(null);
      return;
    }
    setOpenExplanationId(alertId);
    if (explanations[alertId]) return; // already fetched — cached client-side too
    setExplainBusyId(alertId);
    setExplainError(prev => ({ ...prev, [alertId]: undefined }));
    try {
      const { data } = await api.get(`/alerts/${alertId}/explanation`);
      setExplanations(prev => ({ ...prev, [alertId]: data.explanation }));
    } catch (err) {
      setExplainError(prev => ({ ...prev, [alertId]: err.response?.data?.error || 'Failed to generate an explanation' }));
    } finally {
      setExplainBusyId(null);
    }
  };

  const toggleAuditTrail = async (alertId) => {
    if (openAuditId === alertId) {
      setOpenAuditId(null);
      return;
    }
    setOpenAuditId(alertId);
    if (auditTrails[alertId]) return;
    setAuditBusyId(alertId);
    try {
      const { data } = await api.get(`/admin/audit-logs/alert/${alertId}`);
      setAuditTrails(prev => ({ ...prev, [alertId]: data.logs }));
    } catch (err) {
      // non-critical, secondary info — fail quietly with an empty list
      setAuditTrails(prev => ({ ...prev, [alertId]: [] }));
    } finally {
      setAuditBusyId(null);
    }
  };

  const activeFilterCount = Object.values(filters).filter(Boolean).length;

  return (
    <div className="p-4 sm:p-8 max-w-4xl mx-auto">
      <div className="mb-6 sm:mb-8 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <PageHeading icon={AlertTriangle} title="Fraud Alerts" subtitle="View and manage suspicious transaction alerts" />
        </div>
        <div className="flex items-center gap-3">
          <div className={`flex items-center gap-2 text-sm ${connected ? 'text-green-400' : 'text-gray-500'}`}>
            {connected ? <Wifi size={16} /> : <WifiOff size={16} />}
            {connected ? 'Live' : 'Offline'}
          </div>
          <button
            onClick={() => setShowFilters(v => !v)}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm transition-colors ${
              activeFilterCount > 0 ? 'bg-purple-600 hover:bg-purple-700 text-white' : 'bg-white/5 hover:bg-white/10 text-gray-300'
            }`}
          >
            <Filter size={16} /> Filters {activeFilterCount > 0 && `(${activeFilterCount})`}
          </button>
          <button
            onClick={exportCsv}
            disabled={exporting}
            className="flex items-center gap-2 bg-white/5 hover:bg-white/10 disabled:opacity-50 text-gray-300 px-4 py-2 rounded-lg text-sm transition-colors"
          >
            <Download size={16} /> {exporting ? 'Exporting...' : 'Export CSV'}
          </button>
          <button
            onClick={() => loadAlerts(page)}
            className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg text-sm transition-colors"
          >
            <RefreshCw size={16} className={loading ? 'animate-spin' : ''} /> Refresh
          </button>
        </div>
      </div>

      {user?.role === 'admin' && <CaseMetrics />}

      {showFilters && (
        <form onSubmit={applyFilters} className="bg-[#111820] border border-white/10 rounded-xl p-4 sm:p-5 mb-4 flex flex-wrap items-end gap-3">
          <div>
            <label className="block text-xs text-gray-400 mb-1">Status</label>
            <select
              value={filters.status}
              onChange={e => setFilters(f => ({ ...f, status: e.target.value }))}
              className="bg-[#0a0f14] border border-white/20 rounded-lg px-3 py-2 text-sm text-white"
            >
              <option value="">All</option>
              <option value="open">Open</option>
              <option value="in_review">In Review</option>
              <option value="escalated">Escalated</option>
              <option value="pending_info">Waiting for info</option>
              <option value="resolved">Resolved</option>
            </select>
          </div>
          <div>
            <label className="block text-xs text-gray-400 mb-1">Risk Level</label>
            <select
              value={filters.riskLevel}
              onChange={e => setFilters(f => ({ ...f, riskLevel: e.target.value }))}
              className="bg-[#0a0f14] border border-white/20 rounded-lg px-3 py-2 text-sm text-white"
            >
              <option value="">All</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
            </select>
          </div>
          <div>
            <label className="block text-xs text-gray-400 mb-1" htmlFor="f-severity">Severity</label>
            <select id="f-severity" value={filters.severity} onChange={e => setFilters(f => ({ ...f, severity: e.target.value }))} className="bg-[#0a0f14] border border-white/20 rounded-lg px-3 py-2 text-sm text-white">
              <option value="">All</option><option value="critical">Critical</option><option value="high">High</option><option value="medium">Medium</option><option value="low">Low</option>
            </select>
          </div>
          <label className="flex items-center gap-2 text-sm text-gray-300 pb-2">
            <input type="checkbox" checked={filters.overdue === 'true'} onChange={e => setFilters(f => ({ ...f, overdue: e.target.checked ? 'true' : '' }))} /> Overdue only
          </label>
          <label className="flex items-center gap-2 text-sm text-gray-300 pb-2">
            <input type="checkbox" checked={filters.sort === 'priority'} onChange={e => setFilters(f => ({ ...f, sort: e.target.checked ? 'priority' : '' }))} /> Work queue order (nearest deadline first)
          </label>
          <div className="flex-1 min-w-[160px]">
            <label className="block text-xs text-gray-400 mb-1">Merchant</label>
            <input
              type="text"
              value={filters.merchant}
              onChange={e => setFilters(f => ({ ...f, merchant: e.target.value }))}
              placeholder="e.g. Amazon"
              className="w-full bg-[#0a0f14] border border-white/20 rounded-lg px-3 py-2 text-sm text-white"
            />
          </div>
          <button type="submit" className="bg-purple-600 hover:bg-purple-700 text-white px-4 py-2 rounded-lg text-sm transition-colors">
            Apply
          </button>
          {activeFilterCount > 0 && (
            <button type="button" onClick={clearFilters} className="flex items-center gap-1 text-gray-400 hover:text-white text-sm px-3 py-2 transition-colors">
              <X size={14} /> Clear
            </button>
          )}
        </form>
      )}

      <div className="bg-[#111820] border border-white/10 rounded-xl">
        <div className="p-6 border-b border-white/10 flex items-center justify-between gap-4 flex-wrap">
          <h2 className="text-lg font-semibold text-white">
            Alerts
            {pageInfo && <span className="ml-2 text-gray-500 text-sm font-normal">({pageInfo.total} total)</span>}
          </h2>
          {selectableAlerts.length > 0 && (
            <button
              onClick={toggleSelectAll}
              className="flex items-center gap-2 text-sm text-gray-400 hover:text-white transition-colors"
            >
              {allSelected ? <CheckSquare size={16} className="text-purple-400" /> : <Square size={16} />}
              Select all on this page
            </button>
          )}
        </div>

        {selectedIds.size > 0 && (
          <div className="p-4 bg-purple-500/10 border-b border-purple-500/20 flex flex-col sm:flex-row sm:items-center gap-3">
            <span className="text-sm text-white font-medium shrink-0">{selectedIds.size} selected</span>
            <input
              type="text"
              value={bulkNote}
              onChange={e => setBulkNote(e.target.value)}
              placeholder="Resolution note (optional, applied to all selected)"
              maxLength={1000}
              className="flex-1 bg-[#0a0f14] border border-white/20 rounded-lg px-3 py-1.5 text-sm text-white focus:outline-none focus:border-purple-500"
            />
            <div className="flex items-center gap-2 shrink-0">
              <button
                onClick={() => bulkResolve('confirmed_fraud')}
                disabled={bulkBusy}
                className="flex items-center gap-1 bg-red-600 hover:bg-red-700 disabled:opacity-50 text-white px-3 py-1.5 rounded-lg text-sm transition-colors"
              >
                <XCircle size={14} /> Confirm Fraud
              </button>
              <button
                onClick={() => bulkResolve('false_positive')}
                disabled={bulkBusy}
                className="flex items-center gap-1 bg-green-600 hover:bg-green-700 disabled:opacity-50 text-white px-3 py-1.5 rounded-lg text-sm transition-colors"
              >
                <CheckCircle size={14} /> Mark False Positive
              </button>
              {user?.role === 'admin' && <CreateCaseButton alertIds={[...selectedIds]} label="Create case" />}
              <button
                onClick={() => setSelectedIds(new Set())}
                className="text-gray-400 hover:text-white text-sm px-2 py-1.5 transition-colors"
              >
                Clear
              </button>
            </div>
          </div>
        )}
        {bulkError && <p className="text-red-400 text-sm px-6 pt-3">{bulkError}</p>}

        {loading ? (
          <LoadingState label="Loading alerts..." />
        ) : error ? (
          <ErrorState message={error} onRetry={() => loadAlerts(page)} />
        ) : alerts.length === 0 ? (
          <EmptyState icon={CheckCircle} title="No alerts match these filters" subtitle={activeFilterCount > 0 ? 'Try clearing a filter.' : 'All clear!'} />
        ) : (
          <div className="divide-y divide-white/5">
            {alerts.map(alertItem => (
              <div key={alertItem.id} className="p-6 hover:bg-white/5 transition-colors">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                  <div className="flex items-start gap-4">
                    {alertItem.status !== 'resolved' && (
                      <button
                        onClick={() => toggleSelected(alertItem.id)}
                        className="mt-1.5 shrink-0 text-gray-500 hover:text-purple-400 transition-colors"
                        aria-label={selectedIds.has(alertItem.id) ? 'Deselect' : 'Select'}
                      >
                        {selectedIds.has(alertItem.id) ? <CheckSquare size={18} className="text-purple-400" /> : <Square size={18} />}
                      </button>
                    )}
                    <div className={`w-10 h-10 rounded-full flex items-center justify-center shrink-0 ${
                      alertItem.risk_level === 'high' ? 'bg-red-500/20' : 'bg-yellow-500/20'
                    }`}>
                      <AlertTriangle size={20} className={alertItem.risk_level === 'high' ? 'text-red-400' : 'text-yellow-400'} />
                    </div>
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2 mb-1">
                        <span className={`text-xs font-bold uppercase px-2 py-0.5 rounded ${
                          alertItem.risk_level === 'high' ? 'bg-red-500 text-white' : 'bg-yellow-500 text-black'
                        }`}>
                          {alertItem.risk_level} risk
                        </span>
                        <StatusBadge status={alertItem.status} />
                        {alertItem.severity && alertItem.status !== 'resolved' && (
                          <span className={`text-[10px] font-bold uppercase px-2 py-0.5 rounded ${SEVERITY_STYLE[alertItem.severity] || ''}`}>{alertItem.severity}</span>
                        )}
                        {alertItem.overdue && (
                          <span className="flex items-center gap-1 text-[10px] font-semibold uppercase px-2 py-0.5 rounded-full bg-red-500/20 text-red-300"><Clock size={10} /> Overdue</span>
                        )}
                        {alertItem.escalation_level > 0 && alertItem.status !== 'resolved' && (
                          <span className="text-[10px] font-semibold uppercase px-2 py-0.5 rounded-full bg-orange-500/20 text-orange-300">Escalation L{alertItem.escalation_level}</span>
                        )}
                        {alertItem.claim && (
                          <span className="flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full bg-yellow-500/15 text-yellow-300" title={`Lease until ${new Date(alertItem.claim.expires_at).toLocaleTimeString()}`}>
                            <Lock size={10} /> {alertItem.claim.user_id === user?.id ? 'You are working this' : `${alertItem.claim.username} is working this`}
                          </span>
                        )}
                        {alertItem.verdict && (
                          <span className={`text-[10px] font-semibold uppercase px-2 py-0.5 rounded-full ${
                            alertItem.verdict === 'confirmed_fraud' ? 'bg-red-500/15 text-red-400' : 'bg-green-500/15 text-green-400'
                          }`}>
                            {VERDICT_LABEL[alertItem.verdict]}
                          </span>
                        )}
                        {alertItem.username && <span className="text-xs text-gray-500">by {alertItem.username}</span>}
                        {alertItem.assignee_username && (
                          <span className="text-xs text-purple-300">→ {alertItem.assignee_username}</span>
                        )}
                      </div>
                      <p className="text-white text-sm">{alertItem.message}</p>
                      {alertItem.resolution_note && (
                        <p className="text-gray-400 text-xs mt-1 italic">"{alertItem.resolution_note}"</p>
                      )}
                      <p className="text-gray-500 text-xs mt-1">{new Date(alertItem.created_at).toLocaleString()}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-3 shrink-0 pl-14 sm:pl-0">
                    <Link to={`/transactions/${alertItem.transaction_id}`} className="text-right hover:underline transition-colors">
                      <span className="text-white font-semibold tabular-nums block">${Number(alertItem.amount).toFixed(2)}</span>
                      <span className="text-gray-400 text-xs">{alertItem.merchant}</span>
                    </Link>
                    <div className="flex items-center gap-2 relative">
                      <button
                        onClick={() => toggleExplanation(alertItem.id)}
                        disabled={explainBusyId === alertItem.id}
                        title="Explain in plain language"
                        className={`p-2 rounded-lg disabled:opacity-50 transition-colors ${
                          openExplanationId === alertItem.id ? 'bg-purple-600 text-white' : 'bg-white/5 hover:bg-white/10 text-gray-300'
                        }`}
                      >
                        <Lightbulb size={14} />
                      </button>
                      {user?.role === 'admin' && (
                        <button
                          onClick={() => setOpenCaseId(openCaseId === alertItem.id ? null : alertItem.id)}
                          title="Open the case workspace"
                          aria-label="Open case workspace"
                          className={`p-2 rounded-lg transition-colors ${openCaseId === alertItem.id ? 'bg-purple-600 text-white' : 'bg-white/5 hover:bg-white/10 text-gray-300'}`}
                        >
                          <Briefcase size={14} />
                        </button>
                      )}
                      {user?.role === 'admin' && (
                        <button
                          onClick={() => toggleAuditTrail(alertItem.id)}
                          disabled={auditBusyId === alertItem.id}
                          title="View this alert's audit trail"
                          className={`p-2 rounded-lg disabled:opacity-50 transition-colors ${
                            openAuditId === alertItem.id ? 'bg-purple-600 text-white' : 'bg-white/5 hover:bg-white/10 text-gray-300'
                          }`}
                        >
                          <History size={14} />
                        </button>
                      )}
                      {user?.role === 'admin' && alertItem.status !== 'resolved' && (
                        <button
                          onClick={() => toggleAssignToMe(alertItem)}
                          disabled={busyId === alertItem.id}
                          title={alertItem.assigned_to === user.id ? 'Unassign from me' : 'Assign to me'}
                          className="p-2 rounded-lg bg-white/5 hover:bg-white/10 text-gray-300 disabled:opacity-50 transition-colors"
                        >
                          {alertItem.assigned_to === user.id ? <UserMinus size={14} /> : <UserPlus size={14} />}
                        </button>
                      )}
                      {user?.role === 'admin' && (
                        <div className="relative">
                          <button
                            onClick={() => setSarMenuId(sarMenuId === alertItem.id ? null : alertItem.id)}
                            disabled={sarBusyId === alertItem.id}
                            title="Download SAR-style compliance report"
                            className="p-2 rounded-lg bg-white/5 hover:bg-white/10 text-gray-300 disabled:opacity-50 transition-colors"
                          >
                            <FileText size={14} />
                          </button>
                          {sarMenuId === alertItem.id && (
                            <div className="absolute right-0 top-full mt-1 bg-[#111820] border border-white/10 rounded-lg shadow-lg py-1 z-10 w-28 animate-menu-in">
                              <button
                                onClick={() => downloadSarReport(alertItem.id, 'pdf')}
                                disabled={sarBusyId === alertItem.id}
                                className="w-full text-left px-3 py-1.5 text-sm text-gray-300 hover:bg-white/10 disabled:opacity-50 transition-colors"
                              >
                                PDF
                              </button>
                              <button
                                onClick={() => downloadSarReport(alertItem.id, 'csv')}
                                disabled={sarBusyId === alertItem.id}
                                className="w-full text-left px-3 py-1.5 text-sm text-gray-300 hover:bg-white/10 disabled:opacity-50 transition-colors"
                              >
                                CSV
                              </button>
                            </div>
                          )}
                        </div>
                      )}
                      {alertItem.status !== 'resolved' && resolvingId !== alertItem.id && (
                        <button
                          onClick={() => startResolving(alertItem.id)}
                          className="flex items-center gap-1 bg-green-600 hover:bg-green-700 text-white px-3 py-1.5 rounded-lg text-sm transition-colors"
                        >
                          <CheckCircle size={14} /> Resolve
                        </button>
                      )}
                    </div>
                  </div>
                </div>

                {user?.role === 'admin' && openCaseId === alertItem.id && (
                  <CasePanel
                    alert={alertItem}
                    user={user}
                    onAlertChange={(a) => setAlerts(prev => prev.map(x => (x.id === a.id ? { ...x, ...a } : x)))}
                  />
                )}

                {openExplanationId === alertItem.id && (
                  <div className="mt-4 ml-0 sm:ml-14 bg-blue-500/10 border border-blue-500/20 rounded-lg p-4 flex items-start gap-2">
                    <Lightbulb size={14} className="text-blue-400 shrink-0 mt-0.5" />
                    {explainBusyId === alertItem.id ? (
                      <p className="text-gray-400 text-sm">Generating an explanation...</p>
                    ) : explainError[alertItem.id] ? (
                      <p className="text-red-400 text-sm">{explainError[alertItem.id]}</p>
                    ) : (
                      <p className="text-blue-200 text-sm">{explanations[alertItem.id]}</p>
                    )}
                  </div>
                )}

                {openAuditId === alertItem.id && (
                  <div className="mt-4 ml-0 sm:ml-14 bg-black/20 rounded-lg p-4">
                    {auditBusyId === alertItem.id ? (
                      <p className="text-gray-400 text-sm">Loading audit trail...</p>
                    ) : !auditTrails[alertItem.id]?.length ? (
                      <p className="text-gray-500 text-sm">No audit events recorded for this alert yet.</p>
                    ) : (
                      <ul className="space-y-1.5">
                        {auditTrails[alertItem.id].map(log => (
                          <li key={log.id} className="text-xs text-gray-400 flex flex-wrap items-baseline gap-x-2">
                            <span className="text-gray-300 font-mono">{log.action}</span>
                            <span>by {log.username || 'unknown'}</span>
                            <span className="text-gray-600">— {new Date(log.created_at).toLocaleString()}</span>
                            <span className={log.outcome === 'success' ? 'text-green-400' : log.outcome === 'denied' ? 'text-red-400' : 'text-yellow-400'}>
                              {log.outcome}
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}

                {resolvingId === alertItem.id && (
                  <div className="mt-4 ml-0 sm:ml-14 bg-black/20 rounded-lg p-4">
                    <label className="block text-xs text-gray-400 mb-1" htmlFor={`reason-${alertItem.id}`}>Resolution reason (required)</label>
                    <select
                      id={`reason-${alertItem.id}`}
                      value={resolveReason}
                      onChange={e => setResolveReason(e.target.value)}
                      className="w-full bg-[#0a0f14] border border-white/20 rounded-lg px-3 py-2 text-sm text-white mb-3"
                    >
                      <option value="">Choose a reason…</option>
                      {Object.entries(REASON_LABEL).map(([k, label]) => <option key={k} value={k}>{label}</option>)}
                    </select>
                    {user?.role === 'admin' && (
                      <div className="flex flex-wrap gap-3 mb-3">
                        {[['loss', 'Loss'], ['recovered', 'Recovered'], ['prevented', 'Prevented']].map(([k, label]) => (
                          <label key={k} className="text-xs text-gray-400">{label} $ (confirmed fraud only)
                            <input type="number" min="0" step="0.01" aria-label={`${label} amount`} value={amounts[k]} onChange={e => setAmounts(a => ({ ...a, [k]: e.target.value }))}
                              className="block mt-1 w-28 bg-[#0a0f14] border border-white/20 rounded-lg px-2 py-1 text-sm text-white" />
                          </label>
                        ))}
                      </div>
                    )}
                    <label className="block text-xs text-gray-400 mb-1">Resolution note (optional)</label>
                    <textarea
                      value={note}
                      onChange={e => setNote(e.target.value)}
                      rows={2}
                      maxLength={1000}
                      placeholder="Why are you resolving this the way you are?"
                      className="w-full bg-[#0a0f14] border border-white/20 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-purple-500 mb-3"
                    />
                    {resolveError && <p className="text-red-400 text-xs mb-3">{resolveError}</p>}
                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        onClick={() => submitResolve(alertItem.id, 'confirmed_fraud')}
                        disabled={busyId === alertItem.id || !resolveReason}
                        className="flex items-center gap-1 bg-red-600 hover:bg-red-700 disabled:opacity-50 text-white px-3 py-1.5 rounded-lg text-sm transition-colors"
                      >
                        <XCircle size={14} /> Confirm Fraud
                      </button>
                      <button
                        onClick={() => submitResolve(alertItem.id, 'false_positive')}
                        disabled={busyId === alertItem.id || !resolveReason}
                        className="flex items-center gap-1 bg-green-600 hover:bg-green-700 disabled:opacity-50 text-white px-3 py-1.5 rounded-lg text-sm transition-colors"
                      >
                        <CheckCircle size={14} /> Mark False Positive
                      </button>
                      <button
                        onClick={() => setResolvingId(null)}
                        className="text-gray-400 hover:text-white text-sm px-3 py-1.5 transition-colors"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {pageInfo && pageInfo.total_pages > 1 && (
          <div className="flex items-center justify-between px-6 py-4 border-t border-white/10">
            <span className="text-xs text-gray-500">
              Page {pageInfo.page} of {pageInfo.total_pages} &middot; {pageInfo.total} total alerts
            </span>
            <div className="flex items-center gap-2">
              <button
                onClick={() => loadAlerts(page - 1)}
                disabled={!pageInfo.has_prev || loading}
                className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-sm text-gray-300 bg-white/5 hover:bg-white/10 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                <ChevronLeft size={14} /> Prev
              </button>
              <button
                onClick={() => loadAlerts(page + 1)}
                disabled={!pageInfo.has_next || loading}
                className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-sm text-gray-300 bg-white/5 hover:bg-white/10 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                Next <ChevronRight size={14} />
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
