/**
 * Real-time layer (Socket.IO)
 * ==============================
 * Push instead of poll — but push alone is not reliable: a laptop that
 * sleeps, a flaky mobile connection or a slow consumer all lose messages.
 * So delivery here is "push + recoverable":
 *
 *   1. PERSISTENT IDS. Every real event is written to `realtime_events`
 *      (models/realtimeEventRepository.js) in the same database
 *      transaction as the change it describes, and is pushed carrying that
 *      row's id.
 *   2. CURSOR REPLAY. A client remembers the highest id it has seen and
 *      calls GET /api/events?after=<id> (paginated) on (re)connect. The
 *      server sends `sync:hello {head}` on connect and `events:head {head}`
 *      as a periodic heartbeat; a client whose cursor is behind the head
 *      replays. A message lost for ANY reason is therefore recovered within
 *      one heartbeat.
 *   3. BACKPRESSURE. A socket whose outgoing buffer exceeds
 *      REALTIME_MAX_SOCKET_BUFFER is disconnected instead of letting server
 *      memory grow without bound; it reconnects and pages through the missed
 *      events by cursor.
 *   4. FILTERING. A client subscribes to topics (transaction, alert,
 *      simulation) and a minimum risk tier (all | medium | high); events are
 *      routed only to matching rooms, so a quiet dashboard doesn't receive a
 *      firehose.
 *   5. MULTI-INSTANCE. With REDIS_URL set the shared Socket.IO Redis adapter
 *      fans room emits out across instances. Without it, rooms are
 *      process-local and only a single backend instance is correct.
 *
 * ROOMS (a socket is in exactly the rooms its subscription asks for)
 *   u:<userId>:<topic>:<tier>  the owner's own events
 *   a:<topic>:<tier>           every user's events — admins only
 *   simulation-feed            synthetic demo events — never real transactions
 * where tier ∈ {all, medium, high}; an event is emitted to every tier at or
 * below its risk, and a socket sits in one tier per topic.
 *
 * AUTHORISATION. Rooms are derived from the authenticated identity at
 * connect, never from client input: a non-admin can only ever join its own
 * `u:<id>:*` rooms. Synthetic events are emitted ONLY to `simulation-feed`,
 * are labelled `source: 'simulation'`, carry no replay id, and are never
 * written to the event log.
 */

const jwt = require('jsonwebtoken');
const config = require('../config/env');
const logger = require('../config/logger');
const userRepository = require('../models/userRepository');
const realtimeEvents = require('../models/realtimeEventRepository');

const TOPICS = ['transaction', 'alert', 'simulation'];
const TIERS = ['all', 'medium', 'high'];
const EVENT_TOPIC = { 'transaction:new': 'transaction', 'alert:new': 'alert', 'alert:updated': 'alert' };
// Case-management events carry no customer: delivered to admin rooms only.
const ADMIN_ONLY = new Set(['alert:updated']);

/** Tiers an event of the given risk is delivered to. */
function tiersFor(risk) {
  if (risk === 'high') return ['all', 'medium', 'high'];
  if (risk === 'medium') return ['all', 'medium'];
  return ['all'];
}

const userRoom = (userId, topic, tier) => `u:${userId}:${topic}:${tier}`;
const adminRoom = (topic, tier) => `a:${topic}:${tier}`;

async function authenticateSocket(socket, next) {
  try {
    const token = socket.handshake.auth?.token;
    if (!token) return next(new Error('No token provided'));

    const decoded = jwt.verify(token, config.jwtSecret);
    // Only the short-lived access JWT is valid here — same reasoning as
    // middleware/auth.js's authMiddleware.
    if (decoded.type !== 'access') return next(new Error('Invalid or expired token'));

    const user = await userRepository.findById(decoded.id);
    if (!user) return next(new Error('User not found'));

    socket.user = user;
    next();
  } catch (err) {
    next(new Error('Invalid or expired token'));
  }
}

/** Normalises a client's subscription request. */
function parseSubscription(input = {}) {
  const topics = Array.isArray(input.topics) ? input.topics.filter((t) => TOPICS.includes(t)) : TOPICS;
  const tier = TIERS.includes(input.min_risk) ? input.min_risk : 'all';
  return { topics: [...new Set(topics)], tier };
}

function applySubscription(socket, input) {
  const { topics, tier } = parseSubscription(input);
  for (const room of [...socket.rooms]) {
    if (room !== socket.id) socket.leave(room);
  }
  const { id, role } = socket.user;
  for (const topic of topics) {
    if (topic === 'simulation') { socket.join('simulation-feed'); continue; }
    socket.join(userRoom(id, topic, tier));
    if (role === 'admin') socket.join(adminRoom(topic, tier));
  }
  socket.data.subscription = { topics, min_risk: tier };
  return socket.data.subscription;
}

/**
 * Builds a realtime server bound to `httpServer`. Returned as an object so
 * tests (and multi-instance setups) can run several in one process.
 */
function createRealtimeServer(httpServer, options = {}) {
  const { Server } = require('socket.io');
  const redisUrl = options.redisUrl !== undefined ? options.redisUrl : config.redisUrl;
  const heartbeatMs = options.heartbeatMs ?? config.realtimeHeartbeatMs;
  const maxBuffer = options.maxSocketBuffer ?? config.realtimeMaxSocketBuffer;

  const io = new Server(httpServer, {
    // Same allow-list as the REST API's CORS config (server.js) — no wildcard.
    cors: { origin: config.corsAllowedOrigins, credentials: true },
  });

  const status = { adapter: 'in-memory', redis_connected: false };
  let redisClients = [];

  const ready = (async () => {
    if (!redisUrl) return;
    try {
      const { createClient } = require('redis');
      const { createAdapter } = require('@socket.io/redis-adapter');
      const pub = createClient({ url: redisUrl });
      const sub = pub.duplicate();
      pub.on('error', (e) => logger.error('Redis (pub) error', { error: e.message }));
      sub.on('error', (e) => logger.error('Redis (sub) error', { error: e.message }));
      await Promise.all([pub.connect(), sub.connect()]);
      io.adapter(createAdapter(pub, sub));
      redisClients = [pub, sub];
      status.adapter = 'redis';
      status.redis_connected = true;
      logger.info('Socket.IO Redis adapter enabled');
    } catch (err) {
      // Loud on purpose: with several instances, in-memory rooms silently drop events.
      logger.error('Socket.IO Redis adapter FAILED — falling back to in-memory rooms (single instance only)', { error: err.message });
    }
  })();

  io.use(authenticateSocket);

  io.on('connection', async (socket) => {
    const { id, username } = socket.user;
    applySubscription(socket, {});

    socket.on('subscribe', (input, ack) => {
      const sub = applySubscription(socket, input);
      if (typeof ack === 'function') ack({ ok: true, subscription: sub });
    });

    try {
      const { head, oldest } = await realtimeEvents.bounds();
      socket.emit('sync:hello', { head, oldest_available: oldest, subscription: socket.data.subscription });
    } catch (err) {
      logger.error('sync:hello failed', { error: err.message });
    }

    logger.info('Socket connected', { userId: id, username, socketId: socket.id });
    socket.on('disconnect', (reason) => {
      logger.info('Socket disconnected', { userId: id, username, socketId: socket.id, reason });
    });
  });

  // Heartbeat + slow-consumer reaper, local sockets only (each instance
  // looks after its own connections).
  const heartbeat = setInterval(async () => {
    try {
      for (const socket of io.sockets.sockets.values()) {
        const buffered = socket.conn?.writeBuffer?.length || 0;
        if (buffered > maxBuffer) {
          logger.warn('Disconnecting slow socket (backpressure)', { socketId: socket.id, buffered });
          socket.emit('events:lagged', { reason: 'slow_consumer' });
          socket.disconnect(true);
        }
      }
      const { head } = await realtimeEvents.bounds();
      io.local.emit('events:head', { head });
    } catch (err) {
      logger.error('Realtime heartbeat failed', { error: err.message });
    }
  }, heartbeatMs);
  heartbeat.unref?.();

  /** Push already-persisted events (ids assigned) to their rooms. */
  function publish(events = []) {
    for (const event of events) {
      const topic = EVENT_TOPIC[event.type];
      const adminOnly = ADMIN_ONLY.has(event.type);
      if (!topic || (event.user_id == null && !adminOnly)) continue; // only real, owned events travel here
      const rooms = [];
      for (const tier of tiersFor(event.risk_level)) {
        if (!adminOnly) rooms.push(userRoom(event.user_id, topic, tier));
        rooms.push(adminRoom(topic, tier));
      }
      io.to(rooms).emit(event.type, event);
    }
  }

  /** Synthetic demo event: public room only, labelled, no replay id, never stored. */
  function publishSimulation(payload) {
    io.to('simulation-feed').emit('simulation:transaction', { ...payload, source: 'simulation', synthetic: true, id: null });
  }

  function publishSimulationStatus(statusPayload) {
    io.to('simulation-feed').emit('simulation:status', statusPayload);
  }

  async function close() {
    clearInterval(heartbeat);
    await new Promise((resolve) => io.close(resolve));
    await Promise.all(redisClients.map((c) => c.quit().catch(() => {})));
  }

  logger.info('Socket.io server initialized');
  return { io, ready, status, publish, publishSimulation, publishSimulationStatus, close };
}

// --- Process-wide default instance (what server.js and the routes use) ---
let current = null;

function initSocketServer(httpServer) {
  current = createRealtimeServer(httpServer);
  return current.io;
}

const getIO = () => current?.io || null;
const getStatus = () => (current ? { ...current.status } : { adapter: 'none', redis_connected: false });
const publish = (events) => current?.publish(events);
const emitSimulationTransaction = (payload) => current?.publishSimulation(payload);
const emitSimulationStatus = (payload) => current?.publishSimulationStatus(payload);

module.exports = {
  createRealtimeServer, initSocketServer, getIO, getStatus, publish,
  emitSimulationTransaction, emitSimulationStatus,
  tiersFor, parseSubscription, TOPICS, TIERS,
};
