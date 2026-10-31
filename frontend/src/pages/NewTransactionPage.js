import React, { useState } from 'react';
import { api } from '../context/AuthContext';
import FraudScoreExplanation from '../components/FraudScoreExplanation';
import {
  CheckCircle, XCircle, AlertTriangle, Dices, Send, FlaskConical,
  ShoppingBag, Plane, Laptop, Coins, Dice5, Ghost, ListChecks, ShieldQuestion,
} from 'lucide-react';
import PageHeading from '../components/ui/PageHeading';

// Kept in sync with the ML model's training vocabulary
// (ml_service/generate_dataset.py MERCHANT_CATEGORIES) and location table
// (backend/models/geo.js / ml_service/utils/geo.py) — using different
// strings here would mean the model treats every one of these as an
// unrecognized category/location instead of scoring it properly.
const MERCHANTS = ['Amazon', 'Walmart', 'Whole Foods', 'Starbucks', 'Netflix', 'Uber', 'Airbnb', 'Apple Store', 'Shell Gas', "McDonald's", 'Casino Vegas', 'CryptoExchange Pro'];
const CATEGORIES = ['grocery', 'food', 'electronics', 'travel', 'entertainment', 'utilities', 'clothing', 'health', 'crypto', 'gambling', 'wire_transfer'];
const LOCATIONS = ['New York, US', 'London, UK', 'Toronto, CA', 'Bengaluru, IN', 'Sydney, AU', 'Berlin, DE', 'Singapore, SG', 'Lagos, NG', 'Unknown', 'Anonymous Proxy'];
const CARD_TYPES = ['credit', 'debit', 'prepaid'];

function rand(min, max) { return Math.random() * (max - min) + min; }
function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

/**
 * Named scenarios an ops analyst would actually want to replay against
 * the live engine — realistic field combinations with a stated intent,
 * rather than a single "shuffle everything" gimmick. `amount` is still
 * randomized within a bounded, scenario-appropriate range each run so the
 * same scenario isn't identical every time.
 */
const SCENARIOS = [
  {
    id: 'normal_grocery',
    label: 'Normal Grocery Run',
    description: 'Everyday low-risk purchase from a known merchant.',
    expected: 'low',
    icon: ShoppingBag,
    build: () => ({
      amount: rand(15, 180).toFixed(2),
      merchant: pick(['Whole Foods', 'Walmart', 'Starbucks']),
      category: pick(['grocery', 'food']),
      location: 'New York, US',
      card_type: pick(['credit', 'debit']),
    }),
  },
  {
    id: 'weekend_travel',
    label: 'Weekend Travel Booking',
    description: 'Mid-size travel purchase from a new geography.',
    expected: 'medium',
    icon: Plane,
    build: () => ({
      amount: rand(400, 1400).toFixed(2),
      merchant: 'Airbnb',
      category: 'travel',
      location: pick(['London, UK', 'Singapore, SG', 'Sydney, AU', 'Berlin, DE']),
      card_type: pick(['credit', 'debit']),
    }),
  },
  {
    id: 'high_value_electronics',
    label: 'High-Value Electronics',
    description: 'Large single purchase — tests amount-threshold sensitivity.',
    expected: 'medium',
    icon: Laptop,
    build: () => ({
      amount: rand(1800, 3400).toFixed(2),
      merchant: 'Apple Store',
      category: 'electronics',
      location: 'New York, US',
      card_type: 'credit',
    }),
  },
  {
    id: 'crypto_transfer',
    label: 'Crypto Exchange Transfer',
    description: 'High-risk category + high-risk merchant combined.',
    expected: 'high',
    icon: Coins,
    build: () => ({
      amount: rand(500, 5000).toFixed(2),
      merchant: 'CryptoExchange Pro',
      category: 'crypto',
      location: pick(['Unknown', 'Singapore, SG']),
      card_type: pick(['credit', 'prepaid']),
    }),
  },
  {
    id: 'prepaid_gambling',
    label: 'Prepaid Card Burst',
    description: 'Prepaid card into a gambling merchant — a classic velocity/prepaid pattern.',
    expected: 'high',
    icon: Dice5,
    build: () => ({
      amount: rand(100, 900).toFixed(2),
      merchant: 'Casino Vegas',
      category: 'gambling',
      location: pick(['New York, US', 'Toronto, CA']),
      card_type: 'prepaid',
    }),
  },
  {
    id: 'anonymous_proxy',
    label: 'Anonymous Proxy Login',
    description: 'Blacklisted location — should trip a hard-rule override.',
    expected: 'high',
    icon: Ghost,
    build: () => ({
      amount: rand(50, 2500).toFixed(2),
      merchant: pick(['CryptoExchange Pro', 'Amazon']),
      category: pick(['wire_transfer', 'electronics']),
      location: 'Anonymous Proxy',
      card_type: pick(['credit', 'prepaid']),
    }),
  },
];

function RiskChip({ level }) {
  const styles = {
    low: 'bg-green-500/15 text-green-400',
    medium: 'bg-yellow-500/15 text-yellow-400',
    high: 'bg-red-500/15 text-red-400',
  };
  return <span className={`text-[10px] font-semibold uppercase px-1.5 py-0.5 rounded ${styles[level]}`}>expect: {level}</span>;
}

export default function NewTransactionPage() {
  const [form, setForm] = useState({
    amount: '',
    merchant: '',
    category: 'grocery',
    location: 'New York, US',
    card_type: 'credit',
  });
  const [activeScenario, setActiveScenario] = useState(null);
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  // Step-up auth hook (feature: step-up authentication) — only present
  // when the account has a webhook subscribed to
  // 'transaction.step_up_required' (see Settings) and this transaction
  // scored medium-risk. FraudGuard holds the transaction and waits for
  // a verify call; in this demo, Claude is standing in for "the
  // merchant's own OTP/3DS flow", so these buttons simulate the
  // customer completing (or failing) that flow out of band.
  const [stepUp, setStepUp] = useState(null);
  const [stepUpBusy, setStepUpBusy] = useState(false);
  const [stepUpError, setStepUpError] = useState('');

  const applyScenario = (scenario) => {
    setForm(scenario.build());
    setActiveScenario(scenario.id);
    setResult(null);
    setError('');
  };

  const fuzzFields = () => {
    setForm({
      amount: rand(10, 4000).toFixed(2),
      merchant: pick(MERCHANTS),
      category: pick(CATEGORIES),
      location: pick(LOCATIONS),
      card_type: pick(CARD_TYPES),
    });
    setActiveScenario(null);
    setResult(null);
    setError('');
  };

  const handleFieldChange = (patch) => {
    setForm((f) => ({ ...f, ...patch }));
    setActiveScenario(null);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setResult(null);
    setStepUp(null);
    setStepUpError('');
    setLoading(true);
    try {
      const { data } = await api.post('/transactions', { ...form, amount: Number(form.amount) });
      setResult(data);
      if (data.step_up?.required) setStepUp(data.step_up);
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to process transaction');
    } finally {
      setLoading(false);
    }
  };

  const resolveStepUp = async (outcome) => {
    setStepUpBusy(true);
    setStepUpError('');
    try {
      const { data } = await api.post(`/transactions/${stepUp.transaction_id}/step-up/verify`, {
        challenge_token: stepUp.challenge_token,
        outcome,
      });
      // The transaction's is_fraud/risk_level/reasons don't change —
      // only its status does (pending_step_up -> completed/blocked) —
      // so merge the updated row into the existing analysis view rather
      // than treating this as a fresh scoring result.
      setResult(prev => ({ ...prev, transaction: data.transaction, challenge_status: data.challenge_status || (outcome === 'success' ? 'verified' : 'failed') }));
      setStepUp(null);
    } catch (err) {
      setStepUpError(err.response?.data?.error || 'Failed to resolve the step-up challenge');
    } finally {
      setStepUpBusy(false);
    }
  };

  const inputClass = "w-full bg-[#0a0f14] border border-white/20 rounded-lg px-4 py-2.5 text-white focus:outline-none focus:border-purple-500 transition-colors";
  const labelClass = "block text-sm text-gray-300 mb-1";

  return (
    <div className="p-4 sm:p-8 max-w-6xl mx-auto">
      <div className="mb-6 sm:mb-8 flex items-center gap-3">
        <div className="w-11 h-11 rounded-xl bg-purple-500/15 flex items-center justify-center shrink-0">
          <FlaskConical size={22} className="text-purple-400" />
        </div>
        <div>
          <PageHeading icon={FlaskConical} title="Transaction Simulator" subtitle="Run a scenario — or a fully custom transaction — through the live fraud engine and inspect exactly how it was scored." subtitleClassName="text-gray-400 mt-1 text-sm sm:text-base" />
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">
        {/* Scenario library */}
        <div className="lg:col-span-2 bg-[#111820] border border-white/10 rounded-xl p-5 sm:p-6 h-fit">
          <div className="flex items-center gap-2 mb-1 text-white font-semibold">
            <ListChecks size={16} className="text-purple-400" /> Scenario Library
          </div>
          <p className="text-gray-500 text-xs mb-4">Load a realistic pattern into the form below, then submit it.</p>
          <div className="space-y-2">
            {SCENARIOS.map((s) => {
              const Icon = s.icon;
              const active = activeScenario === s.id;
              return (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => applyScenario(s)}
                  className={`w-full text-left flex items-start gap-3 p-3 rounded-lg border transition-colors hover-lift ${
                    active
                      ? 'bg-purple-500/10 border-purple-500/50'
                      : 'bg-black/20 border-white/5 hover:border-white/20 hover:bg-white/5'
                  }`}
                >
                  <Icon size={18} className={active ? 'text-purple-300' : 'text-gray-400'} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-sm font-medium text-white truncate">{s.label}</p>
                      <RiskChip level={s.expected} />
                    </div>
                    <p className="text-gray-500 text-xs mt-0.5">{s.description}</p>
                  </div>
                </button>
              );
            })}
          </div>

          <button
            type="button"
            onClick={fuzzFields}
            className="w-full flex items-center justify-center gap-2 text-sm text-gray-300 hover:text-white border border-white/10 hover:border-white/30 px-3 py-2 rounded-lg transition-colors mt-4"
          >
            <Dices size={14} /> Fuzz random fields
          </button>
        </div>

        {/* Form + result */}
        <div className="lg:col-span-3">
          <div className="bg-[#111820] border border-white/10 rounded-xl p-5 sm:p-8">
            <div className="flex items-center justify-between mb-6">
              <h2 className="text-lg font-semibold text-white">Transaction Details</h2>
              {activeScenario && (
                <span className="text-xs text-purple-300 bg-purple-500/10 px-2 py-1 rounded-full">
                  Scenario: {SCENARIOS.find((s) => s.id === activeScenario)?.label}
                </span>
              )}
            </div>

            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className={labelClass}>Amount ($)</label>
                  <input
                    type="number"
                    step="0.01"
                    min="0.01"
                    value={form.amount}
                    onChange={e => handleFieldChange({ amount: e.target.value })}
                    className={inputClass}
                    placeholder="e.g. 150.00"
                    required
                  />
                </div>
                <div>
                  <label className={labelClass}>Merchant</label>
                  <input
                    type="text"
                    value={form.merchant}
                    onChange={e => handleFieldChange({ merchant: e.target.value })}
                    className={inputClass}
                    placeholder="e.g. Amazon"
                    required
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className={labelClass}>Category</label>
                  <select
                    value={form.category}
                    onChange={e => handleFieldChange({ category: e.target.value })}
                    className={inputClass}
                  >
                    {CATEGORIES.map(c => (
                      <option key={c} value={c} className="bg-[#111820] capitalize">{c}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className={labelClass}>Card Type</label>
                  <select
                    value={form.card_type}
                    onChange={e => handleFieldChange({ card_type: e.target.value })}
                    className={inputClass}
                  >
                    {CARD_TYPES.map(c => (
                      <option key={c} value={c} className="bg-[#111820] capitalize">{c}</option>
                    ))}
                  </select>
                </div>
              </div>

              <div>
                <label className={labelClass}>Location</label>
                <select
                  value={form.location}
                  onChange={e => handleFieldChange({ location: e.target.value })}
                  className={inputClass}
                >
                  {LOCATIONS.map(l => (
                    <option key={l} value={l} className="bg-[#111820]">{l}</option>
                  ))}
                </select>
              </div>

              {error && (
                <div className="bg-red-500/10 border border-red-500/30 text-red-400 rounded-lg px-4 py-3 text-sm">
                  {error}
                </div>
              )}

              <button
                type="submit"
                disabled={loading}
                className="w-full flex items-center justify-center gap-2 bg-purple-600 hover:bg-purple-700 disabled:opacity-50 text-white py-3 rounded-lg font-medium transition-colors mt-2"
              >
                <Send size={16} />
                {loading ? 'Analyzing...' : 'Run Through Fraud Engine'}
              </button>
            </form>
          </div>

          {/* Result Panel */}
          {result && (
            <div className={`mt-6 border rounded-xl p-5 sm:p-8 ${
              result.analysis.is_fraud
                ? 'bg-red-500/10 border-red-500/40'
                : result.analysis.risk_level === 'medium'
                ? 'bg-yellow-500/10 border-yellow-500/40'
                : 'bg-green-500/10 border-green-500/40'
            }`}>
              <div className="flex items-center gap-3 mb-4">
                {result.analysis.is_fraud ? (
                  <XCircle size={32} className="text-red-400 shrink-0" />
                ) : result.analysis.risk_level === 'medium' ? (
                  <AlertTriangle size={32} className="text-yellow-400 shrink-0" />
                ) : (
                  <CheckCircle size={32} className="text-green-400 shrink-0" />
                )}
                <div className="min-w-0">
                  <h3 className={`text-xl font-bold ${
                    result.analysis.is_fraud ? 'text-red-400' : result.analysis.risk_level === 'medium' ? 'text-yellow-400' : 'text-green-400'
                  }`}>
                    {result.analysis.message}
                  </h3>
                  <p className="text-gray-400 text-sm">Transaction ID: #{result.transaction.id}</p>
                </div>
              </div>

              {stepUp && (
                <div className="mb-4 bg-blue-500/10 border border-blue-500/30 rounded-lg p-4 sm:p-5">
                  <div className="flex items-start gap-3">
                    <ShieldQuestion size={20} className="text-blue-400 shrink-0 mt-0.5" />
                    <div className="min-w-0 flex-1">
                      <p className="text-blue-300 font-medium text-sm">Step-Up Verification Required</p>
                      <p className="text-gray-400 text-xs mt-1">
                        This medium-risk transaction is held (status: <code>pending_step_up</code>) pending your own {stepUp.method.toUpperCase()} flow —
                        FraudGuard doesn't run this itself, and it never authorizes or moves a payment. In place of a real customer completing that flow, simulate the outcome below.
                      </p>
                      {stepUpError && <p className="text-red-400 text-xs mt-2">{stepUpError}</p>}
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
                        <button
                          onClick={() => resolveStepUp('abandoned')}
                          disabled={stepUpBusy}
                          className="flex items-center gap-1 bg-gray-600 hover:bg-gray-700 disabled:opacity-50 text-white px-3 py-1.5 rounded-lg text-xs font-medium transition-colors"
                        >
                          Simulate: Customer Abandons
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {result.geo_velocity && result.geo_velocity.status === 'implausible' && (
                <div className="mb-4 bg-amber-500/10 border border-amber-500/30 rounded-lg px-4 py-3 text-sm text-amber-200" role="note">
                  Possible implausible travel: about {result.geo_velocity.distance_km} km from the previous transaction's location {result.geo_velocity.elapsed_minutes} minutes earlier
                  (needs roughly {result.geo_velocity.min_travel_minutes} minutes even by air).
                  {result.geo_velocity.mode === 'flag' ? ' This raised the transaction to at least medium risk.' : ' Recorded for review only; the risk level was not changed.'}
                  {' '}Locations are city-level and can reflect a merchant or VPN, so this is a prompt to review, not proof.
                </div>
              )}
              {result.verification && result.verification.applied_action === 'decline' && (
                <div className="mb-4 bg-red-500/10 border border-red-500/30 rounded-lg px-4 py-3 text-sm text-red-300">
                  Declined by the risk-based verification policy (v{result.verification.policy_version}). FraudGuard recorded this decision; your payment system is what refuses the payment.
                </div>
              )}
              {result.verification && result.verification.mode === 'advisory' && result.verification.recommended_action !== 'approve' && (
                <div className="mb-4 bg-blue-500/10 border border-blue-500/30 rounded-lg px-4 py-3 text-sm text-blue-300">
                  Advisory only: the verification policy would have recommended <b>{result.verification.recommended_action}</b>. Nothing was held or blocked.
                </div>
              )}
              {!stepUp && result.transaction.status === 'blocked' && result.verification?.applied_action !== 'decline' && (
                <div className="mb-4 bg-red-500/10 border border-red-500/30 rounded-lg px-4 py-3 text-sm text-red-300">
                  {result.challenge_status === 'abandoned'
                    ? 'Blocked — the customer abandoned the step-up verification, so this transaction was never completed.'
                    : 'Blocked — the step-up verification failed, so this transaction was never completed.'}
                </div>
              )}
              {!stepUp && result.transaction.status === 'completed' && result.step_up?.required && (
                <div className="mb-4 bg-green-500/10 border border-green-500/30 rounded-lg px-4 py-3 text-sm text-green-300">
                  Verified — the step-up check passed and this transaction completed.
                </div>
              )}

              <div className="grid grid-cols-3 gap-3 sm:gap-4 mb-4">
                <div className="bg-black/20 rounded-lg p-3 sm:p-4 text-center">
                  <p className="text-gray-400 text-xs mb-1">Fraud Score</p>
                  <p className="text-xl sm:text-2xl font-bold text-white">{result.analysis.fraud_score}%</p>
                </div>
                <div className="bg-black/20 rounded-lg p-3 sm:p-4 text-center">
                  <p className="text-gray-400 text-xs mb-1">Risk Level</p>
                  <p className={`text-xl sm:text-2xl font-bold capitalize ${
                    result.analysis.risk_level === 'high' ? 'text-red-400' :
                    result.analysis.risk_level === 'medium' ? 'text-yellow-400' : 'text-green-400'
                  }`}>{result.analysis.risk_level}</p>
                </div>
                <div className="bg-black/20 rounded-lg p-3 sm:p-4 text-center">
                  <p className="text-gray-400 text-xs mb-1">Amount</p>
                  <p className="text-xl sm:text-2xl font-bold text-white">${Number(form.amount).toFixed(2)}</p>
                </div>
              </div>

              <div className="mb-4">
                <FraudScoreExplanation analysis={result.analysis} />
              </div>

              {result.analysis.fraud_reasons.length > 0 ? (
                <div>
                  <p className="text-gray-300 text-sm font-semibold mb-2">Risk Factors Detected:</p>
                  <ul className="space-y-1">
                    {result.analysis.fraud_reasons.map((r, i) => (
                      <li key={i} className="flex items-start gap-2 text-sm text-gray-300">
                        <AlertTriangle size={14} className="text-yellow-400 mt-0.5 shrink-0" />
                        {r}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : (
                <p className="text-green-400 text-sm">No risk factors detected. This transaction appears safe.</p>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
