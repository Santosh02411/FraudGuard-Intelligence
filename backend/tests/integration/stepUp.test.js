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

// A medium-risk transaction under the rule-engine fallback (ml_service
// is unreachable in tests — see tests/setup/testEnv.js): amount over the
// $1,500 "medium" threshold (+20) plus a high-risk category (+25) = 45,
// squarely in the 40-69 medium band, without tripping a hard rule
// ("Bet365" doesn't match the HIGH_RISK_MERCHANTS substrings that would
// push it to high) and without needing account history.
const MEDIUM_RISK_TXN = { amount: 2000, merchant: 'Bet365', category: 'gambling', location: 'New York, US', card_type: 'credit' };

// Every request in this file otherwise shares supertest's default
// User-Agent AND the same loopback IP, which fingerprintDevice()/the IP
// itself would tie together as the SAME device+IP for every account
// created here — accumulating a growing shared-identifier cluster
// across tests that pushes network risk (and the score) up past
// "medium" the more accounts this file creates. A distinct per-user
// User-Agent and X-Forwarded-For keeps each account's identifiers
// independent, same as the real world.
function createTxn(token, id) {
  return request(app).post(`${API}/transactions`).set('Authorization', `Bearer ${token}`)
    .set('User-Agent', `ua-${id}`).set('X-Forwarded-For', `203.0.113.${id}`).send(MEDIUM_RISK_TXN);
}

describe('Step-up authentication hook', () => {
  test('a medium-risk transaction completes immediately when the account has no step_up_required webhook', async () => {
    const token = await registerAndLogin('stepup_no_webhook');
    const res = await createTxn(token, 1);

    expect(res.status).toBe(201);
    expect(res.body.analysis.risk_level).toBe('medium');
    expect(res.body.step_up).toBeNull();
    expect(res.body.transaction.status).toBe('completed');
  });

  test('subscribing to transaction.step_up_required holds a medium-risk transaction for verification', async () => {
    const token = await registerAndLogin('stepup_subscriber');
    await request(app).post(`${API}/webhooks`).set('Authorization', `Bearer ${token}`)
      .send({ url: 'https://example.com/hook', events: ['transaction.step_up_required'] });

    const res = await createTxn(token, 2);
    expect(res.status).toBe(201);
    expect(res.body.analysis.risk_level).toBe('medium');
    expect(res.body.transaction.status).toBe('pending_step_up');
    expect(res.body.step_up).toEqual(expect.objectContaining({
      required: true,
      transaction_id: res.body.transaction.id,
      method: 'otp',
      verify_url: `/api/transactions/${res.body.transaction.id}/step-up/verify`,
    }));
    expect(res.body.step_up.challenge_token).toBeTruthy();
  });

  test('the "*" wildcard also opts an account into the hold', async () => {
    const token = await registerAndLogin('stepup_wildcard');
    await request(app).post(`${API}/webhooks`).set('Authorization', `Bearer ${token}`)
      .send({ url: 'https://example.com/hook', events: ['*'] });

    const res = await createTxn(token, 3);
    expect(res.body.analysis.risk_level).toBe('medium');
    expect(res.body.step_up.required).toBe(true);
  });

  describe('resolving a held transaction', () => {
    let token;
    let txnId;
    let challengeToken;
    let resolveCounter = 0;

    beforeEach(async () => {
      resolveCounter += 1;
      token = await registerAndLogin(`stepup_res_${resolveCounter}`);
      await request(app).post(`${API}/webhooks`).set('Authorization', `Bearer ${token}`)
        .send({ url: 'https://example.com/hook', events: ['transaction.step_up_required'] });
      const created = await createTxn(token, 10 + resolveCounter);
      txnId = created.body.transaction.id;
      challengeToken = created.body.step_up.challenge_token;
    });

    test('GET .../step-up reports the pending challenge, including the challenge_token so an abandoned flow can still be resolved', async () => {
      const res = await request(app).get(`${API}/transactions/${txnId}/step-up`).set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(res.body.transaction_status).toBe('pending_step_up');
      expect(res.body.challenge.status).toBe('pending');
      expect(res.body.challenge.method).toBe('otp');
      expect(res.body.challenge.challenge_token).toBe(challengeToken);
    });

    test('polling and then verifying with the recovered token works, simulating a flow resumed after navigating away', async () => {
      const polled = await request(app).get(`${API}/transactions/${txnId}/step-up`).set('Authorization', `Bearer ${token}`);
      const recoveredToken = polled.body.challenge.challenge_token;

      const res = await request(app).post(`${API}/transactions/${txnId}/step-up/verify`)
        .set('Authorization', `Bearer ${token}`).send({ challenge_token: recoveredToken, outcome: 'success' });
      expect(res.status).toBe(200);
      expect(res.body.transaction.status).toBe('completed');
    });

    test('a resolved challenge no longer exposes its token on poll', async () => {
      await request(app).post(`${API}/transactions/${txnId}/step-up/verify`)
        .set('Authorization', `Bearer ${token}`).send({ challenge_token: challengeToken, outcome: 'success' });

      const res = await request(app).get(`${API}/transactions/${txnId}/step-up`).set('Authorization', `Bearer ${token}`);
      expect(res.body.challenge.status).toBe('verified');
      expect(res.body.challenge.challenge_token).toBeUndefined();
    });

    test('a wrong challenge_token is rejected', async () => {
      const res = await request(app).post(`${API}/transactions/${txnId}/step-up/verify`)
        .set('Authorization', `Bearer ${token}`).send({ challenge_token: 'not-the-real-token', outcome: 'success' });
      expect(res.status).toBe(404);
    });

    test('an invalid outcome value is rejected', async () => {
      const res = await request(app).post(`${API}/transactions/${txnId}/step-up/verify`)
        .set('Authorization', `Bearer ${token}`).send({ challenge_token: challengeToken, outcome: 'maybe' });
      expect(res.status).toBe(400);
    });

    test('outcome "success" completes the transaction', async () => {
      const res = await request(app).post(`${API}/transactions/${txnId}/step-up/verify`)
        .set('Authorization', `Bearer ${token}`).send({ challenge_token: challengeToken, outcome: 'success' });

      expect(res.status).toBe(200);
      expect(res.body.step_up_outcome).toBe('success');
      expect(res.body.transaction.status).toBe('completed');

      const polled = await request(app).get(`${API}/transactions/${txnId}/step-up`).set('Authorization', `Bearer ${token}`);
      expect(polled.body.challenge.status).toBe('verified');
      expect(polled.body.challenge.verified_at).toBeTruthy();
    });

    test('outcome "failure" blocks the transaction', async () => {
      const res = await request(app).post(`${API}/transactions/${txnId}/step-up/verify`)
        .set('Authorization', `Bearer ${token}`).send({ challenge_token: challengeToken, outcome: 'failure' });

      expect(res.status).toBe(200);
      expect(res.body.step_up_outcome).toBe('failure');
      expect(res.body.transaction.status).toBe('blocked');
    });

    test('a resolved challenge cannot be verified a second time', async () => {
      await request(app).post(`${API}/transactions/${txnId}/step-up/verify`)
        .set('Authorization', `Bearer ${token}`).send({ challenge_token: challengeToken, outcome: 'success' });

      const res = await request(app).post(`${API}/transactions/${txnId}/step-up/verify`)
        .set('Authorization', `Bearer ${token}`).send({ challenge_token: challengeToken, outcome: 'success' });
      expect(res.status).toBe(409);
    });

    test('a different account cannot verify or poll someone else\'s challenge', async () => {
      const otherToken = await registerAndLogin('stepup_stranger');
      const verifyRes = await request(app).post(`${API}/transactions/${txnId}/step-up/verify`)
        .set('Authorization', `Bearer ${otherToken}`).send({ challenge_token: challengeToken, outcome: 'success' });
      expect(verifyRes.status).toBe(403);

      const pollRes = await request(app).get(`${API}/transactions/${txnId}/step-up`).set('Authorization', `Bearer ${otherToken}`);
      expect(pollRes.status).toBe(403);
    });
  });

  test('polling a transaction that never had a step-up challenge returns 404', async () => {
    const token = await registerAndLogin('stepup_never_held');
    const created = await request(app).post(`${API}/transactions`).set('Authorization', `Bearer ${token}`)
      .set('User-Agent', 'ua-99').set('X-Forwarded-For', '203.0.113.99')
      .send({ amount: 12, merchant: 'Starbucks', category: 'food', location: 'New York, US', card_type: 'credit' });

    const res = await request(app).get(`${API}/transactions/${created.body.transaction.id}/step-up`).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(404);
  });
});
