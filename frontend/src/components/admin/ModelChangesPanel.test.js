import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import ModelChangesPanel from './ModelChangesPanel';

const mockGet = jest.fn();
const mockPost = jest.fn();
jest.mock('../../context/AuthContext', () => ({
  api: { get: (...a) => mockGet(...a), post: (...a) => mockPost(...a) },
  useAuth: () => ({ user: { id: 2, role: 'admin' } }),
}));

const report = {
  gates: [
    { id: 'artifact_integrity', title: 'Artifact integrity', status: 'pass', hard: true, detail: 'ok' },
    { id: 'outcome_evidence', title: 'Outcomes', status: 'insufficient', hard: false, detail: 'no verdicts yet' },
  ],
  summary: { needs_acknowledgement: ['outcome_evidence'], blocking: [] },
};
const pending = (over = {}) => ({ id: 7, action: 'promote', from_version: 'v3', target_version: 'v4', status: 'pending_approval', reason: 'Retrained, reviewed.', requested_by: 1, requested_by_username: 'alice', version: 1, gate_report: report, ...over });

function setup(changes) {
  mockGet.mockImplementation((url) => {
    if (url.endsWith('/checklist')) return Promise.resolve({ data: { checklists: { promote: [{ id: 'gates_reviewed', label: 'I reviewed the gates' }], rollback: [] } } });
    if (url.endsWith('/change-requests')) return Promise.resolve({ data: { changes } });
    if (url.endsWith('/versions')) return Promise.resolve({ data: { active: 'v3', versions: [{ version: 'v3' }, { version: 'v4' }] } });
    return Promise.resolve({ data: { status: 'ok', triggers: [{ name: 'latency_p95', status: 'ok', value: 90, limit: 1500 }] } });
  });
}
beforeEach(() => { jest.clearAllMocks(); mockPost.mockResolvedValue({ data: {} }); });

test('shows serving version, triggers and the history', async () => {
  setup([pending()]);
  render(<ModelChangesPanel />);
  expect(await screen.findByText(/Serving model: v3/)).toBeInTheDocument();
  expect(screen.getByText(/latency_p95/)).toBeInTheDocument();
  expect(screen.getByText(/#7 promote v3 → v4/)).toBeInTheDocument();
  expect(screen.getByText(/requested by alice/)).toBeInTheDocument();
});

test('an approver must acknowledge open gates, and the version is sent for conflict detection', async () => {
  setup([pending()]);
  render(<ModelChangesPanel />);
  await screen.findByText(/#7 promote/);
  fireEvent.change(screen.getByLabelText('Decision note'), { target: { value: 'Looked at the report carefully.' } });
  fireEvent.click(screen.getByLabelText(/I have read and accept: outcome_evidence/));
  fireEvent.click(screen.getByText(/Approve & apply/));
  await waitFor(() => expect(mockPost).toHaveBeenCalledWith('/admin/ml/change-requests/7/approve', {
    note: 'Looked at the report carefully.', acknowledged_gates: ['outcome_evidence'], version: 1,
  }));
});

test('the requester cannot approve their own request in the UI (server enforces it too)', async () => {
  setup([pending({ requested_by: 2 })]);
  render(<ModelChangesPanel />);
  await screen.findByText(/#7 promote/);
  expect(screen.getByText(/Approve & apply/)).toBeDisabled();
  expect(screen.getByText(/a different admin must approve/)).toBeInTheDocument();
});

test('a blocked request shows which gates blocked it', async () => {
  setup([]);
  mockPost.mockRejectedValue({ response: { status: 422, data: { error: 'x', details: { code: 'GATES_BLOCK', gate_report: { summary: { blocking: ['artifact_integrity'] } } } } } });
  render(<ModelChangesPanel />);
  await screen.findByText(/Serving model/);
  fireEvent.change(screen.getByLabelText('Version'), { target: { value: 'v4' } });
  fireEvent.click(screen.getByText(/Run gates & request/));
  expect(await screen.findByRole('alert')).toHaveTextContent('Blocked by gates: artifact_integrity');
});
