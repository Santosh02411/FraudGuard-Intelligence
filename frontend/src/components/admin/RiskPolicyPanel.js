import React, { useState, useEffect, useCallback } from 'react';
import { api } from '../../context/AuthContext';
import { LoadingState, ErrorState } from '../ui/States';
import StatCard from '../ui/StatCard';

const STATUS_STYLE = {
  consistent: 'bg-green-500/15 text-green-400',
  drifting: 'bg-red-500/15 text-red-400',
  insufficient_data: 'bg-gray-500/15 text-gray-400',
};
const STATUS_LABEL = {
  consistent: 'Scores match outcomes',
  drifting: 'Scores no longer match outcomes',
  insufficient_data: 'Not enough reviewed alerts',
};

const pct = (x) => (x === null || x === undefined ? '—' : `${Math.round(x * 1000) / 10}%`);
const signed = (n) => (n > 0 ? `+${n}` : `${n}`);

function Section({ title, children, hint }) {
  return (
    <section className="bg-[#111820] border border-white/10 rounded-xl mb-6">
      <div className="p-5 border-b border-white/10">
        <h3 className="text-white font-semibold">{title}</h3>
        {hint && <p className="text-gray-400 text-sm mt-1">{hint}</p>}
      </div>
      <div className="p-5">{children}</div>
    </section>
  );
}

function DeltaRow({ label, current, candidate, delta, goodWhenLower }) {
  const bad = goodWhenLower ? delta > 0 : delta < 0;
  const tone = delta === 0 ? 'text-gray-400' : bad ? 'text-red-400' : 'text-green-400';
  return (
    <tr className="border-b border-white/5">
      <td className="px-4 py-2 text-gray-300 text-sm">{label}</td>
      <td className="px-4 py-2 text-white text-sm tabular-nums">{current}</td>
      <td className="px-4 py-2 text-white text-sm tabular-nums">{candidate}</td>
      <td className={`px-4 py-2 text-sm tabular-nums ${tone}`}>{delta === undefined ? '' : signed(delta)}</td>
    </tr>
  );
}

export default function RiskPolicyPanel({ onMessage }) {
  const [data, setData] = useState(null);
  const [calibration, setCalibration] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [medium, setMedium] = useState('');
  const [high, setHigh] = useState('');
  const [capacity, setCapacity] = useState('');
  const [note, setNote] = useState('');
  const [days, setDays] = useState(30);
  const [sim, setSim] = useState(null);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [p, c] = await Promise.all([
        api.get('/admin/risk-policy'),
        api.get('/admin/risk-policy/calibration', { params: { days } }),
      ]);
      setData(p.data);
      setCalibration(c.data);
      setMedium(String(p.data.active.medium_threshold));
      setHigh(String(p.data.active.high_threshold));
      setCapacity(p.data.active.review_capacity_per_day ? String(p.data.active.review_capacity_per_day) : '');
    } catch (e) {
      setError(e.response?.data?.error || 'Failed to load risk policy');
    } finally {
      setLoading(false);
    }
  }, [days]);

  useEffect(() => { load(); }, [load]);

  const payload = () => ({
    medium_threshold: Number(medium),
    high_threshold: Number(high),
    review_capacity_per_day: capacity === '' ? null : Number(capacity),
  });

  const errMsg = (e, fallback) => {
    const d = e.response?.data;
    return d?.details?.map?.((x) => x.message).join('; ') || d?.error || fallback;
  };

  const runSimulation = async () => {
    setBusy(true);
    setFormError('');
    try {
      const { data: s } = await api.post('/admin/risk-policy/simulate', { ...payload(), days });
      setSim(s);
    } catch (e) {
      setSim(null);
      setFormError(errMsg(e, 'Simulation failed'));
    } finally {
      setBusy(false);
    }
  };

  const save = async (e) => {
    e.preventDefault();
    setBusy(true);
    setFormError('');
    try {
      await api.put('/admin/risk-policy', { ...payload(), note });
      setNote('');
      setSim(null);
      onMessage?.('Risk policy saved as a new version. It applies to the next transaction scored.');
      await load();
    } catch (err) {
      setFormError(errMsg(err, 'Could not save policy'));
    } finally {
      setBusy(false);
    }
  };

  if (loading && !data) return <LoadingState label="Loading risk policy..." />;
  if (error) return <ErrorState message={error} onRetry={load} />;

  const { active, history, limits, score_meaning: scoreMeaning } = data;
  const input = 'w-full bg-[#0b1118] border border-white/10 rounded-lg px-3 py-2 text-white text-sm';

  return (
    <div>
      <div className="bg-blue-500/10 border border-blue-500/30 text-blue-200 rounded-lg px-4 py-3 text-sm mb-6">
        <strong className="font-semibold">What a score means.</strong> {scoreMeaning}
      </div>

      <div className="stagger grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        <StatCard title="Policy version" value={`v${active.version}`} />
        <StatCard title="Review at score ≥" value={active.medium_threshold} color="text-yellow-400" />
        <StatCard title="Treat as fraud at score ≥" value={active.high_threshold} color="text-red-400" />
        <StatCard title="Review capacity / day" value={active.review_capacity_per_day ?? 'not set'} />
      </div>

      <Section
        title="Does a score still mean what it claims?"
        hint="Predicted probability vs the fraud rate analysts actually confirmed, per score band. Only flagged transactions are ever reviewed, so this covers scores from the review threshold upward."
      >
        <div className="flex items-center gap-3 mb-4 flex-wrap">
          <span data-testid="calibration-status" className={`px-2.5 py-1 rounded text-xs font-semibold ${STATUS_STYLE[calibration.status]}`}>
            {STATUS_LABEL[calibration.status]}
          </span>
          <span className="text-gray-400 text-sm">{calibration.status_explanation}</span>
          <label className="ml-auto text-gray-400 text-sm flex items-center gap-2">
            Window
            <select value={days} onChange={(e) => setDays(Number(e.target.value))} className="bg-[#0b1118] border border-white/10 rounded px-2 py-1 text-white text-sm">
              {[7, 30, 90, 365].map((d) => <option key={d} value={d}>{d} days</option>)}
            </select>
          </label>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b border-white/10 text-gray-400 text-sm">
                <th className="text-left px-4 py-2">Score band</th>
                <th className="text-left px-4 py-2">Reviewed</th>
                <th className="text-left px-4 py-2">Predicted</th>
                <th className="text-left px-4 py-2">Observed (95% CI)</th>
                <th className="text-left px-4 py-2">Check</th>
              </tr>
            </thead>
            <tbody>
              {calibration.buckets.filter((b) => b.reviewed_alerts > 0).length === 0 ? (
                <tr><td colSpan={5} className="px-4 py-6 text-center text-gray-500">No reviewed model-scored alerts in this window</td></tr>
              ) : calibration.buckets.filter((b) => b.reviewed_alerts > 0).map((b) => (
                <tr key={b.score_range} className="border-b border-white/5">
                  <td className="px-4 py-2 text-white text-sm font-mono">{b.score_range}</td>
                  <td className="px-4 py-2 text-gray-300 text-sm tabular-nums">{b.reviewed_alerts}</td>
                  <td className="px-4 py-2 text-gray-300 text-sm tabular-nums">{pct(b.mean_predicted_probability)}</td>
                  <td className="px-4 py-2 text-gray-300 text-sm tabular-nums">{pct(b.observed_fraud_rate)} ({pct(b.observed_95ci[0])}–{pct(b.observed_95ci[1])})</td>
                  <td className="px-4 py-2 text-sm">
                    {b.consistent_with_prediction === null ? <span className="text-gray-500">too few</span>
                      : b.consistent_with_prediction ? <span className="text-green-400">consistent</span>
                        : <span className="text-red-400">off</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-gray-500 text-xs mt-3">{calibration.coverage_note}</p>
        <p className="text-gray-500 text-xs mt-1">
          Unflagged model-scored transactions: {calibration.unflagged_model_scored_transactions.n}, of which {calibration.unflagged_model_scored_transactions.customer_disputed} disputed by the customer (possible missed fraud, not proof).
        </p>
      </Section>

      <Section
        title="Hard-rule overrides (evaluated separately from the model)"
        hint="Blacklists and amount caps bypass the model. Their precision is reported per decision path so a rule cannot hide behind the model's numbers."
      >
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b border-white/10 text-gray-400 text-sm">
                <th className="text-left px-4 py-2">Decision path</th>
                <th className="text-left px-4 py-2">Alerts</th>
                <th className="text-left px-4 py-2">Confirmed fraud</th>
                <th className="text-left px-4 py-2">False positives</th>
                <th className="text-left px-4 py-2">Precision (reviewed)</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(calibration.by_decision_path).length === 0 ? (
                <tr><td colSpan={5} className="px-4 py-6 text-center text-gray-500">No alerts in this window</td></tr>
              ) : Object.entries(calibration.by_decision_path).map(([path, g]) => (
                <tr key={path} className="border-b border-white/5">
                  <td className="px-4 py-2 text-white text-sm">{path.replace(/_/g, ' ')}</td>
                  <td className="px-4 py-2 text-gray-300 text-sm tabular-nums">{g.alerts}</td>
                  <td className="px-4 py-2 text-gray-300 text-sm tabular-nums">{g.confirmed_fraud}</td>
                  <td className="px-4 py-2 text-gray-300 text-sm tabular-nums">{g.false_positives}</td>
                  <td className="px-4 py-2 text-gray-300 text-sm tabular-nums">{pct(g.precision_of_reviewed_alerts)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-gray-400 text-sm mt-3">
          {calibration.hard_rule_overrides.overrides_with_alert} override alerts; the model alone would not have flagged {calibration.hard_rule_overrides.model_would_not_have_flagged}
          {' '}({calibration.hard_rule_overrides.of_those_confirmed_fraud} confirmed fraud, {calibration.hard_rule_overrides.of_those_false_positives} false positives).
        </p>
      </Section>

      <Section
        title="Change thresholds"
        hint={`Score units (probability × 100). Review ${limits.mediumMin}–${limits.mediumMax}, fraud up to ${limits.highMax}, at least ${limits.minGap} apart. Simulate first; saving creates a new audited version.`}
      >
        <form onSubmit={save} className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <label className="text-gray-300 text-sm">Review at score ≥
            <input aria-label="Review threshold" type="number" step="0.1" value={medium} onChange={(e) => setMedium(e.target.value)} className={input} />
          </label>
          <label className="text-gray-300 text-sm">Treat as fraud at score ≥
            <input aria-label="Fraud threshold" type="number" step="0.1" value={high} onChange={(e) => setHigh(e.target.value)} className={input} />
          </label>
          <label className="text-gray-300 text-sm">Review capacity / day (optional)
            <input aria-label="Review capacity per day" type="number" min="1" value={capacity} onChange={(e) => setCapacity(e.target.value)} className={input} />
          </label>
          <label className="text-gray-300 text-sm md:col-span-3">Reason for change (required, kept in the audit trail)
            <textarea aria-label="Change note" rows={2} value={note} onChange={(e) => setNote(e.target.value)} className={input} />
          </label>
          {formError && <p role="alert" className="md:col-span-3 text-red-400 text-sm">{formError}</p>}
          <div className="md:col-span-3 flex gap-3">
            <button type="button" onClick={runSimulation} disabled={busy} className="px-4 py-2 rounded-lg text-sm bg-white/10 text-white hover:bg-white/20 disabled:opacity-50">
              Simulate on last {days} days
            </button>
            <button type="submit" disabled={busy || note.trim().length < 10} className="px-4 py-2 rounded-lg text-sm bg-purple-600 text-white hover:bg-purple-500 disabled:opacity-50">
              Save as new version
            </button>
          </div>
        </form>

        {sim && (
          <div data-testid="simulation" className="mt-6">
            {sim.warnings.map((w) => (
              <div key={w} className="mb-2 bg-yellow-500/10 border border-yellow-500/30 text-yellow-200 rounded-lg px-4 py-2 text-sm">{w}</div>
            ))}
            <table className="w-full mt-2">
              <thead>
                <tr className="border-b border-white/10 text-gray-400 text-sm">
                  <th className="text-left px-4 py-2">Over last {sim.window_days} days</th>
                  <th className="text-left px-4 py-2">Current</th>
                  <th className="text-left px-4 py-2">Candidate</th>
                  <th className="text-left px-4 py-2">Change</th>
                </tr>
              </thead>
              <tbody>
                <DeltaRow label="Transactions flagged" current={sim.current.flagged} candidate={sim.candidate.flagged} delta={sim.delta.flagged} goodWhenLower />
                <DeltaRow label="Confirmed fraud caught" current={sim.current.confirmed_fraud_caught} candidate={sim.candidate.confirmed_fraud_caught} delta={sim.delta.confirmed_fraud_caught} />
                <DeltaRow label="Confirmed fraud missed" current={sim.current.confirmed_fraud_missed} candidate={sim.candidate.confirmed_fraud_missed} delta={sim.delta.confirmed_fraud_missed} goodWhenLower />
                <DeltaRow label="Legitimate transactions flagged" current={sim.current.false_positives} candidate={sim.candidate.false_positives} delta={sim.delta.false_positives} goodWhenLower />
              </tbody>
            </table>
            <p className="text-gray-500 text-xs mt-2">{sim.method_note}</p>
          </div>
        )}
      </Section>

      <Section title="Policy history" hint="Append-only. Each transaction records the policy version that decided it.">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b border-white/10 text-gray-400 text-sm">
                <th className="text-left px-4 py-2">Version</th>
                <th className="text-left px-4 py-2">Review ≥</th>
                <th className="text-left px-4 py-2">Fraud ≥</th>
                <th className="text-left px-4 py-2">Note</th>
                <th className="text-left px-4 py-2">Set</th>
              </tr>
            </thead>
            <tbody>
              {history.map((h) => (
                <tr key={h.version} className="border-b border-white/5">
                  <td className="px-4 py-2 text-white text-sm font-mono">v{h.version}</td>
                  <td className="px-4 py-2 text-gray-300 text-sm">{h.medium_threshold}</td>
                  <td className="px-4 py-2 text-gray-300 text-sm">{h.high_threshold}</td>
                  <td className="px-4 py-2 text-gray-400 text-sm">{h.note || '—'}</td>
                  <td className="px-4 py-2 text-gray-400 text-sm">{h.created_at ? new Date(h.created_at).toLocaleDateString() : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>
    </div>
  );
}
