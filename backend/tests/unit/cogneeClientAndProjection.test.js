process.env.COGNEE_SERVICE_URL = 'http://cognee.test';
process.env.COGNEE_SERVICE_API_KEY = 'unit-service-key-0123456789abcdef012345';
process.env.COGNEE_PSEUDONYM_SECRET = 'unit-pseudonym-secret-0123456789';
process.env.COGNEE_RETRY_BASE_MS = '0';
process.env.COGNEE_MAX_RETRIES = '2';

const client = require('../../services/cognee/client');
const { accountRef, deviceRef } = require('../../services/cognee/pseudonymize');
const { redact, NEVER_PROJECT } = require('../../services/cognee/sanitize');
const projector = require('../../services/cognee/projector');

const mockFetch = (...responses) => {
  const calls = [];
  global.fetch = jest.fn(async (url, init) => {
    calls.push({ url, init });
    const next = responses.shift() ?? responses[responses.length - 1];
    if (next instanceof Error) throw next;
    return { ok: next.status < 400, status: next.status, text: async () => JSON.stringify(next.body ?? {}) };
  });
  return calls;
};
const realFetch = global.fetch;
afterEach(() => { global.fetch = realFetch; });

describe('pseudonymisation', () => {
  test('is deterministic, keyed, kind-separated and not reversible to the raw id', () => {
    expect(accountRef(42)).toBe(accountRef(42));
    expect(accountRef(42)).not.toBe(accountRef(43));
    expect(accountRef('abc')).not.toBe(deviceRef('abc'));            // an account and a device never collide
    expect(accountRef(42)).toMatch(/^acct_[a-f0-9]{24}$/);
    expect(deviceRef('ua-hash')).toMatch(/^dev_[a-f0-9]{24}$/);
    expect(accountRef(null)).toBeNull();
  });
  test('changes completely when the secret changes (re-keying)', () => {
    const before = accountRef(7);
    jest.resetModules();
    process.env.COGNEE_PSEUDONYM_SECRET = 'a-different-secret-0123456789abcd';
    const rekeyed = require('../../services/cognee/pseudonymize').accountRef(7);
    process.env.COGNEE_PSEUDONYM_SECRET = 'unit-pseudonym-secret-0123456789';
    expect(rekeyed).not.toBe(before);
  });
});

describe('redaction', () => {
  test('removes emails, phones, card numbers, ips, ssn and tokens', () => {
    const out = redact('mail a.b@example.com call +1 (415) 555-0100 card 4111-1111-1111-1111 ip 198.51.100.4 ssn 123-45-6789 key sk_live_0123456789abcdefghij');
    for (const leak of ['a.b@example.com', '415', '4111', '198.51.100.4', '123-45-6789', '0123456789abcdefghij']) expect(out).not.toContain(leak);
  });
  test('keeps ordinary analyst text and bounds length', () => {
    expect(redact('Customer confirmed the purchase was theirs')).toBe('Customer confirmed the purchase was theirs');
    expect(redact('word '.repeat(2000), 100)).toHaveLength(100);
    expect(redact(null)).toBe('');
  });
  test('the never-project list covers credentials and direct identifiers', () => {
    for (const col of ['password', 'totp_secret', 'email', 'ip_address', 'device_fingerprint']) expect(NEVER_PROJECT).toContain(col);
  });
});

describe('projection is deterministic and canonical', () => {
  test('hash ignores key order and is sensitive to content', () => {
    expect(projector.hashOf({ a: 1, b: { c: 2, d: 3 } })).toBe(projector.hashOf({ b: { d: 3, c: 2 }, a: 1 }));
    expect(projector.hashOf({ a: 1 })).not.toBe(projector.hashOf({ a: 2 }));
  });
  test('lookback clause tolerates both timestamp storage formats', () => {
    const c = projector.lookbackClause('t.created_at', 30);
    expect(c.params).toHaveLength(2);
    expect(c.params[0]).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    expect(c.params[1]).toMatch(/T/);
  });
});

describe('client: retries, timeouts and error mapping', () => {
  test('sends the service key and returns parsed JSON', async () => {
    const calls = mockFetch({ status: 200, body: { ok: 1 } });
    expect(await client.get('/v1/health')).toEqual({ ok: 1 });
    expect(calls[0].init.headers['X-Cognee-Service-Key']).toBe(process.env.COGNEE_SERVICE_API_KEY);
    expect(calls[0].url).toBe('http://cognee.test/v1/health');
  });
  test('retries 5xx then succeeds', async () => {
    mockFetch({ status: 503 }, { status: 502 }, { status: 200, body: { ok: true } });
    expect(await client.post('/v1/ingest', {})).toEqual({ ok: true });
    expect(global.fetch).toHaveBeenCalledTimes(3);
  });
  test('retries network errors, then reports unreachable', async () => {
    mockFetch(new TypeError('fetch failed'));
    await expect(client.get('/v1/stats')).rejects.toMatchObject({ code: 'unreachable', status: 503 });
    expect(global.fetch).toHaveBeenCalledTimes(3);                  // 1 try + 2 retries
  });
  test('never retries 4xx', async () => {
    mockFetch({ status: 422, body: { detail: 'Field not allowed' } });
    await expect(client.post('/v1/ingest', {})).rejects.toMatchObject({ code: 'rejected', status: 422 });
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
  test('auth failures are reported without leaking upstream detail and are not retried', async () => {
    mockFetch({ status: 403, body: { detail: 'Invalid credentials' } });
    const err = await client.get('/v1/stats').catch((e) => e);
    expect(err.code).toBe('auth_failed');
    expect(err.message).not.toContain('Invalid credentials');
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
  test('times out a hung request', async () => {
    global.fetch = jest.fn((url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))));
    await expect(client.get('/v1/stats', { timeoutMs: 20, retries: 0 })).rejects.toMatchObject({ code: 'timeout', status: 504 });
  });
  test('a service that is still loading its embedding model is reported as warming_up (503), after retries', async () => {
    const warming = { status: 503, body: { detail: 'Embedding model is not ready (warming)' } };
    mockFetch(warming, warming, warming);                              // one response per attempt (1 try + 2 retries)
    const err = await client.post('/v1/ingest', {}).catch((e) => e);
    expect(err).toMatchObject({ code: 'warming_up', status: 503 });
    expect(err.message).toMatch(/still starting/i); expect(err.message).not.toMatch(/HTTP 5/);
    expect(global.fetch).toHaveBeenCalledTimes(3);                  // retried: it usually becomes ready within seconds
  });
  test('a warming service that becomes ready during the retries succeeds', async () => {
    mockFetch({ status: 503, body: { detail: 'Embedding model is not ready (warming)' } }, { status: 200, body: { ingested: 1 } });
    expect(await client.post('/v1/ingest', {})).toEqual({ ingested: 1 });
  });
  test('404 is preserved as not_found', async () => {
    mockFetch({ status: 404, body: { detail: 'Entity not found' } });
    await expect(client.get('/v1/entities/x/related')).rejects.toMatchObject({ code: 'not_found', status: 404 });
  });
});
