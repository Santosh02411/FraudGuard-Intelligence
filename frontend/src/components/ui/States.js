import React from 'react';
import { AlertCircle, RefreshCw, Inbox } from 'lucide-react';

/**
 * Full-panel loading state. Use inside a card/table container instead of
 * a bare "Loading..." string so every page gets the same look.
 */
export function LoadingState({ label = 'Loading...', rows }) {
  if (rows) {
    // Skeleton rows for table-shaped content — avoids a layout jump when
    // real data arrives.
    return (
      <div className="p-6 space-y-3 animate-pulse">
        {Array.from({ length: rows }).map((_, i) => (
          <div key={i} className="h-10 bg-white/5 rounded-lg" style={{ animationDelay: `${i * 40}ms` }} />
        ))}
      </div>
    );
  }
  return (
    <div className="flex flex-col items-center justify-center gap-3 p-12 text-gray-400 animate-page-in">
      <RefreshCw size={22} className="animate-spin text-purple-400" />
      <p className="text-sm">{label}</p>
    </div>
  );
}

/**
 * Error state with an optional retry action. Distinct from EmptyState so
 * "nothing here yet" and "something went wrong fetching this" never look
 * the same to the user.
 */
export function ErrorState({ message = 'Something went wrong.', onRetry }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 p-12 text-center animate-page-in">
      <div className="w-12 h-12 rounded-full bg-red-500/10 flex items-center justify-center">
        <AlertCircle size={22} className="text-red-400" />
      </div>
      <div>
        <p className="text-red-400 text-sm font-medium">{message}</p>
        <p className="text-gray-500 text-xs mt-1">Please try again, or refresh the page.</p>
      </div>
      {onRetry && (
        <button
          onClick={onRetry}
          className="group flex items-center gap-2 bg-white/5 hover:bg-white/10 text-gray-200 px-4 py-2 rounded-lg text-sm transition-colors mt-1"
        >
          <RefreshCw size={14} className="transition-transform duration-500 group-hover:rotate-180" /> Retry
        </button>
      )}
    </div>
  );
}

/**
 * Empty state for a successful fetch that returned nothing.
 */
export function EmptyState({ icon: Icon = Inbox, title = 'Nothing here yet', subtitle }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 p-12 text-center text-gray-500 animate-page-in">
      <Icon size={36} className="opacity-30 mb-1" />
      <p>{title}</p>
      {subtitle && <p className="text-xs text-gray-600">{subtitle}</p>}
    </div>
  );
}
