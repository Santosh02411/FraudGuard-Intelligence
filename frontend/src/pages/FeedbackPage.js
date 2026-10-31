import React, { useState, useEffect, useCallback } from 'react';
import { ClipboardCheck } from 'lucide-react';
import { api } from '../context/AuthContext';
import PageHeading from '../components/ui/PageHeading';
import { LoadingState, ErrorState } from '../components/ui/States';

const errText = (e, d) => { const x = e.response?.data; return x?.error || x?.message || d; };
const RUN_TONE = { pending_approval: 'text-amber-300', approved: 'text-cyan-300', running: 'text-cyan-300', candidate_ready: 'text-emerald-300', failed: 'text-red-300', rejected: 'text-gray-400', cancelled: 'text-gray-400' };

function Labels({ onChange }) {
  const [data, setData] = useState(null);
  const [status, setStatus] = useState('proposed');
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [form, setForm] = useState({ transaction_id: '', label: 'fraud', evidence_note: '' });
  const load = useCallback(async () => {
    try { setData((await api.get('/feedback/labels', { params: { status, limit: 50 } })).data); } catch (e) { setErr(errText(e, 'Could not load labels')); }
  }, [status]);
  useEffect(() => { load(); }, [load]);

  const act = async (id, action) => {
    const note = window.prompt(`Note for "${action}" (required):`);
    if (!note || note.trim().length < 5) return;
    setErr(''); setMsg('');
    try { await api.post(`/feedback/labels/${id}/${action}`, { note: note.trim() }); setMsg(`Label ${action === 'verify' ? 'verified' : action === 'reject' ? 'rejected' : 'withdrawn'}.`); await load(); onChange(); } catch (e) { setErr(errText(e, `Could not ${action}`)); }
  };
  const propose = async (ev) => {
    ev.preventDefault(); setErr(''); setMsg('');
    try { await api.post('/feedback/labels', { transaction_id: Number(form.transaction_id), label: form.label, evidence_note: form.evidence_note }); setMsg('Label proposed. A different investigator must verify it.'); setForm({ transaction_id: '', label: 'fraud', evidence_note: '' }); await load(); onChange(); } catch (e) { setErr(errText(e, 'Could not propose the label')); }
  };
  const importOutcomes = async () => {
    setErr(''); setMsg('');
    try { const r = (await api.post('/feedback/labels/import-outcomes')).data; setMsg(`${r.proposed} label(s) proposed from analyst verdicts. They still need verification.`); await load(); onChange(); } catch (e) { setErr(errText(e, 'Import failed')); }
  };

  return (
    <section className="bg-[#111820] border border-white/10 rounded-xl p-4 space-y-3" aria-label="Feedback labels">
      <h2 className="text-white font-semibold">Labels</h2>
      <p className="text-xs text-gray-400">A label says a transaction was or was not fraud. Only labels verified by a <b>different</b> investigator can reach training data.</p>
      {msg && <p role="status" className="text-sm text-emerald-300">{msg}</p>}
      {err && <p role="alert" className="text-sm text-red-300">{err}</p>}
      <form onSubmit={propose} className="flex flex-wrap gap-3 items-end text-sm">
        <div><label htmlFor="fb-txn" className="block text-xs text-gray-400">Transaction ID</label>
          <input id="fb-txn" type="number" required value={form.transaction_id} onChange={(e) => setForm({ ...form, transaction_id: e.target.value })} className="w-28 bg-[#0a0f14] border border-white/20 rounded-lg px-2 py-1 text-white" /></div>
        <div><label htmlFor="fb-label" className="block text-xs text-gray-400">Outcome</label>
          <select id="fb-label" value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} className="bg-[#0a0f14] border border-white/20 rounded-lg px-2 py-1 text-white"><option value="fraud">Fraud</option><option value="legitimate">Legitimate</option></select></div>
        <div className="flex-1 min-w-[14rem]"><label htmlFor="fb-note" className="block text-xs text-gray-400">Evidence (at least 10 characters)</label>
          <input id="fb-note" required minLength={10} value={form.evidence_note} onChange={(e) => setForm({ ...form, evidence_note: e.target.value })} className="w-full bg-[#0a0f14] border border-white/20 rounded-lg px-2 py-1 text-white" /></div>
        <button type="submit" className="px-3 py-1.5 rounded-lg bg-cyan-600 text-white">Propose label</button>
        <button type="button" onClick={importOutcomes} className="px-3 py-1.5 rounded-lg border border-white/20 text-gray-200">Import analyst verdicts</button>
      </form>
      <div>
        <label htmlFor="fb-status" className="text-xs text-gray-400 mr-2">Show</label>
        <select id="fb-status" value={status} onChange={(e) => setStatus(e.target.value)} className="bg-[#0a0f14] border border-white/20 rounded-lg px-2 py-1 text-white text-sm">
          {['proposed', 'verified', 'rejected', 'withdrawn'].map((s) => <option key={s}>{s}</option>)}</select>
      </div>
      {!data ? <p className="text-sm text-gray-400">Loading…</p> : data.labels.length === 0 ? <p className="text-sm text-gray-400">No {status} labels.</p> : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm text-left">
            <caption className="sr-only">Feedback labels</caption>
            <thead className="text-xs text-gray-400"><tr><th scope="col" className="py-2 pr-3">Txn</th><th scope="col" className="pr-3">Outcome</th><th scope="col" className="pr-3">Source</th><th scope="col" className="pr-3">Proposed by</th><th scope="col" className="pr-3">Evidence</th><th scope="col">Actions</th></tr></thead>
            <tbody>
              {data.labels.map((l) => (
                <tr key={l.id} className="border-t border-white/10 align-top">
                  <td className="py-2 pr-3 text-white">#{l.transaction_id}</td><td className="pr-3 text-gray-200">{l.label}</td><td className="pr-3 text-gray-400">{l.source}</td>
                  <td className="pr-3 text-gray-400">{l.proposed_by_username || '—'}</td><td className="pr-3 text-gray-400 text-xs">{l.evidence_note}</td>
                  <td className="space-x-2 whitespace-nowrap">
                    {l.status === 'proposed' && <><button type="button" onClick={() => act(l.id, 'verify')} className="text-emerald-300 hover:underline" aria-label={`Verify label ${l.id}`}>Verify</button>
                      <button type="button" onClick={() => act(l.id, 'reject')} className="text-red-300 hover:underline" aria-label={`Reject label ${l.id}`}>Reject</button></>}
                    {(l.status === 'proposed' || l.status === 'verified') && <button type="button" onClick={() => act(l.id, 'withdraw')} className="text-gray-300 hover:underline" aria-label={`Withdraw label ${l.id}`}>Withdraw</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function Retraining({ readiness, refreshReadiness }) {
  const [datasets, setDatasets] = useState([]);
  const [runs, setRuns] = useState([]);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [note, setNote] = useState('');
  const load = useCallback(async () => {
    try {
      const [d, r] = await Promise.all([api.get('/feedback/retraining/datasets'), api.get('/feedback/retraining/runs')]);
      setDatasets(d.data.datasets); setRuns(r.data.runs);
    } catch (e) { setErr(errText(e, 'Could not load retraining state')); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const call = async (fn, ok) => { setErr(''); setMsg(''); try { await fn(); setMsg(ok); await load(); refreshReadiness(); } catch (e) { setErr(errText(e, 'Action failed')); } };
  const askNote = (what) => { const n = window.prompt(`Note for ${what} (required):`); return n && n.trim().length >= 5 ? n.trim() : null; };

  return (
    <section className="bg-[#111820] border border-white/10 rounded-xl p-4 space-y-3" aria-label="Controlled retraining">
      <h2 className="text-white font-semibold">Controlled retraining</h2>
      <p className="text-xs text-gray-400">Verified labels are frozen into a hashed dataset. A second administrator approves a run, and the ML service trains a <b>candidate</b> only. Nothing is served until the candidate passes the existing model-promotion workflow.</p>
      <p className="text-xs text-amber-300">{readiness.bias_note}</p>
      <p className="text-sm text-gray-200" data-testid="readiness">
        {readiness.verified_fraud} verified fraud · {readiness.verified_legitimate} verified legitimate (needs {readiness.minimum_per_class} of each).{' '}
        {readiness.ready ? 'Ready to build a dataset.' : `Missing: ${readiness.missing.join(' and ')}.`}
      </p>
      {msg && <p role="status" className="text-sm text-emerald-300">{msg}</p>}
      {err && <p role="alert" className="text-sm text-red-300">{err}</p>}
      <div className="flex flex-wrap items-end gap-3 text-sm">
        <div className="flex-1 min-w-[14rem]"><label htmlFor="rt-note" className="block text-xs text-gray-400">Reason for this dataset / run (at least 10 characters)</label>
          <input id="rt-note" value={note} onChange={(e) => setNote(e.target.value)} className="w-full bg-[#0a0f14] border border-white/20 rounded-lg px-2 py-1 text-white" /></div>
        <button type="button" disabled={!readiness.ready || note.trim().length < 10} onClick={() => call(() => api.post('/feedback/retraining/datasets', { note: note.trim() }), 'Dataset built and frozen.')}
          className="px-3 py-1.5 rounded-lg bg-cyan-600 text-white disabled:opacity-40">Build dataset</button>
      </div>

      <h3 className="text-sm text-white font-medium">Datasets</h3>
      {datasets.length === 0 ? <p className="text-sm text-gray-400">None yet.</p> : (
        <ul className="space-y-2">
          {datasets.map((d) => (
            <li key={d.id} className="bg-[#0a0f14] border border-white/10 rounded-lg p-3 text-sm">
              <div className="flex justify-between gap-2 flex-wrap">
                <span className="text-white">Dataset #{d.id} · {d.n_rows} rows <span className="text-xs text-gray-500">sha256 {d.content_sha256.slice(0, 12)}…</span></span>
                <button type="button" disabled={!note.trim() || note.trim().length < 10} onClick={() => call(() => api.post('/feedback/retraining/runs', { dataset_id: d.id, note: note.trim() }), 'Run requested; another administrator must approve it.')} className="text-cyan-300 hover:underline disabled:opacity-40">Request retraining run</button>
              </div>
              <p className="text-xs text-gray-400 mt-1">{d.composition.verified_fraud} verified fraud · {d.composition.verified_legitimate} verified legitimate · {d.composition.presumed_legitimate_rows} presumed legitimate (not verified) · fraud rate {d.composition.fraud_rate}</p>
            </li>
          ))}
        </ul>
      )}

      <h3 className="text-sm text-white font-medium">Runs</h3>
      {runs.length === 0 ? <p className="text-sm text-gray-400">None yet.</p> : (
        <ul className="space-y-2">
          {runs.map((r) => (
            <li key={r.id} className="bg-[#0a0f14] border border-white/10 rounded-lg p-3 text-sm">
              <div className="flex justify-between gap-2 flex-wrap">
                <span className="text-white">Run #{r.id} · dataset #{r.dataset_id} · <span className={RUN_TONE[r.status]}>{r.status.replace('_', ' ')}</span>{r.candidate_version ? ` · candidate ${r.candidate_version}` : ''}</span>
                <span className="space-x-3">
                  {r.status === 'pending_approval' && <>
                    <button type="button" onClick={() => { const n = askNote('approval'); if (n) call(() => api.post(`/feedback/retraining/runs/${r.id}/approve`, { note: n }), 'Run approved.'); }} className="text-emerald-300 hover:underline" aria-label={`Approve run ${r.id}`}>Approve</button>
                    <button type="button" onClick={() => { const n = askNote('rejection'); if (n) call(() => api.post(`/feedback/retraining/runs/${r.id}/reject`, { note: n }), 'Run rejected.'); }} className="text-red-300 hover:underline" aria-label={`Reject run ${r.id}`}>Reject</button></>}
                  {r.status === 'approved' && <button type="button" onClick={() => call(() => api.post(`/feedback/retraining/runs/${r.id}/start`), 'Training started in the ML service.')} className="text-cyan-300 hover:underline" aria-label={`Start run ${r.id}`}>Start training</button>}
                  {r.status === 'running' && <button type="button" onClick={() => call(() => api.get(`/feedback/retraining/runs/${r.id}`), 'Status refreshed.')} className="text-cyan-300 hover:underline" aria-label={`Refresh run ${r.id}`}>Refresh status</button>}
                </span>
              </div>
              {r.error && <p className="text-xs text-red-300 mt-1">{r.error}</p>}
              {r.status === 'candidate_ready' && <p className="text-xs text-emerald-300 mt-1">Candidate saved but NOT serving. Request promotion from the model change workflow (Admin → ML models).</p>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export default function FeedbackPage() {
  const [readiness, setReadiness] = useState(null);
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    setError('');
    try { setReadiness((await api.get('/feedback/retraining/readiness')).data); } catch (e) { setError(errText(e, 'Could not load feedback status')); }
  }, []);
  useEffect(() => { load(); }, [load]);
  if (error) return <ErrorState message={error} onRetry={load} />;
  if (!readiness) return <LoadingState label="Loading feedback..." />;
  return (
    <div className="space-y-4">
      <PageHeading icon={ClipboardCheck} title="Feedback & retraining" subtitle="Verify investigator labels, freeze them into a dataset, and train a candidate model under approval" />
      <Labels onChange={load} />
      <Retraining readiness={readiness} refreshReadiness={load} />
    </div>
  );
}
