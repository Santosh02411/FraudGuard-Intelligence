import React from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import DisputesPage from './DisputesPage';

const mockGet = jest.fn();
const mockPatch = jest.fn();
const mockPost = jest.fn();

let mockUser = { id: 1, username: 'test_user', role: 'user' };

jest.mock('../context/AuthContext', () => ({
  api: { get: (...args) => mockGet(...args), patch: (...args) => mockPatch(...args), post: (...args) => mockPost(...args) },
  useAuth: () => ({ user: mockUser }),
}));

// jest.mock calls above are hoisted above these imports by babel-jest at
// compile time, so DisputesPage picks up the mocked modules regardless of
// this file's source order.

function renderPage() {
  return render(<MemoryRouter><DisputesPage /></MemoryRouter>);
}

function makeDispute(overrides = {}) {
  return {
    id: 1,
    transaction_id: 100,
    status: 'opened',
    amount_disputed: 80,
    reason: 'I did not make this purchase.',
    evidence_note: null,
    resolution_note: null,
    merchant: 'Corner Cafe',
    account_username: 'test_user',
    opened_by_username: 'test_user',
    opened_at: '2026-01-01T12:00:00Z',
    ...overrides,
  };
}

function makeSummary(overrides = {}) {
  return {
    total_disputes: 3,
    by_status: { opened: 1, evidence_submitted: 0, won: 1, lost: 1 },
    total_amount_disputed: 220,
    amount_won: 100,
    amount_lost: 40,
    amount_pending: 80,
    win_rate: 50,
    ...overrides,
  };
}

function makeTransaction(overrides = {}) {
  return {
    id: 200,
    merchant: 'Corner Cafe',
    amount: 45,
    created_at: '2026-01-05T12:00:00Z',
    ...overrides,
  };
}

beforeEach(() => {
  mockGet.mockReset();
  mockPatch.mockReset();
  mockPost.mockReset();
  mockUser = { id: 1, username: 'test_user', role: 'user' };
  window.URL.createObjectURL = jest.fn(() => 'blob:mock-url');
  window.URL.revokeObjectURL = jest.fn();
});

describe('DisputesPage — regular user', () => {
  test('shows a loading state, then the fetched disputes, without a financial summary', async () => {
    mockGet.mockResolvedValue({ data: { disputes: [makeDispute()] } });

    renderPage();
    expect(screen.getByText(/Loading disputes/i)).toBeInTheDocument();

    await waitFor(() => expect(screen.getByText('I did not make this purchase.')).toBeInTheDocument());

    expect(screen.getByText('Corner Cafe')).toBeInTheDocument();
    expect(screen.getByText('$80.00')).toBeInTheDocument();
    expect(screen.getByText('Opened')).toBeInTheDocument();
    // Only the list call — no financial-summary request for a non-admin.
    expect(mockGet).toHaveBeenCalledTimes(1);
    expect(mockGet).toHaveBeenCalledWith('/disputes', { params: {} });
    expect(screen.queryByText('Total Disputes')).not.toBeInTheDocument();
  });

  test('shows an empty state when there are no disputes', async () => {
    mockGet.mockResolvedValue({ data: { disputes: [] } });
    renderPage();
    await waitFor(() => expect(screen.getByText(/No disputes match these filters/i)).toBeInTheDocument());
  });

  test('shows an error state with a working retry', async () => {
    mockGet.mockRejectedValueOnce({ response: { data: { error: 'Failed to load' } } });
    renderPage();
    await waitFor(() => expect(screen.getByText('Failed to load')).toBeInTheDocument());

    mockGet.mockResolvedValueOnce({ data: { disputes: [makeDispute()] } });
    fireEvent.click(screen.getByText(/Retry/i));
    await waitFor(() => expect(screen.getByText('Corner Cafe')).toBeInTheDocument());
  });

  test('does not offer an Update action, since transitions are admin-only', async () => {
    mockGet.mockResolvedValue({ data: { disputes: [makeDispute()] } });
    renderPage();
    await waitFor(() => expect(screen.getByText('Corner Cafe')).toBeInTheDocument());
    expect(screen.queryByText('Update')).not.toBeInTheDocument();
  });

  test('filtering by status re-fetches with the status param', async () => {
    mockGet.mockResolvedValue({ data: { disputes: [makeDispute()] } });
    renderPage();
    await waitFor(() => expect(screen.getByText('Corner Cafe')).toBeInTheDocument());

    fireEvent.click(screen.getByText(/Filters/i));
    fireEvent.change(screen.getByDisplayValue('All'), { target: { value: 'won' } });
    fireEvent.click(screen.getByText('Apply'));

    await waitFor(() => expect(mockGet).toHaveBeenLastCalledWith('/disputes', { params: { status: 'won' } }));
  });

  test('exporting downloads a CSV with no status param when unfiltered', async () => {
    mockGet.mockImplementation((url) => {
      if (url === '/disputes/export') return Promise.resolve({ data: 'id,merchant\n1,Corner Cafe\n', headers: {} });
      return Promise.resolve({ data: { disputes: [makeDispute()] } });
    });
    renderPage();
    await waitFor(() => expect(screen.getByText('Corner Cafe')).toBeInTheDocument());

    fireEvent.click(screen.getByText('Export CSV'));

    await waitFor(() => expect(mockGet).toHaveBeenCalledWith('/disputes/export', { params: {}, responseType: 'blob' }));
    await waitFor(() => expect(window.URL.createObjectURL).toHaveBeenCalled());
  });

  test('exporting while a status filter is active includes it in the request', async () => {
    mockGet.mockImplementation((url, config) => {
      if (url === '/disputes/export') return Promise.resolve({ data: 'id,merchant\n', headers: {} });
      return Promise.resolve({ data: { disputes: config?.params?.status === 'won' ? [] : [makeDispute()] } });
    });
    renderPage();
    await waitFor(() => expect(screen.getByText('Corner Cafe')).toBeInTheDocument());

    fireEvent.click(screen.getByText(/Filters/i));
    fireEvent.change(screen.getByDisplayValue('All'), { target: { value: 'won' } });
    fireEvent.click(screen.getByText('Apply'));
    await waitFor(() => expect(screen.getByText(/No disputes match/i)).toBeInTheDocument());

    fireEvent.click(screen.getByText('Export CSV'));
    await waitFor(() => expect(mockGet).toHaveBeenCalledWith('/disputes/export', { params: { status: 'won' }, responseType: 'blob' }));
  });

  test('a failed export shows an error', async () => {
    mockGet.mockImplementation((url) => {
      if (url === '/disputes/export') return Promise.reject(new Error('network error'));
      return Promise.resolve({ data: { disputes: [makeDispute()] } });
    });
    renderPage();
    await waitFor(() => expect(screen.getByText('Corner Cafe')).toBeInTheDocument());

    fireEvent.click(screen.getByText('Export CSV'));
    expect(await screen.findByText(/Failed to export disputes/i)).toBeInTheDocument();
  });
});

describe('DisputesPage — admin', () => {
  beforeEach(() => {
    mockUser = { id: 9, username: 'admin', role: 'admin' };
  });

  test('also loads and renders the financial summary', async () => {
    mockGet.mockImplementation((url) => {
      if (url === '/disputes/financial-summary') return Promise.resolve({ data: makeSummary() });
      return Promise.resolve({ data: { disputes: [makeDispute({ account_username: 'someone_else' })] } });
    });

    renderPage();
    await waitFor(() => expect(screen.getByText('Corner Cafe')).toBeInTheDocument());

    expect(screen.getByText('Total Disputes')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
    expect(screen.getByText('$100.00')).toBeInTheDocument(); // amount_won
    expect(screen.getByText('50%')).toBeInTheDocument(); // win_rate
    expect(screen.getByText(/on someone_else's account/)).toBeInTheDocument();
  });

  test('shows an Update action for an open case, and can advance it to won with a note', async () => {
    const dispute = makeDispute();
    mockGet.mockImplementation((url) => {
      if (url === '/disputes/financial-summary') return Promise.resolve({ data: makeSummary() });
      return Promise.resolve({ data: { disputes: [dispute] } });
    });
    mockPatch.mockResolvedValue({ data: { dispute: { ...dispute, status: 'won', resolution_note: 'Evidence was sufficient.' } } });

    renderPage();
    await waitFor(() => expect(screen.getByText('Update')).toBeInTheDocument());

    fireEvent.click(screen.getByText('Update'));
    // opened -> evidence_submitted / won / lost should all be offered
    expect(screen.getByText('Evidence Submitted')).toBeInTheDocument();
    expect(screen.getByText('Won')).toBeInTheDocument();
    expect(screen.getByText('Lost')).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText(/Evidence submitted, outcome details/i), {
      target: { value: 'Evidence was sufficient.' },
    });
    fireEvent.click(screen.getByText('Won'));

    await waitFor(() => expect(mockPatch).toHaveBeenCalledWith('/disputes/1', { status: 'won', note: 'Evidence was sufficient.' }));
    await waitFor(() => expect(screen.getByText(/Evidence was sufficient\./)).toBeInTheDocument());
  });

  test('offers no further action once a dispute is resolved', async () => {
    mockGet.mockImplementation((url) => {
      if (url === '/disputes/financial-summary') return Promise.resolve({ data: makeSummary() });
      return Promise.resolve({ data: { disputes: [makeDispute({ status: 'won', resolution_note: 'Reversed in our favor.' })] } });
    });

    renderPage();
    await waitFor(() => expect(screen.getByText('Corner Cafe')).toBeInTheDocument());
    expect(screen.queryByText('Update')).not.toBeInTheDocument();
  });

  test('shows a transition error inline without discarding the form', async () => {
    const dispute = makeDispute();
    mockGet.mockImplementation((url) => {
      if (url === '/disputes/financial-summary') return Promise.resolve({ data: makeSummary() });
      return Promise.resolve({ data: { disputes: [dispute] } });
    });
    mockPatch.mockRejectedValue({ response: { data: { error: 'Not a legal transition' } } });

    renderPage();
    await waitFor(() => expect(screen.getByText('Update')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Update'));
    fireEvent.click(screen.getByText('Won'));

    await waitFor(() => expect(screen.getByText('Not a legal transition')).toBeInTheDocument());
    // form stays open so the admin can retry
    expect(screen.getByText('Cancel')).toBeInTheDocument();
  });
});

describe('DisputesPage — opening a new dispute', () => {
  test('loads eligible transactions (excluding ones already disputed) when the form is opened', async () => {
    mockGet.mockImplementation((url) => {
      if (url === '/transactions') {
        return Promise.resolve({ data: { transactions: [makeTransaction({ id: 200 }), makeTransaction({ id: 100, merchant: 'Already Disputed Co' })] } });
      }
      return Promise.resolve({ data: { disputes: [makeDispute({ transaction_id: 100 })] } });
    });

    renderPage();
    await waitFor(() => expect(screen.getByText('Corner Cafe')).toBeInTheDocument());

    fireEvent.click(screen.getByText('Open a Dispute'));
    await waitFor(() => expect(mockGet).toHaveBeenCalledWith('/transactions', { params: { limit: 50 } }));

    expect(await screen.findByText(/#200 — Corner Cafe/)).toBeInTheDocument();
    expect(screen.queryByText(/Already Disputed Co/)).not.toBeInTheDocument();
  });

  test('submitting opens the dispute and adds it to the list', async () => {
    mockGet.mockImplementation((url) => {
      if (url === '/transactions') return Promise.resolve({ data: { transactions: [makeTransaction()] } });
      return Promise.resolve({ data: { disputes: [] } });
    });
    mockPost.mockResolvedValue({ data: { dispute: makeDispute({ id: 5, transaction_id: 200, reason: 'Item never arrived.' }) } });

    renderPage();
    await waitFor(() => expect(screen.getByText(/No disputes match/i)).toBeInTheDocument());

    fireEvent.click(screen.getByText('Open a Dispute'));
    fireEvent.change(await screen.findByRole('combobox'), { target: { value: '200' } });
    fireEvent.change(screen.getByPlaceholderText(/never arrived/i), { target: { value: 'Item never arrived.' } });
    // The submit handler is async and updates state after an `await`,
    // which runs outside fireEvent's own act() scope — wrap explicitly
    // so those updates are flushed before we assert on them below.
    await act(async () => {
      fireEvent.click(screen.getByText('Submit Dispute'));
      await new Promise(r => setTimeout(r, 0));
    });

    expect(mockPost).toHaveBeenCalledWith('/disputes', { transaction_id: 200, reason: 'Item never arrived.' });
    expect(screen.getByText('Item never arrived.')).toBeInTheDocument();
    expect(screen.queryByText('Submitting...')).not.toBeInTheDocument(); // form closed
  });

  test('a partial amount is included in the request when provided', async () => {
    mockGet.mockImplementation((url) => {
      if (url === '/transactions') return Promise.resolve({ data: { transactions: [makeTransaction({ amount: 200 })] } });
      return Promise.resolve({ data: { disputes: [] } });
    });
    mockPost.mockResolvedValue({ data: { dispute: makeDispute({ id: 6, transaction_id: 200, amount_disputed: 50 }) } });

    renderPage();
    await waitFor(() => expect(screen.getByText(/No disputes match/i)).toBeInTheDocument());
    fireEvent.click(screen.getByText('Open a Dispute'));
    fireEvent.change(await screen.findByRole('combobox'), { target: { value: '200' } });
    fireEvent.change(screen.getByPlaceholderText(/never arrived/i), { target: { value: 'Only part of the order.' } });
    fireEvent.change(screen.getByPlaceholderText('200.00'), { target: { value: '50' } });
    fireEvent.click(screen.getByText('Submit Dispute'));

    await waitFor(() => expect(mockPost).toHaveBeenCalledWith('/disputes', {
      transaction_id: 200, reason: 'Only part of the order.', amount_disputed: 50,
    }));
  });

  test('shows a message when there are no eligible transactions', async () => {
    mockGet.mockImplementation((url) => {
      if (url === '/transactions') return Promise.resolve({ data: { transactions: [] } });
      return Promise.resolve({ data: { disputes: [] } });
    });

    renderPage();
    await waitFor(() => expect(screen.getByText(/No disputes match/i)).toBeInTheDocument());
    fireEvent.click(screen.getByText('Open a Dispute'));
    expect(await screen.findByText(/No eligible transactions/)).toBeInTheDocument();
  });

  test('a failed submission shows an inline error', async () => {
    mockGet.mockImplementation((url) => {
      if (url === '/transactions') return Promise.resolve({ data: { transactions: [makeTransaction()] } });
      return Promise.resolve({ data: { disputes: [] } });
    });
    mockPost.mockRejectedValue({ response: { data: { error: 'This transaction already has an open dispute' } } });

    renderPage();
    await waitFor(() => expect(screen.getByText(/No disputes match/i)).toBeInTheDocument());
    fireEvent.click(screen.getByText('Open a Dispute'));
    fireEvent.change(await screen.findByRole('combobox'), { target: { value: '200' } });
    fireEvent.change(screen.getByPlaceholderText(/never arrived/i), { target: { value: 'Testing.' } });
    await act(async () => {
      fireEvent.click(screen.getByText('Submit Dispute'));
      await new Promise(r => setTimeout(r, 0));
    });

    expect(screen.getByText('This transaction already has an open dispute')).toBeInTheDocument();
  });
});
