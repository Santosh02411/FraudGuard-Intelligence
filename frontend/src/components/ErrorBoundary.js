import React from 'react';
import { ShieldAlert, RefreshCw } from 'lucide-react';

/**
 * Catches render/lifecycle errors anywhere below it in the tree. Without
 * this, a single bad page (e.g. a malformed API response) whitescreens
 * the entire app instead of failing gracefully.
 *
 * Resets automatically when the route changes (see `resetKey`), so
 * navigating away from the broken page recovers without a full reload.
 */
export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, info) {
    // eslint-disable-next-line no-console
    console.error('FraudGuard UI crashed:', error, info);
  }

  componentDidUpdate(prevProps) {
    if (this.state.hasError && prevProps.resetKey !== this.props.resetKey) {
      this.setState({ hasError: false, error: null });
    }
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-[60vh] flex items-center justify-center p-8">
          <div className="max-w-md w-full bg-[#111820] border border-red-500/30 rounded-xl p-8 text-center">
            <div className="w-14 h-14 mx-auto rounded-full bg-red-500/10 flex items-center justify-center mb-4">
              <ShieldAlert size={26} className="text-red-400" />
            </div>
            <h2 className="text-lg font-semibold text-white mb-1">Something went wrong</h2>
            <p className="text-gray-400 text-sm mb-6">
              This page hit an unexpected error. You can try reloading, or head back to the dashboard.
            </p>
            <div className="flex items-center justify-center gap-3">
              <button
                onClick={() => window.location.reload()}
                className="flex items-center gap-2 bg-purple-600 hover:bg-purple-700 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors"
              >
                <RefreshCw size={14} /> Reload
              </button>
              <a
                href="/dashboard"
                className="bg-white/5 hover:bg-white/10 text-gray-200 px-4 py-2 rounded-lg text-sm transition-colors"
              >
                Go to Dashboard
              </a>
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
