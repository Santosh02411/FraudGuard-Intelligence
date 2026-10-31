import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import ModelHealthPanel from './ModelHealthPanel';

const mockGet = jest.fn(); const mockPost = jest.fn(); const mockPut = jest.fn();
jest.mock('../../context/AuthContext', () => ({ api: { get: (...a) => mockGet(...a), post: (...a) => mockPost(...a), put: (...a) => mockPut(...a) } }));

const settings = { psi_warn: 0.1, psi_critical: 0.25, score_psi_warn: 0.1, score_psi_critical: 0.25, missing_rate_warn: 0.02, missing_rate_critical: 0.1, min_reviewed_for_quality: 20 };
const overview = (o = {}) => ({
  version: 'v3', last_run: { at: '2026-10-29T04:00:00Z' }, settings, interpretation: 'The distribution of model INPUTS moved. That is a warning signal, not proof that accuracy has fallen.',
  operations: { window_hours: 24, n: 500, latency_p50_ms: 38, latency_p95_ms: 210, latency_max_ms: 900, fallback_rate: 0.012, prediction_failures: 6, failures_by_kind: { timeout: 4, http_error: 2 }, missing_rate: 0.031, top_missing_fields: [{ name: 'hour', count: 12 }], unseen_categories: [{ name: 'category=space_tourism', count: 3 }], series: [{ fallback_rate: 0, latency_p95_ms: 100, missing_rate: 0 }, { fallback_rate: 0.02, latency_p95_ms: 200, missing_rate: 0.03 }] },
  latest_drift: { '24h': { status: 'significant_drift', max_psi: 0.42, score_psi: 0.05, n: 480, feature_psi: { top: [{ feature: 'amount', psi: 0.42 }] } }, '7d': null },
  quality_trend: [{ status: 'insufficient_data', quality: { reviewed: 7, floor: 20 } }],
  open_alerts: [{ id: 3, severity: 'critical', trigger_name: 'drift_features', scope: '24h|category=crypto', kind: 'input_shift', acknowledged: false,
    details: { value: 0.42, warn: 0.1, critical: 0.25, top_features: [{ feature: 'amount' }], interpretation: 'not proof', quality_evidence: { status: 'no_labels_yet' } } }],
  shadow: null, ...o,
});
function route(o) {
  mockGet.mockImplementation((url) => {
    if (url === '/model-monitoring/overview') return Promise.resolve({ data: overview(o) });
    if (url === '/model-monitoring/segments') return Promise.resolve({ data: { segments: [{ segment_dim: 'category', segment_value: 'crypto', n: 60, max_psi: 0.42, score_psi: 0.3, status: 'significant_drift' }] } });
    if (url === '/model-monitoring/snapshots') return Promise.resolve({ data: { snapshots: [{ max_psi: 0.05 }, { max_psi: 0.2 }, { max_psi: 0.42 }] } });
    return Promise.reject(new Error(`unmocked ${url}`));
  });
}
beforeEach(() => { jest.clearAllMocks(); route(); mockPost.mockResolvedValue({ data: { snapshots: 5, alerts_opened: 1, alerts_cleared: 0, errors: [] } }); mockPut.mockResolvedValue({ data: {} }); });

test('shows operations (latency, fallback, failures by kind, missing inputs) and the "not proof" framing', async () => {
  render(<ModelHealthPanel />);
  expect(await screen.findByText(/warning signal, not proof/)).toBeInTheDocument();
  expect(screen.getByTestId('tile-latency')).toHaveTextContent('38 ms / 210 ms');
  expect(screen.getByTestId('tile-fallback')).toHaveTextContent('1.2%');
  expect(screen.getByTestId('tile-failures')).toHaveTextContent('timeout 4 · http_error 2');
  expect(screen.getByTestId('tile-missing')).toHaveTextContent('hour 12');
  expect(screen.getByText(/category=space_tourism \(3\)/)).toBeInTheDocument();
});

test('drift alert shows scope, top features, and the accuracy evidence beside it (no labels yet)', async () => {
  render(<ModelHealthPanel />);
  expect(await screen.findByText('24h|category=crypto')).toBeInTheDocument();
  expect(screen.getByTestId('quality-evidence')).toHaveTextContent('no labels yet');
  expect(screen.getByText(/top: amount/)).toBeInTheDocument();
  expect(screen.getByTestId('quality-insufficient')).toHaveTextContent('7 of 20');
  expect(await screen.findByText('category: crypto')).toBeInTheDocument();
});

test('acknowledging needs a note; evaluating now reports what changed', async () => {
  render(<ModelHealthPanel />);
  const btn = await screen.findByText('Acknowledge');
  expect(btn).toBeDisabled();
  fireEvent.change(screen.getByLabelText('Acknowledgement note'), { target: { value: 'Promo traffic' } });
  fireEvent.click(btn);
  await waitFor(() => expect(mockPost).toHaveBeenCalledWith('/model-monitoring/alerts/3/acknowledge', { note: 'Promo traffic' }));
  // the acknowledge call marks the panel busy; clicking before it settles is ignored (flaky under load)
  await waitFor(() => expect(screen.getByText('Evaluate now')).not.toBeDisabled());
  fireEvent.click(screen.getByText('Evaluate now'));
  expect(await screen.findByText(/5 snapshots, 1 opened, 0 cleared/)).toBeInTheDocument();
});

test('threshold editor sends numbers with a required note and surfaces server validation errors', async () => {
  mockPut.mockRejectedValueOnce({ response: { data: { details: { problems: ['psi_warn must be below psi_critical'] } } } });
  render(<ModelHealthPanel />);
  fireEvent.click(await screen.findByText('Alert thresholds'));
  fireEvent.change(screen.getByLabelText('Feature PSI warn'), { target: { value: '0.5' } });
  fireEvent.change(screen.getByLabelText('Why (10+ chars)'), { target: { value: 'Testing the limits' } });
  fireEvent.click(screen.getByText('Save thresholds'));
  expect(await screen.findByText(/psi_warn must be below psi_critical/)).toBeInTheDocument();
  expect(mockPut).toHaveBeenCalledWith('/model-monitoring/settings', expect.objectContaining({ psi_warn: 0.5, note: 'Testing the limits' }));
});

test('shows the shadow-model comparison when a challenger is active', async () => {
  route({ shadow: { active: true, shadow_version: 'v4', primary_version: 'v3', risk_level_agreement_rate: 0.93, n_compared: 400, mean_absolute_score_diff: 2.1 } });
  render(<ModelHealthPanel />);
  expect(await screen.findByText(/Challenger v4 vs v3: risk-level agreement 93.0% over 400 comparisons/)).toBeInTheDocument();
});
