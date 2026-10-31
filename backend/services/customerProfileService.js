/**
 * Customer risk profiles — an EXPLAINABLE analyst aid built from an account's own history.
 *
 * What it is: six transparent components (spending, velocity, account age, device changes, location, confirmed
 * outcomes), each scored 0-100 with a fixed weight and the evidence that produced the score. Components without
 * enough data are reported as `insufficient_data` and excluded (weights renormalised) rather than guessed.
 *
 * What it is NOT: it does not feed live scoring, never blocks or declines anything, and is not proof of fraud.
 *  - "device" is a hash of the User-Agent, i.e. a browser/client class, not a physical device, so a new device is
 *    weak evidence (a new phone or browser update is normal).
 *  - Account age and thin history are uncertainty, not misconduct; with low confidence the band is capped at medium.
 *  - Shared devices/IPs between accounts are deliberately NOT used here (see services/relationshipService.js, which
 *    treats shared infrastructure with care).
 *  - Raw IPs and fingerprints are never returned, only counts.
 */
const db = require('../config/database');
const { toMs } = require('../models/geoVelocity');

const DAY = 86400000;
const WEIGHTS = Object.freeze({ spending: 20, velocity: 20, account_age: 10, devices: 15, location: 15, outcomes: 20 });
const BANDS = Object.freeze({ medium: 25, high: 50 });
const HISTORY_DAYS = 90;
const clamp = (v, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, v));
const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const round = (v, d = 1) => (v === null || v === undefined ? null : Math.round(v * 10 ** d) / 10 ** d);
const RANK = { low: 0, medium: 1, high: 2 };
const bandOf = (s) => (s >= BANDS.high ? 'high' : s >= BANDS.medium ? 'medium' : 'low');

function insufficient(name, why) { return { name, weight: WEIGHTS[name], status: 'insufficient_data', score: null, evidence: [why] }; }
function comp(name, score, evidence) { return { name, weight: WEIGHTS[name], status: 'ok', score: Math.round(clamp(score)), evidence }; }

function spending(txns, now) {
  const recent = txns.filter((t) => now - t.ts <= 7 * DAY);
  const baseline = txns.filter((t) => now - t.ts > 7 * DAY).map((t) => t.amount);
  if (baseline.length < 5) return insufficient('spending', `Needs at least 5 transactions older than 7 days for a baseline (has ${baseline.length}).`);
  if (!recent.length) return comp('spending', 0, [`No transactions in the last 7 days; baseline median is ${round(median(baseline), 2)}.`]);
  const med = median(baseline);
  const maxRecent = Math.max(...recent.map((t) => t.amount));
  const ratio = med > 0 ? maxRecent / med : 0;
  const score = ((ratio - 2) / 8) * 100; // 2x baseline = 0, 10x = 100
  return comp('spending', score, [`Largest transaction in the last 7 days is ${round(ratio)}x the account's median of ${round(med, 2)}.`]);
}

function velocity(txns, now) {
  const last24 = txns.filter((t) => now - t.ts <= DAY).length;
  const prior = txns.filter((t) => now - t.ts > DAY && now - t.ts <= 31 * DAY);
  if (prior.length < 5) return insufficient('velocity', `Needs at least 5 transactions in the prior 30 days for a baseline (has ${prior.length}).`);
  const perDay = Math.max(prior.length / 30, 0.5);
  const ratio = last24 / perDay;
  const hourly = new Map();
  for (const t of txns.filter((x) => now - x.ts <= 7 * DAY)) { const h = Math.floor(t.ts / 3600000); hourly.set(h, (hourly.get(h) || 0) + 1); }
  const peak = Math.max(0, ...hourly.values());
  let score = ((ratio - 2) / 6) * 100; // 2x usual daily rate = 0, 8x = 100
  const evidence = [`${last24} transaction(s) in the last 24 h versus a usual ${round(perDay)} per day (${round(ratio)}x).`];
  if (peak >= 6) { score = Math.max(score, 60); evidence.push(`Peak of ${peak} transactions within a single hour in the last 7 days.`); }
  return comp('velocity', score, evidence);
}

function accountAge(user, now) {
  const created = toMs(user.created_at);
  if (!Number.isFinite(created)) return insufficient('account_age', 'Account creation time is unknown.');
  const days = Math.max(0, (now - created) / DAY);
  const score = days < 1 ? 90 : days < 7 ? 70 : days < 30 ? 40 : days < 90 ? 15 : 0;
  return comp('account_age', score, [`Account is ${round(days)} day(s) old. A young account means little history to judge by, not wrongdoing.`]);
}

function devices(txns, now) {
  const withDev = txns.filter((t) => t.device);
  if (withDev.length < 3) return insufficient('devices', `Needs at least 3 transactions with a client identifier (has ${withDev.length}).`);
  const firstSeen = new Map();
  for (const t of [...withDev].sort((a, b) => a.ts - b.ts)) if (!firstSeen.has(t.device)) firstSeen.set(t.device, t.ts);
  const total = firstSeen.size;
  const firstTs = Math.min(...firstSeen.values());
  const newRecent = [...firstSeen.values()].filter((ts) => now - ts <= 7 * DAY && ts > firstTs).length; // the very first device is not a "change"
  const score = newRecent === 0 ? 0 : newRecent === 1 ? 20 : newRecent === 2 ? 50 : 80;
  const evidence = [`${total} distinct client(s) seen in ${HISTORY_DAYS} days; ${newRecent} first seen in the last 7 days.`,
    'A client identifier is a browser/app signature, not a physical device, so a new one is weak evidence on its own.'];
  return comp('devices', score, evidence);
}

function location(txns, now) {
  const last30 = txns.filter((t) => now - t.ts <= 30 * DAY);
  if (last30.length < 3) return insufficient('location', `Needs at least 3 transactions in the last 30 days (has ${last30.length}).`);
  const implausible = last30.filter((t) => t.geo === 'implausible').length;
  const distinct = new Set(last30.map((t) => t.location)).size;
  let score = implausible === 0 ? 0 : implausible === 1 ? 40 : implausible === 2 ? 70 : 100;
  const evidence = [`${distinct} distinct location(s) in the last 30 days; ${implausible} implausible-travel flag(s).`];
  if (distinct >= 5) { score = Math.max(score, 30); evidence.push('Five or more locations in 30 days.'); }
  evidence.push('Locations are city-level and may be the merchant\'s, not the cardholder\'s.');
  return comp('location', score, evidence);
}

function outcomes(o) {
  if (!o.reviewed) return { name: 'outcomes', weight: WEIGHTS.outcomes, status: 'ok', score: 0, evidence: ['No analyst-reviewed alerts on this account.'] };
  const score = o.confirmed >= 2 ? 100 : o.confirmed === 1 ? 70 : 0;
  return comp('outcomes', score, [`${o.confirmed} confirmed-fraud and ${o.falsePositive} false-positive verdict(s) among ${o.reviewed} reviewed alert(s).`]);
}

/** Pure: builds the profile from already-loaded rows. */
function buildProfile({ user, txns, outcomes: o = { reviewed: 0, confirmed: 0, falsePositive: 0 }, now = Date.now() }) {
  const t = txns.filter((x) => Number.isFinite(x.ts));
  const components = [spending(t, now), velocity(t, now), accountAge(user, now), devices(t, now), location(t, now), outcomes(o)];
  const usable = components.filter((c) => c.status === 'ok');
  const wSum = usable.reduce((s, c) => s + c.weight, 0);
  const score = wSum ? usable.reduce((s, c) => s + c.score * c.weight, 0) / wSum : 0;
  const confidence = t.length < 5 ? 'low' : t.length < 20 ? 'medium' : 'high';
  let band = bandOf(score);
  const notes = [];
  if (confidence === 'low' && band === 'high') { band = 'medium'; notes.push('Capped at medium: fewer than 5 transactions of history.'); }
  const factors = components
    .map((c) => ({ ...c, contribution: c.status === 'ok' && wSum ? round((c.score * c.weight) / wSum) : null }))
    .sort((a, b) => (b.contribution ?? -1) - (a.contribution ?? -1));
  return {
    user_id: user.id, username: user.username,
    score: Math.round(score), band, confidence,
    coverage: { components_scored: usable.length, components_total: components.length, transactions_considered: t.length, history_days: HISTORY_DAYS },
    top_factors: factors.filter((f) => f.contribution > 0).slice(0, 3).map((f) => ({ name: f.name, contribution: f.contribution, headline: f.evidence[0] })),
    factors, notes,
    disclaimer: 'Analyst aid only. Not used by live scoring, never blocks or declines a transaction, and is not evidence of fraud on its own.',
    computed_at: new Date(now).toISOString(),
  };
}

async function load(userId, now) {
  const user = await db.get('SELECT id, username, created_at FROM users WHERE id = ? AND deleted_at IS NULL', [userId]);
  if (!user) return null;
  const since = new Date(now - HISTORY_DAYS * DAY).toISOString().replace('T', ' ').slice(0, 19);
  const rows = await db.all(
    `SELECT amount, location, device_fingerprint, geo_velocity_status, created_at FROM transactions
     WHERE user_id = ? AND is_synthetic = 0 AND created_at >= ? ORDER BY created_at DESC LIMIT 2000`, [userId, since]);
  const o = await db.get(
    `SELECT COUNT(CASE WHEN verdict IS NOT NULL THEN 1 END) AS reviewed,
            COUNT(CASE WHEN verdict = 'confirmed_fraud' THEN 1 END) AS confirmed,
            COUNT(CASE WHEN verdict = 'false_positive' THEN 1 END) AS fp FROM alerts WHERE user_id = ?`, [userId]);
  return {
    user,
    txns: rows.map((r) => ({ amount: Number(r.amount), location: r.location, device: r.device_fingerprint, geo: r.geo_velocity_status, ts: toMs(r.created_at) })),
    outcomes: { reviewed: Number(o.reviewed), confirmed: Number(o.confirmed), falsePositive: Number(o.fp) },
  };
}

async function getProfile(userId, now = Date.now()) {
  const d = await load(userId, now);
  return d ? buildProfile({ ...d, now }) : null;
}

/** Highest-scoring recently active accounts. Scans at most `scan` accounts, ordered by recent activity. */
async function topRisk({ limit = 25, scan = 200, minBand = null, now = Date.now() } = {}) {
  const since = new Date(now - 30 * DAY).toISOString().replace('T', ' ').slice(0, 19);
  const ids = await db.all(
    `SELECT user_id, COUNT(*) AS n FROM transactions WHERE is_synthetic = 0 AND created_at >= ? GROUP BY user_id ORDER BY n DESC LIMIT ?`, [since, scan]);
  const out = [];
  for (const { user_id: id } of ids) {
    // eslint-disable-next-line no-await-in-loop
    const p = await getProfile(id, now);
    if (p && (!minBand || RANK[p.band] >= RANK[minBand])) {
      out.push({ user_id: p.user_id, username: p.username, score: p.score, band: p.band, confidence: p.confidence, top_factors: p.top_factors, transactions_considered: p.coverage.transactions_considered });
    }
  }
  out.sort((a, b) => b.score - a.score);
  return { profiles: out.slice(0, limit), scanned: ids.length, scan_cap: scan, truncated: ids.length >= scan };
}

module.exports = { buildProfile, getProfile, topRisk, WEIGHTS, BANDS };
