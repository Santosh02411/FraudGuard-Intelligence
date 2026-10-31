/**
 * Realistic per-user transaction timeline generator for demo/seed data.
 *
 * Produces a chronologically-ordered list of transaction specs for one
 * user across `days` days: mostly normal spending behavior, with a small
 * number of injected FRAUD SCENARIOS that mimic real attack patterns
 * rather than generic "high amount = fraud" noise:
 *
 *   - CARD_TESTING    : a burst of many tiny transactions across
 *                       different merchants in a couple of minutes —
 *                       how stolen card numbers get validated before
 *                       being used for a real purchase.
 *   - GEO_HOPPING      : transactions from wildly different locations
 *                       within an implausibly short time window —
 *                       "impossible travel."
 *   - VELOCITY_BURST   : many moderate-amount transactions in a short
 *                       window — an automated script draining a card.
 *   - ACCOUNT_TAKEOVER : one large transaction from a brand-new
 *                       device/IP, in a high-risk category, far from
 *                       the user's home location.
 *
 * This is intentionally separate from ml_service/generate_dataset.py
 * (which generates ML TRAINING data as a flat CSV) — this module writes
 * directly into the live app's transaction shape and is driven through
 * the actual scoring engine by scripts/seedDemoData.js, so the seeded
 * data reflects exactly what a real user of the app would see.
 */

const crypto = require('crypto');
const {
  MERCHANTS_BY_CATEGORY, SAFE_CATEGORIES, HIGH_RISK_CATEGORIES,
  SAFE_LOCATIONS, HIGH_RISK_LOCATIONS, pick, randRange,
} = require('./demoVocabulary');

function fakeFingerprint(seed) {
  return crypto.createHash('sha256').update(seed + Math.random()).digest('hex').slice(0, 16);
}

function fakeIp() {
  return `${randInt(1, 223)}.${randInt(0, 255)}.${randInt(0, 255)}.${randInt(1, 254)}`;
}

function randInt(min, max) {
  return Math.floor(randRange(min, max + 1));
}

function buildProfile(username) {
  const homeLocation = pick(SAFE_LOCATIONS);
  const preferredCategories = shuffle(SAFE_CATEGORIES).slice(0, randInt(2, 4));
  return {
    username,
    homeLocation,
    preferredCategories,
    typicalAmountMean: randRange(20, 180),
    typicalAmountStd: () => 0, // computed inline below
    cardType: pick(['credit', 'debit', 'debit', 'credit']), // mostly credit/debit, rarely prepaid
    knownDevices: [fakeFingerprint(username + '-dev1')],
    knownIps: [fakeIp()],
  };
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function normalTxn(profile, ts) {
  const category = pick(profile.preferredCategories);
  const merchant = pick(MERCHANTS_BY_CATEGORY[category]);
  const amount = Math.max(2, profile.typicalAmountMean * randRange(0.3, 1.8));
  const location = Math.random() < 0.88 ? profile.homeLocation : pick(SAFE_LOCATIONS);
  return {
    timestamp: ts,
    amount: round2(amount),
    merchant,
    category,
    location,
    card_type: profile.cardType,
    device_fingerprint: pick(profile.knownDevices),
    ip_address: pick(profile.knownIps),
    _scenario: 'normal',
  };
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

// --- Fraud scenario generators (each returns an array of txn specs) ---

function cardTestingScenario(profile, startTs) {
  const attackerDevice = fakeFingerprint(profile.username + '-attacker');
  const attackerIp = fakeIp();
  const count = randInt(6, 10);
  const txns = [];
  let t = startTs;
  for (let i = 0; i < count; i++) {
    t = new Date(t.getTime() + randRange(20, 90) * 1000); // 20-90 sec apart
    const category = pick(SAFE_CATEGORIES.concat(HIGH_RISK_CATEGORIES));
    txns.push({
      timestamp: t,
      amount: round2(randRange(0.5, 5)),
      merchant: pick(MERCHANTS_BY_CATEGORY[category]),
      category,
      location: pick(SAFE_LOCATIONS.concat(HIGH_RISK_LOCATIONS)),
      card_type: profile.cardType,
      device_fingerprint: attackerDevice,
      ip_address: attackerIp,
      _scenario: 'card_testing',
    });
  }
  return txns;
}

function geoHoppingScenario(profile, startTs) {
  const device = fakeFingerprint(profile.username + '-geo');
  const ip = fakeIp();
  const hops = shuffle(SAFE_LOCATIONS.concat(HIGH_RISK_LOCATIONS)).slice(0, randInt(3, 5));
  const txns = [];
  let t = startTs;
  for (const location of hops) {
    t = new Date(t.getTime() + randRange(8, 40) * 60 * 1000); // 8-40 min apart — impossible travel
    const category = pick(SAFE_CATEGORIES);
    txns.push({
      timestamp: t,
      amount: round2(randRange(80, 900)),
      merchant: pick(MERCHANTS_BY_CATEGORY[category]),
      category,
      location,
      card_type: profile.cardType,
      device_fingerprint: device,
      ip_address: ip,
      _scenario: 'geo_hopping',
    });
  }
  return txns;
}

function velocityBurstScenario(profile, startTs) {
  const device = fakeFingerprint(profile.username + '-burst');
  const ip = fakeIp();
  const count = randInt(6, 12);
  const location = pick(HIGH_RISK_LOCATIONS.concat([profile.homeLocation]));
  const txns = [];
  let t = startTs;
  for (let i = 0; i < count; i++) {
    t = new Date(t.getTime() + randRange(1, 3) * 60 * 1000); // 1-3 min apart
    const category = pick(SAFE_CATEGORIES);
    txns.push({
      timestamp: t,
      amount: round2(randRange(20, 150)),
      merchant: pick(MERCHANTS_BY_CATEGORY[category]),
      category,
      location,
      card_type: profile.cardType,
      device_fingerprint: device,
      ip_address: ip,
      _scenario: 'velocity_burst',
    });
  }
  return txns;
}

function accountTakeoverScenario(profile, startTs) {
  const category = pick(HIGH_RISK_CATEGORIES);
  return [{
    timestamp: startTs,
    amount: round2(randRange(1000, 5000)),
    merchant: pick(MERCHANTS_BY_CATEGORY[category]),
    category,
    location: pick(HIGH_RISK_LOCATIONS),
    card_type: profile.cardType,
    device_fingerprint: fakeFingerprint(profile.username + '-takeover'),
    ip_address: fakeIp(),
    _scenario: 'account_takeover',
  }];
}

const SCENARIOS = [cardTestingScenario, geoHoppingScenario, velocityBurstScenario, accountTakeoverScenario];

/**
 * Generates a full chronological transaction timeline for one user.
 * @param {object} profile - from buildProfile()
 * @param {number} days - how many days of history to simulate
 * @param {Date} endTime - the most recent timestamp (usually "now")
 * @param {number} txnsPerWeek - roughly how many normal transactions/week
 * @param {number} scenarioCount - how many fraud scenarios to inject
 */
function generateTimeline(profile, days, endTime, txnsPerWeek = 9, scenarioCount = 1) {
  const startTime = new Date(endTime.getTime() - days * 24 * 60 * 60 * 1000);
  const normalCount = Math.round((days / 7) * txnsPerWeek);

  const events = [];
  for (let i = 0; i < normalCount; i++) {
    const ts = new Date(startTime.getTime() + Math.random() * (endTime.getTime() - startTime.getTime()));
    events.push(normalTxn(profile, ts));
  }

  for (let i = 0; i < scenarioCount; i++) {
    const scenarioFn = pick(SCENARIOS);
    const ts = new Date(startTime.getTime() + Math.random() * (endTime.getTime() - startTime.getTime()));
    events.push(...scenarioFn(profile, ts));
  }

  events.sort((a, b) => a.timestamp - b.timestamp);
  return events;
}

module.exports = { buildProfile, generateTimeline, SCENARIOS };
