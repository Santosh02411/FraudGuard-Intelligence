const gv = require('../../models/geoVelocity');

const NY = 'New York, US'; const LON = 'London, UK'; const SYD = 'Sydney, AU';
const t0 = Date.parse('2026-10-01T10:00:00Z');
const at = (min) => t0 + min * 60000;
const ev = (a, b, min) => gv.evaluate({ location: a, at: t0 }, { location: b, at: at(min) });

describe('evaluate', () => {
  test('same place is plausible at any speed', () => {
    expect(ev(NY, NY, 0)).toMatchObject({ status: 'plausible', reason: 'same_area' });
  });
  test('New York -> Sydney in 30 minutes is implausible, with the arithmetic exposed', () => {
    const r = ev(NY, SYD, 30);
    expect(r.status).toBe('implausible');
    expect(r.distance_km).toBeGreaterThan(15000);
    expect(r.effective_distance_km).toBe(r.distance_km - 100);
    expect(r.min_travel_minutes).toBeGreaterThan(r.elapsed_minutes);
    expect(r.required_kmh).toBeGreaterThan(900);
  });
  test('New York -> London: 4 h is implausible, 12 h is plausible (flight + airport overhead)', () => {
    expect(ev(NY, LON, 4 * 60).status).toBe('implausible');
    expect(ev(NY, LON, 12 * 60)).toMatchObject({ status: 'plausible', reason: 'travel_feasible' });
  });
  test('gaps beyond the lookback window are always plausible', () => {
    expect(ev(NY, SYD, 49 * 60)).toMatchObject({ status: 'plausible', reason: 'long_gap' });
  });
  test('unresolvable locations are indeterminate, never "far away"', () => {
    expect(ev(NY, 'Unknown', 1)).toMatchObject({ status: 'indeterminate', reason: 'location_not_resolvable' });
    expect(ev('Anonymous Proxy', NY, 1).status).toBe('indeterminate');
    expect(ev(NY, 'Atlantis, XX', 1).status).toBe('indeterminate');
  });
  test('bad or out-of-order timestamps and missing history are indeterminate', () => {
    expect(gv.evaluate({ location: NY, at: 'nope' }, { location: LON, at: t0 }).reason).toBe('bad_timestamp');
    expect(gv.evaluate({ location: NY, at: at(10) }, { location: LON, at: t0 }).reason).toBe('clock_order');
    expect(gv.evaluate(null, { location: LON, at: t0 }).reason).toBe('no_previous_transaction');
  });
  test('city uncertainty gives near-misses the benefit of the doubt', () => {
    const tight = { ...gv.LIMITS, cityUncertaintyKm: 0 };
    const loose = { ...gv.LIMITS, cityUncertaintyKm: 4000 };
    const a = { location: NY, at: t0 }; const b = { location: LON, at: at(8 * 60 + 30) };
    expect(gv.evaluate(a, b, tight).status).toBe('plausible'); // 8.5h vs ~8.1h needed
    expect(gv.evaluate(a, { ...b, at: at(7 * 60) }, tight).status).toBe('implausible');
    expect(gv.evaluate(a, { ...b, at: at(7 * 60) }, loose).status).toBe('plausible'); // uncertainty swallows the distance
  });
  test('parses SQLite UTC timestamps without a zone marker', () => {
    expect(gv.toMs('2026-10-01 10:00:00')).toBe(Date.parse('2026-10-01T10:00:00Z'));
    expect(gv.toMs(new Date(t0))).toBe(t0);
  });
  test('pickPrevious skips unlocatable rows', () => {
    const rows = [{ location: 'Unknown', created_at: 'x' }, { location: NY, created_at: '2026-10-01 10:00:00' }];
    expect(gv.pickPrevious(rows).location).toBe(NY);
    expect(gv.pickPrevious([])).toBeNull();
  });
});

describe('applyToAnalysis', () => {
  const policy = { medium_threshold: 10, high_threshold: 50 };
  const implausible = { status: 'implausible', distance_km: 5500, elapsed_minutes: 20, min_travel_minutes: 480 };
  const low = { risk_level: 'low', fraud_score: 2, fraud_reasons: [], scoring_method: 'ml_model', is_fraud: 0 };

  test('flag: lifts LOW to MEDIUM only, never to HIGH, never fraud', () => {
    const r = gv.applyToAnalysis(low, implausible, 'flag', policy);
    expect(r).toMatchObject({ risk_level: 'medium', fraud_score: 10, is_fraud: 0, scoring_method: 'ml_model+geo_velocity' });
    expect(r.fraud_reasons[0]).toMatch(/not proof/);
    expect(low.risk_level).toBe('low'); // input not mutated
  });
  test('never lowers an existing level, still adds the reason', () => {
    const high = { ...low, risk_level: 'high', fraud_score: 80 };
    const r = gv.applyToAnalysis(high, implausible, 'flag', policy);
    expect(r.risk_level).toBe('high'); expect(r.fraud_score).toBe(80); expect(r.fraud_reasons).toHaveLength(1);
  });
  test('advisory records the reason but leaves level and score alone; off and plausible change nothing', () => {
    expect(gv.applyToAnalysis(low, implausible, 'advisory', policy)).toMatchObject({ risk_level: 'low', fraud_score: 2 });
    expect(gv.applyToAnalysis(low, implausible, 'off', policy)).toBe(low);
    expect(gv.applyToAnalysis(low, { status: 'plausible' }, 'flag', policy)).toBe(low);
  });
});
