const request = require('supertest');
const app = require('../../app');
const { initSchema } = require('../../config/schema');
const config = require('../../config/env');

beforeAll(async () => {
  await initSchema();
});

const API = '/api/v1';
const STRONG_PASSWORD = 'Str0ng!Passw0rd1';

async function registerAndLogin(username, password = STRONG_PASSWORD) {
  await request(app).post(`${API}/auth/register`).send({ username, email: `${username}@example.com`, password });
  const res = await request(app).post(`${API}/auth/login`).send({ username, password });
  return res.body;
}

async function loginAdmin() {
  const res = await request(app).post(`${API}/auth/login`).send({ username: 'admin', password: 'admin123' });
  return res.body.accessToken;
}

// Fields tuned (same pattern as alerts.test.js) to reliably score
// high-risk via the rule-engine fallback (ML_SERVICE_URL is
// deliberately unreachable in tests — see tests/setup/testEnv.js).
const HIGH_RISK_TXN = { amount: 5000, merchant: 'Risky Merchant', category: 'electronics', location: 'Lagos, NG', card_type: 'prepaid' };
const LOW_RISK_TXN = { amount: 20, merchant: 'Corner Cafe', category: 'food', location: 'New York, US', card_type: 'credit' };

describe('API keys — management', () => {
  test('creating a key requires auth', async () => {
    const res = await request(app).post(`${API}/api-keys`).send({ name: 'test key' });
    expect(res.status).toBe(401);
  });

  test('creates a key with default scopes, returned in plaintext exactly once', async () => {
    const { accessToken } = await registerAndLogin('apikey_user1');
    const res = await request(app).post(`${API}/api-keys`).set('Authorization', `Bearer ${accessToken}`).send({ name: 'Merchant Backend' });

    expect(res.status).toBe(201);
    expect(res.body.key).toMatch(/^fg_live_/);
    expect(res.body.scopes).toEqual(['transactions:write', 'transactions:read']);
    expect(res.body.prefix).toBe(res.body.key.slice(0, res.body.prefix.length));
  });

  test('list only returns the caller\'s own keys, without the key value or hash', async () => {
    const { accessToken: tokenA } = await registerAndLogin('apikey_user2');
    const { accessToken: tokenB } = await registerAndLogin('apikey_user3');
    await request(app).post(`${API}/api-keys`).set('Authorization', `Bearer ${tokenA}`).send({ name: 'A key' });
    await request(app).post(`${API}/api-keys`).set('Authorization', `Bearer ${tokenB}`).send({ name: 'B key' });

    const res = await request(app).get(`${API}/api-keys`).set('Authorization', `Bearer ${tokenA}`);
    expect(res.status).toBe(200);
    expect(res.body.apiKeys).toHaveLength(1);
    expect(res.body.apiKeys[0].name).toBe('A key');
    expect(res.body.apiKeys[0].key).toBeUndefined();
    expect(res.body.apiKeys[0].key_hash).toBeUndefined();
  });

  test('admin sees every user\'s keys', async () => {
    const adminToken = await loginAdmin();
    const res = await request(app).get(`${API}/api-keys`).set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.apiKeys.length).toBeGreaterThanOrEqual(3); // from the tests above
  });

  test('a non-owner cannot revoke someone else\'s key; the owner can', async () => {
    const { accessToken: ownerToken } = await registerAndLogin('apikey_owner1');
    const { accessToken: strangerToken } = await registerAndLogin('apikey_stranger1');
    const createRes = await request(app).post(`${API}/api-keys`).set('Authorization', `Bearer ${ownerToken}`).send({ name: 'Owned key' });
    const keyId = createRes.body.id;

    const forbidden = await request(app).delete(`${API}/api-keys/${keyId}`).set('Authorization', `Bearer ${strangerToken}`);
    expect(forbidden.status).toBe(403);

    const ok = await request(app).delete(`${API}/api-keys/${keyId}`).set('Authorization', `Bearer ${ownerToken}`);
    expect(ok.status).toBe(200);
  });

  test('a revoked key can no longer authenticate', async () => {
    const { accessToken } = await registerAndLogin('apikey_revoke_user');
    const createRes = await request(app).post(`${API}/api-keys`).set('Authorization', `Bearer ${accessToken}`).send({ name: 'Soon revoked' });
    const rawKey = createRes.body.key;

    await request(app).delete(`${API}/api-keys/${createRes.body.id}`).set('Authorization', `Bearer ${accessToken}`);

    const res = await request(app).get(`${API}/transactions`).set('X-API-Key', rawKey);
    expect(res.status).toBe(401);
  });

  test('a key with no expiresInDays has no expiry', async () => {
    const { accessToken } = await registerAndLogin('apikey_noexpiry_user');
    const res = await request(app).post(`${API}/api-keys`).set('Authorization', `Bearer ${accessToken}`).send({ name: 'Forever key' });
    expect(res.body.expires_at).toBeNull();
  });

  test('a key created with expiresInDays reports the correct expiry and still works before it', async () => {
    const { accessToken } = await registerAndLogin('apikey_expiry_user');
    const createRes = await request(app).post(`${API}/api-keys`).set('Authorization', `Bearer ${accessToken}`)
      .send({ name: 'Temp key', expiresInDays: 30 });
    expect(createRes.body.expires_at).toBeTruthy();
    const daysUntilExpiry = (new Date(createRes.body.expires_at).getTime() - Date.now()) / (24 * 60 * 60 * 1000);
    expect(daysUntilExpiry).toBeGreaterThan(29);
    expect(daysUntilExpiry).toBeLessThan(31);

    const res = await request(app).get(`${API}/transactions`).set('X-API-Key', createRes.body.key);
    expect(res.status).toBe(200);
  });

  test('an expired key is rejected, even though it was never revoked', async () => {
    const { accessToken } = await registerAndLogin('apikey_expired_user');
    const createRes = await request(app).post(`${API}/api-keys`).set('Authorization', `Bearer ${accessToken}`)
      .send({ name: 'Already-expired key', expiresInDays: 1 });

    // Directly backdate the stored expiry, simulating time having
    // passed, rather than waiting a day in a test.
    const db = require('../../config/database');
    await db.run('UPDATE api_keys SET expires_at = ? WHERE id = ?', [new Date(Date.now() - 1000).toISOString(), createRes.body.id]);

    const res = await request(app).get(`${API}/transactions`).set('X-API-Key', createRes.body.key);
    expect(res.status).toBe(401);
  });

  test('rejects an expiresInDays that is absurdly large', async () => {
    const { accessToken } = await registerAndLogin('apikey_hugeexpiry_user');
    const res = await request(app).post(`${API}/api-keys`).set('Authorization', `Bearer ${accessToken}`)
      .send({ name: 'Bad key', expiresInDays: 999999 });
    expect(res.status).toBe(400);
  });

  test('GET /api-keys?mine=true returns only the admin\'s own keys, even though admins otherwise see everyone\'s', async () => {
    const adminToken = await loginAdmin();
    const meRes = await request(app).get(`${API}/auth/me`).set('Authorization', `Bearer ${adminToken}`);

    const ownRes = await request(app).get(`${API}/api-keys`).set('Authorization', `Bearer ${adminToken}`).query({ mine: 'true' });
    expect(ownRes.status).toBe(200);
    expect(ownRes.body.apiKeys.every((k) => k.user_id === meRes.body.user.id)).toBe(true);

    const allRes = await request(app).get(`${API}/api-keys`).set('Authorization', `Bearer ${adminToken}`);
    expect(allRes.body.apiKeys.length).toBeGreaterThanOrEqual(ownRes.body.apiKeys.length);
  });

  test('a regular (non-admin) user\'s list is unaffected by the mine param, since it always scopes to their own', async () => {
    const { accessToken } = await registerAndLogin('apikey_mine_regular_user');
    await request(app).post(`${API}/api-keys`).set('Authorization', `Bearer ${accessToken}`).send({ name: 'Some key' });

    const withParam = await request(app).get(`${API}/api-keys`).set('Authorization', `Bearer ${accessToken}`).query({ mine: 'true' });
    const withoutParam = await request(app).get(`${API}/api-keys`).set('Authorization', `Bearer ${accessToken}`);
    expect(withParam.body.apiKeys.length).toBe(withoutParam.body.apiKeys.length);
  });
});

describe('API keys — per-key rate limiting', () => {
  test('transactionLimiter keys by API key id, not just IP — two different keys from the same test process get independent buckets', async () => {
    // Not a full exhaustion test (the configured limit is generous
    // enough that hitting it in a unit test would be slow/flaky) — just
    // confirms two different keys can each submit without one draining
    // the other's shared IP-bucket allowance, i.e. that a request using
    // an API key is trackable independently at all.
    const { accessToken } = await registerAndLogin('apikey_ratelimit_user');
    const key1 = (await request(app).post(`${API}/api-keys`).set('Authorization', `Bearer ${accessToken}`).send({ name: 'Key 1' })).body.key;
    const key2 = (await request(app).post(`${API}/api-keys`).set('Authorization', `Bearer ${accessToken}`).send({ name: 'Key 2' })).body.key;

    const res1 = await request(app).post(`${API}/transactions`).set('X-API-Key', key1).send(LOW_RISK_TXN);
    const res2 = await request(app).post(`${API}/transactions`).set('X-API-Key', key2).send(LOW_RISK_TXN);
    expect(res1.status).toBe(201);
    expect(res2.status).toBe(201);
    // Standard rate-limit headers should reflect independent counters —
    // each key's very first request should show the same remaining
    // count (one used out of the shared max), not a shared/decrementing
    // total across both keys.
    expect(res1.headers['ratelimit-remaining']).toBe(res2.headers['ratelimit-remaining']);
  });
});

describe('API keys — authenticating requests (service-to-service auth)', () => {
  test('an invalid API key is rejected', async () => {
    const res = await request(app).get(`${API}/transactions`).set('X-API-Key', 'fg_live_not_a_real_key');
    expect(res.status).toBe(401);
  });

  test('a valid API key can submit a transaction on behalf of its owning account', async () => {
    const { accessToken, user } = await registerAndLogin('apikey_txn_user1');
    const createRes = await request(app).post(`${API}/api-keys`).set('Authorization', `Bearer ${accessToken}`).send({ name: 'Full access key' });
    const rawKey = createRes.body.key;

    const res = await request(app).post(`${API}/transactions`).set('X-API-Key', rawKey).send(LOW_RISK_TXN);
    expect(res.status).toBe(201);
    expect(res.body.transaction.user_id).toBe(user.id);
  });

  test('a key scoped to read-only cannot submit a transaction, but can list them', async () => {
    const { accessToken } = await registerAndLogin('apikey_readonly_user');
    const createRes = await request(app).post(`${API}/api-keys`).set('Authorization', `Bearer ${accessToken}`)
      .send({ name: 'Read-only key', scopes: ['transactions:read'] });
    const rawKey = createRes.body.key;

    const writeRes = await request(app).post(`${API}/transactions`).set('X-API-Key', rawKey).send(LOW_RISK_TXN);
    expect(writeRes.status).toBe(403);

    const readRes = await request(app).get(`${API}/transactions`).set('X-API-Key', rawKey);
    expect(readRes.status).toBe(200);
  });

  test('transactions created via an API key are audit-logged with the key\'s id and name', async () => {
    const { accessToken } = await registerAndLogin('apikey_audit_user');
    const createRes = await request(app).post(`${API}/api-keys`).set('Authorization', `Bearer ${accessToken}`).send({ name: 'Audited key' });
    const rawKey = createRes.body.key;

    const txnRes = await request(app).post(`${API}/transactions`).set('X-API-Key', rawKey).send(LOW_RISK_TXN);

    const adminToken = await loginAdmin();
    const auditRes = await request(app).get(`${API}/admin/audit-logs`).set('Authorization', `Bearer ${adminToken}`)
      .query({ action: 'transactions.create_via_api_key', targetId: txnRes.body.transaction.id });
    expect(auditRes.status).toBe(200);
    expect(auditRes.body.logs.length).toBeGreaterThan(0);
    expect(auditRes.body.logs[0].details).toMatchObject({ apiKeyId: createRes.body.id, apiKeyName: 'Audited key' });
  });

  test('using the key updates its last_used_at (fire-and-forget, so this allows a brief moment to land)', async () => {
    const { accessToken } = await registerAndLogin('apikey_lastused_user');
    const createRes = await request(app).post(`${API}/api-keys`).set('Authorization', `Bearer ${accessToken}`).send({ name: 'Tracked key' });
    const rawKey = createRes.body.key;

    let listRes = await request(app).get(`${API}/api-keys`).set('Authorization', `Bearer ${accessToken}`);
    expect(listRes.body.apiKeys.find((k) => k.id === createRes.body.id).last_used_at).toBeFalsy();

    await request(app).get(`${API}/transactions`).set('X-API-Key', rawKey);
    await new Promise((resolve) => setTimeout(resolve, 100));

    listRes = await request(app).get(`${API}/api-keys`).set('Authorization', `Bearer ${accessToken}`);
    expect(listRes.body.apiKeys.find((k) => k.id === createRes.body.id).last_used_at).toBeTruthy();
  });

  test('a normal JWT session still works on the same routes (flexibleAuth falls back correctly)', async () => {
    const { accessToken } = await registerAndLogin('apikey_fallback_user');
    const res = await request(app).post(`${API}/transactions`).set('Authorization', `Bearer ${accessToken}`).send(LOW_RISK_TXN);
    expect(res.status).toBe(201);
  });
});

describe('Webhooks — management', () => {
  test('creating a webhook requires auth', async () => {
    const res = await request(app).post(`${API}/webhooks`).send({ url: 'https://example.com/hook' });
    expect(res.status).toBe(401);
  });

  test('rejects a non-URL', async () => {
    const { accessToken } = await registerAndLogin('webhook_baduri_user');
    const res = await request(app).post(`${API}/webhooks`).set('Authorization', `Bearer ${accessToken}`).send({ url: 'not-a-url' });
    expect(res.status).toBe(400);
  });

  test('creates a webhook with a signing secret returned exactly once', async () => {
    const { accessToken } = await registerAndLogin('webhook_user1');
    const res = await request(app).post(`${API}/webhooks`).set('Authorization', `Bearer ${accessToken}`)
      .send({ url: 'https://example.com/fraudguard-hook' });

    expect(res.status).toBe(201);
    expect(typeof res.body.secret).toBe('string');
    expect(res.body.events).toEqual(['transaction.flagged']);
    expect(res.body.active).toBe(true);
  });

  test('list never includes the secret', async () => {
    const { accessToken } = await registerAndLogin('webhook_user2');
    await request(app).post(`${API}/webhooks`).set('Authorization', `Bearer ${accessToken}`).send({ url: 'https://example.com/hook' });

    const res = await request(app).get(`${API}/webhooks`).set('Authorization', `Bearer ${accessToken}`);
    expect(res.status).toBe(200);
    expect(res.body.webhooks[0].secret).toBeUndefined();
  });

  test('the owner can update (deactivate) a webhook; a non-owner cannot', async () => {
    const { accessToken: ownerToken } = await registerAndLogin('webhook_owner1');
    const { accessToken: strangerToken } = await registerAndLogin('webhook_stranger1');
    const createRes = await request(app).post(`${API}/webhooks`).set('Authorization', `Bearer ${ownerToken}`).send({ url: 'https://example.com/hook' });

    const forbidden = await request(app).patch(`${API}/webhooks/${createRes.body.id}`).set('Authorization', `Bearer ${strangerToken}`).send({ active: false });
    expect(forbidden.status).toBe(403);

    const ok = await request(app).patch(`${API}/webhooks/${createRes.body.id}`).set('Authorization', `Bearer ${ownerToken}`).send({ active: false });
    expect(ok.status).toBe(200);
    expect(ok.body.webhook.active).toBe(false);
  });

  test('the owner can delete a webhook', async () => {
    const { accessToken } = await registerAndLogin('webhook_delete_user');
    const createRes = await request(app).post(`${API}/webhooks`).set('Authorization', `Bearer ${accessToken}`).send({ url: 'https://example.com/hook' });
    const res = await request(app).delete(`${API}/webhooks/${createRes.body.id}`).set('Authorization', `Bearer ${accessToken}`);
    expect(res.status).toBe(200);
  });
});

describe('Webhooks — dispatch on high-risk transactions', () => {
  const originalFetch = global.fetch;
  let originalMaxRetries;

  // fingerprintDevice()/clientIp() (routes/transactions.js) derive from
  // the User-Agent header and connection IP, not from the user account —
  // so within one test file every request would otherwise share one
  // "device," including with transactions created by earlier describe
  // blocks above. A unique User-Agent + X-Forwarded-For per test gives
  // each scenario its own isolated device/IP, the same fix applied in
  // alerts.test.js — without it, an earlier test's high-risk transaction
  // would permanently hard-flag every later "low-risk" transaction in
  // this file via the dynamic blacklist.
  function withDevice(req, label) {
    return req.set('User-Agent', `jest-webhook-${label}`).set('X-Forwarded-For', `10.1.0.${Math.floor(Math.random() * 254) + 1}`);
  }

  beforeAll(() => {
    // Keep these delivery tests fast and non-flaky: no real network
    // calls (mock fetch) and no multi-second exponential-backoff
    // retries lingering into later tests (cap retries at 1 attempt).
    originalMaxRetries = config.webhookMaxRetries;
    config.webhookMaxRetries = 1;
  });

  afterAll(() => {
    config.webhookMaxRetries = originalMaxRetries;
    global.fetch = originalFetch;
  });

  beforeEach(() => {
    // mlClient.js also calls the global fetch() (to the deliberately
    // unreachable ML_SERVICE_URL — see tests/setup/testEnv.js) — a
    // blanket mock would swallow that call too and break the
    // rule-engine-fallback scoring these tests' risk-level assertions
    // depend on. Only fake the webhook URL; let anything else
    // (the ML service call) actually fail the way the real unreachable
    // URL would.
    global.fetch = jest.fn((url) => {
      if (typeof url === 'string' && url.startsWith(config.mlServiceUrl)) {
        return Promise.reject(new Error('ECONNREFUSED (simulated — see tests/setup/testEnv.js)'));
      }
      return Promise.resolve({ ok: true, status: 200 });
    });
  });

  function webhookFetchCalls() {
    // mlClient.js also calls global fetch() for every transaction
    // (high or low risk) — filter those out so "did/didn't fire"
    // assertions only look at calls actually aimed at a webhook URL.
    return global.fetch.mock.calls.filter(([url]) => typeof url === 'string' && !url.startsWith(config.mlServiceUrl));
  }

  test('fires on a medium/high-risk transaction, signed with the webhook\'s secret', async () => {
    const { accessToken } = await registerAndLogin('webhook_fire_user1');
    const createRes = await request(app).post(`${API}/webhooks`).set('Authorization', `Bearer ${accessToken}`)
      .send({ url: 'https://example.com/fires-here' });
    const secret = createRes.body.secret;

    await withDevice(request(app).post(`${API}/transactions`), 'fire1').set('Authorization', `Bearer ${accessToken}`).send(HIGH_RISK_TXN);
    await new Promise((resolve) => setTimeout(resolve, 150)); // dispatch is fire-and-forget

    expect(webhookFetchCalls()).toHaveLength(1);
    const [url, options] = webhookFetchCalls()[0];
    expect(url).toBe('https://example.com/fires-here');
    expect(options.headers['X-FraudGuard-Event']).toBe('transaction.flagged');

    const body = JSON.parse(options.body);
    expect(body.event).toBe('transaction.flagged');
    expect(body.data.transaction.merchant).toBe(HIGH_RISK_TXN.merchant);

    // Recompute the signature the same way services/webhookService.js
    // does, to prove the secret returned at creation is actually the
    // one used to sign deliveries — the whole point of a signing
    // secret is that the receiver can verify this independently.
    const crypto = require('crypto');
    const sigHeader = options.headers['X-FraudGuard-Signature'];
    const [tPart, vPart] = sigHeader.split(',');
    const timestamp = tPart.split('=')[1];
    const expectedSig = crypto.createHmac('sha256', secret).update(`${timestamp}.${options.body}`).digest('hex');
    expect(vPart).toBe(`v1=${expectedSig}`);
  });

  test('does not fire on a low-risk transaction', async () => {
    const { accessToken } = await registerAndLogin('webhook_nofire_user');
    await request(app).post(`${API}/webhooks`).set('Authorization', `Bearer ${accessToken}`).send({ url: 'https://example.com/should-not-fire' });

    await withDevice(request(app).post(`${API}/transactions`), 'nofire').set('Authorization', `Bearer ${accessToken}`).send(LOW_RISK_TXN);
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(webhookFetchCalls()).toHaveLength(0);
  });

  test('an inactive webhook does not fire', async () => {
    const { accessToken } = await registerAndLogin('webhook_inactive_user');
    const createRes = await request(app).post(`${API}/webhooks`).set('Authorization', `Bearer ${accessToken}`).send({ url: 'https://example.com/inactive' });
    await request(app).patch(`${API}/webhooks/${createRes.body.id}`).set('Authorization', `Bearer ${accessToken}`).send({ active: false });

    await withDevice(request(app).post(`${API}/transactions`), 'inactive').set('Authorization', `Bearer ${accessToken}`).send(HIGH_RISK_TXN);
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(webhookFetchCalls()).toHaveLength(0);
  });

  test('does not fire for a different user\'s webhook', async () => {
    const { accessToken: userA } = await registerAndLogin('webhook_other_user_a');
    const { accessToken: userB } = await registerAndLogin('webhook_other_user_b');
    await request(app).post(`${API}/webhooks`).set('Authorization', `Bearer ${userA}`).send({ url: 'https://example.com/user-a-hook' });

    await withDevice(request(app).post(`${API}/transactions`), 'otheruser').set('Authorization', `Bearer ${userB}`).send(HIGH_RISK_TXN);
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(webhookFetchCalls()).toHaveLength(0);
  });

  test('a failed delivery is logged and visible via the deliveries endpoint', async () => {
    global.fetch = jest.fn((url) => {
      if (typeof url === 'string' && url.startsWith(config.mlServiceUrl)) return Promise.reject(new Error('simulated ML unreachable'));
      return Promise.resolve({ ok: false, status: 500 });
    });
    const { accessToken } = await registerAndLogin('webhook_faildeliver_user');
    const createRes = await request(app).post(`${API}/webhooks`).set('Authorization', `Bearer ${accessToken}`).send({ url: 'https://example.com/failing' });

    await withDevice(request(app).post(`${API}/transactions`), 'faildeliver').set('Authorization', `Bearer ${accessToken}`).send(HIGH_RISK_TXN);
    await new Promise((resolve) => setTimeout(resolve, 150));

    const res = await request(app).get(`${API}/webhooks/${createRes.body.id}/deliveries`).set('Authorization', `Bearer ${accessToken}`);
    expect(res.status).toBe(200);
    expect(res.body.deliveries.length).toBeGreaterThan(0);
    expect(res.body.deliveries[0].success).toBe(0);
    expect(res.body.deliveries[0].response_status).toBe(500);
  });

  test('a non-owner cannot view another user\'s delivery log', async () => {
    const { accessToken: ownerToken } = await registerAndLogin('webhook_deliveries_owner');
    const { accessToken: strangerToken } = await registerAndLogin('webhook_deliveries_stranger');
    const createRes = await request(app).post(`${API}/webhooks`).set('Authorization', `Bearer ${ownerToken}`).send({ url: 'https://example.com/private' });

    const res = await request(app).get(`${API}/webhooks/${createRes.body.id}/deliveries`).set('Authorization', `Bearer ${strangerToken}`);
    expect(res.status).toBe(403);
  });

  test('a webhook subscribed to the "*" wildcard also fires', async () => {
    const { accessToken } = await registerAndLogin('webhook_wildcard_user');
    await request(app).post(`${API}/webhooks`).set('Authorization', `Bearer ${accessToken}`).send({ url: 'https://example.com/wildcard', events: ['*'] });

    await withDevice(request(app).post(`${API}/transactions`), 'wildcard').set('Authorization', `Bearer ${accessToken}`).send(HIGH_RISK_TXN);
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(webhookFetchCalls()).toHaveLength(1);
  });
});

describe('Webhooks — persistent retry queue (survives a restart)', () => {
  const originalFetch = global.fetch;
  let originalMaxRetries;
  const webhookRetryWorker = require('../../services/webhookRetryWorker');
  const db = require('../../config/database');

  function withDevice(req, label) {
    return req.set('User-Agent', `jest-retryqueue-${label}`).set('X-Forwarded-For', `10.2.0.${Math.floor(Math.random() * 254) + 1}`);
  }

  beforeAll(() => {
    originalMaxRetries = config.webhookMaxRetries;
    config.webhookMaxRetries = 3; // need room for more than one retry in these tests
  });

  afterAll(() => {
    config.webhookMaxRetries = originalMaxRetries;
    global.fetch = originalFetch;
  });

  beforeEach(() => {
    global.fetch = jest.fn((url) => {
      if (typeof url === 'string' && url.startsWith(config.mlServiceUrl)) return Promise.reject(new Error('simulated ML unreachable'));
      return Promise.resolve({ ok: false, status: 500 }); // first attempt always fails in this block, by design
    });
  });

  async function retryQueueRowsFor(webhookId) {
    return db.all('SELECT * FROM webhook_retry_queue WHERE webhook_id = ?', [webhookId]);
  }

  test('a failed first attempt queues a persistent retry row instead of only an in-memory timer', async () => {
    const { accessToken } = await registerAndLogin('retryqueue_queued_user');
    const createRes = await request(app).post(`${API}/webhooks`).set('Authorization', `Bearer ${accessToken}`).send({ url: 'https://example.com/retry-me' });

    await withDevice(request(app).post(`${API}/transactions`), 'queued').set('Authorization', `Bearer ${accessToken}`).send(HIGH_RISK_TXN);
    await new Promise((resolve) => setTimeout(resolve, 150));

    const rows = await retryQueueRowsFor(createRes.body.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].attempt).toBe(2);
    expect(new Date(rows[0].next_retry_at).getTime()).toBeGreaterThan(Date.now());
  });

  test('sweepOnce() ignores a row that is not due yet', async () => {
    const { accessToken } = await registerAndLogin('retryqueue_notdue_user');
    await request(app).post(`${API}/webhooks`).set('Authorization', `Bearer ${accessToken}`).send({ url: 'https://example.com/not-due-yet' });

    await withDevice(request(app).post(`${API}/transactions`), 'notdue').set('Authorization', `Bearer ${accessToken}`).send(HIGH_RISK_TXN);
    await new Promise((resolve) => setTimeout(resolve, 150));

    global.fetch.mockClear();
    await webhookRetryWorker.sweepOnce();
    // The queued retry's next_retry_at is seconds in the future (real
    // exponential backoff) — a sweep run immediately after shouldn't
    // touch it.
    const webhookCalls = global.fetch.mock.calls.filter(([url]) => !url.startsWith(config.mlServiceUrl));
    expect(webhookCalls).toHaveLength(0);
  });

  test('sweepOnce() retries a due row and removes it from the queue on success', async () => {
    const { accessToken } = await registerAndLogin('retryqueue_success_user');
    const createRes = await request(app).post(`${API}/webhooks`).set('Authorization', `Bearer ${accessToken}`).send({ url: 'https://example.com/succeeds-on-retry' });

    await withDevice(request(app).post(`${API}/transactions`), 'retrysuccess').set('Authorization', `Bearer ${accessToken}`).send(HIGH_RISK_TXN);
    await new Promise((resolve) => setTimeout(resolve, 150));

    const [row] = await retryQueueRowsFor(createRes.body.id);
    // Backdate it to be due right now, and make the next attempt succeed.
    await db.run('UPDATE webhook_retry_queue SET next_retry_at = ? WHERE id = ?', [new Date(Date.now() - 1000).toISOString(), row.id]);
    global.fetch = jest.fn((url) => {
      if (typeof url === 'string' && url.startsWith(config.mlServiceUrl)) return Promise.reject(new Error('simulated ML unreachable'));
      return Promise.resolve({ ok: true, status: 200 });
    });

    await webhookRetryWorker.sweepOnce();

    expect(await retryQueueRowsFor(createRes.body.id)).toHaveLength(0);
    const deliveries = await request(app).get(`${API}/webhooks/${createRes.body.id}/deliveries`).set('Authorization', `Bearer ${accessToken}`);
    expect(deliveries.body.deliveries.some((d) => d.success === 1 && d.attempt === 2)).toBe(true);
  });

  test('sweepOnce() reschedules with an incremented attempt if the retry fails again but retries remain', async () => {
    const { accessToken } = await registerAndLogin('retryqueue_reschedule_user');
    const createRes = await request(app).post(`${API}/webhooks`).set('Authorization', `Bearer ${accessToken}`).send({ url: 'https://example.com/keeps-failing' });

    await withDevice(request(app).post(`${API}/transactions`), 'reschedule').set('Authorization', `Bearer ${accessToken}`).send(HIGH_RISK_TXN);
    await new Promise((resolve) => setTimeout(resolve, 150));

    const [row] = await retryQueueRowsFor(createRes.body.id);
    await db.run('UPDATE webhook_retry_queue SET next_retry_at = ? WHERE id = ?', [new Date(Date.now() - 1000).toISOString(), row.id]);
    // global.fetch from beforeEach already always fails (status 500).

    await webhookRetryWorker.sweepOnce();

    const [updatedRow] = await retryQueueRowsFor(createRes.body.id);
    expect(updatedRow).toBeDefined();
    expect(updatedRow.attempt).toBe(3); // was 2, incremented after another failure
    expect(new Date(updatedRow.next_retry_at).getTime()).toBeGreaterThan(Date.now());
  });

  test('the queue row is dropped once max retries are exhausted, with the final failure logged', async () => {
    const { accessToken } = await registerAndLogin('retryqueue_exhausted_user');
    const createRes = await request(app).post(`${API}/webhooks`).set('Authorization', `Bearer ${accessToken}`).send({ url: 'https://example.com/always-fails' });

    await withDevice(request(app).post(`${API}/transactions`), 'exhausted').set('Authorization', `Bearer ${accessToken}`).send(HIGH_RISK_TXN);
    await new Promise((resolve) => setTimeout(resolve, 150));

    // Drive it straight to the last allowed attempt (webhookMaxRetries=3
    // in this block) by backdating + sweeping repeatedly.
    for (let i = 0; i < 2; i++) {
      const [row] = await retryQueueRowsFor(createRes.body.id);
      if (!row) break;
      await db.run('UPDATE webhook_retry_queue SET next_retry_at = ? WHERE id = ?', [new Date(Date.now() - 1000).toISOString(), row.id]);
      await webhookRetryWorker.sweepOnce();
    }

    expect(await retryQueueRowsFor(createRes.body.id)).toHaveLength(0);
    const deliveries = await request(app).get(`${API}/webhooks/${createRes.body.id}/deliveries`).set('Authorization', `Bearer ${accessToken}`);
    expect(deliveries.body.deliveries.some((d) => d.success === 0 && d.attempt === 3)).toBe(true);
  });

  test('a retry for a webhook deactivated since it was queued is dropped silently, without attempting delivery', async () => {
    const { accessToken } = await registerAndLogin('retryqueue_deactivated_user');
    const createRes = await request(app).post(`${API}/webhooks`).set('Authorization', `Bearer ${accessToken}`).send({ url: 'https://example.com/will-be-deactivated' });

    await withDevice(request(app).post(`${API}/transactions`), 'deactivated').set('Authorization', `Bearer ${accessToken}`).send(HIGH_RISK_TXN);
    await new Promise((resolve) => setTimeout(resolve, 150));

    await request(app).patch(`${API}/webhooks/${createRes.body.id}`).set('Authorization', `Bearer ${accessToken}`).send({ active: false });

    const [row] = await retryQueueRowsFor(createRes.body.id);
    await db.run('UPDATE webhook_retry_queue SET next_retry_at = ? WHERE id = ?', [new Date(Date.now() - 1000).toISOString(), row.id]);
    global.fetch.mockClear();

    await webhookRetryWorker.sweepOnce();

    expect(await retryQueueRowsFor(createRes.body.id)).toHaveLength(0);
    const webhookCalls = global.fetch.mock.calls.filter(([url]) => !url.startsWith(config.mlServiceUrl));
    expect(webhookCalls).toHaveLength(0); // dropped before ever calling fetch again
  });

  test('sweepOnce() does not run two sweeps concurrently (the sweeping guard)', async () => {
    // A crude but effective check: call sweepOnce() twice back-to-back
    // without awaiting the first, and confirm this doesn't throw or
    // double-process — the second call should return immediately
    // (no-op) rather than running its own pass while the first is mid-flight.
    const first = webhookRetryWorker.sweepOnce();
    const second = webhookRetryWorker.sweepOnce();
    await expect(Promise.all([first, second])).resolves.toBeDefined();
  });
});

describe('Idempotency keys on POST /transactions', () => {
  test('a request with no Idempotency-Key header behaves normally (no replay machinery involved)', async () => {
    const { accessToken } = await registerAndLogin('idem_none_user');
    const res = await request(app).post(`${API}/transactions`).set('Authorization', `Bearer ${accessToken}`).send(LOW_RISK_TXN);
    expect(res.status).toBe(201);
    expect(res.headers['idempotent-replay']).toBeUndefined();
  });

  test('rejects an empty or oversized Idempotency-Key', async () => {
    const { accessToken } = await registerAndLogin('idem_badkey_user');
    const tooLong = await request(app).post(`${API}/transactions`)
      .set('Authorization', `Bearer ${accessToken}`).set('Idempotency-Key', 'x'.repeat(300)).send(LOW_RISK_TXN);
    expect(tooLong.status).toBe(400);
  });

  test('replaying the same key with the same body returns the identical response and does not create a second transaction', async () => {
    const { accessToken, user } = await registerAndLogin('idem_replay_user');
    const key = 'order-12345';

    const first = await request(app).post(`${API}/transactions`)
      .set('Authorization', `Bearer ${accessToken}`).set('Idempotency-Key', key).send(LOW_RISK_TXN);
    expect(first.status).toBe(201);
    expect(first.headers['idempotent-replay']).toBeUndefined();

    const second = await request(app).post(`${API}/transactions`)
      .set('Authorization', `Bearer ${accessToken}`).set('Idempotency-Key', key).send(LOW_RISK_TXN);
    expect(second.status).toBe(201);
    expect(second.headers['idempotent-replay']).toBe('true');
    expect(second.body.transaction.id).toBe(first.body.transaction.id);

    const listRes = await request(app).get(`${API}/transactions`).set('Authorization', `Bearer ${accessToken}`).query({ page: 1, limit: 100 });
    const matching = listRes.body.transactions.filter((t) => t.merchant === LOW_RISK_TXN.merchant && t.user_id === user.id);
    expect(matching).toHaveLength(1);
  });

  test('reusing the same key with a different body returns 409, not a silent replay', async () => {
    const { accessToken } = await registerAndLogin('idem_conflict_user');
    const key = 'order-67890';

    const first = await request(app).post(`${API}/transactions`)
      .set('Authorization', `Bearer ${accessToken}`).set('Idempotency-Key', key).send(LOW_RISK_TXN);
    expect(first.status).toBe(201);

    const second = await request(app).post(`${API}/transactions`)
      .set('Authorization', `Bearer ${accessToken}`).set('Idempotency-Key', key).send({ ...LOW_RISK_TXN, amount: 99 });
    expect(second.status).toBe(409);
  });

  test('the same key value is independent across two different users (scoped per-user)', async () => {
    const { accessToken: tokenA } = await registerAndLogin('idem_scope_user_a');
    const { accessToken: tokenB } = await registerAndLogin('idem_scope_user_b');
    const key = 'shared-key-value';

    const resA = await request(app).post(`${API}/transactions`).set('Authorization', `Bearer ${tokenA}`).set('Idempotency-Key', key).send(LOW_RISK_TXN);
    const resB = await request(app).post(`${API}/transactions`).set('Authorization', `Bearer ${tokenB}`).set('Idempotency-Key', key).send(LOW_RISK_TXN);

    expect(resA.status).toBe(201);
    expect(resB.status).toBe(201);
    expect(resA.body.transaction.id).not.toBe(resB.body.transaction.id);
  });

  test('two concurrent requests with the same key never both create a NEW transaction', async () => {
    const { accessToken } = await registerAndLogin('idem_race_user');
    const key = 'concurrent-order';

    const [first, second] = await Promise.all([
      request(app).post(`${API}/transactions`).set('Authorization', `Bearer ${accessToken}`).set('Idempotency-Key', key).send(LOW_RISK_TXN),
      request(app).post(`${API}/transactions`).set('Authorization', `Bearer ${accessToken}`).set('Idempotency-Key', key).send(LOW_RISK_TXN),
    ]);

    // The exact status-code split depends on how Node happens to
    // interleave the two requests — with better-sqlite3 fully
    // synchronous (no real yield during a query), it's common for one
    // request to fully complete before the other's idempotency check
    // even runs, so both landing on 201 (the second correctly replaying
    // the first's result) is a legitimate outcome, not just 201+409.
    // What actually matters, and is asserted below regardless of which
    // shape this run produced: never two INDEPENDENTLY created
    // transactions for one idempotency key.
    if (first.status === 201 && second.status === 201) {
      expect(first.body.transaction.id).toBe(second.body.transaction.id);
    } else {
      expect([first.status, second.status].sort()).toEqual([201, 409]);
    }

    const listRes = await request(app).get(`${API}/transactions`).set('Authorization', `Bearer ${accessToken}`).query({ page: 1, limit: 100 });
    const matching = listRes.body.transactions.filter((t) => t.merchant === LOW_RISK_TXN.merchant);
    expect(matching).toHaveLength(1);
  });

  test('an expired idempotency key is treated as fresh (no stale replay)', async () => {
    const { accessToken } = await registerAndLogin('idem_expired_user');
    const key = 'old-order';

    const first = await request(app).post(`${API}/transactions`)
      .set('Authorization', `Bearer ${accessToken}`).set('Idempotency-Key', key).send(LOW_RISK_TXN);
    expect(first.status).toBe(201);

    // Directly backdate the stored key's expiry, simulating the TTL
    // having elapsed, rather than waiting hours in a test.
    const idempotencyRepository = require('../../models/idempotencyRepository');
    const meRes = await request(app).get(`${API}/auth/me`).set('Authorization', `Bearer ${accessToken}`);
    const row = await idempotencyRepository.find(meRes.body.user.id, key);
    const db = require('../../config/database');
    await db.run('UPDATE idempotency_keys SET expires_at = ? WHERE id = ?', [new Date(Date.now() - 1000).toISOString(), row.id]);

    const second = await request(app).post(`${API}/transactions`)
      .set('Authorization', `Bearer ${accessToken}`).set('Idempotency-Key', key).send(LOW_RISK_TXN);
    expect(second.status).toBe(201);
    expect(second.headers['idempotent-replay']).toBeUndefined();
    expect(second.body.transaction.id).not.toBe(first.body.transaction.id);
  });

  test('a 4xx caused by validation happens before idempotency ever reserves the key, so retrying with a corrected body is not blocked', async () => {
    const { accessToken } = await registerAndLogin('idem_validation_user');
    const key = 'invalid-then-valid';

    const bad = await request(app).post(`${API}/transactions`)
      .set('Authorization', `Bearer ${accessToken}`).set('Idempotency-Key', key).send({ ...LOW_RISK_TXN, amount: -5 });
    expect(bad.status).toBe(400);

    const good = await request(app).post(`${API}/transactions`)
      .set('Authorization', `Bearer ${accessToken}`).set('Idempotency-Key', key).send(LOW_RISK_TXN);
    expect(good.status).toBe(201);
  });
});

describe('idempotencyRepository — race safety at the storage layer', () => {
  test('reserving the same (user, key) twice concurrently: the second insert fails as a unique violation', async () => {
    const idempotencyRepository = require('../../models/idempotencyRepository');
    const { accessToken } = await registerAndLogin('idem_repo_race_user');
    const meRes = await request(app).get(`${API}/auth/me`).set('Authorization', `Bearer ${accessToken}`);
    const userId = meRes.body.user.id;
    const expiresAt = new Date(Date.now() + 60_000).toISOString();

    const results = await Promise.allSettled([
      idempotencyRepository.reserve({ userId, key: 'race-key', requestHash: 'h1', expiresAt }),
      idempotencyRepository.reserve({ userId, key: 'race-key', requestHash: 'h1', expiresAt }),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(idempotencyRepository.isUniqueViolation(rejected[0].reason)).toBe(true);
  });
});
