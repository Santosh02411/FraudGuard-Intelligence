import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import RiskPolicyPanel from './RiskPolicyPanel';

const mockGet = jest.fn();
const mockPost = jest.fn();
const mockPut = jest.fn();
jest.mock('../../context/AuthContext', () => ({
  api: { get: (...a) => mockGet(...a), post: (...a) => mockPost(...a), put: (...a) => mockPut(...a) },
}));

const policy = {
  active: { version: 2, medium_threshold: 10, high_threshold: 50, review_capacity_per_day: 40 },
  history: [{ version: 2, medium_threshold: 10, high_threshold: 50, note: 'baseline', created_at: '2026-10-01T00:00:00Z' }],
  limits: { mediumMin: 0.5, mediumMax: 90, highMax: 99, minGap: 5 },
  score_meaning: 'A score is the calibrated probability of fraud x 100.',
};
const calibration = {
  status: 'drifting',
  status_explanation: 'Outside interval.',
  buckets: [{ score_range: '80-100', reviewed_alerts: 40, confirmed_fraud: 20, mean_predicted_probability: 0.9, observed_fraud_rate: 0.5, observed_95ci: [0.35, 0.65], consistent_with_prediction: false }],
  coverage_note: 'coverage note',
  unflagged_model_scored_transactions: { n: 100, customer_disputed: 3 },
  by_decision_path: { hard_rule_override: { alerts: 4, confirmed_fraud: 4, false_positives: 0, precision_of_reviewed_alerts: 1 } },
  hard_rule_overrides: { overrides_with_alert: 4, model_would_not_have_flagged: 2, of_those_confirmed_fraud: 2, of_those_false_positives: 0 },
};
const sim = {
  window_days: 30, warnings: ['Labels only exist for scores >= 8'],
  current: { flagged: 10, confirmed_fraud_caught: 6, confirmed_fraud_missed: 1, false_positives: 4 },
  candidate: { flagged: 15, confirmed_fraud_caught: 7, confirmed_fraud_missed: 0, false_positives: 8 },
  delta: { flagged: 5, confirmed_fraud_caught: 1, confirmed_fraud_missed: -1, false_positives: 4 },
  method_note: 'note',
};

beforeEach(() => {
  jest.clearAllMocks();
  mockGet.mockImplementation((url) => Promise.resolve({ data: url.endsWith('calibration') ? calibration : policy }));
});

test('shows score meaning, calibration status and hard-rule path separately', async () => {
  render(<RiskPolicyPanel />);
  expect(await screen.findByText(/calibrated probability of fraud/)).toBeInTheDocument();
  expect(screen.getByTestId('calibration-status')).toHaveTextContent('Scores no longer match outcomes');
  expect(screen.getByText('hard rule override')).toBeInTheDocument();
});

test('simulation shows missed fraud and legitimate flagged deltas', async () => {
  mockPost.mockResolvedValue({ data: sim });
  render(<RiskPolicyPanel />);
  fireEvent.change(await screen.findByLabelText('Review threshold'), { target: { value: '5' } });
  fireEvent.click(screen.getByText(/Simulate on last/));
  const box = await screen.findByTestId('simulation');
  expect(box).toHaveTextContent('Confirmed fraud missed');
  expect(box).toHaveTextContent('Legitimate transactions flagged');
  expect(box).toHaveTextContent('Labels only exist');
  expect(mockPost).toHaveBeenCalledWith('/admin/risk-policy/simulate', expect.objectContaining({ medium_threshold: 5, days: 30 }));
});

test('saving requires a note and sends it with the thresholds', async () => {
  mockPut.mockResolvedValue({ data: {} });
  const onMessage = jest.fn();
  render(<RiskPolicyPanel onMessage={onMessage} />);
  const save = await screen.findByText('Save as new version');
  expect(save).toBeDisabled();
  fireEvent.change(screen.getByLabelText('Review threshold'), { target: { value: '8' } });
  fireEvent.change(screen.getByLabelText('Change note'), { target: { value: 'Capacity increased, lowering review line' } });
  expect(save).toBeEnabled();
  fireEvent.click(save);
  await waitFor(() => expect(mockPut).toHaveBeenCalledWith('/admin/risk-policy', expect.objectContaining({ medium_threshold: 8, note: 'Capacity increased, lowering review line' })));
  await waitFor(() => expect(onMessage).toHaveBeenCalled());
});
