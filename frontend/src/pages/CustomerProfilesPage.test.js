import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import CustomerProfilesPage from './CustomerProfilesPage';

const mockGet = jest.fn();
jest.mock('../context/AuthContext', () => ({ api: { get: (...a) => mockGet(...a) } }));

const list = { profiles: [{ user_id: 7, username: 'alice', score: 61, band: 'high', confidence: 'high', top_factors: [{ name: 'spending', contribution: 18, headline: 'Largest transaction is 12x the median' }], transactions_considered: 40 }], scanned: 1, scan_cap: 200, truncated: false };
const detail = { profile: { user_id: 7, username: 'alice', score: 61, band: 'high', confidence: 'high', notes: [], coverage: { components_scored: 5, components_total: 6, transactions_considered: 40, history_days: 90 },
  factors: [{ name: 'spending', weight: 20, status: 'ok', score: 90, contribution: 18, evidence: ['Largest transaction is 12x the median'] }, { name: 'velocity', weight: 20, status: 'insufficient_data', score: null, evidence: ['Needs at least 5 transactions'] }],
  disclaimer: 'Analyst aid only. Not used by live scoring, never blocks or declines a transaction.' } };

beforeEach(() => {
  jest.clearAllMocks();
  mockGet.mockImplementation((url) => (url === '/customer-profiles' ? Promise.resolve({ data: list }) : Promise.resolve({ data: detail })));
});

test('lists ranked accounts with the reasons, and opens an explained profile', async () => {
  render(<CustomerProfilesPage />);
  expect(await screen.findByText('alice')).toBeInTheDocument();
  expect(screen.getByText(/does not affect live scoring/)).toBeInTheDocument();
  fireEvent.click(screen.getByText('alice'));
  expect(await screen.findByLabelText('Risk profile for alice')).toBeInTheDocument();
  expect(screen.getByText('not enough data')).toBeInTheDocument();
  expect(screen.getByRole('img', { name: /Spending score 90 out of 100/ })).toBeInTheDocument();
  expect(screen.getByText(/never blocks or declines/)).toBeInTheDocument();
});

test('the band filter is sent to the API', async () => {
  render(<CustomerProfilesPage />);
  await screen.findByText('alice');
  fireEvent.change(screen.getByLabelText('Show'), { target: { value: 'high' } });
  await waitFor(() => expect(mockGet).toHaveBeenCalledWith('/customer-profiles', { params: { limit: 50, min_band: 'high' } }));
});

test('a load failure is shown with a retry', async () => {
  mockGet.mockRejectedValueOnce({ response: { data: { error: 'boom' } } });
  render(<CustomerProfilesPage />);
  expect(await screen.findByText(/boom/)).toBeInTheDocument();
});
