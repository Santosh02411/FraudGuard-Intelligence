const { buildProfile, WEIGHTS } = require('../../services/customerProfileService');

const DAY = 86400000;
const now = Date.parse('2026-10-20T12:00:00Z');
const user = (ageDays) => ({ id: 1, username: 'u', created_at: new Date(now - ageDays * DAY).toISOString() });
const tx = (daysAgo, amount = 50, extra = {}) => ({ ts: now - daysAgo * DAY, amount, location: 'New York, US', device: 'd1', geo: 'plausible', ...extra });
// steady history: one ~$50 purchase per day, days 2..40
const steady = Array.from({ length: 39 }, (_, i) => tx(i + 2, 50 + (i % 5)));
const get = (p, n) => p.factors.find((f) => f.name === n);

test('weights sum to 100', () => {
  expect(Object.values(WEIGHTS).reduce((a, b) => a + b, 0)).toBe(100);
});

test('a steady, established account scores low with high confidence and every component scored', () => {
  const p = buildProfile({ user: user(400), txns: steady, now });
  expect(p).toMatchObject({ band: 'low', confidence: 'high' });
  expect(p.coverage.components_scored).toBe(6);
  expect(p.disclaimer).toMatch(/not evidence of fraud/);
});

test('a brand-new account with one transaction is capped at medium and says why; thin components are excluded, not guessed', () => {
  const p = buildProfile({ user: user(0.2), txns: [tx(0.1)], now });
  expect(p.confidence).toBe('low');
  expect(p.band).not.toBe('high');
  expect(get(p, 'spending').status).toBe('insufficient_data');
  expect(get(p, 'velocity').status).toBe('insufficient_data');
});

test('low confidence caps a high band at medium and says so', () => {
  const p = buildProfile({ user: user(0.2), txns: [tx(0.1)], outcomes: { reviewed: 2, confirmed: 2, falsePositive: 0 }, now });
  expect(p.band).toBe('medium');
  expect(p.score).toBeGreaterThanOrEqual(50);
  expect(p.notes.join(' ')).toMatch(/Capped at medium/);
});

test('spending: a 20x outlier in the last week drives the score and is explained with the ratio', () => {
  const p = buildProfile({ user: user(400), txns: [tx(0.5, 1100), ...steady], now });
  const s = get(p, 'spending');
  expect(s.score).toBe(100);
  expect(s.evidence[0]).toMatch(/20\.\dx|21\.\dx|2\d(\.\d)?x/);
});

test('velocity: a burst of transactions today versus a quiet baseline', () => {
  const burst = Array.from({ length: 12 }, (_, i) => tx(i * 0.002));
  const p = buildProfile({ user: user(400), txns: [...burst, ...steady], now });
  expect(get(p, 'velocity').score).toBeGreaterThanOrEqual(60);
  expect(get(p, 'velocity').evidence.join(' ')).toMatch(/single hour/);
});

test('devices: the first-ever device is not a change; three new ones in a week are, with a caveat about what a "device" is', () => {
  const quiet = buildProfile({ user: user(400), txns: steady, now });
  expect(get(quiet, 'devices').score).toBe(0);
  const changed = buildProfile({ user: user(400), txns: [tx(1, 50, { device: 'n1' }), tx(2, 50, { device: 'n2' }), tx(3, 50, { device: 'n3' }), ...steady], now });
  expect(get(changed, 'devices').score).toBe(80);
  expect(get(changed, 'devices').evidence.join(' ')).toMatch(/not a physical device/);
});

test('location: implausible-travel flags raise the score; city-level caveat always present', () => {
  const flagged = [tx(1, 50, { geo: 'implausible' }), tx(2, 50, { geo: 'implausible' }), ...steady];
  const l = get(buildProfile({ user: user(400), txns: flagged, now }), 'location');
  expect(l.score).toBe(70);
  expect(l.evidence.join(' ')).toMatch(/city-level/);
});

test('outcomes: confirmed fraud counts; no reviews is a zero, not unknown', () => {
  const o = get(buildProfile({ user: user(400), txns: steady, outcomes: { reviewed: 3, confirmed: 2, falsePositive: 1 }, now }), 'outcomes');
  expect(o.score).toBe(100);
  expect(get(buildProfile({ user: user(400), txns: steady, now }), 'outcomes')).toMatchObject({ status: 'ok', score: 0 });
});

test('contributions are explained, sorted, and sum (with rounding) to about the overall score', () => {
  const p = buildProfile({ user: user(400), txns: [tx(0.5, 1100), ...steady], outcomes: { reviewed: 1, confirmed: 1, falsePositive: 0 }, now });
  const contrib = p.factors.filter((f) => f.contribution !== null).map((f) => f.contribution);
  expect([...contrib].sort((a, b) => b - a)).toEqual(contrib);
  expect(Math.abs(contrib.reduce((a, b) => a + b, 0) - p.score)).toBeLessThanOrEqual(2);
  expect(p.top_factors.length).toBeGreaterThan(0);
});

test('never exposes raw identifiers', () => {
  const p = buildProfile({ user: user(400), txns: steady, now });
  expect(JSON.stringify(p)).not.toMatch(/d1|ip_address|fingerprint/i);
});
