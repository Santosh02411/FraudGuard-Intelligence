/**
 * Unit tests for models/fraudEngine.js — the core of what makes this app
 * a "fraud detection" system rather than a CRUD app with a database. Three
 * things are tested in isolation:
 *
 *   1. checkHardRules — deterministic blacklist/threshold checks
 *   2. analyzeTransaction — the rule-engine scorer (also the ML fallback)
 *   3. analyzeTransactionHybrid — orchestrates both plus the ML client,
 *      which is mocked here so these tests never make a network call and
 *      never depend on ml_service actually running.
 */

jest.mock('../../models/mlClient');
const { scoreWithML } = require('../../models/mlClient');
const { DEFAULT_POLICY } = require('../../models/riskPolicy');
const { checkHardRules, checkNetworkRisk, analyzeTransaction, analyzeTransactionHybrid } = require('../../models/fraudEngine');

function baseTxn(overrides = {}) {
  return {
    amount: 50,
    merchant: 'Corner Cafe',
    category: 'dining',
    location: 'New York, US',
    card_type: 'credit',
    device_fingerprint: 'device-abc',
    ip_address: '203.0.113.5',
    ...overrides,
  };
}

describe('checkHardRules', () => {
  test('a clean transaction triggers nothing', () => {
    const result = checkHardRules(baseTxn());
    expect(result.triggered).toBe(false);
    expect(result.reasons).toEqual([]);
  });

  test('flags a blacklisted merchant', () => {
    const result = checkHardRules(baseTxn({ merchant: 'DarkNet Market Vendor #4' }));
    expect(result.triggered).toBe(true);
    expect(result.reasons.some((r) => r.includes('fraud blacklist'))).toBe(true);
  });

  test('blacklisted merchant match is case-insensitive', () => {
    const result = checkHardRules(baseTxn({ merchant: 'darknet market' }));
    expect(result.triggered).toBe(true);
  });

  test('flags a blacklisted location', () => {
    const result = checkHardRules(baseTxn({ location: 'Anonymous Proxy' }));
    expect(result.triggered).toBe(true);
    expect(result.reasons.some((r) => r.includes('Location is on the fraud blacklist'))).toBe(true);
  });

  test('flags an amount over the absolute cap regardless of anything else', () => {
    const result = checkHardRules(baseTxn({ amount: 10001 }));
    expect(result.triggered).toBe(true);
    expect(result.reasons.some((r) => r.includes('exceeds the hard cap'))).toBe(true);
  });

  test('does not flag an amount exactly at the cap', () => {
    const result = checkHardRules(baseTxn({ amount: 10000 }));
    expect(result.triggered).toBe(false);
  });

  test('flags a device fingerprint on the dynamic fraud blacklist', () => {
    const dynamicBlacklist = { devices: new Set(['device-abc']), ips: new Set() };
    const result = checkHardRules(baseTxn(), dynamicBlacklist);
    expect(result.triggered).toBe(true);
    expect(result.reasons.some((r) => r.includes('Device fingerprint'))).toBe(true);
  });

  test('flags an IP address on the dynamic fraud blacklist', () => {
    const dynamicBlacklist = { devices: new Set(), ips: new Set(['203.0.113.5']) };
    const result = checkHardRules(baseTxn(), dynamicBlacklist);
    expect(result.triggered).toBe(true);
    expect(result.reasons.some((r) => r.includes('IP address'))).toBe(true);
  });

  test('an empty dynamic blacklist does not throw and flags nothing extra', () => {
    expect(() => checkHardRules(baseTxn(), {})).not.toThrow();
  });

  test('multiple triggered rules all appear in reasons', () => {
    const result = checkHardRules(baseTxn({ amount: 20000, location: 'Anonymous Proxy' }));
    expect(result.reasons.length).toBeGreaterThanOrEqual(2);
  });
});

describe('analyzeTransaction (rule-engine scorer)', () => {
  test('a small, unremarkable transaction scores low risk', () => {
    const result = analyzeTransaction(baseTxn({ amount: 25 }));
    expect(result.risk_level).toBe('low');
    expect(result.is_fraud).toBe(0);
    expect(result.fraud_score).toBeLessThan(40);
  });

  test('amount just above the "high" threshold (3100) scores +40 and is flagged as fraud on its own', () => {
    const result = analyzeTransaction(baseTxn({ amount: 3001 }));
    expect(result.fraud_reasons.some((r) => r.includes('Very high transaction amount'))).toBe(true);
    expect(result.fraud_score).toBeGreaterThanOrEqual(40);
  });

  test('amount in the "medium" band (1500-3100) scores +20, not +40', () => {
    const result = analyzeTransaction(baseTxn({ amount: 2000 }));
    expect(result.fraud_reasons.some((r) => r.includes('High transaction amount'))).toBe(true);
    expect(result.fraud_reasons.some((r) => r.includes('Very high'))).toBe(false);
  });

  test('a high-risk merchant adds to the score and reasons', () => {
    const result = analyzeTransaction(baseTxn({ merchant: 'Casino Royale' }));
    expect(result.fraud_reasons.some((r) => r.includes('High-risk merchant'))).toBe(true);
  });

  test('a high-risk category (gambling/crypto/wire_transfer) adds to the score', () => {
    const result = analyzeTransaction(baseTxn({ category: 'crypto' }));
    expect(result.fraud_reasons.some((r) => r.includes('Suspicious transaction category'))).toBe(true);
  });

  test('a high-risk location adds to the score', () => {
    const result = analyzeTransaction(baseTxn({ location: 'Lagos, NG' }));
    expect(result.fraud_reasons.some((r) => r.includes('High-risk location'))).toBe(true);
  });

  test('a prepaid card adds to the score', () => {
    const result = analyzeTransaction(baseTxn({ card_type: 'prepaid' }));
    expect(result.fraud_reasons.some((r) => r.includes('Prepaid card'))).toBe(true);
  });

  test('5+ transactions in the last hour triggers high-velocity scoring', () => {
    const now = new Date('2026-01-01T12:00:00Z');
    const recentTxns = Array.from({ length: 5 }, (_, i) => ({
      created_at: new Date(now.getTime() - (i + 1) * 60 * 1000).toISOString(), // every previous minute
    }));
    const result = analyzeTransaction(baseTxn(), recentTxns, now);
    expect(result.fraud_reasons.some((r) => r.includes('High transaction velocity'))).toBe(true);
  });

  test('3-4 transactions in the last hour triggers elevated (not high) velocity scoring', () => {
    const now = new Date('2026-01-01T12:00:00Z');
    const recentTxns = Array.from({ length: 3 }, (_, i) => ({
      created_at: new Date(now.getTime() - (i + 1) * 60 * 1000).toISOString(),
    }));
    const result = analyzeTransaction(baseTxn(), recentTxns, now);
    expect(result.fraud_reasons.some((r) => r.includes('Elevated transaction velocity'))).toBe(true);
    expect(result.fraud_reasons.some((r) => r.includes('High transaction velocity'))).toBe(false);
  });

  test('transactions older than an hour do not count toward velocity', () => {
    const now = new Date('2026-01-01T12:00:00Z');
    const recentTxns = Array.from({ length: 5 }, (_, i) => ({
      created_at: new Date(now.getTime() - (2 * 60 + i) * 60 * 1000).toISOString(), // 2+ hours ago
    }));
    const result = analyzeTransaction(baseTxn(), recentTxns, now);
    expect(result.fraud_reasons.some((r) => r.includes('velocity'))).toBe(false);
  });

  test('score never exceeds 100 even when every rule stacks', () => {
    const now = new Date('2026-01-01T12:00:00Z');
    const recentTxns = Array.from({ length: 6 }, (_, i) => ({
      created_at: new Date(now.getTime() - (i + 1) * 60 * 1000).toISOString(),
    }));
    const result = analyzeTransaction(
      baseTxn({ amount: 50000, merchant: 'Casino Royale', category: 'gambling', location: 'Lagos, NG', card_type: 'prepaid' }),
      recentTxns,
      now
    );
    expect(result.fraud_score).toBeLessThanOrEqual(100);
  });

  test('risk_level thresholds: >=70 high+fraud, 40-69 medium+not-fraud, <40 low+not-fraud', () => {
    const high = analyzeTransaction(baseTxn({ amount: 5000, merchant: 'Casino Royale' })); // 40 (amount) + 30 (merchant) = 70
    expect(high.risk_level).toBe('high');
    expect(high.is_fraud).toBe(1);

    const medium = analyzeTransaction(baseTxn({ amount: 2000 })); // 20
    expect(medium.fraud_score).toBeLessThan(70);
    if (medium.fraud_score >= 40) {
      expect(medium.risk_level).toBe('medium');
      expect(medium.is_fraud).toBe(0);
    }

    const low = analyzeTransaction(baseTxn({ amount: 10 }));
    expect(low.risk_level).toBe('low');
    expect(low.is_fraud).toBe(0);
  });
});

describe('analyzeTransactionHybrid', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('a hard-rule hit overrides everything: forces high risk / fraud=1 / score=100, even if the ML model disagrees', async () => {
    scoreWithML.mockResolvedValue({
      fraud_score: 2,
      risk_level: 'low',
      is_fraud: 0,
      model_used: 'xgboost',
      model_version: '1.0.0',
      top_factors: [],
    });

    const result = await analyzeTransactionHybrid(baseTxn({ merchant: 'DarkNet Market' }), [], {});

    expect(result.risk_level).toBe('high');
    expect(result.is_fraud).toBe(1);
    expect(result.fraud_score).toBe(100);
    expect(result.scoring_method).toBe('hard_rule_override+ml');
    expect(result.hard_flag_triggered.length).toBeGreaterThan(0);
  });

  test('hard-rule hit with the ML service unavailable still overrides, scoring_method reflects no ML', async () => {
    scoreWithML.mockRejectedValue(new Error('ECONNREFUSED'));

    const result = await analyzeTransactionHybrid(baseTxn({ amount: 99999 }), [], {});

    expect(result.risk_level).toBe('high');
    expect(result.scoring_method).toBe('hard_rule_override');
    expect(result.model_used).toBeNull();
  });

  test('no hard-rule hit, ML available: uses the ML result verbatim for score/risk/fraud', async () => {
    scoreWithML.mockResolvedValue({
      fraud_score: 33,
      risk_level: 'medium',
      is_fraud: 0,
      model_used: 'xgboost',
      model_version: '1.0.0',
      top_factors: [
        { feature: 'category: crypto', shap_value: 0.42, effect: 'increased_risk' },
        { feature: 'repeat_retailer', shap_value: -0.1, effect: 'decreased_risk' },
      ],
    });

    const result = await analyzeTransactionHybrid(baseTxn(), [], {});

    expect(result.scoring_method).toBe('ml_model');
    expect(result.fraud_score).toBe(33);
    expect(result.risk_level).toBe('medium');
    expect(result.model_used).toBe('xgboost');
    // Only the increased_risk factor should surface as a human-readable reason.
    expect(result.fraud_reasons.some((r) => r.includes('category: crypto'))).toBe(true);
    expect(result.fraud_reasons.some((r) => r.includes('repeat_retailer'))).toBe(false);
  });

  test('no hard-rule hit, ML unavailable: falls back to the rule engine result', async () => {
    scoreWithML.mockRejectedValue(new Error('timeout'));

    const result = await analyzeTransactionHybrid(baseTxn({ amount: 4000 }), [], {});

    expect(result.scoring_method).toBe('rule_engine_fallback');
    expect(result.model_used).toBeNull();
    // Amount alone (4000 > 3100, the "high" amount band) scores 40 —
    // that lands in the "medium" risk band (40-69), not "high" (>=70),
    // since amount is only one of several contributing signals.
    expect(result.risk_level).toBe('medium');
  });

  test('fraud_reasons are deduplicated across hard-rule, ML, and rule-engine sources', async () => {
    scoreWithML.mockResolvedValue({
      fraud_score: 90,
      risk_level: 'high',
      is_fraud: 1,
      model_used: 'xgboost',
      model_version: '1.0.0',
      top_factors: [],
    });

    // amount over the absolute cap AND over the rule-engine's "high" threshold —
    // both layers would independently produce an amount-related reason.
    const result = await analyzeTransactionHybrid(baseTxn({ amount: 15000 }), [], {});
    const uniqueReasons = new Set(result.fraud_reasons);
    expect(uniqueReasons.size).toBe(result.fraud_reasons.length);
  });

  test('recent transaction velocity is passed through to the rule-engine layer inside the hybrid result', async () => {
    scoreWithML.mockRejectedValue(new Error('unavailable'));
    const now = new Date('2026-01-01T12:00:00Z');
    const recentTxns = Array.from({ length: 5 }, (_, i) => ({
      created_at: new Date(now.getTime() - (i + 1) * 60 * 1000).toISOString(),
    }));

    const result = await analyzeTransactionHybrid(baseTxn(), recentTxns, {}, now);
    expect(result.fraud_reasons.some((r) => r.includes('velocity'))).toBe(true);
  });

  test('a network hard-override (ring includes a confirmed-fraud account) forces high risk, even if the ML model disagrees', async () => {
    scoreWithML.mockResolvedValue({
      fraud_score: 3, risk_level: 'low', is_fraud: 0,
      model_used: 'xgboost', model_version: '1.0.0', top_factors: [],
    });

    const networkRisk = { triggered: true, hardOverride: true, ring: { size: 3, confirmed_fraud_members: ['mallory'] } };
    const result = await analyzeTransactionHybrid(baseTxn(), [], {}, undefined, networkRisk);

    expect(result.risk_level).toBe('high');
    expect(result.is_fraud).toBe(1);
    expect(result.fraud_score).toBe(100);
    expect(result.scoring_method).toBe('hard_rule_override+ml');
    expect(result.fraud_reasons.some((r) => r.includes('confirmed fraud history'))).toBe(true);
  });

  test('a network "watch" signal (large cluster, no confirmed fraud yet) bumps the score without overriding it', async () => {
    scoreWithML.mockResolvedValue({
      fraud_score: 20, risk_level: 'low', is_fraud: 0,
      model_used: 'xgboost', model_version: '1.0.0', top_factors: [],
    });

    const networkRisk = { triggered: true, hardOverride: false, ring: { size: 5, confirmed_fraud_members: [] } };
    const result = await analyzeTransactionHybrid(baseTxn(), [], {}, undefined, networkRisk);

    expect(result.fraud_score).toBe(45); // 20 (ML) + 25 (network watch boost)
    expect(result.risk_level).toBe('medium');
    expect(result.scoring_method).toBe('ml_model+network_watch');
    expect(result.fraud_reasons.some((r) => r.includes('unusually large cluster'))).toBe(true);
  });

  test('no network risk passed: behaves exactly as before (backward-compatible default)', async () => {
    scoreWithML.mockResolvedValue({
      fraud_score: 20, risk_level: 'low', is_fraud: 0,
      model_used: 'xgboost', model_version: '1.0.0', top_factors: [],
    });
    const result = await analyzeTransactionHybrid(baseTxn(), [], {});
    expect(result.fraud_score).toBe(20);
    expect(result.scoring_method).toBe('ml_model');
  });
});

describe('checkNetworkRisk', () => {
  test('not triggered when no network risk is passed', () => {
    expect(checkNetworkRisk()).toEqual({ triggered: false, hardOverride: false, reasons: [] });
  });

  test('produces a hard-override reason naming the confirmed-fraud count', () => {
    const result = checkNetworkRisk({ triggered: true, hardOverride: true, ring: { size: 4, confirmed_fraud_members: ['a', 'b'] } });
    expect(result.hardOverride).toBe(true);
    expect(result.reasons[0]).toContain('network of 4 accounts');
    expect(result.reasons[0]).toContain('2 account(s) with confirmed fraud history');
  });

  test('produces a watch-level reason without hard-override when no confirmed fraud is in the ring', () => {
    const result = checkNetworkRisk({ triggered: true, hardOverride: false, ring: { size: 5, confirmed_fraud_members: [] } });
    expect(result.hardOverride).toBe(false);
    expect(result.reasons[0]).toContain('shared with 4 other account(s)');
  });
});

describe('analyzeTransactionHybrid — calibration guard (model out-of-distribution blind spot)', () => {
  const mlLow = (features) => ({
    fraud_score: 8, risk_level: 'low', is_fraud: 0, model_used: 'random_forest',
    model_version: 'v2', top_factors: [], features,
  });
  const history = (n) => Array.from({ length: n }, (_, i) => ({
    created_at: new Date(Date.now() - (i + 1) * 3600e3 * 6).toISOString(),
    amount: 80, merchant: 'Whole Foods', location: 'New York, US',
  }));

  beforeEach(() => jest.clearAllMocks());

  test('a purchase far above the account\'s own median is floored at medium, with a reason', async () => {
    scoreWithML.mockResolvedValue(mlLow({ ratio_to_median_purchase_price: 30, distance_from_home: 0 }));
    const r = await analyzeTransactionHybrid(baseTxn({ amount: 2400 }), history(10), {});
    expect(r.risk_level).toBe('medium');
    expect(r.fraud_score).toBe(DEFAULT_POLICY.medium_threshold); // floor = the policy's medium threshold
    expect(r.is_fraud).toBe(0);
    expect(r.scoring_method).toBe('ml_model+calibration_floor');
    expect(r.ml_score_for_reference).toBe(8);
    expect(r.fraud_reasons.join(' ')).toMatch(/usual spend/);
  });

  test('far-from-home travel with elevated spend is floored at medium', async () => {
    scoreWithML.mockResolvedValue(mlLow({ ratio_to_median_purchase_price: 5, distance_from_home: 5570 }));
    const r = await analyzeTransactionHybrid(baseTxn({ amount: 400, location: 'London, UK' }), history(10), {});
    expect(r.risk_level).toBe('medium');
    expect(r.fraud_reasons.join(' ')).toMatch(/km from home/);
  });

  test('thin history: a large absolute amount is floored at medium; a small one is not', async () => {
    scoreWithML.mockResolvedValue(mlLow({ ratio_to_median_purchase_price: 1, distance_from_home: 0 }));
    const big = await analyzeTransactionHybrid(baseTxn({ amount: 2000 }), [], {});
    expect(big.risk_level).toBe('medium');
    const small = await analyzeTransactionHybrid(baseTxn({ amount: 90 }), [], {});
    expect(small.risk_level).toBe('low');
    expect(small.scoring_method).toBe('ml_model');
  });

  test('never lowers a score the model already raised, and ignores normal spend', async () => {
    scoreWithML.mockResolvedValue({ ...mlLow({ ratio_to_median_purchase_price: 30, distance_from_home: 0 }), fraud_score: 91, risk_level: 'high', is_fraud: 1 });
    const hi = await analyzeTransactionHybrid(baseTxn({ amount: 2400 }), history(10), {});
    expect(hi.fraud_score).toBe(91);
    expect(hi.scoring_method).toBe('ml_model');

    scoreWithML.mockResolvedValue(mlLow({ ratio_to_median_purchase_price: 1.1, distance_from_home: 0 }));
    const normal = await analyzeTransactionHybrid(baseTxn({ amount: 85 }), history(10), {});
    expect(normal.risk_level).toBe('low');
  });
});
