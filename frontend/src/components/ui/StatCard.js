import React from 'react';

/** Stat tile: label, big value, optional hint line (text or a link) and a dim icon - same look as the interactive demo. */
export default function StatCard({ title, value, icon: Icon, color, hint }) {
  return (
    <div className="bg-[#111820] border border-white/10 rounded-xl p-4 sm:p-5 flex items-start justify-between gap-3">
      <div className="min-w-0">
        <p className="text-gray-400 text-xs sm:text-sm mb-1">{title}</p>
        <p className={`text-xl sm:text-[28px] leading-tight font-bold tabular-nums ${color || 'text-white'}`}>{value}</p>
        {hint ? <div className="text-xs text-gray-500 mt-1.5">{hint}</div> : null}
      </div>
      {Icon && (
        <span className={`shrink-0 mt-0.5 opacity-60 ${color || 'text-gray-500'}`}>
          <Icon size={18} />
        </span>
      )}
    </div>
  );
}
