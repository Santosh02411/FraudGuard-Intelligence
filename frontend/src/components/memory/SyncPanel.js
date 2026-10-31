import React, { useState } from 'react';
import { RefreshCw, Loader2, Clock3, ShieldCheck, CheckCircle2, AlertTriangle, XCircle } from 'lucide-react';
import { api } from '../../context/AuthContext';

const STATUS_STYLE = { completed: 'text-emerald-300', completed_with_errors: 'text-amber-300', failed: 'text-red-300', running: 'text-cyan-300', abandoned: 'text-gray-400' };
const STATUS_ICON = { completed: CheckCircle2, completed_with_errors: AlertTriangle, failed: XCircle, running: Loader2 };
const fmt = (v) => (v ? new Date(v).toLocaleString() : '—');

export default function SyncPanel({ stats, runs, connected, onChanged }) {
  const [busy, setBusy] = useState(null);
  const [message, setMessage] = useState(null);
  const sync = stats?.sync;

  const run = async (body, label) => {
    setBusy(label); setMessage(null);
    try {
      const { data } = await api.post('/cognee-memory/sync', body);
      setMessage({ tone: data.failed ? 'amber' : 'green', text: `Sync ${data.status.replace(/_/g, ' ')}: ${data.ingested} sent, ${data.skippedUnchanged} unchanged${data.failed ? `, ${data.failed} failed` : ''}${data.morePending ? ' — more records pending, run again' : ''}.` });
    } catch (err) {
      setMessage({ tone: 'red', text: err.response?.data?.error || err.response?.data?.message || 'Synchronisation failed.' });
    } finally { setBusy(null); onChanged?.(); }
  };

  const tones = { green: 'border-emerald-500/20 bg-emerald-500/10 text-emerald-200', amber: 'border-amber-500/30 bg-amber-500/10 text-amber-200', red: 'border-red-500/30 bg-red-500/10 text-red-300' };
  return (
    <section className="rounded-2xl border border-white/10 bg-[#111923] p-4 sm:p-5 space-y-4" aria-label="Synchronisation">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h2 className="text-white font-semibold flex items-center gap-2"><ShieldCheck size={18} className="text-emerald-400" /> Synchronisation</h2>
          <p className="text-sm text-gray-400 mt-0.5">Read-only copy of minimised, pseudonymised records. Unchanged records are never re-sent.</p>
        </div>
        <div className="flex gap-2">
          <button onClick={() => run({ mode: 'incremental' }, 'inc')} disabled={!connected || !!busy || sync?.running} className="inline-flex items-center gap-2 rounded-lg bg-cyan-500 hover:bg-cyan-400 text-slate-950 font-semibold px-3.5 py-2 text-sm disabled:opacity-40 disabled:cursor-not-allowed">
            {busy === 'inc' ? <Loader2 size={15} className="animate-spin" /> : <RefreshCw size={15} />}Sync now
          </button>
          <button onClick={() => run({ mode: 'full' }, 'full')} disabled={!connected || !!busy || sync?.running} title="Re-checks every record in the lookback window; only changed ones are sent" className="rounded-lg border border-white/10 px-3 py-2 text-sm text-gray-300 hover:bg-white/5 disabled:opacity-40">Full re-scan</button>
        </div>
      </div>

      <dl className="grid grid-cols-2 lg:grid-cols-4 gap-3 text-sm">
        <div className="rounded-xl bg-black/20 border border-white/5 p-3"><dt className="text-gray-500 text-xs uppercase tracking-wide">Last successful sync</dt><dd className="text-gray-200 mt-1 flex items-center gap-1.5"><Clock3 size={14} className="text-cyan-400" />{fmt(sync?.lastSuccessfulSyncAt)}</dd></div>
        <div className="rounded-xl bg-black/20 border border-white/5 p-3"><dt className="text-gray-500 text-xs uppercase tracking-wide">Waiting to sync</dt><dd className="text-gray-200 mt-1">{sync?.pendingNewTransactions ?? '—'} new transactions</dd></div>
        <div className="rounded-xl bg-black/20 border border-white/5 p-3"><dt className="text-gray-500 text-xs uppercase tracking-wide">Scheduler</dt><dd className="text-gray-200 mt-1">{sync?.scheduler?.intervalMs > 0 ? (sync.scheduler.enabled ? `every ${Math.round(sync.scheduler.intervalMs / 60000)} min` : 'configured, not running') : 'off (manual)'}</dd></div>
        <div className="rounded-xl bg-black/20 border border-white/5 p-3"><dt className="text-gray-500 text-xs uppercase tracking-wide">Synced / failed</dt><dd className="text-gray-200 mt-1">{(sync?.records?.transaction?.synced ?? 0) + (sync?.records?.investigation?.synced ?? 0)} / <span className={(sync?.records?.transaction?.failed || sync?.records?.investigation?.failed) ? 'text-red-300' : ''}>{(sync?.records?.transaction?.failed ?? 0) + (sync?.records?.investigation?.failed ?? 0)}</span></dd></div>
      </dl>

      {message && <div role="status" className={`rounded-xl border p-3 text-sm ${tones[message.tone]}`}>{message.text}</div>}

      <div>
        <h3 className="text-sm font-medium text-white mb-2">Recent ingestion activity</h3>
        {(!runs || runs.length === 0) ? <p className="text-sm text-gray-500">No synchronisation has run yet.</p> : (
          <div className="overflow-x-auto rounded-xl border border-white/10">
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase tracking-wide text-gray-500 bg-black/20"><tr><th className="px-3 py-2">When</th><th className="px-3 py-2">Trigger</th><th className="px-3 py-2">Status</th><th className="px-3 py-2 text-right">Sent</th><th className="px-3 py-2 text-right">Unchanged</th><th className="px-3 py-2 text-right">Failed</th></tr></thead>
              <tbody className="divide-y divide-white/5">
                {runs.map((r) => { const Icon = STATUS_ICON[r.status]; return (
                  <tr key={r.id} className="text-gray-300">
                    <td className="px-3 py-2 whitespace-nowrap">{fmt(r.startedAt)}</td>
                    <td className="px-3 py-2">{r.trigger === 'scheduler' ? 'scheduled' : `manual${r.actor ? ` (${r.actor})` : ''}`}{r.mode === 'full' ? ' · full' : ''}</td>
                    <td className={`px-3 py-2 ${STATUS_STYLE[r.status] || ''}`}><span className="inline-flex items-center gap-1">{Icon && <Icon size={13} className={r.status === 'running' ? 'animate-spin' : ''} />}{r.status.replace(/_/g, ' ')}</span>{r.error && <div className="text-[11px] text-red-300/80 max-w-xs truncate" title={r.error}>{r.error}</div>}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{r.ingested}</td><td className="px-3 py-2 text-right tabular-nums">{r.skippedUnchanged}</td><td className="px-3 py-2 text-right tabular-nums">{r.failed}</td>
                  </tr>); })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}
