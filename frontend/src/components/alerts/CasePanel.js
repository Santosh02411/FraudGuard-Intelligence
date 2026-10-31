import React, { useState, useEffect, useCallback, useRef } from 'react';
import { api } from '../../context/AuthContext';
import { downloadBlobResponse } from '../../utils/download';
import { STATUS_LABEL, SEVERITY_STYLE, lockedByOther, errorCode } from './caseConstants';

const HEARTBEAT_MS = 4 * 60 * 1000; // lease is 15 min by default; renew well within it

/** Investigator workspace for one alert: claim lock, status/severity, comments, evidence, outcome amounts. */
export default function CasePanel({ alert, user, onAlertChange }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [comment, setComment] = useState('');
  const [reasonText, setReasonText] = useState('');
  const [showTakeover, setShowTakeover] = useState(false);
  const [outcome, setOutcome] = useState({ loss: '', recovered: '', prevented: '' });
  const fileRef = useRef(null);

  const mine = alert.claim?.user_id === user.id;
  const other = lockedByOther(alert, user.id);

  const load = useCallback(() => api.get(`/alerts/${alert.id}/case`)
    .then((r) => {
      setData(r.data);
      onAlertChange(r.data.alert);
      const a = r.data.alert;
      setOutcome({ loss: a.loss_amount ?? '', recovered: a.recovered_amount ?? '', prevented: a.prevented_amount ?? '' });
    })
    .catch((e) => setError(e.response?.data?.error || 'Could not load the case')), [alert.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, [load]);

  // Keep the lease alive only while the panel is open and we hold it.
  useEffect(() => {
    if (!mine) return undefined;
    const t = setInterval(() => api.post(`/alerts/${alert.id}/claim`, {}).then((r) => onAlertChange(r.data.alert)).catch(() => {}), HEARTBEAT_MS);
    return () => clearInterval(t);
  }, [mine, alert.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const run = async (fn, fallback) => {
    setBusy(true); setError('');
    try { await fn(); } catch (e) {
      if (errorCode(e) === 'ALERT_LOCKED' || errorCode(e) === 'VERSION_CONFLICT') onAlertChange(e.response.data.details.current);
      setError(e.response?.data?.error || fallback);
    } finally { setBusy(false); }
  };

  const claim = (force) => run(async () => {
    const r = await api.post(`/alerts/${alert.id}/claim`, force ? { force: true, reason: reasonText } : {});
    onAlertChange(r.data.alert); setShowTakeover(false); setReasonText(''); load();
  }, 'Could not claim this case');
  const release = () => run(async () => { await api.delete(`/alerts/${alert.id}/claim`, { data: {} }); await load(); }, 'Could not release');
  const setStatus = (status) => run(async () => { const r = await api.patch(`/alerts/${alert.id}/status`, { status, version: alert.version }); onAlertChange(r.data.alert); load(); }, 'Could not change status');
  const setSeverity = (severity) => {
    const reason = window.prompt('Why is the severity changing? (recorded in the audit trail)');
    if (!reason || reason.trim().length < 5) return;
    run(async () => { const r = await api.patch(`/alerts/${alert.id}/severity`, { severity, reason: reason.trim(), version: alert.version }); onAlertChange(r.data.alert); load(); }, 'Could not change severity');
  };
  const escalate = () => {
    const reason = window.prompt('Reason for escalating this case:');
    if (!reason || reason.trim().length < 5) return;
    run(async () => { const r = await api.post(`/alerts/${alert.id}/escalate`, { reason: reason.trim() }); onAlertChange(r.data.alert); load(); }, 'Could not escalate');
  };
  const postComment = () => run(async () => { await api.post(`/alerts/${alert.id}/comments`, { body: comment }); setComment(''); await load(); }, 'Could not post the comment');
  const upload = (file) => run(async () => {
    await api.post(`/alerts/${alert.id}/evidence`, file, { params: { filename: file.name }, headers: { 'Content-Type': 'application/octet-stream' } });
    if (fileRef.current) fileRef.current.value = '';
    await load();
  }, 'Upload failed');
  const download = (ev) => run(async () => {
    const res = await api.get(`/alerts/${alert.id}/evidence/${ev.id}`, { responseType: 'blob' });
    downloadBlobResponse(res, ev.filename);
  }, 'Download failed');
  const saveOutcome = () => run(async () => {
    const num = (v) => (v === '' ? null : Number(v));
    const r = await api.patch(`/alerts/${alert.id}/outcome`, { loss_amount: num(outcome.loss), recovered_amount: num(outcome.recovered), prevented_amount: num(outcome.prevented), version: alert.version });
    onAlertChange(r.data.alert); await load();
  }, 'Could not save amounts');

  if (!data) return <p className="text-sm text-gray-400" role="status">{error || 'Loading case…'}</p>;
  const resolved = !!alert.resolved;

  return (
    <section aria-label="Case workspace" className="mt-4 ml-0 sm:ml-14 rounded-lg bg-black/20 p-4 space-y-4 text-sm">
      {error && <p role="alert" className="text-red-400 text-xs">{error}</p>}

      {/* Claim lock */}
      {!resolved && (
        <div className={`rounded-lg p-3 ${other ? 'bg-yellow-500/10 border border-yellow-500/30' : 'bg-white/5'}`}>
          {other ? (
            <>
              <p className="text-yellow-300">Being worked by <strong>{alert.claim.username}</strong> until {new Date(alert.claim.expires_at).toLocaleTimeString()}. Resolving, assigning and status changes are blocked for you.</p>
              {!showTakeover
                ? <button type="button" className="mt-2 text-xs underline text-yellow-200" onClick={() => setShowTakeover(true)}>Take over this case…</button>
                : (
                  <div className="mt-2 flex gap-2">
                    <input aria-label="Takeover reason" className="flex-1 bg-[#0a0f14] border border-white/20 rounded px-2 py-1 text-xs" placeholder="Reason for taking over (audited)" value={reasonText} onChange={(e) => setReasonText(e.target.value)} />
                    <button type="button" disabled={busy || reasonText.trim().length < 5} onClick={() => claim(true)} className="bg-yellow-600 disabled:opacity-50 px-3 py-1 rounded text-xs">Take over</button>
                  </div>
                )}
            </>
          ) : mine ? (
            <div className="flex items-center justify-between">
              <span className="text-green-300">You are working this case. Others are warned until you release it.</span>
              <button type="button" disabled={busy} onClick={release} className="text-xs underline text-gray-300">Release</button>
            </div>
          ) : (
            <div className="flex items-center justify-between">
              <span className="text-gray-300">Nobody is working this case.</span>
              <button type="button" disabled={busy} onClick={() => claim(false)} className="bg-purple-600 hover:bg-purple-700 disabled:opacity-50 px-3 py-1 rounded text-xs">Start working</button>
            </div>
          )}
        </div>
      )}

      {/* Triage */}
      {!resolved && (
        <div className="flex flex-wrap items-end gap-3">
          <label className="text-xs text-gray-400">Status
            <select aria-label="Investigation status" disabled={busy || other} value={alert.status} onChange={(e) => setStatus(e.target.value)} className="block mt-1 bg-[#0a0f14] border border-white/20 rounded px-2 py-1 text-sm text-white">
              {['open', 'in_review', 'escalated', 'pending_info'].map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
            </select>
          </label>
          <label className="text-xs text-gray-400">Severity
            <select aria-label="Severity" disabled={busy || other} value={alert.severity || 'medium'} onChange={(e) => setSeverity(e.target.value)} className="block mt-1 bg-[#0a0f14] border border-white/20 rounded px-2 py-1 text-sm text-white">
              {['critical', 'high', 'medium', 'low'].map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </label>
          <span className={`text-xs font-bold uppercase px-2 py-1 rounded ${SEVERITY_STYLE[alert.severity] || ''}`}>{alert.severity}</span>
          <button type="button" disabled={busy || alert.escalation_level >= 3} onClick={escalate} className="text-xs bg-white/10 hover:bg-white/20 disabled:opacity-40 px-3 py-1.5 rounded">Escalate…</button>
          {alert.due_at && (
            <span className={`text-xs ${alert.overdue ? 'text-red-400 font-semibold' : 'text-gray-400'}`}>
              {alert.overdue ? `Overdue since ${new Date(alert.due_at).toLocaleString()}` : `Due ${new Date(alert.due_at).toLocaleString()}`}
              {alert.escalation_level > 0 ? ` · escalation level ${alert.escalation_level}` : ''}
            </span>
          )}
        </div>
      )}

      {/* Outcome amounts */}
      {resolved && alert.verdict === 'confirmed_fraud' && (
        <fieldset className="border border-white/10 rounded-lg p-3">
          <legend className="text-xs text-gray-400 px-1">Financial outcome (transaction ${Number(alert.amount).toFixed(2)})</legend>
          <div className="flex flex-wrap gap-3">
            {[['loss', 'Loss'], ['recovered', 'Recovered'], ['prevented', 'Prevented']].map(([k, label]) => (
              <label key={k} className="text-xs text-gray-400">{label} ($)
                <input type="number" min="0" step="0.01" aria-label={`${label} amount`} value={outcome[k]} onChange={(e) => setOutcome((o) => ({ ...o, [k]: e.target.value }))} className="block mt-1 w-28 bg-[#0a0f14] border border-white/20 rounded px-2 py-1 text-sm text-white" />
              </label>
            ))}
            <button type="button" disabled={busy} onClick={saveOutcome} className="self-end bg-purple-600 disabled:opacity-50 px-3 py-1.5 rounded text-xs">Save amounts</button>
          </div>
        </fieldset>
      )}

      {/* Comments */}
      <div>
        <h4 className="text-xs font-semibold text-gray-300 mb-2">Investigation notes <span className="text-gray-500 font-normal">(internal; append-only)</span></h4>
        <ul className="space-y-2 mb-2">
          {data.comments.length === 0 && <li className="text-xs text-gray-500">No notes yet.</li>}
          {data.comments.map((c) => (
            <li key={c.id} className="bg-white/5 rounded p-2">
              <p className="text-gray-200 whitespace-pre-wrap">{c.body}</p>
              <p className="text-[11px] text-gray-500 mt-1">{c.author_username} · {new Date(c.created_at).toLocaleString()}</p>
            </li>
          ))}
        </ul>
        <div className="flex gap-2">
          <textarea aria-label="New note" rows={2} maxLength={2000} value={comment} onChange={(e) => setComment(e.target.value)} className="flex-1 bg-[#0a0f14] border border-white/20 rounded px-2 py-1 text-sm text-white" placeholder="What did you find or do?" />
          <button type="button" disabled={busy || !comment.trim()} onClick={postComment} className="self-end bg-purple-600 disabled:opacity-50 px-3 py-1.5 rounded text-xs">Add note</button>
        </div>
      </div>

      {/* Evidence */}
      <div>
        <h4 className="text-xs font-semibold text-gray-300 mb-2">Evidence <span className="text-gray-500 font-normal">(PNG, JPEG, PDF, text/CSV; 2 MB each)</span></h4>
        <ul className="space-y-1 mb-2">
          {data.evidence.length === 0 && <li className="text-xs text-gray-500">No files attached.</li>}
          {data.evidence.map((ev) => (
            <li key={ev.id} className="flex items-center justify-between text-xs bg-white/5 rounded px-2 py-1">
              <span><span className="text-gray-200">{ev.filename}</span> · {(ev.size_bytes / 1024).toFixed(1)} KB · {ev.uploaded_by_username} · <span className="font-mono text-gray-500" title={ev.sha256}>sha256 {ev.sha256.slice(0, 10)}…</span></span>
              <button type="button" disabled={busy} onClick={() => download(ev)} className="underline text-purple-300">Download</button>
            </li>
          ))}
        </ul>
        <input ref={fileRef} type="file" aria-label="Attach evidence" accept=".png,.jpg,.jpeg,.pdf,.txt,.csv,.log,.eml" disabled={busy} onChange={(e) => e.target.files[0] && upload(e.target.files[0])} className="text-xs text-gray-400" />
      </div>
    </section>
  );
}
