/**
 * Risk-based verification policy — pure definitions (no database).
 *
 * What FraudGuard does and does not do: it RECOMMENDS and RECORDS an action per transaction
 * (approve / challenge / decline) and holds or blocks the transaction record in ITS OWN store.
 * It never moves money. The integrating payment system authorizes or refuses the payment, and runs
 * the actual verification (OTP, 3DS, ...) itself, reporting the outcome back. The live-feed demo
 * simulator (is_synthetic rows) never goes through this path at all.
 *
 * Modes:
 *   off       legacy behaviour: a medium-risk transaction is held only for accounts subscribed to step_up_required.
 *   advisory  the policy's recommendation is recorded and measured; live behaviour stays as in `off`.
 *   enforce   the policy's action is applied (hold / block). A challenge needs a way to reach the customer
 *             (a step_up_required webhook); without one the transaction is NOT held (recorded as unenforceable)
 *             so nobody is stranded in a hold nobody can resolve.
 */
const MODES = ['off', 'advisory', 'enforce'];
const ACTIONS = ['approve', 'challenge', 'decline'];
// Guard rails: friction on low-risk traffic is never worth it, and declining medium risk outright is too blunt.
const ALLOWED = Object.freeze({ low: ['approve'], medium: ['approve', 'challenge'], high: ['approve', 'challenge', 'decline'] });
const LIMITS = Object.freeze({ ttlMin: 30, ttlMax: 3600, noteMin: 10, noteMax: 500 });

const DEFAULT_POLICY = Object.freeze({
  version: 0, mode: 'off', actions: Object.freeze({ low: 'approve', medium: 'challenge', high: 'challenge' }),
  min_amount: null, ttl_seconds: 300, note: 'Built-in default (no verification policy saved yet)', created_by: null, created_at: null, source: 'default',
});

function validate({ mode, actions, min_amount, ttl_seconds }) {
  const problems = [];
  if (!MODES.includes(mode)) problems.push(`mode must be one of ${MODES.join(', ')}`);
  for (const level of Object.keys(ALLOWED)) {
    if (!ALLOWED[level].includes(actions?.[level])) problems.push(`${level}-risk action must be one of: ${ALLOWED[level].join(', ')}`);
  }
  if (min_amount !== null && min_amount !== undefined && !(min_amount >= 0)) problems.push('min_amount must be zero or more');
  if (!(ttl_seconds >= LIMITS.ttlMin && ttl_seconds <= LIMITS.ttlMax)) problems.push(`ttl_seconds must be between ${LIMITS.ttlMin} and ${LIMITS.ttlMax}`);
  return problems;
}

/**
 * Decides what to do with one scored transaction.
 * @returns {{mode, recommended, effective, enforced, reason}}  `recommended` is what the policy says; `effective` is what happens.
 */
function evaluate({ policy = DEFAULT_POLICY, level, amount, hasChannel }) {
  const legacy = level === 'medium' && hasChannel ? 'challenge' : 'approve';
  if (policy.mode === 'off') return { mode: 'off', recommended: legacy, effective: legacy, enforced: true, reason: legacy === 'challenge' ? 'legacy_step_up' : null };

  let recommended = policy.actions[level] || 'approve';
  let reason = null;
  if (recommended === 'challenge' && policy.min_amount !== null && policy.min_amount !== undefined && Number(amount) < Number(policy.min_amount)) {
    recommended = 'approve'; reason = 'below_min_amount';
  }
  if (policy.mode === 'advisory') return { mode: 'advisory', recommended, effective: legacy, enforced: false, reason: reason || 'advisory_only' };

  if (recommended === 'challenge' && !hasChannel) return { mode: 'enforce', recommended, effective: 'approve', enforced: false, reason: 'no_verification_channel' };
  return { mode: 'enforce', recommended, effective: recommended, enforced: true, reason };
}

module.exports = { MODES, ACTIONS, ALLOWED, LIMITS, DEFAULT_POLICY, validate, evaluate };
