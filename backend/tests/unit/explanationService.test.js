const { templateExplanation, phraseForFeature } = require('../../services/explanationService');

// The LLM tier (generateExplanation) needs a real/mocked network call and
// is exercised indirectly via the route integration tests; these focus on
// the always-available deterministic template, since that's what's on
// screen whenever no ANTHROPIC_API_KEY is configured (the default).
describe('explanationService.templateExplanation', () => {
  test('a hard-rule override explains the hard flag, not SHAP factors', () => {
    const txn = {
      fraud_score: 100, risk_level: 'high', scoring_method: 'hard_rule_override',
      hard_flag_triggered: ['Merchant is on the fraud blacklist: "DarkNet Market"'],
      shap_explanation: [{ feature: 'amount', shap_value: 0.1, effect: 'increased_risk' }],
      fraud_reasons: ['Merchant is on the fraud blacklist: "DarkNet Market"'],
    };
    const text = templateExplanation(txn);
    expect(text).toContain('Blocked by a hard rule');
    expect(text).toContain('DarkNet Market'); // original casing of the flagged merchant preserved
    expect(text.endsWith('.')).toBe(true);
  });

  test('summarizes the top increasing SHAP factors into one sentence', () => {
    const txn = {
      fraud_score: 82, risk_level: 'high', scoring_method: 'ml_model',
      hard_flag_triggered: null,
      shap_explanation: [
        { feature: 'amount', shap_value: 0.4, effect: 'increased_risk' },
        { feature: 'is new device', shap_value: 0.3, effect: 'increased_risk' },
        { feature: 'category: gambling', shap_value: 0.2, effect: 'increased_risk' },
        { feature: 'repeat retailer', shap_value: -0.1, effect: 'decreased_risk' }, // excluded
      ],
      fraud_reasons: [],
    };
    const text = templateExplanation(txn);
    expect(text).toMatch(/^Flagged mainly due to/);
    expect(text).toContain('unusually large purchase amount');
    expect(text).toContain('new, unrecognized device');
    expect(text).toContain('gambling-category purchase');
    expect(text).toContain(', and'); // three-item Oxford-comma join
  });

  test('falls back to the rule-engine reason when no SHAP is available', () => {
    const txn = {
      fraud_score: 55, risk_level: 'medium', scoring_method: 'rule_engine_fallback',
      hard_flag_triggered: null, shap_explanation: [],
      fraud_reasons: ['High transaction amount ($2000.00)'],
    };
    const text = templateExplanation(txn);
    expect(text).toBe('High transaction amount ($2000.00).');
  });

  test('reports "no significant risk factors" for a clean low-risk transaction', () => {
    const txn = { fraud_score: 5, risk_level: 'low', scoring_method: 'ml_model', hard_flag_triggered: null, shap_explanation: [], fraud_reasons: [] };
    expect(templateExplanation(txn)).toBe('No significant risk factors were identified for this transaction.');
  });

  test('an unmapped feature name still produces a usable generic phrase', () => {
    expect(phraseForFeature('some_brand_new_feature')).toBe('elevated some_brand_new_feature');
  });

  test('location/card-type/IP-status prefixed features get natural phrasing', () => {
    expect(phraseForFeature('location: Lagos, NG')).toContain('Lagos, NG');
    expect(phraseForFeature('card type: prepaid')).toContain('prepaid card');
    expect(phraseForFeature('IP status: new')).toContain('flagged as new');
  });
});
