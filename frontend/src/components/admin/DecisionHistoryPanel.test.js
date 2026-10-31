import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import DecisionHistoryPanel from './DecisionHistoryPanel';

const mockGet = jest.fn();
const mockPost = jest.fn();
jest.mock('../../context/AuthContext', () => ({ api: { get: (...a) => mockGet(...a), post: (...a) => mockPost(...a) } }));

const decision = (over = {}) => ({
  seq: 1, decision_type: 'original', applied: true, origin: 'live', decision_source: 'ml', risk_level: 'medium', fraud_score: 31.2, is_fraud: false,
  model_version: 'v9', calibrated: true, ruleset_version: 4, thresholds: { basis: 'risk_policy', policy_version: 2, medium_threshold: 10, high_threshold: 50 },
  reasons: ['Unusual amount'], feature_snapshot: { amount: 20 }, created_at: '2026-10-01T10:00:00Z', ...over,
});
const history = (timeline, chain = { valid: true, records: 1, problems: [] }) => ({ data: { transaction_id: 5, chain, holds: [], timeline } });

beforeEach(() => { jest.clearAllMocks(); });

test('shows source, model, rule set, thresholds, verified chain', async () => {
  mockGet.mockResolvedValue(history([{ kind: 'decision', seq: 1, decision: decision() }]));
  render(<DecisionHistoryPanel transactionId={5} />);
  expect(await screen.findByText('#1 Original decision')).toBeInTheDocument();
  expect(screen.getByText('ML model')).toBeInTheDocument();
  expect(screen.getByText('v9')).toBeInTheDocument();
  expect(screen.getByText('v4')).toBeInTheDocument();
  expect(screen.getByText(/policy v2: medium ≥ 10, high ≥ 50/)).toBeInTheDocument();
  expect(screen.getByRole('status')).toHaveTextContent(/Hash chain verified/);
});

test('a broken chain, a backfilled record and a redacted snapshot are all stated plainly', async () => {
  mockGet.mockResolvedValue(history(
    [{ kind: 'decision', seq: 1, decision: decision({ origin: 'backfill', ruleset_version: null, thresholds: { basis: 'unknown', note: 'not captured' }, feature_snapshot: null, redacted_at: '2026-10-02T00:00:00Z' }) }],
    { valid: false, records: 1, problems: ['seq 1: contents do not match record_hash'] }
  ));
  render(<DecisionHistoryPanel transactionId={5} />);
  expect(await screen.findByText(/reconstructed, inputs not captured/)).toBeInTheDocument();
  expect(screen.getByText(/Hash chain BROKEN/)).toBeInTheDocument();
  fireEvent.click(screen.getByText(/Show feature snapshot/));
  expect(screen.getByText(/Redacted by the retention policy/)).toBeInTheDocument();
});

test('rescore needs a reason, sends apply, then reloads the history', async () => {
  mockGet.mockResolvedValue(history([{ kind: 'decision', seq: 1, decision: decision() }]));
  mockPost.mockResolvedValue({ data: { recorded_seq: 2, applied: false, changed: { risk_level: { before: 'medium', after: 'high' } } } });
  render(<DecisionHistoryPanel transactionId={5} />);
  const button = await screen.findByRole('button', { name: /Rescore \(record only\)/ });
  expect(button).toBeDisabled();
  fireEvent.change(screen.getByLabelText(/Reason/), { target: { value: 'new model check' } });
  fireEvent.click(button);
  await waitFor(() => expect(mockPost).toHaveBeenCalledWith('/admin/transactions/5/rescore', { reason: 'new model check', apply: false }));
  expect(await screen.findByText(/Recorded as #2 \(not applied\)/)).toBeInTheDocument();
  expect(screen.getByText(/risk_level medium → high/)).toBeInTheDocument();
  expect(mockGet).toHaveBeenCalledTimes(2);
});

test('shows the server error when a rescore is refused', async () => {
  mockGet.mockResolvedValue(history([{ kind: 'decision', seq: 1, decision: decision() }]));
  mockPost.mockRejectedValue({ response: { data: { error: 'The ML service is unavailable' } } });
  render(<DecisionHistoryPanel transactionId={5} />);
  fireEvent.change(await screen.findByLabelText(/Reason/), { target: { value: 'a long enough reason' } });
  fireEvent.click(screen.getByRole('button', { name: /Rescore/ }));
  expect(await screen.findByRole('alert')).toHaveTextContent('The ML service is unavailable');
});
