import React, { useState, useEffect, useCallback } from 'react';
import { useParams, Link } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { api } from '../context/AuthContext';
import { LoadingState, ErrorState } from '../components/ui/States';
import { CASE_STATUS_LABEL, CASE_STATUS_STYLE, PRIORITY_STYLE, OUTCOME_LABEL, TIMELINE_STYLE, apiCode, apiMessage } from '../components/cases/caseUi';

export default function CaseDetailPage() {
  const { id } = useParams();
  const [d, setD] = useState(null);
  const [timeline, setTimeline] = useState([]);
  const [suggestions, setSuggestions] = useState(null);
  const [admins, setAdmins] = useState([]);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [comment, setComment] = useState('');
  const [close, setClose] = useState({ outcome: 'confirmed_fraud', note: '', resolve_alerts: true });
  const [reopenReason, setReopenReason] = useState('');

  const load = useCallback(async () => {
    try {
      const [detail, tl, sug, users] = await Promise.all([
        api.get(`/investigations/${id}`), api.get(`/investigations/${id}/timeline`), api.get(`/investigations/${id}/suggestions`), api.get('/admin/users'),
      ]);
      setD(detail.data); setTimeline(tl.data.timeline); setSuggestions(sug.data);
      setAdmins((users.data.users || []).filter((u) => u.role === 'admin'));
      setError('');
    } catch (e) { setError(apiMessage(e, 'Failed to load the case')); }
  }, [id]);
  useEffect(() => { load(); }, [load]);

  /** Runs a mutation; a stale version means someone else changed the case, so reload and say so. */
  const act = async (fn, okMessage) => {
    setNotice('');
    try { await fn(); setNotice(okMessage || ''); await load(); }
    catch (e) {
      if (apiCode(e) === 'VERSION_CONFLICT') { setNotice('Someone else changed this case. It has been reloaded; review it and try again.'); await load(); }
      else setNotice(apiMessage(e, 'Action failed'));
    }
  };

  if (error) return <ErrorState message={error} onRetry={load} />;
  if (!d) return <LoadingState label="Loading case..." />;
  const c = d.investigation; const closed = c.status === 'closed'; const v = { version: c.version };

  return (
    <div className="space-y-6 animate-page-in">
      <Link to="/cases" className="flex items-center gap-1 text-gray-400 hover:text-white text-sm"><ArrowLeft size={14} /> All cases</Link>
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-white">#{c.id} {c.title}</h1>
          <div className="flex flex-wrap items-center gap-2 mt-2 text-sm">
            <span className={`px-2 py-0.5 rounded text-xs ${CASE_STATUS_STYLE[c.status]}`}>{CASE_STATUS_LABEL[c.status]}</span>
            <span className={`px-2 py-0.5 rounded text-xs ${PRIORITY_STYLE[c.priority]}`}>{c.priority}</span>
            {c.outcome && <span className="px-2 py-0.5 rounded text-xs bg-white/10 text-white">{OUTCOME_LABEL[c.outcome]}</span>}
            <span className="text-gray-400">Created by {c.created_by_username}</span>
          </div>
          {c.summary && <p className="text-gray-300 text-sm mt-2 max-w-3xl">{c.summary}</p>}
        </div>
        {!closed && (
          <div className="flex flex-wrap items-end gap-3 text-sm">
            <div><label htmlFor="assignee" className="block text-gray-400 text-xs">Assignee</label>
              <select id="assignee" value={c.assigned_to || ''} onChange={(e) => act(() => api.patch(`/investigations/${id}/assign`, { assigneeId: e.target.value ? Number(e.target.value) : null, ...v }), 'Assignment updated')} className="bg-[#0a0f14] border border-white/20 rounded-lg px-2 py-1 text-white">
                <option value="">Unassigned</option>{admins.map((a) => <option key={a.id} value={a.id}>{a.username}</option>)}</select></div>
            <div><label htmlFor="status" className="block text-gray-400 text-xs">Status</label>
              <select id="status" value={c.status} onChange={(e) => act(() => api.patch(`/investigations/${id}/status`, { status: e.target.value, ...v }), 'Status updated')} className="bg-[#0a0f14] border border-white/20 rounded-lg px-2 py-1 text-white">
                {['open', 'investigating', 'pending_info'].map((s) => <option key={s} value={s}>{CASE_STATUS_LABEL[s]}</option>)}</select></div>
            <div><label htmlFor="priority" className="block text-gray-400 text-xs">Priority</label>
              <select id="priority" value={c.priority} onChange={(e) => act(() => api.patch(`/investigations/${id}`, { priority: e.target.value, ...v }), 'Priority updated')} className="bg-[#0a0f14] border border-white/20 rounded-lg px-2 py-1 text-white">
                {['critical', 'high', 'medium', 'low'].map((p) => <option key={p} value={p}>{p}</option>)}</select></div>
          </div>
        )}
      </header>
      {notice && <p role="status" className="text-sm text-yellow-300">{notice}</p>}

      <section aria-label="Summary" className="grid grid-cols-2 md:grid-cols-5 gap-3 text-sm">
        {[['Exposure', `$${d.summary.exposure_amount.toFixed(2)}`], ['Accounts', d.summary.accounts], ['Devices', d.summary.devices], ['IPs', d.summary.ips], ['Open alerts', d.summary.open_alerts]].map(([k, val]) => (
          <div key={k} className="bg-[#111820] border border-white/10 rounded-xl p-3"><p className="text-gray-400 text-xs">{k}</p><p className="text-white text-xl tabular-nums">{val}</p></div>
        ))}
      </section>

      <div className="grid lg:grid-cols-2 gap-6">
        <section aria-label="Alerts and transactions" className="bg-[#111820] border border-white/10 rounded-xl p-4 space-y-4">
          <h2 className="text-white font-semibold">Contents</h2>
          <table className="w-full text-sm"><caption className="text-left text-gray-400 text-xs mb-1">Alerts</caption>
            <tbody>{d.alerts.map((a) => (
              <tr key={a.id} className="border-t border-white/5 text-gray-200">
                <td className="py-1">Alert #{a.id}</td><td>{a.severity}</td><td>{a.status}</td><td>{a.verdict || '—'}</td>
                <td className="text-right">{!closed && <button className="text-xs text-red-300" onClick={() => act(() => api.delete(`/investigations/${id}/items/alert/${a.id}`, { params: v }), `Alert #${a.id} removed`)}>Remove alert #{a.id}</button>}</td>
              </tr>))}
              {d.alerts.length === 0 && <tr><td className="text-gray-500 text-xs py-1">No alerts</td></tr>}</tbody></table>
          <table className="w-full text-sm"><caption className="text-left text-gray-400 text-xs mb-1">Transactions</caption>
            <tbody>{d.transactions.map((t) => (
              <tr key={t.id} className="border-t border-white/5 text-gray-200">
                <td className="py-1"><Link className="text-cyan-300 hover:underline" to={`/transactions/${t.id}`}>#{t.id}</Link></td><td>{t.username}</td><td>${Number(t.amount).toFixed(2)}</td><td>{t.merchant}</td><td>{t.risk_level}</td>
              </tr>))}</tbody></table>
        </section>

        <section aria-label="Linked entities" className="bg-[#111820] border border-white/10 rounded-xl p-4 text-sm space-y-3">
          <h2 className="text-white font-semibold">Linked entities</h2>
          <p className="text-gray-300"><span className="text-gray-400">Accounts:</span> {d.links.users.map((u) => u.username).join(', ') || '—'}</p>
          <p className="text-gray-300"><span className="text-gray-400">Devices:</span> {d.links.devices.map((x) => `${x.label} (${x.transactions})`).join(', ') || '—'}</p>
          <p className="text-gray-300"><span className="text-gray-400">IPs:</span> {d.links.ips.map((x) => `${x.value} (${x.transactions})`).join(', ') || '—'}</p>
          <p className="text-gray-300"><span className="text-gray-400">Disputes:</span> {d.links.disputes.length ? d.links.disputes.map((x) => `#${x.id} ${x.status} $${Number(x.amount_disputed).toFixed(2)}`).join(', ') : '—'}</p>
          <div>
            <span className="text-gray-400">Other cases touching the same account, device or IP:</span>{' '}
            {d.links.related_cases.length ? d.links.related_cases.map((r) => <Link key={r.case_id} className="text-cyan-300 hover:underline mr-2" to={`/cases/${r.case_id}`}>#{r.case_id} ({r.via.join(', ')})</Link>) : <span className="text-gray-500">none</span>}
          </div>
          {d.transactions[0] && <Link className="inline-block text-cyan-300 hover:underline" to={`/relationships?transactionId=${d.transactions[0].id}`}>Explore related accounts →</Link>}
        </section>
      </div>

      {!closed && suggestions && (
        <section aria-label="Suggested additions" className="bg-[#111820] border border-white/10 rounded-xl p-4">
          <h2 className="text-white font-semibold">Possibly related alerts</h2>
          <p className="text-xs text-yellow-300 mb-2">{suggestions.caution}</p>
          {suggestions.suggestions.length === 0 ? <p className="text-sm text-gray-500">None found.</p> : (
            <ul className="space-y-1 text-sm">{suggestions.suggestions.map((s) => (
              <li key={s.alert_id} className="flex items-center justify-between text-gray-200">
                <span>Alert #{s.alert_id} · ${Number(s.amount).toFixed(2)} at {s.merchant} · {s.reasons.join(', ')}</span>
                <button className="text-cyan-300 text-xs" onClick={() => act(() => api.post(`/investigations/${id}/items`, { alertIds: [s.alert_id], ...v }), `Alert #${s.alert_id} added`)}>Add alert #{s.alert_id}</button>
              </li>))}</ul>)}
        </section>
      )}

      <section aria-label="Timeline" className="bg-[#111820] border border-white/10 rounded-xl p-4">
        <h2 className="text-white font-semibold mb-3">Timeline</h2>
        <ol className="space-y-2 text-sm">
          {timeline.map((e, i) => (
            <li key={`${e.at}-${i}`} className="flex gap-3">
              <time className="text-gray-500 text-xs w-40 shrink-0">{new Date(e.at).toLocaleString()}</time>
              <span className={`text-xs w-24 shrink-0 ${TIMELINE_STYLE[e.source] || 'text-gray-300'}`}>{e.kind.replace(/_/g, ' ')}</span>
              <span className="text-gray-200">{e.summary}{e.actor ? <span className="text-gray-500"> — {e.actor}</span> : null}</span>
            </li>))}
        </ol>
        {!closed && (
          <form className="mt-4 flex gap-2" onSubmit={(e) => { e.preventDefault(); if (!comment.trim()) return; act(async () => { await api.post(`/investigations/${id}/comments`, { body: comment }); setComment(''); }); }}>
            <label htmlFor="comment" className="sr-only">Add a note</label>
            <input id="comment" value={comment} onChange={(e) => setComment(e.target.value)} maxLength={2000} placeholder="Add a note to the case timeline" className="flex-1 bg-[#0a0f14] border border-white/20 rounded-lg px-3 py-1.5 text-sm text-white" />
            <button type="submit" className="bg-white/10 hover:bg-white/20 text-white px-3 py-1.5 rounded-lg text-sm">Add note</button>
          </form>)}
      </section>

      <section aria-label="Outcome" className="bg-[#111820] border border-white/10 rounded-xl p-4">
        {closed ? (
          <div className="space-y-3 text-sm">
            <p className="text-gray-200">Closed as <strong>{OUTCOME_LABEL[c.outcome]}</strong>: {c.outcome_note}</p>
            <form className="flex flex-wrap gap-2" onSubmit={(e) => { e.preventDefault(); act(() => api.patch(`/investigations/${id}/status`, { status: 'open', reason: reopenReason, ...v }), 'Case reopened'); }}>
              <label htmlFor="reopen" className="sr-only">Reason for reopening</label>
              <input id="reopen" value={reopenReason} onChange={(e) => setReopenReason(e.target.value)} placeholder="Reason for reopening (10+ characters)" className="flex-1 bg-[#0a0f14] border border-white/20 rounded-lg px-3 py-1.5 text-white" />
              <button type="submit" disabled={reopenReason.trim().length < 10} className="bg-white/10 disabled:opacity-40 text-white px-3 py-1.5 rounded-lg">Reopen</button>
            </form>
          </div>
        ) : (
          <form className="space-y-3 text-sm" onSubmit={(e) => { e.preventDefault(); act(() => api.post(`/investigations/${id}/close`, { ...close, ...v }), 'Case closed'); }}>
            <h2 className="text-white font-semibold">Close case</h2>
            <fieldset className="flex flex-wrap gap-4"><legend className="sr-only">Outcome</legend>
              {Object.entries(OUTCOME_LABEL).map(([k, label]) => (
                <label key={k} className="flex items-center gap-2 text-gray-200"><input type="radio" name="outcome" value={k} checked={close.outcome === k} onChange={() => setClose({ ...close, outcome: k, resolve_alerts: k === 'inconclusive' ? false : close.resolve_alerts })} /> {label}</label>))}
            </fieldset>
            <div><label htmlFor="outcome-note" className="block text-gray-400 text-xs">Explain the outcome</label>
              <textarea id="outcome-note" value={close.note} onChange={(e) => setClose({ ...close, note: e.target.value })} rows={2} maxLength={2000} className="w-full bg-[#0a0f14] border border-white/20 rounded-lg px-3 py-1.5 text-white" /></div>
            <label className="flex items-center gap-2 text-gray-300"><input type="checkbox" disabled={close.outcome === 'inconclusive'} checked={close.resolve_alerts && close.outcome !== 'inconclusive'} onChange={(e) => setClose({ ...close, resolve_alerts: e.target.checked })} /> Also resolve the case's open alerts with this verdict (feeds model performance)</label>
            <button type="submit" disabled={close.note.trim().length < 10} className="bg-cyan-600 hover:bg-cyan-700 disabled:opacity-40 text-white px-4 py-1.5 rounded-lg">Close case</button>
          </form>
        )}
      </section>
    </div>
  );
}
