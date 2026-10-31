/**
 * The backend must present the right credential to the ML service:
 * the service key for scoring/monitoring, and the separate admin key
 * only on calls that change model state.
 */
describe('ML service client credentials', () => {
  let fetchSpy;

  beforeEach(() => {
    jest.resetModules();
    process.env.ML_SERVICE_API_KEY = 'service-key-' + 's'.repeat(30);
    process.env.ML_ADMIN_API_KEY = 'admin-key-' + 'a'.repeat(30);
    fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true, status: 200, json: async () => ({ fraud_score: 1, risk_level: 'low', is_fraud: 0, top_factors: [] }),
    });
  });
  afterEach(() => {
    fetchSpy.mockRestore();
    delete process.env.ML_SERVICE_API_KEY;
    delete process.env.ML_ADMIN_API_KEY;
  });

  const headersOf = (call) => fetchSpy.mock.calls[call][1].headers;

  test('scoring sends the service key and never the admin key', async () => {
    const { scoreWithML } = require('../../models/mlClient');
    await scoreWithML({ amount: 10, merchant: 'x', category: 'food', location: 'New York, US', card_type: 'credit' }, []);
    expect(headersOf(0)['X-ML-Api-Key']).toBe(process.env.ML_SERVICE_API_KEY);
    expect(headersOf(0)['X-ML-Admin-Key']).toBeUndefined();
  });

  test('read-only monitoring calls send only the service key', async () => {
    const admin = require('../../services/mlAdminClient');
    await admin.getDrift();
    await admin.getShadowStatus();
    await admin.listVersions();
    for (const i of [0, 1, 2]) {
      expect(headersOf(i)['X-ML-Api-Key']).toBe(process.env.ML_SERVICE_API_KEY);
      expect(headersOf(i)['X-ML-Admin-Key']).toBeUndefined();
    }
  });

  test('every state-changing call also sends the admin key', async () => {
    const admin = require('../../services/mlAdminClient');
    await admin.setShadow('v1');
    await admin.clearShadow();
    await admin.activate({ version: 'v2', reason: 'approved change', actor: 'alice', changeId: 1, kind: 'promote' });
    await admin.resetDrift();
    for (const i of [0, 1, 2, 3]) {
      expect(headersOf(i)['X-ML-Admin-Key']).toBe(process.env.ML_ADMIN_API_KEY);
    }
  });

  test('credentials rejected by the ML service surface as a 503 ops error, not a 400', async () => {
    fetchSpy.mockResolvedValue({ ok: false, status: 403, json: async () => ({ detail: 'Invalid credentials' }) });
    const admin = require('../../services/mlAdminClient');
    await expect(admin.activate({ version: 'v2', reason: 'x', kind: 'promote' })).rejects.toMatchObject({ statusCode: 503 });
  });
});
