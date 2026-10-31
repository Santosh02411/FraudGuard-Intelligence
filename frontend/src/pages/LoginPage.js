import React, { useEffect, useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useAuth, api, takeSessionNotice } from '../context/AuthContext';
import { APP_BUILD } from '../version';
import { Shield, ShieldCheck, Eye, Zap, PlayCircle } from 'lucide-react';

const inputClass = "w-full bg-[#0a0f14] border border-white/15 rounded-lg px-4 py-2.5 text-white placeholder:text-gray-600 focus:outline-none focus:border-cyan-500/70 focus:ring-1 focus:ring-cyan-500/30 transition-colors";
const labelClass = "block text-sm text-gray-300 mb-1.5";

const FEATURES = [
  { icon: Zap, text: 'Every transaction scored in real time, before it settles' },
  { icon: Eye, text: 'Each risk score comes with a plain explanation, not a black box' },
  { icon: ShieldCheck, text: 'Medium-risk activity can be held for a second verification step' },
];

/** Left-hand brand panel — the visual identity for the whole app, not
 * just decoration on the login screen. Hidden below lg; the auth form
 * alone carries the mobile experience. */
function BrandPanel() {
  return (
    <div className="hidden lg:flex lg:w-[45%] xl:w-2/5 relative flex-col justify-between overflow-hidden bg-[#0a0f14] border-r border-white/10 px-12 py-12">
      {/* A single, quiet signal-detection motif — concentric rings
          behind the mark, one deliberate animated moment rather than
          scattered hover effects across the page. */}
      <div className="pointer-events-none absolute -left-24 top-1/2 -translate-y-1/2">
        <div className="relative w-[420px] h-[420px]">
          <div className="absolute inset-0 rounded-full border border-cyan-500/10" />
          <div className="absolute inset-[60px] rounded-full border border-cyan-500/10" />
          <div className="absolute inset-[120px] rounded-full border border-cyan-500/15" />
          <div className="absolute inset-[120px] rounded-full border border-cyan-400/20 animate-ping [animation-duration:3s]" />
        </div>
      </div>

      <div className="relative flex items-center gap-2.5">
        <Shield size={22} className="text-cyan-400" />
        <span className="text-white font-semibold tracking-tight">FraudGuard</span>
      </div>

      <div className="relative max-w-sm">
        <h1 className="text-[2.75rem] leading-[1.08] font-semibold text-white tracking-tight">
          Catch fraud<br />before it clears.
        </h1>
        <p className="text-gray-400 mt-4 leading-relaxed">
          A hybrid ML and rules engine scores every transaction the moment it happens, with
          a reason attached to every call.
        </p>
        <ul className="mt-8 space-y-4">
          {FEATURES.map(({ icon: Icon, text }) => (
            <li key={text} className="flex items-start gap-3">
              <Icon size={16} className="text-cyan-400 mt-0.5 shrink-0" />
              <span className="text-sm text-gray-400 leading-snug">{text}</span>
            </li>
          ))}
        </ul>
      </div>

      <p className="relative text-xs text-gray-600">Fraud detection, transparently explained.</p>
    </div>
  );
}

export default function LoginPage() {
  const [mode, setMode] = useState('login'); // 'login' | 'register' | 'forgot'
  const [form, setForm] = useState({ username: '', email: '', password: '' });
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);
  const [notice] = useState(() => takeSessionNotice());          // e.g. "Your session expired" after an automatic sign-out
  const [backend, setBackend] = useState('checking');             // 'checking' | 'up' | 'down'
  const apiBase = api?.defaults?.baseURL || '';

  // Tell the user up front whether the API is reachable: "couldn't sign in" is very often just "the backend isn't running".
  useEffect(() => {
    let cancelled = false;
    Promise.resolve()
      .then(() => api.get('/health', { timeout: 5000 }))
      .then(() => { if (!cancelled) setBackend('up'); })
      .catch(() => { if (!cancelled) setBackend('down'); });
    return () => { cancelled = true; };
  }, []);

  // MFA challenge step — set once POST /login responds with
  // mfaRequired: true, instead of tokens directly.
  const [mfaToken, setMfaToken] = useState(null);
  const [mfaCode, setMfaCode] = useState('');

  const { login, verifyMfaLogin, register } = useAuth();
  const navigate = useNavigate();

  const describeError = (err, fallback) => {
    if (!err.response) {
      // No HTTP response at all: the request never reached the backend (not running, wrong port, blocked by CORS, offline).
      return `Cannot reach the server${apiBase ? ` at ${apiBase.replace(/\/api(\/v1)?\/?$/, '')}` : ''}. Make sure the backend is running (in the backend folder: npm start), then try again.`;
    }
    const data = err.response?.data;
    if (data?.details?.length) {
      // Zod validation errors (e.g. password strength) — show every
      // rule that failed, not just a generic "Validation failed".
      return data.details.map(d => d.message).join(' ');
    }
    return data?.error || fallback;
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setMessage('');
    setLoading(true);
    try {
      if (mode === 'login') {
        const result = await login(form.username, form.password);
        if (result.mfaRequired) {
          setMfaToken(result.mfaToken);
        } else {
          navigate('/dashboard');
        }
      } else if (mode === 'register') {
        await register(form.username, form.email, form.password);
        navigate('/dashboard');
      } else if (mode === 'forgot') {
        const { data } = await api.post('/auth/forgot-password', { email: form.email });
        setMessage(data.message);
      }
    } catch (err) {
      setError(describeError(err, 'Something went wrong'));
    } finally {
      setLoading(false);
    }
  };

  const handleMfaSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await verifyMfaLogin(mfaToken, mfaCode);
      navigate('/dashboard');
    } catch (err) {
      setError(describeError(err, 'Invalid code'));
    } finally {
      setLoading(false);
    }
  };

  if (mfaToken) {
    return (
      <div className="min-h-screen bg-[#0a0f14] flex">
        <BrandPanel />
        <div className="flex-1 flex items-center justify-center p-4">
          <div className="w-full max-w-md">
            <div className="text-center mb-8 lg:hidden">
              <div className="flex items-center justify-center gap-2 text-cyan-400 mb-2">
                <Shield size={32} />
              </div>
              <h1 className="text-2xl font-semibold text-white tracking-tight">FraudGuard</h1>
            </div>

            <div className="text-center mb-8">
              <div className="hidden lg:flex items-center justify-center gap-2 text-cyan-400 mb-3">
                <ShieldCheck size={36} />
              </div>
              <h2 className="text-2xl font-semibold text-white tracking-tight">Two-Factor Verification</h2>
              <p className="text-gray-400 mt-1.5 text-sm">Enter the 6-digit code from your authenticator app</p>
            </div>

            <div className="bg-[#111820] border border-white/10 rounded-2xl p-8 shadow-[0_1px_0_rgba(255,255,255,0.04)_inset]">
              <form onSubmit={handleMfaSubmit} className="space-y-4">
                <div>
                  <label className={labelClass}>Authentication code</label>
                  <input
                    type="text"
                    inputMode="numeric"
                    value={mfaCode}
                    onChange={e => setMfaCode(e.target.value.trim())}
                    className={`${inputClass} text-center text-xl tracking-[0.3em] font-mono`}
                    placeholder="123456"
                    maxLength={11}
                    autoFocus
                    required
                  />
                  <p className="text-xs text-gray-500 mt-1.5">Lost your device? You can also enter one of your backup codes.</p>
                </div>

                {error && (
                  <div className="bg-red-500/10 border border-red-500/30 text-red-400 rounded-lg px-4 py-3 text-sm">
                    {error}
                  </div>
                )}

                <button
                  type="submit"
                  disabled={loading}
                  className="w-full bg-cyan-600 hover:bg-cyan-500 disabled:opacity-50 text-white py-3 rounded-lg font-medium transition-colors"
                >
                  {loading ? 'Verifying...' : 'Verify'}
                </button>
                <button
                  type="button"
                  onClick={() => { setMfaToken(null); setMfaCode(''); setError(''); }}
                  className="w-full text-gray-400 hover:text-white text-sm py-1 transition-colors"
                >
                  Back to login
                </button>
              </form>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#0a0f14] flex">
      <BrandPanel />
      <div className="flex-1 flex items-center justify-center p-4">
        <div className="w-full max-w-md">
          <div className="text-center mb-8">
            <div className="flex items-center justify-center gap-2 text-cyan-400 mb-2">
              <Shield size={36} />
            </div>
            <h1 className="text-2xl lg:hidden font-semibold text-white tracking-tight">FraudGuard</h1>
            <h2 className="text-lg font-medium text-gray-300 mt-1">
              {mode === 'login' ? 'Sign in to your account' : mode === 'register' ? 'Create your account' : 'Reset your password'}
            </h2>
          </div>

          <div className="bg-[#111820] border border-white/10 rounded-2xl p-8 shadow-[0_1px_0_rgba(255,255,255,0.04)_inset]">
            {notice && (
              <div role="status" data-testid="session-notice" className="mb-4 bg-amber-500/10 border border-amber-500/30 text-amber-200 rounded-lg px-4 py-3 text-sm">{notice}</div>
            )}
            {mode !== 'forgot' && (
              <div className="flex gap-1 mb-6 bg-[#0a0f14] rounded-lg p-1">
                {['login', 'register'].map(m => (
                  <button
                    key={m}
                    onClick={() => { setMode(m); setError(''); setMessage(''); }}
                    className={`flex-1 py-2 rounded-md text-sm font-medium transition-colors capitalize ${
                      mode === m ? 'bg-cyan-600 text-white' : 'text-gray-400 hover:text-white'
                    }`}
                  >
                    {m}
                  </button>
                ))}
              </div>
            )}

            {mode === 'forgot' && (
              <div className="mb-6">
                <p className="text-gray-400 text-sm">Enter your account email and we'll send you a reset link.</p>
              </div>
            )}

            {message ? (
              <div className="bg-green-500/10 border border-green-500/30 text-green-400 rounded-lg px-4 py-3 text-sm">
                {message}
              </div>
            ) : (
              <form onSubmit={handleSubmit} className="space-y-4">
                {mode !== 'forgot' && (
                  <div>
                    <label className={labelClass}>Username</label>
                    <input
                      type="text"
                      value={form.username}
                      onChange={e => setForm({ ...form, username: e.target.value })}
                      className={inputClass}
                      placeholder="Enter username"
                      required
                    />
                  </div>
                )}

                {(mode === 'register' || mode === 'forgot') && (
                  <div>
                    <label className={labelClass}>Email</label>
                    <input
                      type="email"
                      value={form.email}
                      onChange={e => setForm({ ...form, email: e.target.value })}
                      className={inputClass}
                      placeholder="Enter email"
                      required
                    />
                  </div>
                )}

                {mode !== 'forgot' && (
                  <div>
                    <div className="flex items-center justify-between">
                      <label className={labelClass}>Password</label>
                      {mode === 'login' && (
                        <button
                          type="button"
                          onClick={() => { setMode('forgot'); setError(''); setMessage(''); }}
                          className="text-xs text-cyan-400 hover:text-cyan-300 mb-1.5 transition-colors"
                        >
                          Forgot password?
                        </button>
                      )}
                    </div>
                    <input
                      type="password"
                      value={form.password}
                      onChange={e => setForm({ ...form, password: e.target.value })}
                      className={inputClass}
                      placeholder="Enter password"
                      required
                    />
                    {mode === 'register' && (
                      <p className="text-xs text-gray-500 mt-1.5">
                        At least 8 characters, with an uppercase letter, a lowercase letter, a number, and a symbol.
                      </p>
                    )}
                  </div>
                )}

                {error && (
                  <div className="bg-red-500/10 border border-red-500/30 text-red-400 rounded-lg px-4 py-3 text-sm">
                    {error}
                  </div>
                )}

                <button
                  type="submit"
                  disabled={loading}
                  className="w-full bg-cyan-600 hover:bg-cyan-500 disabled:opacity-50 text-white py-3 rounded-lg font-medium transition-colors"
                >
                  {loading ? 'Please wait...' : mode === 'login' ? 'Sign In' : mode === 'register' ? 'Create Account' : 'Send Reset Link'}
                </button>

                {mode === 'forgot' && (
                  <button
                    type="button"
                    onClick={() => { setMode('login'); setError(''); setMessage(''); }}
                    className="w-full text-gray-400 hover:text-white text-sm py-1 transition-colors"
                  >
                    Back to login
                  </button>
                )}
              </form>
            )}

            {mode === 'forgot' && message && (
              <button
                onClick={() => { setMode('login'); setMessage(''); }}
                className="w-full text-gray-400 hover:text-white text-sm py-1 mt-4 transition-colors"
              >
                Back to login
              </button>
            )}

            {mode !== 'forgot' && (
              <div className="mt-5">
                <div className="flex items-center gap-3 text-xs text-gray-500 mb-3"><span className="flex-1 h-px bg-white/10" />or<span className="flex-1 h-px bg-white/10" /></div>
                {/* A plain link, not a router <Link>: the demo is a separate static page (public/demo/) that runs entirely
                    in the browser on pre-loaded sample data, so nothing here touches the real database. */}
                <a
                  href={`${process.env.PUBLIC_URL || ''}/demo/`}
                  data-testid="try-demo"
                  className="flex items-center justify-center gap-2 w-full border border-cyan-500/40 text-cyan-300 hover:bg-cyan-500/10 py-3 rounded-lg font-medium transition-colors"
                >
                  <PlayCircle size={18} /> Try demo
                </a>
                <p className="text-center text-gray-500 text-xs mt-2">Explore every screen with pre-loaded sample data. No account needed; nothing is saved.</p>
              </div>
            )}

            {mode === 'login' && (
              <div className="mt-4 p-3 bg-white/5 rounded-lg text-xs text-gray-400">
                <strong className="text-gray-300">Default admin:</strong> username: <code className="text-cyan-300 font-mono">admin</code> / password: <code className="text-cyan-300 font-mono">admin123</code>
              </div>
            )}
          </div>

          <p className="text-center text-gray-500 text-xs mt-4">
            Verifying your email? <Link to="/verify-email" className="text-cyan-400 hover:text-cyan-300 transition-colors">Enter your verification link here</Link>
          </p>
          <div className="text-center text-xs mt-3" data-testid="backend-status" role="status">
            {backend === 'up' && <span className="text-green-400"><span className="inline-block w-1.5 h-1.5 rounded-full bg-green-400 mr-1.5 align-middle" />Backend connected</span>}
            {backend === 'checking' && <span className="text-gray-500">Checking the backend…</span>}
            {backend === 'down' && (
              <span className="text-red-300">
                <span className="inline-block w-1.5 h-1.5 rounded-full bg-red-400 mr-1.5 align-middle" />
                Backend not reachable{apiBase ? ` at ${apiBase.replace(/\/api(\/v1)?\/?$/, '')}` : ''}. Start it: open the <code className="font-mono">backend</code> folder and run <code className="font-mono">npm start</code>.
              </span>
            )}
          </div>
          <p className="text-center text-gray-600 text-[11px] mt-2" data-testid="app-build">FraudGuard build {APP_BUILD}</p>
        </div>
      </div>
    </div>
  );
}
