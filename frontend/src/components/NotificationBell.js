import React, { useState, useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { api, useAuth } from '../context/AuthContext';
import { useSocket } from '../context/SocketContext';
import { Bell, AlertTriangle } from 'lucide-react';

const MAX_SHOWN = 8;

function lastSeenKey(userId) {
  return `fg_alerts_last_seen_${userId || 'anon'}`;
}

/**
 * In-app notification bell (feature: notification center). Reuses data
 * the app already has — GET /alerts for the initial list, the same
 * `alert:new` socket event AlertsPage/LiveFeedPage already listen for
 * live updates — rather than a new backend concept. "Seen" is tracked
 * client-side (per-account, in localStorage) since it's a per-browser
 * UI convenience, not something worth a server round-trip or a new DB
 * column: opening the dropdown marks the current alerts as seen, so
 * the badge only ever counts what arrived since the last time you
 * actually looked.
 */
export default function NotificationBell() {
  const { user } = useAuth();
  const { socket } = useSocket();
  const [alerts, setAlerts] = useState([]);
  const [open, setOpen] = useState(false);
  const [lastSeenAt, setLastSeenAt] = useState(
    () => localStorage.getItem(lastSeenKey(user?.id)) || new Date(0).toISOString()
  );
  const containerRef = useRef(null);

  useEffect(() => {
    api.get('/alerts', { params: { page: 1, limit: MAX_SHOWN } })
      .then(({ data }) => setAlerts(data.alerts))
      .catch(() => {}); // non-critical — the bell just stays empty
  }, []);

  useEffect(() => {
    if (!socket) return undefined;
    const onAlert = ({ alert }) => setAlerts(prev => [alert, ...prev.filter(a => a.id !== alert.id)].slice(0, MAX_SHOWN));
    socket.on('alert:new', onAlert);
    return () => socket.off('alert:new', onAlert);
  }, [socket]);

  useEffect(() => {
    function onClickOutside(e) {
      if (containerRef.current && !containerRef.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, []);

  const unseenCount = alerts.filter(a => new Date(a.created_at) > new Date(lastSeenAt)).length;

  const toggleOpen = () => {
    setOpen((wasOpen) => {
      if (!wasOpen) {
        const now = new Date().toISOString();
        localStorage.setItem(lastSeenKey(user?.id), now);
        setLastSeenAt(now);
      }
      return !wasOpen;
    });
  };

  return (
    <div className="relative" ref={containerRef}>
      <button
        onClick={toggleOpen}
        title="Notifications"
        className="relative p-2 rounded-lg text-gray-300 hover:text-white hover:bg-white/10 transition-colors"
      >
        <Bell size={18} />
        {unseenCount > 0 && (
          <span className="absolute -top-0.5 -right-0.5 bg-red-500 text-white text-[10px] font-bold rounded-full min-w-[16px] h-4 px-1 flex items-center justify-center leading-none">
            {unseenCount > 9 ? '9+' : unseenCount}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 mt-2 w-80 bg-[#111820] border border-white/10 rounded-xl shadow-xl z-50 max-h-96 overflow-y-auto animate-menu-in">
          <div className="px-4 py-3 border-b border-white/10 flex items-center justify-between">
            <p className="text-white text-sm font-semibold">Notifications</p>
            <Link to="/alerts" onClick={() => setOpen(false)} className="text-purple-400 hover:text-purple-300 text-xs transition-colors">
              View all
            </Link>
          </div>
          {alerts.length === 0 ? (
            <p className="px-4 py-6 text-center text-gray-500 text-sm">No alerts yet</p>
          ) : (
            <div className="divide-y divide-white/5">
              {alerts.map(a => (
                <Link
                  key={a.id}
                  to="/alerts"
                  onClick={() => setOpen(false)}
                  className="block px-4 py-3 hover:bg-white/5 transition-colors hover-lift"
                >
                  <div className="flex items-start gap-2">
                    <AlertTriangle size={14} className={`mt-0.5 shrink-0 ${a.risk_level === 'high' ? 'text-red-400' : 'text-yellow-400'}`} />
                    <div className="min-w-0">
                      <p className="text-gray-200 text-xs">{a.message}</p>
                      <p className="text-gray-500 text-[11px] mt-0.5">{new Date(a.created_at).toLocaleString()}</p>
                    </div>
                  </div>
                </Link>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
