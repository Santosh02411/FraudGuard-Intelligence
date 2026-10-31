import React, { useMemo } from 'react';

const SIZE = 520; const C = SIZE / 2;

/** Deterministic radial layout: seed(s) in the middle, each hop on its own pair of rings (identifiers inside, accounts outside). */
export function layout(nodes) {
  const pos = new Map();
  const groups = new Map();
  for (const n of nodes) {
    const key = n.level === 0 ? 'seed' : `${n.level}:${n.type === 'account' ? 'account' : 'identifier'}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(n);
  }
  for (const [key, list] of groups) {
    if (key === 'seed') {
      list.forEach((n, i) => pos.set(n.id, list.length === 1 ? [C, C] : [C + (i - (list.length - 1) / 2) * 60, C]));
      continue;
    }
    const [level, kind] = key.split(':');
    const radius = (kind === 'identifier' ? 70 : 115) + (Number(level) - 1) * 75;
    list.forEach((n, i) => { const a = (2 * Math.PI * i) / list.length - Math.PI / 2 + (kind === 'account' ? Math.PI / list.length : 0); pos.set(n.id, [C + radius * Math.cos(a), C + radius * Math.sin(a)]); });
  }
  return pos;
}

function Node({ n, p }) {
  const [x, y] = p;
  const danger = n.confirmed_fraud; const common = n.common;
  const label = n.label.length > 14 ? `${n.label.slice(0, 13)}…` : n.label;
  const title = n.type === 'account'
    ? `${n.label}${n.confirmed_fraud ? ' — analyst-confirmed fraud' : ''}${n.unresolved_alerts ? ` — ${n.unresolved_alerts} open alert(s)` : ''}${n.cluster_id ? ` — cluster ${n.cluster_id}` : ''}`
    : `${n.type} ${n.label}${n.note ? ` — ${n.note}` : n.accounts ? ` — ${n.accounts} account(s)` : ''}`;
  return (
    <g data-testid={`node-${n.id}`} data-type={n.type}>
      <title>{title}</title>
      {n.type === 'account' && <circle cx={x} cy={y} r={n.seed ? 16 : 12} fill={danger ? '#ef4444' : '#0e7490'} stroke={n.seed ? '#fff' : '#22d3ee'} strokeWidth={n.seed ? 3 : 1.5} />}
      {n.type === 'transaction' && <rect x={x - 14} y={y - 14} width="28" height="28" transform={`rotate(45 ${x} ${y})`} fill="#a855f7" stroke="#fff" strokeWidth="2" />}
      {(n.type === 'ip' || n.type === 'device') && <rect x={x - 11} y={y - 8} width="22" height="16" rx="3" fill={common ? 'none' : '#374151'} stroke={common ? '#f59e0b' : '#9ca3af'} strokeDasharray={common ? '3 2' : undefined} />}
      <text x={x} y={y + (n.type === 'account' ? 27 : 22)} textAnchor="middle" fontSize="9" fill="#d1d5db">{label}</text>
    </g>
  );
}

export default function RelationshipGraph({ graph }) {
  const pos = useMemo(() => layout(graph.nodes), [graph.nodes]);
  return (
    <figure>
      <svg viewBox={`0 0 ${SIZE} ${SIZE}`} role="img" aria-label={`Relationship graph: ${graph.nodes.length} nodes, ${graph.edges.length} links`} className="w-full max-w-[640px] mx-auto bg-[#0a0f14] rounded-lg">
        {graph.edges.map((e, i) => {
          const a = pos.get(e.from); const b = pos.get(e.to);
          if (!a || !b) return null;
          const strong = e.type === 'strong_link'; const weak = e.type === 'weak_lead';
          return <line key={i} data-testid={`edge-${e.type}`} x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]} stroke={strong ? '#f97316' : weak ? '#eab308' : '#4b5563'} strokeWidth={strong ? 3 : 1} strokeDasharray={weak ? '5 4' : undefined} opacity={e.type === 'uses' || e.type === 'made_by' ? 0.7 : 1}><title>{e.type === 'uses' ? `${e.transactions ?? ''} transaction(s)` : `${e.type.replace('_', ' ')} (strength ${e.strength}): ${(e.evidence || []).join(' + ')}`}</title></line>;
        })}
        {graph.nodes.map((n) => pos.get(n.id) && <Node key={n.id} n={n} p={pos.get(n.id)} />)}
      </svg>
      <figcaption className="text-xs text-gray-400 mt-2 flex flex-wrap gap-x-4 gap-y-1 justify-center">
        <span><span className="text-cyan-400">●</span> account</span><span><span className="text-red-400">●</span> analyst-confirmed fraud</span><span><span className="text-purple-400">◆</span> seed transaction</span>
        <span><span className="text-gray-400">▭</span> IP / device</span><span><span className="text-yellow-500">▭</span> common/private (not expanded)</span>
        <span><span className="text-orange-400">━</span> strong link</span><span><span className="text-yellow-400">┅</span> weak lead</span>
      </figcaption>
      {graph.truncated && <p className="text-xs text-yellow-300 text-center mt-1">Graph truncated at the node limit. Narrow with depth 1.</p>}
    </figure>
  );
}
