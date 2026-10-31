import React, { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { FolderOpen } from 'lucide-react';
import { api } from '../context/AuthContext';
import PageHeading from '../components/ui/PageHeading';
import { LoadingState, ErrorState, EmptyState } from '../components/ui/States';
import { CASE_STATUS_LABEL, CASE_STATUS_STYLE, PRIORITY_STYLE, OUTCOME_LABEL } from '../components/cases/caseUi';
import CreateCaseButton from '../components/cases/CreateCaseButton';

const ids = (s) => [...new Set(s.split(/[\s,]+/).filter(Boolean).map(Number).filter((n) => Number.isInteger(n) && n > 0))];

export default function CasesPage() {
  const [filters, setFilters] = useState({ status: '', priority: '', unassigned: false, q: '' });
  const [page, setPage] = useState(1);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [alertText, setAlertText] = useState('');

  const load = useCallback(() => {
    setLoading(true); setError('');
    const params = { page, limit: 20 };
    if (filters.status) params.status = filters.status;
    if (filters.priority) params.priority = filters.priority;
    if (filters.unassigned) params.unassigned = 'true';
    if (filters.q) params.q = filters.q;
    api.get('/investigations', { params }).then((r) => setData(r.data)).catch((e) => setError(e.response?.data?.error || 'Failed to load cases')).finally(() => setLoading(false));
  }, [filters, page]);
  useEffect(() => { load(); }, [load]);
  const set = (k, v) => { setPage(1); setFilters((f) => ({ ...f, [k]: v })); };

  return (
    <div className="space-y-6 animate-page-in">
      <PageHeading icon={FolderOpen} title="Cases" subtitle="Related alerts and transactions worked as one investigation" />
      <div className="bg-[#111820] border border-white/10 rounded-xl p-4 flex flex-wrap items-end gap-3 text-sm">
        <div><label htmlFor="c-status" className="block text-gray-400 text-xs">Status</label>
          <select id="c-status" value={filters.status} onChange={(e) => set('status', e.target.value)} className="bg-[#0a0f14] border border-white/20 rounded-lg px-2 py-1 text-white">
            <option value="">All</option>{Object.entries(CASE_STATUS_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></div>
        <div><label htmlFor="c-prio" className="block text-gray-400 text-xs">Priority</label>
          <select id="c-prio" value={filters.priority} onChange={(e) => set('priority', e.target.value)} className="bg-[#0a0f14] border border-white/20 rounded-lg px-2 py-1 text-white">
            <option value="">All</option>{['critical', 'high', 'medium', 'low'].map((p) => <option key={p} value={p}>{p}</option>)}</select></div>
        <div><label htmlFor="c-q" className="block text-gray-400 text-xs">Search title</label>
          <input id="c-q" value={filters.q} onChange={(e) => set('q', e.target.value)} className="bg-[#0a0f14] border border-white/20 rounded-lg px-2 py-1 text-white" /></div>
        <label className="flex items-center gap-2 text-gray-300"><input type="checkbox" checked={filters.unassigned} onChange={(e) => set('unassigned', e.target.checked)} /> Unassigned only</label>
      </div>

      <details className="bg-[#111820] border border-white/10 rounded-xl p-4">
        <summary className="text-gray-200 cursor-pointer text-sm">Start a case from alert IDs</summary>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <label htmlFor="c-alert-ids" className="sr-only">Alert IDs</label>
          <input id="c-alert-ids" value={alertText} onChange={(e) => setAlertText(e.target.value)} placeholder="Alert IDs, e.g. 12, 15, 31" className="bg-[#0a0f14] border border-white/20 rounded-lg px-3 py-1.5 text-sm text-white w-64" />
          {ids(alertText).length > 0 && <CreateCaseButton alertIds={ids(alertText)} />}
          <p className="text-xs text-gray-500 w-full">You can also select alerts in the Alerts queue, or open a cluster in Relationships, and create the case from there.</p>
        </div>
      </details>

      <div className="bg-[#111820] border border-white/10 rounded-xl overflow-x-auto">
        {loading && <LoadingState label="Loading cases..." />}
        {error && <ErrorState message={error} onRetry={load} />}
        {!loading && !error && data && (data.cases.length === 0
          ? <EmptyState icon={FolderOpen} title="No cases match" subtitle="Select related alerts and create a case to start." />
          : (
            <table className="w-full text-sm">
              <thead><tr className="text-left text-gray-400 text-xs"><th className="p-3">Case</th><th>Status</th><th>Priority</th><th>Assignee</th><th>Alerts</th><th>Txns</th><th>Outcome</th><th>Updated</th></tr></thead>
              <tbody>
                {data.cases.map((c) => (
                  <tr key={c.id} className="border-t border-white/5 text-gray-200">
                    <td className="p-3"><Link className="text-cyan-300 hover:underline" to={`/cases/${c.id}`}>#{c.id} {c.title}</Link></td>
                    <td><span className={`px-2 py-0.5 rounded text-xs ${CASE_STATUS_STYLE[c.status]}`}>{CASE_STATUS_LABEL[c.status]}</span></td>
                    <td><span className={`px-2 py-0.5 rounded text-xs ${PRIORITY_STYLE[c.priority]}`}>{c.priority}</span></td>
                    <td>{c.assignee_username || <span className="text-gray-500">unassigned</span>}</td>
                    <td>{c.alert_count}</td><td>{c.transaction_count}</td><td>{c.outcome ? OUTCOME_LABEL[c.outcome] : '—'}</td>
                    <td className="text-gray-400">{new Date(c.updated_at).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ))}
        {data?.pagination && data.pagination.total_pages > 1 && (
          <div className="flex items-center justify-between p-3 text-sm text-gray-400">
            <button disabled={!data.pagination.has_prev} onClick={() => setPage((p) => p - 1)} className="disabled:opacity-40">Previous</button>
            <span>Page {data.pagination.page} of {data.pagination.total_pages}</span>
            <button disabled={!data.pagination.has_next} onClick={() => setPage((p) => p + 1)} className="disabled:opacity-40">Next</button>
          </div>
        )}
      </div>
    </div>
  );
}
