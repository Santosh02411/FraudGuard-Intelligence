import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import FeedbackPage from './FeedbackPage';

const mockGet = jest.fn(); const mockPost = jest.fn();
jest.mock('../context/AuthContext', () => ({ api: { get: (...a) => mockGet(...a), post: (...a) => mockPost(...a) } }));

const readiness = (o = {}) => ({ verified_fraud: 4, verified_legitimate: 25, minimum_per_class: 20, ready: false, missing: ['16 more verified fraud label(s)'], bias_note: 'Verified labels come from reviewed alerts, so they are selection-biased.', ...o });
const label = { id: 3, transaction_id: 88, label: 'fraud', source: 'manual_review', status: 'proposed', proposed_by_username: 'ana', evidence_note: 'Customer confirmed' };
const ds = { id: 1, n_rows: 300, content_sha256: 'a'.repeat(64), composition: { verified_fraud: 20, verified_legitimate: 30, presumed_legitimate_rows: 250, fraud_rate: 0.0667 } };
const runs = [{ id: 9, dataset_id: 1, status: 'pending_approval' }, { id: 8, dataset_id: 1, status: 'candidate_ready', candidate_version: 'v7' }];

function route(r = readiness()) {
  mockGet.mockImplementation((url) => {
    if (url === '/feedback/retraining/readiness') return Promise.resolve({ data: r });
    if (url === '/feedback/labels') return Promise.resolve({ data: { labels: [label], total: 1 } });
    if (url === '/feedback/retraining/datasets') return Promise.resolve({ data: { datasets: [ds] } });
    if (url === '/feedback/retraining/runs') return Promise.resolve({ data: { runs } });
    return Promise.reject(new Error(`unmocked ${url}`));
  });
}
beforeEach(() => { jest.clearAllMocks(); route(); mockPost.mockResolvedValue({ data: {} }); window.prompt = jest.fn(() => 'Checked the evidence'); });

test('states what is missing, keeps presumed rows distinct from verified, and warns that labels are biased', async () => {
  render(<FeedbackPage />);
  expect(await screen.findByTestId('readiness')).toHaveTextContent('Missing: 16 more verified fraud label(s)');
  expect(screen.getByText(/selection-biased/)).toBeInTheDocument();
  expect(await screen.findByText(/250 presumed legitimate \(not verified\)/)).toBeInTheDocument();
  expect(screen.getByText('Build dataset')).toBeDisabled();
});

test('verifying a label asks for a note and calls the API', async () => {
  render(<FeedbackPage />);
  fireEvent.click(await screen.findByLabelText('Verify label 3'));
  await waitFor(() => expect(mockPost).toHaveBeenCalledWith('/feedback/labels/3/verify', { note: 'Checked the evidence' }));
});

test('a self-verification refusal from the server is shown to the user', async () => {
  mockPost.mockRejectedValueOnce({ response: { data: { error: 'A different investigator must verify this label (four-eyes)' } } });
  render(<FeedbackPage />);
  fireEvent.click(await screen.findByLabelText('Verify label 3'));
  expect(await screen.findByRole('alert')).toHaveTextContent('different investigator');
});

test('runs: pending ones can be approved; a finished candidate is clearly NOT serving', async () => {
  render(<FeedbackPage />);
  expect(await screen.findByText(/Candidate saved but NOT serving/)).toBeInTheDocument();
  fireEvent.click(screen.getByLabelText('Approve run 9'));
  await waitFor(() => expect(mockPost).toHaveBeenCalledWith('/feedback/retraining/runs/9/approve', { note: 'Checked the evidence' }));
});

test('building a dataset needs readiness and a reason', async () => {
  route(readiness({ ready: true, missing: [], verified_fraud: 22 }));
  render(<FeedbackPage />);
  const btn = await screen.findByText('Build dataset');
  expect(btn).toBeDisabled();
  fireEvent.change(screen.getByLabelText(/Reason for this dataset/), { target: { value: 'Autumn retrain from labels' } });
  expect(btn).not.toBeDisabled();
  fireEvent.click(btn);
  await waitFor(() => expect(mockPost).toHaveBeenCalledWith('/feedback/retraining/datasets', { note: 'Autumn retrain from labels' }));
});
