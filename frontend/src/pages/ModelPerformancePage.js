import React, { useState, useEffect, useCallback } from 'react';
import { api } from '../context/AuthContext';
import { LineChart, Download } from 'lucide-react';
import PageHeading from '../components/ui/PageHeading';
import { LoadingState, ErrorState } from '../components/ui/States';
import { downloadBlobResponse, downloadJson } from '../utils/download';
import TrendChart from '../components/performance/TrendChart';
import ModelHealthPanel from '../components/performance/ModelHealthPanel';

const pct = (v) => (v === null || v === undefined ? '—' : `${(v * 100).toFixed(1)}%`);
const ci = (a) => (a && a[0] !== null && a[1] !== null ? `${(a[0] * 100).toFixed(0)}–${(a[1] * 100).toFixed(0)}%` : null);
const DIMENSIONS = [['risk_band', 'Risk band'], ['category', 'Category'], ['merchant', 'Merchant'], ['customer_cohort', 'Customer cohort']];

function Metric({ label, value, range, sub, low }) {
  return (
    <div className="bg-[#111820] border border-white/10 rounded-xl p-4" data-testid={`metric-${label}`}>
      <p className="text-gray-400 text-xs">{label}</p>
      <p className="text-2xl font-bold text-white tabular-nums">{value}</p>
      {range && <p className="text-xs text-gray-500">95% CI {range}</p>}
      {sub && <p className="text-xs text-gray-500 mt-1">{sub}</p>}
      {low && <p className="text-xs text-yellow-400 mt-1">Low sample, treat as indicative</p>}
    </div>
  );
}

function BreakdownTable({ rows }) {
  if (!rows?.length) return <p className="text-sm text-gray-500 p-4">No flagged transactions in this window.</p>;
  return (
    <table className="w-full text-sm">
      <thead><tr className="text-left text-gray-400 text-xs"><th className="p-2">Segment</th><th>Flagged</th><th>Reviewed</th><th>Confirmed</th><th>False pos.</th><th>Unreviewed</th><th>Precision</th></tr></thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.key} className="border-t border-white/5 text-gray-200">
            <td className="p-2 font-medium">{r.key}</td><td>{r.flagged}</td><td>{r.reviewed}</td><td>{r.confirmed_fraud}</td><td>{r.false_positives}</td><td>{r.unreviewed}</td>
            <td>{pct(r.precision)}{ci(r.precision_ci) && <span className="text-xs text-gray-500"> ({ci(r.precision_ci)})</span>}{r.low_sample && <span className="ml-1 text-xs text-yellow-400">low n</span>}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function PerformanceView() {
  const [days, setDays] = useState(90);
  const [maturity, setMaturity] = useState(30);
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [dim, setDim] = useState('risk_band');
  const [exportError, setExportError] = useState('');

  const load = useCallback(() => {
    setLoading(true); setError('');
    api.get('/admin/model-performance', { params: { days, maturity_days: maturity } })
      .then((r) => setData(r.data))
      .catch((e) => setError(e.response?.data?.error || 'Failed to load model performance'))
      .finally(() => setLoading(false));
  }, [days, maturity]);
  useEffect(() => { load(); }, [load]);

  const exportCsv = async () => {
    setExportError('');
    try { downloadBlobResponse(await api.get('/admin/model-performance', { params: { days, maturity_days: maturity, format: 'csv' }, responseType: 'blob' }), 'model-performance.csv'); }
    catch { setExportError('Export failed'); }
  };

  const o = data?.overall; const f = data?.feedback; const cmp = data?.version_comparison;
  return (
    <div className="space-y-6 animate-page-in">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <PageHeading icon={LineChart} title="Model performance" subtitle="Predictions compared with what investigators and customers later confirmed" />
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <label className="text-gray-400" htmlFor="mp-days">Window</label>
          <select id="mp-days" value={days} onChange={(e) => setDays(Number(e.target.value))} className="bg-[#0a0f14] border border-white/20 rounded-lg px-2 py-1 text-white">
            {[30, 90, 180, 365].map((d) => <option key={d} value={d}>{d} days</option>)}
          </select>
          <label className="text-gray-400" htmlFor="mp-mat">Presume legitimate after</label>
          <select id="mp-mat" value={maturity} onChange={(e) => setMaturity(Number(e.target.value))} className="bg-[#0a0f14] border border-white/20 rounded-lg px-2 py-1 text-white">
            {[14, 30, 60, 90].map((d) => <option key={d} value={d}>{d} days</option>)}
          </select>
          <button type="button" onClick={exportCsv} disabled={!data} className="flex items-center gap-1 bg-white/5 hover:bg-white/10 disabled:opacity-40 text-gray-200 px-3 py-1.5 rounded-lg"><Download size={14} /> CSV</button>
          <button type="button" onClick={() => downloadJson(data, 'model-performance.json')} disabled={!data} className="flex items-center gap-1 bg-white/5 hover:bg-white/10 disabled:opacity-40 text-gray-200 px-3 py-1.5 rounded-lg"><Download size={14} /> JSON report</button>
        </div>
      </div>
      {exportError && <p className="text-red-400 text-sm">{exportError}</p>}

      {loading && <LoadingState label="Computing performance from outcomes..." />}
      {error && <ErrorState message={error} onRetry={load} />}

      {data && !loading && (
        <>
          <section aria-label="Headline metrics" className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <Metric label="Precision" value={pct(o.precision)} range={ci(o.precision_ci)} sub={`${o.confirmed_fraud} confirmed of ${o.reviewed} reviewed alerts`} low={o.low_sample} />
            <Metric label="Recall (estimate)" value={pct(o.recall_estimate)} range={ci(o.recall_ci)} sub={`${o.missed_candidates} unflagged transactions disputed by customers`} />
            <Metric label="False-positive rate (estimate)" value={pct(o.false_positive_rate_estimate)} range={ci(o.fpr_ci)} sub={`${o.false_positives} false positives / ${o.presumed_legitimate} presumed legitimate`} />
            <Metric label="PR-AUC" value={o.pr_auc === null ? '—' : o.pr_auc.toFixed(3)} sub={`baseline ${o.pr_auc_baseline ?? '—'} · reviewed-only ${o.pr_auc_reviewed_only === null ? '—' : o.pr_auc_reviewed_only.toFixed(3)}`} />
          </section>

          <section aria-label="Outcome feedback" className="bg-[#111820] border border-white/10 rounded-xl p-4">
            <h2 className="text-white font-semibold mb-3">Outcome feedback loop</h2>
            <dl className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
              <div><dt className="text-gray-400">Flagged predictions</dt><dd className="text-white text-xl tabular-nums">{f.flagged_predictions}</dd></div>
              <div><dt className="text-gray-400">Unreviewed</dt><dd className="text-white text-xl tabular-nums" data-testid="unreviewed">{f.unreviewed_predictions}</dd><dd className="text-xs text-gray-500">{f.unreviewed_older_than_24h} over 24h · {f.unreviewed_older_than_7d} over 7d{f.oldest_unreviewed_hours !== null ? ` · oldest ${f.oldest_unreviewed_hours}h` : ''}</dd></div>
              <div><dt className="text-gray-400">Confirmed outcomes</dt><dd className="text-white text-xl tabular-nums">{f.confirmed_outcomes}</dd><dd className="text-xs text-gray-500">{f.confirmed_fraud} fraud · {f.false_positives} false positive</dd></div>
              <div><dt className="text-gray-400">Review coverage</dt><dd className="text-white text-xl tabular-nums">{pct(f.review_coverage)}</dd><dd className="text-xs text-gray-500">{f.unflagged_disputes} unflagged disputes</dd></div>
            </dl>
          </section>

          <section aria-label="Trend" className="bg-[#111820] border border-white/10 rounded-xl p-4">
            <div className="flex items-center justify-between mb-2">
              <h2 className="text-white font-semibold">By week</h2>
              <span className="text-xs text-gray-400"><span className="text-cyan-400">● precision</span> &nbsp; <span className="text-orange-400">● recall (est.)</span> &nbsp; hollow = low sample</span>
            </div>
            {data.over_time.length === 0
              ? <p className="text-sm text-gray-500">No transactions in this window.</p>
              : <TrendChart points={data.over_time} series={[{ key: 'precision', label: 'precision', color: '#22d3ee' }, { key: 'recall_estimate', label: 'recall', color: '#fb923c' }]} />}
          </section>

          <section aria-label="Model versions" className="bg-[#111820] border border-white/10 rounded-xl p-4">
            <h2 className="text-white font-semibold mb-2">Model versions</h2>
            {cmp && (
              <div className="mb-3 rounded-lg bg-white/5 p-3 text-sm text-gray-200" data-testid="comparison">
                <strong>{cmp.current}</strong> vs previous <strong>{cmp.previous}</strong>: precision {cmp.delta.precision === null ? '—' : `${cmp.delta.precision >= 0 ? '+' : ''}${(cmp.delta.precision * 100).toFixed(1)} pts`}, PR-AUC {cmp.delta.pr_auc === null ? '—' : `${cmp.delta.pr_auc >= 0 ? '+' : ''}${cmp.delta.pr_auc.toFixed(3)}`}.{' '}
                {cmp.precision_difference_significant === true && 'The precision gap is statistically distinguishable.'}
                {cmp.precision_difference_significant === false && 'Not enough reviewed cases to call this difference real.'}
                <p className="text-xs text-gray-500 mt-1">{cmp.note}</p>
              </div>
            )}
            <table className="w-full text-sm">
              <thead><tr className="text-left text-gray-400 text-xs"><th className="p-2">Version</th><th>First seen</th><th>Flagged</th><th>Reviewed</th><th>Precision</th><th>Recall (est.)</th><th>PR-AUC</th></tr></thead>
              <tbody>
                {data.versions.map((v) => (
                  <tr key={v.version} className="border-t border-white/5 text-gray-200">
                    <td className="p-2 font-medium">{v.version}</td><td>{v.first_seen.slice(0, 10)}</td><td>{v.flagged}</td><td>{v.reviewed}</td><td>{pct(v.precision)}</td><td>{pct(v.recall_estimate)}</td><td>{v.pr_auc === null ? '—' : v.pr_auc.toFixed(3)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          <section aria-label="Breakdown" className="bg-[#111820] border border-white/10 rounded-xl p-4">
            <div className="flex flex-wrap gap-2 mb-3" role="tablist">
              {DIMENSIONS.map(([k, label]) => (
                <button key={k} role="tab" aria-selected={dim === k} onClick={() => setDim(k)} className={`px-3 py-1 rounded-lg text-sm ${dim === k ? 'bg-cyan-500/10 text-cyan-300' : 'text-gray-400 hover:bg-white/5'}`}>{label}</button>
              ))}
            </div>
            <BreakdownTable rows={data.breakdowns[dim]} />
          </section>

          <section aria-label="Caveats" className="rounded-xl border border-yellow-500/20 bg-yellow-500/5 p-4">
            <h2 className="text-yellow-300 font-semibold text-sm mb-1">Read these before acting on the numbers</h2>
            <ul className="list-disc pl-5 text-xs text-gray-300 space-y-1">{data.caveats.map((c) => <li key={c}>{c}</li>)}</ul>
          </section>
        </>
      )}
    </div>
  );
}

export default function ModelPerformancePage() {
  const [tab, setTab] = useState('performance');
  const tabs = [['performance', 'Performance'], ['health', 'Health & drift']];
  return (
    <div className="space-y-4">
      <div role="tablist" aria-label="Model views" className="flex gap-1 border-b border-white/10">
        {tabs.map(([key, label]) => (
          <button key={key} role="tab" type="button" aria-selected={tab === key} onClick={() => setTab(key)}
            className={`px-4 py-2 text-sm -mb-px border-b-2 ${tab === key ? 'border-cyan-400 text-white' : 'border-transparent text-gray-400 hover:text-gray-200'}`}>{label}</button>
        ))}
      </div>
      {tab === 'performance' ? <PerformanceView /> : <ModelHealthPanel />}
    </div>
  );
}
