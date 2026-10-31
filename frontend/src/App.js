import React from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './context/AuthContext';
import { SocketProvider } from './context/SocketContext';
import AppLayout from './components/AppLayout';
import LoginPage from './pages/LoginPage';
import ResetPasswordPage from './pages/ResetPasswordPage';
import VerifyEmailPage from './pages/VerifyEmailPage';
import DashboardPage from './pages/DashboardPage';
import NewTransactionPage from './pages/NewTransactionPage';
import BulkImportPage from './pages/BulkImportPage';
import TransactionsPage from './pages/TransactionsPage';
import TransactionDetailPage from './pages/TransactionDetailPage';
import ModelPerformancePage from './pages/ModelPerformancePage';
import CasesPage from './pages/CasesPage';
import RuleLabPage from './pages/RuleLabPage';
import VerificationPage from './pages/VerificationPage';
import CustomerProfilesPage from './pages/CustomerProfilesPage';
import FeedbackPage from './pages/FeedbackPage';
import CaseDetailPage from './pages/CaseDetailPage';
import RelationshipsPage from './pages/RelationshipsPage';
import AlertsPage from './pages/AlertsPage';
import DisputesPage from './pages/DisputesPage';
import AnalyticsPage from './pages/AnalyticsPage';
import AdminPage from './pages/AdminPage';
import LiveFeedPage from './pages/LiveFeedPage';
import SettingsPage from './pages/SettingsPage';
import CogneeMemoryPage from './pages/CogneeMemoryPage';

function FullPageLoading() {
  return <div className="min-h-screen bg-[#0a0f14] flex items-center justify-center text-gray-400">Loading...</div>;
}

function PrivateRoute({ children, adminOnly = false }) {
  const { user, loading } = useAuth();
  if (loading) return <FullPageLoading />;
  if (!user) return <Navigate to="/login" replace />;
  if (adminOnly && user.role !== 'admin') return <Navigate to="/dashboard" replace />;
  return children;
}

// The sidebar/top-bar shell lives in components/AppLayout.js (it also owns the per-page ErrorBoundary).
const Layout = AppLayout;

function AppRoutes() {
  const { user, loading } = useAuth();
  return (
    <Routes>
      <Route path="/login" element={loading ? <FullPageLoading /> : user ? <Navigate to="/dashboard" /> : <LoginPage />} />
      {/* Public — the token in the URL is itself the credential, so
          these are reachable whether or not the visitor is logged in. */}
      <Route path="/reset-password" element={<ResetPasswordPage />} />
      <Route path="/verify-email" element={<VerifyEmailPage />} />
      <Route path="/dashboard" element={<PrivateRoute><Layout><DashboardPage /></Layout></PrivateRoute>} />
      <Route path="/settings" element={<PrivateRoute><Layout><SettingsPage /></Layout></PrivateRoute>} />
      <Route path="/new-transaction" element={<PrivateRoute><Layout><NewTransactionPage /></Layout></PrivateRoute>} />
      <Route path="/bulk-import" element={<PrivateRoute><Layout><BulkImportPage /></Layout></PrivateRoute>} />
      <Route path="/transactions" element={<PrivateRoute><Layout><TransactionsPage /></Layout></PrivateRoute>} />
      <Route path="/transactions/:id" element={<PrivateRoute><Layout><TransactionDetailPage /></Layout></PrivateRoute>} />
      <Route path="/alerts" element={<PrivateRoute><Layout><AlertsPage /></Layout></PrivateRoute>} />
      <Route path="/disputes" element={<PrivateRoute><Layout><DisputesPage /></Layout></PrivateRoute>} />
      <Route path="/analytics" element={<PrivateRoute><Layout><AnalyticsPage /></Layout></PrivateRoute>} />
      <Route path="/live-feed" element={<PrivateRoute><Layout><LiveFeedPage /></Layout></PrivateRoute>} />
      <Route path="/customer-profiles" element={<PrivateRoute adminOnly><Layout><CustomerProfilesPage /></Layout></PrivateRoute>} />
      <Route path="/feedback" element={<PrivateRoute adminOnly><Layout><FeedbackPage /></Layout></PrivateRoute>} />
      <Route path="/verification" element={<PrivateRoute adminOnly><Layout><VerificationPage /></Layout></PrivateRoute>} />
      <Route path="/rule-lab" element={<PrivateRoute adminOnly><Layout><RuleLabPage /></Layout></PrivateRoute>} />
      <Route path="/cases" element={<PrivateRoute adminOnly><Layout><CasesPage /></Layout></PrivateRoute>} />
      <Route path="/cases/:id" element={<PrivateRoute adminOnly><Layout><CaseDetailPage /></Layout></PrivateRoute>} />
      <Route path="/relationships" element={<PrivateRoute adminOnly><Layout><RelationshipsPage /></Layout></PrivateRoute>} />
      <Route path="/fraud-intelligence" element={<PrivateRoute adminOnly><Layout><CogneeMemoryPage /></Layout></PrivateRoute>} />
      <Route path="/model-performance" element={<PrivateRoute adminOnly><Layout><ModelPerformancePage /></Layout></PrivateRoute>} />
      <Route path="/admin" element={<PrivateRoute adminOnly><Layout><AdminPage /></Layout></PrivateRoute>} />
      <Route path="*" element={<Navigate to="/dashboard" replace />} />
    </Routes>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <SocketProvider>
          <AppRoutes />
        </SocketProvider>
      </AuthProvider>
    </BrowserRouter>
  );
}
