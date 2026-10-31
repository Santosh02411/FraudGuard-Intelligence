import React, { useState, useEffect, useCallback } from 'react';
import { UserSearch } from 'lucide-react';
import { api } from '../context/AuthContext';
import PageHeading from '../components/ui/PageHeading';
import { LoadingState, ErrorState } from '../components/ui/States';

const BAND = { low: 'text-emerald-300 bg-emerald-500/10 border-emerald-500/30', medium: 'text-amber-300 bg-amber-500/10 border-amber-500/30', high: 'text-red-300 bg-red-500/10 border-red-500/30' };
const LABEL = { spending: 'Spending', velocity: 'Velocity', account_age: 'Account age', devices: 'Client / device changes', location: 'Location', outcomes: 'Confirmed outcomes' };

function BandChip({ band }) {
  return <span className={`text-xs px-2 py-0.5 rounded-full border ${BAND[band]}`}>{band}</span>;
}

function ProfileDetail({ id, onClose }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    api.get(`/customer-profiles/${id}`).then((r) => { if (live) setData(r.data); }).catch((e) => { if (live) setError(e.response?.data?.error || 'Could not load the profile'); });
    return () => { live = false; };
  }, [id]);
  if (error) return <p role="alert" className="text-sm text-red-300">{error}</p>;
  if (!data) return <p className="text-sm text-gray-400">Loading profile…</p>;
  const p = data.profile;
  return (
    <section className="bg-[#111820] border border-white/10 rounded-xl p-4 space-y-3" aria-label={`Risk profile for ${p.username}`}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-white font-semibold">{p.username} <BandChip band={p.band} /></h2>
          <p className="text-xs text-gray-400">Score {p.score}/100 · confidence {p.confidence} · {p.coverage.components_scored} of {p.coverage.components_total} components scored from {p.coverage.transactions_considered} transactions (last {p.coverage.history_days} days)</p>
        </div>
        <button type="button" onClick={onClose} className="text-xs text-gray-300 hover:text-white underline">Close</button>
      </div>
      {p.notes.map((n) => <p key={n} className="text-xs text-amber-300">{n}</p>)}
      <ul className="space-y-2">
        {p.factors.map((f) => (
          <li key={f.name} className="bg-[#0a0f14] border border-white/10 rounded-lg p-3">
            <div className="flex justify-between text-sm">
              <span className="text-white">{LABEL[f.name] || f.name} <span className="text-xs text-gray-500">weight {f.weight}</span></span>
              <span className="text-gray-300 tabular-nums">{f.status === 'ok' ? `${f.score}/100 · contributes ${f.contribution}` : 'not enough data'}</span>
            </div>
            {f.status === 'ok' && (
              <div className="h-1.5 bg-white/10 rounded mt-2" role="img" aria-label={`${LABEL[f.name]} score ${f.score} out of 100`}>
                <div className="h-1.5 bg-cyan-400 rounded" style={{ width: `${f.score}%` }} />
              </div>
            )}
            {f.evidence.map((e) => <p key={e} className="text-xs text-gray-400 mt-1">{e}</p>)}
          </li>
        ))}
      </ul>
      <p className="text-xs text-gray-500">{p.disclaimer}</p>
    </section>
  );
}

export default function CustomerProfilesPage() {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [minBand, setMinBand] = useState('');
  const [selected, setSelected] = useState(null);

  const load = useCallback(async () => {
    setError('');
    try { setData((await api.get('/customer-profiles', { params: { limit: 50, ...(minBand ? { min_band: minBand } : {}) } })).data); } catch (e) { setError(e.response?.data?.error || 'Could not load customer profiles'); }
  }, [minBand]);
  useEffect(() => { load(); }, [load]);

  if (error) return <ErrorState message={error} onRetry={load} />;
  if (!data) return <LoadingState label="Loading customer profiles..." />;
  return (
    <div className="space-y-4">
      <PageHeading icon={UserSearch} title="Customer risk profiles" subtitle="An explainable analyst aid built from each account's own history. It does not affect live scoring and never blocks anything." />
      <p className="text-xs text-gray-400">A new client or a young account is weak evidence on its own (new phone, new customer). Scores are built from fixed weights you can inspect; components without enough data are left out rather than guessed.</p>
      <div className="flex items-end gap-3">
        <div>
          <label htmlFor="cp-band" className="block text-xs text-gray-400">Show</label>
          <select id="cp-band" value={minBand} onChange={(e) => { setMinBand(e.target.value); setSelected(null); }} className="bg-[#0a0f14] border border-white/20 rounded-lg px-2 py-1 text-white text-sm">
            <option value="">All bands</option><option value="medium">Medium and above</option><option value="high">High only</option>
          </select>
        </div>
        {data.truncated && <p className="text-xs text-amber-300">Only the {data.scan_cap} most active accounts were scanned.</p>}
      </div>
      {data.profiles.length === 0 ? <p className="text-sm text-gray-400">No accounts match.</p> : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm text-left">
            <caption className="sr-only">Accounts ranked by risk profile score</caption>
            <thead className="text-xs text-gray-400"><tr><th scope="col" className="py-2 pr-3">Account</th><th scope="col" className="pr-3">Score</th><th scope="col" className="pr-3">Band</th><th scope="col" className="pr-3">Confidence</th><th scope="col">Main reasons</th></tr></thead>
            <tbody>
              {data.profiles.map((p) => (
                <tr key={p.user_id} className="border-t border-white/10">
                  <td className="py-2 pr-3"><button type="button" onClick={() => setSelected(p.user_id)} className="text-cyan-300 hover:underline">{p.username}</button></td>
                  <td className="pr-3 tabular-nums text-white">{p.score}</td>
                  <td className="pr-3"><BandChip band={p.band} /></td>
                  <td className="pr-3 text-gray-300">{p.confidence}</td>
                  <td className="text-gray-400 text-xs">{p.top_factors.map((f) => f.headline).join(' · ') || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {selected && <ProfileDetail key={selected} id={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}
