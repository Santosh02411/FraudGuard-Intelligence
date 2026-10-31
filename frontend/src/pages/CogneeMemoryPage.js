import React, { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { BrainCircuit, Database, Network, GitBranch, Users, Store, Smartphone, FolderOpen, FileText, Activity, AlertTriangle, CheckCircle2, Search, Bot, RefreshCw } from 'lucide-react';
import { api } from '../context/AuthContext';
import PageHeading from '../components/ui/PageHeading';
import StatCard from '../components/ui/StatCard';
import SyncPanel from '../components/memory/SyncPanel';
import SearchPanel from '../components/memory/SearchPanel';
import AssistantPanel from '../components/memory/AssistantPanel';
import GraphExplorer from '../components/memory/GraphExplorer';

const TABS = [
  { id: 'overview', label: 'Overview', icon: Activity },
  { id: 'search', label: 'Search history', icon: Search },
  { id: 'assistant', label: 'Assistant', icon: Bot },
  { id: 'graph', label: 'Entities & graph', icon: Network },
];

function HealthBanner({ health }) {
  if (!health) return null;
  if (!health.configured) {
    return <div role="status" className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-200"><strong>Cognee is not configured.</strong> Set <code>COGNEE_SERVICE_URL</code> and <code>COGNEE_SERVICE_API_KEY</code> in <code>backend/.env</code> and start <code>cognee_service</code>, then restart the backend. See the README for setup.</div>;
  }
  if (!health.reachable) {
    return <div role="alert" className="rounded-xl border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-300 flex gap-2"><AlertTriangle size={18} className="shrink-0 mt-0.5" /><span>The Cognee service is configured but not reachable: {health.error?.message || 'unknown error'}.</span></div>;
  }
  const svc = health.service || {};
  const failing = Object.entries(svc.checks || {}).filter(([, c]) => !c.ok);
  return (
    <div className="flex flex-wrap gap-2 text-xs" aria-label="Integration health">
      <span className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 ${health.status === 'ok' ? 'border-emerald-500/25 bg-emerald-500/10 text-emerald-300' : 'border-amber-500/30 bg-amber-500/10 text-amber-300'}`}>{health.status === 'ok' ? <CheckCircle2 size={13} /> : <AlertTriangle size={13} />}Cognee service {health.status === 'ok' ? 'healthy' : 'degraded'}{failing.length ? `: ${failing.map(([n]) => n.replace('_', ' ')).join(', ')} failing` : ''}</span>
      <span className={`rounded-full border px-3 py-1 ${svc.llm_configured ? 'border-white/10 text-gray-300' : 'border-amber-500/30 text-amber-300'}`}>LLM: {svc.llm_configured ? 'configured' : 'not configured (graph + vector search only)'}</span>
      <span className="rounded-full border border-white/10 px-3 py-1 text-gray-300">Narrative memory: {String(svc.narrative_layer || 'n/a').replace(/_/g, ' ')}</span>
      <span className="rounded-full border border-white/10 px-3 py-1 text-gray-400">Cognee {svc.cognee_version}</span>
    </div>
  );
}

export default function CogneeMemoryPage() {
  const [params, setParams] = useSearchParams();
  const initialTab = TABS.some((t) => t.id === params.get('tab')) ? params.get('tab') : 'overview';
  const [tab, setTab] = useState(initialTab);
  const [health, setHealth] = useState(null);
  const [stats, setStats] = useState(null);
  const [runs, setRuns] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setError('');
    try {
      const { data: h } = await api.get('/cognee-memory/health');
      setHealth(h);
      if (h.configured) {
        const [s, r] = await Promise.all([
          api.get('/cognee-memory/stats').catch(() => ({ data: null })),
          api.get('/cognee-memory/sync/runs', { params: { limit: 8 } }).catch(() => ({ data: { runs: [] } })),
        ]);
        setStats(s.data); setRuns(r.data.runs || []);
      }
    } catch (err) {
      setError(err.response?.data?.error || 'Unable to load Fraud Intelligence status.');
    } finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const choose = (id) => { setTab(id); const next = new URLSearchParams(params); next.set('tab', id); setParams(next, { replace: true }); };
  const ready = Boolean(health?.reachable);
  const mem = stats?.memory && !stats.memory.unavailable ? stats.memory : null;
  const ent = mem?.structured_entities || {};
  const initialAssist = params.get('id') ? { kind: params.get('kind') === 'investigation' ? 'investigation' : 'transaction', id: params.get('id') } : undefined;

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 py-8 space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
        <PageHeading icon={BrainCircuit} title="AI Memory / Fraud Intelligence" subtitle="Cognee-powered memory of past transactions, cases and outcomes — search it, explore the entity graph, and ask the assistant." />
        <button onClick={() => { setLoading(true); load(); }} className="inline-flex items-center gap-2 rounded-lg border border-white/10 px-3 py-2 text-sm text-gray-300 hover:bg-white/5 self-start"><RefreshCw size={14} className={loading ? 'animate-spin' : ''} />Refresh</button>
      </div>

      {error && <div role="alert" className="rounded-xl border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-300">{error}</div>}
      <HealthBanner health={health} />

      <nav className="flex gap-1 border-b border-white/10 overflow-x-auto" role="tablist" aria-label="Fraud intelligence sections">
        {TABS.map(({ id, label, icon: Icon }) => (
          <button key={id} role="tab" aria-selected={tab === id} onClick={() => choose(id)} className={`inline-flex items-center gap-2 px-4 py-2.5 text-sm whitespace-nowrap border-b-2 -mb-px ${tab === id ? 'border-cyan-400 text-cyan-200' : 'border-transparent text-gray-400 hover:text-gray-200'}`}><Icon size={15} />{label}</button>
        ))}
      </nav>

      {tab === 'overview' && (
        <div className="space-y-6">
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
            <StatCard icon={Database} title="Graph entities" value={mem ? mem.nodes_total.toLocaleString() : '—'} />
            <StatCard icon={GitBranch} title="Relationships" value={mem ? mem.edges_total.toLocaleString() : '—'} />
            <StatCard icon={FileText} title="Transactions remembered" value={mem ? (ent.Transaction ?? 0).toLocaleString() : '—'} />
            <StatCard icon={FolderOpen} title="Cases remembered" value={mem ? (ent.Investigation ?? 0).toLocaleString() : '—'} />
            <StatCard icon={Users} title="Customer accounts" value={mem ? (ent.Customer ?? 0).toLocaleString() : '—'} />
            <StatCard icon={Store} title="Merchants" value={mem ? (ent.Merchant ?? 0).toLocaleString() : '—'} />
            <StatCard icon={Smartphone} title="Devices (suspicious)" value={mem ? `${ent.Device ?? 0} (${mem.suspicious_devices ?? 0})` : '—'} color={mem?.suspicious_devices ? 'text-red-300' : undefined} />
            <StatCard icon={Network} title="Fraud patterns" value={mem ? (ent.FraudPattern ?? 0).toLocaleString() : '—'} />
          </div>
          {mem && <p className="text-xs text-gray-500">Narrative documents: {mem.narrative_documents ?? 'n/a'} · semantic indexing: {String(mem.cognify?.status || 'n/a').replace(/_/g, ' ')}{mem.cognify?.last_error ? ` (last error: ${mem.cognify.last_error})` : ''}</p>}
          <SyncPanel stats={stats} runs={runs} connected={ready} onChanged={load} />
          <section className="rounded-2xl border border-cyan-500/15 bg-cyan-500/5 p-4 sm:p-5 space-y-1.5" aria-label="Privacy and scope">
            <h3 className="text-cyan-200 font-semibold text-sm">Privacy and scope</h3>
            <p className="text-gray-400 text-sm leading-6">Read-only: FraudGuard data is never modified. Customer accounts and devices are replaced by keyed pseudonyms; IP addresses, emails, card details and credentials are never sent, and analyst notes are redacted for emails, phone numbers and card-like numbers first. Pseudonymisation is not anonymisation — treat the memory store with the same care as the source data. Search results are an investigative aid, never a fraud decision.</p>
          </section>
        </div>
      )}
      {tab === 'search' && <SearchPanel disabled={!ready} />}
      {tab === 'assistant' && <AssistantPanel disabled={!ready} initial={initialAssist} />}
      {tab === 'graph' && <GraphExplorer disabled={!ready} />}
    </div>
  );
}
