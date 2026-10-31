import React, { useState } from 'react';
import { useSearchParams, Link, useNavigate } from 'react-router-dom';
import { api } from '../context/AuthContext';
import { KeyRound, CheckCircle } from 'lucide-react';

/**
 * Public page reached via the link emailed by POST /auth/forgot-password
 * (routes/auth.js) — the token in the URL is itself the credential that
 * proves email ownership, so this page requires no login.
 */
export default function ResetPasswordPage() {
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token') || '';
  const navigate = useNavigate();

  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);

  const inputClass = "w-full bg-[#0a0f14] border border-white/20 rounded-lg px-4 py-2.5 text-white focus:outline-none focus:border-purple-500 transition-colors";
  const labelClass = "block text-sm text-gray-300 mb-1";

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');

    if (password !== confirmPassword) {
      setError('Passwords do not match.');
      return;
    }

    setLoading(true);
    try {
      await api.post('/auth/reset-password', { token, password });
      setDone(true);
    } catch (err) {
      const data = err.response?.data;
      setError(data?.details?.length ? data.details.map(d => d.message).join(' ') : (data?.error || 'Something went wrong'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#0a0f14] flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <div className="flex items-center justify-center gap-2 text-purple-400 mb-2">
            <KeyRound size={40} />
          </div>
          <h1 className="text-3xl font-bold text-white">Reset Password</h1>
        </div>

        <div className="bg-[#111820] border border-white/10 rounded-2xl p-8">
          {!token ? (
            <div className="bg-red-500/10 border border-red-500/30 text-red-400 rounded-lg px-4 py-3 text-sm">
              This page requires a reset link — please use the link from your password reset email, or{' '}
              <Link to="/login" className="underline">request a new one</Link>.
            </div>
          ) : done ? (
            <div>
              <div className="bg-green-500/10 border border-green-500/30 text-green-400 rounded-lg px-4 py-3 text-sm flex items-start gap-2">
                <CheckCircle size={16} className="mt-0.5 shrink-0" />
                Password reset successfully. You can now log in with your new password.
              </div>
              <button
                onClick={() => navigate('/login')}
                className="w-full bg-purple-600 hover:bg-purple-700 text-white py-3 rounded-lg font-medium transition-colors mt-4"
              >
                Go to Login
              </button>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label className={labelClass}>New password</label>
                <input
                  type="password"
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  className={inputClass}
                  placeholder="Enter new password"
                  required
                />
                <p className="text-xs text-gray-500 mt-1">
                  At least 8 characters, with an uppercase letter, a lowercase letter, a number, and a symbol.
                </p>
              </div>
              <div>
                <label className={labelClass}>Confirm new password</label>
                <input
                  type="password"
                  value={confirmPassword}
                  onChange={e => setConfirmPassword(e.target.value)}
                  className={inputClass}
                  placeholder="Confirm new password"
                  required
                />
              </div>

              {error && (
                <div className="bg-red-500/10 border border-red-500/30 text-red-400 rounded-lg px-4 py-3 text-sm">
                  {error}
                </div>
              )}

              <button
                type="submit"
                disabled={loading}
                className="w-full bg-purple-600 hover:bg-purple-700 disabled:opacity-50 text-white py-3 rounded-lg font-medium transition-colors"
              >
                {loading ? 'Resetting...' : 'Reset Password'}
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
