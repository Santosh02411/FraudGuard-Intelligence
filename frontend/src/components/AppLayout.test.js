import React from 'react';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import AppLayout from './AppLayout';
import Sidebar, { NAV_GROUPS } from './Sidebar';

const mockLogout = jest.fn(); const mockNavigate = jest.fn(); const mockGet = jest.fn();
let mockUser = { username: 'alice', role: 'user' };
let mockSocketHandlers = {};
const mockSocket = { on: (e, f) => { mockSocketHandlers[e] = f; }, off: (e) => { delete mockSocketHandlers[e]; } };
let mockConnected = false;
let mockMl = 'ok';

jest.mock('../context/AuthContext', () => ({ useAuth: () => ({ user: mockUser, logout: mockLogout }), api: { get: (...a) => mockGet(...a) } }));
jest.mock('../context/SocketContext', () => ({ useSocket: () => ({ socket: mockSocket, connected: mockConnected }) }));
jest.mock('react-router-dom', () => ({ ...jest.requireActual('react-router-dom'), useNavigate: () => mockNavigate }));

beforeEach(() => {
  jest.clearAllMocks(); mockSocketHandlers = {}; mockConnected = false; mockMl = 'ok';
  mockGet.mockImplementation((url) => {
    if (url === '/alerts/metrics') return Promise.resolve({ data: { open: { total: 7, overdue: 2 } } });
    if (url === '/alerts') return Promise.resolve({ data: { alerts: [], pagination: { total: 3 } } });
    if (url === '/system/status') return Promise.resolve({ data: { ml: { status: mockMl } } });
    return Promise.reject(new Error(url));
  });
});
const nav = () => screen.getByRole('navigation', { name: /main navigation/i });
const renderLayout = (path = '/dashboard') => render(<MemoryRouter initialEntries={[path]}><AppLayout><div>page body</div></AppLayout></MemoryRouter>);

describe('Sidebar navigation', () => {
  test('a regular user sees the core links grouped, but no admin-only links or groups', async () => {
    mockUser = { username: 'alice', role: 'user' };
    render(<MemoryRouter><Sidebar /></MemoryRouter>);
    const n = within(nav());
    for (const label of ['Dashboard', 'Live Feed', 'Transactions', 'Alerts', 'Analytics', 'Simulator', 'Bulk Import', 'Disputes', 'Settings']) expect(n.getByText(label)).toBeInTheDocument();
    for (const label of ['Cases', 'Relationships', 'Profiles', 'AI Memory', 'Feedback', 'Verification', 'Rule Lab', 'Model', 'Admin', 'Govern']) expect(n.queryByText(label)).not.toBeInTheDocument();
    await waitFor(() => expect(n.getByLabelText('3 open alerts')).toBeInTheDocument());
  });

  test('an admin sees every group and every link (nothing is clipped like the old top bar)', async () => {
    mockUser = { username: 'root', role: 'admin' };
    render(<MemoryRouter><Sidebar /></MemoryRouter>);
    const n = within(nav());
    for (const g of NAV_GROUPS) { expect(n.getByText(g.title)).toBeInTheDocument(); for (const i of g.items) expect(n.getByText(i.label)).toBeInTheDocument(); }
    expect(NAV_GROUPS.flatMap((g) => g.items).length).toBe(18);
    expect(n.getByText('AI Memory').closest('a')).toHaveAttribute('href', '/fraud-intelligence');
    await waitFor(() => expect(n.getByLabelText('7 open alerts')).toBeInTheDocument());
    expect(mockGet).toHaveBeenCalledWith('/alerts/metrics', { params: { days: 7 } });
  });

  test('the badge refreshes when a new alert arrives over the socket; failures just hide it', async () => {
    mockUser = { username: 'root', role: 'admin' };
    render(<MemoryRouter><Sidebar /></MemoryRouter>);
    await screen.findByLabelText('7 open alerts');
    mockGet.mockImplementation(() => Promise.resolve({ data: { open: { total: 9, overdue: 0 } } }));
    mockSocketHandlers['alert:new']();
    await screen.findByLabelText('9 open alerts');
    mockGet.mockImplementation(() => Promise.reject(new Error('down')));
    mockSocketHandlers['alert:new']();
    await waitFor(() => expect(screen.queryByLabelText(/open alerts/)).not.toBeInTheDocument());
  });

  test('marks the current page as active', () => {
    mockUser = { username: 'alice', role: 'user' };
    render(<MemoryRouter initialEntries={['/transactions']}><Sidebar /></MemoryRouter>);
    expect(within(nav()).getByText('Transactions').closest('a').className).toMatch(/text-cyan-300/);
    expect(within(nav()).getByText('Dashboard').closest('a').className).not.toMatch(/text-cyan-300/);
  });
});

describe('AppLayout', () => {
  test('shows the user and role, the page content, and signs out to /login', async () => {
    mockUser = { username: 'alice', role: 'user' };
    renderLayout();
    expect(screen.getByTestId('topbar-user')).toHaveTextContent('alice');
    expect(screen.getByText('page body')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /sign out/i }));
    expect(mockLogout).toHaveBeenCalledTimes(1); expect(mockNavigate).toHaveBeenCalledWith('/login');
    await waitFor(() => expect(mockGet).toHaveBeenCalled());
  });

  test('top bar matches the demo: user pill, role chip, ML service pill, bell and Sign out', async () => {
    mockUser = { username: 'root', role: 'admin' };
    renderLayout();
    expect(screen.getByTestId('topbar-user')).toHaveTextContent('root');
    expect(screen.getByTestId('topbar-role')).toHaveTextContent('role: admin');
    expect(await screen.findByText('ML service ok')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /sign out/i })).toBeInTheDocument();
    expect(screen.queryByText(/live updates on/i)).not.toBeInTheDocument();
  });

  test('the ML pill turns red when the service is down and grey when its status cannot be read', async () => {
    mockUser = { username: 'root', role: 'admin' }; mockMl = 'down';
    const { unmount } = renderLayout();
    expect(await screen.findByText('ML service down')).toBeInTheDocument();
    expect(screen.getByTestId('ml-status').className).toMatch(/text-red-300/);
    unmount();
    mockGet.mockImplementation((url) => (url === '/system/status' ? Promise.reject(new Error('x')) : Promise.resolve({ data: { open: { total: 0 }, alerts: [], pagination: { total: 0 } } })));
    renderLayout();
    await waitFor(() => expect(mockGet).toHaveBeenCalledWith('/system/status'));
    expect(screen.getByTestId('ml-status')).toHaveTextContent('ML service —');
  });

  test('a regular user is labelled analyst', async () => {
    mockUser = { username: 'alice', role: 'user' };
    renderLayout();
    expect(screen.getByTestId('topbar-role')).toHaveTextContent('role: analyst');
    await waitFor(() => expect(mockGet).toHaveBeenCalled());
  });

  test('the sidebar shows the build marker', async () => {
    mockUser = { username: 'alice', role: 'user' };
    renderLayout();
    expect(screen.getByTestId('sidebar-build')).toHaveTextContent(/FraudGuard build v3/);
    await waitFor(() => expect(mockGet).toHaveBeenCalled());
  });

  test('mobile: the menu opens from the hamburger and closes from the overlay and after choosing a page', async () => {
    mockUser = { username: 'alice', role: 'user' };
    renderLayout();
    expect(screen.queryByTestId('sidebar-overlay')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /open menu/i }));
    expect(screen.getByTestId('sidebar-overlay')).toBeInTheDocument();
    expect(screen.getByTestId('sidebar').className).toMatch(/translate-x-0/);
    fireEvent.click(screen.getByTestId('sidebar-overlay'));
    expect(screen.queryByTestId('sidebar-overlay')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /open menu/i }));
    fireEvent.click(within(nav()).getByText('Alerts'));
    expect(screen.queryByTestId('sidebar-overlay')).not.toBeInTheDocument();
    await waitFor(() => expect(mockGet).toHaveBeenCalled());
  });

  test('a crashing page is contained and recovers on navigation (ErrorBoundary kept)', async () => {
    mockUser = { username: 'alice', role: 'user' };
    const Boom = () => { throw new Error('page exploded'); };
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    render(<MemoryRouter><AppLayout><Boom /></AppLayout></MemoryRouter>);
    expect(screen.getByRole('navigation', { name: /main navigation/i })).toBeInTheDocument(); // chrome survives the crash
    expect(screen.queryByText('page body')).not.toBeInTheDocument();
    spy.mockRestore();
    await waitFor(() => expect(mockGet).toHaveBeenCalled());
  });
});
