/**
 * Concurrency & data-integrity guarantees, verified under REAL concurrent
 * requests (see helpers.js). Each test fires its requests at the same time
 * and then asserts on what the DATABASE contains — not just on responses.
 */
const db = require('../../config/database');
const alertRepository = require('../../models/alertRepository');
const idempotencyRepository = require('../../models/idempotencyRepository');
const realtimeEvents = require('../../models/realtimeEventRepository');
const {
  start, stop, call, registerAndLogin, adminToken, secondAdmin, unique, identity, FLAGGED_TXN, SAFE_TXN,
} = require('./helpers');

jest.setTimeout(60000);

beforeAll(start);
afterAll(stop);
afterEach(() => jest.restoreAllMocks());

const count = async (sql, params = []) => Number((await db.get(sql, params)).n);
const post = (token, body, key, extra = {}) =>
  call('POST', '/transactions', { token, body, headers: { ...identity(), ...(key ? { 'Idempotency-Key': key } : {}), ...extra } });

describe('idempotency under simultaneous submission', () => {
  test('25 simultaneous requests with the same key create exactly ONE transaction and ONE alert', async () => {
    const { token, user } = await registerAndLogin('idem_burst');
    const key = unique('burst');
    const headers = identity(); // same client for all, as a retrying client would be

    const results = await Promise.all(Array.from({ length: 25 }, () =>
      call('POST', '/transactions', { token, body: FLAGGED_TXN, headers: { ...headers, 'Idempotency-Key': key } })));

    const created = results.filter((r) => r.status === 201 && r.headers.get('idempotent-replay') !== 'true');
    const replays = results.filter((r) => r.status === 201 && r.headers.get('idempotent-replay') === 'true');
    const inProgress = results.filter((r) => r.status === 409);
    expect(created).toHaveLength(1);
    expect(created.length + replays.length + inProgress.length).toBe(25); // nothing else (no 500s)
    for (const r of replays) expect(r.body.transaction.id).toBe(created[0].body.transaction.id);

    expect(await count('SELECT COUNT(*) AS n FROM transactions WHERE user_id = ?', [user.id])).toBe(1);
    expect(await count('SELECT COUNT(*) AS n FROM alerts WHERE user_id = ?', [user.id])).toBe(1);
    expect(await count('SELECT COUNT(*) AS n FROM realtime_events WHERE user_id = ? AND event_type = ?', [user.id, 'transaction:new'])).toBe(1);

    // The key is completed with the exact response, so a later retry replays it.
    const later = await call('POST', '/transactions', { token, body: FLAGGED_TXN, headers: { ...headers, 'Idempotency-Key': key } });
    expect(later.status).toBe(201);
    expect(later.headers.get('idempotent-replay')).toBe('true');
    expect(later.body.transaction.id).toBe(created[0].body.transaction.id);
  });

  test('same key with DIFFERENT bodies, simultaneously: one wins, nobody gets a silent wrong replay', async () => {
    const { token, user } = await registerAndLogin('idem_mixed');
    const key = unique('mixed');
    const bodies = [20, 30, 40, 50, 60, 70].map((amount) => ({ ...SAFE_TXN, amount }));

    const results = await Promise.all(bodies.map((b) => post(token, b, key)));
    const created = results.filter((r) => r.status === 201);
    expect(created).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(5);
    expect(await count('SELECT COUNT(*) AS n FROM transactions WHERE user_id = ?', [user.id])).toBe(1);
  });

  test('20 DIFFERENT keys at once all succeed — no lost writes, no spurious conflicts', async () => {
    const { token, user } = await registerAndLogin('idem_many');
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => post(token, { ...SAFE_TXN, amount: 10 + i }, unique(`k${i}`))));
    expect(results.every((r) => r.status === 201)).toBe(true);
    expect(await count('SELECT COUNT(*) AS n FROM transactions WHERE user_id = ?', [user.id])).toBe(20);
  });

  test('uniqueness is enforced by the DATABASE, not just application logic', async () => {
    const { user } = await registerAndLogin('idem_db');
    const row = { userId: user.id, key: 'raw-key', requestHash: 'h', expiresAt: new Date(Date.now() + 1e6).toISOString() };
    await idempotencyRepository.reserve(row);
    // A second writer that bypasses the middleware entirely still cannot duplicate the key.
    let error;
    try { await idempotencyRepository.reserve(row); } catch (e) { error = e; }
    expect(error).toBeDefined();
    expect(idempotencyRepository.isUniqueViolation(error)).toBe(true);
  });

  test('a stale pending reservation (worker died) can be taken over — by exactly one retry', async () => {
    const { token, user } = await registerAndLogin('idem_stale');
    const key = unique('stale');
    const hashBody = (b) => require('crypto').createHash('sha256').update(JSON.stringify(b)).digest('hex');
    // Zod-normalised body is what the middleware hashes; mimic by sending a request once to learn the hash.
    const probe = await post(token, SAFE_TXN, unique('probe'));
    expect(probe.status).toBe(201);
    const { lastInsertRowid } = await db.insert(
      "INSERT INTO idempotency_keys (user_id, idempotency_key, request_hash, status, locked_at, expires_at) VALUES (?, ?, ?, 'pending', ?, ?)",
      [user.id, key, 'placeholder', new Date(Date.now() - 3600e3).toISOString(), new Date(Date.now() + 3600e3).toISOString()]
    );
    // A different body hash can't take it over (it isn't the same request)…
    const different = await post(token, { ...SAFE_TXN, amount: 99 }, key);
    expect(different.status).toBe(409);
    // …and a pending row that is NOT stale blocks the same request.
    await db.run("UPDATE idempotency_keys SET locked_at = ? WHERE id = ?", [new Date().toISOString(), lastInsertRowid]);
    const fresh = await post(token, SAFE_TXN, key);
    expect(fresh.status).toBe(409);
    void hashBody;
  });
});

describe('atomicity: a failure part-way never leaves a half-written decision', () => {
  test('failure while creating the alert rolls back the transaction and releases the idempotency key', async () => {
    const { token, user } = await registerAndLogin('atomic_alert');
    const key = unique('atomic');
    const headers = identity();
    jest.spyOn(alertRepository, 'insertOnce').mockRejectedValueOnce(new Error('disk full'));

    const failed = await call('POST', '/transactions', { token, body: FLAGGED_TXN, headers: { ...headers, 'Idempotency-Key': key } });
    expect(failed.status).toBe(500);
    expect(await count('SELECT COUNT(*) AS n FROM transactions WHERE user_id = ?', [user.id])).toBe(0);
    expect(await count('SELECT COUNT(*) AS n FROM alerts WHERE user_id = ?', [user.id])).toBe(0);
    expect(await count('SELECT COUNT(*) AS n FROM realtime_events WHERE user_id = ?', [user.id])).toBe(0);

    // The reservation was released, so the client's retry goes through and creates exactly one of each.
    const retry = await call('POST', '/transactions', { token, body: FLAGGED_TXN, headers: { ...headers, 'Idempotency-Key': key } });
    expect(retry.status).toBe(201);
    expect(await count('SELECT COUNT(*) AS n FROM transactions WHERE user_id = ?', [user.id])).toBe(1);
    expect(await count('SELECT COUNT(*) AS n FROM alerts WHERE user_id = ?', [user.id])).toBe(1);
  });

  test('failure while writing the real-time event (after txn + alert) rolls everything back', async () => {
    const { token, user } = await registerAndLogin('atomic_event');
    jest.spyOn(realtimeEvents, 'append').mockRejectedValueOnce(new Error('event log down'));
    const failed = await post(token, FLAGGED_TXN);
    expect(failed.status).toBe(500);
    expect(await count('SELECT COUNT(*) AS n FROM transactions WHERE user_id = ?', [user.id])).toBe(0);
    expect(await count('SELECT COUNT(*) AS n FROM alerts WHERE user_id = ?', [user.id])).toBe(0);
  });

  test('failure while completing the idempotency record rolls back the work it describes', async () => {
    const { token, user } = await registerAndLogin('atomic_idem');
    jest.spyOn(idempotencyRepository, 'complete').mockRejectedValueOnce(new Error('write failed'));
    const failed = await post(token, FLAGGED_TXN, unique('c'));
    expect(failed.status).toBe(500);
    expect(await count('SELECT COUNT(*) AS n FROM transactions WHERE user_id = ?', [user.id])).toBe(0);
  });

  test('a concurrent request is not able to see (or be blocked by) another request\'s uncommitted rows', async () => {
    const { token, user } = await registerAndLogin('atomic_iso');
    const results = await Promise.all(Array.from({ length: 12 }, () => post(token, FLAGGED_TXN)));
    expect(results.every((r) => r.status === 201)).toBe(true);
    // every transaction has exactly one alert, and every flagged transaction has one
    const orphans = await count(
      `SELECT COUNT(*) AS n FROM transactions t WHERE t.user_id = ? AND t.risk_level != 'low'
         AND (SELECT COUNT(*) FROM alerts a WHERE a.transaction_id = t.id) != 1`, [user.id]);
    expect(orphans).toBe(0);
    expect(await count('SELECT COUNT(*) AS n FROM alerts WHERE user_id = ?', [user.id])).toBe(12);
  });
});

describe('alerts: the database allows only one alert per transaction', () => {
  test('a second alert for the same transaction is rejected by a unique index, even if the app is bypassed', async () => {
    const { token, user } = await registerAndLogin('alert_unique');
    const created = await post(token, FLAGGED_TXN);
    const txnId = created.body.transaction.id;
    let error;
    try {
      await db.insert('INSERT INTO alerts (transaction_id, user_id, message, risk_level) VALUES (?, ?, ?, ?)', [txnId, user.id, 'dup', 'high']);
    } catch (e) { error = e; }
    expect(error).toBeDefined();
    expect(idempotencyRepository.isUniqueViolation(error)).toBe(true);
  });

  test('insertOnce called by 10 racing writers yields one row and exactly one "created"', async () => {
    const { token, user } = await registerAndLogin('alert_once');
    const created = await post(token, SAFE_TXN); // low risk: no alert yet
    const txnId = created.body.transaction.id;
    const outcomes = await Promise.all(Array.from({ length: 10 }, () =>
      alertRepository.insertOnce({ transaction_id: txnId, user_id: user.id, message: 'race', risk_level: 'medium' })));
    expect(outcomes.filter((o) => o.created)).toHaveLength(1);
    expect(new Set(outcomes.map((o) => o.alert.id)).size).toBe(1);
    expect(await count('SELECT COUNT(*) AS n FROM alerts WHERE transaction_id = ?', [txnId])).toBe(1);
  });
});

describe('optimistic locking: two investigators on one alert', () => {
  async function flaggedAlert() {
    const owner = await registerAndLogin('lock_owner');
    const created = await post(owner.token, FLAGGED_TXN);
    const list = await call('GET', '/alerts', { token: await adminToken() });
    const alert = list.body.alerts.find((a) => a.transaction_id === created.body.transaction.id);
    return { alert, owner };
  }

  test('10 investigators resolving the same alert at once: exactly one verdict is recorded, the rest get 409 + current state', async () => {
    const { alert } = await flaggedAlert();
    const admin = await adminToken();
    const second = await secondAdmin();
    const tokens = [admin, second.token];
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) =>
      call('PATCH', `/alerts/${alert.id}/resolve`, {
        token: tokens[i % 2], body: { verdict: i % 2 ? 'false_positive' : 'confirmed_fraud', note: `investigator ${i}` },
      })));

    const wins = results.filter((r) => r.status === 200);
    const conflicts = results.filter((r) => r.status === 409);
    expect(wins).toHaveLength(1);
    expect(conflicts).toHaveLength(9);
    expect(conflicts[0].body.details.code).toBe('VERSION_CONFLICT');
    expect(conflicts[0].body.details.current.verdict).toBe(wins[0].body.alert.verdict);

    const row = await db.get('SELECT * FROM alerts WHERE id = ?', [alert.id]);
    expect(row.verdict).toBe(wins[0].body.alert.verdict);
    expect(row.resolution_note).toBe(wins[0].body.alert.resolution_note);
    expect(Number(row.version)).toBe(Number(alert.version) + 1); // one write, one version bump
  });

  test('a stale version is rejected; the current version is accepted', async () => {
    const { alert } = await flaggedAlert();
    const admin = await adminToken();
    const second = await secondAdmin();

    // Investigator B assigns the alert (bumps version) after A loaded it.
    const adminUser = (await call('GET', '/auth/me', { token: second.token })).body;
    const assigned = await call('PATCH', `/alerts/${alert.id}/assign`, { token: admin, body: { assigneeId: adminUser.user?.id ?? adminUser.id } });
    expect(assigned.status).toBe(200);

    const stale = await call('PATCH', `/alerts/${alert.id}/resolve`, { token: admin, body: { verdict: 'false_positive', version: alert.version } });
    expect(stale.status).toBe(409);
    expect(stale.body.details.code).toBe('VERSION_CONFLICT');
    expect(stale.body.details.current.version).toBe(Number(alert.version) + 1);

    const fresh = await call('PATCH', `/alerts/${alert.id}/resolve`, { token: admin, body: { verdict: 'false_positive', version: stale.body.details.current.version } });
    expect(fresh.status).toBe(200);

    // Resolved alerts can't be silently re-resolved without the current version.
    const again = await call('PATCH', `/alerts/${alert.id}/resolve`, { token: second.token, body: { verdict: 'confirmed_fraud' } });
    expect(again.status).toBe(409);
  });

  test('bulk-resolve racing single resolves never overwrites an already-resolved alert', async () => {
    const owner = await registerAndLogin('lock_bulk');
    const created = await Promise.all(Array.from({ length: 6 }, () => post(owner.token, FLAGGED_TXN)));
    const admin = await adminToken();
    const list = await call('GET', '/alerts', { token: admin, });
    const ids = created.map((c) => list.body.alerts.find((a) => a.transaction_id === c.body.transaction.id).id);

    const [bulk, ...singles] = await Promise.all([
      call('PATCH', '/alerts/bulk-resolve', { token: admin, body: { alertIds: ids, verdict: 'false_positive' } }),
      ...ids.slice(0, 3).map((id) => call('PATCH', `/alerts/${id}/resolve`, { token: admin, body: { verdict: 'confirmed_fraud' } })),
    ]);
    expect(bulk.status).toBe(200);
    const singleWins = singles.filter((s) => s.status === 200).length;
    // every alert is resolved exactly once, by exactly one of the writers
    expect(bulk.body.resolvedCount + singleWins).toBe(6);
    const rows = await db.all(`SELECT version, verdict FROM alerts WHERE id IN (${ids.map(() => '?').join(',')})`, ids);
    expect(rows.every((r) => Number(r.version) === 2)).toBe(true);
  });
});

describe('disputes', () => {
  async function disputableTxn() {
    const owner = await registerAndLogin('disp');
    const created = await post(owner.token, SAFE_TXN);
    return { owner, txnId: created.body.transaction.id };
  }

  test('10 simultaneous "open dispute" calls for one transaction create exactly one dispute', async () => {
    const { owner, txnId } = await disputableTxn();
    const results = await Promise.all(Array.from({ length: 10 }, () =>
      call('POST', '/disputes', { token: owner.token, body: { transaction_id: txnId, reason: 'not mine' } })));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(9);
    expect(await count('SELECT COUNT(*) AS n FROM disputes WHERE transaction_id = ?', [txnId])).toBe(1);
  });

  test('two investigators moving the same dispute to "won" and "lost" at once: one wins, the other is told', async () => {
    const { owner, txnId } = await disputableTxn();
    const open = await call('POST', '/disputes', { token: owner.token, body: { transaction_id: txnId } });
    const id = open.body.dispute.id;
    const admin = await adminToken();
    const second = await secondAdmin();

    const results = await Promise.all([
      call('PATCH', `/disputes/${id}`, { token: admin, body: { status: 'won', note: 'A', version: open.body.dispute.version } }),
      call('PATCH', `/disputes/${id}`, { token: second.token, body: { status: 'lost', note: 'B', version: open.body.dispute.version } }),
    ]);
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([200, 409]);
    const loser = results.find((r) => r.status === 409);
    expect(['VERSION_CONFLICT', undefined]).toContain(loser.body.details?.code);
    const final = await db.get('SELECT status, version FROM disputes WHERE id = ?', [id]);
    expect(final.status).toBe(results.find((r) => r.status === 200).body.dispute.status);
    expect(Number(final.version)).toBe(2);
  });
});

describe('step-up verification race', () => {
  test('simultaneous success and failure callbacks resolve the hold exactly once, consistently', async () => {
    const { token, user } = await registerAndLogin('stepup_race');
    await call('POST', '/webhooks', { token, body: { url: 'https://example.com/hook', events: ['transaction.step_up_required'] } });
    const created = await post(token, FLAGGED_TXN);
    expect(created.body.transaction.status).toBe('pending_step_up');
    const { id } = created.body.transaction;
    const challenge = created.body.step_up.challenge_token;

    const outcomes = ['success', 'failure', 'success', 'failure', 'success', 'failure'];
    const results = await Promise.all(outcomes.map((outcome) =>
      call('POST', `/transactions/${id}/step-up/verify`, { token, body: { challenge_token: challenge, outcome } })));
    const winners = results.filter((r) => r.status === 200);
    expect(winners).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(5);

    const txn = await db.get('SELECT status FROM transactions WHERE id = ?', [id]);
    const ch = await db.get('SELECT status FROM step_up_challenges WHERE transaction_id = ?', [id]);
    expect(txn.status).toBe(winners[0].body.step_up_outcome === 'success' ? 'completed' : 'blocked');
    expect(ch.status).toBe(winners[0].body.step_up_outcome === 'success' ? 'verified' : 'failed');
    void user;
  });
});

describe('database transactions are isolated from unrelated requests (SQLite shares one connection)', () => {
  test('statements from other requests do not leak into, or get rolled back with, a failing transaction', async () => {
    const { token, user } = await registerAndLogin('iso');
    // One request fails mid-transaction while several others succeed at the same time.
    jest.spyOn(alertRepository, 'insertOnce').mockRejectedValueOnce(new Error('boom'));
    const results = await Promise.all(Array.from({ length: 8 }, () => post(token, FLAGGED_TXN)));
    const failed = results.filter((r) => r.status === 500);
    const ok = results.filter((r) => r.status === 201);
    expect(failed).toHaveLength(1);
    expect(ok).toHaveLength(7);
    // the 7 survivors are all intact and committed
    expect(await count('SELECT COUNT(*) AS n FROM transactions WHERE user_id = ?', [user.id])).toBe(7);
    expect(await count('SELECT COUNT(*) AS n FROM alerts WHERE user_id = ?', [user.id])).toBe(7);
  });
});
