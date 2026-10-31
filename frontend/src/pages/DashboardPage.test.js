import React from 'react';
import { render, screen, within, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import DashboardPage, { parseTs, detectionLayer, volumeByDay, p95 } from './DashboardPage';

const fs = require('fs');
const path = require('path');

const mockGet = jest.fn(); let mockUser = { username: 'root', role: 'admin' }; let mockHandlers = {};
jest.mock('../context/AuthContext', () => ({ useAuth: () => ({ user: mockUser }), api: { get: (...a) => mockGet(...a) } }));
jest.mock('../context/SocketContext', () => ({ useSocket: () => ({ socket: { on: (e, f) => { mockHandlers[e] = f; }, off: (e) => { delete mockHandlers[e]; } }, connected: true, resyncToken: 0 }) }));
jest.mock('recharts', () => { const R = jest.requireActual('react'); const box = (n) => ({ children }) => R.createElement('div', { 'data-chart': n }, children); return {
  ResponsiveContainer: box('rc'), BarChart: ({ data, children }) => R.createElement('div', { 'data-chart': 'bar', 'data-points': JSON.stringify(data) }, children), Bar: () => null, XAxis: () => null, YAxis: () => null,
  CartesianGrid: () => null, Tooltip: () => null, Legend: () => null, PieChart: box('pie'), Pie: ({ children }) => R.createElement('div', null, children), Cell: () => null,
  Label: ({ content }) => (content ? R.createElement('svg', { 'data-testid': 'donut-centre' }, content({ viewBox: { cx: 50, cy: 50 } })) : null) }; });

const iso = (hoursAgo) => new Date(Date.now() - hoursAgo * 3600e3).toISOString();
const tx = (id, o = {}) => ({ id, merchant: `Shop ${id}`, username: `cust${id}`, amount: 100 + id, category: 'grocery', risk_level: 'low', fraud_score: 5, is_fraud: 0, scoring_method: 'ml_model', ml_latency_ms: 20 + id, created_at: iso(id), ...o });
const STATS = { total_transactions: 1234, fraud_count: 12, fraud_rate: 0.97, total_amount: 98765.4, avg_fraud_score: 14.25, medium_count: 21, declined_count: 3, held_count: 1 };
function setup({ pages = [[tx(1), tx(2, { risk_level: 'high', fraud_score: 90, is_fraud: 1, scoring_method: 'hard_rule_override' }), tx(3, { risk_level: 'medium', fraud_score: 45 })]], metrics, alertsFail = false, stats } = {}) {
  mockGet.mockImplementation((url, cfg) => {
    if (url === '/transactions/stats') return Promise.resolve({ data: stats || STATS });
    if (url === '/transactions') { const i = (cfg.params.page || 1) - 1; return Promise.resolve({ data: { transactions: pages[i] || [], pagination: { has_next: i + 1 < pages.length } } }); }
    if (url === '/alerts/metrics') return alertsFail ? Promise.reject(new Error('x')) : Promise.resolve({ data: metrics || { open: { total: 15, overdue: 4 } } });
    if (url === '/alerts') return alertsFail ? Promise.reject(new Error('x')) : Promise.resolve({ data: { alerts: [], pagination: { total: cfg.params.overdue ? 2 : 6 } } });
    return Promise.reject(new Error(url));
  });
  return render(<MemoryRouter><DashboardPage /></MemoryRouter>);
}
beforeEach(() => { jest.clearAllMocks(); mockHandlers = {}; mockUser = { username: 'root', role: 'admin' }; });

describe('dashboard (same cards, hints and order as the interactive demo)', () => {
  test('first row: totals from /stats with the demo hints', async () => {
    setup();
    expect(await screen.findByText('1,234')).toBeInTheDocument();
    expect(screen.getByText('$98,765.40')).toBeInTheDocument(); expect(screen.getByText('0.97%')).toBeInTheDocument();
    expect(screen.getByText('21 more held for review')).toBeInTheDocument();            // medium_count from the whole table, not a page
    expect(screen.getByText('all time + live')).toBeInTheDocument();
    const titles = [...document.querySelectorAll('p.text-gray-400')].map((e) => e.textContent).filter((t) => ['Total Transactions', 'Fraud Detected', 'Total Amount', 'Fraud Rate'].includes(t));
    expect(titles).toEqual(['Total Transactions', 'Fraud Detected', 'Total Amount', 'Fraud Rate']);
  });

  test('second row: Open alerts / Overdue / Model latency p95 / Declined-held, with the demo wording', async () => {
    setup();
    await screen.findByText('1,234');
    const ops = screen.getByLabelText('Operations');
    expect([...ops.querySelectorAll('p.text-gray-400')].map((e) => e.textContent)).toEqual(['Open alerts', 'Overdue (past SLA)', 'Model latency p95', 'Declined / held']);
    expect(within(ops).getByText('15')).toBeInTheDocument(); expect(within(ops).getByText('4')).toBeInTheDocument();
    expect(within(ops).getByRole('link', { name: 'work the queue →' })).toHaveAttribute('href', '/alerts');
    expect(within(ops).getByText(/^\d+ ms$/)).toBeInTheDocument(); expect(within(ops).getByText('ML scoring service')).toBeInTheDocument();
    expect(within(ops).getByText('3 / 1')).toBeInTheDocument(); expect(within(ops).getByText('risk-based verification')).toBeInTheDocument();
  });

  test('volume chart (14 days) and the detection-layer donut with a centre count and percentages', async () => {
    setup();
    await screen.findByText('1,234');
    expect(screen.getByText(/Volume — last 14 days/)).toBeInTheDocument(); expect(screen.getByText('Which detection layer decided')).toBeInTheDocument();
    const pts = JSON.parse(document.querySelector('[data-chart="bar"]').getAttribute('data-points'));
    expect(pts).toHaveLength(14); expect(pts.reduce((s, p) => s + p.total, 0)).toBe(3); expect(pts.reduce((s, p) => s + p.flagged, 0)).toBe(2);
    const centre = screen.getByTestId('donut-centre');
    expect(centre).toHaveTextContent('3'); expect(centre).toHaveTextContent('decisions');
    const legend = within(screen.getByLabelText('Detection layers'));
    expect(legend.getByText('ML model').parentElement).toHaveTextContent('ML model2(67%)');
    expect(legend.getByText('Hard rule override').parentElement).toHaveTextContent('Hard rule override1(33%)');
  });

  test('says so when the donut covers only the latest transactions (so it never silently disagrees with the total)', async () => {
    setup();                                                    // 3 rows loaded vs 1,234 in total
    await screen.findByText('1,234');
    expect(screen.getByTestId('donut-sample')).toHaveTextContent('Latest 3 of 1,234 transactions');
  });

  test('no caption when the donut covers every transaction', async () => {
    setup({ stats: { ...STATS, total_transactions: 3 } });
    await screen.findByText('Recent Transactions');
    expect(screen.queryByTestId('donut-sample')).not.toBeInTheDocument();
  });

  test('recent transactions table with a Customer column for admins', async () => {
    setup();
    await screen.findByText('1,234');
    expect(screen.getByText('Customer')).toBeInTheDocument(); expect(screen.getByText('cust2')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Shop 2' })).toHaveAttribute('href', '/transactions/2');
  });

  test('non-admin users see the same four cards, using their own alert counts', async () => {
    mockUser = { username: 'alice', role: 'user' };
    setup();
    await screen.findByText('1,234');
    expect(screen.queryByText('Customer')).not.toBeInTheDocument();
    const ops = screen.getByLabelText('Operations');
    expect([...ops.querySelectorAll('p.text-gray-400')].map((e) => e.textContent)).toEqual(['Open alerts', 'Overdue (past SLA)', 'Model latency p95', 'Declined / held']);
    expect(within(ops).getByText('6')).toBeInTheDocument(); expect(within(ops).getByText('2')).toBeInTheDocument();
    expect(mockGet).not.toHaveBeenCalledWith('/alerts/metrics', expect.anything());
  });

  test('a failing alert-queue call does not break the dashboard', async () => {
    setup({ alertsFail: true });
    expect(await screen.findByText('1,234')).toBeInTheDocument();
    const ops = screen.getByLabelText('Operations');
    expect(within(ops).getAllByText('—')).toHaveLength(2);
  });

  test('pages through history for the chart but stops at the cap and says when it is a sample', async () => {
    const page = (n) => Array.from({ length: 100 }, (_, i) => tx(n * 1000 + i, { created_at: iso(1 + i / 100) }));
    setup({ pages: [page(1), page(2), page(3), page(4), page(5), page(6)] });
    await screen.findByText('1,234');
    expect(mockGet.mock.calls.filter((c) => c[0] === '/transactions')).toHaveLength(5);
    expect(screen.getByText(/most recent transactions/i)).toBeInTheDocument();
  });

  test('empty state when there are no transactions yet, with a pointer to seeding', async () => {
    setup({ pages: [[]], stats: { ...STATS, total_transactions: 0, fraud_count: 0, fraud_rate: 0, total_amount: 0, medium_count: 0, declined_count: 0, held_count: 0 } });
    expect(await screen.findByText('No transactions yet')).toBeInTheDocument();
    expect(screen.getByText(/npm run seed/)).toBeInTheDocument();
    expect(screen.queryByText(/Volume — last/)).not.toBeInTheDocument();
  });

  test('a pushed transaction updates totals and the table without a reload', async () => {
    setup();
    await screen.findByText('1,234');
    act(() => mockHandlers['transaction:new']({ transaction: tx(99, { merchant: 'Pushed Cafe', amount: 50, is_fraud: 1, created_at: new Date().toISOString() }) }));
    expect(await screen.findByText('1,235')).toBeInTheDocument(); expect(screen.getByText('Pushed Cafe')).toBeInTheDocument();
  });

  test('shows an error with retry when the main data cannot be loaded', async () => {
    mockGet.mockRejectedValue({ response: { data: { error: 'boom' } } });
    render(<MemoryRouter><DashboardPage /></MemoryRouter>);
    expect(await screen.findByText(/boom/)).toBeInTheDocument();
  });
});

describe('parity with the interactive demo', () => {
  const demoFile = path.join(__dirname, '..', '..', '..', 'demo', 'fraudguard-demo.base.html');
  const maybe = fs.existsSync(demoFile) ? test : test.skip;
  maybe('every label, hint and chart title on the real dashboard also exists in the demo dashboard', async () => {
    const demo = fs.readFileSync(demoFile, 'utf8');
    setup();
    await screen.findByText('1,234');
    const ours = [
      'Total Transactions', 'Fraud Detected', 'Total Amount', 'Fraud Rate', 'Open alerts', 'Overdue (past SLA)', 'Model latency p95', 'Declined / held',
      'ML scoring service', 'risk-based verification', 'work the queue', 'more held for review', 'Which detection layer decided', 'Recent Transactions',
      'Hard rule override', 'ML + calibration floor', 'ML + network watch', 'Rule-engine fallback', 'decisions',
    ];
    for (const label of ours) expect(demo).toContain(label);
    expect(demo).toContain('Volume — last 14 days');
    expect(screen.getByText(/Volume — last 14 days/)).toBeInTheDocument();
  });
});

describe('helpers', () => {
  test('parseTs treats zone-less SQLite timestamps as UTC and respects explicit zones', () => {
    expect(parseTs('2026-10-31 10:00:00')).toBe(Date.UTC(2026, 9, 31, 10, 0, 0));
    expect(parseTs('2026-10-31T10:00:00Z')).toBe(Date.UTC(2026, 9, 31, 10, 0, 0));
    expect(parseTs('2026-10-31T15:30:00+05:30')).toBe(Date.UTC(2026, 9, 31, 10, 0, 0));
  });
  test('detectionLayer classifies scoring methods like the demo', () => {
    expect(detectionLayer('hard_rule_override+ml')).toBe('Hard rule override'); expect(detectionLayer('ml_model+calibration_floor')).toBe('ML + calibration floor');
    expect(detectionLayer('ml_model+network_watch')).toBe('ML + network watch'); expect(detectionLayer('rule_engine_fallback')).toBe('Rule-engine fallback'); expect(detectionLayer('ml_model')).toBe('ML model');
  });
  test('p95 and volumeByDay', () => {
    expect(p95([])).toBeNull(); expect(p95([5, 1, 3])).toBe(5); expect(p95(Array.from({ length: 100 }, (_, i) => i + 1))).toBe(96);
    const now = Date.now(); const v = volumeByDay([{ created_at: new Date(now).toISOString(), risk_level: 'high' }, { created_at: new Date(now - 40 * 86400000).toISOString(), risk_level: 'low' }], now);
    expect(v).toHaveLength(14); expect(v[13]).toMatchObject({ total: 1, flagged: 1 }); expect(v.reduce((s, b) => s + b.total, 0)).toBe(1);
  });
});
