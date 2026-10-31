import React, { useEffect, useState } from 'react';
import { Bot, Loader2, Sparkles, Database, ListChecks, Link2 } from 'lucide-react';
import { api } from '../../context/AuthContext';
import EvidenceList from './EvidenceList';

const AI_STATUS = {
  llm_not_configured: 'No LLM is configured for the Cognee service, so only retrieved evidence is shown. Configure LLM_API_KEY on the service to enable suggestions.',
  generation_failed: 'The LLM call failed. The retrieved evidence above is still valid; try again shortly.',
};

function CitationChips({ ids }) {
  if (!ids?.length) return null;
  return <span className="ml-2 inline-flex gap-1">{ids.map((id) => <span key={id} className="font-mono text-[10px] text-cyan-300 bg-cyan-500/10 rounded px-1">{id}</span>)}</span>;
}

function AiBlock({ ai }) {
  const Section = ({ title, icon: Icon, children }) => <div><h4 className="flex items-center gap-1.5 text-xs uppercase tracking-wide text-violet-200/80 mb-1.5"><Icon size={13} />{title}</h4>{children}</div>;
  const finding = (f, i) => (
    <li key={i} className="text-sm text-gray-200">{f.statement}<CitationChips ids={f.evidence_ids} />{!f.grounded && <span className="ml-2 text-[10px] text-amber-300/90">based on this record only</span>}</li>
  );
  return (
    <section className="rounded-2xl border border-violet-500/30 bg-violet-500/[0.06] p-4 sm:p-5 space-y-4" aria-label="AI-generated suggestions">
      <div className="flex items-center gap-2"><span className="inline-flex items-center gap-1 rounded-md bg-violet-500/20 text-violet-200 text-[11px] font-semibold uppercase tracking-wide px-2 py-0.5"><Sparkles size={11} /> AI-generated</span><span className="text-xs text-gray-400">{ai.label}</span></div>
      {ai.explanation?.length > 0 && <Section title="Why this looks suspicious" icon={Bot}><ul className="space-y-1.5 list-disc pl-5">{ai.explanation.map(finding)}</ul></Section>}
      {ai.similar_patterns?.length > 0 && <Section title="Similar historical patterns" icon={Link2}><ul className="space-y-1.5 list-disc pl-5">{ai.similar_patterns.map(finding)}</ul></Section>}
      {ai.suggested_steps?.length > 0 && (
        <Section title="Suggested investigation steps" icon={ListChecks}>
          <ol className="space-y-2 list-decimal pl-5">{ai.suggested_steps.map((s, i) => <li key={i} className="text-sm text-gray-200">{s.action}<CitationChips ids={s.evidence_ids} />{s.rationale && <div className="text-xs text-gray-400">{s.rationale}</div>}</li>)}</ol>
        </Section>
      )}
      {ai.caveats?.length > 0 && <div className="text-xs text-gray-400 border-t border-white/10 pt-3">Caveats: {ai.caveats.join(' · ')}</div>}
    </section>
  );
}

export default function AssistantPanel({ disabled, initial }) {
  const [kind, setKind] = useState(initial?.kind || 'transaction');
  const [id, setId] = useState(initial?.id || '');
  const [question, setQuestion] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);

  useEffect(() => { if (initial?.id) { setKind(initial.kind || 'transaction'); setId(initial.id); } }, [initial]);

  const run = async (e) => {
    e?.preventDefault();
    const n = Number(id);
    if (!Number.isInteger(n) || n < 1) { setError('Enter a valid record number.'); return; }
    setBusy(true); setError(''); setResult(null);
    try {
      const { data } = await api.post('/cognee-memory/assistant', { kind, id: n, ...(question.trim() ? { question: question.trim() } : {}) });
      setResult(data);
    } catch (err) {
      setError(err.response?.data?.error || err.response?.data?.message || 'The assistant request failed.');
    } finally { setBusy(false); }
  };

  return (
    <div className="space-y-4">
      <form onSubmit={run} className="rounded-2xl border border-white/10 bg-[#111923] p-4 sm:p-5 space-y-3">
        <div className="text-sm font-medium text-white">Investigation assistant</div>
        <p className="text-xs text-gray-400">Explains a record using FraudGuard’s own data and similar history retrieved from memory. Three layers are always shown separately: current facts, retrieved evidence, and AI-generated suggestions.</p>
        <div className="flex flex-wrap gap-3">
          <select aria-label="Record kind" value={kind} onChange={(e) => setKind(e.target.value)} className="rounded-lg bg-black/30 border border-white/10 text-sm text-gray-200 px-2.5 py-2">
            <option value="transaction">Transaction</option><option value="investigation">Case</option>
          </select>
          <input aria-label="Record number" inputMode="numeric" value={id} onChange={(e) => setId(e.target.value.replace(/\D/g, ''))} placeholder="Record #" className="w-32 rounded-lg bg-black/30 border border-white/10 text-sm text-gray-200 px-3 py-2" />
        </div>
        <input aria-label="Optional question" value={question} onChange={(e) => setQuestion(e.target.value)} maxLength={1000} placeholder="Optional: e.g. Is this part of a ring?" className="w-full rounded-lg bg-black/30 border border-white/10 text-sm text-gray-200 px-3 py-2" />
        <button type="submit" disabled={busy || disabled || !id} className="inline-flex items-center gap-2 rounded-lg bg-violet-500 hover:bg-violet-400 text-white font-semibold px-4 py-2 text-sm disabled:opacity-40 disabled:cursor-not-allowed">
          {busy ? <Loader2 size={15} className="animate-spin" /> : <Bot size={15} />}{busy ? 'Investigating…' : 'Investigate'}
        </button>
      </form>
      {error && <div role="alert" className="rounded-xl border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-300">{error}</div>}
      {result && (
        <div className="space-y-4">
          <section className="rounded-2xl border border-white/10 bg-black/20 p-4 sm:p-5" aria-label="Current record facts">
            <div className="flex items-center gap-2 mb-2"><span className="inline-flex items-center gap-1 rounded-md bg-white/10 text-gray-200 text-[11px] font-semibold uppercase tracking-wide px-2 py-0.5"><Database size={11} /> Current facts</span><span className="text-xs text-gray-400">{result.subject.label}</span></div>
            <pre className="text-sm text-gray-300 whitespace-pre-wrap break-words font-sans">{result.subject.facts}</pre>
          </section>
          <EvidenceList evidence={result.evidence} emptyText="No similar historical records were found - this may be a new pattern, or memory may not be synced yet." />
          {result.ai ? <AiBlock ai={result.ai} /> : <div className="rounded-xl border border-white/10 bg-white/[0.03] p-3 text-sm text-gray-400">{AI_STATUS[result.ai_status] || 'No AI suggestions were generated.'}</div>}
        </div>
      )}
    </div>
  );
}
