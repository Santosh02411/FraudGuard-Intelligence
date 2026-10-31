/**
 * Session handling. The scenario behind the "page keeps blinking / can't sign in" report: the browser still holds a saved login that the
 * server no longer accepts (database reset, new JWT secret, expired refresh token). Several requests then fail at once. The old code hard-
 * reloaded the page once per failed request; now the app ends the session ONCE, routes to /login with a notice, and never reloads.
 */
import React from 'react';
import axios, { AxiosError } from 'axios';
import { render, waitFor, act } from '@testing-library/react';
import { AuthProvider, useAuth, api, takeSessionNotice, SESSION_EXPIRED_EVENT, _resetSessionStateForTests } from './AuthContext';

let auth; let calls; let handler; let expiredEvents; let consoleError; let onExpired;
function Probe() { auth = useAuth(); return <div data-testid="probe">{auth.loading ? 'loading' : auth.user ? `user:${auth.user.username}:${auth.user.role}` : 'anonymous'}</div>; }

const ok = (config, data, status = 200) => ({ data, status, statusText: 'OK', headers: {}, config });
const fail = (config, status, data = {}) => { throw new AxiosError(`HTTP ${status}`, 'ERR_BAD_REQUEST', config, null, { data, status, statusText: '', headers: {}, config }); };
const networkDown = (config) => { throw new AxiosError('Network Error', 'ERR_NETWORK', config); };
const adapter = async (config) => { calls.push(`${String(config.method).toUpperCase()} ${String(config.url).replace(/^https?:\/\/[^/]+\/api\/v1/, '')}`); return handler(config); };
const count = (needle) => calls.filter((c) => c.includes(needle)).length;

function seedSession({ access = 'old-access', refresh = 'old-refresh', user = { id: 1, username: 'admin', role: 'user' } } = {}) {
  if (access) localStorage.setItem('fg_access_token', access); if (refresh) localStorage.setItem('fg_refresh_token', refresh); if (user) localStorage.setItem('fg_user', JSON.stringify(user));
}
const mount = () => render(<AuthProvider><Probe /></AuthProvider>);
const settled = (container) => waitFor(() => expect(container.querySelector('[data-testid="probe"]').textContent).not.toBe('loading'));

beforeEach(() => {
  localStorage.clear(); sessionStorage.clear(); calls = []; expiredEvents = 0; _resetSessionStateForTests();
  api.defaults.adapter = adapter; axios.defaults.adapter = adapter;
  onExpired = () => { expiredEvents += 1; };
  window.addEventListener(SESSION_EXPIRED_EVENT, onExpired);
  consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { consoleError.mockRestore(); window.removeEventListener(SESSION_EXPIRED_EVENT, onExpired); });
const navigationAttempts = () => consoleError.mock.calls.filter((c) => /not implemented: navigation/i.test(String(c[0]?.message || c[0]))).length;

describe('stale saved login (the blinking scenario)', () => {
  test('the server rejects it: signed out once, notice shown once, storage cleared, and the page is NEVER reloaded', async () => {
    seedSession(); handler = (c) => fail(c, 401);
    const { container } = mount();
    await settled(container);
    expect(container.textContent).toBe('anonymous');
    expect(localStorage.getItem('fg_access_token')).toBeNull(); expect(localStorage.getItem('fg_refresh_token')).toBeNull(); expect(localStorage.getItem('fg_user')).toBeNull();
    expect(navigationAttempts()).toBe(0);
    expect(count('/auth/me')).toBe(1); expect(count('/auth/refresh')).toBe(1);        // verified once, refreshed once - no storm
    expect(takeSessionNotice()).toMatch(/session expired/i); expect(takeSessionNotice()).toBe('');
  });

  test('nothing is rendered as logged-in while the saved session is being verified', async () => {
    seedSession(); let release; handler = (c) => new Promise((res) => { release = () => res(ok(c, { user: { id: 1, username: 'admin', role: 'admin' } })); });
    const { container } = mount();
    expect(container.textContent).toBe('loading');                                       // not the dashboard, not the login form
    await waitFor(() => expect(release).toBeDefined());
    await act(async () => { release(); });
    await settled(container);
    expect(container.textContent).toBe('user:admin:admin');
  });

  test('several requests failing at once end the session exactly once', async () => {
    seedSession(); handler = (c) => (String(c.url).includes('/auth/me') ? ok(c, { user: { id: 1, username: 'admin', role: 'admin' } }) : fail(c, 401));
    const { container } = mount(); await settled(container);
    expect(container.textContent).toBe('user:admin:admin'); calls = []; expiredEvents = 0;
    const results = await Promise.allSettled([1, 2, 3, 4, 5].map((n) => api.get(`/transactions?n=${n}`)));
    expect(results.every((r) => r.status === 'rejected')).toBe(true);
    await waitFor(() => expect(container.textContent).toBe('anonymous'));
    expect(expiredEvents).toBe(1); expect(count('/auth/refresh')).toBe(1);             // one shared refresh, one sign-out
    expect(navigationAttempts()).toBe(0);
  });

  test('a 401 with no refresh token at all also ends the session once, without a reload', async () => {
    seedSession({ refresh: null }); handler = (c) => (String(c.url).includes('/auth/me') ? ok(c, { user: { id: 1, username: 'admin', role: 'user' } }) : fail(c, 401));
    const { container } = mount(); await settled(container); expiredEvents = 0;
    await Promise.allSettled([api.get('/a'), api.get('/b'), api.get('/c')]);
    await waitFor(() => expect(container.textContent).toBe('anonymous'));
    expect(expiredEvents).toBe(1); expect(navigationAttempts()).toBe(0); expect(count('/auth/refresh')).toBe(0);
  });
});

describe('healthy and degraded cases keep working', () => {
  test('a valid saved session is verified and picks up server-side changes (e.g. a role change)', async () => {
    seedSession(); handler = (c) => ok(c, { user: { id: 1, username: 'admin', role: 'admin' } });
    const { container } = mount(); await settled(container);
    expect(container.textContent).toBe('user:admin:admin');
    expect(JSON.parse(localStorage.getItem('fg_user')).role).toBe('admin');
    expect(expiredEvents).toBe(0);
  });

  test('server unreachable on startup: the saved login is kept (an outage must not sign everyone out)', async () => {
    seedSession(); handler = (c) => networkDown(c);
    const { container } = mount(); await settled(container);
    expect(container.textContent).toBe('user:admin:user'); expect(localStorage.getItem('fg_access_token')).toBe('old-access'); expect(expiredEvents).toBe(0);
  });

  test('server error (500) on startup keeps the saved login too', async () => {
    seedSession(); handler = (c) => fail(c, 500);
    const { container } = mount(); await settled(container);
    expect(container.textContent).toBe('user:admin:user'); expect(expiredEvents).toBe(0);
  });

  test('an ordinary expired access token is refreshed silently and the request is retried', async () => {
    seedSession(); let first = true;
    handler = (c) => {
      const url = String(c.url);
      if (url.includes('/auth/me')) return ok(c, { user: { id: 1, username: 'admin', role: 'user' } });
      if (url.includes('/auth/refresh')) return ok(c, { accessToken: 'new-access', refreshToken: 'new-refresh', user: { id: 1, username: 'admin', role: 'user' } });
      if (first) { first = false; return fail(c, 401); }
      return ok(c, { transactions: [] });
    };
    const { container } = mount(); await settled(container);
    const res = await api.get('/transactions');
    expect(res.data).toEqual({ transactions: [] });
    expect(localStorage.getItem('fg_access_token')).toBe('new-access'); expect(container.textContent).toBe('user:admin:user'); expect(expiredEvents).toBe(0);
  });

  test('no saved login: straight to anonymous with no API call', async () => {
    handler = (c) => ok(c, {});
    const { container } = mount(); await settled(container);
    expect(container.textContent).toBe('anonymous'); expect(calls).toEqual([]);
  });

  test('corrupt saved user data is discarded instead of crashing', async () => {
    localStorage.setItem('fg_access_token', 'x'); localStorage.setItem('fg_user', '{not json'); handler = (c) => ok(c, {});
    const { container } = mount(); await settled(container);
    expect(container.textContent).toBe('anonymous'); expect(localStorage.getItem('fg_user')).toBeNull();
  });
});

describe('signing in', () => {
  test('a wrong password does not touch the session or show an "expired" notice', async () => {
    handler = (c) => fail(c, 401, { error: 'Invalid credentials' });
    const { container } = mount(); await settled(container);
    await expect(auth.login('admin', 'nope')).rejects.toBeTruthy();
    expect(expiredEvents).toBe(0); expect(takeSessionNotice()).toBe(''); expect(container.textContent).toBe('anonymous');
  });

  test('after an expiry, a fresh sign-in works and a later expiry is handled again', async () => {
    seedSession(); handler = (c) => fail(c, 401);
    const { container } = mount(); await settled(container); expect(expiredEvents).toBe(1);
    handler = (c) => (String(c.url).includes('/auth/login') ? ok(c, { accessToken: 'a2', refreshToken: 'r2', user: { id: 1, username: 'admin', role: 'admin' } }) : fail(c, 401));
    await act(async () => { await auth.login('admin', 'admin123'); });
    expect(container.textContent).toBe('user:admin:admin');
    await Promise.allSettled([api.get('/x')]);
    await waitFor(() => expect(container.textContent).toBe('anonymous'));
    expect(expiredEvents).toBe(2);
  });

  test('logout clears the saved login and revokes the refresh token server-side (best effort)', async () => {
    seedSession(); handler = (c) => ok(c, { user: { id: 1, username: 'admin', role: 'user' } });
    const { container } = mount(); await settled(container); calls = [];
    act(() => auth.logout());
    expect(container.textContent).toBe('anonymous'); expect(localStorage.getItem('fg_access_token')).toBeNull();
    await waitFor(() => expect(count('/auth/logout')).toBe(1));
  });
});
