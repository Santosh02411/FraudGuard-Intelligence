import React, { useEffect, useState } from 'react';
import { api } from '../../context/AuthContext';

const money = (n) => `$${Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
const pct = (n) => (n === null || n === undefined ? '–' : `${Math.round(n * 100)}%`);

function Tile({ label, value, tone = '' }) {
  return (
    <div className="rounded-lg bg-white/5 px-3 py-2">
      <div className={`text-lg font-semibold tabular-nums ${tone}`}>{value}</div>
      <div className="text-[11px] text-gray-400">{label}</div>
    </div>
  );
}

/** Team numbers for the last 30 days: queue health, SLA, verdict mix and money. */
export default function CaseMetrics() {
  const [m, setM] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => { api.get('/alerts/metrics', { params: { days: 30 } }).then((r) => (r.data?.open ? setM(r.data) : setError('Case metrics unavailable'))).catch(() => setError('Case metrics unavailable')); }, []);
  if (error) return <p className="text-xs text-gray-500 mb-4">{error}</p>;
  if (!m) return null;
  const { open, resolved, amounts } = m;
  return (
    <section aria-label="Case metrics" className="mb-4 bg-[#111820] border border-white/10 rounded-xl p-4">
      <h2 className="text-sm font-semibold text-white mb-3">Team queue <span className="text-gray-500 font-normal">· resolved figures cover the last {m.window_days} days</span></h2>
      <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-2">
        <Tile label="Open cases" value={open.total} />
        <Tile label="Overdue" value={open.overdue} tone={open.overdue ? 'text-red-400' : ''} />
        <Tile label="Escalated" value={open.escalated} tone={open.escalated ? 'text-orange-400' : ''} />
        <Tile label="Unassigned" value={open.unassigned} />
        <Tile label="Confirmed fraud" value={resolved.confirmed_fraud} />
        <Tile label="False-positive rate" value={pct(resolved.false_positive_rate)} />
        <Tile label="SLA met" value={pct(resolved.sla_met_rate)} />
        <Tile label="Median time to resolve" value={resolved.median_minutes_to_resolve === null ? '–' : `${resolved.median_minutes_to_resolve} min`} />
        <Tile label="Loss" value={money(amounts.loss)} />
        <Tile label="Recovered" value={`${money(amounts.recovered)} (${pct(amounts.recovery_rate)})`} />
        <Tile label="Prevented" value={money(amounts.prevented)} />
        <Tile label="Fraud amount w/o outcome data" value={amounts.cases_without_amounts} />
      </div>
    </section>
  );
}
