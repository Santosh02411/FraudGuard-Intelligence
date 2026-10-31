/**
 * Risk policy: the model gives a PROBABILITY, the policy turns it into a
 * DECISION, and the two are stored separately.
 */
jest.mock('../../models/mlClient');

const { scoreWithML } = require('../../models/mlClient');
const { DEFAULT_POLICY, LIMITS, validateThresholds, levelFor } = require('../../models/riskPolicy');
const { analyzeTransactionHybrid } = require('../../models/fraudEngine');

const txn = (o = {}) => ({
  amount: 50, merchant: 'Corner Cafe', category: 'dining', location: 'New York, US', card_type: 'credit',
  device_fingerprint: 'd', ip_address: '1.1.1.1', ...o,
});
const ml = (score) => ({ fraud_score: score, model_probability: score / 100, model_used: 'random_forest', model_version: 'v3', top_factors: [] });
const policy = (medium, high, version = 7) => ({ version, medium_threshold: medium, high_threshold: high });

describe('levelFor / validateThresholds', () => {
  test('boundaries are inclusive at the threshold', () => {
    expect(levelFor(9.99, policy(10, 50))).toBe('low');
    expect(levelFor(10, policy(10, 50))).toBe('medium');
    expect(levelFor(49.9, policy(10, 50))).toBe('medium');
    expect(levelFor(50, policy(10, 50))).toBe('high');
  });

  test('guard rails reject nonsense thresholds', () => {
    expect(validateThresholds(10, 50)).toEqual([]);
    expect(validateThresholds(0, 50).join()).toMatch(/medium_threshold must be between/);
    expect(validateThresholds(95, 99).join()).toMatch(/medium_threshold must be between/);
    expect(validateThresholds(10, 100).join()).toMatch(/high_threshold must be at most/);
    expect(validateThresholds(40, 42).join()).toMatch(new RegExp(`at least ${LIMITS.minGap} points above`));
    expect(validateThresholds(NaN, 50).length).toBeGreaterThan(0);
  });
});

describe('analyzeTransactionHybrid applies the policy to the calibrated probability', () => {
  beforeEach(() => jest.clearAllMocks());

  test('the same model probability is a different DECISION under different policies, with one stored probability', async () => {
    scoreWithML.mockResolvedValue(ml(30));
    const lenient = await analyzeTransactionHybrid(txn(), [], {}, undefined, undefined, undefined, policy(35, 60, 2));
    const strict = await analyzeTransactionHybrid(txn(), [], {}, undefined, undefined, undefined, policy(10, 25, 3));

    expect(lenient.risk_level).toBe('low');
    expect(strict.risk_level).toBe('high');
    expect(strict.is_fraud).toBe(1);
    expect(lenient.model_probability).toBeCloseTo(0.3);
    expect(strict.model_probability).toBeCloseTo(0.3); // the fact about the transaction does not change
    expect(lenient.policy_version).toBe(2);
    expect(strict.policy_version).toBe(3);
  });

  test('is_fraud means "high under the policy in force", not a hardcoded 70', async () => {
    scoreWithML.mockResolvedValue(ml(55));
    expect((await analyzeTransactionHybrid(txn(), [], {}, undefined, undefined, undefined, policy(10, 50))).is_fraud).toBe(1);
    expect((await analyzeTransactionHybrid(txn(), [], {}, undefined, undefined, undefined, policy(10, 60))).is_fraud).toBe(0);
  });

  test('the live policy is passed to the ML client (for shadow-model agreement logging)', async () => {
    scoreWithML.mockResolvedValue(ml(5));
    const p = policy(12, 44);
    await analyzeTransactionHybrid(txn(), [], {}, undefined, undefined, undefined, p);
    expect(scoreWithML.mock.calls[0][3]).toBe(p);
  });

  test('a hard-rule override decides on its own but still records what the model said', async () => {
    scoreWithML.mockResolvedValue(ml(1.5));
    const r = await analyzeTransactionHybrid(txn({ merchant: 'DarkNet Market' }), [], {}, undefined, undefined, undefined, policy(10, 50, 4));
    expect(r.scoring_method).toBe('hard_rule_override+ml');
    expect(r.risk_level).toBe('high');
    expect(r.fraud_score).toBe(100);
    expect(r.model_probability).toBeCloseTo(0.015); // "the model alone would not have flagged this"
    expect(r.policy_version).toBe(4);
  });

  test('the calibration guard floors at the POLICY medium threshold, whatever it is', async () => {
    scoreWithML.mockResolvedValue({ ...ml(2), features: { ratio_to_median_purchase_price: 30, distance_from_home: 0 } });
    const history = Array.from({ length: 6 }, (_, i) => ({ created_at: new Date(Date.now() - (i + 1) * 3600e3 * 6).toISOString(), amount: 80, merchant: 'x', location: 'New York, US' }));
    const r = await analyzeTransactionHybrid(txn({ amount: 2400 }), history, {}, undefined, undefined, undefined, policy(25, 70));
    expect(r.fraud_score).toBe(25);
    expect(r.risk_level).toBe('medium');
    expect(r.model_probability).toBeCloseTo(0.02); // the pure model output is not overwritten by the floor
  });

  test('rule-engine fallback keeps its own fixed bands and is NOT subject to the probability policy', async () => {
    scoreWithML.mockRejectedValue(new Error('ML down'));
    // rule points for a $3500 txn = 40 (very high amount) -> medium under the rule engine's own bands
    const r = await analyzeTransactionHybrid(txn({ amount: 3500 }), [], {}, undefined, undefined, undefined, policy(60, 90));
    expect(r.scoring_method).toBe('rule_engine_fallback');
    expect(r.risk_level).toBe('medium');
    expect(r.model_probability).toBeNull();
  });

  test('default policy values are the documented ones', () => {
    expect(DEFAULT_POLICY).toMatchObject({ version: 0, medium_threshold: 10, high_threshold: 50 });
  });
});
