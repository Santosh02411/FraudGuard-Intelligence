import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import VerificationPage from './VerificationPage';

const mockGet = jest.fn(); const mockPost = jest.fn(); const mockPut = jest.fn();
jest.mock('../context/AuthContext', () => ({ api: { get: (...a) => mockGet(...a), post: (...a) => mockPost(...a), put: (...a) => mockPut(...a) } }));

const eff = {
  window_days: 30, total_transactions: 800,
  challenges: { issued: 40, verified: 25, failed: 5, abandoned: 6, expired: 2, pending: 2, resolved: 38, completion_rate: 0.6579, abandonment_rate: 0.2105, failure_rate: 0.1316, per_1000_transactions: 50, median_seconds_to_complete: 42, replay_attempts_rejected: 3 },
  fraud_loss: { stopped_by_challenge: { count: 4, amount: 3200 }, passed_challenge: { count: 1, amount: 400 }, flagged_not_challenged: { count: 2, amount: 900 }, stopped_by_decline: { count: 0, amount: 0 }, all_completed_fraud: { count: 3, amount: 1300 } },
  friction: { legit_confirmed_challenged: 9, legit_confirmed_not_completed: 2, legit_confirmed_not_completed_amount: 150, unlabelled_challenged: 20, unlabelled_not_completed: 6, declined: 0 },
  caveats: ['Observational, not an experiment: challenged and unchallenged groups differ.'],
};
const policy = { active: { version: 2, mode: 'advisory', actions: { low: 'approve', medium: 'challenge', high: 'challenge' }, min_amount: null, ttl_seconds: 300 } };

function route() {
  mockGet.mockImplementation((url) => {
    if (url === '/verification/policy') return Promise.resolve({ data: policy });
    if (url === '/verification/effectiveness') return Promise.resolve({ data: eff });
    if (url === '/verification/challenges') return Promise.resolve({ data: { challenges: [{ id: 5, transaction_id: 9, risk_level: 'medium', status: 'expired', replay_attempts: 1 }] } });
    return Promise.reject(new Error(`unmocked ${url}`));
  });
}
beforeEach(() => { jest.clearAllMocks(); route(); mockPut.mockResolvedValue({ data: {} }); });

test('shows measured effects with the honest caveats and unlabelled outcomes kept separate', async () => {
  render(<VerificationPage />);
  expect(await screen.findByText('$3,200')).toBeInTheDocument();
  expect(screen.getByText(/fraud or a customer who gave up — unknown/)).toBeInTheDocument();
  expect(screen.getByText(/Observational, not an experiment/)).toBeInTheDocument();
  expect(screen.getByText(/1 replay\(s\) rejected/)).toBeInTheDocument();
});

test('guard rails in the editor: low risk can only be approved; enforce needs a note and explicit confirmation', async () => {
  render(<VerificationPage />);
  const low = await screen.findByLabelText('low risk');
  expect([...low.options].map((o) => o.value)).toEqual(['approve']);
  const med = screen.getByLabelText('medium risk');
  expect([...med.options].map((o) => o.value)).not.toContain('decline');
  fireEvent.change(screen.getByLabelText('Mode'), { target: { value: 'enforce' } });
  fireEvent.change(screen.getByLabelText('Change note'), { target: { value: 'Pilot on high risk' } });
  const save = screen.getByText('Save policy');
  expect(save).toBeDisabled();
  fireEvent.click(screen.getByLabelText(/I understand this changes real outcomes/));
  expect(save).not.toBeDisabled();
  fireEvent.click(save);
  await waitFor(() => expect(mockPut).toHaveBeenCalledWith('/verification/policy', expect.objectContaining({ mode: 'enforce', confirm_enforce: true, note: 'Pilot on high risk' })));
});

test('preview reports intent and known outcomes of those who would be challenged', async () => {
  mockPost.mockResolvedValue({ data: { evaluated: 100, actions: { challenge: 12, decline: 1, approve: 87 }, share_challenged: 0.12, share_declined: 0.01, challenged_labels: { fraud: 3, legit: 4, unknown: 5 }, caveats: ['Labels are analyst verdicts and disputes only.'] } });
  render(<VerificationPage />);
  fireEvent.click(await screen.findByText('Preview on last 30 days'));
  expect(await screen.findByLabelText('Policy preview')).toHaveTextContent('12 would be challenged');
  expect(screen.getByLabelText('Policy preview')).toHaveTextContent('4 confirmed legitimate');
});
