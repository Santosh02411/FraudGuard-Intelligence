import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import BulkImportPage from './BulkImportPage';

const mockPost = jest.fn();

jest.mock('../context/AuthContext', () => ({
  api: { post: (...args) => mockPost(...args) },
}));

function renderPage() {
  return render(<MemoryRouter><BulkImportPage /></MemoryRouter>);
}

const VALID_CSV = 'amount,merchant,category,location,card_type\n50,Starbucks,food,"New York, US",credit\n5000,Some Shop,electronics,"Lagos, NG",prepaid';

beforeEach(() => {
  mockPost.mockReset();
  window.URL.createObjectURL = jest.fn(() => 'blob:mock-url');
  window.URL.revokeObjectURL = jest.fn();
});

describe('BulkImportPage — parsing and validation', () => {
  test('parses pasted CSV and shows a row-count summary', async () => {
    renderPage();
    fireEvent.change(screen.getByPlaceholderText(/amount,merchant,category/), { target: { value: VALID_CSV } });
    expect(await screen.findByText('2 rows parsed')).toBeInTheDocument();
  });

  test('a row with an invalid category is flagged and blocks submission', async () => {
    renderPage();
    const badCsv = 'amount,merchant,category,location,card_type\n50,Starbucks,not-a-category,"New York, US",credit';
    fireEvent.change(screen.getByPlaceholderText(/amount,merchant,category/), { target: { value: badCsv } });

    await waitFor(() => {
      const match = screen.getAllByText((_, el) => el?.textContent === '1 row parsed — 1 invalid').length > 0;
      expect(match).toBe(true);
    });
    expect(screen.getByText(/category must be one of/)).toBeInTheDocument();
    expect(screen.getByText(/Score 1 Transaction/).closest('button')).toBeDisabled();
  });

  test('a CSV missing a required column blocks submission', async () => {
    renderPage();
    fireEvent.change(screen.getByPlaceholderText(/amount,merchant,category/), {
      target: { value: 'amount,merchant\n50,Starbucks' },
    });

    expect(await screen.findByText(/Missing required column\(s\): category, location, card_type/)).toBeInTheDocument();
    expect(screen.getByText(/Score 1 Transaction/).closest('button')).toBeDisabled();
  });

  test('more than 50 rows blocks submission', async () => {
    renderPage();
    const header = 'amount,merchant,category,location,card_type';
    const row = '50,Starbucks,food,"New York, US",credit';
    const csv = [header, ...Array(51).fill(row)].join('\n');
    fireEvent.change(screen.getByPlaceholderText(/amount,merchant,category/), { target: { value: csv } });

    expect(await screen.findByText(/over the 50-row limit/)).toBeInTheDocument();
    expect(screen.getByText(/Score 51 Transactions/).closest('button')).toBeDisabled();
  });

  test('clear removes the parsed preview', async () => {
    renderPage();
    fireEvent.change(screen.getByPlaceholderText(/amount,merchant,category/), { target: { value: VALID_CSV } });
    await screen.findByText('2 rows parsed');

    fireEvent.click(screen.getByText('Clear'));
    expect(screen.queryByText('2 rows parsed')).not.toBeInTheDocument();
  });
});

describe('BulkImportPage — submission', () => {
  test('submits the normalized rows and shows the summary + per-row results', async () => {
    mockPost.mockResolvedValue({
      data: {
        summary: { total: 2, completed: 2, flagged: 1, held_for_step_up: 0, failed: 0 },
        results: [
          { index: 0, transaction: { id: 501, merchant: 'Starbucks', amount: 50 }, analysis: { risk_level: 'low' }, step_up: null },
          { index: 1, transaction: { id: 502, merchant: 'Some Shop', amount: 5000 }, analysis: { risk_level: 'high' }, step_up: null },
        ],
      },
    });

    renderPage();
    fireEvent.change(screen.getByPlaceholderText(/amount,merchant,category/), { target: { value: VALID_CSV } });
    await screen.findByText('2 rows parsed');
    fireEvent.click(screen.getByText(/Score 2 Transactions/));

    await waitFor(() => expect(mockPost).toHaveBeenCalledWith('/transactions/bulk', {
      transactions: [
        { amount: 50, merchant: 'Starbucks', category: 'food', location: 'New York, US', card_type: 'credit' },
        { amount: 5000, merchant: 'Some Shop', category: 'electronics', location: 'Lagos, NG', card_type: 'prepaid' },
      ],
    }));

    expect(await screen.findByText('Results')).toBeInTheDocument();
    expect(screen.getAllByText('2')[0]).toBeInTheDocument(); // completed count
    expect(screen.getByText(/Starbucks — \$50\.00/)).toBeInTheDocument();
    expect(screen.getByText(/Some Shop — \$5000\.00/)).toBeInTheDocument();
    expect(screen.getByText('high risk')).toBeInTheDocument();
  });

  test('a per-row failure in the response shows an inline error for that row', async () => {
    mockPost.mockResolvedValue({
      data: {
        summary: { total: 1, completed: 0, flagged: 0, held_for_step_up: 0, failed: 1 },
        results: [{ index: 0, error: 'Failed to score this transaction' }],
      },
    });

    renderPage();
    fireEvent.change(screen.getByPlaceholderText(/amount,merchant,category/), { target: { value: VALID_CSV } });
    await screen.findByText('2 rows parsed');
    fireEvent.click(screen.getByText(/Score 2 Transactions/));

    expect(await screen.findByText('Failed to score this transaction')).toBeInTheDocument();
  });

  test('a held-for-step-up row is labeled distinctly from a risk level', async () => {
    mockPost.mockResolvedValue({
      data: {
        summary: { total: 1, completed: 1, flagged: 0, held_for_step_up: 1, failed: 0 },
        results: [{ index: 0, transaction: { id: 501, merchant: 'Bet365', amount: 2000 }, analysis: { risk_level: 'medium' }, step_up: { required: true } }],
      },
    });

    renderPage();
    fireEvent.change(screen.getByPlaceholderText(/amount,merchant,category/), { target: { value: VALID_CSV } });
    await screen.findByText('2 rows parsed');
    fireEvent.click(screen.getByText(/Score 2 Transactions/));

    expect(await screen.findByText('Step-up held')).toBeInTheDocument();
    expect(screen.queryByText('medium risk')).not.toBeInTheDocument();
  });

  test('a failed submission shows an error and keeps the form usable', async () => {
    mockPost.mockRejectedValue({ response: { data: { error: 'A row exceeded the maximum amount' } } });

    renderPage();
    fireEvent.change(screen.getByPlaceholderText(/amount,merchant,category/), { target: { value: VALID_CSV } });
    await screen.findByText('2 rows parsed');
    fireEvent.click(screen.getByText(/Score 2 Transactions/));

    expect(await screen.findByText('A row exceeded the maximum amount')).toBeInTheDocument();
    expect(screen.getByText(/Score 2 Transactions/)).toBeInTheDocument();
  });

  test('"Import Another Batch" resets back to the empty form', async () => {
    mockPost.mockResolvedValue({
      data: {
        summary: { total: 1, completed: 1, flagged: 0, held_for_step_up: 0, failed: 0 },
        results: [{ index: 0, transaction: { id: 501, merchant: 'Starbucks', amount: 50 }, analysis: { risk_level: 'low' }, step_up: null }],
      },
    });

    renderPage();
    fireEvent.change(screen.getByPlaceholderText(/amount,merchant,category/), { target: { value: VALID_CSV } });
    await screen.findByText('2 rows parsed');
    fireEvent.click(screen.getByText(/Score 2 Transactions/));
    await screen.findByText('Results');

    fireEvent.click(screen.getByText('Import Another Batch'));
    expect(screen.getByPlaceholderText(/amount,merchant,category/)).toHaveValue('');
    expect(screen.queryByText('Results')).not.toBeInTheDocument();
  });
});
