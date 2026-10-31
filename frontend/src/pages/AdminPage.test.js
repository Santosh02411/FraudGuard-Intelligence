import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import AdminPage from './AdminPage';

const mockGet = jest.fn();
const mockPost = jest.fn();
const mockPatch = jest.fn();
const mockDelete = jest.fn();

jest.mock('../context/AuthContext', () => ({
  api: {
    get: (...args) => mockGet(...args),
    post: (...args) => mockPost(...args),
    patch: (...args) => mockPatch(...args),
    delete: (...args) => mockDelete(...args),
  },
  useAuth: () => ({ user: { id: 1, username: 'admin', role: 'admin' } }),
}));

function makeRule(overrides = {}) {
  return {
    id: 1,
    rule_type: 'blacklist_merchant',
    value: 'Shady Imports LLC',
    threshold: null,
    reason: 'Repeated chargebacks',
    enabled: true,
    updated_by_username: 'admin',
    ...overrides,
  };
}

function makeRing(overrides = {}) {
  return {
    ring_id: 'device:abc123',
    size: 3,
    members: [{ user_id: 2, username: 'alice' }, { user_id: 3, username: 'bob' }, { user_id: 4, username: 'carol' }],
    shared_device_count: 1,
    shared_ip_count: 0,
    confirmed_fraud_members: ['alice'],
    risk: 'high',
    ...overrides,
  };
}

function baseGetImpl({ rules = [makeRule()], rings = [makeRing()] } = {}) {
  return (url) => {
    if (url === '/admin/stats') return Promise.resolve({ data: { total_users: 5, total_transactions: 42, active_alerts: 2, system_fraud_rate: 4.2 } });
    if (url === '/admin/users') return Promise.resolve({ data: { users: [{ id: 1, username: 'admin', email: 'admin@x.com', role: 'admin', total_transactions: 0, fraud_rate: 0 }] } });
    if (url === '/admin/audit-logs') return Promise.resolve({ data: { logs: [] } });
    if (url === '/api-keys') return Promise.resolve({ data: { apiKeys: [] } });
    if (url === '/webhooks') return Promise.resolve({ data: { webhooks: [] } });
    if (url === '/admin/fraud-rules') return Promise.resolve({ data: { rules } });
    if (url === '/admin/fraud-rings') return Promise.resolve({ data: { rings } });
    if (url === '/admin/ml/versions') return Promise.resolve({ data: { versions: [{ version: 'v1', best_model_type: 'xgboost', pr_auc: 0.99, trained_at: '2026-08-21T00:00:00Z' }], active: 'v1' } });
    if (url === '/admin/ml/drift') return Promise.resolve({ data: { status: 'stable', n_samples: 500, version: 'v1', flagged_features: {} } });
    if (url === '/admin/ml/shadow/status') return Promise.resolve({ data: { active: false } });
    return Promise.reject(new Error(`unmocked GET ${url}`));
  };
}

beforeEach(() => {
  mockGet.mockReset();
  mockPost.mockReset();
  mockPatch.mockReset();
  mockDelete.mockReset();
});

describe('AdminPage — overview', () => {
  test('loads and shows stats and the user table by default', async () => {
    mockGet.mockImplementation(baseGetImpl());
    render(<AdminPage />);

    await waitFor(() => expect(screen.getByText('User Management')).toBeInTheDocument());
    expect(screen.getByText('42')).toBeInTheDocument(); // total_transactions
    expect(screen.getAllByText('admin').length).toBeGreaterThan(0);
    // one Promise.all covers stats/users/audit/keys/webhooks/rules/rings
    expect(mockGet).toHaveBeenCalledWith('/admin/fraud-rules');
    expect(mockGet).toHaveBeenCalledWith('/admin/fraud-rings');
  });
});

describe('AdminPage — Fraud Rules tab', () => {
  test('lists existing rules and lets an admin create a new one', async () => {
    mockGet.mockImplementation(baseGetImpl());
    mockPost.mockResolvedValue({ data: { rule: makeRule({ id: 2, rule_type: 'blacklist_ip', value: '203.0.113.9', reason: 'Testing farm' }) } });

    render(<AdminPage />);
    await waitFor(() => expect(screen.getByText('User Management')).toBeInTheDocument());

    fireEvent.click(screen.getByText('Fraud Rules'));
    expect(await screen.findByText('Shady Imports LLC')).toBeInTheDocument();
    expect(screen.getByText('Repeated chargebacks')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Add Rule'));
    fireEvent.change(screen.getByDisplayValue('Blacklist: Merchant'), { target: { value: 'blacklist_ip' } });
    fireEvent.change(screen.getByPlaceholderText('203.0.113.5'), { target: { value: '203.0.113.9' } });
    fireEvent.change(screen.getByPlaceholderText('Why this rule exists'), { target: { value: 'Testing farm' } });
    fireEvent.click(screen.getByText('Create Rule'));

    await waitFor(() => expect(mockPost).toHaveBeenCalledWith('/admin/fraud-rules', { rule_type: 'blacklist_ip', reason: 'Testing farm', value: '203.0.113.9' }));
    expect(await screen.findByText('203.0.113.9')).toBeInTheDocument();
  });

  test('the amount_cap type asks for a threshold instead of a value', async () => {
    mockGet.mockImplementation(baseGetImpl());
    render(<AdminPage />);
    await waitFor(() => expect(screen.getByText('User Management')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Fraud Rules'));
    fireEvent.click(await screen.findByText('Add Rule'));

    fireEvent.change(screen.getByDisplayValue('Blacklist: Merchant'), { target: { value: 'amount_cap' } });
    expect(screen.getByPlaceholderText('10000')).toBeInTheDocument();
    expect(screen.queryByPlaceholderText('203.0.113.5')).not.toBeInTheDocument();
  });

  test('Preview Impact is disabled until the required field is filled in', async () => {
    mockGet.mockImplementation(baseGetImpl());
    render(<AdminPage />);
    await waitFor(() => expect(screen.getByText('User Management')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Fraud Rules'));
    fireEvent.click(await screen.findByText('Add Rule'));

    expect(screen.getByText('Preview Impact').closest('button')).toBeDisabled();
    fireEvent.change(screen.getByPlaceholderText('exact match text'), { target: { value: 'Shady Imports LLC' } });
    expect(screen.getByText('Preview Impact').closest('button')).not.toBeDisabled();
  });

  test('previewing shows the matched count and sample without creating a rule', async () => {
    mockGet.mockImplementation(baseGetImpl());
    mockPost.mockImplementation((url) => {
      if (url === '/admin/fraud-rules/preview') {
        return Promise.resolve({
          data: {
            matched_count: 2,
            sample: [{ id: 501, merchant: 'Shady Imports LLC', amount: 80, created_at: '2026-01-05T00:00:00Z' }],
          },
        });
      }
      return Promise.reject(new Error(`unmocked POST ${url}`));
    });

    render(<AdminPage />);
    await waitFor(() => expect(screen.getByText('User Management')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Fraud Rules'));
    fireEvent.click(await screen.findByText('Add Rule'));
    fireEvent.change(screen.getByPlaceholderText('exact match text'), { target: { value: 'Shady Imports LLC' } });
    fireEvent.click(screen.getByText('Preview Impact'));

    await waitFor(() => expect(mockPost).toHaveBeenCalledWith('/admin/fraud-rules/preview', { rule_type: 'blacklist_merchant', value: 'Shady Imports LLC' }));
    expect(await screen.findByText(/would have matched 2 transactions/)).toBeInTheDocument();
    expect(screen.getByText(/Shady Imports LLC — \$80\.00/)).toBeInTheDocument();
    // create-rule endpoint was never called
    expect(mockPost).not.toHaveBeenCalledWith('/admin/fraud-rules', expect.anything());
  });

  test('a zero-match preview is shown as reassuring rather than a warning', async () => {
    mockGet.mockImplementation(baseGetImpl());
    mockPost.mockImplementation((url) => {
      if (url === '/admin/fraud-rules/preview') return Promise.resolve({ data: { matched_count: 0, sample: [] } });
      return Promise.reject(new Error(`unmocked POST ${url}`));
    });

    render(<AdminPage />);
    await waitFor(() => expect(screen.getByText('User Management')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Fraud Rules'));
    fireEvent.click(await screen.findByText('Add Rule'));
    fireEvent.change(screen.getByPlaceholderText('exact match text'), { target: { value: 'Brand New Merchant' } });
    fireEvent.click(screen.getByText('Preview Impact'));

    expect(await screen.findByText(/would not have matched any transaction/)).toBeInTheDocument();
  });

  test('editing the value after previewing clears the stale preview', async () => {
    mockGet.mockImplementation(baseGetImpl());
    mockPost.mockImplementation((url) => {
      if (url === '/admin/fraud-rules/preview') return Promise.resolve({ data: { matched_count: 3, sample: [] } });
      return Promise.reject(new Error(`unmocked POST ${url}`));
    });

    render(<AdminPage />);
    await waitFor(() => expect(screen.getByText('User Management')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Fraud Rules'));
    fireEvent.click(await screen.findByText('Add Rule'));
    fireEvent.change(screen.getByPlaceholderText('exact match text'), { target: { value: 'Shady Imports LLC' } });
    fireEvent.click(screen.getByText('Preview Impact'));
    await screen.findByText(/would have matched 3 transactions/);

    fireEvent.change(screen.getByPlaceholderText('exact match text'), { target: { value: 'A Different Merchant' } });
    expect(screen.queryByText(/would have matched 3 transactions/)).not.toBeInTheDocument();
  });

  test('can toggle a rule off and delete it', async () => {
    const rule = makeRule();
    mockGet.mockImplementation(baseGetImpl({ rules: [rule] }));
    mockPatch.mockResolvedValue({ data: { rule: { ...rule, enabled: false } } });
    mockDelete.mockResolvedValue({ data: { message: 'Rule deleted' } });

    render(<AdminPage />);
    await waitFor(() => expect(screen.getByText('User Management')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Fraud Rules'));
    await screen.findByText('Shady Imports LLC');

    expect(screen.getByText('Enabled')).toBeInTheDocument();
    fireEvent.click(screen.getByTitle('Disable'));
    await waitFor(() => expect(mockPatch).toHaveBeenCalledWith('/admin/fraud-rules/1', { enabled: false }));
    expect(await screen.findByText('Disabled')).toBeInTheDocument();

    fireEvent.click(screen.getByTitle('Delete permanently'));
    await waitFor(() => expect(mockDelete).toHaveBeenCalledWith('/admin/fraud-rules/1'));
    await waitFor(() => expect(screen.queryByText('Shady Imports LLC')).not.toBeInTheDocument());
  });

  test('can edit a rule\'s value and reason in place', async () => {
    const rule = makeRule();
    mockGet.mockImplementation(baseGetImpl({ rules: [rule] }));
    mockPatch.mockResolvedValue({
      data: { rule: { ...rule, value: 'New Shady Imports LLC', reason: 'Escalated after a second chargeback' } },
    });

    render(<AdminPage />);
    await waitFor(() => expect(screen.getByText('User Management')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Fraud Rules'));
    await screen.findByText('Shady Imports LLC');

    fireEvent.click(screen.getByTitle('Edit value/threshold/reason'));
    const valueInput = screen.getByDisplayValue('Shady Imports LLC');
    fireEvent.change(valueInput, { target: { value: 'New Shady Imports LLC' } });
    const reasonInput = screen.getByDisplayValue('Repeated chargebacks');
    fireEvent.change(reasonInput, { target: { value: 'Escalated after a second chargeback' } });
    fireEvent.click(screen.getByText('Save Changes'));

    await waitFor(() => expect(mockPatch).toHaveBeenCalledWith('/admin/fraud-rules/1', {
      reason: 'Escalated after a second chargeback',
      value: 'New Shady Imports LLC',
    }));
    expect(await screen.findByText('New Shady Imports LLC')).toBeInTheDocument();
    expect(screen.getByText('Escalated after a second chargeback')).toBeInTheDocument();
  });

  test('editing an amount_cap rule shows a threshold field instead of a value field', async () => {
    const rule = makeRule({ id: 2, rule_type: 'amount_cap', value: null, threshold: 10000 });
    mockGet.mockImplementation(baseGetImpl({ rules: [rule] }));

    render(<AdminPage />);
    await waitFor(() => expect(screen.getByText('User Management')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Fraud Rules'));
    await screen.findByText('$10,000');

    fireEvent.click(screen.getByTitle('Edit value/threshold/reason'));
    expect(screen.getByDisplayValue('10000')).toBeInTheDocument();
  });
});

describe('AdminPage — Fraud Rings tab', () => {
  test('shows a detected ring with its risk level, members, and confirmed-fraud callout', async () => {
    mockGet.mockImplementation(baseGetImpl());
    render(<AdminPage />);
    await waitFor(() => expect(screen.getByText('User Management')).toBeInTheDocument());

    fireEvent.click(screen.getByText('Fraud Rings'));
    expect(await screen.findByText('3 accounts')).toBeInTheDocument();
    expect(screen.getByText('high risk')).toBeInTheDocument();
    expect(screen.getByText('alice')).toBeInTheDocument();
    expect(screen.getByText(/Includes confirmed-fraud account\(s\): alice/)).toBeInTheDocument();
  });

  test('shows an empty state when no rings are detected', async () => {
    mockGet.mockImplementation(baseGetImpl({ rings: [] }));
    render(<AdminPage />);
    await waitFor(() => expect(screen.getByText('User Management')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Fraud Rings'));
    expect(await screen.findByText(/No clusters of 2\+ accounts detected/)).toBeInTheDocument();
  });
});

describe('AdminPage — ML Ops tab', () => {
  test('lazy-loads model registry, drift, and shadow status only when the tab is opened', async () => {
    mockGet.mockImplementation(baseGetImpl());
    render(<AdminPage />);
    await waitFor(() => expect(screen.getByText('User Management')).toBeInTheDocument());
    expect(mockGet).not.toHaveBeenCalledWith('/admin/ml/versions');

    fireEvent.click(screen.getByText('ML Ops'));
    await waitFor(() => expect(mockGet).toHaveBeenCalledWith('/admin/ml/versions'));
    expect(await screen.findByText('v1')).toBeInTheDocument();
    expect(screen.getByText('Active')).toBeInTheDocument();
    expect(screen.getByText('stable')).toBeInTheDocument();
  });

  test('shows a retry-able error state when ml_service is unreachable, without affecting the rest of the panel', async () => {
    mockGet.mockImplementation((url) => {
      if (url.startsWith('/admin/ml/')) return Promise.reject({ response: { data: { error: 'ML service is unreachable — is ml_service running?' } } });
      return baseGetImpl()(url);
    });
    render(<AdminPage />);
    await waitFor(() => expect(screen.getByText('User Management')).toBeInTheDocument());

    fireEvent.click(screen.getByText('ML Ops'));
    expect(await screen.findByText(/ML service is unreachable/)).toBeInTheDocument();

    // the rest of the panel is unaffected — Fraud Rules still works
    fireEvent.click(screen.getByText('Fraud Rules'));
    expect(await screen.findByText('Shady Imports LLC')).toBeInTheDocument();
  });
});
