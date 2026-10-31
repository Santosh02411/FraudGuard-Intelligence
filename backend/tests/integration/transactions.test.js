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

describe('POST /transactions', () => {
  test('requires authentication', async () => {
    const res = await request(app).post(`${API}/transactions`).send({
      amount: 50, merchant: 'Corner Cafe', category: 'food', location: 'New York, US', card_type: 'credit',
    });
    expect(res.status).toBe(401);
  });

  test('a small, ordinary transaction scores low risk and creates no alert', async () => {
    const token = await registerAndLogin('txn_user_low');
    const res = await request(app).post(`${API}/transactions`)
      .set('Authorization', `Bearer ${token}`)
      .send({ amount: 25, merchant: 'Corner Cafe', category: 'food', location: 'New York, US', card_type: 'credit' });

    expect(res.status).toBe(201);
    expect(res.body.transaction.risk_level).toBe('low');
    expect(res.body.transaction.is_fraud).toBe(0);
  });

  test('a large transaction to a high-risk location gets flagged and creates an alert', async () => {
    const token = await registerAndLogin('txn_user_high');
    const res = await request(app).post(`${API}/transactions`)
      .set('Authorization', `Bearer ${token}`)
      .send({ amount: 5000, merchant: 'Some Shop', category: 'electronics', location: 'Lagos, NG', card_type: 'prepaid' });

    expect(res.status).toBe(201);
    expect(res.body.transaction.risk_level).toBe('high');
    expect(res.body.transaction.is_fraud).toBe(1);
    expect(Array.isArray(res.body.transaction.fraud_reasons)).toBe(true);
  });

  test('rejects an invalid payload (bad category/location enum)', async () => {
    const token = await registerAndLogin('txn_user_invalid');
    const res = await request(app).post(`${API}/transactions`)
      .set('Authorization', `Bearer ${token}`)
      .send({ amount: 25, merchant: 'X', category: 'not-a-real-category', location: 'Nowhere', card_type: 'credit' });
    expect(res.status).toBe(400);
  });
});

describe('GET /transactions — pagination', () => {
  let token;

  beforeAll(async () => {
    token = await registerAndLogin('txn_pagination_user');
    // Create 5 transactions to page through.
    for (let i = 0; i < 5; i++) {
      await request(app).post(`${API}/transactions`)
        .set('Authorization', `Bearer ${token}`)
        .send({ amount: 10 + i, merchant: 'Repeat Shop', category: 'food', location: 'New York, US', card_type: 'credit' });
    }
  });

  test('defaults to page 1 with pagination metadata', async () => {
    const res = await request(app).get(`${API}/transactions`).set('Authorization', `Bearer ${token}`).query({ limit: 2 });
    expect(res.status).toBe(200);
    expect(res.body.transactions.length).toBe(2);
    expect(res.body.pagination).toMatchObject({ page: 1, limit: 2, total: 5 });
    expect(res.body.pagination.has_next).toBe(true);
  });

  test('page 2 returns the next slice and reflects has_prev', async () => {
    const res = await request(app).get(`${API}/transactions`).set('Authorization', `Bearer ${token}`).query({ page: 2, limit: 2 });
    expect(res.status).toBe(200);
    expect(res.body.transactions.length).toBe(2);
    expect(res.body.pagination.has_prev).toBe(true);
  });

  test('rejects a limit above the max', async () => {
    const res = await request(app).get(`${API}/transactions`).set('Authorization', `Bearer ${token}`).query({ limit: 9999 });
    expect(res.status).toBe(400);
  });
});

describe('GET /transactions — filters', () => {
  let token;

  beforeAll(async () => {
    token = await registerAndLogin('txn_filter_user');
    await request(app).post(`${API}/transactions`).set('Authorization', `Bearer ${token}`)
      .send({ amount: 40, merchant: 'Filter Cafe', category: 'food', location: 'New York, US', card_type: 'credit' });
    await request(app).post(`${API}/transactions`).set('Authorization', `Bearer ${token}`)
      .send({ amount: 6000, merchant: 'Filter Electronics', category: 'electronics', location: 'Lagos, NG', card_type: 'prepaid' });
  });

  test('filters by merchant (partial match)', async () => {
    const res = await request(app).get(`${API}/transactions`).set('Authorization', `Bearer ${token}`).query({ merchant: 'Electronics' });
    expect(res.status).toBe(200);
    expect(res.body.transactions.every((t) => t.merchant.includes('Electronics'))).toBe(true);
    expect(res.body.transactions.length).toBeGreaterThan(0);
  });

  test('filters by riskLevel', async () => {
    const res = await request(app).get(`${API}/transactions`).set('Authorization', `Bearer ${token}`).query({ riskLevel: 'high' });
    expect(res.status).toBe(200);
    expect(res.body.transactions.every((t) => t.risk_level === 'high')).toBe(true);
  });

  test('filters by amount range', async () => {
    const res = await request(app).get(`${API}/transactions`).set('Authorization', `Bearer ${token}`).query({ amountMin: 100 });
    expect(res.status).toBe(200);
    expect(res.body.transactions.every((t) => t.amount >= 100)).toBe(true);
  });

  test('rejects an invalid category filter', async () => {
    const res = await request(app).get(`${API}/transactions`).set('Authorization', `Bearer ${token}`).query({ category: 'not-a-category' });
    expect(res.status).toBe(400);
  });
});

describe('GET /transactions/:id', () => {
  let ownerToken;
  let otherUserToken;
  let adminToken;
  let txnId;

  beforeAll(async () => {
    ownerToken = await registerAndLogin('txn_detail_owner');
    otherUserToken = await registerAndLogin('txn_detail_stranger');
    const adminRes = await request(app).post(`${API}/auth/login`).send({ username: 'admin', password: 'admin123' });
    adminToken = adminRes.body.accessToken;

    const txnRes = await request(app).post(`${API}/transactions`).set('Authorization', `Bearer ${ownerToken}`)
      .send({ amount: 75, merchant: 'Detail Shop', category: 'grocery', location: 'New York, US', card_type: 'credit' });
    txnId = txnRes.body.transaction.id;
  });

  test('the owner can view their own transaction, including shap_explanation', async () => {
    const res = await request(app).get(`${API}/transactions/${txnId}`).set('Authorization', `Bearer ${ownerToken}`);
    expect(res.status).toBe(200);
    expect(res.body.transaction.id).toBe(txnId);
    expect(Array.isArray(res.body.transaction.shap_explanation)).toBe(true);
  });

  test('a different user cannot view someone else\'s transaction', async () => {
    const res = await request(app).get(`${API}/transactions/${txnId}`).set('Authorization', `Bearer ${otherUserToken}`);
    expect(res.status).toBe(403);
  });

  test('an admin can view any transaction', async () => {
    const res = await request(app).get(`${API}/transactions/${txnId}`).set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
  });

  test('viewing a non-existent transaction returns 404', async () => {
    const res = await request(app).get(`${API}/transactions/99999999`).set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(404);
  });

  test('the audit trail records the view', async () => {
    const res = await request(app).get(`${API}/admin/audit-logs`).set('Authorization', `Bearer ${adminToken}`)
      .query({ action: 'transactions.view', targetId: txnId });
    expect(res.status).toBe(200);
    expect(res.body.logs.some((l) => l.target_id === txnId)).toBe(true);
  });
});

describe('GET /transactions/export — CSV export', () => {
  test('requires auth', async () => {
    const res = await request(app).get(`${API}/transactions/export`);
    expect(res.status).toBe(401);
  });

  test('returns CSV with a header row and one row per transaction, scoped to the caller', async () => {
    const token = await registerAndLogin('export_txn_user1');
    await request(app).post(`${API}/transactions`).set('Authorization', `Bearer ${token}`)
      .send({ amount: 42.50, merchant: 'Export Cafe', category: 'food', location: 'New York, US', card_type: 'credit' });

    const res = await request(app).get(`${API}/transactions/export`).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.headers['content-disposition']).toMatch(/attachment; filename="transactions-/);

    const lines = res.text.trim().split('\r\n');
    expect(lines[0]).toBe('ID,Date,User,Merchant,Category,Amount,Card Type,Location,Risk Level,Fraud Score,Scoring Method');
    expect(lines.some((l) => l.includes('Export Cafe'))).toBe(true);
  });

  test('respects the same filters as the list endpoint', async () => {
    const token = await registerAndLogin('export_txn_user2');
    await request(app).post(`${API}/transactions`).set('Authorization', `Bearer ${token}`)
      .send({ amount: 10, merchant: 'Filtered Out', category: 'grocery', location: 'New York, US', card_type: 'credit' });
    await request(app).post(`${API}/transactions`).set('Authorization', `Bearer ${token}`)
      .send({ amount: 10, merchant: 'Filtered In', category: 'electronics', location: 'New York, US', card_type: 'credit' });

    const res = await request(app).get(`${API}/transactions/export`).set('Authorization', `Bearer ${token}`).query({ category: 'electronics' });
    expect(res.text).toContain('Filtered In');
    expect(res.text).not.toContain('Filtered Out');
  });

  test('a regular user cannot see another user\'s transactions in their export', async () => {
    const tokenA = await registerAndLogin('export_txn_user3');
    const tokenB = await registerAndLogin('export_txn_user4');
    await request(app).post(`${API}/transactions`).set('Authorization', `Bearer ${tokenA}`)
      .send({ amount: 10, merchant: 'User A Only', category: 'grocery', location: 'New York, US', card_type: 'credit' });

    const res = await request(app).get(`${API}/transactions/export`).set('Authorization', `Bearer ${tokenB}`);
    expect(res.text).not.toContain('User A Only');
  });

  test('a value containing a comma is safely quoted in the CSV', async () => {
    const token = await registerAndLogin('export_txn_comma_user');
    await request(app).post(`${API}/transactions`).set('Authorization', `Bearer ${token}`)
      .send({ amount: 10, merchant: 'Smith, Jones & Co', category: 'grocery', location: 'New York, US', card_type: 'credit' });

    const res = await request(app).get(`${API}/transactions/export`).set('Authorization', `Bearer ${token}`);
    expect(res.text).toContain('"Smith, Jones & Co"');
  });
});

describe('API versioning', () => {
  test('the unversioned /api alias serves the same routes as /api/v1', async () => {
    const versioned = await request(app).get('/api/v1/health');
    const unversioned = await request(app).get('/api/health');
    expect(versioned.status).toBe(200);
    expect(unversioned.status).toBe(200);
    expect(unversioned.body.api_version).toBe('v1');
  });
});
