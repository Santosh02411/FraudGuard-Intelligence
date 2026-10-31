import React, { createContext, useContext, useEffect, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import { useAuth, api } from './AuthContext';

const SocketContext = createContext(null);

// Socket.io connects to the backend's origin, not the REST /api/v1 path —
// derive it from REACT_APP_SOCKET_URL if set, otherwise strip a trailing
// /api or /api/v1 off REACT_APP_API_URL, otherwise fall back to the same
// localhost:5000 dev default AuthContext.js uses.
function resolveSocketUrl() {
  if (process.env.REACT_APP_SOCKET_URL) return process.env.REACT_APP_SOCKET_URL;
  const apiUrl = process.env.REACT_APP_API_URL || 'http://localhost:5000/api/v1';
  return apiUrl.replace(/\/api(\/v1)?\/?$/, '');
}

const SOCKET_URL = resolveSocketUrl();

/**
 * One socket connection per logged-in session, shared via context.
 * Connects/reconnects when `user` changes, disconnects on logout —
 * this is the "push" side of real-time alerts: components subscribe to
 * events (transaction:new, alert:new, simulation:*) instead of polling
 * a REST endpoint on a timer.
 */
const REPLAY_PAGE = 200;
const SEEN_MAX = 2000;

/**
 * One socket connection per logged-in session, shared via context.
 *
 * Push is not reliable on its own (sleeping laptops, flaky networks, a
 * server that drops a slow consumer), so this provider adds RECOVERY:
 *  - every real event carries a persistent id; the highest id seen is the cursor;
 *  - on (re)connect and on the server's `events:head` heartbeat, if the cursor
 *    is behind the head, missed events are fetched with GET /events?after=<cursor>
 *    (paged) and handed to the same handlers as live events, oldest first;
 *  - ids already delivered live are skipped, so nothing is shown twice;
 *  - if the server says part of the log was pruned (`gap`), `resyncToken`
 *    changes so pages reload their data instead of trusting a partial replay.
 * Simulation events have no id and are never part of replay.
 */
export function SocketProvider({ children }) {
  const { user } = useAuth();
  const [connected, setConnected] = useState(false);
  const [resyncToken, setResyncToken] = useState(0);
  const [recovering, setRecovering] = useState(false);
  const socketRef = useRef(null);

  useEffect(() => {
    if (!user) {
      socketRef.current?.disconnect();
      socketRef.current = null;
      setConnected(false);
      return undefined;
    }

    const token = localStorage.getItem('fg_access_token');
    if (!token) return undefined;

    const socket = io(SOCKET_URL, { auth: { token }, reconnectionDelay: 1000, reconnectionDelayMax: 5000 });
    socketRef.current = socket;

    let cursor = null;            // highest event id delivered; null until the first hello
    let replaying = false;
    let again = false;            // a head update arrived during a replay
    let latestHead = 0;
    const seen = new Set();
    let disposed = false;

    const remember = (id) => {
      seen.add(id);
      if (seen.size > SEEN_MAX) seen.delete(seen.values().next().value);
      if (cursor === null || id > cursor) cursor = id;
    };

    // Registered before any page handler, so ids are recorded before pages see the event.
    socket.onAny((type, payload) => {
      if (payload && typeof payload === 'object' && Number.isInteger(payload.id) && payload.source !== 'simulation') remember(payload.id);
    });

    const dispatch = (event) => socket.listeners(event.type).forEach((h) => h(event));

    async function replay() {
      if (replaying) { again = true; return; }
      replaying = true;
      setRecovering(true);
      try {
        do {
          again = false;
          let more = true;
          while (more && !disposed) {
            const { data } = await api.get('/events', { params: { after: cursor, limit: REPLAY_PAGE } });
            if (data.gap) setResyncToken((n) => n + 1);
            data.events.forEach((event) => {
              if (seen.has(event.id)) return;
              remember(event.id);
              dispatch(event);
            });
            if (data.next_cursor > cursor) cursor = data.next_cursor;
            more = data.has_more;
          }
        } while (again && !disposed);
      } catch (err) {
        // Leave the cursor where it is: the next heartbeat retries.
      } finally {
        replaying = false;
        if (!disposed) setRecovering(false);
      }
    }

    const onHead = ({ head }) => {
      latestHead = head;
      if (cursor === null) { cursor = head; return; }      // first contact: pages load their own initial state
      if (head > cursor) replay();
    };

    socket.on('connect', () => setConnected(true));
    socket.on('sync:hello', onHead);
    socket.on('events:head', onHead);
    socket.on('disconnect', (reason) => {
      setConnected(false);
      // A server-initiated disconnect (slow consumer) is not retried by socket.io itself.
      if (reason === 'io server disconnect') setTimeout(() => { if (!disposed) socket.connect(); }, 1000);
    });
    socket.on('connect_error', () => setConnected(false));

    return () => {
      disposed = true;
      void latestHead;
      socket.disconnect();
      socketRef.current = null;
    };
  }, [user]);

  return (
    <SocketContext.Provider value={{ socket: socketRef.current, connected, resyncToken, recovering }}>
      {children}
    </SocketContext.Provider>
  );
}

export function useSocket() {
  return useContext(SocketContext);
}
