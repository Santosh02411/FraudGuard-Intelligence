import React, { useState, useEffect, useCallback } from 'react';
import { api, useAuth } from '../../context/AuthContext';
import { LoadingState, ErrorState } from '../ui/States';

const STATUS_STYLE = {
  pending_approval: 'bg-yellow-500/15 text-yellow-400',
  applied: 'bg-green-500/15 text-green-400',
  rejected: 'bg-red-500/15 text-red-400',
  apply_failed: 'bg-red-500/15 text-red-400',
  cancelled: 'bg-gray-500/15 text-gray-400',
  approved: 'bg-blue-500/15 text-blue-400',
  applying: 'bg-blue-500/15 text-blue-400',
};
const GATE_STYLE = {
  pass: 'text-green-400', warn: 'text-yellow-400', insufficient: 'text-yellow-400', fail: 'text-red-400',
};
const TRIGGER_STYLE = { ok: 'text-green-400', warn: 'text-yellow-400', critical: 'text-red-400', insufficient_data: 'text-gray-400' };

function errorText(err, fallback) {
  const d = err.response?.data;
  if (d?.details?.code === 'GATES_BLOCK') return `Blocked by gates: ${d.details.gate_report.summary.blocking.join(', ')}`;
  if (d?.details?.code === 'CHECKLIST_INCOMPLETE') return `Confirm every checklist item (missing: ${d.details.missing.join(', ')})`;
  if (d?.details?.code === 'GATES_NOT_ACKNOWLEDGED') return `Acknowledge: ${d.details.missing.join(', ')}`;
  return d?.error || fallback;
}

function GateList({ report }) {
  if (!report) return null;
  return (
    <ul className="mt-2 space-y-1" aria-label="Gate report">
      {report.gates.map((g) => (
        <li key={g.id} className="text-xs">
          <span className={`font-semibold ${GATE_STYLE[g.status] || 'text-gray-300'}`}>{g.status.toUpperCase()}</span>{' '}
          <span className="text-gray-200">{g.title}</span>{g.hard ? <span className="text-gray-500"> (hard)</span> : null}
          <div className="text-gray-500">{g.detail}</div>
        </li>
      ))}
    </ul>
  );
}

function ChangeRow({ change, me, onChanged, onMessage }) {
  const [open, setOpen] = useState(change.status === 'pending_approval');
  const [note, setNote] = useState('');
  const [acks, setAcks] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const needs = change.gate_report?.summary?.needs_acknowledgement || [];
  const mine = change.requested_by === me;

  const act = async (verb, body) => {
    setBusy(true); setError('');
    try {
      await api.post(`/admin/ml/change-requests/${change.id}/${verb}`, body);
      onMessage?.(verb === 'approve' ? 'Approved and applied' : verb === 'reject' ? 'Rejected' : 'Cancelled', 'success');
      onChanged();
    } catch (err) {
      setError(errorText(err, `Could not ${verb}`));
      if (err.response?.status === 409) onChanged();
    } finally { setBusy(false); }
  };

  return (
    <div className="border border-white/10 rounded-lg mb-3">
      <button type="button" onClick={() => setOpen(!open)} className="w-full text-left px-4 py-3 flex flex-wrap items-center gap-3">
        <span className="text-white text-sm font-medium">#{change.id} {change.action} {change.from_version} → {change.target_version}</span>
        <span className={`text-xs px-2 py-0.5 rounded-full ${STATUS_STYLE[change.status] || ''}`}>{change.status.replace('_', ' ')}</span>
        <span className="text-gray-500 text-xs">requested by {change.requested_by_username || 'system'}{change.decided_by_username ? `, decided by ${change.decided_by_username}` : ''}</span>
      </button>
      {open && (
        <div className="px-4 pb-4 text-sm">
          <p className="text-gray-300"><span className="text-gray-500">Reason: </span>{change.reason}</p>
          {change.decision_note && <p className="text-gray-300 mt-1"><span className="text-gray-500">Decision note: </span>{change.decision_note}</p>}
          {change.apply_result?.error && <p className="text-red-400 mt-1">Not applied: {change.apply_result.error}</p>}
          <GateList report={change.gate_report} />
          {change.status === 'pending_approval' && (
            <div className="mt-3 space-y-2">
              {needs.length > 0 && (
                <fieldset className="border border-yellow-500/30 rounded p-2">
                  <legend className="text-xs text-yellow-400 px-1">Acknowledge the open items to approve</legend>
                  {needs.map((id) => (
                    <label key={id} className="flex items-center gap-2 text-xs text-gray-300">
                      <input type="checkbox" checked={acks.includes(id)} onChange={(e) => setAcks(e.target.checked ? [...acks, id] : acks.filter((a) => a !== id))} />
                      I have read and accept: {id}
                    </label>
                  ))}
                </fieldset>
              )}
              <textarea aria-label="Decision note" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note (at least 10 characters)" rows={2}
                className="w-full bg-[#0a0f14] border border-white/10 rounded-lg px-3 py-2 text-white text-sm" />
              {mine && <p className="text-xs text-gray-500">You requested this change; a different admin must approve it.</p>}
              <div className="flex gap-2">
                <button type="button" disabled={busy || mine} onClick={() => act('approve', { note, acknowledged_gates: acks, version: change.version })}
                  className="px-3 py-1.5 rounded-lg bg-green-600 text-white text-sm disabled:opacity-40">Approve &amp; apply</button>
                <button type="button" disabled={busy || mine} onClick={() => act('reject', { note, version: change.version })}
                  className="px-3 py-1.5 rounded-lg bg-red-600/80 text-white text-sm disabled:opacity-40">Reject</button>
                {mine && <button type="button" disabled={busy} onClick={() => act('cancel', {})} className="px-3 py-1.5 rounded-lg bg-white/10 text-white text-sm">Cancel request</button>}
              </div>
              {error && <p role="alert" className="text-red-400 text-xs">{error}</p>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function ModelChangesPanel({ onMessage }) {
  const { user } = useAuth();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [form, setForm] = useState({ action: 'promote', version: '', reason: '', checklist: {} });
  const [formError, setFormError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const load = useCallback(async () => {
    try {
      const [changes, checklist, versions, health] = await Promise.all([
        api.get('/admin/ml/change-requests'), api.get('/admin/ml/change-requests/checklist'),
        api.get('/admin/ml/versions'), api.get('/admin/ml/health').catch(() => ({ data: null })),
      ]);
      setData({ changes: changes.data.changes, checklists: checklist.data.checklists, versions: versions.data, health: health.data });
      setError('');
    } catch (err) { setError(errorText(err, 'Failed to load model changes')); }
  }, []);
  useEffect(() => { load(); }, [load]);

  if (error && !data) return <ErrorState message={error} onRetry={load} />;
  if (!data) return <LoadingState message="Loading model changes..." />;

  const active = data.versions.active;
  const items = data.checklists[form.action] || [];
  const candidates = (data.versions.versions || []).map((v) => v.version).filter((v) => v !== active);

  const submit = async (e) => {
    e.preventDefault();
    setSubmitting(true); setFormError('');
    try {
      await api.post('/admin/ml/change-requests', form);
      onMessage?.('Change requested; a second admin must approve it', 'success');
      setForm({ ...form, reason: '', checklist: {} });
      await load();
    } catch (err) { setFormError(errorText(err, 'Request failed')); } finally { setSubmitting(false); }
  };

  return (
    <div>
      <section className="bg-[#111820] border border-white/10 rounded-xl p-5 mb-6">
        <h3 className="text-white font-semibold">Serving model: {active || 'none'}</h3>
        <p className="text-gray-400 text-sm mt-1">Training only produces candidates. Changing the model needs gates, a checklist, a reason and a second admin&apos;s approval. Shadow-score agreement is not accuracy evidence and is not a gate.</p>
        {data.health && (
          <div className="mt-3" aria-label="Rollback triggers">
            <p className="text-xs text-gray-500">Rollback triggers (real traffic, last window) — overall <span className={TRIGGER_STYLE[data.health.status]}>{data.health.status}</span></p>
            <ul className="grid sm:grid-cols-2 gap-1 mt-1">
              {data.health.triggers.map((t) => (
                <li key={t.name} className="text-xs text-gray-300">{t.name}: <span className={TRIGGER_STYLE[t.status]}>{t.status.replace('_', ' ')}</span>{t.value !== undefined ? ` (${t.value}, limit ${t.limit})` : ''}</li>
              ))}
            </ul>
          </div>
        )}
      </section>

      <section className="bg-[#111820] border border-white/10 rounded-xl p-5 mb-6">
        <h3 className="text-white font-semibold mb-3">Request a model change</h3>
        <form onSubmit={submit} className="space-y-3">
          <div className="flex flex-wrap gap-3">
            <select aria-label="Action" value={form.action} onChange={(e) => setForm({ ...form, action: e.target.value, checklist: {} })} className="bg-[#0a0f14] border border-white/10 rounded-lg px-3 py-2 text-white text-sm">
              <option value="promote">Promote</option><option value="rollback">Roll back</option>
            </select>
            <select aria-label="Version" value={form.version} onChange={(e) => setForm({ ...form, version: e.target.value })} className="bg-[#0a0f14] border border-white/10 rounded-lg px-3 py-2 text-white text-sm">
              <option value="">Select version…</option>
              {candidates.map((v) => <option key={v} value={v}>{v}</option>)}
            </select>
          </div>
          <textarea aria-label="Reason" value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} rows={2} placeholder="Why (at least 20 characters) — kept permanently"
            className="w-full bg-[#0a0f14] border border-white/10 rounded-lg px-3 py-2 text-white text-sm" />
          <fieldset className="space-y-1">
            <legend className="text-xs text-gray-400 mb-1">Checklist</legend>
            {items.map((it) => (
              <label key={it.id} className="flex items-start gap-2 text-xs text-gray-300">
                <input type="checkbox" checked={!!form.checklist[it.id]} onChange={(e) => setForm({ ...form, checklist: { ...form.checklist, [it.id]: e.target.checked } })} />
                {it.label}
              </label>
            ))}
          </fieldset>
          {formError && <p role="alert" className="text-red-400 text-xs">{formError}</p>}
          <button type="submit" disabled={submitting || !form.version} className="px-4 py-2 rounded-lg bg-purple-600 text-white text-sm disabled:opacity-40">
            {submitting ? 'Running gates…' : 'Run gates & request'}
          </button>
        </form>
      </section>

      <section>
        <h3 className="text-white font-semibold mb-3">Promotion history</h3>
        {data.changes.length === 0 ? <p className="text-gray-500 text-sm">No model changes recorded yet.</p>
          : data.changes.map((c) => <ChangeRow key={`${c.id}-${c.version}`} change={c} me={user?.id} onChanged={load} onMessage={onMessage} />)}
      </section>
    </div>
  );
}
