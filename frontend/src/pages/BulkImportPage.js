import React, { useState, useMemo, useRef } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../context/AuthContext';
import { parseCsv } from '../utils/csv';
import {
  Upload, Download, FileText, CheckCircle, XCircle, AlertTriangle,
  ShieldQuestion, Trash2, Send,
} from 'lucide-react';
import PageHeading from '../components/ui/PageHeading';
import { RISK_TEXT } from '../constants/risk';

// Kept in sync with backend/schemas/transactionSchemas.js and
// pages/NewTransactionPage.js's own copy of the same lists.
const CATEGORIES = ['grocery', 'food', 'electronics', 'travel', 'entertainment', 'utilities', 'clothing', 'health', 'crypto', 'gambling', 'wire_transfer'];
const LOCATIONS = ['New York, US', 'London, UK', 'Toronto, CA', 'Bengaluru, IN', 'Sydney, AU', 'Berlin, DE', 'Singapore, SG', 'Lagos, NG', 'Unknown', 'Anonymous Proxy'];
const CARD_TYPES = ['credit', 'debit', 'prepaid'];
const MAX_ROWS = 50;
const REQUIRED_COLUMNS = ['amount', 'merchant', 'category', 'location', 'card_type'];

const TEMPLATE_CSV = 'amount,merchant,category,location,card_type\n'
  + '42.50,Whole Foods,grocery,"New York, US",debit\n'
  + '2500,Some Shop,electronics,"Lagos, NG",prepaid\n';

function downloadTemplate() {
  const url = window.URL.createObjectURL(new Blob([TEMPLATE_CSV], { type: 'text/csv' }));
  const link = document.createElement('a');
  link.href = url;
  link.setAttribute('download', 'transactions-template.csv');
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.URL.revokeObjectURL(url);
}

/** Validates and normalizes one parsed CSV row into a transaction
 * payload, or returns the reasons it can't be submitted as-is. */
function validateRow(row) {
  const errors = [];
  const amount = Number(row.amount);
  if (!row.amount || Number.isNaN(amount) || amount <= 0) errors.push('amount must be a positive number');
  else if (amount > 1_000_000) errors.push('amount is unreasonably large');

  if (!row.merchant || !row.merchant.trim()) errors.push('merchant is required');
  else if (row.merchant.length > 100) errors.push('merchant is too long');

  if (!CATEGORIES.includes(row.category)) errors.push(`category must be one of: ${CATEGORIES.join(', ')}`);
  if (!LOCATIONS.includes(row.location)) errors.push(`location must be one of: ${LOCATIONS.join(', ')}`);
  if (!CARD_TYPES.includes(row.card_type)) errors.push(`card_type must be one of: ${CARD_TYPES.join(', ')}`);

  return {
    errors,
    valid: errors.length === 0,
    normalized: { amount, merchant: row.merchant?.trim(), category: row.category, location: row.location, card_type: row.card_type },
  };
}

/**
 * Bulk transaction import (feature: bulk transaction import/batch
 * scoring) — the ops-tool counterpart to the one-at-a-time Simulator:
 * paste or upload a CSV of transactions and score all of them through
 * the exact same fraud-detection pipeline in one request. See
 * backend/routes/transactions.js's POST /transactions/bulk.
 */
export default function BulkImportPage() {
  const [csvText, setCsvText] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState('');
  const [result, setResult] = useState(null);
  const fileInputRef = useRef(null);

  const { headers, rows } = useMemo(() => parseCsv(csvText), [csvText]);
  const missingColumns = useMemo(
    () => (headers.length > 0 ? REQUIRED_COLUMNS.filter(c => !headers.includes(c)) : []),
    [headers]
  );
  const validated = useMemo(() => rows.map(validateRow), [rows]);
  const invalidCount = validated.filter(v => !v.valid).length;
  const canSubmit = rows.length > 0 && rows.length <= MAX_ROWS && missingColumns.length === 0 && invalidCount === 0;

  const handleFile = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => setCsvText(ev.target.result);
    reader.readAsText(file);
  };

  const reset = () => {
    setCsvText('');
    setResult(null);
    setSubmitError('');
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const submit = async () => {
    setSubmitting(true);
    setSubmitError('');
    try {
      const { data } = await api.post('/transactions/bulk', { transactions: validated.map(v => v.normalized) });
      setResult(data);
    } catch (err) {
      setSubmitError(err.response?.data?.error || 'Failed to submit the batch');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="p-4 sm:p-8 max-w-4xl mx-auto">
      <div className="mb-6 sm:mb-8 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <PageHeading icon={Upload} title="Bulk Import" subtitle="Score a batch of transactions in one request" />
        </div>
        <button
          onClick={downloadTemplate}
          className="flex items-center gap-2 bg-white/5 hover:bg-white/10 text-gray-300 px-4 py-2 rounded-lg text-sm transition-colors shrink-0"
        >
          <Download size={16} /> Download Template
        </button>
      </div>

      {!result && (
        <div className="bg-[#111820] border border-white/10 rounded-xl p-5 sm:p-6 mb-6">
          <div className="flex flex-wrap items-center gap-3 mb-4">
            <label className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg text-sm cursor-pointer transition-colors">
              <Upload size={16} /> Upload CSV
              <input ref={fileInputRef} type="file" accept=".csv,text/csv" onChange={handleFile} className="hidden" />
            </label>
            <span className="text-gray-500 text-sm">or paste CSV text below</span>
            {csvText && (
              <button onClick={reset} className="ml-auto flex items-center gap-1 text-gray-400 hover:text-white text-sm transition-colors">
                <Trash2 size={14} /> Clear
              </button>
            )}
          </div>

          <textarea
            value={csvText}
            onChange={e => setCsvText(e.target.value)}
            rows={6}
            placeholder={'amount,merchant,category,location,card_type\n42.50,Whole Foods,grocery,"New York, US",debit'}
            className="w-full bg-[#0a0f14] border border-white/20 rounded-lg px-3 py-2 text-sm text-white font-mono focus:outline-none focus:border-purple-500 mb-2"
          />
          <p className="text-gray-500 text-xs mb-4">
            Required columns: <code>{REQUIRED_COLUMNS.join(', ')}</code>. Valid <code>category</code> values:{' '}
            {CATEGORIES.join(', ')}. Valid <code>location</code> values: {LOCATIONS.join(', ')}. Valid{' '}
            <code>card_type</code> values: {CARD_TYPES.join(', ')}.
          </p>

          {rows.length > 0 && (
            <div className="mb-4">
              <div className="flex items-center gap-2 mb-2">
                <FileText size={14} className="text-gray-400" />
                <p className="text-gray-300 text-sm">
                  {rows.length} row{rows.length === 1 ? '' : 's'} parsed
                  {invalidCount > 0 && <span className="text-red-400"> — {invalidCount} invalid</span>}
                  {rows.length > MAX_ROWS && <span className="text-red-400"> — over the {MAX_ROWS}-row limit</span>}
                </p>
              </div>
              {missingColumns.length > 0 && (
                <p className="text-red-400 text-xs mb-2">Missing required column(s): {missingColumns.join(', ')}</p>
              )}
              <div className="overflow-x-auto border border-white/10 rounded-lg max-h-64 overflow-y-auto">
                <table className="w-full text-sm">
                  <thead className="sticky top-0 bg-[#0a0f14]">
                    <tr className="border-b border-white/10 text-gray-400">
                      <th className="text-left px-3 py-2">#</th>
                      <th className="text-left px-3 py-2">Amount</th>
                      <th className="text-left px-3 py-2">Merchant</th>
                      <th className="text-left px-3 py-2">Category</th>
                      <th className="text-left px-3 py-2">Location</th>
                      <th className="text-left px-3 py-2">Card</th>
                      <th className="text-left px-3 py-2">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row, i) => (
                      <tr key={i} className={`border-b border-white/5 ${validated[i].valid ? '' : 'bg-red-500/5'}`}>
                        <td className="px-3 py-2 text-gray-500">{i + 1}</td>
                        <td className="px-3 py-2 text-gray-300">{row.amount}</td>
                        <td className="px-3 py-2 text-gray-300">{row.merchant}</td>
                        <td className="px-3 py-2 text-gray-300">{row.category}</td>
                        <td className="px-3 py-2 text-gray-300">{row.location}</td>
                        <td className="px-3 py-2 text-gray-300">{row.card_type}</td>
                        <td className="px-3 py-2">
                          {validated[i].valid ? (
                            <CheckCircle size={14} className="text-green-400" />
                          ) : (
                            <span title={validated[i].errors.join('; ')}>
                              <XCircle size={14} className="text-red-400" />
                            </span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {invalidCount > 0 && (
                <ul className="mt-2 space-y-1">
                  {validated.map((v, i) => (v.valid ? null : (
                    <li key={i} className="text-red-400 text-xs">Row {i + 1}: {v.errors.join('; ')}</li>
                  )))}
                </ul>
              )}
            </div>
          )}

          {submitError && <p className="text-red-400 text-sm mb-3">{submitError}</p>}

          <button
            onClick={submit}
            disabled={!canSubmit || submitting}
            className="flex items-center gap-2 bg-purple-600 hover:bg-purple-700 disabled:opacity-40 text-white px-4 py-2.5 rounded-lg text-sm font-medium transition-colors"
          >
            <Send size={16} /> {submitting ? 'Scoring...' : `Score ${rows.length || ''} Transaction${rows.length === 1 ? '' : 's'}`}
          </button>
        </div>
      )}

      {result && (
        <div className="space-y-6">
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
            <div className="bg-[#111820] border border-white/10 rounded-xl p-4 sm:p-6">
              <p className="text-gray-400 text-xs sm:text-sm mb-1">Completed</p>
              <p className="text-xl sm:text-2xl font-bold text-white">{result.summary.completed}</p>
            </div>
            <div className="bg-[#111820] border border-white/10 rounded-xl p-4 sm:p-6">
              <p className="text-gray-400 text-xs sm:text-sm mb-1">Flagged</p>
              <p className="text-xl sm:text-2xl font-bold text-yellow-400">{result.summary.flagged}</p>
            </div>
            <div className="bg-[#111820] border border-white/10 rounded-xl p-4 sm:p-6">
              <p className="text-gray-400 text-xs sm:text-sm mb-1">Held for Step-Up</p>
              <p className="text-xl sm:text-2xl font-bold text-blue-400">{result.summary.held_for_step_up}</p>
            </div>
            <div className="bg-[#111820] border border-white/10 rounded-xl p-4 sm:p-6">
              <p className="text-gray-400 text-xs sm:text-sm mb-1">Failed</p>
              <p className="text-xl sm:text-2xl font-bold text-red-400">{result.summary.failed}</p>
            </div>
          </div>

          <div className="bg-[#111820] border border-white/10 rounded-xl">
            <div className="p-6 border-b border-white/10 flex items-center justify-between">
              <h2 className="text-lg font-semibold text-white">Results</h2>
              <button onClick={reset} className="text-purple-400 hover:text-purple-300 text-sm transition-colors">Import Another Batch</button>
            </div>
            <div className="divide-y divide-white/5">
              {result.results.map(r => (
                <div key={r.index} className="p-4 sm:p-6 flex items-center justify-between gap-4">
                  <div className="min-w-0">
                    <p className="text-gray-500 text-xs">Row {r.index + 1}</p>
                    {r.error ? (
                      <p className="text-red-400 text-sm flex items-center gap-1"><AlertTriangle size={14} /> {r.error}</p>
                    ) : (
                      <Link to={`/transactions/${r.transaction.id}`} className="text-white text-sm hover:underline transition-colors">
                        {r.transaction.merchant} — ${Number(r.transaction.amount).toFixed(2)}
                      </Link>
                    )}
                  </div>
                  {!r.error && (
                    <div className="flex items-center gap-2 shrink-0">
                      {r.step_up ? (
                        <span className="flex items-center gap-1 text-xs text-blue-400"><ShieldQuestion size={14} /> Step-up held</span>
                      ) : (
                        <span className={`text-xs font-semibold capitalize ${RISK_TEXT[r.analysis.risk_level]}`}>{r.analysis.risk_level} risk</span>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
