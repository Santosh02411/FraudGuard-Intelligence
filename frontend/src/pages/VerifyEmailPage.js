import React, { useState, useEffect, useCallback } from 'react';
import { useSearchParams, Link } from 'react-router-dom';
import { api } from '../context/AuthContext';
import { MailCheck, CheckCircle, XCircle } from 'lucide-react';

/**
 * Public page reached via the link emailed by POST /auth/register or
 * POST /auth/resend-verification (routes/auth.js). Also accepts a
 * manually-pasted token, since a link opened in a different browser
 * than the one the person is logged in on is a real case (email client
 * default browser vs. the app's browser).
 */
export default function VerifyEmailPage() {
  const [searchParams] = useSearchParams();
  const tokenFromUrl = searchParams.get('token') || '';

  const [manualToken, setManualToken] = useState('');
  const [status, setStatus] = useState(tokenFromUrl ? 'verifying' : 'idle'); // idle | verifying | success | error
  const [error, setError] = useState('');

  const verify = useCallback((token) => {
    setStatus('verifying');
    setError('');
    api.post('/auth/verify-email', { token })
      .then(() => setStatus('success'))
      .catch((err) => {
        setStatus('error');
        setError(err.response?.data?.error || 'This verification link is invalid or has expired.');
      });
  }, []);

  useEffect(() => {
    if (tokenFromUrl) verify(tokenFromUrl);
  }, [tokenFromUrl, verify]);

  const handleManualSubmit = (e) => {
    e.preventDefault();
    verify(manualToken.trim());
  };

  const inputClass = "w-full bg-[#0a0f14] border border-white/20 rounded-lg px-4 py-2.5 text-white focus:outline-none focus:border-purple-500 transition-colors";

  return (
    <div className="min-h-screen bg-[#0a0f14] flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <div className="flex items-center justify-center gap-2 text-purple-400 mb-2">
            <MailCheck size={40} />
          </div>
          <h1 className="text-3xl font-bold text-white">Verify Email</h1>
        </div>

        <div className="bg-[#111820] border border-white/10 rounded-2xl p-8">
          {status === 'verifying' && (
            <p className="text-gray-400 text-sm text-center">Verifying...</p>
          )}

          {status === 'success' && (
            <div>
              <div className="bg-green-500/10 border border-green-500/30 text-green-400 rounded-lg px-4 py-3 text-sm flex items-start gap-2">
                <CheckCircle size={16} className="mt-0.5 shrink-0" />
                Your email has been verified.
              </div>
              <Link
                to="/dashboard"
                className="w-full block text-center bg-purple-600 hover:bg-purple-700 text-white py-3 rounded-lg font-medium transition-colors mt-4"
              >
                Go to Dashboard
              </Link>
            </div>
          )}

          {(status === 'idle' || status === 'error') && (
            <>
              {status === 'error' && (
                <div className="bg-red-500/10 border border-red-500/30 text-red-400 rounded-lg px-4 py-3 text-sm flex items-start gap-2 mb-4">
                  <XCircle size={16} className="mt-0.5 shrink-0" />
                  {error}
                </div>
              )}
              <form onSubmit={handleManualSubmit} className="space-y-4">
                <div>
                  <label className="block text-sm text-gray-300 mb-1">Verification token</label>
                  <input
                    type="text"
                    value={manualToken}
                    onChange={e => setManualToken(e.target.value)}
                    className={inputClass}
                    placeholder="Paste your verification token"
                    required
                  />
                  <p className="text-xs text-gray-500 mt-1">
                    Use the link from your verification email, or paste the token from it here.
                  </p>
                </div>
                <button
                  type="submit"
                  className="w-full bg-purple-600 hover:bg-purple-700 text-white py-3 rounded-lg font-medium transition-colors"
                >
                  Verify
                </button>
              </form>
            </>
          )}
        </div>

        <p className="text-center text-gray-500 text-xs mt-4">
          <Link to="/login" className="text-purple-400 hover:text-purple-300 transition-colors">Back to login</Link>
        </p>
      </div>
    </div>
  );
}
