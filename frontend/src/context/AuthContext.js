import React, { createContext, useContext, useState, useEffect, useRef } from 'react';
import axios from 'axios';

const AuthContext = createContext(null);

// /api/v1 is the versioned base all new code should target. The backend
// also keeps the old unversioned /api/* paths mounted as an alias to the
// same v1 routes, so this only matters for new clients/env overrides.
const API = process.env.REACT_APP_API_URL || 'http://localhost:5000/api/v1';

const ACCESS_TOKEN_KEY = 'fg_access_token';
const REFRESH_TOKEN_KEY = 'fg_refresh_token';
const USER_KEY = 'fg_user';

// Axios instance with auth header
export const api = axios.create({ baseURL: API });

function getAccessToken() { return localStorage.getItem(ACCESS_TOKEN_KEY); }
function getRefreshToken() { return localStorage.getItem(REFRESH_TOKEN_KEY); }

function storeSession({ accessToken, refreshToken, user }) {
  sessionExpired = false;
  localStorage.setItem(ACCESS_TOKEN_KEY, accessToken);
  localStorage.setItem(REFRESH_TOKEN_KEY, refreshToken);
  localStorage.setItem(USER_KEY, JSON.stringify(user));
}

const NOTICE_KEY = 'fg_notice';
export const SESSION_EXPIRED_EVENT = 'fg:session-expired';
let sessionExpired = false;

/**
 * End a session that can no longer be recovered. Several requests usually fail together (dashboard stats, alerts, ...), so this
 * runs ONCE: it clears the saved login and tells the app, which then routes to the sign-in page with a notice. It never forces a
 * full page reload - the old code did, once per failed request, and the burst of reloads looked like the page "blinking" and could
 * wipe what you were typing.
 */
function expireSession(notice = 'Your session expired. Please sign in again.') {
  if (sessionExpired) return;
  sessionExpired = true;
  clearSession();
  try { sessionStorage.setItem(NOTICE_KEY, notice); } catch { /* storage unavailable: the redirect still happens */ }
  window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT));
}

/** Test helper: re-arm expiry handling between tests (a real login does this via storeSession). */
export function _resetSessionStateForTests() { sessionExpired = false; }

export function takeSessionNotice() {
  try { const n = sessionStorage.getItem(NOTICE_KEY); sessionStorage.removeItem(NOTICE_KEY); return n || ''; } catch { return ''; }
}

function clearSession() {
  localStorage.removeItem(ACCESS_TOKEN_KEY);
  localStorage.removeItem(REFRESH_TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
}

api.interceptors.request.use(cfg => {
  const token = getAccessToken();
  if (token) cfg.headers.Authorization = `Bearer ${token}`;
  return cfg;
});

// Access tokens are short-lived (15m by default — see backend .env.example)
// by design, so a normal session will hit a 401 on an otherwise-valid
// request well before the user does anything wrong. Refresh once,
// transparently, and retry the original request — the user never sees
// this happen unless the refresh token itself is invalid/expired, in
// which case they're logged out. Concurrent 401s share one in-flight
// refresh call instead of each firing their own.
let refreshPromise = null;

async function refreshAccessToken() {
  if (!refreshPromise) {
    refreshPromise = axios.post(`${API}/auth/refresh`, { refreshToken: getRefreshToken() })
      .then(({ data }) => {
        storeSession(data);
        return data;
      })
      .finally(() => { refreshPromise = null; });
  }
  return refreshPromise;
}

api.interceptors.response.use(
  (res) => res,
  async (err) => {
    const { config: originalRequest, response } = err;
    const isAuthRoute = originalRequest?.url?.includes('/auth/login') || originalRequest?.url?.includes('/auth/register') || originalRequest?.url?.includes('/auth/refresh');

    if (response?.status === 401 && originalRequest && !isAuthRoute) {
      if (!originalRequest._retried && getRefreshToken()) {
        originalRequest._retried = true;
        try {
          const { accessToken } = await refreshAccessToken();
          originalRequest.headers.Authorization = `Bearer ${accessToken}`;
          return api(originalRequest);
        } catch (refreshErr) {
          expireSession();
          return Promise.reject(refreshErr);
        }
      }
      // A session existed but cannot be recovered (no refresh token, or the retried request was refused again).
      if (getAccessToken()) expireSession();
    }

    return Promise.reject(err);
  }
);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const initialized = useRef(false);

  // The interceptor ends unrecoverable sessions by dispatching this event; routing then sends the user to /login.
  useEffect(() => {
    const onExpired = () => setUser(null);
    window.addEventListener(SESSION_EXPIRED_EVENT, onExpired);
    return () => window.removeEventListener(SESSION_EXPIRED_EVENT, onExpired);
  }, []);

  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;
    const token = getAccessToken();
    const savedUser = localStorage.getItem(USER_KEY);
    if (!(token && savedUser)) { setLoading(false); return; }
    let parsed;
    try { parsed = JSON.parse(savedUser); } catch { clearSession(); setLoading(false); return; }
    // Do not trust local storage alone. A stale saved login (database reset, new JWT secret, expired refresh token) used to
    // render the dashboard first and only then discover it was invalid. Ask the server once, and show nothing until it answers.
    api.get('/auth/me', { timeout: 8000 })
      .then(({ data }) => {
        const merged = { ...parsed, ...data.user };
        localStorage.setItem(USER_KEY, JSON.stringify(merged));
        setUser(merged);
      })
      .catch((err) => {
        // 401: the interceptor already ended the session. Anything else (server down, 5xx, timeout): keep the saved login -
        // pages show their own "could not load" state, and an outage should not log everybody out.
        if (err.response?.status !== 401) setUser(parsed);
      })
      .finally(() => setLoading(false));
  }, []);

  const login = async (username, password) => {
    const { data } = await api.post('/auth/login', { username, password });
    if (data.mfaRequired) {
      // Password was correct, but this account has 2FA enabled — no
      // session yet, just a short-lived challenge token the caller
      // must complete via verifyMfaLogin() below.
      return { mfaRequired: true, mfaToken: data.mfaToken };
    }
    storeSession(data);
    setUser(data.user);
    return { mfaRequired: false, user: data.user };
  };

  const verifyMfaLogin = async (mfaToken, code) => {
    const { data } = await api.post('/auth/login/mfa', { mfaToken, code });
    storeSession(data);
    setUser(data.user);
    return data;
  };

  const register = async (username, email, password) => {
    const { data } = await api.post('/auth/register', { username, email, password });
    storeSession(data);
    setUser(data.user);
    return data.user;
  };

  const refreshUser = async () => {
    const { data } = await api.get('/auth/me');
    const updated = { ...user, ...data.user };
    localStorage.setItem(USER_KEY, JSON.stringify(updated));
    setUser(updated);
    return updated;
  };

  // Used after PATCH /auth/password: that endpoint revokes every
  // refresh token for the account (including the one already in
  // localStorage) and issues a fresh pair for *this* session — without
  // storing it, the next access-token expiry would try to refresh with
  // the now-revoked token and force an unnecessary logout.
  const applyNewTokens = ({ accessToken, refreshToken }) => {
    localStorage.setItem(ACCESS_TOKEN_KEY, accessToken);
    localStorage.setItem(REFRESH_TOKEN_KEY, refreshToken);
  };

  const logout = () => {
    const refreshToken = getRefreshToken();
    sessionExpired = false;
    clearSession();
    setUser(null);
    // Best-effort — revokes the refresh token server-side so logout
    // actually ends the session instead of just clearing local storage.
    // Fire-and-forget: the user is logged out client-side regardless of
    // whether this call succeeds.
    if (refreshToken) {
      axios.post(`${API}/auth/logout`, { refreshToken }).catch(() => {});
    }
  };

  return (
    <AuthContext.Provider value={{ user, login, verifyMfaLogin, register, logout, refreshUser, applyNewTokens, loading }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
