import React from 'react';
import { Link } from 'react-router-dom';
import { FileText, FolderOpen, AlertTriangle, ExternalLink } from 'lucide-react';

const LAYER_STYLE = {
  evidence: 'border-cyan-500/25 bg-cyan-500/[0.04]',
};

function Chip({ children, tone = 'gray' }) {
  const tones = { gray: 'bg-white/5 text-gray-300', amber: 'bg-amber-500/15 text-amber-300', red: 'bg-red-500/15 text-red-300', green: 'bg-emerald-500/15 text-emerald-300', cyan: 'bg-cyan-500/15 text-cyan-300' };
  return <span className={`inline-flex items-center rounded-md px-2 py-0.5 text-[11px] ${tones[tone]}`}>{children}</span>;
}

export function EvidenceCard({ item }) {
  const isTx = item.source_type === 'transaction';
  const Icon = isTx ? FileText : FolderOpen;
  const live = item.live || {};
  const verdict = live.verdict || item.properties?.verdict || item.properties?.outcome;
  return (
    <li className="rounded-xl border border-white/10 bg-black/20 p-4" data-testid={`evidence-${item.source_key}`}>
      <div className="flex flex-wrap items-center gap-2">
        {item.evidence_id && <span className="font-mono text-xs text-cyan-300 bg-cyan-500/10 rounded px-1.5 py-0.5">{item.evidence_id}</span>}
        <Icon size={15} className="text-gray-400" />
        <span className="text-sm font-medium text-white">{isTx ? `Transaction #${item.source_id}` : `Case #${item.source_id}`}</span>
        {item.properties?.risk_level && <Chip tone={['high', 'critical'].includes(item.properties.risk_level) ? 'red' : 'gray'}>{item.properties.risk_level} risk</Chip>}
        {verdict && <Chip tone={verdict === 'confirmed_fraud' ? 'red' : 'green'}>{String(verdict).replace('_', ' ')}</Chip>}
        {item.relevance !== null && item.relevance !== undefined && <Chip tone="cyan">match {Math.round(item.relevance * 100)}%</Chip>}
        {live.memoryOutOfDate && <Chip tone="amber"><AlertTriangle size={11} className="mr-1" />changed since last sync</Chip>}
        {live.exists === false && <Chip tone="amber">record no longer exists</Chip>}
        {live.exists && live.url && <Link to={live.url} className="ml-auto inline-flex items-center gap-1 text-xs text-cyan-400 hover:text-cyan-300">Open record <ExternalLink size={12} /></Link>}
      </div>
      <p className="mt-2 text-sm text-gray-300 whitespace-pre-line break-words">{item.snippet}</p>
      {item.connected?.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5" aria-label="Connected entities">
          {item.connected.map((c) => <Chip key={`${c.relation}-${c.id}`}>{c.type}: <span className="font-mono ml-1">{c.label}</span></Chip>)}
        </div>
      )}
      <div className="mt-2 text-[11px] text-gray-500">Matched via {item.matched_via.join(', ').replace(/_/g, ' ')}</div>
    </li>
  );
}

/** Retrieved-from-memory block. Always labelled so it is never mistaken for generated text. */
export default function EvidenceList({ evidence, emptyText = 'No similar historical records were found.' }) {
  const items = evidence?.items || [];
  return (
    <section className={`rounded-2xl border p-4 sm:p-5 ${LAYER_STYLE.evidence}`} aria-label="Retrieved evidence">
      <div className="flex items-center gap-2 mb-3">
        <span className="rounded-md bg-cyan-500/15 text-cyan-300 text-[11px] font-semibold uppercase tracking-wide px-2 py-0.5">Retrieved evidence</span>
        <span className="text-xs text-gray-400">{evidence?.label}</span>
      </div>
      {items.length === 0 ? <p className="text-sm text-gray-400">{emptyText}</p> : <ul className="space-y-3">{items.map((i) => <EvidenceCard key={i.source_key} item={i} />)}</ul>}
    </section>
  );
}
