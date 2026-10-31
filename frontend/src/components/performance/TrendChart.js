import React from 'react';

const W = 640; const H = 180; const PAD = { l: 36, r: 12, t: 12, b: 24 };

/** Small dependency-free line chart: values are 0..1 rates, null = no data (a gap, never a zero). */
export default function TrendChart({ points, series }) {
  const xs = points.map((_, i) => PAD.l + (points.length < 2 ? (W - PAD.l - PAD.r) / 2 : (i * (W - PAD.l - PAD.r)) / (points.length - 1)));
  const y = (v) => PAD.t + (1 - v) * (H - PAD.t - PAD.b);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Weekly precision and recall trend" className="w-full">
      {[0, 0.25, 0.5, 0.75, 1].map((g) => (
        <g key={g}>
          <line x1={PAD.l} x2={W - PAD.r} y1={y(g)} y2={y(g)} stroke="#ffffff14" />
          <text x={PAD.l - 6} y={y(g) + 3} textAnchor="end" fontSize="9" fill="#9ca3af">{Math.round(g * 100)}%</text>
        </g>
      ))}
      {points.map((p, i) => (i % Math.ceil(points.length / 8) === 0 ? <text key={p.week} x={xs[i]} y={H - 8} textAnchor="middle" fontSize="9" fill="#9ca3af">{p.week.slice(5)}</text> : null))}
      {series.map((s) => {
        const segs = []; let cur = [];
        points.forEach((p, i) => { const v = p[s.key]; if (v === null || v === undefined) { if (cur.length) segs.push(cur); cur = []; } else cur.push([xs[i], y(v)]); });
        if (cur.length) segs.push(cur);
        return (
          <g key={s.key} data-testid={`series-${s.key}`}>
            {segs.map((seg, i) => <polyline key={i} points={seg.map((q) => q.join(',')).join(' ')} fill="none" stroke={s.color} strokeWidth="2" />)}
            {points.map((p, i) => (p[s.key] === null || p[s.key] === undefined ? null : (
              <circle key={p.week} cx={xs[i]} cy={y(p[s.key])} r={p.low_sample ? 2.5 : 3.5} fill={p.low_sample ? 'none' : s.color} stroke={s.color}>
                <title>{`${p.week} ${s.label}: ${(p[s.key] * 100).toFixed(1)}% (${p.reviewed} reviewed${p.low_sample ? ', low sample' : ''})`}</title>
              </circle>
            )))}
          </g>
        );
      })}
    </svg>
  );
}
