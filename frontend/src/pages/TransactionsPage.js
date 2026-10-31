import React, { useState, useEffect } from 'react';
import { api } from '../context/AuthContext';
import { Link } from 'react-router-dom';
import { Filter, X, ChevronLeft, ChevronRight, List, Download } from 'lucide-react';
import { LoadingState, ErrorState, EmptyState } from '../components/ui/States';
import { downloadBlobResponse } from '../utils/download';
import PageHeading from '../components/ui/PageHeading';
import DotBadge from '../components/ui/DotBadge';
import { RISK_STYLE, RISK_DOT } from '../constants/risk';

const PAGE_SIZE = 20;
const EMPTY_FILTERS = { merchant: '', category: '', riskLevel: '', amountMin: '', amountMax: '', dateFrom: '', dateTo: '' };
const CATEGORIES = ['grocery', 'food', 'electronics', 'travel', 'entertainment', 'utilities', 'clothing', 'health', 'crypto', 'gambling', 'wire_transfer'];

/**
 * Full transaction history — the search/filter "ops tool" view that the
 * Dashboard's 10-row recent list and the Simulator's one-off result
 * can't provide: every transaction, filterable and paginated, with a
 * click-through to the full record (including its SHAP explanation).
 */
export default function TransactionsPage() {
  const [transactions, setTransactions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [page, setPage] = useState(1);
  const [pageInfo, setPageInfo] = useState(null);
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const [showFilters, setShowFilters] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState('');

  const load = (targetPage = page, activeFilters = filters) => {
    setLoading(true);
    setError('');
    const params = { page: targetPage, limit: PAGE_SIZE };
    Object.entries(activeFilters).forEach(([key, value]) => {
      if (value) params[key] = value;
    });
    api.get('/transactions', { params })
      .then(res => {
        setTransactions(res.data.transactions);
        setPageInfo(res.data.pagination);
        setPage(targetPage);
      })
      .catch((err) => setError(err.response?.data?.error || 'Failed to load transactions'))
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(1, EMPTY_FILTERS); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const applyFilters = (e) => {
    e.preventDefault();
    load(1, filters);
  };

  const clearFilters = () => {
    setFilters(EMPTY_FILTERS);
    load(1, EMPTY_FILTERS);
  };

  const exportCsv = async () => {
    setExportError('');
    setExporting(true);
    try {
      const params = {};
      Object.entries(filters).forEach(([key, value]) => {
        if (value) params[key] = value;
      });
      const res = await api.get('/transactions/export', { params, responseType: 'blob' });
      downloadBlobResponse(res, 'transactions.csv');
    } catch (err) {
      setExportError('Failed to export transactions');
    } finally {
      setExporting(false);
    }
  };

  const activeFilterCount = Object.values(filters).filter(Boolean).length;

  return (
    <div className="p-4 sm:p-8 max-w-5xl mx-auto">
      <div className="mb-6 sm:mb-8 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <PageHeading icon={List} title="Transactions" subtitle="Search and filter the full transaction history." subtitleClassName="text-gray-400 mt-1 text-sm sm:text-base" />
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={() => setShowFilters(v => !v)}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm transition-colors ${
              activeFilterCount > 0 ? 'bg-purple-600 hover:bg-purple-700 text-white' : 'bg-white/5 hover:bg-white/10 text-gray-300'
            }`}
          >
            <Filter size={16} /> Filters {activeFilterCount > 0 && `(${activeFilterCount})`}
          </button>
          <button
            onClick={exportCsv}
            disabled={exporting}
            className="flex items-center gap-2 bg-white/5 hover:bg-white/10 disabled:opacity-50 text-gray-300 px-4 py-2 rounded-lg text-sm transition-colors"
          >
            <Download size={16} /> {exporting ? 'Exporting...' : 'Export CSV'}
          </button>
        </div>
      </div>
      {exportError && <p className="text-red-400 text-sm mb-4">{exportError}</p>}

      {showFilters && (
        <form onSubmit={applyFilters} className="bg-[#111820] border border-white/10 rounded-xl p-4 sm:p-5 mb-4 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          <div>
            <label className="block text-xs text-gray-400 mb-1">Merchant</label>
            <input
              type="text"
              value={filters.merchant}
              onChange={e => setFilters(f => ({ ...f, merchant: e.target.value }))}
              placeholder="e.g. Amazon"
              className="w-full bg-[#0a0f14] border border-white/20 rounded-lg px-3 py-2 text-sm text-white"
            />
          </div>
          <div>
            <label className="block text-xs text-gray-400 mb-1">Category</label>
            <select
              value={filters.category}
              onChange={e => setFilters(f => ({ ...f, category: e.target.value }))}
              className="w-full bg-[#0a0f14] border border-white/20 rounded-lg px-3 py-2 text-sm text-white"
            >
              <option value="">All</option>
              {CATEGORIES.map(c => <option key={c} value={c} className="capitalize">{c}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-xs text-gray-400 mb-1">Risk Level</label>
            <select
              value={filters.riskLevel}
              onChange={e => setFilters(f => ({ ...f, riskLevel: e.target.value }))}
              className="w-full bg-[#0a0f14] border border-white/20 rounded-lg px-3 py-2 text-sm text-white"
            >
              <option value="">All</option>
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
            </select>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="block text-xs text-gray-400 mb-1">Min $</label>
              <input
                type="number" min="0" step="0.01"
                value={filters.amountMin}
                onChange={e => setFilters(f => ({ ...f, amountMin: e.target.value }))}
                className="w-full bg-[#0a0f14] border border-white/20 rounded-lg px-3 py-2 text-sm text-white"
              />
            </div>
            <div>
              <label className="block text-xs text-gray-400 mb-1">Max $</label>
              <input
                type="number" min="0" step="0.01"
                value={filters.amountMax}
                onChange={e => setFilters(f => ({ ...f, amountMax: e.target.value }))}
                className="w-full bg-[#0a0f14] border border-white/20 rounded-lg px-3 py-2 text-sm text-white"
              />
            </div>
          </div>
          <div>
            <label className="block text-xs text-gray-400 mb-1">From</label>
            <input
              type="date"
              value={filters.dateFrom}
              onChange={e => setFilters(f => ({ ...f, dateFrom: e.target.value }))}
              className="w-full bg-[#0a0f14] border border-white/20 rounded-lg px-3 py-2 text-sm text-white"
            />
          </div>
          <div>
            <label className="block text-xs text-gray-400 mb-1">To</label>
            <input
              type="date"
              value={filters.dateTo}
              onChange={e => setFilters(f => ({ ...f, dateTo: e.target.value }))}
              className="w-full bg-[#0a0f14] border border-white/20 rounded-lg px-3 py-2 text-sm text-white"
            />
          </div>
          <div className="flex items-end gap-2 sm:col-span-2 lg:col-span-1">
            <button type="submit" className="bg-purple-600 hover:bg-purple-700 text-white px-4 py-2 rounded-lg text-sm transition-colors">
              Apply
            </button>
            {activeFilterCount > 0 && (
              <button type="button" onClick={clearFilters} className="flex items-center gap-1 text-gray-400 hover:text-white text-sm px-3 py-2 transition-colors">
                <X size={14} /> Clear
              </button>
            )}
          </div>
        </form>
      )}

      <div className="bg-[#111820] border border-white/10 rounded-xl">
        {loading ? (
          <LoadingState label="Loading transactions..." />
        ) : error ? (
          <ErrorState message={error} onRetry={() => load(page)} />
        ) : transactions.length === 0 ? (
          <EmptyState title="No transactions match these filters" subtitle={activeFilterCount > 0 ? 'Try clearing a filter.' : undefined} />
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-gray-400 border-b border-white/10">
                    <th className="px-4 sm:px-6 py-3 font-medium">Merchant</th>
                    <th className="px-4 sm:px-6 py-3 font-medium">Category</th>
                    <th className="px-4 sm:px-6 py-3 font-medium">Amount</th>
                    <th className="px-4 sm:px-6 py-3 font-medium">Risk</th>
                    <th className="px-4 sm:px-6 py-3 font-medium">Date</th>
                  </tr>
                </thead>
                <tbody>
                  {transactions.map(t => (
                    <tr key={t.id} className="border-b border-white/5 last:border-0 hover:bg-white/5 transition-colors">
                      <td className="px-4 sm:px-6 py-3">
                        <Link to={`/transactions/${t.id}`} className="text-white hover:text-purple-400 transition-colors">{t.merchant}</Link>
                      </td>
                      <td className="px-4 sm:px-6 py-3 text-gray-400 capitalize">{t.category}</td>
                      <td className="px-4 sm:px-6 py-3 text-white tabular-nums">${Number(t.amount).toFixed(2)}</td>
                      <td className="px-4 sm:px-6 py-3">
                        <DotBadge label={t.risk_level} colorClass={RISK_STYLE[t.risk_level]} dotClass={RISK_DOT[t.risk_level]} />
                      </td>
                      <td className="px-4 sm:px-6 py-3 text-gray-500">{new Date(t.created_at).toLocaleDateString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {pageInfo && pageInfo.total_pages > 1 && (
              <div className="flex items-center justify-between px-6 py-4 border-t border-white/10">
                <span className="text-xs text-gray-500">
                  Page {pageInfo.page} of {pageInfo.total_pages} &middot; {pageInfo.total} total
                </span>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => load(page - 1)}
                    disabled={!pageInfo.has_prev || loading}
                    className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-sm text-gray-300 bg-white/5 hover:bg-white/10 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                  >
                    <ChevronLeft size={14} /> Prev
                  </button>
                  <button
                    onClick={() => load(page + 1)}
                    disabled={!pageInfo.has_next || loading}
                    className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-sm text-gray-300 bg-white/5 hover:bg-white/10 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                  >
                    Next <ChevronRight size={14} />
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
