import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import SettingsPage from './SettingsPage';

const mockGet = jest.fn();
const mockPost = jest.fn();
const mockPatch = jest.fn();
const mockDelete = jest.fn();

const testUser = { id: 1, username: 'test_user', email: 'test@example.com', role: 'user', email_verified: 1, totp_enabled: 0 };

jest.mock('../context/AuthContext', () => ({
  api: {
    get: (...args) => mockGet(...args),
    post: (...args) => mockPost(...args),
    patch: (...args) => mockPatch(...args),
    delete: (...args) => mockDelete(...args),
  },
  useAuth: () => ({ user: testUser, refreshUser: () => Promise.resolve() }),
}));

function makeWebhook(overrides = {}) {
  return { id: 1, url: 'https://example.com/hook', events: ['transaction.flagged'], active: true, ...overrides };
}

function baseGetImpl({ webhooks = [] } = {}) {
  return (url) => {
    if (url === '/api-keys') return Promise.resolve({ data: { apiKeys: [] } });
    if (url === '/webhooks') return Promise.resolve({ data: { webhooks } });
    return Promise.reject(new Error(`unmocked GET ${url}`));
  };
}

beforeEach(() => {
  mockGet.mockReset();
  mockPost.mockReset();
  mockPatch.mockReset();
  mockDelete.mockReset();
});

describe('SettingsPage — webhook event subscriptions', () => {
  test('the create form defaults to transaction.flagged and lets other events be added', async () => {
    mockGet.mockImplementation(baseGetImpl());
    mockPost.mockResolvedValue({ data: { id: 2, secret: 'whsec_test', url: 'https://x.example.com/h', events: ['transaction.flagged', 'transaction.step_up_required'] } });

    render(<MemoryRouter><SettingsPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText('Webhooks')).toBeInTheDocument());

    // default: only "Transaction flagged" checked
    const flaggedBox = screen.getByText('Transaction flagged').closest('label').querySelector('input');
    const stepUpBox = screen.getByText('Step-up required').closest('label').querySelector('input');
    expect(flaggedBox.checked).toBe(true);
    expect(stepUpBox.checked).toBe(false);

    fireEvent.click(stepUpBox);
    expect(stepUpBox.checked).toBe(true);

    fireEvent.change(screen.getByPlaceholderText('https://your-app.example.com/fraudguard-hook'), { target: { value: 'https://x.example.com/h' } });
    fireEvent.click(screen.getByText('Add Webhook'));

    await waitFor(() => expect(mockPost).toHaveBeenCalledWith('/webhooks', {
      url: 'https://x.example.com/h',
      events: ['transaction.flagged', 'transaction.step_up_required'],
    }));
  });

  test('unchecking every event disables the submit button', async () => {
    mockGet.mockImplementation(baseGetImpl());
    render(<MemoryRouter><SettingsPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText('Webhooks')).toBeInTheDocument());

    const flaggedBox = screen.getByText('Transaction flagged').closest('label').querySelector('input');
    fireEvent.click(flaggedBox);

    expect(screen.getByText('Add Webhook').closest('button')).toBeDisabled();
  });

  test('an existing webhook\'s events can be edited', async () => {
    const webhook = makeWebhook();
    mockGet.mockImplementation(baseGetImpl({ webhooks: [webhook] }));
    mockPatch.mockResolvedValue({ data: { message: 'updated' } });

    render(<MemoryRouter><SettingsPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText('https://example.com/hook')).toBeInTheDocument());

    fireEvent.click(screen.getByTitle('Edit event subscriptions'));
    // Both the inline edit form and the create form below it render an
    // EventCheckboxes with the same labels — the edit one renders first.
    const stepUpBox = screen.getAllByText('Step-up verified')[0].closest('label').querySelector('input');
    fireEvent.click(stepUpBox);
    fireEvent.click(screen.getByText('Save events'));

    await waitFor(() => expect(mockPatch).toHaveBeenCalledWith('/webhooks/1', {
      events: ['transaction.flagged', 'transaction.step_up_verified'],
    }));
  });
});
