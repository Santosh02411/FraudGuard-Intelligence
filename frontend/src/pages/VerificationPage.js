import React, { useState, useEffect, useCallback } from 'react';
import { ShieldQuestion } from 'lucide-react';
import { api } from '../context/AuthContext';
import PageHeading from '../components/ui/PageHeading';
import { LoadingState, ErrorState } from '../components/ui/States';

const ALLOWED = { low: ['approve'], medium: ['approve', 'challenge'], high: ['approve', 'challenge', 'decline'] };
const errText = (e, d) => { const x = e.response?.data; return x?.details?.problems?.join('; ') || x?.error || d; };
const pct = (v) => (v === null || v === undefined ? '—' : `${(v * 100).toFixed(1)}%`);
const money = (n) => `$${Number(n || 0).toLocaleString()}`;

function Stat({ label, value, hint }) {
  return (
    <div className="bg-[#0a0f14] border border-white/10 rounded-lg p-3">
      <p className="text-xs text-gray-400">{label}</p>
      <p className="text-xl text-white font-semibold tabular-nums">{value}</p>
      {hint && <p className="text-[11px] text-gray-500 mt-0.5">{hint}</p>}
    </div>
  );
}

function PolicyEditor({ active, onSaved }) {
  const [form, setForm] = useState(null);
  const [preview, setPreview] = useState(null);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (active) setForm({ mode: active.mode, actions: { ...active.actions }, min_amount: active.min_amount ?? '', ttl_seconds: active.ttl_seconds, note: '', confirm: false }); }, [active]);
  if (!form) return null;
  const body = () => ({ mode: form.mode, actions: form.actions, min_amount: form.min_amount === '' ? null : Number(form.min_amount), ttl_seconds: Number(form.ttl_seconds) });
  const setAction = (level, v) => { setPreview(null); setForm((f) => ({ ...f, actions: { ...f.actions, [level]: v } })); };

  const runPreview = async () => {
    setBusy(true); setErr('');
    try { setPreview((await api.post('/verification/policy/preview', { ...body(), days: 30 })).data); } catch (e) { setErr(errText(e, 'Preview failed')); } finally { setBusy(false); }
  };
  const save = async () => {
    setBusy(true); setErr(''); setMsg('');
    try { await api.put('/verification/policy', { ...body(), note: form.note, confirm_enforce: form.mode === 'enforce' ? form.confirm : undefined }); setMsg('Policy saved as a new version.'); onSaved(); } catch (e) { setErr(errText(e, 'Could not save the policy')); } finally { setBusy(false); }
  };

  return (
    <section className="bg-[#111820] border border-white/10 rounded-xl p-4 space-y-3" aria-label="Verification policy">
      <h2 className="text-white font-semibold">Policy <span className="text-xs text-gray-500 font-normal">v{active.version} · {active.mode}</span></h2>
      <p className="text-xs text-gray-400">FraudGuard recommends and records an action and holds or blocks the transaction in its own records. It never authorizes or moves a payment — your payment system does, and runs the actual OTP/3DS check. The live-feed demo never creates challenges.</p>
      <div className="flex flex-wrap gap-4 text-sm items-end">
        <div><label htmlFor="vp-mode" className="block text-xs text-gray-400">Mode</label>
          <select id="vp-mode" value={form.mode} onChange={(e) => { setPreview(null); setForm({ ...form, mode: e.target.value, confirm: false }); }} className="bg-[#0a0f14] border border-white/20 rounded-lg px-2 py-1 text-white">
            <option value="off">off (legacy)</option><option value="advisory">advisory (record only)</option><option value="enforce">enforce (hold / block)</option></select></div>
        {['low', 'medium', 'high'].map((lvl) => (
          <div key={lvl}><label htmlFor={`vp-${lvl}`} className="block text-xs text-gray-400">{lvl} risk</label>
            <select id={`vp-${lvl}`} value={form.actions[lvl]} onChange={(e) => setAction(lvl, e.target.value)} className="bg-[#0a0f14] border border-white/20 rounded-lg px-2 py-1 text-white">
              {ALLOWED[lvl].map((a) => <option key={a}>{a}</option>)}</select></div>
        ))}
        <div><label htmlFor="vp-min" className="block text-xs text-gray-400">Challenge only if amount ≥</label>
          <input id="vp-min" type="number" value={form.min_amount} onChange={(e) => setForm({ ...form, min_amount: e.target.value })} className="w-28 bg-[#0a0f14] border border-white/20 rounded-lg px-2 py-1 text-white" /></div>
        <div><label htmlFor="vp-ttl" className="block text-xs text-gray-400">Expires after (seconds)</label>
          <input id="vp-ttl" type="number" value={form.ttl_seconds} onChange={(e) => setForm({ ...form, ttl_seconds: e.target.value })} className="w-28 bg-[#0a0f14] border border-white/20 rounded-lg px-2 py-1 text-white" /></div>
      </div>
      {form.mode === 'off' && <p className="text-xs text-gray-500">Off: a medium-risk transaction is held only for accounts subscribed to <code>transaction.step_up_required</code>.</p>}
      {form.mode === 'enforce' && <p className="text-xs text-amber-300">Enforce: a challenge needs a way to reach the customer (a step_up_required webhook). Accounts without one are never held; they are recorded as unenforceable.</p>}
      <div className="flex flex-wrap gap-2 items-end">
        <button type="button" onClick={runPreview} disabled={busy} className="px-3 py-1.5 rounded-lg bg-cyan-600 text-white text-sm disabled:opacity-40">Preview on last 30 days</button>
        <label htmlFor="vp-note" className="sr-only">Change note</label>
        <input id="vp-note" value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} placeholder="Why (10+ chars)" className="bg-[#0a0f14] border border-white/20 rounded-lg px-2 py-1 text-sm text-white" />
        {form.mode === 'enforce' && <label className="flex items-center gap-1 text-sm text-gray-300"><input type="checkbox" checked={form.confirm} onChange={(e) => setForm({ ...form, confirm: e.target.checked })} /> I understand this changes real outcomes</label>}
        <button type="button" onClick={save} disabled={busy || form.note.trim().length < 10 || (form.mode === 'enforce' && !form.confirm)} className="px-3 py-1.5 rounded-lg bg-white/10 text-white text-sm disabled:opacity-40">Save policy</button>
      </div>
      {err && <p role="alert" className="text-sm text-red-400">{err}</p>}
      {msg && <p className="text-sm text-green-400">{msg}</p>}
      {preview && (
        <div className="text-sm text-gray-300 space-y-1" aria-label="Policy preview">
          <p>Of {preview.evaluated} recent transactions: <b>{preview.actions.challenge}</b> would be challenged ({pct(preview.share_challenged)}), <b>{preview.actions.decline}</b> declined ({pct(preview.share_declined)}), {preview.actions.approve} approved.</p>
          <p className="text-gray-400">Challenged, by known outcome: {preview.challenged_labels.fraud} fraud · {preview.challenged_labels.legit} confirmed legitimate · {preview.challenged_labels.unknown} unlabelled.</p>
          <ul className="text-xs text-gray-500 list-disc list-inside">{preview.caveats.map((c) => <li key={c}>{c}</li>)}</ul>
        </div>
      )}
    </section>
  );
}

function Effectiveness({ data }) {
  if (!data) return null;
  const c = data.challenges; const f = data.fraud_loss; const fr = data.friction;
  return (
    <section className="bg-[#111820] border border-white/10 rounded-xl p-4 space-y-3" aria-label="Effectiveness">
      <h2 className="text-white font-semibold">Effect of challenges <span className="text-xs text-gray-500 font-normal">last {data.window_days} days · {data.total_transactions} real transactions</span></h2>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <Stat label="Challenges issued" value={c.issued} hint={`${c.per_1000_transactions ?? '—'} per 1,000 transactions`} />
        <Stat label="Completed" value={c.verified} hint={`completion ${pct(c.completion_rate)}`} />
        <Stat label="Failed" value={c.failed} hint={`failure ${pct(c.failure_rate)}`} />
        <Stat label="Abandoned / expired" value={`${c.abandoned} / ${c.expired}`} hint={`non-completion ${pct(c.abandonment_rate)}`} />
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <Stat label="Fraud stopped by challenge" value={money(f.stopped_by_challenge.amount)} hint={`${f.stopped_by_challenge.count} transactions`} />
        <Stat label="Fraud that passed a challenge" value={money(f.passed_challenge.amount)} hint={`${f.passed_challenge.count} transactions`} />
        <Stat label="Flagged, not challenged, fraud" value={money(f.flagged_not_challenged.amount)} hint={`${f.flagged_not_challenged.count} transactions`} />
        <Stat label="Fraud stopped by decline" value={money(f.stopped_by_decline.amount)} hint={`${f.stopped_by_decline.count} transactions`} />
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <Stat label="Legit users challenged" value={fr.legit_confirmed_challenged} hint="analyst-confirmed" />
        <Stat label="…who did not complete" value={fr.legit_confirmed_not_completed} hint={money(fr.legit_confirmed_not_completed_amount)} />
        <Stat label="Unlabelled, not completed" value={fr.unlabelled_not_completed} hint="fraud or a customer who gave up — unknown" />
        <Stat label="Median time to complete" value={c.median_seconds_to_complete === null ? '—' : `${Math.round(c.median_seconds_to_complete)}s`} hint={`replays rejected: ${c.replay_attempts_rejected}`} />
      </div>
      <ul className="text-xs text-gray-500 list-disc list-inside space-y-0.5">{data.caveats.map((x) => <li key={x}>{x}</li>)}</ul>
    </section>
  );
}

export default function VerificationPage() {
  const [policy, setPolicy] = useState(null);
  const [eff, setEff] = useState(null);
  const [challenges, setChallenges] = useState(null);
  const [error, setError] = useState('');
  const [days, setDays] = useState(30);

  const load = useCallback(() => {
    setError('');
    Promise.all([api.get('/verification/policy'), api.get('/verification/effectiveness', { params: { days } }), api.get('/verification/challenges', { params: { limit: 25 } })])
      .then(([p, e, c]) => { setPolicy(p.data); setEff(e.data); setChallenges(c.data.challenges); })
      .catch((e) => setError(errText(e, 'Failed to load verification data')));
  }, [days]);
  useEffect(() => { load(); }, [load]);

  if (error) return <ErrorState message={error} onRetry={load} />;
  if (!policy) return <LoadingState label="Loading verification..." />;
  return (
    <div className="space-y-6 animate-page-in">
      <PageHeading icon={ShieldQuestion} title="Verification" subtitle="Decide which risk bands get extra verification, and measure what it does to fraud loss and to legitimate customers" />
      <PolicyEditor active={policy.active} onSaved={load} />
      <div className="flex items-center gap-2 text-sm"><label htmlFor="vf-days" className="text-gray-400">Window</label>
        <select id="vf-days" value={days} onChange={(e) => setDays(Number(e.target.value))} className="bg-[#0a0f14] border border-white/20 rounded-lg px-2 py-1 text-white">{[7, 30, 90].map((d) => <option key={d} value={d}>{d} days</option>)}</select></div>
      <Effectiveness data={eff} />
      <section className="bg-[#111820] border border-white/10 rounded-xl p-4" aria-label="Recent challenges">
        <h2 className="text-white font-semibold mb-2">Recent challenges</h2>
        {challenges && challenges.length === 0 && <p className="text-sm text-gray-500">No challenges yet.</p>}
        <ul className="text-sm text-gray-300 space-y-1">{(challenges || []).map((c) => (
          <li key={c.id}>#{c.id} · txn {c.transaction_id} · {c.risk_level || '—'} · <b>{c.status}</b>{c.replay_attempts > 0 && <span className="text-amber-300"> · {c.replay_attempts} replay(s) rejected</span>}</li>))}</ul>
      </section>
    </div>
  );
}
