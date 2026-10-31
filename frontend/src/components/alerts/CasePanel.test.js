import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import CasePanel from './CasePanel';

const mockGet = jest.fn();
const mockPost = jest.fn();
const mockPatch = jest.fn();
const mockDelete = jest.fn();
jest.mock('../../context/AuthContext', () => ({
  api: { get: (...a) => mockGet(...a), post: (...a) => mockPost(...a), patch: (...a) => mockPatch(...a), delete: (...a) => mockDelete(...a) },
}));
jest.mock('../../utils/download', () => ({ downloadBlobResponse: jest.fn() }));
const { downloadBlobResponse } = require('../../utils/download');

const me = { id: 9, username: 'me', role: 'admin' };
const base = { id: 4, status: 'open', severity: 'high', version: 3, resolved: 0, amount: 100, due_at: '2030-01-01T00:00:00Z', escalation_level: 0, claim: null };
const caseData = (alert, extra = {}) => ({ data: { alert, comments: [], evidence: [], activity: [], reasons: [], ...extra } });

let onChange;
beforeEach(() => { jest.clearAllMocks(); onChange = jest.fn(); });

test('nobody working: offers to start; claiming updates the alert', async () => {
  mockGet.mockResolvedValue(caseData(base));
  mockPost.mockResolvedValue({ data: { alert: { ...base, claim: { user_id: 9, username: 'me', expires_at: '2030-01-01T00:15:00Z' } } } });
  render(<CasePanel alert={base} user={me} onAlertChange={onChange} />);
  fireEvent.click(await screen.findByRole('button', { name: /start working/i }));
  await waitFor(() => expect(mockPost).toHaveBeenCalledWith('/alerts/4/claim', {}));
  expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ claim: expect.objectContaining({ username: 'me' }) }));
});

test('another investigator holds it: warned, controls disabled, takeover needs a reason', async () => {
  const held = { ...base, claim: { user_id: 3, username: 'dana', expires_at: '2030-01-01T00:15:00Z' } };
  mockGet.mockResolvedValue(caseData(held));
  mockPost.mockResolvedValue({ data: { alert: { ...held, claim: { user_id: 9, username: 'me', expires_at: 'x' } } } });
  render(<CasePanel alert={held} user={me} onAlertChange={onChange} />);
  expect(await screen.findByText(/Being worked by/)).toHaveTextContent('dana');
  expect(screen.getByLabelText('Investigation status')).toBeDisabled();
  fireEvent.click(screen.getByText(/Take over this case/));
  const confirm = screen.getByRole('button', { name: 'Take over' });
  expect(confirm).toBeDisabled();
  fireEvent.change(screen.getByLabelText('Takeover reason'), { target: { value: 'dana is out today' } });
  fireEvent.click(confirm);
  await waitFor(() => expect(mockPost).toHaveBeenCalledWith('/alerts/4/claim', { force: true, reason: 'dana is out today' }));
});

test('a rejected action because of a lock refreshes the alert and shows the server message', async () => {
  mockGet.mockResolvedValue(caseData(base));
  const current = { ...base, claim: { user_id: 3, username: 'dana', expires_at: 'x' } };
  mockPatch.mockRejectedValue({ response: { data: { error: 'This case is being worked by dana', details: { code: 'ALERT_LOCKED', current } } } });
  render(<CasePanel alert={base} user={me} onAlertChange={onChange} />);
  fireEvent.change(await screen.findByLabelText('Investigation status'), { target: { value: 'pending_info' } });
  expect(await screen.findByRole('alert')).toHaveTextContent('being worked by dana');
  expect(onChange).toHaveBeenCalledWith(current);
});

test('comments post and reload; evidence uploads as a raw file and downloads', async () => {
  mockGet.mockResolvedValueOnce(caseData(base)).mockResolvedValue(caseData(base, {
    comments: [{ id: 1, body: 'Called customer', author_username: 'me', created_at: '2026-10-25T10:00:00Z' }],
    evidence: [{ id: 5, filename: 'shot.png', size_bytes: 2048, uploaded_by_username: 'me', sha256: 'a'.repeat(64) }],
  }));
  mockPost.mockResolvedValue({ data: {} });
  render(<CasePanel alert={base} user={me} onAlertChange={onChange} />);
  fireEvent.change(await screen.findByLabelText('New note'), { target: { value: 'Called customer' } });
  fireEvent.click(screen.getByRole('button', { name: 'Add note' }));
  await waitFor(() => expect(mockPost).toHaveBeenCalledWith('/alerts/4/comments', { body: 'Called customer' }));
  expect(await screen.findByText('Called customer')).toBeInTheDocument();

  const file = new File([new Uint8Array([1, 2, 3])], 'shot.png', { type: 'image/png' });
  fireEvent.change(screen.getByLabelText('Attach evidence'), { target: { files: [file] } });
  await waitFor(() => expect(mockPost).toHaveBeenCalledWith('/alerts/4/evidence', file, { params: { filename: 'shot.png' }, headers: { 'Content-Type': 'application/octet-stream' } }));

  mockGet.mockResolvedValueOnce({ data: new Blob(['x']), headers: {} });
  fireEvent.click(await screen.findByRole('button', { name: 'Download' }));
  await waitFor(() => expect(downloadBlobResponse).toHaveBeenCalled());
});

test('resolved confirmed-fraud cases expose outcome amounts and save them with the version', async () => {
  const resolved = { ...base, resolved: 1, status: 'resolved', verdict: 'confirmed_fraud', loss_amount: 100, recovered_amount: null, prevented_amount: null };
  mockGet.mockResolvedValue(caseData(resolved));
  mockPatch.mockResolvedValue({ data: { alert: { ...resolved, recovered_amount: 40 } } });
  render(<CasePanel alert={resolved} user={me} onAlertChange={onChange} />);
  fireEvent.change(await screen.findByLabelText('Recovered amount'), { target: { value: '40' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save amounts' }));
  await waitFor(() => expect(mockPatch).toHaveBeenCalledWith('/alerts/4/outcome', { loss_amount: 100, recovered_amount: 40, prevented_amount: null, version: 3 }));
  expect(screen.queryByRole('button', { name: /start working/i })).not.toBeInTheDocument();
});
