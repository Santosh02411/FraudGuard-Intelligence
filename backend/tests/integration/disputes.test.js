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

async function createTransactionFor(token, overrides = {}) {
  const res = await request(app).post(`${API}/transactions`)
    .set('Authorization', `Bearer ${token}`)
    .send({ amount: 80, merchant: 'Corner Cafe', category: 'food', location: 'New York, US', card_type: 'credit', ...overrides });
  return res.body.transaction.id;
}

describe('Disputes — open, view, ownership', () => {
  let ownerToken;
  let otherUserToken;
  let adminToken;
  let txnId;

  beforeAll(async () => {
    ownerToken = await registerAndLogin('dispute_owner');
    otherUserToken = await registerAndLogin('dispute_stranger');
    adminToken = await loginAdmin();
    txnId = await createTransactionFor(ownerToken);
  });

  test('requires authentication', async () => {
    const res = await request(app).post(`${API}/disputes`).send({ transaction_id: txnId });
    expect(res.status).toBe(401);
  });

  test('opening a dispute without a transaction_id is rejected by validation', async () => {
    const res = await request(app).post(`${API}/disputes`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ reason: 'I did not make this purchase.' });
    expect(res.status).toBe(400);
  });

  test('a different user cannot open a dispute on someone else\'s transaction', async () => {
    const res = await request(app).post(`${API}/disputes`)
      .set('Authorization', `Bearer ${otherUserToken}`)
      .send({ transaction_id: txnId, reason: 'Not mine.' });
    expect(res.status).toBe(403);
  });

  test('opening a dispute on a non-existent transaction returns 404', async () => {
    const res = await request(app).post(`${API}/disputes`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ transaction_id: 99999999, reason: 'Ghost transaction.' });
    expect(res.status).toBe(404);
  });

  let disputeId;

  test('the owner can open a dispute on their own transaction, defaulting the amount to the full transaction amount', async () => {
    const res = await request(app).post(`${API}/disputes`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ transaction_id: txnId, reason: 'I did not make this purchase.' });

    expect(res.status).toBe(201);
    expect(res.body.dispute.status).toBe('opened');
    expect(res.body.dispute.transaction_id).toBe(txnId);
    expect(Number(res.body.dispute.amount_disputed)).toBe(80);
    disputeId = res.body.dispute.id;
  });

  test('a transaction can only have one open dispute at a time', async () => {
    const res = await request(app).post(`${API}/disputes`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ transaction_id: txnId, reason: 'Trying again.' });
    expect(res.status).toBe(409);
  });

  test('the owner can view their own dispute', async () => {
    const res = await request(app).get(`${API}/disputes/${disputeId}`).set('Authorization', `Bearer ${ownerToken}`);
    expect(res.status).toBe(200);
    expect(res.body.dispute.id).toBe(disputeId);
  });

  test('a different user cannot view someone else\'s dispute', async () => {
    const res = await request(app).get(`${API}/disputes/${disputeId}`).set('Authorization', `Bearer ${otherUserToken}`);
    expect(res.status).toBe(403);
  });

  test('an admin can view any dispute', async () => {
    const res = await request(app).get(`${API}/disputes/${disputeId}`).set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
  });

  test('viewing a non-existent dispute returns 404', async () => {
    const res = await request(app).get(`${API}/disputes/99999999`).set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(404);
  });

  test('a non-admin can list their own disputes, an admin sees every case', async () => {
    const ownRes = await request(app).get(`${API}/disputes`).set('Authorization', `Bearer ${ownerToken}`);
    expect(ownRes.status).toBe(200);
    expect(ownRes.body.disputes.some(d => d.id === disputeId)).toBe(true);

    const strangerRes = await request(app).get(`${API}/disputes`).set('Authorization', `Bearer ${otherUserToken}`);
    expect(strangerRes.status).toBe(200);
    expect(strangerRes.body.disputes.some(d => d.id === disputeId)).toBe(false);

    const adminRes = await request(app).get(`${API}/disputes`).set('Authorization', `Bearer ${adminToken}`);
    expect(adminRes.status).toBe(200);
    expect(adminRes.body.disputes.some(d => d.id === disputeId)).toBe(true);
  });

  test('a partial dispute amount can override the transaction total', async () => {
    const partialTxnId = await createTransactionFor(ownerToken, { amount: 200 });
    const res = await request(app).post(`${API}/disputes`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ transaction_id: partialTxnId, amount_disputed: 50, reason: 'Only part of this order arrived.' });

    expect(res.status).toBe(201);
    expect(Number(res.body.dispute.amount_disputed)).toBe(50);
  });
});

describe('Disputes — lifecycle transitions (admin-only)', () => {
  let ownerToken;
  let adminToken;
  let disputeId;

  beforeAll(async () => {
    ownerToken = await registerAndLogin('dispute_lifecycle_owner');
    adminToken = await loginAdmin();
    const txnId = await createTransactionFor(ownerToken);
    const openRes = await request(app).post(`${API}/disputes`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ transaction_id: txnId, reason: 'Unrecognized charge.' });
    disputeId = openRes.body.dispute.id;
  });

  test('the account owner cannot advance a dispute\'s status', async () => {
    const res = await request(app).patch(`${API}/disputes/${disputeId}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ status: 'won' });
    expect(res.status).toBe(403);
  });

  test('an invalid status value is rejected', async () => {
    const res = await request(app).patch(`${API}/disputes/${disputeId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ status: 'opened' }); // not a valid transition target
    expect(res.status).toBe(400);
  });

  test('an admin can move opened -> evidence_submitted with a note', async () => {
    const res = await request(app).patch(`${API}/disputes/${disputeId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ status: 'evidence_submitted', note: 'Submitted AVS match + signed delivery receipt.' });

    expect(res.status).toBe(200);
    expect(res.body.dispute.status).toBe('evidence_submitted');
    expect(res.body.dispute.evidence_note).toBe('Submitted AVS match + signed delivery receipt.');
    expect(res.body.dispute.evidence_submitted_at).toBeTruthy();
  });

  test('evidence_submitted cannot be re-entered once already in that state — only won/lost are valid next steps', async () => {
    const res = await request(app).patch(`${API}/disputes/${disputeId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ status: 'evidence_submitted' });
    expect(res.status).toBe(400);
  });

  test('an admin can resolve the case as won, stamping the resolution note and timestamp', async () => {
    const res = await request(app).patch(`${API}/disputes/${disputeId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ status: 'won', note: 'Chargeback reversed in our favor.' });

    expect(res.status).toBe(200);
    expect(res.body.dispute.status).toBe('won');
    expect(res.body.dispute.resolution_note).toBe('Chargeback reversed in our favor.');
    expect(res.body.dispute.resolved_at).toBeTruthy();
  });

  test('a resolved dispute (won/lost) cannot be transitioned any further', async () => {
    const res = await request(app).patch(`${API}/disputes/${disputeId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ status: 'lost' });
    expect(res.status).toBe(400);
  });

  test('opened can also resolve straight to lost, skipping evidence_submitted', async () => {
    const txnId = await createTransactionFor(ownerToken);
    const openRes = await request(app).post(`${API}/disputes`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ transaction_id: txnId, reason: 'Merchant billed twice.' });

    const res = await request(app).patch(`${API}/disputes/${openRes.body.dispute.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ status: 'lost', note: 'No response within the contest window.' });

    expect(res.status).toBe(200);
    expect(res.body.dispute.status).toBe('lost');
  });

  test('transitioning a non-existent dispute returns 404', async () => {
    const res = await request(app).patch(`${API}/disputes/99999999`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ status: 'won' });
    expect(res.status).toBe(404);
  });
});

describe('Disputes — financial summary (admin-only)', () => {
  let adminToken;

  beforeAll(async () => {
    adminToken = await loginAdmin();
  });

  test('a non-admin cannot view the financial summary', async () => {
    const userToken = await registerAndLogin('dispute_summary_user');
    const res = await request(app).get(`${API}/disputes/financial-summary`).set('Authorization', `Bearer ${userToken}`);
    expect(res.status).toBe(403);
  });

  test('an admin sees a rollup that accounts for won/lost/pending amounts and a win rate over resolved cases', async () => {
    const ownerToken = await registerAndLogin('dispute_summary_owner');

    const wonTxn = await createTransactionFor(ownerToken, { amount: 100 });
    const wonOpen = await request(app).post(`${API}/disputes`).set('Authorization', `Bearer ${ownerToken}`).send({ transaction_id: wonTxn, reason: 'x' });
    await request(app).patch(`${API}/disputes/${wonOpen.body.dispute.id}`).set('Authorization', `Bearer ${adminToken}`).send({ status: 'won' });

    const lostTxn = await createTransactionFor(ownerToken, { amount: 40 });
    const lostOpen = await request(app).post(`${API}/disputes`).set('Authorization', `Bearer ${ownerToken}`).send({ transaction_id: lostTxn, reason: 'x' });
    await request(app).patch(`${API}/disputes/${lostOpen.body.dispute.id}`).set('Authorization', `Bearer ${adminToken}`).send({ status: 'lost' });

    const pendingTxn = await createTransactionFor(ownerToken, { amount: 30 });
    await request(app).post(`${API}/disputes`).set('Authorization', `Bearer ${ownerToken}`).send({ transaction_id: pendingTxn, reason: 'x' });

    const res = await request(app).get(`${API}/disputes/financial-summary`).set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.total_disputes).toBeGreaterThanOrEqual(3);
    expect(res.body.amount_won).toBeGreaterThanOrEqual(100);
    expect(res.body.amount_lost).toBeGreaterThanOrEqual(40);
    expect(res.body.amount_pending).toBeGreaterThanOrEqual(30);
    expect(res.body.win_rate).not.toBeNull();
  });
});

describe('Disputes — CSV export', () => {
  let ownerToken;
  let strangerToken;
  let adminToken;
  let disputeId;

  beforeAll(async () => {
    ownerToken = await registerAndLogin('dispute_export_owner');
    strangerToken = await registerAndLogin('dispute_export_stranger');
    adminToken = await loginAdmin();

    const txnId = await createTransactionFor(ownerToken, { merchant: 'Export Test Co', amount: 120 });
    const openRes = await request(app).post(`${API}/disputes`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ transaction_id: txnId, reason: 'Never received the item.' });
    disputeId = openRes.body.dispute.id;
  });

  test('requires authentication', async () => {
    const res = await request(app).get(`${API}/disputes/export`);
    expect(res.status).toBe(401);
  });

  test('the owner gets a CSV including their own case', async () => {
    const res = await request(app).get(`${API}/disputes/export`).set('Authorization', `Bearer ${ownerToken}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.headers['content-disposition']).toMatch(/disputes-.*\.csv/);
    expect(res.text).toContain('Export Test Co');
    expect(res.text).toContain('Never received the item.');
    expect(res.text.split('\r\n')[0]).toBe('ID,Opened,Account,Merchant,Amount Disputed,Transaction Amount,Status,Reason,Evidence Note,Resolution Note,Opened By,Resolved');
  });

  test('a different account does not see someone else\'s case in their export', async () => {
    const res = await request(app).get(`${API}/disputes/export`).set('Authorization', `Bearer ${strangerToken}`);
    expect(res.status).toBe(200);
    expect(res.text).not.toContain('Export Test Co');
  });

  test('an admin export includes every account\'s cases', async () => {
    const res = await request(app).get(`${API}/disputes/export`).set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.text).toContain('Export Test Co');
    expect(res.text).toContain('dispute_export_owner');
  });

  test('?status= filters the export the same way as the list endpoint', async () => {
    const res = await request(app).get(`${API}/disputes/export`).query({ status: 'won' }).set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.text).not.toContain('Export Test Co'); // that one's still "opened"
  });

  test('resolving the case does not remove it from the owner\'s export', async () => {
    await request(app).patch(`${API}/disputes/${disputeId}`).set('Authorization', `Bearer ${adminToken}`).send({ status: 'won', note: 'Refunded by merchant.' });

    const res = await request(app).get(`${API}/disputes/export`).set('Authorization', `Bearer ${ownerToken}`);
    expect(res.text).toContain('Export Test Co');
    expect(res.text).toContain('Refunded by merchant.');
    expect(res.text).toContain('won');
  });
});
