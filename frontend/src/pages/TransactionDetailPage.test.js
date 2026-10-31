import React from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import TransactionDetailPage from './TransactionDetailPage';

const mockGet = jest.fn();
const mockPost = jest.fn();

jest.mock('../context/AuthContext', () => ({
  api: { get: (...args) => mockGet(...args), post: (...args) => mockPost(...args) },
  useAuth: () => ({ user: { id: 1, role: 'user' } }),
}));

function renderPage(id = '501') {
  return render(
    <MemoryRouter initialEntries={[`/transactions/${id}`]}>
      <Routes>
        <Route path="/transactions/:id" element={<TransactionDetailPage />} />
      </Routes>
    </MemoryRouter>
  );
}

function makeTxn(overrides = {}) {
  return {
    id: 501, merchant: 'Corner Cafe', amount: 45, fraud_score: 20, risk_level: 'low',
    is_fraud: false, category: 'food', location: 'New York, US', card_type: 'credit',
    status: 'completed', created_at: '2026-01-05T12:00:00Z', fraud_reasons: [],
    scoring_method: 'rule_engine_fallback', shap_explanation: [],
    ...overrides,
  };
}

beforeEach(() => {
  mockGet.mockReset();
  mockPost.mockReset();
});

describe('TransactionDetailPage — normal transaction', () => {
  test('renders transaction details and shows no dispute/step-up panels', async () => {
    mockGet.mockImplementation((url) => {
      if (url === '/transactions/501') return Promise.resolve({ data: { transaction: makeTxn() } });
      if (url === '/disputes') return Promise.resolve({ data: { disputes: [] } });
      return Promise.reject(new Error(`unmocked GET ${url}`));
    });

    renderPage();
    expect(await screen.findByText('Corner Cafe')).toBeInTheDocument();
    expect(screen.getByText('$45.00')).toBeInTheDocument();
    expect(screen.queryByText('Step-Up Verification Required')).not.toBeInTheDocument();
    expect(screen.queryByText(/Blocked —/)).not.toBeInTheDocument();
    expect(mockGet).not.toHaveBeenCalledWith('/transactions/501/step-up');
  });

  test('shows an error state with retry on load failure', async () => {
    mockGet.mockImplementation((url) => {
      if (url === '/transactions/501') return Promise.reject({ response: { data: { error: 'Transaction not found' } } });
      if (url === '/disputes') return Promise.resolve({ data: { disputes: [] } });
      return Promise.reject(new Error(`unmocked GET ${url}`));
    });
    renderPage();
    expect(await screen.findByText('Transaction not found')).toBeInTheDocument();
  });
});

describe('TransactionDetailPage — step-up recovery (resuming an abandoned flow)', () => {
  test('polls the challenge and offers to resolve it when the transaction is still pending', async () => {
    mockGet.mockImplementation((url) => {
      if (url === '/transactions/501') return Promise.resolve({ data: { transaction: makeTxn({ status: 'pending_step_up', risk_level: 'medium' }) } });
      if (url === '/disputes') return Promise.resolve({ data: { disputes: [] } });
      if (url === '/transactions/501/step-up') {
        return Promise.resolve({ data: { transaction_status: 'pending_step_up', challenge: { status: 'pending', method: 'otp', challenge_token: 'chal_recovered' } } });
      }
      return Promise.reject(new Error(`unmocked GET ${url}`));
    });

    renderPage();
    expect(await screen.findByText('Step-Up Verification Required')).toBeInTheDocument();
    await waitFor(() => expect(mockGet).toHaveBeenCalledWith('/transactions/501/step-up'));
    expect(await screen.findByText(/OTP/)).toBeInTheDocument();
  });

  test('resolving as verified updates the page to reflect a completed transaction', async () => {
    mockGet.mockImplementation((url) => {
      if (url === '/transactions/501') return Promise.resolve({ data: { transaction: makeTxn({ status: 'pending_step_up', risk_level: 'medium' }) } });
      if (url === '/disputes') return Promise.resolve({ data: { disputes: [] } });
      if (url === '/transactions/501/step-up') {
        return Promise.resolve({ data: { transaction_status: 'pending_step_up', challenge: { status: 'pending', method: 'otp', challenge_token: 'chal_recovered' } } });
      }
      return Promise.reject(new Error(`unmocked GET ${url}`));
    });
    mockPost.mockResolvedValue({ data: { transaction: makeTxn({ status: 'completed', risk_level: 'medium' }), step_up_outcome: 'success' } });

    renderPage();
    await screen.findByText('Step-Up Verification Required');
    await act(async () => {
      fireEvent.click(await screen.findByText('Simulate: Customer Verifies'));
      await new Promise(r => setTimeout(r, 0));
    });

    expect(mockPost).toHaveBeenCalledWith('/transactions/501/step-up/verify', {
      challenge_token: 'chal_recovered',
      outcome: 'success',
    });
    expect(screen.getByText('Corner Cafe')).toBeInTheDocument();
    expect(screen.queryByText('Step-Up Verification Required')).not.toBeInTheDocument();
  });

  test('resolving as failed shows the blocked banner', async () => {
    mockGet.mockImplementation((url) => {
      if (url === '/transactions/501') return Promise.resolve({ data: { transaction: makeTxn({ status: 'pending_step_up', risk_level: 'medium' }) } });
      if (url === '/disputes') return Promise.resolve({ data: { disputes: [] } });
      if (url === '/transactions/501/step-up') {
        return Promise.resolve({ data: { transaction_status: 'pending_step_up', challenge: { status: 'pending', method: 'otp', challenge_token: 'chal_recovered' } } });
      }
      return Promise.reject(new Error(`unmocked GET ${url}`));
    });
    mockPost.mockResolvedValue({ data: { transaction: makeTxn({ status: 'blocked', risk_level: 'medium' }), step_up_outcome: 'failure' } });

    renderPage();
    await screen.findByText('Step-Up Verification Required');
    fireEvent.click(await screen.findByText('Simulate: Customer Fails'));

    expect(await screen.findByText(/the step-up verification failed/)).toBeInTheDocument();
  });

  test('a transaction already blocked on load shows the banner directly, with no challenge fetch', async () => {
    mockGet.mockImplementation((url) => {
      if (url === '/transactions/501') return Promise.resolve({ data: { transaction: makeTxn({ status: 'blocked', risk_level: 'medium' }) } });
      if (url === '/disputes') return Promise.resolve({ data: { disputes: [] } });
      return Promise.reject(new Error(`unmocked GET ${url}`));
    });

    renderPage();
    expect(await screen.findByText(/the step-up verification failed/)).toBeInTheDocument();
    expect(mockGet).not.toHaveBeenCalledWith('/transactions/501/step-up');
  });
});

describe('TransactionDetailPage — dispute panel', () => {
  test('shows an existing dispute for this transaction', async () => {
    mockGet.mockImplementation((url) => {
      if (url === '/transactions/501') return Promise.resolve({ data: { transaction: makeTxn() } });
      if (url === '/disputes') {
        return Promise.resolve({ data: { disputes: [{ id: 9, transaction_id: 501, status: 'opened', amount_disputed: 45, reason: 'Never arrived.' }] } });
      }
      return Promise.reject(new Error(`unmocked GET ${url}`));
    });

    renderPage();
    expect(await screen.findByText('Never arrived.')).toBeInTheDocument();
    expect(screen.getByText('Opened')).toBeInTheDocument();
  });

  test('opening and submitting a dispute posts the right body', async () => {
    mockGet.mockImplementation((url) => {
      if (url === '/transactions/501') return Promise.resolve({ data: { transaction: makeTxn() } });
      if (url === '/disputes') return Promise.resolve({ data: { disputes: [] } });
      return Promise.reject(new Error(`unmocked GET ${url}`));
    });
    mockPost.mockResolvedValue({ data: { dispute: { id: 9, transaction_id: 501, status: 'opened', amount_disputed: 45, reason: 'Billed twice.' } } });

    renderPage();
    await screen.findByText('Corner Cafe');
    fireEvent.click(screen.getByText('Open a Dispute'));
    fireEvent.change(screen.getByPlaceholderText(/never arrived/i), { target: { value: 'Billed twice.' } });
    await act(async () => {
      fireEvent.click(screen.getByText('Submit Dispute'));
      await new Promise(r => setTimeout(r, 0));
    });

    expect(mockPost).toHaveBeenCalledWith('/disputes', { transaction_id: 501, reason: 'Billed twice.' });
    expect(screen.getByText('Billed twice.')).toBeInTheDocument();
  });
});
