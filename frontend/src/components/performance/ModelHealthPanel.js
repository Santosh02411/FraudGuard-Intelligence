import React, { useState, useEffect, useCallback } from 'react';
import { api } from '../../context/AuthContext';
import { LoadingState, ErrorState } from '../ui/States';

const pct = (v, d = 1) => (v === null || v === undefined ? '—' : `${(v * 100).toFixed(d)}%`);
const ms = (v) => (v === null || v === undefined ? '—' : `${Math.round(v)} ms`);
const errText = (e, d) => { const x = e.response?.data; return x?.details?.problems?.join('; ') || x?.error || d; };
const STATUS_STYLE = { stable: 'text-green-400', moderate_drift: 'text-amber-300', significant_drift: 'text-red-400', insufficient_data: 'text-gray-400', ok: 'text-green-400' };
const SEV_STYLE = { critical: 'bg-red-500/20 text-red-300', warn: 'bg-amber-500/20 text-amber-300' };
const KIND_LABEL = { input_shift: 'Input shift', data_quality: 'Data quality', accuracy: 'Accuracy' };

function Tile({ label, value, sub, testId }) {
  return (
    <div className="bg-[#0a0f14] border border-white/10 rounded-lg p-3" data-testid={testId}>
      <p className="text-xs text-gray-400">{label}</p>
      <p className="text-xl text-white font-semibold tabular-nums">{value}</p>
      {sub && <p className="text-[11px] text-gray-500 mt-0.5">{sub}</p>}
    </div>
  );
}

/** Dependency-free sparkline; null = gap. */
function Spark({ values, label, max, thresholds = [] }) {
  const W = 260; const H = 46; const clean = values.filter((v) => v !== null && v !== undefined);
  if (clean.length < 2) return <p className="text-xs text-gray-500">{label}: not enough history yet</p>;
  const hi = Math.max(max ?? 0, ...clean, ...thresholds.map((t) => t.value)) || 1;
  const x = (i) => (i * (W - 4)) / (values.length - 1) + 2;
  const y = (v) => H - 4 - (v / hi) * (H - 8);
  const pts = values.map((v, i) => (v === null || v === undefined ? null : `${x(i)},${y(v)}`)).filter(Boolean).join(' ');
  return (
    <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label} className="w-full max-w-xs">
      {thresholds.map((t) => <line key={t.label} x1="0" x2={W} y1={y(t.value)} y2={y(t.value)} stroke={t.color} strokeDasharray="3 3"><title>{`${t.label} ${t.value}`}</title></line>)}
      <polyline points={pts} fill="none" stroke="#22d3ee" strokeWidth="2" />
    </svg>
  );
}

function AlertRow({ a, onAck, busy }) {
  const [note, setNote] = useState('');
  const d = a.details || {};
  return (
    <li className="border border-white/10 rounded-lg p-3 space-y-1.5 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className={`text-xs px-2 py-0.5 rounded-full ${SEV_STYLE[a.severity] || 'bg-white/10 text-gray-300'}`}>{a.severity}</span>
        <span className="text-white font-medium">{a.trigger_name.replace(/_/g, ' ')}</span>
        <span className="text-gray-400">{a.scope}</span>
        <span className="text-[11px] text-gray-500">{KIND_LABEL[a.kind] || a.kind}</span>
        {a.acknowledged && <span className="text-[11px] text-cyan-300">acknowledged{a.acknowledged_by_username ? ` by ${a.acknowledged_by_username}` : ''}</span>}
      </div>
      {d.value !== undefined && d.value !== null && <p className="text-gray-300">Value {typeof d.value === 'number' ? d.value : '—'} (warn {d.warn}, critical {d.critical}){d.top_features?.length ? ` · top: ${d.top_features.map((f) => f.feature).join(', ')}` : ''}{d.top_missing_fields?.length ? ` · missing: ${d.top_missing_fields.map((f) => f.name).join(', ')}` : ''}</p>}
      {d.message && <p className="text-gray-300">{d.message}</p>}
      {d.interpretation && <p className="text-xs text-gray-500">{d.interpretation}</p>}
      {d.quality_evidence && (
        <p className="text-xs text-cyan-200" data-testid="quality-evidence">
          Accuracy evidence: {d.quality_evidence.status === 'no_labels_yet' ? 'no labels yet — cannot tell whether accuracy changed' : d.quality_evidence.status === 'decline_observed' ? 'precision decline also observed' : `no precision decline observed (precision ${pct(d.quality_evidence.precision)} over ${d.quality_evidence.reviewed} reviewed)`}
        </p>
      )}
      {!a.acknowledged && (
        <div className="flex gap-2 items-center">
          <label className="sr-only" htmlFor={`ack-${a.id}`}>Acknowledgement note</label>
          <input id={`ack-${a.id}`} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note (5+ chars)" className="bg-[#0a0f14] border border-white/20 rounded-lg px-2 py-1 text-white text-xs" />
          <button type="button" disabled={busy || note.trim().length < 5} onClick={() => onAck(a.id, note)} className="px-2 py-1 rounded-lg bg-white/10 text-white text-xs disabled:opacity-40">Acknowledge</button>
        </div>
      )}
    </li>
  );
}

function SettingsEditor({ data, onSaved }) {
  const [form, setForm] = useState(null);
  const [note, setNote] = useState('');
  const [err, setErr] = useState('');
  const [ok, setOk] = useState('');
  useEffect(() => { if (data) setForm({ psi_warn: data.settings.psi_warn, psi_critical: data.settings.psi_critical, score_psi_warn: data.settings.score_psi_warn, score_psi_critical: data.settings.score_psi_critical, missing_rate_warn: data.settings.missing_rate_warn, missing_rate_critical: data.settings.missing_rate_critical }); }, [data]);
  if (!form) return null;
  const field = (key, label) => (
    <div key={key}><label htmlFor={`st-${key}`} className="block text-xs text-gray-400">{label}</label>
      <input id={`st-${key}`} type="number" step="0.01" value={form[key]} onChange={(e) => setForm({ ...form, [key]: e.target.value })} className="w-24 bg-[#0a0f14] border border-white/20 rounded-lg px-2 py-1 text-white text-sm" /></div>
  );
  const save = async () => {
    setErr(''); setOk('');
    try { await api.put('/model-monitoring/settings', { ...Object.fromEntries(Object.entries(form).map(([k, v]) => [k, Number(v)])), note }); setOk('Thresholds saved.'); setNote(''); onSaved(); } catch (e) { setErr(errText(e, 'Could not save thresholds')); }
  };
  return (
    <details className="bg-[#111820] border border-white/10 rounded-xl p-4">
      <summary className="text-white font-semibold cursor-pointer">Alert thresholds</summary>
      <div className="mt-3 flex flex-wrap gap-3 items-end">
        {field('psi_warn', 'Feature PSI warn')}{field('psi_critical', 'Feature PSI critical')}
        {field('score_psi_warn', 'Score PSI warn')}{field('score_psi_critical', 'Score PSI critical')}
        {field('missing_rate_warn', 'Missing-input rate warn')}{field('missing_rate_critical', 'Missing-input rate critical')}
        <div><label htmlFor="st-note" className="block text-xs text-gray-400">Why (10+ chars)</label>
          <input id="st-note" value={note} onChange={(e) => setNote(e.target.value)} className="bg-[#0a0f14] border border-white/20 rounded-lg px-2 py-1 text-white text-sm" /></div>
        <button type="button" disabled={note.trim().length < 10} onClick={save} className="px-3 py-1.5 rounded-lg bg-white/10 text-white text-sm disabled:opacity-40">Save thresholds</button>
      </div>
      {err && <p role="alert" className="text-sm text-red-400 mt-2">{err}</p>}
      {ok && <p className="text-sm text-green-400 mt-2">{ok}</p>}
      <p className="text-xs text-gray-500 mt-2">PSI guide: under 0.1 little change · 0.1–0.25 moderate · over 0.25 significant. Drift alerts never roll a model back; they ask a person to look.</p>
    </details>
  );
}

export default function ModelHealthPanel() {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [segWindow, setSegWindow] = useState('');
  const [segments, setSegments] = useState(null);
  const [trend, setTrend] = useState([]);
  const [busy, setBusy] = useState(false);
  const [runMsg, setRunMsg] = useState('');

  const load = useCallback(() => {
    setError('');
    api.get('/model-monitoring/overview').then((r) => {
      setData(r.data);
      setSegWindow((w) => w || Object.keys(r.data.latest_drift)[0] || '24h');
    }).catch((e) => setError(errText(e, 'Failed to load model health')));
  }, []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (!segWindow) return;
    api.get('/model-monitoring/segments', { params: { window: segWindow } }).then((r) => setSegments(r.data.segments)).catch(() => setSegments([]));
    api.get('/model-monitoring/snapshots', { params: { window: segWindow, dim: 'all', limit: 48 } }).then((r) => setTrend(r.data.snapshots)).catch(() => setTrend([]));
  }, [segWindow, data]);

  const ack = async (id, note) => {
    setBusy(true);
    try { await api.post(`/model-monitoring/alerts/${id}/acknowledge`, { note }); load(); } catch (e) { setError(errText(e, 'Could not acknowledge')); } finally { setBusy(false); }
  };
  const run = async () => {
    setBusy(true); setRunMsg('');
    try { const r = (await api.post('/model-monitoring/run')).data; setRunMsg(`Evaluated: ${r.snapshots} snapshots, ${r.alerts_opened} opened, ${r.alerts_cleared} cleared${r.errors.length ? ` · ${r.errors.length} error(s): ${r.errors[0]}` : ''}`); load(); } catch (e) { setRunMsg(errText(e, 'Run failed')); } finally { setBusy(false); }
  };

  if (error && !data) return <ErrorState message={error} onRetry={load} />;
  if (!data) return <LoadingState label="Loading model health..." />;
  const o = data.operations; const s = data.settings;
  const failKinds = Object.entries(o.failures_by_kind || {}).map(([k, n]) => `${k} ${n}`).join(' · ');
  return (
    <div className="space-y-6" aria-label="Model health">
      <p className="text-sm text-cyan-200 bg-cyan-500/10 border border-cyan-500/20 rounded-lg px-3 py-2">{data.interpretation}</p>
      {error && <p role="alert" className="text-sm text-red-400">{error}</p>}
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <button type="button" onClick={run} disabled={busy} className="px-3 py-1.5 rounded-lg bg-cyan-600 text-white disabled:opacity-40">Evaluate now</button>
        <span className="text-gray-400">Model {data.version || '—'}{data.last_run ? ` · last evaluated ${new Date(data.last_run.at).toLocaleString()}` : ' · not evaluated yet'}</span>
        {runMsg && <span className="text-gray-300">{runMsg}</span>}
      </div>

      <section aria-label="Open alerts" className="bg-[#111820] border border-white/10 rounded-xl p-4">
        <h2 className="text-white font-semibold mb-2">Open alerts <span className="text-xs text-gray-500 font-normal">{data.open_alerts.length}</span></h2>
        {data.open_alerts.length === 0 ? <p className="text-sm text-gray-500">No open alerts. Thresholds in force: feature PSI {s.psi_warn}/{s.psi_critical}, score PSI {s.score_psi_warn}/{s.score_psi_critical}.</p>
          : <ul className="space-y-2">{data.open_alerts.map((a) => <AlertRow key={a.id} a={a} onAck={ack} busy={busy} />)}</ul>}
      </section>

      <section aria-label="Operations" className="bg-[#111820] border border-white/10 rounded-xl p-4 space-y-3">
        <h2 className="text-white font-semibold">Operations <span className="text-xs text-gray-500 font-normal">last {o.window_hours}h · {o.n} inferences</span></h2>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          <Tile label="Latency p50 / p95" value={`${ms(o.latency_p50_ms)} / ${ms(o.latency_p95_ms)}`} sub={`max ${ms(o.latency_max_ms)}`} testId="tile-latency" />
          <Tile label="Fallback-scoring rate" value={pct(o.fallback_rate)} sub="scored by the rule engine because the ML call failed" testId="tile-fallback" />
          <Tile label="Prediction failures" value={o.prediction_failures} sub={failKinds || 'none'} testId="tile-failures" />
          <Tile label="Inferences with missing inputs" value={pct(o.missing_rate)} sub={o.top_missing_fields.length ? o.top_missing_fields.map((f) => `${f.name} ${f.count}`).join(', ') : 'none'} testId="tile-missing" />
        </div>
        {o.unseen_categories.length > 0 && <p className="text-xs text-amber-300">Values the model never saw in training: {o.unseen_categories.map((u) => `${u.name} (${u.count})`).join(', ')}</p>}
        <div className="grid sm:grid-cols-3 gap-3">
          <Spark label="Fallback rate by hour" values={o.series.map((x) => x.fallback_rate)} max={0.1} />
          <Spark label="p95 latency by hour" values={o.series.map((x) => x.latency_p95_ms)} />
          <Spark label="Missing-input rate by hour" values={o.series.map((x) => x.missing_rate)} max={0.05} />
        </div>
      </section>

      <section aria-label="Drift" className="bg-[#111820] border border-white/10 rounded-xl p-4 space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="text-white font-semibold">Drift against training data</h2>
          <label htmlFor="mh-window" className="text-xs text-gray-400">Window</label>
          <select id="mh-window" value={segWindow} onChange={(e) => setSegWindow(e.target.value)} className="bg-[#0a0f14] border border-white/20 rounded-lg px-2 py-1 text-white text-sm">{Object.keys(data.latest_drift).map((w) => <option key={w}>{w}</option>)}</select>
        </div>
        <div className="grid sm:grid-cols-2 gap-3">
          {Object.entries(data.latest_drift).map(([w, snap]) => (
            <div key={w} className="bg-[#0a0f14] border border-white/10 rounded-lg p-3 text-sm" data-testid={`drift-${w}`}>
              <p className="text-gray-400 text-xs">Last {w}</p>
              {snap ? (<>
                <p className={`font-medium ${STATUS_STYLE[snap.status]}`}>{snap.status.replace('_', ' ')}</p>
                <p className="text-gray-300">Worst feature PSI {snap.max_psi ?? '—'} · score PSI {snap.score_psi ?? '—'} · n {snap.n}</p>
                {snap.feature_psi?.top && <p className="text-xs text-gray-500">{snap.feature_psi.top.slice(0, 3).map((f) => `${f.feature} ${f.psi}`).join(' · ')}</p>}
              </>) : <p className="text-gray-500">No evaluation yet</p>}
            </div>
          ))}
        </div>
        <Spark label={`Worst feature PSI over time (${segWindow})`} values={trend.map((t) => t.max_psi)} thresholds={[{ label: 'warn', value: s.psi_warn, color: '#f59e0b' }, { label: 'critical', value: s.psi_critical, color: '#ef4444' }]} />
        <h3 className="text-sm text-gray-200 font-medium">By customer segment</h3>
        {segments && segments.length === 0 && <p className="text-sm text-gray-500">No segment has enough traffic to judge yet.</p>}
        {segments && segments.length > 0 && (
          <table className="w-full text-sm">
            <thead><tr className="text-xs text-gray-400 text-left"><th className="font-normal">Segment</th><th className="font-normal text-right">n</th><th className="font-normal text-right">Worst PSI</th><th className="font-normal text-right">Score PSI</th><th className="font-normal">Status</th></tr></thead>
            <tbody>{segments.map((g) => (
              <tr key={`${g.segment_dim}=${g.segment_value}`} className="border-t border-white/5 text-gray-200">
                <td>{g.segment_dim === 'all' ? 'All traffic' : `${g.segment_dim}: ${g.segment_value}`}</td><td className="text-right tabular-nums">{g.n}</td>
                <td className="text-right tabular-nums">{g.max_psi ?? '—'}</td><td className="text-right tabular-nums">{g.score_psi ?? '—'}</td><td className={STATUS_STYLE[g.status]}>{g.status.replace('_', ' ')}</td>
              </tr>))}</tbody>
          </table>
        )}
      </section>

      <section aria-label="Model quality" className="bg-[#111820] border border-white/10 rounded-xl p-4 space-y-2">
        <h2 className="text-white font-semibold">Quality from confirmed outcomes</h2>
        {data.quality_trend.length === 0 && <p className="text-sm text-gray-500">No evaluation yet.</p>}
        {data.quality_trend.length > 0 && (() => {
          const last = data.quality_trend[data.quality_trend.length - 1]; const q = last.quality;
          return q && last.status === 'ok'
            ? (<><p className="text-sm text-gray-200">Precision <b>{pct(q.precision)}</b> ({q.precision_ci ? `${(q.precision_ci[0] * 100).toFixed(0)}–${(q.precision_ci[1] * 100).toFixed(0)}%` : '—'}) over {q.reviewed} reviewed alerts · recall estimate {pct(q.recall_estimate)} · review coverage {pct(q.review_coverage)}</p>
              <Spark label="Precision trend" values={data.quality_trend.map((t) => (t.quality && t.status === 'ok' ? t.quality.precision : null))} max={1} /></>)
            : <p className="text-sm text-gray-400" data-testid="quality-insufficient">Not enough analyst-reviewed alerts yet ({q?.reviewed ?? 0} of {q?.floor ?? s.min_reviewed_for_quality}) — accuracy cannot be tracked, so drift cannot be confirmed or dismissed as an accuracy problem.</p>;
        })()}
        <p className="text-xs text-gray-500">Labels arrive days after predictions and cover mostly flagged transactions, so this lags drift and is selection-biased toward what the model already flagged.</p>
      </section>

      {data.shadow && (
        <section aria-label="Shadow model" className="bg-[#111820] border border-white/10 rounded-xl p-4 text-sm text-gray-300">
          <h2 className="text-white font-semibold mb-1">Shadow model</h2>
          <p>Challenger {data.shadow.shadow_version} vs {data.shadow.primary_version}: risk-level agreement {pct(data.shadow.risk_level_agreement_rate)} over {data.shadow.n_compared ?? 0} comparisons{data.shadow.mean_absolute_score_diff !== undefined ? ` · mean score difference ${data.shadow.mean_absolute_score_diff}` : ''}.</p>
        </section>
      )}
      <SettingsEditor data={data} onSaved={load} />
    </div>
  );
}
