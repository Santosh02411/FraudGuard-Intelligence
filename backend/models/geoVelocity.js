/**
 * Geo-velocity ("impossible travel") check — pure, no database.
 *
 * Question asked: given the account's previous located transaction and this one, could the same cardholder
 * physically have been at both places in the elapsed time?
 *
 * Honest limits, which shape the design:
 *  - Locations are CITY-LEVEL labels from a small lookup table, not GPS. Each end carries an uncertainty radius
 *    (CITY_UNCERTAINTY_KM) which is SUBTRACTED from the distance, so near-misses are given the benefit of the doubt.
 *  - Card-not-present purchases often carry the MERCHANT's location, and VPNs/proxies move IP locations, so an
 *    implausible result is a prompt for a look, never proof. On its own it can raise a low transaction to MEDIUM,
 *    never to HIGH, and never blocks.
 *  - Unknown / anonymised / unmapped locations are INDETERMINATE (not "far away"), unlike models/geo.js which treats
 *    them as maximally distant for the ML feature.
 *  - Long gaps are plausible by construction (any two cities are reachable within MAX_LOOKBACK_HOURS).
 */
const { coordsFor, haversineKm } = require('./geo');

const LIMITS = Object.freeze({
  maxPlausibleKmh: 900,        // commercial flight cruise speed
  overheadHours: 2,            // airport/transfer time added once the trip is long enough to need a flight
  overheadAboveKm: 300,
  cityUncertaintyKm: 50,       // per end; subtracted from the great-circle distance
  maxLookbackHours: 48,        // beyond this, travel is always plausible
  minDistanceKm: 100,          // below this (after uncertainty) never flagged
});
const MODES = ['off', 'advisory', 'flag'];
const UNLOCATABLE = new Set(['Unknown', 'Anonymous Proxy']);

function isLocatable(location) {
  if (!location || UNLOCATABLE.has(location)) return false;
  const [lat, lon] = coordsFor(location);
  return !(lat === 0 && lon === 0);
}

function toMs(v) {
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'number') return v;
  if (typeof v !== 'string') return NaN;
  // SQLite CURRENT_TIMESTAMP is 'YYYY-MM-DD HH:MM:SS' in UTC with no zone marker.
  const iso = /[zZ]|[+-]\d\d:?\d\d$/.test(v) ? v : `${v.replace(' ', 'T')}Z`;
  return Date.parse(iso);
}

/**
 * @param {{location:string, at:(string|Date|number)}} prev  previous located transaction
 * @param {{location:string, at:(string|Date|number)}} curr
 * @returns {{status:'plausible'|'implausible'|'indeterminate', reason:string, distance_km:number|null,
 *            effective_distance_km:number|null, elapsed_minutes:number|null, required_kmh:number|null,
 *            min_travel_minutes:number|null}}
 */
function evaluate(prev, curr, limits = LIMITS) {
  const blank = { distance_km: null, effective_distance_km: null, elapsed_minutes: null, required_kmh: null, min_travel_minutes: null };
  if (!prev || !curr) return { status: 'indeterminate', reason: 'no_previous_transaction', ...blank };
  if (!isLocatable(prev.location) || !isLocatable(curr.location)) {
    return { status: 'indeterminate', reason: 'location_not_resolvable', ...blank };
  }
  const t0 = toMs(prev.at);
  const t1 = toMs(curr.at);
  if (!Number.isFinite(t0) || !Number.isFinite(t1)) return { status: 'indeterminate', reason: 'bad_timestamp', ...blank };
  const elapsedH = (t1 - t0) / 3600000;
  if (elapsedH < 0) return { status: 'indeterminate', reason: 'clock_order', ...blank };

  const distance = haversineKm(prev.location, curr.location);
  const effective = Math.max(0, distance - 2 * limits.cityUncertaintyKm);
  const base = {
    distance_km: Math.round(distance), effective_distance_km: Math.round(effective),
    elapsed_minutes: Math.round(elapsedH * 60),
  };
  if (elapsedH > limits.maxLookbackHours) return { status: 'plausible', reason: 'long_gap', ...base, required_kmh: null, min_travel_minutes: null };
  if (effective < limits.minDistanceKm) return { status: 'plausible', reason: 'same_area', ...base, required_kmh: null, min_travel_minutes: null };

  const minTravelH = effective / limits.maxPlausibleKmh + (effective > limits.overheadAboveKm ? limits.overheadHours : 0);
  const requiredKmh = elapsedH > 0 ? Math.round(effective / elapsedH) : null;
  const out = { ...base, required_kmh: requiredKmh, min_travel_minutes: Math.round(minTravelH * 60) };
  return elapsedH < minTravelH
    ? { status: 'implausible', reason: 'faster_than_travel', ...out }
    : { status: 'plausible', reason: 'travel_feasible', ...out };
}

/** Newest previous transaction that has a resolvable location, from a newest-first list. */
function pickPrevious(recentTxns) {
  return (recentTxns || []).find((t) => isLocatable(t.location) && t.created_at) || null;
}

function reasonText(g) {
  return `Possible implausible travel: ${g.distance_km} km from the previous transaction's location ${g.elapsed_minutes} minutes earlier `
    + `(needs about ${g.min_travel_minutes} minutes even by air). Locations are city-level and may reflect a merchant or VPN, so this is a prompt to review, not proof.`;
}

/**
 * Applies the result to an analysis object WITHOUT mutating it. `flag` mode may lift LOW to MEDIUM (score floored at
 * the policy's medium threshold); it never lowers a level and never creates HIGH. `advisory` only records the result.
 */
function applyToAnalysis(analysis, g, mode, policy) {
  if (mode === 'off' || !g || g.status !== 'implausible') return analysis;
  const reasons = [...(analysis.fraud_reasons || []), reasonText(g)];
  if (mode !== 'flag') return { ...analysis, fraud_reasons: reasons };
  if (analysis.risk_level !== 'low') return { ...analysis, fraud_reasons: reasons, scoring_method: `${analysis.scoring_method}+geo_velocity` };
  return {
    ...analysis,
    fraud_reasons: reasons,
    fraud_score: Math.max(analysis.fraud_score, policy.medium_threshold),
    risk_level: 'medium',
    scoring_method: `${analysis.scoring_method}+geo_velocity`,
  };
}

module.exports = { LIMITS, MODES, evaluate, pickPrevious, applyToAnalysis, isLocatable, toMs, reasonText };
