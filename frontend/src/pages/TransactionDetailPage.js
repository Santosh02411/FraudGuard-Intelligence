import React, { useState, useEffect, useCallback } from 'react';
import { useParams, Link } from 'react-router-dom';
import { api, useAuth } from '../context/AuthContext';
import DecisionHistoryPanel from '../components/admin/DecisionHistoryPanel';
import FraudScoreExplanation from '../components/FraudScoreExplanation';
import { ArrowLeft, CheckCircle, AlertTriangle, XCircle, Scale, ShieldQuestion } from 'lucide-react';
import { LoadingState, ErrorState } from '../components/ui/States';

const RISK_STYLE = {
  low: { icon: CheckCircle, color: 'text-green-400', bg: 'bg-green-500/10 border-green-500/40' },
  medium: { icon: AlertTriangle, color: 'text-yellow-400', bg: 'bg-yellow-500/10 border-yellow-500/40' },
  high: { icon: XCircle, color: 'text-red-400', bg: 'bg-red-500/10 border-red-500/40' },
};

const DISPUTE_STATUS_LABEL = {
  opened: 'Opened',
  evidence_submitted: 'Evidence Submitted',
  won: 'Won',
  lost: 'Lost',
};
const DISPUTE_STATUS_STYLE = {
  opened: 'bg-yellow-500/15 text-yellow-400',
  evidence_submitted: 'bg-blue-500/15 text-blue-400',
  won: 'bg-green-500/15 text-green-400',
  lost: 'bg-red-500/15 text-red-400',
};

/**
 * Full record for a single past transaction — the page the Simulator's
 * result panel, the Alerts list, and the Transactions history table all
 * link into, so a transaction's SHAP explanation and reasons stay
 * reachable after the moment it was created, not just in the Simulator.
 */
export default function TransactionDetailPage() {
  const { user } = useAuth();
  const { id } = useParams();
  const [txn, setTxn] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // A transaction can have at most one dispute (see disputeRepository.js),
  // so this is a single record, not a list — undefined while loading,
  // null once we know there isn't one.
  const [dispute, setDispute] = useState(undefined);
  const [showDisputeForm, setShowDisputeForm] = useState(false);
  const [disputeReason, setDisputeReason] = useState('');
  const [disputeAmount, setDisputeAmount] = useState('');
  const [disputeSubmitting, setDisputeSubmitting] = useState(false);
  const [disputeError, setDisputeError] = useState('');

  // Step-up recovery (feature: step-up authentication) — a transaction
  // left in pending_step_up (e.g. the Simulator tab was closed before
  // it was resolved) is otherwise a dead end: the challenge_token was
  // only ever shown once, at creation. Polling here recovers it (the
  // poll endpoint returns it to the transaction's own owner/admin —
  // see routes/transactions.js) so it can still be resolved from here.
  const [stepUp, setStepUp] = useState(null);
  const [stepUpLoading, setStepUpLoading] = useState(false);
  const [stepUpBusy, setStepUpBusy] = useState(false);
  const [stepUpError, setStepUpError] = useState('');

  const load = useCallback(() => {
    setLoading(true);
    setError('');
    api.get(`/transactions/${id}`)
      .then(res => setTxn(res.data.transaction))
      .catch((err) => setError(err.response?.data?.error || 'Failed to load transaction'))
      .finally(() => setLoading(false));
  }, [id]);

  const loadDispute = useCallback(() => {
    // No "by transaction" filter on GET /disputes, so pull the caller's
    // own cases and match client-side — the list is small (one's own
    // disputes, not the whole system's).
    api.get('/disputes')
      .then(res => setDispute(res.data.disputes.find(d => d.transaction_id === Number(id)) || null))
      .catch(() => setDispute(null));
  }, [id]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { loadDispute(); }, [loadDispute]);

  useEffect(() => {
    if (txn?.status !== 'pending_step_up') return;
    setStepUpLoading(true);
    setStepUpError('');
    api.get(`/transactions/${id}/step-up`)
      .then(res => setStepUp(res.data))
      .catch((err) => setStepUpError(err.response?.data?.error || 'Failed to load the step-up challenge'))
      .finally(() => setStepUpLoading(false));
  }, [id, txn?.status]);

  const resolveStepUp = async (outcome) => {
    setStepUpBusy(true);
    setStepUpError('');
    try {
      const { data } = await api.post(`/transactions/${id}/step-up/verify`, {
        challenge_token: stepUp.challenge.challenge_token,
        outcome,
      });
      setTxn(data.transaction);
      setStepUp(null);
    } catch (err) {
      setStepUpError(err.response?.data?.error || 'Failed to resolve the step-up challenge');
    } finally {
      setStepUpBusy(false);
    }
  };

  const submitDispute = async (e) => {
    e.preventDefault();
    setDisputeSubmitting(true);
    setDisputeError('');
    try {
      const body = { transaction_id: Number(id), reason: disputeReason };
      if (disputeAmount) body.amount_disputed = Number(disputeAmount);
      const { data } = await api.post('/disputes', body);
      setDispute(data.dispute);
      setShowDisputeForm(false);
    } catch (err) {
      setDisputeError(err.response?.data?.error || 'Failed to open dispute');
    } finally {
      setDisputeSubmitting(false);
    }
  };

  if (loading) return (
    <div className="p-4 sm:p-8 max-w-3xl mx-auto"><LoadingState label="Loading transaction..." /></div>
  );
  if (error) return (
    <div className="p-4 sm:p-8 max-w-3xl mx-auto"><ErrorState message={error} onRetry={load} /></div>
  );
  if (!txn) return null;

  const risk = RISK_STYLE[txn.risk_level] || RISK_STYLE.low;
  const RiskIcon = risk.icon;
  const analysis = {
    is_fraud: txn.is_fraud,
    risk_level: txn.risk_level,
    scoring_method: txn.scoring_method,
    shap_explanation: txn.shap_explanation || [],
    model_used: txn.model_used,
    model_version: txn.model_version,
  };

  return (
    <div className="p-4 sm:p-8 max-w-3xl mx-auto">
      <Link to="/transactions" className="inline-flex items-center gap-2 text-gray-400 hover:text-white text-sm mb-6 transition-colors">
        <ArrowLeft size={16} /> Back to Transactions
      </Link>

      <div className={`border rounded-xl p-5 sm:p-8 ${risk.bg}`}>
        <div className="flex items-center gap-3 mb-6">
          <RiskIcon size={32} className={`${risk.color} shrink-0`} />
          <div className="min-w-0">
            <h1 className="text-xl sm:text-2xl font-bold text-white">{txn.merchant}</h1>
            <p className="text-gray-400 text-sm">Transaction #{txn.id} &middot; {new Date(txn.created_at).toLocaleString()}</p>
          </div>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 sm:gap-4 mb-6">
          <div className="bg-black/20 rounded-lg p-3 sm:p-4 text-center">
            <p className="text-gray-400 text-xs mb-1">Amount</p>
            <p className="text-lg sm:text-xl font-bold text-white">${Number(txn.amount).toFixed(2)}</p>
          </div>
          <div className="bg-black/20 rounded-lg p-3 sm:p-4 text-center">
            <p className="text-gray-400 text-xs mb-1">Fraud Score</p>
            <p className="text-lg sm:text-xl font-bold text-white">{txn.fraud_score}%</p>
          </div>
          <div className="bg-black/20 rounded-lg p-3 sm:p-4 text-center">
            <p className="text-gray-400 text-xs mb-1">Risk Level</p>
            <p className={`text-lg sm:text-xl font-bold capitalize ${risk.color}`}>{txn.risk_level}</p>
          </div>
          <div className="bg-black/20 rounded-lg p-3 sm:p-4 text-center">
            <p className="text-gray-400 text-xs mb-1">Card Type</p>
            <p className="text-lg sm:text-xl font-bold text-white capitalize">{txn.card_type}</p>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3 sm:gap-4 mb-6 text-sm">
          <div>
            <p className="text-gray-400 text-xs mb-1">Category</p>
            <p className="text-white capitalize">{txn.category}</p>
          </div>
          <div>
            <p className="text-gray-400 text-xs mb-1">Location</p>
            <p className="text-white">{txn.location}</p>
          </div>
        </div>

        <div className="mb-6">
          <FraudScoreExplanation analysis={analysis} />
        </div>

        {user?.role === 'admin' && (
          <p className="mb-4 text-sm">
            <Link className="text-cyan-300 hover:underline" to={`/relationships?transactionId=${txn.id}`}>Explore related accounts, devices and IPs →</Link>
          </p>
        )}
        {user?.role === 'admin' && <DecisionHistoryPanel transactionId={txn.id} />}

        {txn.fraud_reasons?.length > 0 ? (
          <div>
            <p className="text-gray-300 text-sm font-semibold mb-2">Risk Factors Detected:</p>
            <ul className="space-y-1">
              {txn.fraud_reasons.map((r, i) => (
                <li key={i} className="flex items-start gap-2 text-sm text-gray-300">
                  <AlertTriangle size={14} className="text-yellow-400 mt-0.5 shrink-0" />
                  {r}
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <p className="text-green-400 text-sm">No risk factors detected.</p>
        )}
      </div>

      {txn.status === 'pending_step_up' && (
        <div className="bg-blue-500/10 border border-blue-500/30 rounded-xl p-5 sm:p-6 mt-4">
          <div className="flex items-start gap-3">
            <ShieldQuestion size={20} className="text-blue-400 shrink-0 mt-0.5" />
            <div className="min-w-0 flex-1">
              <p className="text-blue-300 font-medium text-sm">Step-Up Verification Required</p>
              {stepUpLoading ? (
                <p className="text-gray-400 text-xs mt-1">Loading the pending challenge...</p>
              ) : stepUpError ? (
                <p className="text-red-400 text-xs mt-1">{stepUpError}</p>
              ) : stepUp ? (
                <>
                  <p className="text-gray-400 text-xs mt-1">
                    This transaction is still held (status: <code>pending_step_up</code>) pending your own {stepUp.challenge.method.toUpperCase()} flow.
                    In place of a real customer completing that flow, simulate the outcome below.
                  </p>
                  <div className="flex items-center gap-2 mt-3">
                    <button
                      onClick={() => resolveStepUp('success')}
                      disabled={stepUpBusy}
                      className="flex items-center gap-1 bg-green-600 hover:bg-green-700 disabled:opacity-50 text-white px-3 py-1.5 rounded-lg text-xs font-medium transition-colors"
                    >
                      <CheckCircle size={13} /> Simulate: Customer Verifies
                    </button>
                    <button
                      onClick={() => resolveStepUp('failure')}
                      disabled={stepUpBusy}
                      className="flex items-center gap-1 bg-red-600 hover:bg-red-700 disabled:opacity-50 text-white px-3 py-1.5 rounded-lg text-xs font-medium transition-colors"
                    >
                      <XCircle size={13} /> Simulate: Customer Fails
                    </button>
                  </div>
                </>
              ) : null}
            </div>
          </div>
        </div>
      )}
      {txn.status === 'blocked' && (
        <div className="bg-red-500/10 border border-red-500/30 rounded-xl px-5 py-4 mt-4 text-sm text-red-300">
          Blocked — the step-up verification failed, so this transaction was never completed.
        </div>
      )}

      <div className="bg-[#111820] border border-white/10 rounded-xl p-5 sm:p-6 mt-4">
        <div className="flex items-center gap-2 mb-1">
          <Scale size={18} className="text-purple-400" />
          <h2 className="text-white font-semibold">Dispute</h2>
        </div>

        {dispute === undefined ? (
          <p className="text-gray-500 text-sm">Checking dispute status...</p>
        ) : dispute ? (
          <div>
            <div className="flex items-center gap-2 mb-2">
              <span className={`text-[10px] font-semibold uppercase px-2 py-0.5 rounded-full ${DISPUTE_STATUS_STYLE[dispute.status]}`}>
                {DISPUTE_STATUS_LABEL[dispute.status]}
              </span>
              <span className="text-gray-400 text-xs">${Number(dispute.amount_disputed).toFixed(2)} disputed</span>
            </div>
            {dispute.reason && <p className="text-gray-300 text-sm mb-1">{dispute.reason}</p>}
            {dispute.resolution_note && <p className="text-gray-400 text-xs italic mb-1">&ldquo;{dispute.resolution_note}&rdquo;</p>}
            <Link to="/disputes" className="text-purple-400 hover:text-purple-300 text-sm transition-colors">View in Disputes &rarr;</Link>
          </div>
        ) : showDisputeForm ? (
          <form onSubmit={submitDispute} className="mt-3">
            <label className="block text-xs text-gray-400 mb-1">Why are you disputing this charge?</label>
            <textarea
              value={disputeReason}
              onChange={e => setDisputeReason(e.target.value)}
              required
              minLength={1}
              maxLength={500}
              rows={2}
              placeholder="I don't recognize this charge / item never arrived / billed twice, etc."
              className="w-full bg-[#0a0f14] border border-white/20 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-purple-500 mb-3"
            />
            <label className="block text-xs text-gray-400 mb-1">
              Amount to dispute <span className="text-gray-600">(optional — defaults to the full ${Number(txn.amount).toFixed(2)})</span>
            </label>
            <input
              type="number"
              step="0.01"
              min="0.01"
              max={txn.amount}
              value={disputeAmount}
              onChange={e => setDisputeAmount(e.target.value)}
              placeholder={Number(txn.amount).toFixed(2)}
              className="w-full bg-[#0a0f14] border border-white/20 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-purple-500 mb-3"
            />
            {disputeError && <p className="text-red-400 text-xs mb-3">{disputeError}</p>}
            <div className="flex items-center gap-2">
              <button
                type="submit"
                disabled={disputeSubmitting}
                className="bg-purple-600 hover:bg-purple-700 disabled:opacity-50 text-white px-4 py-2 rounded-lg text-sm transition-colors"
              >
                {disputeSubmitting ? 'Submitting...' : 'Submit Dispute'}
              </button>
              <button type="button" onClick={() => setShowDisputeForm(false)} className="text-gray-400 hover:text-white text-sm px-3 py-2 transition-colors">
                Cancel
              </button>
            </div>
          </form>
        ) : (
          <div className="flex items-center justify-between gap-4">
            <p className="text-gray-400 text-sm">Don't recognize this charge, or something went wrong with the order?</p>
            <button
              onClick={() => setShowDisputeForm(true)}
              className="shrink-0 bg-white/5 hover:bg-white/10 text-gray-200 px-4 py-2 rounded-lg text-sm transition-colors"
            >
              Open a Dispute
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

