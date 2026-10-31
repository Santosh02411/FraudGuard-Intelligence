/**
 * Investigations: cases that group related alerts/transactions.
 *
 * Invariants (enforced in SQL / one DB transaction, not by caller discipline):
 *  - an alert or transaction belongs to at most one investigation (unique index);
 *  - adding an alert also links its transaction (and vice versa: a transaction that has
 *    an alert brings the alert), so the two views never disagree;
 *  - every mutation writes its timeline event in the SAME database transaction;
 *  - status changes and edits are optimistic-locked by `version`;
 *  - the timeline is append-only.
 */
const db = require('../config/database');

const STATUSES = ['open', 'investigating', 'pending_info', 'closed'];
const PRIORITIES = ['low', 'medium', 'high', 'critical'];
const OUTCOMES = ['confirmed_fraud', 'legitimate', 'inconclusive'];
const TRANSITIONS = {
  open: ['investigating', 'pending_info', 'closed'],
  investigating: ['open', 'pending_info', 'closed'],
  pending_info: ['open', 'investigating', 'closed'],
  closed: ['open'], // reopening needs a reason (route enforces)
};
const SEV_RANK = { low: 0, medium: 1, high: 2, critical: 3 };

const now = () => new Date().toISOString();
/** SQLite returns 'YYYY-MM-DD HH:MM:SS' (UTC) for CURRENT_TIMESTAMP defaults, Postgres returns Date objects. */
function toIso(v) {
  if (v instanceof Date) return v.toISOString();
  const s = String(v);
  return new Date(s.includes('T') ? s : `${s.replace(' ', 'T')}Z`).toISOString();
}

class ConflictError extends Error {
  constructor(code, message, extra = {}) { super(message); this.code = code; this.extra = extra; }
}

async function addEvent(investigationId, kind, actor, summary, details) {
  await db.run(
    'INSERT INTO investigation_events (investigation_id, kind, actor_id, actor_username, summary, details, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [investigationId, kind, actor?.id ?? null, actor?.username ?? 'system', summary, details ? JSON.stringify(details) : null, now()]
  );
}

async function touch(id, expectedVersion) {
  const versioned = expectedVersion !== undefined && expectedVersion !== null;
  const r = await db.run(
    `UPDATE investigations SET updated_at = ?, version = version + 1 WHERE id = ? ${versioned ? 'AND version = ?' : ''}`,
    versioned ? [now(), id, expectedVersion] : [now(), id]
  );
  if (versioned && r.changes === 0) throw new ConflictError('VERSION_CONFLICT', 'This case was changed by someone else since you opened it.');
}

/** Resolve a mixed list of alert ids / transaction ids into a normalised, de-duplicated item set. */
async function resolveItems({ alertIds = [], transactionIds = [] }) {
  const alerts = [];
  const txns = new Map(); // id -> row
  for (const id of new Set(alertIds)) {
    const a = await db.get('SELECT a.id, a.transaction_id, a.severity FROM alerts a WHERE a.id = ?', [id]);
    if (!a) throw new ConflictError('NOT_FOUND', `Alert ${id} not found`);
    alerts.push(a);
  }
  const txnIds = new Set([...transactionIds, ...alerts.map((a) => a.transaction_id)]);
  for (const id of txnIds) {
    const t = await db.get('SELECT id, user_id, amount FROM transactions WHERE id = ?', [id]);
    if (!t) throw new ConflictError('NOT_FOUND', `Transaction ${id} not found`);
    txns.set(id, t);
    // a transaction that has an alert always brings its alert along
    const a = await db.get('SELECT id, transaction_id, severity FROM alerts WHERE transaction_id = ?', [id]);
    if (a && !alerts.some((x) => x.id === a.id)) alerts.push(a);
  }
  return { alerts, txns: [...txns.values()] };
}

async function insertItems(investigationId, { alerts, txns }, actor) {
  for (const a of alerts) await linkOne(investigationId, 'alert', a.id, actor);
  for (const t of txns) await linkOne(investigationId, 'transaction', t.id, actor);
}

async function linkOne(investigationId, type, itemId, actor) {
  const existing = await db.get('SELECT investigation_id FROM investigation_items WHERE item_type = ? AND item_id = ?', [type, itemId]);
  if (existing) {
    if (existing.investigation_id === Number(investigationId)) return false; // already here: idempotent
    throw new ConflictError('ITEM_IN_OTHER_CASE', `${type} ${itemId} already belongs to case #${existing.investigation_id}`, { caseId: existing.investigation_id, type, itemId });
  }
  // ON CONFLICT DO NOTHING (not a caught error): in PostgreSQL a failed statement aborts the whole
  // transaction, so a race on the unique index must be a normal outcome, not an exception.
  const r = await db.run('INSERT INTO investigation_items (investigation_id, item_type, item_id, added_by, added_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (item_type, item_id) DO NOTHING', [investigationId, type, itemId, actor?.id ?? null, now()]);
  if (r.changes === 0) {
    const winner = await db.get('SELECT investigation_id FROM investigation_items WHERE item_type = ? AND item_id = ?', [type, itemId]);
    throw new ConflictError('ITEM_IN_OTHER_CASE', `${type} ${itemId} already belongs to case #${winner ? winner.investigation_id : '?'}`, { caseId: winner?.investigation_id, type, itemId });
  }
  return true;
}

async function create({ title, summary, priority, assignedTo, alertIds, transactionIds }, actor) {
  return db.transaction(async () => {
    const items = await resolveItems({ alertIds, transactionIds });
    if (items.alerts.length + items.txns.length === 0) throw new ConflictError('EMPTY_CASE', 'A case needs at least one alert or transaction');
    const derived = items.alerts.reduce((best, a) => (SEV_RANK[a.severity] > SEV_RANK[best] ? a.severity : best), 'low');
    const prio = priority || (items.alerts.length ? derived : 'medium');
    const t = now();
    const { lastInsertRowid: id } = await db.insert(
      `INSERT INTO investigations (title, summary, status, priority, assigned_to, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [title, summary || null, assignedTo ? 'investigating' : 'open', prio, assignedTo || null, actor.id, t, t]);
    await insertItems(id, items, actor);
    await addEvent(id, 'created', actor, `Case created with ${items.alerts.length} alert(s) and ${items.txns.length} transaction(s)`, { alerts: items.alerts.map((a) => a.id), transactions: items.txns.map((x) => x.id) });
    if (assignedTo) await addEvent(id, 'assigned', actor, `Assigned to user #${assignedTo}`, { assigned_to: assignedTo });
    return Number(id);
  });
}

async function addItems(id, { alertIds, transactionIds }, actor, expectedVersion) {
  return db.transaction(async () => {
    const items = await resolveItems({ alertIds, transactionIds });
    let added = 0;
    for (const a of items.alerts) if (await linkOne(id, 'alert', a.id, actor)) added += 1;
    for (const t of items.txns) if (await linkOne(id, 'transaction', t.id, actor)) added += 1;
    if (added) {
      await touch(id, expectedVersion);
      await addEvent(id, 'items_added', actor, `Added ${added} item(s)`, { alerts: items.alerts.map((a) => a.id), transactions: items.txns.map((x) => x.id) });
    }
    return added;
  });
}

async function removeItem(id, type, itemId, actor, expectedVersion) {
  return db.transaction(async () => {
    const item = await db.get('SELECT id FROM investigation_items WHERE investigation_id = ? AND item_type = ? AND item_id = ?', [id, type, itemId]);
    if (!item) return false;
    // keep alert/transaction pairs together: removing a transaction that still has its alert linked is refused
    if (type === 'transaction') {
      const a = await db.get('SELECT a.id FROM alerts a JOIN investigation_items i ON i.item_type = \'alert\' AND i.item_id = a.id WHERE a.transaction_id = ? AND i.investigation_id = ?', [itemId, id]);
      if (a) throw new ConflictError('PAIRED_ITEM', `Remove alert ${a.id} first; its transaction travels with it`);
    }
    await db.run('DELETE FROM investigation_items WHERE id = ?', [item.id]);
    if (type === 'alert') {
      const t = await db.get('SELECT transaction_id FROM alerts WHERE id = ?', [itemId]);
      if (t) await db.run("DELETE FROM investigation_items WHERE investigation_id = ? AND item_type = 'transaction' AND item_id = ?", [id, t.transaction_id]);
    }
    await touch(id, expectedVersion);
    await addEvent(id, 'item_removed', actor, `Removed ${type} ${itemId}`, { type, item_id: itemId });
    return true;
  });
}

async function findById(id) {
  return db.get(
    `SELECT i.*, au.username AS assignee_username, cu.username AS created_by_username
       FROM investigations i LEFT JOIN users au ON au.id = i.assigned_to LEFT JOIN users cu ON cu.id = i.created_by WHERE i.id = ?`, [id]);
}

async function list({ status, priority, assignedTo, unassigned, q, page = 1, limit = 20 } = {}) {
  const where = []; const params = [];
  if (status) { where.push('i.status = ?'); params.push(status); }
  if (priority) { where.push('i.priority = ?'); params.push(priority); }
  if (assignedTo) { where.push('i.assigned_to = ?'); params.push(assignedTo); }
  if (unassigned) where.push("i.assigned_to IS NULL AND i.status != 'closed'");
  if (q) { where.push('LOWER(i.title) LIKE ?'); params.push(`%${String(q).toLowerCase().replace(/[%_]/g, '')}%`); }
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = Number((await db.get(`SELECT COUNT(*) AS n FROM investigations i ${w}`, params)).n);
  const rows = await db.all(
    `SELECT i.*, au.username AS assignee_username,
            (SELECT COUNT(*) FROM investigation_items x WHERE x.investigation_id = i.id AND x.item_type = 'alert') AS alert_count,
            (SELECT COUNT(*) FROM investigation_items x WHERE x.investigation_id = i.id AND x.item_type = 'transaction') AS transaction_count
       FROM investigations i LEFT JOIN users au ON au.id = i.assigned_to ${w}
      ORDER BY CASE i.status WHEN 'closed' THEN 1 ELSE 0 END,
               CASE i.priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END, i.updated_at DESC
      LIMIT ? OFFSET ?`, [...params, limit, (page - 1) * limit]);
  return { rows: rows.map((r) => ({ ...r, alert_count: Number(r.alert_count), transaction_count: Number(r.transaction_count) })), total };
}

async function members(id) {
  const alerts = await db.all(
    `SELECT a.id, a.transaction_id, a.severity, a.status, a.verdict, a.resolved, a.claimed_by, a.claim_expires_at, a.message
       FROM investigation_items i JOIN alerts a ON a.id = i.item_id WHERE i.investigation_id = ? AND i.item_type = 'alert' ORDER BY a.id`, [id]);
  const transactions = await db.all(
    `SELECT t.id, t.user_id, u.username, t.amount, t.merchant, t.category, t.location, t.device_fingerprint, t.ip_address, t.fraud_score, t.risk_level, t.created_at
       FROM investigation_items i JOIN transactions t ON t.id = i.item_id JOIN users u ON u.id = t.user_id
      WHERE i.investigation_id = ? AND i.item_type = 'transaction' ORDER BY t.created_at, t.id`, [id]);
  return { alerts, transactions };
}

const mask = (v) => (v && v.length > 8 ? `${v.slice(0, 4)}…${v.slice(-2)}` : v); // device ids are shown shortened in link lists

/** Users, devices, IPs and disputes implied by the member transactions, plus other cases touching them. */
async function links(id, memberTxns) {
  const txnIds = memberTxns.map((t) => t.id);
  const userIds = [...new Set(memberTxns.map((t) => t.user_id))];
  const devices = new Map(); const ips = new Map();
  for (const t of memberTxns) {
    if (t.device_fingerprint) devices.set(t.device_fingerprint, (devices.get(t.device_fingerprint) || 0) + 1);
    if (t.ip_address) ips.set(t.ip_address, (ips.get(t.ip_address) || 0) + 1);
  }
  const disputes = txnIds.length
    ? await db.all(`SELECT id, transaction_id, status, amount_disputed, opened_at, resolved_at FROM disputes WHERE transaction_id IN (${txnIds.map(() => '?').join(',')}) ORDER BY id`, txnIds) : [];
  const users = userIds.length
    ? await db.all(`SELECT id, username FROM users WHERE id IN (${userIds.map(() => '?').join(',')})`, userIds) : [];

  // other open/closed cases that involve the same account, device or IP
  const related = new Map();
  const note = (row, via) => { if (row.investigation_id !== Number(id)) { const r = related.get(row.investigation_id) || { case_id: row.investigation_id, via: new Set() }; r.via.add(via); related.set(row.investigation_id, r); } };
  const dev = [...devices.keys()]; const ip = [...ips.keys()];
  const q = async (col, vals, label) => {
    if (!vals.length) return;
    const rows = await db.all(
      `SELECT DISTINCT i.investigation_id FROM investigation_items i JOIN transactions t ON i.item_type = 'transaction' AND t.id = i.item_id WHERE t.${col} IN (${vals.map(() => '?').join(',')})`, vals);
    rows.forEach((r) => note(r, label));
  };
  await q('user_id', userIds, 'same account'); await q('device_fingerprint', dev, 'same device'); await q('ip_address', ip, 'same IP');

  return {
    users,
    devices: [...devices].map(([value, count]) => ({ value, label: mask(value), transactions: count })),
    ips: [...ips].map(([value, count]) => ({ value, transactions: count })),
    disputes,
    related_cases: [...related.values()].map((r) => ({ case_id: r.case_id, via: [...r.via] })),
  };
}

/** Chronological timeline: this case's own events + the evidence/comments/disputes of what it contains. */
async function timeline(id, { alerts, transactions }) {
  const out = [];
  const own = await db.all('SELECT * FROM investigation_events WHERE investigation_id = ? ORDER BY id', [id]);
  own.forEach((e) => out.push({ at: e.created_at, source: 'case', kind: e.kind, actor: e.actor_username, summary: e.summary, details: e.details ? JSON.parse(e.details) : null }));
  transactions.forEach((t) => out.push({ at: toIso(t.created_at), source: 'transaction', kind: 'transaction', actor: t.username, summary: `${t.username} spent $${Number(t.amount).toFixed(2)} at ${t.merchant} (score ${t.fraud_score}, ${t.risk_level})`, ref: { type: 'transaction', id: t.id } }));
  const aIds = alerts.map((a) => a.id);
  if (aIds.length) {
    const ph = aIds.map(() => '?').join(',');
    (await db.all(`SELECT id, alert_id, author_username, body, created_at FROM alert_comments WHERE alert_id IN (${ph})`, aIds))
      .forEach((c) => out.push({ at: c.created_at, source: 'alert', kind: 'alert_comment', actor: c.author_username, summary: c.body, ref: { type: 'alert', id: c.alert_id } }));
    (await db.all(`SELECT id, alert_id, uploaded_by_username, filename, content_type, size_bytes, created_at FROM alert_evidence WHERE alert_id IN (${ph})`, aIds))
      .forEach((e) => out.push({ at: e.created_at, source: 'alert', kind: 'evidence', actor: e.uploaded_by_username, summary: `Evidence attached: ${e.filename} (${e.size_bytes} bytes)`, ref: { type: 'alert', id: e.alert_id, evidence_id: e.id } }));
    (await db.all(`SELECT id, resolved_at, verdict, resolution_reason FROM alerts WHERE id IN (${ph}) AND resolved = 1 AND resolved_at IS NOT NULL`, aIds))
      .forEach((a) => out.push({ at: toIso(a.resolved_at), source: 'alert', kind: 'alert_resolved', actor: null, summary: `Alert ${a.id} resolved: ${a.verdict}${a.resolution_reason ? ` (${a.resolution_reason})` : ''}`, ref: { type: 'alert', id: a.id } }));
  }
  const tIds = transactions.map((t) => t.id);
  if (tIds.length) {
    (await db.all(`SELECT id, transaction_id, status, opened_at, resolved_at, amount_disputed FROM disputes WHERE transaction_id IN (${tIds.map(() => '?').join(',')})`, tIds)).forEach((d) => {
      const iso = toIso;
      out.push({ at: iso(d.opened_at), source: 'dispute', kind: 'dispute_opened', actor: null, summary: `Dispute opened for $${Number(d.amount_disputed).toFixed(2)}`, ref: { type: 'dispute', id: d.id } });
      if (d.resolved_at) out.push({ at: iso(d.resolved_at), source: 'dispute', kind: 'dispute_resolved', actor: null, summary: `Dispute ${d.status}`, ref: { type: 'dispute', id: d.id } });
    });
  }
  return out.sort((a, b) => new Date(a.at) - new Date(b.at) || 0).map((e) => ({ ...e, at: toIso(e.at) }));
}

async function assign(id, assigneeId, actor, expectedVersion) {
  return db.transaction(async () => {
    const inv = await findById(id);
    if (inv.status === 'closed') throw new ConflictError('CASE_CLOSED', 'Reopen the case before reassigning it');
    await db.run('UPDATE investigations SET assigned_to = ?, status = CASE WHEN status = \'open\' AND CAST(? AS INTEGER) IS NOT NULL THEN \'investigating\' ELSE status END WHERE id = ?', [assigneeId, assigneeId, id]);
    await touch(id, expectedVersion);
    await addEvent(id, 'assigned', actor, assigneeId ? `Assigned to user #${assigneeId}` : 'Unassigned', { from: inv.assigned_to, to: assigneeId });
  });
}

async function setStatus(id, status, actor, { reason, expectedVersion } = {}) {
  return db.transaction(async () => {
    const inv = await findById(id);
    if (!TRANSITIONS[inv.status].includes(status)) throw new ConflictError('BAD_TRANSITION', `Cannot move a case from ${inv.status} to ${status}`);
    if (status === 'closed') throw new ConflictError('USE_CLOSE', 'Close a case with an outcome via POST /close');
    if (inv.status === 'closed') { // reopen
      await db.run("UPDATE investigations SET status = ?, outcome = NULL, outcome_note = NULL, closed_at = NULL, closed_by = NULL WHERE id = ?", [status, id]);
    } else await db.run('UPDATE investigations SET status = ? WHERE id = ?', [status, id]);
    await touch(id, expectedVersion);
    await addEvent(id, inv.status === 'closed' ? 'reopened' : 'status', actor, inv.status === 'closed' ? `Reopened: ${reason}` : `Status ${inv.status} → ${status}`, { from: inv.status, to: status, reason: reason || null, previous_outcome: inv.status === 'closed' ? inv.outcome : undefined });
  });
}

async function update(id, { title, summary, priority }, actor, expectedVersion) {
  return db.transaction(async () => {
    const inv = await findById(id);
    const sets = []; const params = []; const changed = {};
    if (title !== undefined && title !== inv.title) { sets.push('title = ?'); params.push(title); changed.title = [inv.title, title]; }
    if (summary !== undefined && summary !== inv.summary) { sets.push('summary = ?'); params.push(summary); changed.summary = true; }
    if (priority !== undefined && priority !== inv.priority) { sets.push('priority = ?'); params.push(priority); changed.priority = [inv.priority, priority]; }
    if (!sets.length) return false;
    await db.run(`UPDATE investigations SET ${sets.join(', ')} WHERE id = ?`, [...params, id]);
    await touch(id, expectedVersion);
    await addEvent(id, 'updated', actor, `Updated ${Object.keys(changed).join(', ')}`, changed);
    return true;
  });
}

async function comment(id, body, actor) {
  await db.transaction(async () => { await addEvent(id, 'comment', actor, body); await touch(id); });
}

async function close(id, { outcome, note }, actor, expectedVersion) {
  return db.transaction(async () => {
    const inv = await findById(id);
    if (inv.status === 'closed') throw new ConflictError('CASE_CLOSED', 'Case is already closed');
    await db.run("UPDATE investigations SET status = 'closed', outcome = ?, outcome_note = ?, closed_at = ?, closed_by = ? WHERE id = ?", [outcome, note, now(), actor.id, id]);
    await touch(id, expectedVersion);
    await addEvent(id, 'closed', actor, `Closed as ${outcome}`, { outcome, note });
  });
}

/** Alerts not yet in any case that share an account, device or IP with this case — candidates only, never auto-added. */
async function suggestions(id, memberTxns, limit = 25) {
  const userIds = [...new Set(memberTxns.map((t) => t.user_id))];
  const devs = [...new Set(memberTxns.map((t) => t.device_fingerprint).filter(Boolean))];
  const ips = [...new Set(memberTxns.map((t) => t.ip_address).filter(Boolean))];
  const clauses = []; const params = [];
  if (userIds.length) { clauses.push(`t.user_id IN (${userIds.map(() => '?').join(',')})`); params.push(...userIds); }
  if (devs.length) { clauses.push(`t.device_fingerprint IN (${devs.map(() => '?').join(',')})`); params.push(...devs); }
  if (ips.length) { clauses.push(`t.ip_address IN (${ips.map(() => '?').join(',')})`); params.push(...ips); }
  if (!clauses.length) return [];
  const rows = await db.all(
    `SELECT a.id AS alert_id, a.severity, a.status, t.id AS transaction_id, t.user_id, t.amount, t.merchant, t.device_fingerprint, t.ip_address, t.created_at
       FROM alerts a JOIN transactions t ON t.id = a.transaction_id
      WHERE (${clauses.join(' OR ')})
        AND NOT EXISTS (SELECT 1 FROM investigation_items i WHERE i.item_type = 'alert' AND i.item_id = a.id)
      ORDER BY a.id DESC LIMIT ?`, [...params, limit]);
  return rows.map((r) => ({
    alert_id: r.alert_id, transaction_id: r.transaction_id, severity: r.severity, status: r.status, amount: r.amount, merchant: r.merchant, created_at: r.created_at,
    reasons: [userIds.includes(r.user_id) && 'same account', devs.includes(r.device_fingerprint) && 'same device', ips.includes(r.ip_address) && 'same IP'].filter(Boolean),
  }));
}

module.exports = {
  STATUSES, PRIORITIES, OUTCOMES, TRANSITIONS, ConflictError,
  create, addItems, removeItem, findById, list, members, links, timeline, assign, setStatus, update, comment, close, suggestions,
};
