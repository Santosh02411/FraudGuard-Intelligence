/**
 * Helpers for tests that need REAL concurrency: the app is served on a real
 * TCP port and hit with genuinely simultaneous HTTP requests (separate
 * sockets, all in flight at once) rather than awaited one after another.
 * Run on SQLite by default; `npm run test:postgres` runs the same files
 * against a real PostgreSQL (multiple pooled connections, true parallel
 * database sessions).
 */
const http = require('http');
const app = require('../../app');
const { initSchema } = require('../../config/schema');

const API = '/api/v1';
let server;
let base;

async function start() {
  await initSchema();
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  return { server, base };
}

async function stop() {
  if (server) await new Promise((resolve) => server.close(resolve));
  await require('../../config/database').close(); // release the pg pool so Jest can exit
}

async function call(method, path, { token, body, headers = {} } = {}) {
  const res = await fetch(`${base}${API}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch (_) { /* no body */ }
  return { status: res.status, body: json, headers: res.headers };
}

const unique = (prefix) => `${prefix}_${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;

async function registerAndLogin(prefix = 'cc') {
  const username = unique(prefix);
  const password = 'Str0ng!Passw0rd1';
  await call('POST', '/auth/register', { body: { username, email: `${username}@example.com`, password } });
  const login = await call('POST', '/auth/login', { body: { username, password } });
  return { username, token: login.body.accessToken, user: login.body.user };
}

async function adminToken() {
  const login = await call('POST', '/auth/login', { body: { username: 'admin', password: 'admin123' } });
  return login.body.accessToken;
}

/** A second admin, so "two investigators" are genuinely different people. */
async function secondAdmin() {
  const { username, token } = await registerAndLogin('cc_admin');
  const db = require('../../config/database');
  await db.run("UPDATE users SET role = 'admin' WHERE username = ?", [username]);
  const login = await call('POST', '/auth/login', { body: { username, password: 'Str0ng!Passw0rd1' } });
  return { username, token: login.body.accessToken || token };
}

// Medium risk under the rule-engine fallback (ml_service is unreachable in
// tests): over $1,500 (+20) plus a high-risk category (+25) => flagged, so
// an alert is created. Distinct UA/IP per call keeps accounts independent.
const FLAGGED_TXN = { amount: 2000, merchant: 'Bet365', category: 'gambling', location: 'New York, US', card_type: 'credit' };
const SAFE_TXN = { amount: 12.5, merchant: 'Starbucks', category: 'food', location: 'New York, US', card_type: 'credit' };

let ipCounter = 10;
function identity() {
  ipCounter += 1;
  return { 'User-Agent': `cc-ua-${ipCounter}-${Math.random()}`, 'X-Forwarded-For': `198.51.100.${ipCounter % 250}` };
}

module.exports = { API, start, stop, call, registerAndLogin, adminToken, secondAdmin, unique, identity, FLAGGED_TXN, SAFE_TXN };
