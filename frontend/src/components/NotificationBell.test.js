import React from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import NotificationBell from './NotificationBell';

const mockGet = jest.fn();
let mockUser = { id: 1, username: 'alice', role: 'user' };
let socketHandlers = {};
const mockSocket = {
  on: (event, handler) => { socketHandlers[event] = handler; },
  off: (event) => { delete socketHandlers[event]; },
};

jest.mock('../context/AuthContext', () => ({
  api: { get: (...args) => mockGet(...args) },
  useAuth: () => ({ user: mockUser }),
}));

jest.mock('../context/SocketContext', () => ({
  useSocket: () => ({ socket: mockSocket, connected: true }),
}));

function renderBell() {
  return render(<MemoryRouter><NotificationBell /></MemoryRouter>);
}

function makeAlert(overrides = {}) {
  return {
    id: 1, message: 'High risk transaction detected at Some Shop. Amount: $5000.00',
    risk_level: 'high', created_at: '2026-01-05T12:00:00Z', ...overrides,
  };
}

beforeEach(() => {
  mockGet.mockReset();
  socketHandlers = {};
  mockUser = { id: 1, username: 'alice', role: 'user' };
  window.localStorage.clear();
});

describe('NotificationBell', () => {
  test('fetches the most recent alerts on mount', async () => {
    mockGet.mockResolvedValue({ data: { alerts: [makeAlert()] } });
    renderBell();
    await waitFor(() => expect(mockGet).toHaveBeenCalledWith('/alerts', { params: { page: 1, limit: 8 } }));
  });

  test('shows an unseen badge for alerts that arrived before the bell was ever opened', async () => {
    mockGet.mockResolvedValue({ data: { alerts: [makeAlert(), makeAlert({ id: 2 })] } });
    renderBell();
    expect(await screen.findByText('2')).toBeInTheDocument();
  });

  test('opening the dropdown shows the alerts and clears the badge', async () => {
    mockGet.mockResolvedValue({ data: { alerts: [makeAlert()] } });
    renderBell();
    await screen.findByText('1');

    fireEvent.click(screen.getByTitle('Notifications'));
    expect(screen.getByText(/High risk transaction detected/)).toBeInTheDocument();
    expect(screen.getByText('Notifications')).toBeInTheDocument();
    expect(screen.queryByText('1')).not.toBeInTheDocument(); // badge cleared
  });

  test('shows an empty state when there are no alerts', async () => {
    mockGet.mockResolvedValue({ data: { alerts: [] } });
    renderBell();
    fireEvent.click(await screen.findByTitle('Notifications'));
    expect(screen.getByText('No alerts yet')).toBeInTheDocument();
  });

  test('a live alert:new event prepends the new alert and shows an unseen badge', async () => {
    mockGet.mockResolvedValue({ data: { alerts: [] } });
    renderBell();
    await waitFor(() => expect(mockGet).toHaveBeenCalled());
    // No alerts yet — open once so any pre-existing state is "seen".
    fireEvent.click(screen.getByTitle('Notifications'));
    fireEvent.click(screen.getByTitle('Notifications')); // close

    act(() => {
      socketHandlers['alert:new']({ id: 77, type: 'alert:new', alert: { id: 9, message: 'Fresh alert', risk_level: 'high', created_at: new Date().toISOString() } });
    });

    expect(await screen.findByText('1')).toBeInTheDocument();
    fireEvent.click(screen.getByTitle('Notifications'));
    expect(screen.getByText('Fresh alert')).toBeInTheDocument();
  });

  test('remembers "seen" across remounts for the same account, via localStorage', async () => {
    mockGet.mockResolvedValue({ data: { alerts: [makeAlert()] } });
    const { unmount } = renderBell();
    await screen.findByText('1');
    fireEvent.click(screen.getByTitle('Notifications')); // marks as seen

    unmount();
    renderBell();
    await waitFor(() => expect(mockGet).toHaveBeenCalledTimes(2));
    expect(screen.queryByText('1')).not.toBeInTheDocument();
  });

  test('a different account does not inherit another account\'s "seen" state', async () => {
    mockGet.mockResolvedValue({ data: { alerts: [makeAlert()] } });
    const { unmount } = renderBell();
    await screen.findByText('1');
    fireEvent.click(screen.getByTitle('Notifications'));
    unmount();

    mockUser = { id: 2, username: 'bob', role: 'user' };
    renderBell();
    expect(await screen.findByText('1')).toBeInTheDocument();
  });

  test('clicking outside the dropdown closes it', async () => {
    mockGet.mockResolvedValue({ data: { alerts: [makeAlert()] } });
    renderBell();
    await screen.findByText('1');

    fireEvent.click(screen.getByTitle('Notifications'));
    expect(screen.getByText('Notifications')).toBeInTheDocument();

    fireEvent.mouseDown(document.body);
    expect(screen.queryByText('Notifications')).not.toBeInTheDocument();
  });

  test('a failed fetch leaves the bell empty rather than crashing', async () => {
    mockGet.mockRejectedValue(new Error('network error'));
    renderBell();
    await waitFor(() => expect(mockGet).toHaveBeenCalled());
    fireEvent.click(screen.getByTitle('Notifications'));
    expect(screen.getByText('No alerts yet')).toBeInTheDocument();
  });
});
