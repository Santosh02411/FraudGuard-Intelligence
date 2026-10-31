const db = require('../config/database');

function parseRow(row) {
  if (!row) return row;
  return { ...row, events: JSON.parse(row.events || '[]'), active: Boolean(row.active) };
}

async function create({ userId, url, secret, events }) {
  return db.insert(
    'INSERT INTO webhooks (user_id, url, secret, events) VALUES (?, ?, ?, ?)',
    [userId, url, secret, JSON.stringify(events)]
  );
}

async function findById(id) {
  return parseRow(await db.get('SELECT * FROM webhooks WHERE id = ?', [id]));
}

async function forUser(userId) {
  const rows = await db.all('SELECT * FROM webhooks WHERE user_id = ? ORDER BY created_at DESC', [userId]);
  return rows.map(parseRow);
}

async function allWithUsername() {
  const rows = await db.all(`
    SELECT w.*, u.username FROM webhooks w
    JOIN users u ON w.user_id = u.id
    ORDER BY w.created_at DESC
  `);
  return rows.map(parseRow);
}

async function update(id, { url, events, active }) {
  const sets = [];
  const params = [];
  if (url !== undefined) { sets.push('url = ?'); params.push(url); }
  if (events !== undefined) { sets.push('events = ?'); params.push(JSON.stringify(events)); }
  if (active !== undefined) { sets.push('active = ?'); params.push(active ? 1 : 0); }
  if (sets.length === 0) return { changes: 0 };
  params.push(id);
  return db.run(`UPDATE webhooks SET ${sets.join(', ')} WHERE id = ?`, params);
}

async function remove(id) {
  return db.run('DELETE FROM webhooks WHERE id = ?', [id]);
}

/** Used by account deletion (routes/auth.js DELETE /me) — deactivates
 * every webhook belonging to a user in one statement. Deactivate, not
 * delete: the delivery history in webhook_deliveries stays intact and
 * attributable, consistent with this app's general "anonymize the
 * account, keep the historical records" approach to deletion. */
async function deactivateAllForUser(userId) {
  return db.run('UPDATE webhooks SET active = 0 WHERE user_id = ?', [userId]);
}

/** Active webhooks for a user subscribed to `event` (or the '*'
 * wildcard) — filtered in JS rather than SQL LIKE-matching the JSON
 * text, since `events` is a small JSON array, not something worth a
 * dedicated join table for at this scale. */
async function forUserAndEvent(userId, event) {
  const rows = await db.all('SELECT * FROM webhooks WHERE user_id = ? AND active = 1', [userId]);
  return rows.map(parseRow).filter((w) => w.events.includes(event) || w.events.includes('*'));
}

async function logDelivery({ webhookId, event, payload, responseStatus, success, attempt, error }) {
  return db.insert(
    'INSERT INTO webhook_deliveries (webhook_id, event, payload, response_status, success, attempt, error) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [webhookId, event, payload, responseStatus, success ? 1 : 0, attempt, error || null]
  );
}

async function deliveriesForWebhook(webhookId, limit = 20) {
  return db.all('SELECT * FROM webhook_deliveries WHERE webhook_id = ? ORDER BY created_at DESC LIMIT ?', [webhookId, limit]);
}

// --- Persistent retry queue (feature: retries that survive a restart —
// see services/webhookRetryWorker.js and config/schema.js's comment on
// webhook_retry_queue for why this exists alongside the immediate
// first-attempt delivery in services/webhookService.js) ---

async function queueRetry({ webhookId, event, payload, attempt, nextRetryAt }) {
  return db.insert(
    'INSERT INTO webhook_retry_queue (webhook_id, event, payload, attempt, next_retry_at) VALUES (?, ?, ?, ?, ?)',
    [webhookId, event, payload, attempt, nextRetryAt]
  );
}

/** Rows whose next_retry_at has already passed — what the sweep worker
 * picks up on each tick. Capped per call so one enormous backlog (e.g.
 * after being down for a while) can't be processed in one unbounded
 * batch; the next tick picks up whatever's left. */
async function dueRetries(limit = 50) {
  return db.all(
    'SELECT * FROM webhook_retry_queue WHERE next_retry_at <= ? ORDER BY next_retry_at ASC LIMIT ?',
    [new Date().toISOString(), limit]
  );
}

async function updateRetryEntry(id, { attempt, nextRetryAt }) {
  return db.run('UPDATE webhook_retry_queue SET attempt = ?, next_retry_at = ? WHERE id = ?', [attempt, nextRetryAt, id]);
}

async function removeRetryEntry(id) {
  return db.run('DELETE FROM webhook_retry_queue WHERE id = ?', [id]);
}

module.exports = {
  create, findById, forUser, allWithUsername, update, remove, deactivateAllForUser,
  forUserAndEvent, logDelivery, deliveriesForWebhook,
  queueRetry, dueRetries, updateRetryEntry, removeRetryEntry,
};
