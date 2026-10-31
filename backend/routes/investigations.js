/**
 * Investigations (cases): group related alerts/transactions into one unit of work with an
 * owner, a status, a timeline and a recorded outcome. Admin-only (investigators).
 */
const express = require('express');
const router = express.Router();
const repo = require('../models/investigationRepository');
const alertRepository = require('../models/alertRepository');
const userRepository = require('../models/userRepository');
const { authMiddleware, adminMiddleware } = require('../middleware/auth');
const { AppError, asyncHandler } = require('../middleware/errorHandler');
const { validate } = require('../middleware/validate');
const schemas = require('../schemas/investigationSchemas');
const { paginationMeta } = require('../schemas/paginationSchema');
const { audit } = require('../middleware/auditLog');
const db = require('../config/database');

router.use(authMiddleware, adminMiddleware);

const STATUS_FOR = { NOT_FOUND: 404, EMPTY_CASE: 400 };
/** Maps repository ConflictErrors to HTTP errors carrying a machine-readable code. */
function mapErrors(fn) {
  return asyncHandler(async (req, res, next) => {
    try { return await fn(req, res, next); } catch (err) {
      if (err instanceof repo.ConflictError) {
        const e = new AppError(err.message, STATUS_FOR[err.code] || 409);
        e.details = { code: err.code, ...err.extra };
        throw e;
      }
      throw err;
    }
  });
}

const A = (req, action, id, details) => audit({ req, userId: req.user.id, username: req.user.username, action, targetType: 'investigation', targetId: id, outcome: 'success', details });

async function load(id) {
  const inv = await repo.findById(id);
  if (!inv) throw AppError.notFound('Case not found');
  return inv;
}

async function requireAssignableAdmin(assigneeId) {
  const u = await userRepository.findById(assigneeId);
  if (!u || u.role !== 'admin') throw AppError.badRequest('Assignee must be an active investigator (admin)');
}

router.get('/', validate({ query: schemas.listQuery }), asyncHandler(async (req, res) => {
  const { page, limit, unassigned, ...f } = req.query;
  const { rows, total } = await repo.list({ ...f, unassigned: unassigned === 'true', page, limit });
  res.json({ cases: rows, pagination: paginationMeta({ page, limit, total }) });
}));

// Which case (if any) holds this alert/transaction — lets the alert list show a "in case #n" badge.
router.get('/by-item', validate({ query: schemas.byItemQuery }), asyncHandler(async (req, res) => {
  const row = await db.get('SELECT investigation_id FROM investigation_items WHERE item_type = ? AND item_id = ?', [req.query.type, req.query.id]);
  res.json({ case_id: row ? row.investigation_id : null });
}));

router.post('/', validate({ body: schemas.createBody }), mapErrors(async (req, res) => {
  const b = req.body;
  if (b.assignedTo) await requireAssignableAdmin(b.assignedTo);
  const id = await repo.create(b, req.user);
  A(req, 'investigations.create', id, { alerts: b.alertIds.length, transactions: b.transactionIds.length, priority: b.priority ?? null });
  res.status(201).json(await detail(id));
}));

async function detail(id) {
  const investigation = await load(id);
  const m = await repo.members(id);
  const links = await repo.links(id, m.transactions);
  const exposure = m.transactions.reduce((s, t) => s + Number(t.amount), 0);
  return {
    investigation, alerts: m.alerts, transactions: m.transactions, links,
    summary: {
      exposure_amount: Math.round(exposure * 100) / 100,
      accounts: links.users.length, devices: links.devices.length, ips: links.ips.length,
      open_alerts: m.alerts.filter((a) => !a.resolved).length,
      resolved_alerts: m.alerts.filter((a) => a.resolved).length,
    },
  };
}

router.get('/:id', validate({ params: schemas.idParams }), asyncHandler(async (req, res) => res.json(await detail(req.params.id))));

router.get('/:id/timeline', validate({ params: schemas.idParams }), asyncHandler(async (req, res) => {
  await load(req.params.id);
  res.json({ timeline: await repo.timeline(req.params.id, await repo.members(req.params.id)) });
}));

router.get('/:id/suggestions', validate({ params: schemas.idParams }), asyncHandler(async (req, res) => {
  await load(req.params.id);
  const m = await repo.members(req.params.id);
  res.json({
    suggestions: await repo.suggestions(req.params.id, m.transactions),
    caution: 'Shared accounts, devices or IPs are leads, not proof: shared networks and common browsers collide. Review before adding.',
  });
}));

router.patch('/:id', validate({ params: schemas.idParams, body: schemas.updateBody }), mapErrors(async (req, res) => {
  await load(req.params.id);
  const { version, ...fields } = req.body;
  const changed = await repo.update(req.params.id, fields, req.user, version);
  if (changed) A(req, 'investigations.update', req.params.id, { fields: Object.keys(fields) });
  res.json(await detail(req.params.id));
}));

router.post('/:id/items', validate({ params: schemas.idParams, body: schemas.itemsBody }), mapErrors(async (req, res) => {
  const inv = await load(req.params.id);
  if (inv.status === 'closed') throw new AppError('Reopen the case before adding to it', 409);
  const added = await repo.addItems(req.params.id, req.body, req.user, req.body.version);
  if (added) A(req, 'investigations.add_items', req.params.id, { added, alertIds: req.body.alertIds, transactionIds: req.body.transactionIds });
  res.json({ added, ...(await detail(req.params.id)) });
}));

router.delete('/:id/items/:type/:itemId', validate({ params: schemas.itemParams, query: schemas.removeQuery }), mapErrors(async (req, res) => {
  const inv = await load(req.params.id);
  if (inv.status === 'closed') throw new AppError('Reopen the case before changing it', 409);
  const removed = await repo.removeItem(req.params.id, req.params.type, req.params.itemId, req.user, req.query.version);
  if (!removed) throw AppError.notFound('Item is not in this case');
  A(req, 'investigations.remove_item', req.params.id, { type: req.params.type, itemId: req.params.itemId });
  res.json(await detail(req.params.id));
}));

router.patch('/:id/assign', validate({ params: schemas.idParams, body: schemas.assignBody }), mapErrors(async (req, res) => {
  const inv = await load(req.params.id);
  if (req.body.assigneeId) await requireAssignableAdmin(req.body.assigneeId);
  await repo.assign(req.params.id, req.body.assigneeId, req.user, req.body.version);
  A(req, 'investigations.assign', req.params.id, { from: inv.assigned_to, to: req.body.assigneeId });
  res.json(await detail(req.params.id));
}));

router.patch('/:id/status', validate({ params: schemas.idParams, body: schemas.statusBody }), mapErrors(async (req, res) => {
  const inv = await load(req.params.id);
  if (inv.status === 'closed' && !req.body.reason) throw AppError.badRequest('A reason (10+ characters) is required to reopen a closed case');
  await repo.setStatus(req.params.id, req.body.status, req.user, { reason: req.body.reason, expectedVersion: req.body.version });
  A(req, inv.status === 'closed' ? 'investigations.reopen' : 'investigations.status', req.params.id, { from: inv.status, to: req.body.status, reason: req.body.reason ?? null });
  res.json(await detail(req.params.id));
}));

router.post('/:id/comments', validate({ params: schemas.idParams, body: schemas.commentBody }), mapErrors(async (req, res) => {
  const inv = await load(req.params.id);
  if (inv.status === 'closed') throw new AppError('Reopen the case before commenting', 409);
  await repo.comment(req.params.id, req.body.body, req.user);
  A(req, 'investigations.comment', req.params.id, { length: req.body.body.length }); // text lives on the timeline, not in the audit log
  res.status(201).json({ timeline: await repo.timeline(req.params.id, await repo.members(req.params.id)) });
}));

const ALERT_REASON = { confirmed_fraud: 'customer_confirmed_fraud', legitimate: 'customer_confirmed_legitimate' };
const ALERT_VERDICT = { confirmed_fraud: 'confirmed_fraud', legitimate: 'false_positive' };

router.post('/:id/close', validate({ params: schemas.idParams, body: schemas.closeBody }), mapErrors(async (req, res) => {
  const inv = await load(req.params.id);
  const { outcome, note, resolve_alerts: resolveAlerts, version } = req.body;
  if (resolveAlerts && outcome === 'inconclusive') throw AppError.badRequest('An inconclusive case cannot resolve its alerts: an alert verdict is either confirmed fraud or false positive');
  await repo.close(req.params.id, { outcome, note }, req.user, version);

  // Feeding the outcome back to the alerts is what makes it count in model performance and the
  // dynamic blacklist. Alerts claimed by another investigator are skipped and reported, never overridden.
  const result = { resolved: [], skipped: [] };
  if (resolveAlerts) {
    const m = await repo.members(req.params.id);
    for (const a of m.alerts.filter((x) => !x.resolved)) {
      const r = await alertRepository.resolve(a.id, { verdict: ALERT_VERDICT[outcome], note: `Resolved via case #${inv.id}`, reason: ALERT_REASON[outcome], resolvedBy: req.user.id, actorId: req.user.id });
      (r.changes ? result.resolved : result.skipped).push(a.id);
    }
    if (result.skipped.length) await repo.comment(req.params.id, `Alerts not auto-resolved (locked or already changed): ${result.skipped.join(', ')}`, { id: null, username: 'system' });
  }
  A(req, 'investigations.close', req.params.id, { outcome, resolve_alerts: resolveAlerts, resolved_alerts: result.resolved, skipped_alerts: result.skipped });
  res.json({ ...(await detail(req.params.id)), alerts_resolved: result.resolved, alerts_skipped: result.skipped });
}));

module.exports = router;
