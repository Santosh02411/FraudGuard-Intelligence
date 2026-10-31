import React, { useState, useEffect, useCallback } from 'react';
import { api } from '../../context/AuthContext';
import { LoadingState, ErrorState } from '../ui/States';

const SOURCE_LABEL = { ml: 'ML model', hard_rule: 'Hard-rule override', fallback: 'Fallback (rule engine)' };

function Thresholds({ t }) {
  if (!t) return null;
  if (t.basis === 'risk_policy') return <>policy v{t.policy_version ?? '?'}: medium ≥ {t.medium_threshold}, high ≥ {t.high_threshold}</>;
  if (t.basis === 'rule_engine_fixed') return <>fixed rule-engine thresholds: medium ≥ {t.medium_threshold}, high ≥ {t.high_threshold}</>;
  if (t.basis === 'hard_rule_override') return <>fixed by a hard rule (thresholds not applied)</>;
  return <>{t.note || 'not recorded'}</>;
}

function DecisionCard({ d }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="rounded border border-gray-700 p-3 text-sm" data-testid={`decision-${d.seq}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-semibold text-gray-100">#{d.seq} {d.decision_type === 'original' ? 'Original decision' : 'Rescore'}</span>
        <span className="rounded bg-gray-700 px-2 py-0.5 text-xs">{SOURCE_LABEL[d.decision_source] || d.decision_source}</span>
        {d.decision_type === 'rescore' && (
          <span className={`rounded px-2 py-0.5 text-xs ${d.applied ? 'bg-yellow-500/15 text-yellow-400' : 'bg-gray-600/40 text-gray-300'}`}>
            {d.applied ? 'applied' : 'recorded only (not applied)'}
          </span>
        )}
        {d.origin === 'backfill' && <span className="rounded bg-yellow-500/15 px-2 py-0.5 text-xs text-yellow-400">reconstructed, inputs not captured</span>}
        <span className="ml-auto text-xs text-gray-500">{new Date(d.created_at).toLocaleString()}</span>
      </div>
      <div className="mt-1 text-gray-300">
        {d.risk_level} risk, score {Number(d.fraud_score).toFixed(1)}{d.is_fraud ? ', flagged fraud' : ''}
      </div>
      <dl className="mt-2 grid grid-cols-[auto,1fr] gap-x-3 gap-y-1 text-xs text-gray-400">
        <dt>Model</dt><dd>{d.model_version || 'none'}{d.calibrated === false ? ' (uncalibrated)' : ''}</dd>
        <dt>Rule set</dt><dd>{d.ruleset_version ? `v${d.ruleset_version}` : 'not recorded'}</dd>
        <dt>Thresholds</dt><dd><Thresholds t={d.thresholds} /></dd>
        {d.actor_username && (<><dt>By</dt><dd>{d.actor_username}: {d.reason}</dd></>)}
      </dl>
      {d.reasons?.length > 0 && <ul className="mt-2 list-disc pl-5 text-xs text-gray-300">{d.reasons.map((r) => <li key={r}>{r}</li>)}</ul>}
      <button type="button" className="mt-2 text-xs text-blue-400 underline" onClick={() => setOpen(!open)} aria-expanded={open}>
        {open ? 'Hide' : 'Show'} feature snapshot
      </button>
      {open && (
        d.feature_snapshot
          ? <pre className="mt-1 max-h-48 overflow-auto rounded bg-gray-900 p-2 text-xs">{JSON.stringify(d.feature_snapshot, null, 2)}</pre>
          : <p className="mt-1 text-xs text-gray-500">{d.redacted_at ? `Redacted by the retention policy on ${new Date(d.redacted_at).toLocaleDateString()}.` : 'No snapshot was captured for this decision.'}</p>
      )}
    </li>
  );
}

export default function DecisionHistoryPanel({ transactionId }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [reason, setReason] = useState('');
  const [apply, setApply] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [rescoreError, setRescoreError] = useState(null);

  const load = useCallback(() => api.get(`/admin/transactions/${transactionId}/decision-history`)
    .then((r) => { setData(r.data); setError(null); })
    .catch((e) => setError(e.response?.data?.error || 'Could not load the decision history')), [transactionId]);
  useEffect(() => { load(); }, [load]);

  const rescore = async () => {
    setBusy(true); setRescoreError(null); setResult(null);
    try {
      const r = await api.post(`/admin/transactions/${transactionId}/rescore`, { reason, apply });
      setResult(r.data);
      setReason('');
      await load();
    } catch (e) {
      setRescoreError(e.response?.data?.error || 'Rescore failed');
    } finally { setBusy(false); }
  };

  if (error) return <ErrorState message={error} />;
  if (!data) return <LoadingState label="Loading decision history" />;

  return (
    <section aria-label="Decision history" className="mt-6 rounded-lg border border-gray-700 p-4">
      <h2 className="text-lg font-semibold">Decision history</h2>
      <p className="text-xs text-gray-400">Append-only. Original decisions are never overwritten; a rescore adds a record.</p>
      <p className={`mt-1 text-xs ${data.chain.valid ? 'text-green-400' : 'text-red-400'}`} role="status">
        {data.chain.valid ? `Hash chain verified (${data.chain.records} record${data.chain.records === 1 ? '' : 's'})` : `Hash chain BROKEN: ${data.chain.problems.join('; ')}`}
      </p>
      {data.holds?.some((h) => !h.released_at) && <p className="mt-1 text-xs text-yellow-400">Legal hold active: this history is exempt from retention deletion.</p>}

      <ol className="mt-3 space-y-2">
        {data.timeline.map((e, i) => e.kind === 'decision'
          ? <DecisionCard key={`d${e.seq}`} d={e.decision} />
          : (
            <li key={`a${i}`} className="rounded border border-gray-800 p-2 text-xs text-gray-300" data-testid="audit-event">
              <span className="font-medium">{e.action}</span> by {e.actor || 'system'} ({e.outcome}) · {new Date(e.at).toLocaleString()}
              {e.details?.before && e.details?.after && (
                <div className="text-gray-500">{JSON.stringify(e.details.before)} → {JSON.stringify(e.details.after)}</div>
              )}
            </li>
          ))}
      </ol>

      <div className="mt-4 border-t border-gray-700 pt-3">
        <h3 className="text-sm font-semibold">Rescore with the current model and rules</h3>
        <label className="mt-1 block text-xs text-gray-400" htmlFor="rescore-reason">Reason (recorded)</label>
        <input id="rescore-reason" className="w-full rounded bg-gray-800 p-2 text-sm" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why are you rescoring this transaction?" />
        <label className="mt-2 flex items-center gap-2 text-xs text-gray-300">
          <input type="checkbox" checked={apply} onChange={(e) => setApply(e.target.checked)} />
          Apply the new decision (otherwise it is recorded only; the current decision stays)
        </label>
        <button type="button" disabled={busy || reason.trim().length < 10} onClick={rescore} className="mt-2 rounded bg-blue-600 px-3 py-1 text-sm disabled:opacity-50">
          {busy ? 'Rescoring…' : apply ? 'Rescore and apply' : 'Rescore (record only)'}
        </button>
        {rescoreError && <p role="alert" className="mt-2 text-xs text-red-400">{rescoreError}</p>}
        {result && (
          <p role="status" className="mt-2 text-xs text-gray-300">
            Recorded as #{result.recorded_seq}{result.applied ? ' and applied' : ' (not applied)'}.{' '}
            {Object.keys(result.changed).length === 0 ? 'The decision would not change.' : `Would change: ${Object.entries(result.changed).map(([k, v]) => `${k} ${v.before} → ${v.after}`).join(', ')}.`}
          </p>
        )}
      </div>
    </section>
  );
}
