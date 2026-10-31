import React, { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { LogOut, Menu, User } from "lucide-react";
import { api, useAuth } from "../context/AuthContext";
import Sidebar from "./Sidebar";
import NotificationBell from "./NotificationBell";
import ErrorBoundary from "./ErrorBoundary";

/** 'ok' | 'down' | 'unknown' - polled gently; a failed check just shows "unknown", it never breaks the page. */
export function useMlStatus() {
  const [status, setStatus] = useState("unknown");
  useEffect(() => {
    let cancelled = false;
    const load = () =>
      Promise.resolve()
        .then(() => api.get("/system/status"))
        .then(({ data }) => {
          if (!cancelled) setStatus(data?.ml?.status === "ok" ? "ok" : "down");
        })
        .catch(() => {
          if (!cancelled) setStatus("unknown");
        });
    load();
    const timer = setInterval(load, 31000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);
  return status;
}

/** Sidebar + top bar + page area. Replaces the old single-row navbar, which clipped once an admin had ~17 links. */
export default function AppLayout({ children }) {
  const { user, logout } = useAuth();
  const ml = useMlStatus();
  const navigate = useNavigate();
  const location = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);

  const handleLogout = () => {
    logout();
    navigate("/login");
  };

  return (
    <div className="min-h-screen bg-[#0a0f14] lg:flex">
      <Sidebar open={menuOpen} onClose={() => setMenuOpen(false)} />
      <div className="flex-1 min-w-0 flex flex-col">
        <header className="sticky top-0 z-30 bg-[#0a0f14]/90 backdrop-blur border-b border-white/10 px-4 sm:px-6 py-2.5 flex items-center gap-3">
          <button
            onClick={() => setMenuOpen(true)}
            className="lg:hidden text-gray-300 hover:text-white p-1.5 -ml-1.5"
            aria-label="Open menu"
          >
            <Menu size={20} />
          </button>
          <span className="inline-flex items-center gap-1.5 text-xs text-gray-300 border border-white/10 bg-white/[0.03] rounded-full px-3 py-1.5">
            <User size={13} />
            <span data-testid="topbar-user">{user?.username}</span>
          </span>
          <span
            className="text-xs text-gray-300 border border-white/10 bg-[#0a0f14] rounded-lg px-2.5 py-1.5"
            data-testid="topbar-role"
          >
            role: {user?.role === "admin" ? "admin" : "analyst"}
          </span>
          <span className="flex-1" />
          <span
            data-testid="ml-status"
            title={
              ml === "ok"
                ? "The ML scoring service is answering"
                : ml === "down"
                  ? "The ML service is not answering: the rule engine is scoring instead"
                  : "ML service status unknown"
            }
            className={`hidden sm:inline-flex items-center gap-2 text-xs px-3 py-1.5 rounded-full border ${ml === "ok" ? "text-green-400 border-green-500/25 bg-green-500/5" : ml === "down" ? "text-red-300 border-red-500/25 bg-red-500/5" : "text-gray-400 border-white/10 bg-white/5"}`}
          >
            <span
              className={`w-2 h-2 rounded-full ${ml === "ok" ? "bg-green-400" : ml === "down" ? "bg-red-400" : "bg-gray-500"}`}
            />
            ML service {ml === "ok" ? "ok" : ml === "down" ? "down" : "—"}
          </span>
          <NotificationBell />
          <button
            onClick={handleLogout}
            className="inline-flex items-center gap-2 border border-white/10 hover:bg-white/5 text-gray-200 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors"
          >
            <LogOut size={15} />
            <span className="hidden sm:inline">Sign out</span>
          </button>
        </header>
        {/* resetKey: a crash on one page recovers automatically once the user navigates away. The same pathname
            keys the fade-in so it replays on every navigation rather than only on first mount. */}
        <main className="flex-1">
          <div key={location.pathname} className="animate-page-in">
            <ErrorBoundary resetKey={location.pathname}>
              {children}
            </ErrorBoundary>
          </div>
        </main>
      </div>
    </div>
  );
}
