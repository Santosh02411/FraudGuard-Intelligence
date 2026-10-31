import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { api, useAuth } from '../context/AuthContext';
import { useSocket } from '../context/SocketContext';
import { Link } from 'react-router-dom';
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, PieChart, Pie, Cell, Legend, Label } from 'recharts';
import { DollarSign, AlertTriangle, Activity, TrendingUp, CheckCircle, XCircle, Bell, Lock, LayoutDashboard } from 'lucide-react';
import { LoadingState, ErrorState, EmptyState } from '../components/ui/States';
import StatCard from '../components/ui/StatCard';
import PageHeading from '../components/ui/PageHeading';

const DAY = 86400000;
const CHART_DAYS = 14;
const MAX_PAGES = 5; // 500 newest transactions feed the charts; the totals above come from /transactions/stats (exact)
const TOOLTIP = { backgroundColor: '#111820', border: '1px solid #ffffff20', color: '#fff' };

/** SQLite hands back 'YYYY-MM-DD HH:MM:SS' (UTC, no zone); Postgres/ISO values carry one. */
export function parseTs(v) {
  if (v instanceof Date) return v.getTime();
  const s = String(v ?? '');
  return new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : `${s.replace(' ', 'T')}Z`).getTime();
}

export function detectionLayer(method) {
  const m = String(method || '');
  if (m.startsWith('hard')) return 'Hard rule override';
  if (m.includes('floor')) return 'ML + calibration floor';
  if (m.includes('network')) return 'ML + network watch';
  if (m.startsWith('rule')) return 'Rule-engine fallback';
  return 'ML model';
}
const LAYER_COLOR = { 'ML model': '#22d3ee', 'Hard rule override': '#ef4444', 'ML + calibration floor': '#f59e0b', 'ML + network watch': '#a78bfa', 'Rule-engine fallback': '#6b7280' };

export function volumeByDay(rows, now = Date.now(), days = CHART_DAYS) {
  const start = new Date(now); start.setHours(0, 0, 0, 0);
  const buckets = Array.from({ length: days }, (_, i) => {
    const t0 = start.getTime() - (days - 1 - i) * DAY;
    return { t0, day: new Date(t0).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }), total: 0, flagged: 0 };
  });
  for (const r of rows) {
    const t = parseTs(r.created_at);
    const b = buckets.find((x) => t >= x.t0 && t < x.t0 + DAY);
    if (b) { b.total += 1; if (r.risk_level !== 'low') b.flagged += 1; }
  }
  return buckets;
}

export function p95(values) {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  return v.length ? v[Math.min(v.length - 1, Math.floor(v.length * 0.95))] : null;
}

function RiskBadge({ level }) {
  const styles = {
    high: 'bg-red-500/20 text-red-400 border border-red-500/30',
    medium: 'bg-yellow-500/20 text-yellow-400 border border-yellow-500/30',
    low: 'bg-green-500/20 text-green-400 border border-green-500/30',
  };
  return <span className={`px-2 py-0.5 rounded-full text-xs font-semibold uppercase ${styles[level] || styles.low}`}>{level}</span>;
}

export default function DashboardPage() {
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
  const { socket, connected, resyncToken } = useSocket();
  const [stats, setStats] = useState(null);
  const [rows, setRows] = useState([]);
  const [truncated, setTruncated] = useState(false);
  const [alertInfo, setAlertInfo] = useState(null); // { open, overdue|null }
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const [statsRes, first] = await Promise.all([api.get('/transactions/stats'), api.get('/transactions', { params: { page: 1, limit: 100 } })]);
      let all = first.data.transactions; let hasNext = first.data.pagination?.has_next; let page = 1;
      const cutoff = Date.now() - CHART_DAYS * DAY;
      while (hasNext && page < MAX_PAGES && all.length && parseTs(all[all.length - 1].created_at) >= cutoff) {
        page += 1;
        const next = await api.get('/transactions', { params: { page, limit: 100 } });
        all = all.concat(next.data.transactions); hasNext = next.data.pagination?.has_next;
      }
      setStats(statsRes.data); setRows(all);
      setTruncated(Boolean(hasNext) && all.length > 0 && parseTs(all[all.length - 1].created_at) >= cutoff);
      // Queue health is a nice-to-have: if it fails the rest of the dashboard still renders.
      try {
        if (isAdmin) {
          const { data } = await api.get('/alerts/metrics', { params: { days: 7 } });
          setAlertInfo({ open: Number(data?.open?.total ?? 0), overdue: Number(data?.open?.overdue ?? 0) });
        } else {
          const [open, overdue] = await Promise.all([
            api.get('/alerts', { params: { status: 'open', limit: 1 } }),
            api.get('/alerts', { params: { overdue: 'true', limit: 1 } }),
          ]);
          setAlertInfo({ open: Number(open.data?.pagination?.total ?? 0), overdue: Number(overdue.data?.pagination?.total ?? 0) });
        }
      } catch { setAlertInfo(null); }
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to load dashboard data');
    } finally { setLoading(false); }
  }, [isAdmin]);

  useEffect(() => { load(); }, [load, resyncToken]);

  // Pushed updates instead of polling: a transaction scored by the backend (real or Live Feed simulation)
  // shows up here immediately (see realtime/socketServer.js).
  useEffect(() => {
    if (!socket) return undefined;
    const onTransaction = ({ transaction: txn }) => {
      setRows((prev) => (prev.some((t) => t.id === txn.id) ? prev : [txn, ...prev]));
      setStats((prev) => {
        if (!prev) return prev;
        const total = prev.total_transactions + 1;
        const fraudCount = prev.fraud_count + (txn.is_fraud ? 1 : 0);
        return { ...prev, total_transactions: total, fraud_count: fraudCount, fraud_rate: parseFloat(((fraudCount / total) * 100).toFixed(2)), total_amount: parseFloat((prev.total_amount + Number(txn.amount)).toFixed(2)) };
      });
    };
    socket.on('transaction:new', onTransaction);
    return () => socket.off('transaction:new', onTransaction);
  }, [socket]);

  const volume = useMemo(() => volumeByDay(rows), [rows]);
  const layers = useMemo(() => {
    const m = {}; rows.forEach((t) => { const k = detectionLayer(t.scoring_method); m[k] = (m[k] || 0) + 1; });
    return Object.entries(m).map(([name, value]) => ({ name, value }));
  }, [rows]);
  const latency = useMemo(() => p95(rows.map((t) => Number(t.ml_latency_ms)).filter((x) => x > 0)), [rows]);
  const decisions = layers.reduce((n, l) => n + l.value, 0);

  if (loading) return <div className="p-4 sm:p-8 max-w-7xl mx-auto"><LoadingState label="Loading dashboard..." /></div>;
  if (error) return <div className="p-4 sm:p-8 max-w-7xl mx-auto"><ErrorState message={error} onRetry={load} /></div>;

  const greeting = (() => { const h = new Date().getHours(); return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening'; })();
  const recent = rows.slice(0, 10);
  const usd = (n) => `$${Number(n ?? 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  return (
    <div className="p-4 sm:p-8 max-w-7xl mx-auto">
      <div className="mb-6 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <PageHeading icon={LayoutDashboard} title="Dashboard" subtitle={`${greeting}, ${user?.username}`} />
        <div className={`flex items-center gap-2 text-sm px-3 py-1.5 rounded-full border self-start ${connected ? 'text-green-400 border-green-500/20 bg-green-500/5' : 'text-gray-500 border-white/10 bg-white/5'}`}>
          <span className={`relative flex w-2 h-2 rounded-full ${connected ? 'bg-green-400' : 'bg-gray-600'}`}>
            {connected && <span className="absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75 animate-ping" />}
          </span>
          {connected ? 'Live' : 'Offline'}
        </div>
      </div>

      <div className="stagger grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-4">
        <StatCard title="Total Transactions" value={(stats?.total_transactions ?? 0).toLocaleString()} icon={Activity} hint="all time + live" />
        <StatCard title="Fraud Detected" value={stats?.fraud_count ?? 0} icon={AlertTriangle} color="text-red-400" hint={`${stats?.medium_count ?? 0} more held for review`} />
        <StatCard title="Total Amount" value={usd(stats?.total_amount)} icon={DollarSign} color="text-green-400" />
        <StatCard title="Fraud Rate" value={`${Number(stats?.fraud_rate ?? 0).toFixed(2)}%`} icon={TrendingUp} color={stats?.fraud_rate > 20 ? 'text-red-400' : 'text-yellow-400'} />
      </div>
      <div className="stagger grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-6" aria-label="Operations">
        <StatCard title="Open alerts" value={alertInfo ? alertInfo.open : '—'} icon={Bell} color="text-blue-400"
          hint={<Link to="/alerts" className="text-cyan-400 hover:text-cyan-300">work the queue →</Link>} />
        <StatCard title="Overdue (past SLA)" value={alertInfo ? alertInfo.overdue : '—'} icon={AlertTriangle} color={alertInfo?.overdue ? 'text-yellow-400' : 'text-green-400'} />
        <StatCard title="Model latency p95" value={latency === null ? 'n/a' : `${latency} ms`} icon={Activity} color="text-purple-400" hint="ML scoring service" />
        <StatCard title="Declined / held" value={`${stats?.declined_count ?? 0} / ${stats?.held_count ?? 0}`} icon={Lock} hint="risk-based verification" />
      </div>

      {rows.length > 0 && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-6">
          <div className="lg:col-span-2 bg-[#111820] border border-white/10 rounded-xl p-5 sm:p-6">
            <h2 className="text-lg font-semibold text-white mb-1">Volume — last {CHART_DAYS} days</h2>
            {truncated && <p className="text-xs text-gray-500 mb-2">Based on the {rows.length} most recent transactions.</p>}
            <ResponsiveContainer width="100%" height={230}>
              <BarChart data={volume}>
                <CartesianGrid strokeDasharray="3 3" stroke="#ffffff10" />
                <XAxis dataKey="day" tick={{ fill: '#9ca3af', fontSize: 11 }} interval="preserveStartEnd" />
                <YAxis allowDecimals={false} tick={{ fill: '#9ca3af', fontSize: 12 }} />
                <Tooltip contentStyle={TOOLTIP} />
                <Legend wrapperStyle={{ fontSize: 12, color: '#9ca3af' }} />
                <Bar dataKey="total" name="Transactions" fill="#22d3ee" radius={[4, 4, 0, 0]} />
                <Bar dataKey="flagged" name="Flagged" fill="#ef4444" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
          <div className="bg-[#111820] border border-white/10 rounded-xl p-5 sm:p-6">
            <h2 className="text-lg font-semibold text-white mb-1">Which detection layer decided</h2>
            {decisions !== (stats?.total_transactions ?? decisions) && <p className="text-xs text-gray-500 mb-1" data-testid="donut-sample">Latest {decisions} of {(stats?.total_transactions ?? 0).toLocaleString()} transactions</p>}
            <ResponsiveContainer width="100%" height={190}>
              <PieChart>
                <Pie data={layers} dataKey="value" nameKey="name" innerRadius={55} outerRadius={82} paddingAngle={1} stroke="none">
                  {layers.map((l) => <Cell key={l.name} fill={LAYER_COLOR[l.name]} />)}
                  <Label position="center" content={({ viewBox }) => (viewBox ? (
                    <g>
                      <text x={viewBox.cx} y={viewBox.cy - 2} textAnchor="middle" fill="#fff" fontSize="24" fontWeight="700">{decisions}</text>
                      <text x={viewBox.cx} y={viewBox.cy + 16} textAnchor="middle" fill="#9ca3af" fontSize="11">decisions</text>
                    </g>) : null)} />
                </Pie>
                <Tooltip contentStyle={TOOLTIP} />
              </PieChart>
            </ResponsiveContainer>
            <ul className="space-y-1.5 text-xs text-gray-300 mt-1" aria-label="Detection layers">
              {layers.map((l) => (
                <li key={l.name} className="flex items-center gap-2">
                  <span className="w-2.5 h-2.5 rounded-sm" style={{ background: LAYER_COLOR[l.name] }} />
                  <span>{l.name}</span>
                  <span className="font-semibold text-white tabular-nums">{l.value}</span>
                  <span className="text-gray-500 tabular-nums">({decisions ? Math.round((l.value / decisions) * 100) : 0}%)</span>
                </li>
              ))}
            </ul>
            <p className="text-[11px] text-gray-500 mt-3">Hard rules override the model; the calibration floor and network watch back it up; the rule engine only runs if the ML service is down.</p>
          </div>
        </div>
      )}

      <div className="bg-[#111820] border border-white/10 rounded-xl">
        <div className="p-6 border-b border-white/10 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-white">Recent Transactions</h2>
          <Link to="/transactions" className="text-cyan-400 hover:text-cyan-300 text-sm transition-colors">View all &rarr;</Link>
        </div>
        {recent.length === 0 ? (
          <EmptyState icon={Activity} title="No transactions yet" subtitle="Run a scenario in the Simulator, or seed demo data (npm run seed in backend/), to see activity here." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-white/10 text-gray-400 text-sm">
                  <th className="text-left px-6 py-3">Merchant</th>
                  {isAdmin && <th className="text-left px-6 py-3">Customer</th>}
                  <th className="text-left px-6 py-3">Amount</th>
                  <th className="text-left px-6 py-3">Category</th>
                  <th className="text-left px-6 py-3">Risk</th>
                  <th className="text-left px-6 py-3">Score</th>
                  <th className="text-left px-6 py-3">Status</th>
                  <th className="text-left px-6 py-3">Date</th>
                </tr>
              </thead>
              <tbody>
                {recent.map((txn) => (
                  <tr key={txn.id} className="border-b border-white/5 hover:bg-white/5 transition-colors">
                    <td className="px-6 py-4 text-white font-medium"><Link to={`/transactions/${txn.id}`} className="hover:text-cyan-400 transition-colors">{txn.merchant}</Link></td>
                    {isAdmin && <td className="px-6 py-4 text-gray-400 text-sm">{txn.username || '—'}</td>}
                    <td className="px-6 py-4 text-white tabular-nums">${Number(txn.amount).toFixed(2)}</td>
                    <td className="px-6 py-4 text-gray-300 capitalize">{String(txn.category).replace('_', ' ')}</td>
                    <td className="px-6 py-4"><RiskBadge level={txn.risk_level} /></td>
                    <td className="px-6 py-4">
                      <div className="flex items-center gap-2">
                        <div className="w-16 bg-white/10 rounded-full h-1.5"><div className={`h-1.5 rounded-full ${txn.fraud_score >= 70 ? 'bg-red-500' : txn.fraud_score >= 40 ? 'bg-yellow-500' : 'bg-green-500'}`} style={{ width: `${Math.min(100, txn.fraud_score)}%` }} /></div>
                        <span className="text-xs text-gray-400 tabular-nums">{txn.fraud_score}%</span>
                      </div>
                    </td>
                    <td className="px-6 py-4">
                      {txn.is_fraud ? <span className="flex items-center gap-1 text-red-400 text-sm"><XCircle size={14} /> Fraud</span> : <span className="flex items-center gap-1 text-green-400 text-sm"><CheckCircle size={14} /> Safe</span>}
                    </td>
                    <td className="px-6 py-4 text-gray-400 text-sm">{new Date(parseTs(txn.created_at)).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
