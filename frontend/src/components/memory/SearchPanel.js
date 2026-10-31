import React, { useState } from 'react';
import { Search, Loader2, Sparkles } from 'lucide-react';
import { api } from '../../context/AuthContext';
import EvidenceList from './EvidenceList';

const EXAMPLES = [
  'accounts that shared a device and were confirmed fraud',
  'card testing with many small purchases',
  'cases closed as confirmed fraud and how they were remediated',
];

export default function SearchPanel({ disabled }) {
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState('all');
  const [withAnswer, setWithAnswer] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);

  const run = async (e) => {
    e?.preventDefault();
    if (query.trim().length < 2) return;
    setBusy(true); setError(''); setResult(null);
    try {
      const { data } = await api.post('/cognee-memory/search', {
        query: query.trim(), topK: 8, includeAnswer: withAnswer, sourceTypes: kind === 'all' ? [] : [kind],
      });
      setResult(data);
    } catch (err) {
      setError(err.response?.data?.error || err.response?.data?.message || 'Search failed.');
    } finally { setBusy(false); }
  };

  return (
    <div className="space-y-4">
      <form onSubmit={run} className="rounded-2xl border border-white/10 bg-[#111923] p-4 sm:p-5 space-y-3">
        <label htmlFor="memory-query" className="text-sm font-medium text-white">Ask the fraud history</label>
        <textarea id="memory-query" value={query} onChange={(e) => setQuery(e.target.value)} rows={2} maxLength={1000}
          placeholder="e.g. Have we seen card testing at gift card merchants before?"
          className="w-full rounded-xl bg-black/20 border border-white/10 text-gray-200 placeholder-gray-500 p-3 text-sm focus:outline-none focus:border-cyan-500/50" />
        <div className="flex flex-wrap gap-1.5">
          {EXAMPLES.map((ex) => <button type="button" key={ex} onClick={() => setQuery(ex)} className="text-xs rounded-full border border-white/10 px-2.5 py-1 text-gray-400 hover:text-white hover:bg-white/5">{ex}</button>)}
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <select aria-label="Record type" value={kind} onChange={(e) => setKind(e.target.value)} className="rounded-lg bg-black/30 border border-white/10 text-sm text-gray-200 px-2.5 py-2">
            <option value="all">Transactions and cases</option>
            <option value="transaction">Transactions only</option>
            <option value="investigation">Cases only</option>
          </select>
          <label className="inline-flex items-center gap-2 text-sm text-gray-300">
            <input type="checkbox" checked={withAnswer} onChange={(e) => setWithAnswer(e.target.checked)} /> Also generate a summary (uses the LLM)
          </label>
          <button type="submit" disabled={busy || disabled || query.trim().length < 2} className="ml-auto inline-flex items-center gap-2 rounded-lg bg-cyan-500 hover:bg-cyan-400 text-slate-950 font-semibold px-4 py-2 text-sm disabled:opacity-40 disabled:cursor-not-allowed">
            {busy ? <Loader2 size={15} className="animate-spin" /> : <Search size={15} />}{busy ? 'Searching…' : 'Search memory'}
          </button>
        </div>
      </form>

      {error && <div role="alert" className="rounded-xl border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-300">{error}</div>}

      {result && (
        <div className="space-y-4">
          {result.answer && (
            <section className="rounded-2xl border border-violet-500/30 bg-violet-500/[0.06] p-4 sm:p-5" aria-label="AI-generated summary">
              <div className="flex items-center gap-2 mb-2"><span className="inline-flex items-center gap-1 rounded-md bg-violet-500/20 text-violet-200 text-[11px] font-semibold uppercase tracking-wide px-2 py-0.5"><Sparkles size={11} /> AI-generated</span><span className="text-xs text-gray-400">{result.answer.label}</span></div>
              <p className="text-sm text-gray-200 whitespace-pre-line">{result.answer.text}</p>
            </section>
          )}
          <EvidenceList evidence={result.evidence} />
        </div>
      )}
    </div>
  );
}
