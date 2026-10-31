import React, { useEffect, useState } from 'react';
import { NavLink } from 'react-router-dom';
import {
  Shield, LayoutDashboard, Radio, List, Bell, BarChart2, FlaskConical, Upload, Scale, FolderOpen, Network,
  UserSearch, BrainCircuit, ClipboardCheck, ShieldQuestion, LineChart, Settings, UserCog, X,
} from 'lucide-react';
import { api, useAuth } from '../context/AuthContext';
import { useSocket } from '../context/SocketContext';
import { APP_BUILD } from '../version';

/**
 * Grouped navigation (same structure as the interactive demo). `admin: true` items are only shown to
 * administrators, mirroring the backend's role checks and the PrivateRoute adminOnly routes in App.js.
 */
export const NAV_GROUPS = [
  { title: 'Monitor', items: [
    { to: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
    { to: '/live-feed', label: 'Live Feed', icon: Radio },
    { to: '/transactions', label: 'Transactions', icon: List },
    { to: '/alerts', label: 'Alerts', icon: Bell, badge: true },
    { to: '/analytics', label: 'Analytics', icon: BarChart2 },
  ] },
  { title: 'Submit', items: [
    { to: '/new-transaction', label: 'Simulator', icon: FlaskConical },
    { to: '/bulk-import', label: 'Bulk Import', icon: Upload },
  ] },
  { title: 'Investigate', items: [
    { to: '/disputes', label: 'Disputes', icon: Scale },
    { to: '/cases', label: 'Cases', icon: FolderOpen, admin: true },
    { to: '/relationships', label: 'Relationships', icon: Network, admin: true },
    { to: '/customer-profiles', label: 'Profiles', icon: UserSearch, admin: true },
    { to: '/fraud-intelligence', label: 'AI Memory', icon: BrainCircuit, admin: true },
  ] },
  { title: 'Govern', items: [
    { to: '/feedback', label: 'Feedback', icon: ClipboardCheck, admin: true },
    { to: '/verification', label: 'Verification', icon: ShieldQuestion, admin: true },
    { to: '/rule-lab', label: 'Rule Lab', icon: FlaskConical, admin: true },
    { to: '/model-performance', label: 'Model', icon: LineChart, admin: true },
    { to: '/admin', label: 'Admin', icon: Settings, admin: true },
  ] },
  { title: 'Account', items: [{ to: '/settings', label: 'Settings', icon: UserCog }] },
];

/** Number of alerts still needing work, for the Alerts badge. Failures just hide the badge. */
function useOpenAlertCount(isAdmin) {
  const { socket } = useSocket();
  const [count, setCount] = useState(null);
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        if (isAdmin) {
          const { data } = await api.get('/alerts/metrics', { params: { days: 7 } });
          if (!cancelled) setCount(Number(data?.open?.total ?? 0));
        } else {
          const { data } = await api.get('/alerts', { params: { status: 'open', limit: 1 } });
          if (!cancelled) setCount(Number(data?.pagination?.total ?? 0));
        }
      } catch { if (!cancelled) setCount(null); }
    };
    load();
    const timer = setInterval(load, 60000);
    const onNew = () => load();
    socket?.on('alert:new', onNew);
    return () => { cancelled = true; clearInterval(timer); socket?.off('alert:new', onNew); };
  }, [isAdmin, socket]);
  return count;
}

const linkClass = ({ isActive }) =>
  `flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-[13px] font-medium transition-colors ${
    isActive ? 'bg-cyan-500/10 text-cyan-300' : 'text-gray-400 hover:text-gray-200 hover:bg-white/5'
  }`;

export default function Sidebar({ open = false, onClose = () => {} }) {
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
  const alertCount = useOpenAlertCount(isAdmin);

  return (
    <>
      {open && <div className="fixed inset-0 z-40 bg-black/60 lg:hidden" onClick={onClose} aria-hidden="true" data-testid="sidebar-overlay" />}
      <aside
        data-testid="sidebar"
        className={`fixed inset-y-0 left-0 z-50 w-[226px] bg-[#0a0f14] border-r border-white/10 overflow-y-auto px-2.5 py-3.5 flex flex-col gap-0.5
          transition-transform lg:sticky lg:top-0 lg:h-screen lg:translate-x-0 lg:shrink-0 ${open ? 'translate-x-0' : '-translate-x-full'}`}
      >
        <div className="flex items-center gap-2.5 px-2 pt-1 pb-3.5">
          <span className="flex items-center justify-center w-[30px] h-[30px] rounded-lg bg-cyan-500/10 border border-cyan-500/25">
            <Shield size={16} className="text-cyan-400" />
          </span>
          <span className="text-white font-semibold text-[15px] tracking-tight">FraudGuard</span>
          <button onClick={onClose} className="ml-auto lg:hidden text-gray-400 hover:text-white p-1" aria-label="Close menu"><X size={18} /></button>
        </div>
        <nav aria-label="Main navigation" className="flex flex-col gap-0.5">
        {NAV_GROUPS.map((group) => {
          const items = group.items.filter((i) => !i.admin || isAdmin);
          if (!items.length) return null;
          return (
            <div key={group.title} className="mb-1">
              <div className="text-[10px] uppercase tracking-[0.1em] text-gray-500 px-2.5 pt-3 pb-1">{group.title}</div>
              {items.map(({ to, label, icon: Icon, badge }) => (
                <NavLink key={to} to={to} className={linkClass} onClick={onClose}>
                  <Icon size={15} className="shrink-0" />
                  <span>{label}</span>
                  {badge && alertCount > 0 && (
                    <span className="ml-auto text-[10px] px-1.5 py-px rounded-full bg-red-500/20 text-red-400" aria-label={`${alertCount} open alerts`}>{alertCount > 99 ? '99+' : alertCount}</span>
                  )}
                </NavLink>
              ))}
            </div>
          );
        })}
        </nav>
        <div className="mt-auto pt-4 px-2.5 text-[10px] text-gray-600" data-testid="sidebar-build">FraudGuard build {APP_BUILD}</div>
      </aside>
    </>
  );
}
