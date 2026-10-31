/**
 * Persistent real-time event log
 * ==================================
 * Every event pushed over Socket.IO is first written here and carries the
 * row's autoincrement id. That id is the replay cursor: a client that was
 * offline asks for "everything after id N" and gets exactly what it missed,
 * in order, paginated.
 *
 * Ordering guarantee. Ids must become visible in id order or a client that
 * has seen id 12 could never learn about a slower id 11. SQLite has one
 * writer, so ids commit in order. On Postgres, `append` first takes a
 * transaction-scoped advisory lock so concurrent appenders commit in the
 * order they were numbered. Appends are the last step of a business
 * transaction (outbox pattern), so the lock is held only briefly — and an
 * event exists if and only if the business change it describes committed.
 *
 * Authorisation lives HERE, in the query, not in the socket layer: a user
 * can only read events whose user_id is theirs; admins read every live
 * event. Synthetic ('simulation') events are never returned unless the
 * caller explicitly asks for them, and are always labelled source='simulation'.
 */

const db = require('../config/database');

const PG_ORDER_LOCK_KEY = 727001;
const MAX_PAGE = 500;
const DEFAULT_PAGE = 100;
const RISK_RANK = { low: 0, medium: 1, high: 2 };

function parse(row) {
  const payload = JSON.parse(row.payload);
  return {
    id: Number(row.id),
    type: row.event_type,
    source: row.source,
    user_id: row.user_id,
    risk_level: row.risk_level,
    created_at: row.created_at,
    ...payload,
  };
}

/** Appends events atomically and returns them with their ids. */
async function append(events) {
  const list = Array.isArray(events) ? events : [events];
  return db.transaction(async () => {
    if (db.dialect === 'postgres') await db.get('SELECT pg_advisory_xact_lock(?)', [PG_ORDER_LOCK_KEY]);
    const out = [];
    for (const e of list) {
      const { lastInsertRowid } = await db.insert(
        'INSERT INTO realtime_events (event_type, source, user_id, risk_level, payload) VALUES (?, ?, ?, ?, ?)',
        [e.type, e.source || 'live', e.userId ?? null, e.riskLevel ?? null, JSON.stringify(e.payload || {})]
      );
      const row = await db.get('SELECT * FROM realtime_events WHERE id = ?', [lastInsertRowid]);
      out.push(parse(row));
    }
    return out;
  });
}

/**
 * Events after `afterId` visible to `viewer` ({ id, role }).
 * Returns { events, next_cursor, has_more, head, oldest_available, gap }.
 *   gap=true  → events between the caller's cursor and the oldest retained
 *               one were pruned; the client should reload state instead of
 *               trusting the replay to be complete.
 */
async function listFor(viewer, { afterId = 0, limit = DEFAULT_PAGE, types, minRisk, includeSimulation = false } = {}) {
  const pageSize = Math.min(Math.max(Number(limit) || DEFAULT_PAGE, 1), MAX_PAGE);
  const where = ['id > ?'];
  const params = [afterId];

  const visibility = [];
  if (viewer.role === 'admin') visibility.push("source = 'live'");
  else { visibility.push("(source = 'live' AND user_id = ?)"); params.push(viewer.id); }
  if (includeSimulation) visibility.push("source = 'simulation'");
  where.push(`(${visibility.join(' OR ')})`);

  if (!includeSimulation) where.push("source = 'live'");
  if (types && types.length) {
    where.push(`event_type IN (${types.map(() => '?').join(', ')})`);
    params.push(...types);
  }
  if (minRisk && RISK_RANK[minRisk] > 0) {
    // events with no risk (e.g. status messages) are not filtered out
    const allowed = Object.keys(RISK_RANK).filter((r) => RISK_RANK[r] >= RISK_RANK[minRisk]);
    where.push(`(risk_level IS NULL OR risk_level IN (${allowed.map(() => '?').join(', ')}))`);
    params.push(...allowed);
  }

  const rows = await db.all(`SELECT * FROM realtime_events WHERE ${where.join(' AND ')} ORDER BY id ASC LIMIT ?`, [...params, pageSize + 1]);
  const hasMore = rows.length > pageSize;
  const page = rows.slice(0, pageSize).map(parse);
  const { head, oldest } = await bounds();
  // When the page is the last one, advance the cursor to the log head so
  // a client doesn't rescan events it can't see (other users' events).
  const nextCursor = hasMore ? page[page.length - 1].id : Math.max(head, afterId);
  return {
    events: page,
    next_cursor: nextCursor,
    has_more: hasMore,
    head,
    oldest_available: oldest,
    gap: oldest !== null && afterId > 0 && afterId < oldest - 1,
  };
}

async function bounds() {
  const row = await db.get('SELECT MAX(id) AS head, MIN(id) AS oldest FROM realtime_events');
  return { head: row?.head == null ? 0 : Number(row.head), oldest: row?.oldest == null ? null : Number(row.oldest) };
}

/** Retention: drop events older than `maxAgeHours`. Returns rows removed. */
async function prune({ maxAgeHours = 72 } = {}) {
  const cutoff = new Date(Date.now() - maxAgeHours * 3600 * 1000).toISOString();
  const { changes } = await db.run(
    db.dialect === 'postgres'
      ? 'DELETE FROM realtime_events WHERE created_at < ?::timestamptz'
      : 'DELETE FROM realtime_events WHERE datetime(created_at) < datetime(?)',
    [cutoff]
  );
  return changes;
}

module.exports = { append, listFor, bounds, prune, MAX_PAGE, DEFAULT_PAGE, RISK_RANK };
