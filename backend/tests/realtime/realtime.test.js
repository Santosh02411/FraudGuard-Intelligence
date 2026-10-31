/**
 * Real-time layer: authorization, cursor replay, synthetic separation,
 * filtering, backpressure and multi-instance delivery over a real Redis.
 * Uses real Socket.IO clients over real WebSockets.
 */
const { spawn, spawnSync } = require('child_process');
const { deleteTransactions } = require('../helpers/purge');
const { io: connect } = require('socket.io-client');
const db = require('../../config/database');
const bcrypt = require('bcryptjs');
const realtimeEvents = require('../../models/realtimeEventRepository');
const { initSocketServer, createRealtimeServer } = require('../../realtime/socketServer');
const simulator = require('../../realtime/simulator');
const { start, stop, call, registerAndLogin, adminToken, identity, FLAGGED_TXN, SAFE_TXN, unique } = require('../concurrency/helpers');

jest.setTimeout(60000);

let server; let base; let realtime;
const sockets = [];

beforeAll(async () => {
  ({ server, base } = await start());
  realtime = initSocketServer(server);
});
afterAll(async () => {
  sockets.forEach((s) => s.close());
  try { simulator.stop(); } catch (_) { /* not running */ }
  await new Promise((r) => realtime.close(r));
  await stop();
});

function open(token, { url = base, subscribe } = {}) {
  const socket = connect(url, { auth: { token }, transports: ['websocket'], forceNew: true, reconnection: false });
  const received = [];
  socket.onAny((name, payload) => received.push({ name, payload }));
  sockets.push(socket);
  return new Promise((resolve, reject) => {
    socket.on('connect_error', reject);
    socket.on('connect', async () => {
      if (subscribe) await new Promise((r) => socket.emit('subscribe', subscribe, r));
      resolve({ socket, received, of: (name) => received.filter((e) => e.name === name).map((e) => e.payload) });
    });
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 4000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return true; await sleep(25); }
  return false;
}
const make = (token, body = FLAGGED_TXN) => call('POST', '/transactions', { token, body, headers: identity() });

describe('authentication', () => {
  test('a socket without a valid access token is refused', async () => {
    await expect(open(undefined)).rejects.toThrow();
    await expect(open('not-a-jwt')).rejects.toThrow();
  });
});

describe('authorization: each user receives only events they are allowed to see', () => {
  test('owner and admin get the event (with a persistent id); another user gets nothing', async () => {
    const a = await registerAndLogin('rt_a');
    const b = await registerAndLogin('rt_b');
    const admin = await adminToken();
    const [sa, sb, sadmin] = await Promise.all([open(a.token), open(b.token), open(admin)]);

    const created = await make(a.token);
    expect(created.status).toBe(201);
    const txnId = created.body.transaction.id;

    expect(await waitFor(() => sa.of('transaction:new').length === 1 && sadmin.of('transaction:new').some((e) => e.transaction.id === txnId))).toBe(true);
    await sleep(400); // give a leak time to show up
    const ev = sa.of('transaction:new')[0];
    expect(ev.id).toBeGreaterThan(0);
    expect(ev.source).toBe('live');
    expect(ev.transaction.id).toBe(txnId);
    expect(sb.received.filter((e) => ['transaction:new', 'alert:new'].includes(e.name))).toHaveLength(0);
    expect(sa.of('alert:new')).toHaveLength(1);
  });

  test('the replay API applies the same rules: users read only their own events, admins read all', async () => {
    const a = await registerAndLogin('rt_ra');
    const b = await registerAndLogin('rt_rb');
    await make(a.token); await make(b.token);
    const mine = await call('GET', '/events?after=0&limit=500', { token: a.token });
    expect(mine.status).toBe(200);
    expect(mine.body.events.length).toBeGreaterThan(0);
    expect(mine.body.events.every((e) => e.user_id === a.user.id)).toBe(true);
    const all = await call('GET', '/events?after=0&limit=500', { token: await adminToken() });
    expect(new Set(all.body.events.map((e) => e.user_id)).size).toBeGreaterThan(1);
    expect((await call('GET', '/events')).status).toBe(401);
  });
});

describe('persistent ids and cursor replay', () => {
  test('events missed while disconnected are recovered in order, paginated, with no duplicates or gaps', async () => {
    const u = await registerAndLogin('rt_replay');
    const live = await open(u.token);
    const first = await make(u.token, SAFE_TXN);
    expect(await waitFor(() => live.of('transaction:new').length === 1)).toBe(true);
    const cursor = live.of('transaction:new')[0].id;
    live.socket.close(); // goes offline

    const missed = [];
    for (let i = 0; i < 5; i += 1) missed.push((await make(u.token, { ...SAFE_TXN, amount: 10 + i })).body.transaction.id);

    const back = await open(u.token);
    expect(await waitFor(() => back.of('sync:hello').length === 1)).toBe(true);
    expect(back.of('sync:hello')[0].head).toBeGreaterThan(cursor);

    const collected = [];
    let after = cursor; let pages = 0; let more = true;
    while (more) {
      // eslint-disable-next-line no-await-in-loop
      const page = await call('GET', `/events?after=${after}&limit=2`, { token: u.token });
      collected.push(...page.body.events);
      after = page.body.next_cursor; more = page.body.has_more; pages += 1;
      expect(page.body.events.length).toBeLessThanOrEqual(2);
    }
    expect(pages).toBeGreaterThanOrEqual(3);
    const ids = collected.map((e) => e.id);
    expect([...ids].sort((x, y) => x - y)).toEqual(ids);       // ordered
    expect(new Set(ids).size).toBe(ids.length);                // no duplicates
    expect(collected.filter((e) => e.type === 'transaction:new').map((e) => e.transaction.id)).toEqual(missed); // none missing
    expect(first.status).toBe(201);
    // the cursor now sits at the log head: nothing more to fetch
    const done = await call('GET', `/events?after=${after}`, { token: u.token });
    expect(done.body.events).toHaveLength(0);
  });

  test('under 20 simultaneous submissions every pushed id is in the log, ids are unique and ordered', async () => {
    const u = await registerAndLogin('rt_burst');
    const live = await open(u.token);
    await Promise.all(Array.from({ length: 20 }, (_, i) => make(u.token, { ...SAFE_TXN, amount: 5 + i })));
    expect(await waitFor(() => live.of('transaction:new').length === 20)).toBe(true);
    const pushed = live.of('transaction:new').map((e) => e.id);
    const log = (await call('GET', '/events?after=0&limit=500&types=transaction:new', { token: u.token })).body.events.map((e) => e.id);
    expect(new Set(pushed).size).toBe(20);
    expect(log).toEqual(expect.arrayContaining(pushed));
    expect([...log].sort((x, y) => x - y)).toEqual(log);
  });

  test('a cursor older than the retained log is flagged as a gap', async () => {
    const u = await registerAndLogin('rt_gap');
    await make(u.token, SAFE_TXN); await make(u.token, SAFE_TXN);
    const before = await realtimeEvents.bounds();
    await db.run('DELETE FROM realtime_events WHERE id < ?', [before.head]); // simulate retention pruning
    const res = await call('GET', '/events?after=1', { token: u.token });
    expect(res.body.gap).toBe(true);
    expect((await call('GET', `/events?after=${before.head}`, { token: u.token })).body.gap).toBe(false);
  });

  test('retention pruning removes only expired events', async () => {
    await realtimeEvents.append([{ type: 'transaction:new', userId: null, payload: {} }]);
    await db.run("UPDATE realtime_events SET created_at = ? WHERE id = (SELECT MIN(id) FROM realtime_events)", [new Date(Date.now() - 100 * 3600e3).toISOString()]);
    const removed = await realtimeEvents.prune({ maxAgeHours: 72 });
    expect(removed).toBeGreaterThanOrEqual(1);
  });
});

describe('filtering', () => {
  test('a socket subscribed to alerts at min_risk=high receives only high-risk alerts', async () => {
    const u = await registerAndLogin('rt_filter');
    const quiet = await open(u.token, { subscribe: { topics: ['alert'], min_risk: 'high' } });
    const all = await open(u.token); // default subscription: everything
    await make(u.token, FLAGGED_TXN);                                         // medium
    await make(u.token, { ...FLAGGED_TXN, amount: 20000, merchant: 'Wire' }); // over the hard cap => high
    expect(await waitFor(() => all.of('alert:new').length === 2)).toBe(true);
    await sleep(300);
    expect(quiet.of('alert:new')).toHaveLength(1);
    expect(quiet.of('alert:new')[0].alert.risk_level).toBe('high');
    expect(quiet.of('transaction:new')).toHaveLength(0); // topic not subscribed
  });

  test('a client cannot subscribe itself into another user\'s rooms', async () => {
    const a = await registerAndLogin('rt_sub_a');
    const b = await registerAndLogin('rt_sub_b');
    const sneaky = await open(b.token, { subscribe: { topics: ['transaction', 'alert'], user_id: a.user.id, rooms: [`u:${a.user.id}:transaction:all`] } });
    await make(a.token);
    await sleep(600);
    expect(sneaky.received.filter((e) => ['transaction:new', 'alert:new'].includes(e.name))).toHaveLength(0);
  });
});

describe('synthetic events are never confused with real transactions', () => {
  test('simulation output is labelled, flagged is_synthetic, kept off user/admin rooms and out of the replay log', async () => {
    const demoEmail = `${unique('sim')}@demo.fraudguard.io`;
    await db.insert("INSERT INTO users (username, email, password, role) VALUES (?, ?, ?, 'user')", [unique('simuser'), demoEmail, bcrypt.hashSync('x'.repeat(12), 4)]);
    const real = await registerAndLogin('rt_real');
    const admin = await adminToken();
    const [feed, sreal, sadmin] = await Promise.all([open(real.token), open(real.token), open(admin)]);
    const headBefore = (await realtimeEvents.bounds()).head;

    simulator.start({ intervalMs: 500, fraudRatio: 1, startedBy: 'test' });
    expect(await waitFor(() => feed.of('simulation:transaction').length >= 1, 8000)).toBe(true);
    simulator.stop();

    const ev = feed.of('simulation:transaction')[0];
    expect(ev.source).toBe('simulation');
    expect(ev.synthetic).toBe(true);
    expect(ev.id).toBeNull();                       // no replay id: never part of the durable log
    expect(ev.transaction.is_synthetic).toBe(1);
    // nothing synthetic reached the per-user / admin channels
    await sleep(300);
    for (const s of [sreal, sadmin]) {
      expect(s.received.filter((e) => ['transaction:new', 'alert:new'].includes(e.name))).toHaveLength(0);
    }
    expect((await realtimeEvents.bounds()).head).toBe(headBefore);   // nothing appended to the log
    // attributed to a demo account only, never to the real customer
    const owner = await db.get('SELECT email FROM users WHERE id = ?', [ev.transaction.user_id]);
    expect(owner.email.endsWith('@demo.fraudguard.io')).toBe(true);
    expect(await db.get('SELECT COUNT(*) AS n FROM transactions WHERE user_id = ?', [real.user.id]).then((r) => Number(r.n))).toBe(0);
  });

  test('with no demo accounts present the simulator writes nothing', async () => {
    await db.run("DELETE FROM alerts WHERE transaction_id IN (SELECT id FROM transactions WHERE is_synthetic = 1)");
    await deleteTransactions("is_synthetic = 1");
    await db.run("DELETE FROM users WHERE email LIKE '%@demo.fraudguard.io'");
    simulator.start({ intervalMs: 500, fraudRatio: 0.5, startedBy: 'test' });
    await sleep(1200);
    simulator.stop();
    expect(Number((await db.get('SELECT COUNT(*) AS n FROM transactions WHERE is_synthetic = 1')).n)).toBe(0);
  });
});

describe('heartbeat and backpressure', () => {
  test('clients receive a periodic head so a lost message is detectable, and slow consumers are dropped for replay', async () => {
    const u = await registerAndLogin('rt_hb');
    const httpServer = require('http').createServer();
    await new Promise((r) => httpServer.listen(0, '127.0.0.1', r));
    const rt = createRealtimeServer(httpServer, { redisUrl: null, heartbeatMs: 100, maxSocketBuffer: 1000 });
    const url = `http://127.0.0.1:${httpServer.address().port}`;
    const c = await open(u.token, { url });
    expect(await waitFor(() => c.of('events:head').length >= 2)).toBe(true);
    expect(typeof c.of('events:head')[0].head).toBe('number');
    await rt.close();

    // Mechanism check: a threshold below the current buffer forces the reaper to act.
    const httpServer2 = require('http').createServer();
    await new Promise((r) => httpServer2.listen(0, '127.0.0.1', r));
    const rt2 = createRealtimeServer(httpServer2, { redisUrl: null, heartbeatMs: 100, maxSocketBuffer: -1 });
    const c2 = await open(u.token, { url: `http://127.0.0.1:${httpServer2.address().port}` });
    const lagged = await waitFor(() => c2.of('events:lagged').length === 1 || !c2.socket.connected);
    expect(lagged).toBe(true);
    expect(await waitFor(() => !c2.socket.connected)).toBe(true);
    await rt2.close();
  });
});

const hasRedis = spawnSync('which', ['redis-server']).status === 0;
(hasRedis ? describe : describe.skip)('multiple backend instances sharing a Redis adapter', () => {
  let redis; let redisUrl; const rts = [];
  beforeAll(async () => {
    const port = 6400 + Math.floor(Math.random() * 500);
    redis = spawn('redis-server', ['--port', String(port), '--save', '', '--appendonly', 'no'], { stdio: 'ignore' });
    redisUrl = `redis://127.0.0.1:${port}`;
    await sleep(600);
  });
  afterAll(async () => { for (const r of rts) await r.close(); redis.kill(); });

  async function instance(url) {
    const httpServer = require('http').createServer();
    await new Promise((r) => httpServer.listen(0, '127.0.0.1', r));
    const rt = createRealtimeServer(httpServer, { redisUrl: url, heartbeatMs: 60000 });
    await rt.ready;
    rts.push(rt);
    return { rt, url: `http://127.0.0.1:${httpServer.address().port}` };
  }

  test('an event published on instance 2 reaches the owner connected to instance 1 — and still only the owner and admins', async () => {
    const a = await registerAndLogin('rt_mi_a');
    const b = await registerAndLogin('rt_mi_b');
    const admin = await adminToken();
    const [i1, i2] = [await instance(redisUrl), await instance(redisUrl)];
    expect(i1.rt.status.adapter).toBe('redis');
    const [ca, cb, cadmin] = await Promise.all([open(a.token, { url: i1.url }), open(b.token, { url: i2.url }), open(admin, { url: i2.url })]);

    i2.rt.publish([{ id: 9001, type: 'transaction:new', source: 'live', user_id: a.user.id, risk_level: 'high', transaction: { id: 1 } }]);
    expect(await waitFor(() => ca.of('transaction:new').length === 1)).toBe(true);   // crossed instances
    expect(await waitFor(() => cadmin.of('transaction:new').length === 1)).toBe(true);
    await sleep(300);
    expect(cb.of('transaction:new')).toHaveLength(0);                                // other user: nothing
  });

  test('control: without the shared adapter the same event does NOT cross instances', async () => {
    const a = await registerAndLogin('rt_ctl_a');
    const [i1, i2] = [await instance(null), await instance(null)];
    const ca = await open(a.token, { url: i1.url });
    i2.rt.publish([{ id: 9002, type: 'transaction:new', source: 'live', user_id: a.user.id, risk_level: 'low', transaction: { id: 2 } }]);
    await sleep(600);
    expect(ca.of('transaction:new')).toHaveLength(0);
  });
});
