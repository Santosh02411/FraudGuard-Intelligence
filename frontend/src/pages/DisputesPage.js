import React, { useState, useEffect, useCallback } from 'react';
import { api, useAuth } from '../context/AuthContext';
import { Link } from 'react-router-dom';
import {
  Scale, CheckCircle, XCircle, Clock, FileText, RefreshCw, Filter, X, Plus, Download,
} from 'lucide-react';
import { LoadingState, ErrorState, EmptyState } from '../components/ui/States';
import { downloadBlobResponse } from '../utils/download';
import PageHeading from '../components/ui/PageHeading';
import StatCard from '../components/ui/StatCard';
import DotBadge from '../components/ui/DotBadge';

const STATUS_LABEL = {
  opened: 'Opened',
  evidence_submitted: 'Evidence Submitted',
  won: 'Won',
  lost: 'Lost',
};
const STATUS_STYLE = {
  opened: 'bg-yellow-500/15 text-yellow-400',
  evidence_submitted: 'bg-blue-500/15 text-blue-400',
  won: 'bg-green-500/15 text-green-400',
  lost: 'bg-red-500/15 text-red-400',
};
const STATUS_DOT = {
  opened: 'bg-yellow-400',
  evidence_submitted: 'bg-blue-400',
  won: 'bg-green-400',
  lost: 'bg-red-400',
};
// The next legal step(s) from a given status — mirrors
// disputeRepository.js's TRANSITIONS so the UI never offers a button
// the API would reject.
const NEXT_STEPS = {
  opened: ['evidence_submitted', 'won', 'lost'],
  evidence_submitted: ['won', 'lost'],
  won: [],
  lost: [],
};

function StatusBadge({ status }) {
  return (
    <DotBadge label={STATUS_LABEL[status]} colorClass={STATUS_STYLE[status]} dotClass={STATUS_DOT[status]} />
  );
}

/**
 * Case management for chargebacks/disputes (feature: dispute tracking —
 * see backend/models/disputeRepository.js's header for why this is
 * separate from an alert's verdict). A dispute is opened from a
 * transaction's detail page; this page is where it's tracked and, for
 * admins, worked through to a resolution.
 */
export default function DisputesPage() {
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';

  const [disputes, setDisputes] = useState([]);
  const [summary, setSummary] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [showFilters, setShowFilters] = useState(false);
  const [exporting, setExporting] = useState(false);

  // Inline "advance status" form — only one case's form is open at a
  // time, tracked by id, same pattern as AlertsPage's resolve form.
  const [transitioningId, setTransitioningId] = useState(null);
  const [note, setNote] = useState('');
  const [transitionError, setTransitionError] = useState('');
  const [busyId, setBusyId] = useState(null);

  // Open a new dispute without needing to go through a specific
  // transaction's detail page first — pick from a list of the caller's
  // own eligible (not already disputed) transactions instead.
  const [showOpenForm, setShowOpenForm] = useState(false);
  const [openTxnOptions, setOpenTxnOptions] = useState(null); // null = not loaded yet
  const [openTxnLoading, setOpenTxnLoading] = useState(false);
  const [openForm, setOpenForm] = useState({ transaction_id: '', reason: '', amount_disputed: '' });
  const [openFormError, setOpenFormError] = useState('');
  const [openFormBusy, setOpenFormBusy] = useState(false);

  const load = useCallback((activeStatus = status) => {
    setLoading(true);
    setError('');
    const params = activeStatus ? { status: activeStatus } : {};
    const requests = [api.get('/disputes', { params })];
    if (isAdmin) requests.push(api.get('/disputes/financial-summary'));

    Promise.all(requests)
      .then(([disputesRes, summaryRes]) => {
        setDisputes(disputesRes.data.disputes);
        if (summaryRes) setSummary(summaryRes.data);
      })
      .catch((err) => setError(err.response?.data?.error || 'Failed to load disputes'))
      .finally(() => setLoading(false));
  }, [status, isAdmin]);

  useEffect(() => { load(''); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const applyFilter = (e) => {
    e.preventDefault();
    load(status);
  };

  const clearFilter = () => {
    setStatus('');
    load('');
  };

  const exportCsv = async () => {
    setExporting(true);
    try {
      const params = status ? { status } : {};
      const res = await api.get('/disputes/export', { params, responseType: 'blob' });
      downloadBlobResponse(res, 'disputes.csv');
    } catch (err) {
      setError('Failed to export disputes');
    } finally {
      setExporting(false);
    }
  };

  const startTransitioning = (id) => {
    setTransitioningId(id);
    setNote('');
    setTransitionError('');
  };

  const submitTransition = async (id, nextStatus) => {
    setBusyId(id);
    setTransitionError('');
    try {
      const current = disputes.find(d => d.id === id);
      const { data } = await api.patch(`/disputes/${id}`, { status: nextStatus, note: note || undefined, version: current?.version });
      setDisputes(prev => prev.map(d => (d.id === id ? data.dispute : d)));
      setTransitioningId(null);
      if (isAdmin) {
        api.get('/disputes/financial-summary').then(res => setSummary(res.data)).catch(() => {});
      }
    } catch (err) {
      if (err.response?.status === 409 && err.response?.data?.details?.code === 'VERSION_CONFLICT') {
        const latest = err.response.data.details.current;
        if (latest) setDisputes(prev => prev.map(d => (d.id === id ? latest : d)));
        setTransitionError('Someone else just updated this dispute, so your change was not applied. Review the latest state and try again if it is still needed.');
      } else {
        setTransitionError(err.response?.data?.error || 'Failed to update the dispute');
      }
    } finally {
      setBusyId(null);
    }
  };

  const activeFilterCount = status ? 1 : 0;

  const openNewDisputeForm = async () => {
    setShowOpenForm(true);
    setOpenFormError('');
    if (openTxnOptions !== null) return; // already fetched this session
    setOpenTxnLoading(true);
    try {
      const { data } = await api.get('/transactions', { params: { limit: 50 } });
      const alreadyDisputed = new Set(disputes.map(d => d.transaction_id));
      setOpenTxnOptions(data.transactions.filter(t => !alreadyDisputed.has(t.id)));
    } catch (err) {
      setOpenFormError('Failed to load transactions');
      setOpenTxnOptions([]);
    } finally {
      setOpenTxnLoading(false);
    }
  };

  const submitOpenDispute = async (e) => {
    e.preventDefault();
    setOpenFormBusy(true);
    setOpenFormError('');
    try {
      const body = { transaction_id: Number(openForm.transaction_id), reason: openForm.reason };
      if (openForm.amount_disputed) body.amount_disputed = Number(openForm.amount_disputed);
      const { data } = await api.post('/disputes', body);
      setDisputes(prev => [data.dispute, ...prev]);
      setShowOpenForm(false);
      setOpenForm({ transaction_id: '', reason: '', amount_disputed: '' });
      setOpenTxnOptions(prev => (prev || []).filter(t => t.id !== data.dispute.transaction_id));
    } catch (err) {
      setOpenFormError(err.response?.data?.error || 'Failed to open dispute');
    } finally {
      setOpenFormBusy(false);
    }
  };

  const selectedTxn = openTxnOptions?.find(t => t.id === Number(openForm.transaction_id));

  return (
    <div className="p-4 sm:p-8 max-w-4xl mx-auto">
      <div className="mb-6 sm:mb-8 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <PageHeading icon={Scale} title="Disputes" subtitle="Chargeback and dispute case tracking" />
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={openNewDisputeForm}
            className="flex items-center gap-2 bg-purple-600 hover:bg-purple-700 text-white px-4 py-2 rounded-lg text-sm transition-colors"
          >
            <Plus size={16} /> Open a Dispute
          </button>
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
            onClick={() => load(status)}
            className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg text-sm transition-colors"
          >
            <RefreshCw size={16} className={loading ? 'animate-spin' : ''} /> Refresh
          </button>
        </div>
      </div>

      {showOpenForm && (
        <div className="bg-[#111820] border border-white/10 rounded-xl p-4 sm:p-5 mb-4">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-white font-semibold text-sm">Open a Dispute</h2>
            <button onClick={() => setShowOpenForm(false)} className="text-gray-400 hover:text-white transition-colors"><X size={16} /></button>
          </div>
          {openTxnLoading ? (
            <p className="text-gray-500 text-sm">Loading your transactions...</p>
          ) : openTxnOptions?.length === 0 && !openFormError ? (
            <p className="text-gray-500 text-sm">No eligible transactions — every recent transaction already has a dispute, or you have none yet.</p>
          ) : (
            <form onSubmit={submitOpenDispute}>
              <div className="mb-3">
                <label className="block text-xs text-gray-400 mb-1">Transaction</label>
                <select
                  required
                  value={openForm.transaction_id}
                  onChange={e => setOpenForm(f => ({ ...f, transaction_id: e.target.value }))}
                  className="w-full bg-[#0a0f14] border border-white/20 rounded-lg px-3 py-2 text-sm text-white"
                >
                  <option value="">Select a transaction…</option>
                  {(openTxnOptions || []).map(t => (
                    <option key={t.id} value={t.id}>
                      #{t.id} — {t.merchant} — ${Number(t.amount).toFixed(2)} — {new Date(t.created_at).toLocaleDateString()}
                    </option>
                  ))}
                </select>
              </div>
              <div className="mb-3">
                <label className="block text-xs text-gray-400 mb-1">Why are you disputing this charge?</label>
                <textarea
                  required
                  minLength={1}
                  maxLength={500}
                  rows={2}
                  value={openForm.reason}
                  onChange={e => setOpenForm(f => ({ ...f, reason: e.target.value }))}
                  placeholder="I don't recognize this charge / item never arrived / billed twice, etc."
                  className="w-full bg-[#0a0f14] border border-white/20 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-purple-500"
                />
              </div>
              <div className="mb-3">
                <label className="block text-xs text-gray-400 mb-1">
                  Amount to dispute <span className="text-gray-600">{selectedTxn ? `(optional — defaults to the full $${Number(selectedTxn.amount).toFixed(2)})` : '(optional)'}</span>
                </label>
                <input
                  type="number" step="0.01" min="0.01" max={selectedTxn?.amount}
                  value={openForm.amount_disputed}
                  onChange={e => setOpenForm(f => ({ ...f, amount_disputed: e.target.value }))}
                  placeholder={selectedTxn ? Number(selectedTxn.amount).toFixed(2) : undefined}
                  className="w-full bg-[#0a0f14] border border-white/20 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-purple-500"
                />
              </div>
              {openFormError && <p className="text-red-400 text-xs mb-3">{openFormError}</p>}
              <button
                type="submit"
                disabled={openFormBusy}
                className="bg-purple-600 hover:bg-purple-700 disabled:opacity-50 text-white px-4 py-2 rounded-lg text-sm transition-colors"
              >
                {openFormBusy ? 'Submitting...' : 'Submit Dispute'}
              </button>
            </form>
          )}
        </div>
      )}

      {isAdmin && summary && (
        <div className="stagger grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4 mb-6 sm:mb-8">
          <StatCard title="Total Disputes" value={summary.total_disputes} />
          <StatCard title="Amount Won" value={`$${summary.amount_won.toFixed(2)}`} color="text-green-400" />
          <StatCard title="Amount Lost" value={`$${summary.amount_lost.toFixed(2)}`} color="text-red-400" />
          <StatCard
            title="Win Rate"
            value={summary.win_rate === null ? '—' : `${summary.win_rate}%`}
            color={summary.win_rate !== null && summary.win_rate < 50 ? 'text-yellow-400' : 'text-green-400'}
          />
        </div>
      )}

      {showFilters && (
        <form onSubmit={applyFilter} className="bg-[#111820] border border-white/10 rounded-xl p-4 sm:p-5 mb-4 flex flex-wrap items-end gap-3">
          <div>
            <label className="block text-xs text-gray-400 mb-1">Status</label>
            <select
              value={status}
              onChange={e => setStatus(e.target.value)}
              className="bg-[#0a0f14] border border-white/20 rounded-lg px-3 py-2 text-sm text-white"
            >
              <option value="">All</option>
              <option value="opened">Opened</option>
              <option value="evidence_submitted">Evidence Submitted</option>
              <option value="won">Won</option>
              <option value="lost">Lost</option>
            </select>
          </div>
          <button type="submit" className="bg-purple-600 hover:bg-purple-700 text-white px-4 py-2 rounded-lg text-sm transition-colors">
            Apply
          </button>
          {activeFilterCount > 0 && (
            <button type="button" onClick={clearFilter} className="flex items-center gap-1 text-gray-400 hover:text-white text-sm px-3 py-2 transition-colors">
              <X size={14} /> Clear
            </button>
          )}
        </form>
      )}

      <div className="bg-[#111820] border border-white/10 rounded-xl">
        <div className="p-6 border-b border-white/10">
          <h2 className="text-lg font-semibold text-white">
            Cases
            {!loading && !error && <span className="ml-2 text-gray-500 text-sm font-normal">({disputes.length} total)</span>}
          </h2>
        </div>

        {loading ? (
          <LoadingState label="Loading disputes..." />
        ) : error ? (
          <ErrorState message={error} onRetry={() => load(status)} />
        ) : disputes.length === 0 ? (
          <EmptyState icon={Scale} title="No disputes match these filters" subtitle={activeFilterCount > 0 ? 'Try clearing a filter.' : 'Use "Open a Dispute" above, or start from a transaction\u2019s detail page.'} />
        ) : (
          <div className="divide-y divide-white/5">
            {disputes.map(dispute => {
              const nextSteps = NEXT_STEPS[dispute.status] || [];
              return (
                <div key={dispute.id} className="p-6 hover:bg-white/5 transition-colors">
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                    <div className="flex items-start gap-4">
                      <div className="w-10 h-10 rounded-full bg-purple-500/15 flex items-center justify-center shrink-0">
                        <Scale size={20} className="text-purple-400" />
                      </div>
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2 mb-1">
                          <StatusBadge status={dispute.status} />
                          {(dispute.account_username || dispute.opened_by_username) && (
                            <span className="text-xs text-gray-500">
                              {dispute.account_username ? `on ${dispute.account_username}'s account` : `opened by ${dispute.opened_by_username}`}
                            </span>
                          )}
                        </div>
                        {dispute.reason && <p className="text-white text-sm">{dispute.reason}</p>}
                        {dispute.evidence_note && (
                          <p className="text-gray-400 text-xs mt-1 flex items-start gap-1">
                            <FileText size={12} className="mt-0.5 shrink-0" /> {dispute.evidence_note}
                          </p>
                        )}
                        {dispute.resolution_note && (
                          <p className="text-gray-400 text-xs mt-1 italic">&ldquo;{dispute.resolution_note}&rdquo;</p>
                        )}
                        <p className="text-gray-500 text-xs mt-1 flex items-center gap-1">
                          <Clock size={12} /> Opened {new Date(dispute.opened_at).toLocaleString()}
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-3 shrink-0 pl-14 sm:pl-0">
                      <Link to={`/transactions/${dispute.transaction_id}`} className="text-right hover:underline transition-colors">
                        <span className="text-white font-semibold tabular-nums block">${Number(dispute.amount_disputed).toFixed(2)}</span>
                        <span className="text-gray-400 text-xs">{dispute.merchant}</span>
                      </Link>
                      {isAdmin && nextSteps.length > 0 && transitioningId !== dispute.id && (
                        <button
                          onClick={() => startTransitioning(dispute.id)}
                          className="flex items-center gap-1 bg-blue-600 hover:bg-blue-700 text-white px-3 py-1.5 rounded-lg text-sm transition-colors"
                        >
                          Update
                        </button>
                      )}
                    </div>
                  </div>

                  {transitioningId === dispute.id && (
                    <div className="mt-4 ml-0 sm:ml-14 bg-black/20 rounded-lg p-4">
                      <label className="block text-xs text-gray-400 mb-1">Note (optional)</label>
                      <textarea
                        value={note}
                        onChange={e => setNote(e.target.value)}
                        rows={2}
                        maxLength={2000}
                        placeholder="Evidence submitted, outcome details, etc."
                        className="w-full bg-[#0a0f14] border border-white/20 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-purple-500 mb-3"
                      />
                      {transitionError && <p className="text-red-400 text-xs mb-3">{transitionError}</p>}
                      <div className="flex flex-wrap items-center gap-2">
                        {nextSteps.includes('evidence_submitted') && (
                          <button
                            onClick={() => submitTransition(dispute.id, 'evidence_submitted')}
                            disabled={busyId === dispute.id}
                            className="flex items-center gap-1 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white px-3 py-1.5 rounded-lg text-sm transition-colors"
                          >
                            <FileText size={14} /> Evidence Submitted
                          </button>
                        )}
                        {nextSteps.includes('won') && (
                          <button
                            onClick={() => submitTransition(dispute.id, 'won')}
                            disabled={busyId === dispute.id}
                            className="flex items-center gap-1 bg-green-600 hover:bg-green-700 disabled:opacity-50 text-white px-3 py-1.5 rounded-lg text-sm transition-colors"
                          >
                            <CheckCircle size={14} /> Won
                          </button>
                        )}
                        {nextSteps.includes('lost') && (
                          <button
                            onClick={() => submitTransition(dispute.id, 'lost')}
                            disabled={busyId === dispute.id}
                            className="flex items-center gap-1 bg-red-600 hover:bg-red-700 disabled:opacity-50 text-white px-3 py-1.5 rounded-lg text-sm transition-colors"
                          >
                            <XCircle size={14} /> Lost
                          </button>
                        )}
                        <button
                          onClick={() => setTransitioningId(null)}
                          className="text-gray-400 hover:text-white text-sm px-3 py-1.5 transition-colors"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
