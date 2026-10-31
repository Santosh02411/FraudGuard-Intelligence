import React from 'react';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import ModelPerformancePage from './ModelPerformancePage';

const mockGet = jest.fn();
jest.mock('../context/AuthContext', () => ({ api: { get: (...a) => mockGet(...a) } }));
jest.mock('../utils/download', () => ({ downloadBlobResponse: jest.fn(), downloadJson: jest.fn() }));
const { downloadBlobResponse, downloadJson } = require('../utils/download');

const m = (o = {}) => ({ transactions: 100, flagged: 20, reviewed: 16, unreviewed: 4, confirmed_fraud: 12, false_positives: 4, missed_candidates: 3, presumed_legitimate: 70, review_coverage: 0.8, precision: 0.75, precision_ci: [0.51, 0.9], recall_estimate: 0.8, recall_ci: [0.55, 0.93], false_positive_rate_estimate: 0.054, fpr_ci: [0.02, 0.13], pr_auc: 0.71, pr_auc_reviewed_only: 0.8, pr_auc_baseline: 0.15, low_sample: false, ...o });
const report = (over = {}) => ({
  window_days: 90, overall: m(),
  feedback: { flagged_predictions: 20, unreviewed_predictions: 4, unreviewed_older_than_24h: 3, unreviewed_older_than_7d: 1, oldest_unreviewed_hours: 200, confirmed_outcomes: 16, confirmed_fraud: 12, false_positives: 4, unflagged_disputes: 3, review_coverage: 0.8 },
  over_time: [{ week: '2026-09-07', ...m(), recall_estimate: null }, { week: '2026-09-14', ...m({ low_sample: true }) }],
  versions: [{ version: 'v1', first_seen: '2026-08-01T00:00:00Z', ...m({ precision: 0.4 }) }, { version: 'v2', first_seen: '2026-09-10T00:00:00Z', ...m() }],
  version_comparison: { current: 'v2', previous: 'v1', delta: { precision: 0.35, pr_auc: 0.1 }, precision_difference_significant: false, note: 'Versions saw different traffic.' },
  breakdowns: { risk_band: [{ key: 'high', ...m() }], category: [{ key: 'travel', ...m({ low_sample: true }) }], merchant: [], customer_cohort: [] },
  caveats: ['Precision uses analyst-reviewed alerts only.'], ...over,
});

beforeEach(() => { jest.clearAllMocks(); mockGet.mockResolvedValue({ data: report() }); });

test('shows headline metrics with intervals, the review backlog, and the caveats', async () => {
  render(<ModelPerformancePage />);
  const p = await screen.findByTestId('metric-Precision');
  expect(within(p).getByText('75.0%')).toBeInTheDocument();
  expect(within(p).getByText(/95% CI 51–90%/)).toBeInTheDocument();
  expect(screen.getByTestId('unreviewed')).toHaveTextContent('4');
  expect(screen.getByText(/3 over 24h · 1 over 7d · oldest 200h/)).toBeInTheDocument();
  expect(screen.getByText(/Precision uses analyst-reviewed alerts only/)).toBeInTheDocument();
});

test('a null recall week is a gap in the chart, not a zero, and low-sample points are hollow', async () => {
  render(<ModelPerformancePage />);
  await screen.findByTestId('series-precision');
  expect(screen.getByTestId('series-recall_estimate').querySelectorAll('circle')).toHaveLength(1);
  expect(screen.getByTestId('series-precision').querySelectorAll('circle[fill="none"]')).toHaveLength(1);
});

test('version comparison refuses to overclaim when the sample is small', async () => {
  render(<ModelPerformancePage />);
  expect(await screen.findByTestId('comparison')).toHaveTextContent(/v2 vs previous v1: precision \+35.0 pts/);
  expect(screen.getByTestId('comparison')).toHaveTextContent(/Not enough reviewed cases/);
});

test('breakdown tabs switch dimension and flag low-n segments', async () => {
  render(<ModelPerformancePage />);
  await screen.findByText('high');
  fireEvent.click(screen.getByRole('tab', { name: 'Category' }));
  expect(screen.getByText('travel')).toBeInTheDocument();
  expect(screen.getByText('low n')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('tab', { name: 'Merchant' }));
  expect(screen.getByText(/No flagged transactions/)).toBeInTheDocument();
});

test('changing the window reloads; exports use the API csv and the loaded JSON', async () => {
  mockGet.mockImplementation((url, opts) => Promise.resolve(opts?.params?.format === 'csv' ? { data: 'csv', headers: {} } : { data: report() }));
  render(<ModelPerformancePage />);
  await screen.findByTestId('metric-Precision');
  fireEvent.change(screen.getByLabelText('Window'), { target: { value: '30' } });
  await waitFor(() => expect(mockGet).toHaveBeenCalledWith('/admin/model-performance', { params: { days: 30, maturity_days: 30 } }));
  fireEvent.click(screen.getByRole('button', { name: /CSV/ }));
  await waitFor(() => expect(downloadBlobResponse).toHaveBeenCalled());
  expect(mockGet).toHaveBeenCalledWith('/admin/model-performance', { params: { days: 30, maturity_days: 30, format: 'csv' }, responseType: 'blob' });
  fireEvent.click(screen.getByRole('button', { name: /JSON report/ }));
  expect(downloadJson).toHaveBeenCalledWith(expect.objectContaining({ window_days: 90 }), 'model-performance.json');
});

test('an API failure is shown with a retry', async () => {
  mockGet.mockRejectedValueOnce({ response: { data: { error: 'boom' } } });
  render(<ModelPerformancePage />);
  expect(await screen.findByText('boom')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: /Retry/ }));
  expect(await screen.findByTestId('metric-Precision')).toBeInTheDocument();
});
