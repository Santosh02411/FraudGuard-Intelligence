import React from 'react';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import RelationshipsPage from './RelationshipsPage';
import RelationshipGraph, { layout } from '../components/relationships/RelationshipGraph';

const mockGet = jest.fn(); const mockPost = jest.fn();
jest.mock('../context/AuthContext', () => ({ api: { get: (...a) => mockGet(...a), post: (...a) => mockPost(...a) } }));

const cluster = (o = {}) => ({
  cluster_id: 'c4', size: 3, risk_score: 72, risk_band: 'high', corroborated: true, reasons: ['1 of 3 accounts have analyst-confirmed fraud', 'coordinated burst: 7 transactions from 2 accounts within 10 minutes'],
  members: [{ user_id: 4, username: 'ring_a', confirmed_fraud: true, unresolved_alerts: 0 }, { user_id: 5, username: 'ring_b', confirmed_fraud: false, unresolved_alerts: 2 }, { user_id: 6, username: 'ring_c', confirmed_fraud: false, unresolved_alerts: 0 }],
  exposure_amount: 410.5, shared_ips: [{ value: '198.51.100.7', accounts: 3 }], shared_devices: [], open_alert_ids: [11, 12],
  signals: { burst: { txns: 7, accounts: 2, start: '2026-10-20T10:00:00Z', end: '2026-10-20T10:08:00Z' }, repeated_small: [{ user_id: 5, txns: 6 }], accounts_created_together: 3 },
  caveats: ['A review priority, not a finding of fraud.'], ...o,
});
const graph = (o = {}) => ({
  seed: { user_id: 4 }, depth: 1, truncated: false, cluster: null, cautions: [],
  nodes: [
    { id: 'u4', type: 'account', user_id: 4, label: 'ring_a', level: 0, seed: true, confirmed_fraud: true },
    { id: 'i:198.51.100.7', type: 'ip', label: '198.51.100.7', level: 1, accounts: 2 },
    { id: 'i:203.0.113.9', type: 'ip', label: '203.0.113.9', level: 1, accounts: 40, common: true, note: 'used by 40 accounts: shared infrastructure, not expanded' },
    { id: 'u5', type: 'account', user_id: 5, label: 'ring_b', level: 1 },
  ],
  edges: [{ from: 'u4', to: 'i:198.51.100.7', type: 'uses', transactions: 3 }, { from: 'u5', to: 'i:198.51.100.7', type: 'uses', transactions: 1 }, { from: 'u4', to: 'u5', type: 'strong_link', strength: 0.85, evidence: ['ip', 'device'] }, { from: 'u4', to: 'u6', type: 'weak_lead', strength: 0.5, evidence: ['ip'] }], ...o,
});

function setup(url = '/relationships', { clusters = [cluster()], g = graph() } = {}) {
  mockGet.mockImplementation((u) => {
    if (u === '/relationships/clusters') return Promise.resolve({ data: { clusters, suppressed_identifiers: { ips: 2, devices: 5 } } });
    if (u === '/relationships/signals') return Promise.resolve({ data: { definition: '5+ transactions of $5 or less within 60 minutes', repeated_small: [{ user_id: 5, username: 'ring_b', txns: 6, merchants: 6, total: 9, start: '2026-10-20T10:00:00Z' }] } });
    if (u === '/relationships/graph') return Promise.resolve({ data: g });
    return Promise.reject(new Error(u));
  });
  return render(<MemoryRouter initialEntries={[url]}><RelationshipsPage /></MemoryRouter>);
}
beforeEach(() => { jest.clearAllMocks(); mockPost.mockResolvedValue({ data: { investigation: { id: 1 } } }); });

test('lists clusters with score, reasons and the ignored-infrastructure disclosure', async () => {
  setup();
  expect(await screen.findByText('3 accounts')).toBeInTheDocument();
  expect(screen.getByText(/high 72/)).toBeInTheDocument();
  expect(screen.getByText(/Currently ignored as shared infrastructure: 2 IP\(s\), 5 device\(s\)/)).toBeInTheDocument();
  expect(screen.getByText(/innocent explanations/)).toBeInTheDocument();
});

test('selecting a cluster loads its graph and itemised evidence, and offers a case from its open alerts', async () => {
  setup();
  fireEvent.click(await screen.findByRole('button', { name: /3 accounts/ }));
  const detail = await screen.findByTestId('cluster-detail');
  expect(within(detail).getByText(/coordinated burst: 7 transactions/)).toBeInTheDocument();
  expect(within(detail).getByText(/Burst: 7 transactions from 2 accounts/)).toBeInTheDocument();
  expect(within(detail).getByText(/3 accounts were created within 48 hours/)).toBeInTheDocument();
  await waitFor(() => expect(mockGet).toHaveBeenCalledWith('/relationships/graph', { params: { userId: 4, depth: 1 } }));
  expect(await screen.findByRole('img', { name: /Relationship graph: 4 nodes, 4 links/ })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /Open case from 2 open alert/ })).toBeInTheDocument();
});

test('a cluster without open alerts says so instead of offering an empty case', async () => {
  setup('/relationships', { clusters: [cluster({ open_alert_ids: [] })] });
  fireEvent.click(await screen.findByRole('button', { name: /3 accounts/ }));
  expect(await screen.findByText(/No open alerts to build a case from/)).toBeInTheDocument();
});

test('shared-infrastructure-only clusters are labelled as such', async () => {
  setup('/relationships', { clusters: [cluster({ corroborated: false, risk_band: 'watch', risk_score: 40 })] });
  fireEvent.click(await screen.findByRole('button', { name: /3 accounts/ }));
  expect(await screen.findByText('shared infrastructure only')).toBeInTheDocument();
});

test('opening from a transaction shows its neighbourhood directly, and a non-clustered account is explained', async () => {
  setup('/relationships?transactionId=21');
  expect(await screen.findByText('Around transaction #21')).toBeInTheDocument();
  await waitFor(() => expect(mockGet).toHaveBeenCalledWith('/relationships/graph', { params: { transactionId: '21', depth: 1 } }));
  expect(await screen.findByText(/not part of a strongly linked cluster/)).toBeInTheDocument();
});

test('graph errors are shown, not swallowed', async () => {
  mockGet.mockImplementation((u) => (u === '/relationships/graph' ? Promise.reject({ response: { data: { error: 'Transaction or account not found' } } }) : Promise.resolve({ data: { clusters: [], signals: [], repeated_small: [] } })));
  render(<MemoryRouter initialEntries={['/relationships?transactionId=999']}><RelationshipsPage /></MemoryRouter>);
  expect(await screen.findByRole('alert')).toHaveTextContent('Transaction or account not found');
});

test('repeated small transactions tab', async () => {
  setup();
  fireEvent.click(await screen.findByRole('tab', { name: /Repeated small/ }));
  expect(await screen.findByText(/5\+ transactions of \$5 or less/)).toBeInTheDocument();
  expect(screen.getByText('ring_b')).toBeInTheDocument();
});

describe('graph rendering', () => {
  test('strong links are solid, weak leads dashed; common identifiers are marked and never expanded; edges to missing nodes are skipped', () => {
    render(<RelationshipGraph graph={graph()} />);
    expect(screen.getAllByTestId('edge-strong_link')).toHaveLength(1);
    expect(screen.queryByTestId('edge-weak_lead')).toBeNull(); // u6 is not on the graph
    expect(screen.getByTestId('edge-strong_link')).toHaveAttribute('stroke-width', '3');
    expect(screen.getByTestId('node-i:203.0.113.9').textContent).toMatch(/shared infrastructure, not expanded/);
    expect(screen.getByTestId('node-u4').textContent).toMatch(/analyst-confirmed fraud/);
  });
  test('layout is deterministic and places the seed at the centre', () => {
    const g = graph(); const a = layout(g.nodes); const b = layout(g.nodes);
    expect([...a]).toEqual([...b]);
    expect(a.get('u4')).toEqual([260, 260]);
    expect(new Set([...a.values()].map((p) => p.join(','))).size).toBe(g.nodes.length); // no two nodes on the same spot
  });
  test('shows a truncation warning', () => {
    render(<RelationshipGraph graph={graph({ truncated: true })} />);
    expect(screen.getByText(/Graph truncated/)).toBeInTheDocument();
  });
});
