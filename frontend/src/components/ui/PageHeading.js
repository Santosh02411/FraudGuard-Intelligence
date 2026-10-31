import React from 'react';

export default function PageHeading({ icon: Icon, title, subtitle, subtitleClassName }) {
  return (
    <div>
      <h1 className="text-2xl sm:text-3xl font-bold text-white tracking-tight flex items-center gap-2.5">
        <span className="flex items-center justify-center w-9 h-9 rounded-lg bg-cyan-500/10 border border-cyan-500/20 shrink-0">
          <Icon size={18} className="text-cyan-400" />
        </span>
        {title}
      </h1>
      {subtitle && <p className={subtitleClassName || 'text-gray-400 mt-1'}>{subtitle}</p>}
    </div>
  );
}
