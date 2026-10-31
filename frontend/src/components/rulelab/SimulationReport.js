import React from 'react';

const pct = (v) => (v === null || v === undefined ? '—' : `${(v * 100).toFixed(1)}%`);
const sign = (n) => (n > 0 ? `+${n}` : `${n}`);

function Row({ label, cur, prop, delta, hint }) {
  return (
    <tr className="border-t border-white/5">
      <th scope="row" className="text-left font-normal text-gray-300 py-1.5 pr-3">{label}{hint && <span className="block text-[11px] text-gray-500">{hint}</span>}</th>
      <td className="text-right text-gray-200 tabular-nums">{cur}</td>
      <td className="text-right text-white tabular-nums">{prop}</td>
      <td className="text-right text-cyan-300 tabular-nums">{delta}</td>
    </tr>
  );
}

/** Current vs proposed policy on the same history. Estimates are labelled as estimates. */
export default function SimulationReport({ sim }) {
  if (!sim) return null;
  const c = sim.current; const p = sim.proposed; const d = sim.delta;
  return (
    <section aria-label="Simulation result" className="space-y-4">
      <p className="text-sm text-gray-300">
        Replayed <b>{sim.evaluated}</b> transactions from the last {sim.window_days} days ({sim.labelled} with usable labels).
        {sim.truncated && <span className="text-amber-300"> Window truncated at the row cap.</span>}
      </p>
      {sim.warnings?.length > 0 && (
        <ul role="alert" className="space-y-1 bg-amber-500/10 border border-amber-500/30 rounded-lg p-3 text-sm text-amber-200 list-disc list-inside">
          {sim.warnings.map((w) => <li key={w}>{w}</li>)}
        </ul>
      )}
      <table className="w-full text-sm">
        <thead><tr className="text-xs text-gray-400"><th className="text-left font-normal">Metric</th><th className="text-right font-normal">Current</th><th className="text-right font-normal">Proposed</th><th className="text-right font-normal">Change</th></tr></thead>
        <tbody>
          <Row label="Transactions flagged" cur={c.flagged} prop={p.flagged} delta={`${sign(d.flagged)} (${sign(d.flagged_per_day)}/day)`} />
          <Row label="Fraud caught" hint="confirmed or disputed" cur={c.tp} prop={p.tp} delta={sign(d.true_positives)} />
          <Row label="Likely false positives" hint="analyst false-positive or presumed legitimate (estimate)" cur={c.fp} prop={p.fp} delta={sign(d.false_positives)} />
          <Row label="Fraud missed" hint="disputed but not flagged" cur={c.fn} prop={p.fn} delta={sign(d.missed_fraud)} />
          <Row label="Precision" hint="of labelled flags" cur={pct(c.precision)} prop={pct(p.precision)} delta={d.precision === null ? '—' : `${d.precision > 0 ? '+' : ''}${(d.precision * 100).toFixed(1)} pts`} />
          <Row label="False-positive rate (estimate)" cur={pct(c.false_positive_rate_estimate)} prop={pct(p.false_positive_rate_estimate)} delta="" />
          <Row label="Flagged, no label yet" cur={c.unlabelled_flagged} prop={p.unlabelled_flagged} delta="" />
        </tbody>
      </table>
      <div className="grid sm:grid-cols-2 gap-3 text-sm">
        <div className="bg-[#0a0f14] border border-white/10 rounded-lg p-3">
          <h4 className="text-gray-200 font-medium">Newly flagged: {sim.newly_flagged.count}</h4>
          <p className="text-gray-400">{sim.newly_flagged.likely_fraud} likely fraud · {sim.newly_flagged.likely_legitimate} likely legitimate · {sim.newly_flagged.unlabelled} unlabelled</p>
        </div>
        <div className="bg-[#0a0f14] border border-white/10 rounded-lg p-3">
          <h4 className="text-gray-200 font-medium">No longer flagged: {sim.no_longer_flagged.count}</h4>
          <p className="text-gray-400">{sim.no_longer_flagged.likely_fraud} likely fraud · {sim.no_longer_flagged.likely_legitimate} likely legitimate · {sim.no_longer_flagged.unlabelled} unlabelled</p>
        </div>
      </div>
      {sim.newly_flagged.sample.length > 0 && (
        <details className="text-sm"><summary className="cursor-pointer text-gray-300">Sample of newly flagged transactions</summary>
          <ul className="mt-2 space-y-1 text-gray-400">{sim.newly_flagged.sample.map((t) => <li key={t.id}>#{t.id} · {t.merchant} · ${t.amount} · {t.label}</li>)}</ul>
        </details>
      )}
      <details className="text-xs text-gray-500"><summary className="cursor-pointer">What this estimate cannot tell you</summary>
        <ul className="list-disc list-inside mt-1 space-y-1">{sim.caveats.map((x) => <li key={x}>{x}</li>)}</ul></details>
    </section>
  );
}
