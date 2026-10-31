/**
 * Risk policy — pure definitions (no database), shared by the fraud engine,
 * the repository and the analytics. See riskPolicyRepository.js for what a
 * "policy" is and why it is separate from the model probability.
 */

// Starting point derived from the validation sweep documented in
// docs/MODEL_VALIDATION.md (synthetic data): at 10 -> ~94% recall / ~81%
// precision on the review tier, at 50 -> "more likely than not fraud". Tune
// with POST /admin/risk-policy/simulate against YOUR reviewed alerts.
const DEFAULT_POLICY = Object.freeze({
  version: 0,
  medium_threshold: 10,
  high_threshold: 50,
  review_capacity_per_day: null,
  note: 'Built-in default (no policy has been saved yet)',
  created_by: null,
  created_at: null,
  source: 'default',
});

// Guard rails for the admin setting. A typo (medium = 0) would flag nearly
// every transaction; high = 100 would make the high tier unreachable.
const LIMITS = Object.freeze({ mediumMin: 0.5, mediumMax: 90, highMax: 99, minGap: 5, noteMin: 10, noteMax: 500 });

function validateThresholds(medium, high) {
  const problems = [];
  if (!(medium >= LIMITS.mediumMin && medium <= LIMITS.mediumMax)) {
    problems.push(`medium_threshold must be between ${LIMITS.mediumMin} and ${LIMITS.mediumMax}`);
  }
  if (!(high <= LIMITS.highMax)) problems.push(`high_threshold must be at most ${LIMITS.highMax}`);
  if (!(high - medium >= LIMITS.minGap)) problems.push(`high_threshold must be at least ${LIMITS.minGap} points above medium_threshold`);
  return problems;
}

/** Maps a score (0-100) to a risk level under a policy. */
function levelFor(score, policy = DEFAULT_POLICY) {
  if (score >= policy.high_threshold) return 'high';
  if (score >= policy.medium_threshold) return 'medium';
  return 'low';
}

// The rule-engine fallback scores in RULE POINTS (amount/merchant/velocity
// bands), not probabilities, so it keeps its own fixed bands — the admin
// risk policy applies only to calibrated model scores.
const RULE_ENGINE_POLICY = Object.freeze({ version: 0, medium_threshold: 40, high_threshold: 70 });

module.exports = { DEFAULT_POLICY, LIMITS, RULE_ENGINE_POLICY, validateThresholds, levelFor };
