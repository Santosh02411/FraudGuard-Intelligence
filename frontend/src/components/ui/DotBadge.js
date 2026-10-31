import React from 'react';

export default function DotBadge({ label, colorClass, dotClass, uppercase = true }) {
  return (
    <span className={`inline-flex items-center gap-1.5 text-[10px] font-semibold px-2 py-0.5 rounded-full ${uppercase ? 'uppercase' : ''} ${colorClass}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${dotClass}`} />
      {label}
    </span>
  );
}
