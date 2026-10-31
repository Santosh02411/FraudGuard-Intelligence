import React, { useState, useEffect, useCallback } from 'react';
import { FlaskConical } from 'lucide-react';
import { api } from '../context/AuthContext';
import PageHeading from '../components/ui/PageHeading';
import { LoadingState, ErrorState, EmptyState } from '../components/ui/States';
import SimulationReport from '../components/rulelab/SimulationReport';

const STATUS_STYLE = {
  draft: 'bg-gray-500/20 text-gray-300', approved: 'bg-blue-500/20 text-blue-300', active: 'bg-green-500/20 text-green-300',
  rolled_back: 'bg-amber-500/20 text-amber-300', rejected: 'bg-red-500/20 text-red-300',
};
const RULE_TYPES = ['blacklist_merchant', 'blacklist_location', 'blacklist_device', 'blacklist_ip', 'amount_cap'];
const errText = (e, d) => { const x = e.response?.data; return x?.details?.problems?.join('; ') || x?.error || d; };

function describe(c) {
  if (c.op === 'add') return `Add ${c.rule_type}: ${c.value ?? `$${c.threshold}`}`;
  if (c.op === 'update') return `Update rule #${c.rule_id}: ${c.value ?? `$${c.threshold}`}`;
  return `${c.op[0].toUpperCase()}${c.op.slice(1)} rule #${c.rule_id}`;
}

function Builder({ onChange, state }) {
  const [type, setType] = useState('blacklist_merchant');
  const [val, setVal] = useState('');
  const [policy, setPolicy] = useState({ medium: '', high: '' });
  const [changes, setChanges] = useState([]);
  const [title, setTitle] = useState('');
  const [sim, setSim] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const policyChange = policy.medium && policy.high ? { medium_threshold: Number(policy.medium), high_threshold: Number(policy.high) } : null;
  const body = { rule_changes: changes, policy_change: policyChange };

  const addRule = () => {
    if (!val.trim()) return;
    setChanges((c) => [...c, type === 'amount_cap' ? { op: 'add', rule_type: type, threshold: Number(val) } : { op: 'add', rule_type: type, value: val.trim() }]);
    setVal(''); setSim(null);
  };
  const run = async () => {
    setBusy(true); setErr('');
    try { setSim((await api.post('/rule-proposals/simulate', body)).data); } catch (e) { setErr(errText(e, 'Simulation failed')); } finally { setBusy(false); }
  };
  const save = async () => {
    setBusy(true); setErr('');
    try { const r = await api.post('/rule-proposals', { title, ...body }); setChanges([]); setTitle(''); setSim(null); setPolicy({ medium: '', high: '' }); onChange(r.data.proposal.id); } catch (e) { setErr(errText(e, 'Could not save the draft')); } finally { setBusy(false); }
  };
  const empty = changes.length === 0 && !policyChange;

  return (
    <div className="bg-[#111820] border border-white/10 rounded-xl p-4 space-y-3">
      <h2 className="text-white font-semibold">Try a change</h2>
      <p className="text-xs text-gray-400">Nothing here touches live traffic. Simulate against history first, then save as a draft for approval.</p>
      <div className="flex flex-wrap items-end gap-2 text-sm">
        <div><label htmlFor="rl-type" className="block text-xs text-gray-400">Rule type</label>
          <select id="rl-type" value={type} onChange={(e) => setType(e.target.value)} className="bg-[#0a0f14] border border-white/20 rounded-lg px-2 py-1 text-white">{RULE_TYPES.map((t) => <option key={t}>{t}</option>)}</select></div>
        <div><label htmlFor="rl-val" className="block text-xs text-gray-400">{type === 'amount_cap' ? 'Cap ($)' : 'Value'}</label>
          <input id="rl-val" value={val} onChange={(e) => setVal(e.target.value)} className="bg-[#0a0f14] border border-white/20 rounded-lg px-2 py-1 text-white" /></div>
        <button type="button" onClick={addRule} className="px-3 py-1 rounded-lg bg-white/10 text-white">Add rule change</button>
      </div>
      <div className="flex flex-wrap items-end gap-2 text-sm">
        <div><label htmlFor="rl-med" className="block text-xs text-gray-400">Medium threshold{state?.policy ? ` (now ${state.policy.medium_threshold})` : ''}</label>
          <input id="rl-med" type="number" value={policy.medium} onChange={(e) => { setPolicy((p) => ({ ...p, medium: e.target.value })); setSim(null); }} className="w-24 bg-[#0a0f14] border border-white/20 rounded-lg px-2 py-1 text-white" /></div>
        <div><label htmlFor="rl-high" className="block text-xs text-gray-400">High threshold{state?.policy ? ` (now ${state.policy.high_threshold})` : ''}</label>
          <input id="rl-high" type="number" value={policy.high} onChange={(e) => { setPolicy((p) => ({ ...p, high: e.target.value })); setSim(null); }} className="w-24 bg-[#0a0f14] border border-white/20 rounded-lg px-2 py-1 text-white" /></div>
      </div>
      {changes.length > 0 && (
        <ul className="text-sm text-gray-200 space-y-1">{changes.map((c, i) => (
          <li key={`${describe(c)}-${i}`} className="flex items-center gap-2">{describe(c)}
            <button type="button" aria-label={`Remove change ${i + 1}`} onClick={() => { setChanges((x) => x.filter((_, j) => j !== i)); setSim(null); }} className="text-xs text-red-300">remove</button></li>))}</ul>
      )}
      {err && <p role="alert" className="text-sm text-red-400">{err}</p>}
      <div className="flex flex-wrap items-end gap-2">
        <button type="button" disabled={empty || busy} onClick={run} className="px-3 py-1.5 rounded-lg bg-cyan-600 disabled:opacity-40 text-white text-sm">Simulate on history</button>
        <div><label htmlFor="rl-title" className="sr-only">Draft title</label>
          <input id="rl-title" placeholder="Draft title" value={title} onChange={(e) => setTitle(e.target.value)} className="bg-[#0a0f14] border border-white/20 rounded-lg px-2 py-1 text-sm text-white" /></div>
        <button type="button" disabled={empty || busy || title.trim().length < 3} onClick={save} className="px-3 py-1.5 rounded-lg bg-white/10 disabled:opacity-40 text-white text-sm">Save as draft</button>
      </div>
      <SimulationReport sim={sim} />
    </div>
  );
}

function ProposalDetail({ id, onChanged }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [reason, setReason] = useState('');
  const load = useCallback(() => api.get(`/rule-proposals/${id}`).then((r) => setData(r.data)).catch((e) => setErr(errText(e, 'Failed to load proposal'))), [id]);
  useEffect(() => { setData(null); load(); }, [load]);
  const act = async (path, body = {}) => {
    setBusy(true); setErr('');
    try { await api.post(`/rule-proposals/${id}/${path}`, body); setReason(''); await load(); onChanged(); } catch (e) { setErr(errText(e, 'Action failed')); await load(); } finally { setBusy(false); }
  };
  if (err && !data) return <ErrorState message={err} onRetry={load} />;
  if (!data) return <LoadingState label="Loading proposal..." />;
  const p = data.proposal;
  return (
    <div className="bg-[#111820] border border-white/10 rounded-xl p-4 space-y-3">
      <div className="flex items-center gap-2"><h2 className="text-white font-semibold">#{p.id} {p.title}</h2>
        <span className={`text-xs px-2 py-0.5 rounded-full ${STATUS_STYLE[p.status]}`}>{p.status.replace('_', ' ')}</span></div>
      {p.description && <p className="text-sm text-gray-400">{p.description}</p>}
      <ul className="text-sm text-gray-200 list-disc list-inside">
        {p.rule_changes.map((c, i) => <li key={`${describe(c)}-${i}`}>{describe(c)}</li>)}
        {p.policy_change && <li>Risk policy → medium {p.policy_change.medium_threshold}, high {p.policy_change.high_threshold}</li>}
      </ul>
      {err && <p role="alert" className="text-sm text-red-400">{err}</p>}
      {p.status === 'draft' && !p.simulated_current && <p className="text-sm text-amber-300">Not simulated yet — approval requires a simulation of this exact content.</p>}
      <SimulationReport sim={p.simulation} />
      <div className="flex flex-wrap items-end gap-2 text-sm">
        {p.status === 'draft' && <button type="button" disabled={busy} onClick={() => act('simulate')} className="px-3 py-1.5 rounded-lg bg-cyan-600 text-white disabled:opacity-40">{p.simulation ? 'Re-run simulation' : 'Run simulation'}</button>}
        {p.status === 'draft' && <button type="button" disabled={busy || !p.simulated_current} onClick={() => act('approve')} className="px-3 py-1.5 rounded-lg bg-blue-600 text-white disabled:opacity-40">Approve</button>}
        {p.status === 'approved' && <button type="button" disabled={busy} onClick={() => act('activate')} className="px-3 py-1.5 rounded-lg bg-green-600 text-white disabled:opacity-40">Activate on live traffic</button>}
        {['draft', 'approved', 'active'].includes(p.status) && (
          <>
            <label htmlFor="rl-reason" className="sr-only">Reason</label>
            <input id="rl-reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason (10+ chars)" className="bg-[#0a0f14] border border-white/20 rounded-lg px-2 py-1 text-white" />
          </>
        )}
        {['draft', 'approved'].includes(p.status) && <button type="button" disabled={busy || reason.trim().length < 10} onClick={() => act('reject', { reason })} className="px-3 py-1.5 rounded-lg bg-red-600/80 text-white disabled:opacity-40">Reject</button>}
        {p.status === 'active' && <button type="button" disabled={busy || reason.trim().length < 10} onClick={() => act('rollback', { reason })} className="px-3 py-1.5 rounded-lg bg-amber-600 text-white disabled:opacity-40">Roll back</button>}
      </div>
      <details className="text-sm"><summary className="cursor-pointer text-gray-300">History</summary>
        <ul className="mt-2 text-gray-400 space-y-1">{data.events.map((e) => <li key={e.id}>{e.created_at?.slice(0, 16).replace('T', ' ')} · {e.actor_username} · {e.summary}</li>)}</ul></details>
    </div>
  );
}

export default function RuleLabPage() {
  const [list, setList] = useState(null);
  const [state, setState] = useState(null);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState(null);
  const [status, setStatus] = useState('');

  const load = useCallback(() => {
    setError('');
    const params = { page: 1, limit: 30 }; if (status) params.status = status;
    Promise.all([api.get('/rule-proposals', { params }), api.get('/rule-proposals/state')])
      .then(([l, s]) => { setList(l.data.proposals); setState(s.data); })
      .catch((e) => setError(errText(e, 'Failed to load Rule Lab')));
  }, [status]);
  useEffect(() => { load(); }, [load]);

  return (
    <div className="space-y-6 animate-page-in">
      <PageHeading icon={FlaskConical} title="Rule Lab" subtitle="Simulate a rule or policy change on history, compare it with today's policy, then approve, activate and — if needed — roll back" />
      {state?.require_proposal && <p className="text-sm text-cyan-300">Direct rule edits are disabled: every change goes through this lifecycle.</p>}
      {state && <p className="text-xs text-gray-500">Live: rule-set v{state.rule_version} · risk policy v{state.policy.version} (medium {state.policy.medium_threshold}, high {state.policy.high_threshold}) · {state.active_proposals.length} active proposal(s)</p>}
      <Builder state={state} onChange={(id) => { load(); setSelected(id); }} />
      <div className="grid lg:grid-cols-[320px_1fr] gap-4">
        <div className="bg-[#111820] border border-white/10 rounded-xl p-3 space-y-2">
          <label htmlFor="rl-status" className="block text-xs text-gray-400">Status</label>
          <select id="rl-status" value={status} onChange={(e) => setStatus(e.target.value)} className="bg-[#0a0f14] border border-white/20 rounded-lg px-2 py-1 text-sm text-white">
            <option value="">All</option>{Object.keys(STATUS_STYLE).map((s) => <option key={s} value={s}>{s.replace('_', ' ')}</option>)}</select>
          {error && <ErrorState message={error} onRetry={load} />}
          {!error && !list && <LoadingState label="Loading proposals..." />}
          {list && list.length === 0 && <EmptyState title="No proposals" subtitle="Simulate a change above and save it as a draft." />}
          <ul className="space-y-1">{(list || []).map((p) => (
            <li key={p.id}><button type="button" onClick={() => setSelected(p.id)} className={`w-full text-left px-2 py-1.5 rounded-lg text-sm ${selected === p.id ? 'bg-white/10' : 'hover:bg-white/5'} text-gray-200`}>
              <span>#{p.id} {p.title}</span> <span className={`ml-1 text-[11px] px-1.5 rounded-full ${STATUS_STYLE[p.status]}`}>{p.status.replace('_', ' ')}</span></button></li>))}</ul>
        </div>
        <div>{selected ? <ProposalDetail id={selected} onChanged={load} /> : <p className="text-sm text-gray-500 p-4">Select a proposal to review its simulation and take the next step.</p>}</div>
      </div>
    </div>
  );
}
