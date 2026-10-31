import React, { useState, useEffect, useCallback } from 'react';
import { useSearchParams, Link } from 'react-router-dom';
import { Network } from 'lucide-react';
import { api } from '../context/AuthContext';
import PageHeading from '../components/ui/PageHeading';
import { LoadingState, ErrorState, EmptyState } from '../components/ui/States';
import RelationshipGraph from '../components/relationships/RelationshipGraph';
import CreateCaseButton from '../components/cases/CreateCaseButton';

const BAND_STYLE = { high: 'bg-red-600 text-white', watch: 'bg-yellow-500 text-black', low: 'bg-gray-600 text-white' };

function ClusterDetail({ c }) {
  const sig = c.signals;
  return (
    <div className="space-y-3 text-sm" data-testid="cluster-detail">
      <div className="flex flex-wrap items-center gap-2">
        <span className={`px-2 py-0.5 rounded text-xs ${BAND_STYLE[c.risk_band]}`}>{c.risk_band} · {c.risk_score}</span>
        <span className="text-gray-300">{c.size} accounts · exposure ${c.exposure_amount.toFixed(2)}</span>
        {!c.corroborated && <span className="text-xs text-yellow-300">shared infrastructure only</span>}
      </div>
      <ul className="list-disc pl-5 text-gray-300">{c.reasons.map((r) => <li key={r}>{r}</li>)}</ul>
      <div className="text-gray-300">
        <span className="text-gray-400">Members:</span>{' '}
        {c.members.map((m) => <span key={m.user_id} className="mr-3">{m.username}{m.confirmed_fraud && <span className="text-red-400"> (confirmed fraud)</span>}{m.unresolved_alerts > 0 && <span className="text-yellow-400"> ({m.unresolved_alerts} open)</span>}</span>)}
      </div>
      {sig.burst && <p className="text-orange-300">Burst: {sig.burst.txns} transactions from {sig.burst.accounts} accounts, {new Date(sig.burst.start).toLocaleString()} to {new Date(sig.burst.end).toLocaleTimeString()}</p>}
      {sig.repeated_small.length > 0 && <p className="text-orange-300">Repeated small transactions: {sig.repeated_small.map((s) => `user ${s.user_id} (${s.txns})`).join(', ')}</p>}
      {sig.accounts_created_together && <p className="text-orange-300">{sig.accounts_created_together} accounts were created within 48 hours of each other</p>}
      {c.shared_ips.length > 0 && <p className="text-gray-400">Shared IPs: {c.shared_ips.map((s) => `${s.value} (${s.accounts})`).join(', ')}</p>}
      <p className="text-xs text-gray-500">{c.caveats.join(' ')}</p>
      {c.open_alert_ids.length > 0
        ? <CreateCaseButton alertIds={c.open_alert_ids.slice(0, 100)} defaultTitle={`Cluster ${c.cluster_id}: ${c.size} linked accounts`} label={`Open case from ${c.open_alert_ids.length} open alert(s)`} />
        : <p className="text-xs text-gray-500">No open alerts to build a case from.</p>}
    </div>
  );
}

export default function RelationshipsPage() {
  const [params, setParams] = useSearchParams();
  const transactionId = params.get('transactionId');
  const [tab, setTab] = useState('clusters');
  const [clusters, setClusters] = useState(null);
  const [signals, setSignals] = useState(null);
  const [selected, setSelected] = useState(null);
  const [graph, setGraph] = useState(null);
  const [depth, setDepth] = useState(1);
  const [error, setError] = useState('');
  const [graphError, setGraphError] = useState('');
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    setLoading(true); setError('');
    Promise.all([api.get('/relationships/clusters', { params: { limit: 50 } }), api.get('/relationships/signals')])
      .then(([c, s]) => { setClusters(c.data); setSignals(s.data); })
      .catch((e) => setError(e.response?.data?.error || 'Failed to load relationship analysis'))
      .finally(() => setLoading(false));
  }, []);
  useEffect(() => { load(); }, [load]);

  const loadGraph = useCallback((query) => {
    setGraphError('');
    api.get('/relationships/graph', { params: { ...query, depth } }).then((r) => setGraph(r.data)).catch((e) => { setGraph(null); setGraphError(e.response?.data?.error || 'Could not build the graph'); });
  }, [depth]);

  useEffect(() => { if (transactionId) loadGraph({ transactionId }); }, [transactionId, loadGraph]);
  useEffect(() => { if (selected && !transactionId) loadGraph({ userId: selected.members[0].user_id }); }, [selected, transactionId, loadGraph]);

  return (
    <div className="space-y-6 animate-page-in">
      <PageHeading icon={Network} title="Relationships" subtitle="Accounts that appear to be operated together. A lead for review, never proof." />
      <div className="rounded-lg border border-yellow-500/20 bg-yellow-500/5 p-3 text-xs text-gray-300">
        Shared IPs and devices have innocent explanations. Identifiers used by many accounts are ignored, and accounts are only grouped when independent kinds of evidence agree.
        {clusters?.suppressed_identifiers && ` Currently ignored as shared infrastructure: ${clusters.suppressed_identifiers.ips} IP(s), ${clusters.suppressed_identifiers.devices} device(s).`}
      </div>

      {transactionId && (
        <section aria-label="Transaction neighbourhood" className="bg-[#111820] border border-white/10 rounded-xl p-4">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-white font-semibold">Around transaction #{transactionId}</h2>
            <div className="flex items-center gap-2 text-sm"><label htmlFor="depth" className="text-gray-400">Hops</label>
              <select id="depth" value={depth} onChange={(e) => setDepth(Number(e.target.value))} className="bg-[#0a0f14] border border-white/20 rounded-lg px-2 py-1 text-white"><option value={1}>1</option><option value={2}>2</option></select>
              <button type="button" className="text-gray-400 underline" onClick={() => { setParams({}); setGraph(null); }}>Close</button></div>
          </div>
          {graphError && <p role="alert" className="text-red-400 text-sm">{graphError}</p>}
          {graph && <RelationshipGraph graph={graph} />}
          {graph?.cluster ? <div className="mt-4"><ClusterDetail c={graph.cluster} /></div> : graph && <p className="text-sm text-gray-400 mt-3">This account is not part of a strongly linked cluster. Dashed lines, if any, are weak leads.</p>}
          <Link className="text-xs text-cyan-300 hover:underline" to="/relationships">All clusters</Link>
        </section>
      )}

      {!transactionId && (
        <>
          <div role="tablist" className="flex gap-2">
            {[['clusters', 'Clusters'], ['small', 'Repeated small transactions']].map(([k, label]) => (
              <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)} className={`px-3 py-1 rounded-lg text-sm ${tab === k ? 'bg-cyan-500/10 text-cyan-300' : 'text-gray-400 hover:bg-white/5'}`}>{label}</button>))}
          </div>
          {loading && <LoadingState label="Analysing relationships..." />}
          {error && <ErrorState message={error} onRetry={load} />}
          {!loading && !error && tab === 'clusters' && clusters && (
            clusters.clusters.length === 0
              ? <EmptyState icon={Network} title="No clusters" subtitle="No accounts are linked by independent evidence in this window." />
              : (
                <div className="grid lg:grid-cols-[22rem,1fr] gap-6">
                  <ul className="space-y-2" aria-label="Clusters">
                    {clusters.clusters.map((c) => (
                      <li key={c.cluster_id}>
                        <button type="button" onClick={() => setSelected(c)} aria-pressed={selected?.cluster_id === c.cluster_id} className={`w-full text-left rounded-xl border p-3 ${selected?.cluster_id === c.cluster_id ? 'border-cyan-500/50 bg-cyan-500/5' : 'border-white/10 bg-[#111820] hover:bg-white/5'}`}>
                          <div className="flex items-center justify-between"><span className="text-white text-sm font-medium">{c.size} accounts</span><span className={`px-2 py-0.5 rounded text-xs ${BAND_STYLE[c.risk_band]}`}>{c.risk_band} {c.risk_score}</span></div>
                          <p className="text-xs text-gray-400 mt-1">{c.members.slice(0, 3).map((m) => m.username).join(', ')}{c.size > 3 ? '…' : ''}</p>
                          <p className="text-xs text-gray-500 mt-1">{c.reasons[0]}</p>
                        </button>
                      </li>))}
                  </ul>
                  <div className="bg-[#111820] border border-white/10 rounded-xl p-4 space-y-4">
                    {!selected ? <p className="text-sm text-gray-400">Select a cluster to see its evidence and relationship graph.</p> : (
                      <>
                        <ClusterDetail c={selected} />
                        <div className="flex items-center gap-2 text-sm"><label htmlFor="depth2" className="text-gray-400">Hops</label>
                          <select id="depth2" value={depth} onChange={(e) => setDepth(Number(e.target.value))} className="bg-[#0a0f14] border border-white/20 rounded-lg px-2 py-1 text-white"><option value={1}>1</option><option value={2}>2</option></select></div>
                        {graphError && <p role="alert" className="text-red-400 text-sm">{graphError}</p>}
                        {graph && <RelationshipGraph graph={graph} />}
                      </>)}
                  </div>
                </div>)
          )}
          {!loading && !error && tab === 'small' && signals && (
            <div className="bg-[#111820] border border-white/10 rounded-xl p-4">
              <p className="text-xs text-gray-400 mb-3">{signals.definition}</p>
              {signals.repeated_small.length === 0 ? <p className="text-sm text-gray-500">No accounts match.</p> : (
                <table className="w-full text-sm"><thead><tr className="text-left text-gray-400 text-xs"><th className="p-2">Account</th><th>Transactions</th><th>Merchants</th><th>Total</th><th>Window</th></tr></thead>
                  <tbody>{signals.repeated_small.map((s) => (
                    <tr key={s.user_id} className="border-t border-white/5 text-gray-200"><td className="p-2">{s.username}</td><td>{s.txns}</td><td>{s.merchants}</td><td>${s.total.toFixed(2)}</td><td className="text-gray-400">{new Date(s.start).toLocaleString()}</td></tr>))}</tbody></table>)}
            </div>)}
        </>
      )}
    </div>
  );
}
