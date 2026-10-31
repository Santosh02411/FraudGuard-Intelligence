const request = require('supertest');
const app = require('../../app');
const { initSchema } = require('../../config/schema');

beforeAll(async () => {
  await initSchema();
});

const API = '/api/v1';

async function registerAndLogin(username) {
  const password = 'Str0ng!Passw0rd1';
  await request(app).post(`${API}/auth/register`).send({ username, email: `${username}@example.com`, password });
  const res = await request(app).post(`${API}/auth/login`).send({ username, password });
  return res.body.accessToken;
}

async function loginAdmin() {
  const res = await request(app).post(`${API}/auth/login`).send({ username: 'admin', password: 'admin123' });
  return res.body.accessToken;
}

describe('Fraud rules (admin rule builder)', () => {
  let userToken;
  let adminToken;

  beforeAll(async () => {
    userToken = await registerAndLogin('fraudrules_user');
    adminToken = await loginAdmin();
  });

  test('a regular user cannot list or manage fraud rules', async () => {
    expect((await request(app).get(`${API}/admin/fraud-rules`).set('Authorization', `Bearer ${userToken}`)).status).toBe(403);
    expect((await request(app).post(`${API}/admin/fraud-rules`).set('Authorization', `Bearer ${userToken}`).send({ rule_type: 'blacklist_merchant', value: 'x' })).status).toBe(403);
  });

  test('an admin sees the seeded default rules', async () => {
    const res = await request(app).get(`${API}/admin/fraud-rules`).set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.rules.length).toBeGreaterThanOrEqual(5); // seedDefaultsIfEmpty in config/schema.js
    expect(res.body.rules.some(r => r.rule_type === 'amount_cap')).toBe(true);
  });

  test('a blacklist rule requires a value, not a threshold', async () => {
    const res = await request(app).post(`${API}/admin/fraud-rules`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ rule_type: 'blacklist_merchant', threshold: 500 });
    expect(res.status).toBe(400);
  });

  test('an amount_cap rule requires a threshold, not a value', async () => {
    const res = await request(app).post(`${API}/admin/fraud-rules`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ rule_type: 'amount_cap', value: 'nope' });
    expect(res.status).toBe(400);
  });

  let ruleId;

  test('an admin can create a blacklist_ip rule', async () => {
    const res = await request(app).post(`${API}/admin/fraud-rules`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ rule_type: 'blacklist_ip', value: '198.51.100.7', reason: 'Known testing farm' });

    expect(res.status).toBe(201);
    expect(res.body.rule.rule_type).toBe('blacklist_ip');
    expect(res.body.rule.value).toBe('198.51.100.7');
    expect(!!res.body.rule.enabled).toBe(true);
    ruleId = res.body.rule.id;
  });

  test('a new rule takes effect on the very next transaction scored', async () => {
    const res = await request(app).post(`${API}/transactions`)
      .set('Authorization', `Bearer ${userToken}`)
      .set('X-Forwarded-For', '198.51.100.7')
      .send({ amount: 20, merchant: 'Corner Cafe', category: 'food', location: 'New York, US', card_type: 'credit' });

    expect(res.status).toBe(201);
    expect(!!res.body.transaction.is_fraud).toBe(true);
    expect((res.body.transaction.fraud_reasons || []).some(r => /admin-configured blacklist/i.test(r))).toBe(true);
  });

  test('disabling the rule stops it applying to the next transaction', async () => {
    const patchRes = await request(app).patch(`${API}/admin/fraud-rules/${ruleId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ enabled: false });
    expect(patchRes.status).toBe(200);
    expect(!!patchRes.body.rule.enabled).toBe(false);

    const res = await request(app).post(`${API}/transactions`)
      .set('Authorization', `Bearer ${userToken}`)
      .set('X-Forwarded-For', '198.51.100.7')
      .send({ amount: 20, merchant: 'Corner Cafe', category: 'food', location: 'New York, US', card_type: 'credit' });
    expect(res.status).toBe(201);
    expect((res.body.transaction.fraud_reasons || []).some(r => /admin-configured blacklist/i.test(r))).toBe(false);
  });

  test('a PATCH with no fields is rejected as a no-op', async () => {
    const res = await request(app).patch(`${API}/admin/fraud-rules/${ruleId}`).set('Authorization', `Bearer ${adminToken}`).send({});
    expect(res.status).toBe(400);
  });

  test('patching a non-existent rule returns 404', async () => {
    const res = await request(app).patch(`${API}/admin/fraud-rules/99999999`).set('Authorization', `Bearer ${adminToken}`).send({ enabled: true });
    expect(res.status).toBe(404);
  });

  test('an admin can permanently delete a rule', async () => {
    const res = await request(app).delete(`${API}/admin/fraud-rules/${ruleId}`).set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);

    const list = await request(app).get(`${API}/admin/fraud-rules`).set('Authorization', `Bearer ${adminToken}`);
    expect(list.body.rules.some(r => r.id === ruleId)).toBe(false);
  });

  test('deleting a non-existent rule returns 404', async () => {
    const res = await request(app).delete(`${API}/admin/fraud-rules/99999999`).set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(404);
  });
});

describe('Fraud rule impact preview (dry-run, no rule is created)', () => {
  let userToken;
  let adminToken;

  beforeAll(async () => {
    userToken = await registerAndLogin('rulepreview_user');
    adminToken = await loginAdmin();

    // A handful of transactions to preview against — distinct
    // merchants/amounts, and each with its own User-Agent/IP so this
    // doesn't feed into the fraud-ring/network-risk clustering that
    // would otherwise escalate later transactions' scores (see
    // tests/integration/stepUp.test.js's header for the full story).
    for (let i = 0; i < 3; i += 1) {
      await request(app).post(`${API}/transactions`).set('Authorization', `Bearer ${userToken}`)
        .set('User-Agent', `ua-preview-${i}`).set('X-Forwarded-For', `203.0.113.${20 + i}`)
        .send({ amount: 50, merchant: 'Preview Target Store', category: 'food', location: 'New York, US', card_type: 'credit' });
    }
    await request(app).post(`${API}/transactions`).set('Authorization', `Bearer ${userToken}`)
      .set('User-Agent', 'ua-preview-other').set('X-Forwarded-For', '203.0.113.30')
      .send({ amount: 9999, merchant: 'Some Other Shop', category: 'electronics', location: 'New York, US', card_type: 'credit' });
  });

  test('a regular user cannot preview a rule', async () => {
    const res = await request(app).post(`${API}/admin/fraud-rules/preview`).set('Authorization', `Bearer ${userToken}`)
      .send({ rule_type: 'blacklist_merchant', value: 'Preview Target Store' });
    expect(res.status).toBe(403);
  });

  test('counts and samples matching transactions for a blacklist_merchant preview', async () => {
    const res = await request(app).post(`${API}/admin/fraud-rules/preview`).set('Authorization', `Bearer ${adminToken}`)
      .send({ rule_type: 'blacklist_merchant', value: 'Preview Target Store' });

    expect(res.status).toBe(200);
    expect(res.body.matched_count).toBe(3);
    expect(res.body.sample).toHaveLength(3);
    expect(res.body.sample.every(t => t.merchant === 'Preview Target Store')).toBe(true);
  });

  test('a merchant with no matching transactions previews as zero', async () => {
    const res = await request(app).post(`${API}/admin/fraud-rules/preview`).set('Authorization', `Bearer ${adminToken}`)
      .send({ rule_type: 'blacklist_merchant', value: 'Nobody Has Shopped Here LLC' });

    expect(res.status).toBe(200);
    expect(res.body.matched_count).toBe(0);
    expect(res.body.sample).toEqual([]);
  });

  test('counts transactions over an amount_cap threshold', async () => {
    const res = await request(app).post(`${API}/admin/fraud-rules/preview`).set('Authorization', `Bearer ${adminToken}`)
      .send({ rule_type: 'amount_cap', threshold: 1000 });

    expect(res.status).toBe(200);
    expect(res.body.matched_count).toBeGreaterThanOrEqual(1);
    expect(res.body.sample.some(t => t.merchant === 'Some Other Shop')).toBe(true);
  });

  test('previewing does not create a rule', async () => {
    const before = await request(app).get(`${API}/admin/fraud-rules`).set('Authorization', `Bearer ${adminToken}`);
    await request(app).post(`${API}/admin/fraud-rules/preview`).set('Authorization', `Bearer ${adminToken}`)
      .send({ rule_type: 'blacklist_merchant', value: 'Preview Target Store' });
    const after = await request(app).get(`${API}/admin/fraud-rules`).set('Authorization', `Bearer ${adminToken}`);

    expect(after.body.rules.length).toBe(before.body.rules.length);
    expect(after.body.rules.some(r => r.value === 'Preview Target Store')).toBe(false);
  });

  test('a blacklist preview with a threshold instead of a value is rejected, same validation as create', async () => {
    const res = await request(app).post(`${API}/admin/fraud-rules/preview`).set('Authorization', `Bearer ${adminToken}`)
      .send({ rule_type: 'blacklist_merchant', threshold: 500 });
    expect(res.status).toBe(400);
  });
});

describe('Fraud rings (network/graph detection)', () => {
  let adminToken;
  let userToken;

  beforeAll(async () => {
    adminToken = await loginAdmin();
    userToken = await registerAndLogin('fraudrings_user');
  });

  test('a regular user cannot view fraud rings', async () => {
    const res = await request(app).get(`${API}/admin/fraud-rings`).set('Authorization', `Bearer ${userToken}`);
    expect(res.status).toBe(403);
  });

  test('accounts that share a device fingerprint form a ring', async () => {
    const sharedDevice = 'ring-test-device-xyz';
    const memberA = await registerAndLogin('ring_member_a');
    const memberB = await registerAndLogin('ring_member_b');

    await request(app).post(`${API}/transactions`).set('Authorization', `Bearer ${memberA}`).set('User-Agent', sharedDevice)
      .send({ amount: 15, merchant: 'Corner Cafe', category: 'food', location: 'New York, US', card_type: 'credit' });
    await request(app).post(`${API}/transactions`).set('Authorization', `Bearer ${memberB}`).set('User-Agent', sharedDevice)
      .send({ amount: 15, merchant: 'Corner Cafe', category: 'food', location: 'New York, US', card_type: 'credit' });

    const res = await request(app).get(`${API}/admin/fraud-rings`).set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.rings)).toBe(true);

    const ring = res.body.rings.find(r =>
      r.members.some(m => m.username === 'ring_member_a') && r.members.some(m => m.username === 'ring_member_b')
    );
    expect(ring).toBeDefined();
    expect(ring.size).toBeGreaterThanOrEqual(2);
    expect(['low', 'watch', 'high']).toContain(ring.risk);
  });
});

describe('SAR-style compliance report export (admin only)', () => {
  let ownerToken;
  let adminToken;
  let alertId;

  beforeAll(async () => {
    ownerToken = await registerAndLogin('sar_report_owner');
    adminToken = await loginAdmin();

    const txnRes = await request(app).post(`${API}/transactions`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ amount: 5000, merchant: 'Risky Merchant', category: 'electronics', location: 'Lagos, NG', card_type: 'prepaid' });
    const list = await request(app).get(`${API}/alerts`).set('Authorization', `Bearer ${ownerToken}`);
    alertId = list.body.alerts.find(a => a.transaction_id === txnRes.body.transaction.id)?.id;
    expect(alertId).toBeDefined();
  });

  test('a regular user cannot export a SAR report', async () => {
    const res = await request(app).get(`${API}/admin/alerts/${alertId}/sar-report`).set('Authorization', `Bearer ${ownerToken}`);
    expect(res.status).toBe(403);
  });

  test('an admin gets a PDF by default', async () => {
    const res = await request(app).get(`${API}/admin/alerts/${alertId}/sar-report`).set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/pdf/);
    expect(res.headers['content-disposition']).toMatch(/sar-report-alert-/);
    expect(Buffer.isBuffer(res.body) ? res.body.length : res.text.length).toBeGreaterThan(0);
  });

  test('?format=csv returns a CSV rendering of the same case', async () => {
    const res = await request(app).get(`${API}/admin/alerts/${alertId}/sar-report`).query({ format: 'csv' }).set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.text).toContain('Alert ID');
    expect(res.text).toContain('Risky Merchant');
    expect(res.text).toContain('NOT a completed regulatory'); // FOOTER_DISCLAIMER
  });

  test('a non-existent alert returns 404', async () => {
    const res = await request(app).get(`${API}/admin/alerts/99999999/sar-report`).set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(404);
  });

  test('an invalid format value is rejected', async () => {
    const res = await request(app).get(`${API}/admin/alerts/${alertId}/sar-report`).query({ format: 'docx' }).set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(400);
  });
});
