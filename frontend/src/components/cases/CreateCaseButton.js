import React, { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { FolderOpen } from 'lucide-react';
import { api } from '../../context/AuthContext';
import { apiCode, apiMessage } from './caseUi';

/** Inline "create a case from these alerts/transactions" control (used from the alert queue and relationship views). */
export default function CreateCaseButton({ alertIds = [], transactionIds = [], defaultTitle = '', label = 'Create case' }) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState(defaultTitle);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const submit = async (e) => {
    e.preventDefault(); setBusy(true); setError(null);
    try {
      const { data } = await api.post('/investigations', { title, alertIds, transactionIds });
      navigate(`/cases/${data.investigation.id}`);
    } catch (err) {
      const caseId = err.response?.data?.details?.caseId;
      setError(apiCode(err) === 'ITEM_IN_OTHER_CASE' ? { text: apiMessage(err, 'Already in a case'), caseId } : { text: apiMessage(err, 'Could not create the case') });
    } finally { setBusy(false); }
  };

  if (!open) return <button type="button" onClick={() => setOpen(true)} className="flex items-center gap-1 bg-cyan-600 hover:bg-cyan-700 text-white px-3 py-1.5 rounded-lg text-sm"><FolderOpen size={14} /> {label}</button>;
  return (
    <form onSubmit={submit} className="flex flex-wrap items-center gap-2" aria-label="Create case">
      <label className="sr-only" htmlFor="new-case-title">Case title</label>
      <input id="new-case-title" value={title} onChange={(e) => setTitle(e.target.value)} minLength={3} maxLength={200} required placeholder="Case title" className="bg-[#0a0f14] border border-white/20 rounded-lg px-3 py-1.5 text-sm text-white" />
      <button type="submit" disabled={busy || title.trim().length < 3} className="bg-cyan-600 hover:bg-cyan-700 disabled:opacity-50 text-white px-3 py-1.5 rounded-lg text-sm">Create from {alertIds.length + transactionIds.length} item(s)</button>
      <button type="button" onClick={() => setOpen(false)} className="text-gray-400 text-sm">Cancel</button>
      {error && <p role="alert" className="w-full text-red-400 text-sm">{error.text}{error.caseId && <> <Link className="underline" to={`/cases/${error.caseId}`}>Open case #{error.caseId}</Link></>}</p>}
    </form>
  );
}
