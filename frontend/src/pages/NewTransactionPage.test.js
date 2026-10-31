import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import NewTransactionPage from './NewTransactionPage';

const mockPost = jest.fn();

jest.mock('../context/AuthContext', () => ({
  api: { post: (...args) => mockPost(...args) },
}));

function fillAndSubmit() {
  fireEvent.change(screen.getByPlaceholderText('e.g. 150.00'), { target: { value: '850' } });
  fireEvent.change(screen.getByPlaceholderText('e.g. Amazon'), { target: { value: 'Airbnb' } });
  fireEvent.click(screen.getByText('Run Through Fraud Engine'));
}

function normalResult(overrides = {}) {
  return {
    transaction: { id: 501, status: 'completed', ...overrides.transaction },
    step_up: null,
    analysis: {
      is_fraud: false, fraud_score: 20, risk_level: 'low', fraud_reasons: [],
      scoring_method: 'rule_engine_fallback', shap_explanation: [],
      message: '✅ Transaction looks safe.',
      ...overrides.analysis,
    },
  };
}

function stepUpResult() {
  return {
    transaction: { id: 502, status: 'pending_step_up' },
    step_up: {
      required: true,
      transaction_id: 502,
      challenge_token: 'chal_abc123',
      method: 'otp',
      expires_at: '2026-01-01T00:10:00Z',
      verify_url: '/api/transactions/502/step-up/verify',
    },
    analysis: {
      is_fraud: false, fraud_score: 55, risk_level: 'medium', fraud_reasons: ['High transaction amount ($850.00)'],
      scoring_method: 'rule_engine_fallback', shap_explanation: [],
      message: '🔐 Additional verification required before this transaction can complete.',
    },
  };
}

beforeEach(() => {
  mockPost.mockReset();
});

describe('NewTransactionPage — no step-up', () => {
  test('a normal result renders without any step-up panel', async () => {
    mockPost.mockResolvedValue({ data: normalResult() });
    render(<NewTransactionPage />);
    fillAndSubmit();

    expect(await screen.findByText('Transaction looks safe.', { exact: false })).toBeInTheDocument();
    expect(screen.queryByText('Step-Up Verification Required')).not.toBeInTheDocument();
  });
});

describe('NewTransactionPage — step-up required', () => {
  test('shows the step-up panel with simulate actions when the response requires it', async () => {
    mockPost.mockResolvedValue({ data: stepUpResult() });
    render(<NewTransactionPage />);
    fillAndSubmit();

    expect(await screen.findByText('Step-Up Verification Required')).toBeInTheDocument();
    expect(screen.getByText(/OTP/)).toBeInTheDocument();
    expect(screen.getByText('Simulate: Customer Verifies')).toBeInTheDocument();
    expect(screen.getByText('Simulate: Customer Fails')).toBeInTheDocument();
  });

  test('simulating a customer verifying calls the verify endpoint and shows the transaction as completed', async () => {
    mockPost.mockImplementation((url) => {
      if (url === '/transactions') return Promise.resolve({ data: stepUpResult() });
      if (url === '/transactions/502/step-up/verify') {
        return Promise.resolve({ data: { transaction: { id: 502, status: 'completed' }, step_up_outcome: 'success' } });
      }
      return Promise.reject(new Error(`unmocked POST ${url}`));
    });

    render(<NewTransactionPage />);
    fillAndSubmit();
    await screen.findByText('Step-Up Verification Required');

    fireEvent.click(screen.getByText('Simulate: Customer Verifies'));

    await waitFor(() => expect(mockPost).toHaveBeenCalledWith('/transactions/502/step-up/verify', {
      challenge_token: 'chal_abc123',
      outcome: 'success',
    }));
    expect(screen.queryByText('Step-Up Verification Required')).not.toBeInTheDocument();
    expect(await screen.findByText(/the step-up check passed/)).toBeInTheDocument();
  });

  test('simulating a customer failing blocks the transaction', async () => {
    mockPost.mockImplementation((url) => {
      if (url === '/transactions') return Promise.resolve({ data: stepUpResult() });
      if (url === '/transactions/502/step-up/verify') {
        return Promise.resolve({ data: { transaction: { id: 502, status: 'blocked' }, step_up_outcome: 'failure' } });
      }
      return Promise.reject(new Error(`unmocked POST ${url}`));
    });

    render(<NewTransactionPage />);
    fillAndSubmit();
    await screen.findByText('Step-Up Verification Required');

    fireEvent.click(screen.getByText('Simulate: Customer Fails'));

    await waitFor(() => expect(mockPost).toHaveBeenCalledWith('/transactions/502/step-up/verify', {
      challenge_token: 'chal_abc123',
      outcome: 'failure',
    }));
    expect(await screen.findByText(/the step-up verification failed/)).toBeInTheDocument();
  });

  test('a failed verify call shows an error and keeps the panel open for retry', async () => {
    mockPost.mockImplementation((url) => {
      if (url === '/transactions') return Promise.resolve({ data: stepUpResult() });
      if (url === '/transactions/502/step-up/verify') {
        return Promise.reject({ response: { data: { error: 'This challenge has expired' } } });
      }
      return Promise.reject(new Error(`unmocked POST ${url}`));
    });

    render(<NewTransactionPage />);
    fillAndSubmit();
    await screen.findByText('Step-Up Verification Required');

    fireEvent.click(screen.getByText('Simulate: Customer Verifies'));

    expect(await screen.findByText('This challenge has expired')).toBeInTheDocument();
    // still resolvable — the panel/buttons are still there for a retry
    expect(screen.getByText('Simulate: Customer Verifies')).toBeInTheDocument();
  });
});
