import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import CasesPage from './CasesPage';
import CaseDetailPage from './CaseDetailPage';
import CreateCaseButton from '../components/cases/CreateCaseButton';

const mockGet = jest.fn(); const mockPost = jest.fn(); const mockPatch = jest.fn(); const mockDelete = jest.fn();
jest.mock('../context/AuthContext', () => ({ api: { get: (...a) => mockGet(...a), post: (...a) => mockPost(...a), patch: (...a) => mockPatch(...a), delete: (...a) => mockDelete(...a) } }));

const inv = (o = {}) => ({ id: 7, title: 'Ring around devA', summary: 'Two accounts, one device', status: 'open', priority: 'high', outcome: null, outcome_note: null, assigned_to: null, assignee_username: null, created_by_username: 'admin', version: 3, updated_at: '2026-10-20T10:00:00Z', ...o });
const detail = (o = {}) => ({
  investigation: inv(o.inv), alerts: [{ id: 11, severity: 'high', status: 'open', verdict: null, resolved: 0 }], transactions: [{ id: 21, username: 'alice', amount: 99, merchant: 'Shop', risk_level: 'high' }],
  links: { users: [{ id: 1, username: 'alice' }], devices: [{ value: 'abcdef123', label: 'abcd…23', transactions: 2 }], ips: [{ value: '198.51.100.7', transactions: 2 }], disputes: [{ id: 5, status: 'opened', amount_disputed: 99 }], related_cases: [{ case_id: 9, via: ['same device'] }] },
  summary: { exposure_amount: 99, accounts: 1, devices: 1, ips: 1, open_alerts: 1, resolved_alerts: 0 }, ...o.rest,
});
function route(over = {}) {
  mockGet.mockImplementation((url) => {
    if (url === '/investigations/7') return Promise.resolve({ data: detail(over) });
    if (url === '/investigations/7/timeline') return Promise.resolve({ data: { timeline: [{ at: '2026-10-20T09:00:00Z', source: 'case', kind: 'created', actor: 'admin', summary: 'Case created' }, { at: '2026-10-20T09:30:00Z', source: 'dispute', kind: 'dispute_opened', summary: 'Dispute opened for $99.00' }] } });
    if (url === '/investigations/7/suggestions') return Promise.resolve({ data: { caution: 'Leads, not proof.', suggestions: [{ alert_id: 31, amount: 40, merchant: 'Other', reasons: ['same device'] }] } });
    if (url === '/admin/users') return Promise.resolve({ data: { users: [{ id: 1, username: 'admin', role: 'admin' }, { id: 2, username: 'cust', role: 'user' }] } });
    return Promise.reject(new Error(`unmocked ${url}`));
  });
}
const renderDetail = () => render(<MemoryRouter initialEntries={['/cases/7']}><Routes><Route path="/cases/:id" element={<CaseDetailPage />} /></Routes></MemoryRouter>);

beforeEach(() => { jest.clearAllMocks(); mockPost.mockResolvedValue({ data: {} }); mockPatch.mockResolvedValue({ data: {} }); mockDelete.mockResolvedValue({ data: {} }); });

describe('list', () => {
  test('shows cases, filters, and the unassigned marker', async () => {
    mockGet.mockResolvedValue({ data: { cases: [{ ...inv(), alert_count: 2, transaction_count: 3 }], pagination: { page: 1, total_pages: 1 } } });
    render(<MemoryRouter><CasesPage /></MemoryRouter>);
    expect(await screen.findByText('#7 Ring around devA')).toBeInTheDocument();
    expect(screen.getByText('unassigned')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'closed' } });
    await waitFor(() => expect(mockGet).toHaveBeenLastCalledWith('/investigations', { params: { page: 1, limit: 20, status: 'closed' } }));
  });
});

describe('create button', () => {
  test('posts the selected alerts and explains a conflict with a link to the other case', async () => {
    mockPost.mockRejectedValueOnce({ response: { data: { error: 'alert 11 already belongs to case #4', details: { code: 'ITEM_IN_OTHER_CASE', caseId: 4 } } } });
    render(<MemoryRouter><CreateCaseButton alertIds={[11, 12]} /></MemoryRouter>);
    fireEvent.click(screen.getByRole('button', { name: /Create case/ }));
    fireEvent.change(screen.getByLabelText('Case title'), { target: { value: 'Shared device' } });
    fireEvent.click(screen.getByRole('button', { name: /Create from 2 item/ }));
    await waitFor(() => expect(mockPost).toHaveBeenCalledWith('/investigations', { title: 'Shared device', alertIds: [11, 12], transactionIds: [] }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/already belongs to case #4/);
    expect(screen.getByRole('link', { name: 'Open case #4' })).toHaveAttribute('href', '/cases/4');
  });
});

describe('detail', () => {
  test('shows contents, links, related cases and a chronological timeline', async () => {
    route(); renderDetail();
    expect(await screen.findByText('#7 Ring around devA')).toBeInTheDocument();
    expect(screen.getByText(/Alert #11/)).toBeInTheDocument();
    expect(screen.getByText(/abcd…23 \(2\)/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /#9 \(same device\)/ })).toHaveAttribute('href', '/cases/9');
    const items = screen.getAllByRole('listitem').map((li) => li.textContent);
    expect(items.findIndex((t) => /Case created/.test(t))).toBeLessThan(items.findIndex((t) => /Dispute opened/.test(t)));
    expect(screen.getByText('Leads, not proof.')).toBeInTheDocument();
  });

  test('assignment and status send the case version for optimistic locking', async () => {
    route(); renderDetail();
    fireEvent.change(await screen.findByLabelText('Assignee'), { target: { value: '1' } });
    await waitFor(() => expect(mockPatch).toHaveBeenCalledWith('/investigations/7/assign', { assigneeId: 1, version: 3 }));
    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'investigating' } });
    await waitFor(() => expect(mockPatch).toHaveBeenCalledWith('/investigations/7/status', { status: 'investigating', version: 3 }));
    expect(screen.queryByRole('option', { name: 'cust' })).toBeNull(); // only investigators are assignable
  });

  test('a stale version reloads and says so instead of silently overwriting', async () => {
    route(); mockPatch.mockRejectedValueOnce({ response: { data: { error: 'changed', details: { code: 'VERSION_CONFLICT' } } } });
    renderDetail();
    fireEvent.change(await screen.findByLabelText('Priority'), { target: { value: 'low' } });
    expect(await screen.findByRole('status')).toHaveTextContent(/Someone else changed this case/);
  });

  test('adding a suggested alert and removing one', async () => {
    route(); renderDetail();
    fireEvent.click(await screen.findByRole('button', { name: 'Add alert #31' }));
    await waitFor(() => expect(mockPost).toHaveBeenCalledWith('/investigations/7/items', { alertIds: [31], version: 3 }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove alert #11' }));
    await waitFor(() => expect(mockDelete).toHaveBeenCalledWith('/investigations/7/items/alert/11', { params: { version: 3 } }));
  });

  test('closing needs an explanation, resolves alerts by default, and inconclusive disables that', async () => {
    route(); renderDetail();
    const submit = await screen.findByRole('button', { name: 'Close case' });
    expect(submit).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Explain the outcome'), { target: { value: 'Same stolen card on both.' } });
    fireEvent.click(submit);
    await waitFor(() => expect(mockPost).toHaveBeenCalledWith('/investigations/7/close', { outcome: 'confirmed_fraud', note: 'Same stolen card on both.', resolve_alerts: true, version: 3 }));
    fireEvent.click(screen.getByLabelText('Inconclusive'));
    expect(screen.getByLabelText(/Also resolve the case's open alerts/)).toBeDisabled();
  });

  test('a closed case is read-only apart from a reopen that needs a reason', async () => {
    route({ inv: { status: 'closed', outcome: 'legitimate', outcome_note: 'Customer confirmed all purchases.' } }); renderDetail();
    expect(await screen.findByText(/Closed as/)).toHaveTextContent(/Legitimate activity/);
    expect(screen.queryByLabelText('Add a note')).toBeNull();
    expect(screen.queryByRole('button', { name: /Remove alert/ })).toBeNull();
    const btn = screen.getByRole('button', { name: 'Reopen' });
    expect(btn).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Reason for reopening'), { target: { value: 'New chargeback evidence' } });
    fireEvent.click(btn);
    await waitFor(() => expect(mockPatch).toHaveBeenCalledWith('/investigations/7/status', { status: 'open', reason: 'New chargeback evidence', version: 3 }));
  });
});
