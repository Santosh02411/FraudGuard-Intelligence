import React, { useState, useEffect, useCallback } from 'react';
import { api } from '../context/AuthContext';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  PieChart, Pie, Cell
} from 'recharts';
import { LoadingState, ErrorState } from '../components/ui/States';
import { BarChart2 } from 'lucide-react';
import PageHeading from '../components/ui/PageHeading';

export default function AnalyticsPage() {
  const [transactions, setTransactions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(() => {
    setLoading(true);
    setError('');
    // Charts below need the full history, not one page of it — pull pages
    // (capped at the API's max page size) until there's nothing left.
    async function loadAll() {
      let page = 1;
      let all = [];
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const res = await api.get('/transactions', { params: { page, limit: 100 } });
        all = all.concat(res.data.transactions);
        if (!res.data.pagination?.has_next) break;
        page += 1;
      }
      setTransactions(all);
    }
    loadAll()
      .catch((err) => setError(err.response?.data?.error || 'Failed to load analytics'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  if (loading) return (
    <div className="p-4 sm:p-8 max-w-7xl mx-auto">
      <LoadingState label="Loading analytics..." />
    </div>
  );

  if (error) return (
    <div className="p-4 sm:p-8 max-w-7xl mx-auto">
      <ErrorState message={error} onRetry={load} />
    </div>
  );

  // Category breakdown
  const categoryMap = {};
  transactions.forEach(t => {
    if (!categoryMap[t.category]) categoryMap[t.category] = { category: t.category, count: 0, amount: 0, fraud: 0 };
    categoryMap[t.category].count++;
    categoryMap[t.category].amount += t.amount;
    if (t.is_fraud) categoryMap[t.category].fraud++;
  });
  const categoryData = Object.values(categoryMap).map(c => ({
    ...c,
    amount: parseFloat(c.amount.toFixed(2)),
  }));

  // Risk breakdown for pie
  const riskCount = { low: 0, medium: 0, high: 0 };
  transactions.forEach(t => { riskCount[t.risk_level]++; });
  const pieData = [
    { name: 'Low Risk', value: riskCount.low },
    { name: 'Medium Risk', value: riskCount.medium },
    { name: 'High Risk', value: riskCount.high },
  ].filter(d => d.value > 0);

  // Daily transaction volume (last 7 days)
  const dailyMap = {};
  transactions.forEach(t => {
    const day = new Date(t.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    if (!dailyMap[day]) dailyMap[day] = { day, total: 0, fraud: 0 };
    dailyMap[day].total++;
    if (t.is_fraud) dailyMap[day].fraud++;
  });
  const dailyData = Object.values(dailyMap).slice(-7);

  return (
    <div className="p-4 sm:p-8 max-w-7xl mx-auto">
      <div className="mb-6 sm:mb-8">
        <PageHeading icon={BarChart2} title="Analytics" subtitle="Transaction patterns and fraud insights" />
      </div>

      {transactions.length === 0 ? (
        <div className="bg-[#111820] border border-white/10 rounded-xl p-12 text-center text-gray-500">
          No transaction data yet. Create some transactions to see analytics.
        </div>
      ) : (
        <div className="space-y-6">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Daily volume */}
            <div className="bg-[#111820] border border-white/10 rounded-xl p-6">
              <h2 className="text-lg font-semibold text-white mb-4">Transaction Volume by Day</h2>
              <ResponsiveContainer width="100%" height={250}>
                <BarChart data={dailyData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#ffffff10" />
                  <XAxis dataKey="day" tick={{ fill: '#9ca3af', fontSize: 12 }} />
                  <YAxis tick={{ fill: '#9ca3af', fontSize: 12 }} />
                  <Tooltip contentStyle={{ backgroundColor: '#111820', border: '1px solid #ffffff20', color: '#fff' }} />
                  <Bar dataKey="total" fill="#06b6d4" name="Total" radius={[4,4,0,0]} />
                  <Bar dataKey="fraud" fill="#ef4444" name="Fraud" radius={[4,4,0,0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>

            {/* Risk breakdown pie */}
            <div className="bg-[#111820] border border-white/10 rounded-xl p-6">
              <h2 className="text-lg font-semibold text-white mb-4">Risk Level Distribution</h2>
              <ResponsiveContainer width="100%" height={250}>
                <PieChart>
                  <Pie data={pieData} cx="50%" cy="50%" outerRadius={90} dataKey="value" label={({ name, percent }) => `${name} ${(percent * 100).toFixed(0)}%`}>
                    {pieData.map((_, i) => <Cell key={i} fill={['#10b981','#f59e0b','#ef4444'][i]} />)}
                  </Pie>
                  <Tooltip contentStyle={{ backgroundColor: '#111820', border: '1px solid #ffffff20', color: '#fff' }} />
                </PieChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* Category breakdown */}
          <div className="bg-[#111820] border border-white/10 rounded-xl p-6">
            <h2 className="text-lg font-semibold text-white mb-4">Amount by Category</h2>
            <ResponsiveContainer width="100%" height={280}>
              <BarChart data={categoryData} layout="vertical">
                <CartesianGrid strokeDasharray="3 3" stroke="#ffffff10" />
                <XAxis type="number" tick={{ fill: '#9ca3af', fontSize: 12 }} />
                <YAxis dataKey="category" type="category" tick={{ fill: '#9ca3af', fontSize: 12 }} width={90} />
                <Tooltip contentStyle={{ backgroundColor: '#111820', border: '1px solid #ffffff20', color: '#fff' }}
                  formatter={(v) => [`$${v.toLocaleString()}`, 'Amount']} />
                <Bar dataKey="amount" fill="#38bdf8" radius={[0,4,4,0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}
    </div>
  );
}
