import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import RuleLabPage from './RuleLabPage';

const mockGet = jest.fn(); const mockPost = jest.fn();
jest.mock('../context/AuthContext', () => ({ api: { get: (...a) => mockGet(...a), post: (...a) => mockPost(...a) } }));

const sim = {
  evaluated: 100, window_days: 90, labelled: 40, truncated: false, warnings: ['Fewer than 5 positive labels in the window: recall and precision comparisons are not reliable.'],
  current: { flagged: 3, tp: 3, fp: 0, fn: 4, precision: 1, false_positive_rate_estimate: 0, unlabelled_flagged: 0 },
  proposed: { flagged: 9, tp: 7, fp: 2, fn: 0, precision: 0.7778, false_positive_rate_estimate: 0.1, unlabelled_flagged: 0 },
  delta: { flagged: 6, flagged_per_day: 0.07, true_positives: 4, false_positives: 2, missed_fraud: -4, precision: -0.2222 },
  newly_flagged: { count: 6, likely_fraud: 4, likely_legitimate: 2, unlabelled: 0, sample: [{ id: 5, merchant: 'GiftHub', amount: 50, label: 'FN' }] },
  no_longer_flagged: { count: 0, likely_fraud: 0, likely_legitimate: 0, unlabelled: 0, sample: [] },
  caveats: ['Negative labels for never-flagged traffic are PRESUMED.'],
};
const proposal = (o = {}) => ({ id: 3, title: 'Block GiftHub', status: 'draft', rule_changes: [{ op: 'add', rule_type: 'blacklist_merchant', value: 'GiftHub' }], policy_change: null, simulation: sim, simulated_current: true, ...o });

function route(p = proposal()) {
  mockGet.mockImplementation((url) => {
    if (url === '/rule-proposals/state') return Promise.resolve({ data: { rule_version: 4, policy: { version: 2, medium_threshold: 10, high_threshold: 50 }, active_proposals: [], require_proposal: false } });
    if (url === '/rule-proposals') return Promise.resolve({ data: { proposals: [{ ...p, simulation: null }] } });
    if (url === '/rule-proposals/3') return Promise.resolve({ data: { proposal: p, events: [{ id: 1, created_at: '2026-10-20T10:00:00Z', actor_username: 'admin', summary: 'Draft created' }] } });
    return Promise.reject(new Error(`unmocked ${url}`));
  });
}
beforeEach(() => { jest.clearAllMocks(); mockPost.mockResolvedValue({ data: {} }); });

test('simulates a new rule on history and shows current vs proposed with warnings and caveats', async () => {
  route(); mockPost.mockResolvedValue({ data: sim });
  render(<RuleLabPage />);
  expect(await screen.findByText(/rule-set v4/)).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('Value'), { target: { value: 'GiftHub' } });
  fireEvent.click(screen.getByText('Add rule change'));
  expect(screen.getByText('Add blacklist_merchant: GiftHub')).toBeInTheDocument();
  fireEvent.click(screen.getByText('Simulate on history'));
  await waitFor(() => expect(mockPost).toHaveBeenCalledWith('/rule-proposals/simulate', { rule_changes: [{ op: 'add', rule_type: 'blacklist_merchant', value: 'GiftHub' }], policy_change: null }));
  expect(await screen.findByLabelText('Simulation result')).toBeInTheDocument();
  expect(screen.getByText(/Fewer than 5 positive labels/)).toBeInTheDocument();
  expect(screen.getByText('77.8%')).toBeInTheDocument();
  expect(screen.getByText(/PRESUMED/)).toBeInTheDocument();
});

test('approve needs a simulation; activation is offered only once approved', async () => {
  route(proposal({ simulated_current: false, simulation: null }));
  render(<RuleLabPage />);
  fireEvent.click(await screen.findByText(/#3 Block GiftHub/));
  expect(await screen.findByText(/Not simulated yet/)).toBeInTheDocument();
  expect(screen.getByText('Approve')).toBeDisabled();
  expect(screen.queryByText('Activate on live traffic')).toBeNull();
});

test('approved proposal can be activated; active one needs a reason to roll back', async () => {
  route(proposal({ status: 'approved' }));
  const { unmount } = render(<RuleLabPage />);
  fireEvent.click(await screen.findByText(/#3 Block GiftHub/));
  fireEvent.click(await screen.findByText('Activate on live traffic'));
  await waitFor(() => expect(mockPost).toHaveBeenCalledWith('/rule-proposals/3/activate', {}));
  unmount();

  route(proposal({ status: 'active' }));
  render(<RuleLabPage />);
  fireEvent.click(await screen.findByText(/#3 Block GiftHub/));
  const btn = await screen.findByText('Roll back');
  expect(btn).toBeDisabled();
  fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'False positives in week one' } });
  expect(btn).not.toBeDisabled();
  fireEvent.click(btn);
  await waitFor(() => expect(mockPost).toHaveBeenCalledWith('/rule-proposals/3/rollback', { reason: 'False positives in week one' }));
});

test('surfaces a server conflict (stale simulation) instead of failing silently', async () => {
  route();
  mockPost.mockRejectedValue({ response: { data: { error: 'The live rules or risk policy changed after this simulation. Run it again.' } } });
  render(<RuleLabPage />);
  fireEvent.click(await screen.findByText(/#3 Block GiftHub/));
  fireEvent.click(await screen.findByText('Approve'));
  expect(await screen.findByText(/changed after this simulation/)).toBeInTheDocument();
});
