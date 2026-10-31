import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Network, Loader2, Search } from 'lucide-react';
import { api } from '../../context/AuthContext';

const TYPES = ['Customer', 'Merchant', 'Device', 'FraudPattern', 'Transaction', 'Investigation'];
const COLOR = { Customer: '#22d3ee', Merchant: '#fbbf24', Device: '#f87171', FraudPattern: '#a78bfa', Transaction: '#94a3b8', Investigation: '#34d399' };
const SIZE = 460; const C = SIZE / 2;

/** Deterministic radial layout: centre entity in the middle, each hop on its own ring. */
export function layoutNodes(nodes) {
  const byLevel = new Map();
  nodes.forEach((n) => { if (!byLevel.has(n.level)) byLevel.set(n.level, []); byLevel.get(n.level).push(n); });
  const pos = new Map();
  for (const [level, list] of byLevel) {
    if (level === 0) { list.forEach((n) => pos.set(n.id, [C, C])); continue; }
    const r = 85 + (level - 1) * 80;
    list.forEach((n, i) => { const a = (2 * Math.PI * i) / list.length - Math.PI / 2; pos.set(n.id, [C + r * Math.cos(a), C + r * Math.sin(a)]); });
  }
  return pos;
}

function Graph({ graph, onSelect }) {
  const pos = useMemo(() => layoutNodes(graph.nodes), [graph.nodes]);
  return (
    <svg viewBox={`0 0 ${SIZE} ${SIZE}`} role="img" aria-label={`Entity graph: ${graph.nodes.length} entities, ${graph.edges.length} relationships`} className="w-full max-w-[520px] mx-auto">
      {graph.edges.map((e, i) => { const a = pos.get(e.source); const b = pos.get(e.target); if (!a || !b) return null;
        return <g key={i}><line x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]} stroke="#475569" strokeWidth="1" /><title>{e.relation.replace(/_/g, ' ')}</title></g>; })}
      {graph.nodes.map((n) => { const p = pos.get(n.id); if (!p) return null; const sus = n.signals?.suspicious;
        return (
          <g key={n.id} transform={`translate(${p[0]},${p[1]})`} onClick={() => onSelect(n.id)} style={{ cursor: 'pointer' }} data-testid={`gnode-${n.label}`}>
            <circle r={n.level === 0 ? 15 : 10} fill={COLOR[n.type]} stroke={sus ? '#ef4444' : n.level === 0 ? '#fff' : 'none'} strokeWidth={sus ? 3 : 2} />
            <title>{`${n.type}: ${n.label}${sus ? ' — shared across accounts / linked to confirmed fraud' : ''}`}</title>
            <text y={n.level === 0 ? 28 : 22} textAnchor="middle" fontSize="8.5" fill="#cbd5e1">{n.label.length > 16 ? `${n.label.slice(0, 15)}…` : n.label}</text>
          </g>);
      })}
    </svg>
  );
}

export default function GraphExplorer({ disabled }) {
  const [type, setType] = useState('Device');
  const [q, setQ] = useState('');
  const [suspicious, setSuspicious] = useState(false);
  const [list, setList] = useState({ total: 0, entities: [] });
  const [loading, setLoading] = useState(false);
  const [graph, setGraph] = useState(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const { data } = await api.get('/cognee-memory/entities', { params: { type, q: q || undefined, limit: 25, suspiciousOnly: suspicious } });
      setList(data);
    } catch (err) { setError(err.response?.data?.error || 'Unable to load entities.'); } finally { setLoading(false); }
  }, [type, q, suspicious]);
  useEffect(() => { if (!disabled) load(); }, [load, disabled]);

  const open = async (id) => {
    setError('');
    try { const { data } = await api.get(`/cognee-memory/entities/${encodeURIComponent(id)}/related`, { params: { depth: 2 } }); setGraph(data); }
    catch (err) { setError(err.response?.data?.error || 'Unable to load relationships.'); }
  };

  return (
    <div className="grid lg:grid-cols-5 gap-4">
      <section className="lg:col-span-2 rounded-2xl border border-white/10 bg-[#111923] p-4 space-y-3" aria-label="Entities">
        <div className="flex flex-wrap gap-2">
          <select aria-label="Entity type" value={type} onChange={(e) => setType(e.target.value)} className="rounded-lg bg-black/30 border border-white/10 text-sm text-gray-200 px-2.5 py-2">{TYPES.map((t) => <option key={t}>{t}</option>)}</select>
          <div className="relative flex-1 min-w-[8rem]"><Search size={14} className="absolute left-2.5 top-3 text-gray-500" /><input aria-label="Filter entities" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter…" className="w-full rounded-lg bg-black/30 border border-white/10 text-sm text-gray-200 pl-8 pr-3 py-2" /></div>
        </div>
        {type === 'Device' && <label className="inline-flex items-center gap-2 text-sm text-gray-300"><input type="checkbox" checked={suspicious} onChange={(e) => setSuspicious(e.target.checked)} /> Suspicious only (shared across accounts or tied to confirmed fraud)</label>}
        {error && <div role="alert" className="text-sm text-red-300">{error}</div>}
        {loading ? <div className="py-6 text-center text-gray-400"><Loader2 className="animate-spin inline" size={18} /></div> : list.entities.length === 0 ? <p className="text-sm text-gray-500 py-4">No {type.toLowerCase()} entities in memory yet.</p> : (
          <ul className="divide-y divide-white/5 max-h-96 overflow-y-auto">
            {list.entities.map((e) => (
              <li key={e.id}><button onClick={() => open(e.id)} className="w-full text-left py-2 px-1 hover:bg-white/5 rounded flex items-center gap-2">
                <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: COLOR[e.type] }} />
                <span className="font-mono text-xs text-gray-200 truncate">{e.label}</span>
                {e.signals?.suspicious && <span className="text-[10px] rounded bg-red-500/15 text-red-300 px-1.5 py-0.5">suspicious</span>}
                <span className="ml-auto text-[11px] text-gray-500 whitespace-nowrap">{e.signals?.accounts ? `${e.signals.accounts} accts · ` : ''}{e.degree} links</span>
              </button></li>))}
          </ul>
        )}
        <div className="text-[11px] text-gray-500">{list.total} total</div>
      </section>
      <section className="lg:col-span-3 rounded-2xl border border-white/10 bg-[#111923] p-4" aria-label="Relationship graph">
        {!graph ? <div className="h-full min-h-[16rem] grid place-items-center text-sm text-gray-500 text-center px-6"><div><Network className="mx-auto mb-2" size={22} />Select an entity to see its connected customers, merchants, devices, patterns and cases.</div></div> : (
          <>
            <Graph graph={graph} onSelect={open} />
            <div className="flex flex-wrap gap-3 justify-center mt-2 text-[11px] text-gray-400">{TYPES.map((t) => <span key={t} className="inline-flex items-center gap-1"><span className="w-2 h-2 rounded-full" style={{ background: COLOR[t] }} />{t}</span>)}</div>
            {graph.truncated && <p className="text-center text-[11px] text-amber-300/80 mt-1">Showing a subset of connections.</p>}
          </>
        )}
      </section>
    </div>
  );
}
