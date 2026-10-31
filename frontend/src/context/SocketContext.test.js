import React from 'react';
import { render, act, waitFor } from '@testing-library/react';
import { EventEmitter } from 'events';
import { SocketProvider, useSocket } from './SocketContext';

const mockApiGet = jest.fn();
let mockSocket;
jest.mock('socket.io-client', () => ({ io: () => mockSocket }));
const mockUser = { id: 1 };
jest.mock('./AuthContext', () => ({ useAuth: () => ({ user: mockUser }), api: { get: (...a) => mockApiGet(...a) } }));


function makeSocket() {
  const em = new EventEmitter();
  const any = [];
  const s = {
    on: (t, h) => { em.on(t, h); return s; }, off: (t, h) => em.off(t, h),
    listeners: (t) => em.listeners(t), onAny: (h) => any.push(h),
    connect: jest.fn(), disconnect: jest.fn(),
    fire: (t, p) => { any.forEach((h) => h(t, p)); em.emit(t, p); },
  };
  return s;
}

function Probe({ onSocket }) { const { socket } = useSocket(); React.useEffect(() => { if (socket) onSocket(socket); }, [socket, onSocket]); return null; }

beforeEach(() => { jest.clearAllMocks(); localStorage.setItem('fg_access_token', 't'); mockSocket = makeSocket(); });

async function boot() {
  const received = [];
  render(<SocketProvider><Probe onSocket={() => {}} /></SocketProvider>);
  await waitFor(() => expect(mockSocket).toBeTruthy());
  mockSocket.on('alert:new', (e) => received.push(e.id));
  return { received, sock: mockSocket };
}

test('events missed while disconnected are fetched by cursor and delivered once, in order', async () => {
  const { received, sock } = await boot();
  act(() => { sock.fire('sync:hello', { head: 10 }); });                  // first contact: cursor = head
  act(() => { sock.fire('alert:new', { id: 11, type: 'alert:new' }); });  // live
  mockApiGet.mockResolvedValueOnce({ data: { events: [{ id: 11, type: 'alert:new' }, { id: 12, type: 'alert:new' }, { id: 13, type: 'alert:new' }], next_cursor: 13, has_more: false, gap: false } });
  act(() => { sock.fire('events:head', { head: 13 }); });                  // heartbeat says we are behind
  await waitFor(() => expect(received).toEqual([11, 12, 13]));              // 11 not duplicated
  expect(mockApiGet).toHaveBeenCalledWith('/events', { params: { after: 11, limit: 200 } });
});

test('replay pages until has_more is false and does nothing when up to date', async () => {
  const { received, sock } = await boot();
  act(() => { sock.fire('sync:hello', { head: 0 }); });
  mockApiGet
    .mockResolvedValueOnce({ data: { events: [{ id: 1, type: 'alert:new' }, { id: 2, type: 'alert:new' }], next_cursor: 2, has_more: true, gap: false } })
    .mockResolvedValueOnce({ data: { events: [{ id: 3, type: 'alert:new' }], next_cursor: 3, has_more: false, gap: false } });
  act(() => { sock.fire('events:head', { head: 3 }); });
  await waitFor(() => expect(received).toEqual([1, 2, 3]));
  expect(mockApiGet).toHaveBeenCalledTimes(2);
  act(() => { sock.fire('events:head', { head: 3 }); });
  expect(mockApiGet).toHaveBeenCalledTimes(2);
});

test('simulation events carry no id and never move the cursor', async () => {
  const { sock } = await boot();
  act(() => { sock.fire('sync:hello', { head: 5 }); });
  act(() => { sock.fire('simulation:transaction', { id: null, source: 'simulation', synthetic: true }); });
  act(() => { sock.fire('events:head', { head: 5 }); });
  expect(mockApiGet).not.toHaveBeenCalled();
});

test('a server-initiated disconnect (slow consumer) is reconnected', async () => {
  jest.useFakeTimers();
  const { sock } = await boot();
  act(() => { sock.fire('disconnect', 'io server disconnect'); });
  act(() => { jest.advanceTimersByTime(1100); });
  expect(sock.connect).toHaveBeenCalled();
  jest.useRealTimers();
});
