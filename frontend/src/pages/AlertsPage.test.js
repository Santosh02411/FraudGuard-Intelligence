import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import AlertsPage from './AlertsPage';

const mockGet = jest.fn();
const mockPatch = jest.fn();
let mockUser = { id: 1, username: 'test_user', role: 'user' };

jest.mock('../context/AuthContext', () => ({
  api: { get: (...args) => mockGet(...args), patch: (...args) => mockPatch(...args) },
  useAuth: () => ({ user: mockUser }),
}));

jest.mock('../context/SocketContext', () => ({
  useSocket: () => ({ socket: null, connected: false }),
}));

// jest.mock calls above are hoisted above these imports by babel-jest at
// compile time, so AlertsPage picks up the mocked modules regardless of
// this file's source order — written top-to-bottom for readability
// (and to satisfy eslint's import/first rule).

function renderPage() {
  return render(<MemoryRouter><AlertsPage /></MemoryRouter>);
}

function makeAlert(overrides = {}) {
  return {
    id: 1,
    transaction_id: 100,
    message: 'High risk transaction detected at Some Shop. Amount: $5000.00',
    risk_level: 'high',
    status: 'open',
    verdict: null,
    resolution_note: null,
    assigned_to: null,
    assignee_username: null,
    amount: 5000,
    merchant: 'Some Shop',
    created_at: '2026-01-01T12:00:00Z',
    ...overrides,
  };
}

beforeEach(() => {
  mockGet.mockReset();
  mockPatch.mockReset();
  mockUser = { id: 1, username: 'test_user', role: 'user' };
  window.URL.createObjectURL = jest.fn(() => 'blob:mock-url');
  window.URL.revokeObjectURL = jest.fn();
});

describe('AlertsPage', () => {
  test('shows a loading state, then the fetched alerts', async () => {
    mockGet.mockResolvedValue({
      data: {
        alerts: [makeAlert()],
        pagination: { page: 1, limit: 20, total: 1, total_pages: 1, has_next: false, has_prev: false },
      },
    });

    renderPage();
    expect(screen.getByText(/loading alerts/i)).toBeInTheDocument();

    expect(await screen.findByText(/High risk transaction detected/)).toBeInTheDocument();
    expect(screen.getByText('Some Shop')).toBeInTheDocument();
    expect(screen.getByText('$5000.00')).toBeInTheDocument();
  });

  test('shows the empty state when there are no alerts', async () => {
    mockGet.mockResolvedValue({
      data: { alerts: [], pagination: { page: 1, limit: 20, total: 0, total_pages: 0, has_next: false, has_prev: false } },
    });

    renderPage();
    expect(await screen.findByText(/no alerts match these filters/i)).toBeInTheDocument();
  });

  test('resolving as a confirmed fraud verdict calls the API with the verdict and note, and updates the alert in place', async () => {
    mockGet.mockResolvedValue({
      data: {
        alerts: [makeAlert({ id: 42 })],
        pagination: { page: 1, limit: 20, total: 1, total_pages: 1, has_next: false, has_prev: false },
      },
    });
    mockPatch.mockResolvedValue({
      data: {
        message: 'Alert resolved',
        alert: makeAlert({ id: 42, status: 'resolved', verdict: 'confirmed_fraud', resolution_note: 'Cardholder confirmed theft.' }),
      },
    });

    renderPage();
    await screen.findByText(/High risk transaction detected/);

    // Opens the inline verdict form rather than resolving immediately.
    fireEvent.click(screen.getByRole('button', { name: /^resolve$/i }));
    fireEvent.change(screen.getByLabelText(/resolution reason/i), { target: { value: 'stolen_card' } });
    fireEvent.change(screen.getByPlaceholderText(/why are you resolving/i), { target: { value: 'Cardholder confirmed theft.' } });
    fireEvent.click(screen.getByRole('button', { name: /confirm fraud/i }));

    await waitFor(() => expect(mockPatch).toHaveBeenCalledWith('/alerts/42/resolve', { verdict: 'confirmed_fraud', note: 'Cardholder confirmed theft.', reason: 'stolen_card', version: undefined }));
    expect(await screen.findByText('Confirmed Fraud')).toBeInTheDocument();
    expect(screen.getByText('Resolved')).toBeInTheDocument();
    expect(screen.getByText(/Cardholder confirmed theft/)).toBeInTheDocument();
    // A resolved alert no longer shows a Resolve button.
    expect(screen.queryByRole('button', { name: /^resolve$/i })).not.toBeInTheDocument();
  });

  test('marking an alert as a false positive sends that verdict', async () => {
    mockGet.mockResolvedValue({
      data: {
        alerts: [makeAlert({ id: 43 })],
        pagination: { page: 1, limit: 20, total: 1, total_pages: 1, has_next: false, has_prev: false },
      },
    });
    mockPatch.mockResolvedValue({
      data: { message: 'Alert resolved', alert: makeAlert({ id: 43, status: 'resolved', verdict: 'false_positive' }) },
    });

    renderPage();
    await screen.findByText(/High risk transaction detected/);
    fireEvent.click(screen.getByRole('button', { name: /^resolve$/i }));
    expect(screen.getByRole('button', { name: /mark false positive/i })).toBeDisabled(); // a reason is required
    fireEvent.change(screen.getByLabelText(/resolution reason/i), { target: { value: 'stolen_card' } });
    fireEvent.click(screen.getByRole('button', { name: /mark false positive/i }));

    await waitFor(() => expect(mockPatch).toHaveBeenCalledWith('/alerts/43/resolve', { verdict: 'false_positive', note: undefined, reason: 'stolen_card', version: undefined }));
    expect(await screen.findByText('False Positive')).toBeInTheDocument();
  });

  test('cancelling the resolve form closes it without calling the API', async () => {
    mockGet.mockResolvedValue({
      data: {
        alerts: [makeAlert({ id: 44 })],
        pagination: { page: 1, limit: 20, total: 1, total_pages: 1, has_next: false, has_prev: false },
      },
    });

    renderPage();
    await screen.findByText(/High risk transaction detected/);
    fireEvent.click(screen.getByRole('button', { name: /^resolve$/i }));
    expect(screen.getByRole('button', { name: /confirm fraud/i })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));
    expect(screen.queryByRole('button', { name: /confirm fraud/i })).not.toBeInTheDocument();
    expect(mockPatch).not.toHaveBeenCalled();
  });

  test('shows pagination controls only when there is more than one page, and Next fetches page 2', async () => {
    mockGet.mockResolvedValueOnce({
      data: {
        alerts: [makeAlert({ id: 1 })],
        pagination: { page: 1, limit: 1, total: 2, total_pages: 2, has_next: true, has_prev: false },
      },
    });

    renderPage();
    await screen.findByText(/High risk transaction detected/);

    const nextButton = screen.getByRole('button', { name: /next/i });
    expect(nextButton).not.toBeDisabled();

    mockGet.mockResolvedValueOnce({
      data: {
        alerts: [makeAlert({ id: 2, merchant: 'Second Shop' })],
        pagination: { page: 2, limit: 1, total: 2, total_pages: 2, has_next: false, has_prev: true },
      },
    });
    fireEvent.click(nextButton);

    await screen.findByText('Second Shop');
    expect(mockGet).toHaveBeenLastCalledWith('/alerts', { params: { page: 2, limit: 20 } });
  });

  test('a failed resolve shows the server error inline and keeps the alert unresolved', async () => {
    mockGet.mockResolvedValue({
      data: {
        alerts: [makeAlert({ id: 7 })],
        pagination: { page: 1, limit: 20, total: 1, total_pages: 1, has_next: false, has_prev: false },
      },
    });
    mockPatch.mockRejectedValue({ response: { data: { error: 'Not authorized' } } });

    renderPage();
    await screen.findByText(/High risk transaction detected/);
    fireEvent.click(screen.getByRole('button', { name: /^resolve$/i }));
    fireEvent.change(screen.getByLabelText(/resolution reason/i), { target: { value: 'other' } });
    fireEvent.click(screen.getByRole('button', { name: /confirm fraud/i }));

    expect(await screen.findByText('Not authorized')).toBeInTheDocument();
    expect(screen.getByText(/High risk transaction detected/)).toBeInTheDocument();
    // Still open — the form stays up so the analyst can retry.
    expect(screen.getByRole('button', { name: /confirm fraud/i })).toBeInTheDocument();
  });
});

describe('AlertsPage — bulk actions', () => {
  function twoOpenAlerts() {
    return {
      data: {
        alerts: [makeAlert({ id: 1, merchant: 'First Shop' }), makeAlert({ id: 2, merchant: 'Second Shop' })],
        pagination: { page: 1, limit: 20, total: 2, total_pages: 1, has_next: false, has_prev: false },
      },
    };
  }

  test('selecting alerts reveals the bulk action bar with a running count', async () => {
    mockGet.mockResolvedValue(twoOpenAlerts());
    renderPage();
    await screen.findByText('First Shop');

    expect(screen.queryByText(/selected/i)).not.toBeInTheDocument();

    fireEvent.click(screen.getAllByLabelText('Select')[0]);
    expect(await screen.findByText('1 selected')).toBeInTheDocument();

    // After the first click, that checkbox's own label flips to
    // "Deselect" — only the still-unselected one is still "Select".
    fireEvent.click(screen.getAllByLabelText('Select')[0]);
    expect(await screen.findByText('2 selected')).toBeInTheDocument();
  });

  test('"Select all on this page" selects every open alert, and toggles back off', async () => {
    mockGet.mockResolvedValue(twoOpenAlerts());
    renderPage();
    await screen.findByText('First Shop');

    fireEvent.click(screen.getByText(/select all on this page/i));
    expect(await screen.findByText('2 selected')).toBeInTheDocument();

    fireEvent.click(screen.getByText(/select all on this page/i));
    expect(screen.queryByText(/selected/i)).not.toBeInTheDocument();
  });

  test('bulk-confirming fraud calls the bulk-resolve endpoint with the selected ids, verdict, and note, then reloads', async () => {
    mockGet.mockResolvedValueOnce(twoOpenAlerts());
    mockPatch.mockResolvedValue({ data: { message: '2 alert(s) resolved', resolvedCount: 2, alertIds: [1, 2] } });

    renderPage();
    await screen.findByText('First Shop');

    fireEvent.click(screen.getByText(/select all on this page/i));
    await screen.findByText('2 selected');

    fireEvent.change(screen.getByPlaceholderText(/resolution note \(optional/i), { target: { value: 'Card-testing burst, batch cleared.' } });

    mockGet.mockResolvedValueOnce({
      data: { alerts: [], pagination: { page: 1, limit: 20, total: 0, total_pages: 0, has_next: false, has_prev: false } },
    });
    fireEvent.click(screen.getByRole('button', { name: /confirm fraud/i }));

    await waitFor(() => expect(mockPatch).toHaveBeenCalledWith('/alerts/bulk-resolve', {
      alertIds: [1, 2], verdict: 'confirmed_fraud', note: 'Card-testing burst, batch cleared.',
    }));
    // Reloads the list (and therefore clears the selection/bar) after a
    // successful bulk action.
    await waitFor(() => expect(screen.queryByText(/selected/i)).not.toBeInTheDocument());
  });

  test('a failed bulk resolve shows the server error and keeps the selection', async () => {
    mockGet.mockResolvedValue(twoOpenAlerts());
    mockPatch.mockRejectedValue({ response: { data: { error: 'Not authorized to resolve one or more of the specified alerts' } } });

    renderPage();
    await screen.findByText('First Shop');
    fireEvent.click(screen.getByText(/select all on this page/i));
    await screen.findByText('2 selected');

    fireEvent.click(screen.getByRole('button', { name: /mark false positive/i }));

    expect(await screen.findByText(/not authorized to resolve/i)).toBeInTheDocument();
    expect(screen.getByText('2 selected')).toBeInTheDocument();
  });

  test('a resolved alert has no checkbox and cannot be selected', async () => {
    mockGet.mockResolvedValue({
      data: {
        alerts: [makeAlert({ id: 9, status: 'resolved', verdict: 'confirmed_fraud' })],
        pagination: { page: 1, limit: 20, total: 1, total_pages: 1, has_next: false, has_prev: false },
      },
    });
    renderPage();
    await screen.findByText(/High risk transaction detected/);
    expect(screen.queryByLabelText('Select')).not.toBeInTheDocument();
    expect(screen.queryByText(/select all on this page/i)).not.toBeInTheDocument();
  });
});

describe('AlertsPage — CSV export', () => {
  test('clicking Export CSV fetches the CSV as a blob and triggers a download', async () => {
    mockGet.mockResolvedValueOnce({
      data: {
        alerts: [makeAlert()],
        pagination: { page: 1, limit: 20, total: 1, total_pages: 1, has_next: false, has_prev: false },
      },
    });
    renderPage();
    await screen.findByText(/High risk transaction detected/);

    const clickSpy = jest.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    mockGet.mockResolvedValueOnce({
      data: 'id,merchant\n1,Some Shop\n',
      headers: { 'content-disposition': 'attachment; filename="alerts.csv"' },
    });

    fireEvent.click(screen.getByRole('button', { name: /export csv/i }));

    await waitFor(() => expect(mockGet).toHaveBeenLastCalledWith('/alerts/export', { params: {}, responseType: 'blob' }));
    await waitFor(() => expect(window.URL.createObjectURL).toHaveBeenCalled());
    expect(clickSpy).toHaveBeenCalled();
    clickSpy.mockRestore();
  });

  test('a failed export shows an inline error', async () => {
    mockGet.mockResolvedValueOnce({
      data: {
        alerts: [makeAlert()],
        pagination: { page: 1, limit: 20, total: 1, total_pages: 1, has_next: false, has_prev: false },
      },
    });
    renderPage();
    await screen.findByText(/High risk transaction detected/);

    mockGet.mockRejectedValueOnce(new Error('network error'));
    fireEvent.click(screen.getByRole('button', { name: /export csv/i }));

    expect(await screen.findByText(/failed to export alerts/i)).toBeInTheDocument();
  });

  test('any user can request a plain-language explanation, and it is only fetched once per alert', async () => {
    mockGet.mockImplementation((url) => {
      if (url === '/alerts/1/explanation') return Promise.resolve({ data: { explanation: 'Flagged for an unusually large purchase from a new device.', cached: false } });
      return Promise.resolve({
        data: { alerts: [makeAlert({ id: 1 })], pagination: { page: 1, limit: 20, total: 1, total_pages: 1, has_next: false, has_prev: false } },
      });
    });

    renderPage();
    await screen.findByText(/High risk transaction detected/);

    fireEvent.click(screen.getByTitle('Explain in plain language'));
    expect(await screen.findByText(/Flagged for an unusually large purchase/)).toBeInTheDocument();
    expect(mockGet).toHaveBeenCalledWith('/alerts/1/explanation');

    // collapse, then reopen — should use the cached value, not refetch
    fireEvent.click(screen.getByTitle('Explain in plain language'));
    expect(screen.queryByText(/Flagged for an unusually large purchase/)).not.toBeInTheDocument();
    mockGet.mockClear();
    fireEvent.click(screen.getByTitle('Explain in plain language'));
    expect(await screen.findByText(/Flagged for an unusually large purchase/)).toBeInTheDocument();
    expect(mockGet).not.toHaveBeenCalledWith('/alerts/1/explanation');
  });

  test('a regular user does not see the audit trail button, but an admin does and can view it', async () => {
    mockGet.mockImplementation((url) => {
      if (url === '/admin/audit-logs/alert/1') {
        return Promise.resolve({
          data: { logs: [{ id: 9, action: 'alerts.resolve', username: 'admin', created_at: '2026-01-02T00:00:00Z', outcome: 'success' }] },
        });
      }
      return Promise.resolve({
        data: { alerts: [makeAlert({ id: 1 })], pagination: { page: 1, limit: 20, total: 1, total_pages: 1, has_next: false, has_prev: false } },
      });
    });

    renderPage();
    await screen.findByText(/High risk transaction detected/);
    expect(screen.queryByTitle("View this alert's audit trail")).not.toBeInTheDocument();

    mockUser = { id: 9, username: 'admin_user', role: 'admin' };
    renderPage();
    await screen.findAllByText(/High risk transaction detected/);

    fireEvent.click(screen.getAllByTitle("View this alert's audit trail")[0]);
    expect(await screen.findByText('alerts.resolve')).toBeInTheDocument();
    expect(screen.getByText(/by admin/)).toBeInTheDocument();
  });
});

describe('AlertsPage — case workflow', () => {
  const pageOf = (alerts) => ({ data: { alerts, pagination: { page: 1, limit: 20, total: alerts.length, total_pages: 1, has_next: false, has_prev: false } } });

  test('badges show severity, overdue, escalation and who is working a case', async () => {
    mockUser = { id: 9, username: 'admin_user', role: 'admin' };
    mockGet.mockImplementation((url) => Promise.resolve(url === '/alerts/metrics' ? { data: {} } : pageOf([makeAlert({
      id: 5, severity: 'critical', overdue: true, escalation_level: 2, status: 'escalated',
      claim: { user_id: 3, username: 'dana', expires_at: '2026-10-25T10:00:00Z' },
    })])));
    renderPage();
    expect(await screen.findByText('critical')).toBeInTheDocument();
    expect(screen.getByText(/overdue/i)).toBeInTheDocument();
    expect(screen.getByText('Escalation L2')).toBeInTheDocument();
    expect(screen.getByText('dana is working this')).toBeInTheDocument();
    expect(screen.getByText('Escalated')).toBeInTheDocument();
  });

  test('resolving a case another investigator holds shows who, and refreshes the row', async () => {
    mockUser = { id: 9, username: 'admin_user', role: 'admin' };
    const held = makeAlert({ id: 6, version: 1 });
    mockGet.mockImplementation((url) => Promise.resolve(url === '/alerts/metrics' ? { data: {} } : pageOf([held])));
    mockPatch.mockRejectedValue({ response: { status: 409, data: { error: 'This case is being worked by dana until 10:00.', details: { code: 'ALERT_LOCKED', current: { ...held, claim: { user_id: 3, username: 'dana', expires_at: '2026-10-25T10:00:00Z' } } } } } });
    renderPage();
    await screen.findByText(/High risk transaction detected/);
    fireEvent.click(screen.getByRole('button', { name: /^resolve$/i }));
    fireEvent.change(screen.getByLabelText(/resolution reason/i), { target: { value: 'other' } });
    fireEvent.click(screen.getByRole('button', { name: /mark false positive/i }));
    expect(await screen.findByText(/being worked by dana/)).toBeInTheDocument();
    expect(screen.getByText('dana is working this')).toBeInTheDocument();
  });
});
