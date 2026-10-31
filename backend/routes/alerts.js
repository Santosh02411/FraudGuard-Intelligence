const express = require('express');
const router = express.Router();
const alertRepository = require('../models/alertRepository');
const userRepository = require('../models/userRepository');
const transactionRepository = require('../models/transactionRepository');
const explanationService = require('../services/explanationService');
const { authMiddleware } = require('../middleware/auth');
const { AppError, asyncHandler } = require('../middleware/errorHandler');
const { validate } = require('../middleware/validate');
const alertSchemas = require('../schemas/alertSchemas');
const { pagination, paginationMeta } = require('../schemas/paginationSchema');
const { audit } = require('../middleware/auditLog');
const alertCase = require('../models/alertCaseRepository');
const auditLogRepository = require('../models/auditLogRepository');
const alertEvents = require('../services/alertEvents');
const config = require('../config/env');
const crypto = require('crypto');
const { adminMiddleware } = require('../middleware/auth');
const csvService = require('../services/csvService');

/**
 * Expected version for optimistic locking, from the body (`version`) or an
 * `If-Match` header. Optional for backward compatibility; the web UI always
 * sends it. See alertRepository.resolve for what happens without it.
 */
function expectedVersion(req) {
  if (req.body && Number.isInteger(req.body.version)) return req.body.version;
  const m = /^"?(\d+)"?$/.exec(req.headers['if-match'] || '');
  return m ? Number(m[1]) : undefined;
}

async function conflictFor(id, message, actorId) {
  const current = alertCase.present(await alertRepository.findByIdWithDetails(id));
  // A live lease held by someone else is a different problem from a stale version: say so.
  if (actorId && current && alertCase.isLockedForOthers(current, actorId)) {
    const err = AppError.conflict(`This case is being worked by ${current.claimed_by_username || 'another investigator'} until ${current.claim_expires_at}. Ask them to release it, or an admin can take it over.`);
    err.details = { code: 'ALERT_LOCKED', current };
    return err;
  }
  const err = AppError.conflict(message);
  err.details = { code: 'VERSION_CONFLICT', current };
  return err;
}

// GET /api/alerts?page=&limit=&status=&riskLevel=&merchant=&dateFrom=&dateTo=&amountMin=&amountMax=&assignedTo=
// Paginated + filterable alerts — the case-management filter bar. Regular
// users see only their own alerts; admins see everyone's.
const listQuerySchema = pagination.merge(alertSchemas.listQuery);
router.get('/', authMiddleware, validate({ query: listQuerySchema }), asyncHandler(async (req, res) => {
  const { page, limit, ...filters } = req.query;
  const { rows: alerts, total } = req.user.role === 'admin'
    ? await alertRepository.allWithUsername({ page, limit, ...filters })
    : await alertRepository.forUser(req.user.id, { page, limit, ...filters });
  res.json({ alerts: alerts.map((a) => alertCase.present(a)), pagination: paginationMeta({ page, limit, total }) });
}));

// PATCH /api/alerts/bulk-resolve - resolve a batch of alerts with the
// same verdict/note in one request (feature: bulk actions — a real
// triage sweep, e.g. clearing a batch of card-testing false positives,
// shouldn't cost one click per alert). Fails the WHOLE batch if any id
// is missing or not owned by the caller, rather than partially applying —
// a bulk action silently succeeding for 8 of 10 requested alerts is a
// worse failure mode than requiring the caller to notice and retry.
router.patch('/bulk-resolve', authMiddleware, validate({ body: alertSchemas.bulkResolveBody }), asyncHandler(async (req, res) => {
  const { alertIds, verdict, note, reason } = req.body;
  const uniqueIds = [...new Set(alertIds)];

  const alerts = await alertRepository.findByIds(uniqueIds);
  const foundIds = new Set(alerts.map((a) => a.id));
  const missingIds = uniqueIds.filter((id) => !foundIds.has(id));
  if (missingIds.length > 0) {
    throw AppError.notFound(`Alert(s) not found: ${missingIds.join(', ')}`);
  }

  if (req.user.role !== 'admin') {
    const notOwned = alerts.some((a) => a.user_id !== req.user.id);
    if (notOwned) throw AppError.forbidden('Not authorized to resolve one or more of the specified alerts');
  }

  // Cases another investigator is working right now are skipped (and reported), never overwritten.
  const lockedIds = alerts.filter((a) => !a.resolved && alertCase.isLockedForOthers(a, req.user.id)).map((a) => a.id);
  const { changes } = await alertRepository.bulkResolve(uniqueIds.filter((id) => !lockedIds.includes(id)), { verdict, note, reason, resolvedBy: req.user.id });
  // Only still-open alerts are touched, so an alert another investigator
  // resolved a moment ago is left alone rather than overwritten.
  const resolvedNow = Number(changes);

  audit({
    req, userId: req.user.id, username: req.user.username,
    action: 'alerts.bulk_resolve', targetType: 'alert', targetId: null, outcome: 'success',
    details: { alertIds: uniqueIds, count: uniqueIds.length, resolved: resolvedNow, alreadyResolved: uniqueIds.length - resolvedNow - lockedIds.length, lockedIds, verdict, reason, hasNote: Boolean(note) },
  });

  res.json({ message: `${resolvedNow} alert(s) resolved`, resolvedCount: resolvedNow, alreadyResolvedCount: uniqueIds.length - resolvedNow - lockedIds.length, lockedCount: lockedIds.length, lockedIds, alertIds: uniqueIds });
}));

// GET /api/alerts/metrics?days= — team dashboard numbers: queue health, SLA, verdict mix, loss/recovered/prevented.
router.get('/metrics', authMiddleware, adminMiddleware, validate({ query: alertSchemas.metricsQuery }), asyncHandler(async (req, res) => {
  res.json(await alertCase.metrics({ days: req.query.days }));
}));

// GET /api/alerts/export?<same filters as GET />
// CSV export (feature: CSV export). Registered before /:id, same
// ordering reasoning as transactions' export route.
const EXPORT_ROW_CAP = 10000;
router.get('/export', authMiddleware, validate({ query: alertSchemas.listQuery }), asyncHandler(async (req, res) => {
  const filters = req.query;
  const { rows: alerts } = req.user.role === 'admin'
    ? await alertRepository.allWithUsername({ page: 1, limit: EXPORT_ROW_CAP, ...filters })
    : await alertRepository.forUser(req.user.id, { page: 1, limit: EXPORT_ROW_CAP, ...filters });

  const csv = csvService.toCsv(alerts, [
    { key: 'id', header: 'ID' },
    { key: 'created_at', header: 'Date' },
    { key: 'username', header: 'User' }, // only populated for admin exports
    { key: 'merchant', header: 'Merchant' },
    { key: 'amount', header: 'Amount' },
    { key: 'risk_level', header: 'Risk Level' },
    { key: 'status', header: 'Status' },
    { key: 'verdict', header: 'Verdict' },
    { key: 'assignee_username', header: 'Assigned To' },
    { key: 'resolution_note', header: 'Resolution Note' },
    { key: 'message', header: 'Message' },
  ]);

  audit({ req, userId: req.user.id, username: req.user.username, action: 'alerts.export', outcome: 'success', details: { rowCount: alerts.length, filters } });

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="alerts-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send(csv);
}));

// GET /api/alerts/:id - view a single alert (audit trail: who viewed
// which alert and when — feature: audit trail).
router.get('/:id', authMiddleware, validate({ params: alertSchemas.resolveParams }), asyncHandler(async (req, res) => {
  const alert = await alertRepository.findByIdWithDetails(req.params.id);
  if (!alert) throw AppError.notFound('Alert not found');
  if (req.user.role !== 'admin' && alert.user_id !== req.user.id) {
    throw AppError.forbidden('Not authorized');
  }

  audit({ req, userId: req.user.id, username: req.user.username, action: 'alerts.view', targetType: 'alert', targetId: alert.id, outcome: 'success' });

  res.json({ alert: alertCase.present(alert) });
}));

// GET /api/alerts/:id/explanation - feature: LLM-generated plain-language
// explanations. Turns the transaction's SHAP top-factors (or hard-rule/
// rule-engine reasons, whichever actually decided the score) into ONE
// human sentence for an analyst who doesn't want to read a feature-
// contribution chart. Generated ON DEMAND (not at scoring time for every
// transaction — the 99% of low-risk transactions nobody ever opens an
// alert for shouldn't pay the LLM cost/latency) and cached on the
// transaction row so re-opening the same alert never regenerates it.
router.get('/:id/explanation', authMiddleware, validate({ params: alertSchemas.resolveParams }), asyncHandler(async (req, res) => {
  const alert = await alertRepository.findByIdWithDetails(req.params.id);
  if (!alert) throw AppError.notFound('Alert not found');
  if (req.user.role !== 'admin' && alert.user_id !== req.user.id) {
    throw AppError.forbidden('Not authorized');
  }

  if (alert.plain_language_explanation) {
    return res.json({ explanation: alert.plain_language_explanation, cached: true });
  }

  const txn = transactionRepository.parseRow(alert); // JSON-parses fraud_reasons/shap_explanation/hard_flag_triggered
  const { text, source } = await explanationService.generateExplanation(txn);
  await transactionRepository.savePlainLanguageExplanation(alert.transaction_id, text);

  audit({
    req, userId: req.user.id, username: req.user.username,
    action: 'alerts.explain', targetType: 'alert', targetId: alert.id, outcome: 'success',
    details: { source }, // 'llm' or 'template' — worth tracking since one of these costs money
  });

  res.json({ explanation: text, cached: false });
}));

// PATCH /api/alerts/:id/resolve - resolve an alert with an analyst
// verdict (feature: confirmed-fraud vs. false-positive case management).
// verdict is required, not optional — see schemas/alertSchemas.js's
// comment on why. `confirmed_fraud` feeds the dynamic device/IP
// blacklist (transactionRepository.fraudDeviceAndIpBlacklist);
// `false_positive` explicitly removes it from that signal even if the
// model's original score said otherwise, which is what actually closes
// the feedback loop the old boolean-only resolve couldn't.
router.patch('/:id/resolve', authMiddleware, validate({ params: alertSchemas.resolveParams, body: alertSchemas.resolveBody }), asyncHandler(async (req, res) => {
  const alert = await alertRepository.findById(req.params.id);
  if (!alert) throw AppError.notFound('Alert not found');
  if (req.user.role !== 'admin' && alert.user_id !== req.user.id) {
    throw AppError.forbidden('Not authorized');
  }
  const { verdict, note, reason, prevented_amount: prevented, recovered_amount: recovered, loss_amount: loss } = req.body;
  const hasAmounts = [prevented, recovered, loss].some((v) => v !== undefined);
  if (hasAmounts && req.user.role !== 'admin') throw AppError.forbidden('Only investigators can record loss, recovered or prevented amounts');
  let amounts = { prevented: null, recovered: null, loss: null };
  if (hasAmounts) {
    const detail = await alertRepository.findByIdWithDetails(alert.id);
    try {
      amounts = alertCase.validateOutcome({ verdict, transactionAmount: detail.amount, prevented, recovered, loss });
    } catch (err) { throw AppError.badRequest(err.message); }
  }
  const expected = expectedVersion(req);
  const result = await alertRepository.resolve(req.params.id, { verdict, note, reason, ...amounts, resolvedBy: req.user.id, expectedVersion: expected });
  if (result.changes === 0) {
    // Nothing was written: someone else got there first (or, without a
    // version, the alert was already resolved). Tell the caller what the
    // alert looks like now instead of overwriting the other investigator.
    throw await conflictFor(alert.id, expected !== undefined
      ? 'This alert was changed by someone else since you opened it. Review the latest state and try again.'
      : 'This alert has already been resolved. Send its current version to deliberately re-resolve it.', req.user.id);
  }

  audit({
    req, userId: req.user.id, username: req.user.username,
    action: 'alerts.resolve', targetType: 'alert', targetId: alert.id, outcome: 'success',
    details: {
      transaction_id: alert.transaction_id,
      before: { resolved: !!alert.resolved, status: alert.status, verdict: alert.verdict ?? null, assigned_to: alert.assigned_to ?? null, version: alert.version },
      after: { resolved: true, verdict, reason: reason ?? null, ...(hasAmounts ? { prevented: amounts.prevented, recovered: amounts.recovered, loss: amounts.loss } : {}) },
      verdict, reason: reason ?? null,
      hasNote: Boolean(note), // the note text itself is kept on the alert, not copied into the audit trail
    },
  });

  const updated = await alertRepository.findByIdWithDetails(req.params.id);
  alertEvents.emit('resolved', updated, { actor: req.user, extra: { verdict } });
  res.json({ message: 'Alert resolved', alert: alertCase.present(updated) });
}));

// PATCH /api/alerts/:id/assign - assign (or unassign, with assigneeId:
// null) an alert to an analyst (feature: case assignment). Admin-only:
// only admins currently have visibility across every user's alerts, so
// only admins can meaningfully triage/assign them. The assignee must
// themselves be an admin for the same reason — assigning a case to
// someone who can't see the full alert queue wouldn't make sense.
router.patch('/:id/assign', authMiddleware, validate({ params: alertSchemas.resolveParams, body: alertSchemas.assignBody }), asyncHandler(async (req, res) => {
  if (req.user.role !== 'admin') throw AppError.forbidden('Only admins can assign alerts');

  const alert = await alertRepository.findById(req.params.id);
  if (!alert) throw AppError.notFound('Alert not found');

  const { assigneeId } = req.body;
  let assignee = null;
  if (assigneeId !== null) {
    assignee = await userRepository.findById(assigneeId);
    if (!assignee) throw AppError.notFound('Assignee not found');
    if (assignee.role !== 'admin') throw AppError.badRequest('Alerts can only be assigned to admin users');
  }

  const result = await alertRepository.assign(req.params.id, assigneeId, { expectedVersion: expectedVersion(req), actorId: req.user.id });
  if (result.changes === 0) {
    throw await conflictFor(alert.id, 'This alert was changed by someone else since you opened it. Review the latest state and try again.', req.user.id);
  }

  audit({
    req, userId: req.user.id, username: req.user.username,
    action: 'alerts.assign', targetType: 'alert', targetId: alert.id, outcome: 'success',
    details: { transaction_id: alert.transaction_id, before: { assigned_to: alert.assigned_to ?? null }, after: { assigned_to: assigneeId }, assigneeId, assigneeUsername: assignee?.username ?? null },
  });

  const updated = await alertRepository.findByIdWithDetails(req.params.id);
  alertEvents.emit('assigned', updated, { actor: req.user });
  res.json({ message: assigneeId ? 'Alert assigned' : 'Alert unassigned', alert: alertCase.present(updated) });
}));

// ===========================================================================
// Case management (admin/investigator only). Customers never see these: claims,
// internal comments, evidence and escalations are investigation records.
// ===========================================================================
async function loadForCase(req) {
  const alert = await alertRepository.findByIdWithDetails(req.params.id);
  if (!alert) throw AppError.notFound('Alert not found');
  return alert;
}
const caseRoute = [authMiddleware, adminMiddleware];
const idParams = { params: alertSchemas.resolveParams };

// GET /:id/case — everything an investigator needs on one screen.
router.get('/:id/case', ...caseRoute, validate(idParams), asyncHandler(async (req, res) => {
  const alert = await loadForCase(req);
  const [comments, evidence, activity] = await Promise.all([
    alertCase.listComments(alert.id), alertCase.listEvidence(alert.id), auditLogRepository.forTarget('alert', alert.id),
  ]);
  res.json({ alert: alertCase.present(alert), comments, evidence, activity: activity.reverse(), reasons: alertSchemas.RESOLUTION_REASONS });
}));

// POST /:id/claim — take (or renew) the working lease. 409 ALERT_LOCKED if someone else holds a live one.
router.post('/:id/claim', ...caseRoute, validate({ ...idParams, body: alertSchemas.claimBody }), asyncHandler(async (req, res) => {
  const alert = await loadForCase(req);
  if (alert.resolved) throw AppError.badRequest('A resolved case cannot be claimed');
  const force = req.body.force === true;
  if (force && !req.body.reason) throw AppError.badRequest('Taking over another investigator\'s case needs a reason');
  const holderBefore = alertCase.isLockedForOthers(alert, req.user.id) ? { id: alert.claimed_by, username: alert.claimed_by_username } : null;
  const r = await alertCase.claim(alert.id, req.user.id, { force });
  if (!r.claimed) throw await conflictFor(alert.id, 'Could not claim this case', req.user.id);
  const fresh = await alertRepository.findByIdWithDetails(alert.id);
  if (!alert.claimed_by || alert.claimed_by !== req.user.id || force) {
    audit({ req, userId: req.user.id, username: req.user.username, action: force && holderBefore ? 'alerts.claim_takeover' : 'alerts.claim', targetType: 'alert', targetId: alert.id, outcome: 'success',
      details: { transaction_id: alert.transaction_id, before: { claimed_by: holderBefore?.username ?? null }, after: { claimed_by: req.user.username }, reason: req.body.reason ?? null } });
    alertEvents.emit(force && holderBefore ? 'claim_takeover' : 'claimed', fresh, { actor: req.user });
  }
  res.json({ claimed: true, expires_at: r.expires_at, ttl_minutes: config.alertCases.claimTtlMinutes, alert: alertCase.present(fresh) });
}));

// DELETE /:id/claim — release (the holder, or an admin with force).
router.delete('/:id/claim', ...caseRoute, validate({ ...idParams, body: alertSchemas.releaseBody }), asyncHandler(async (req, res) => {
  const alert = await loadForCase(req);
  const ok = await alertCase.release(alert.id, req.user.id, { force: req.body.force === true });
  if (ok) {
    audit({ req, userId: req.user.id, username: req.user.username, action: 'alerts.release', targetType: 'alert', targetId: alert.id, outcome: 'success', details: { transaction_id: alert.transaction_id, before: { claimed_by: alert.claimed_by_username ?? null }, after: { claimed_by: null } } });
    alertEvents.emit('released', await alertRepository.findByIdWithDetails(alert.id), { actor: req.user });
  }
  res.json({ released: ok });
}));

// PATCH /:id/status — investigation status (not 'resolved': resolving needs a verdict, use /resolve).
router.patch('/:id/status', ...caseRoute, validate({ ...idParams, body: alertSchemas.statusBody }), asyncHandler(async (req, res) => {
  const alert = await loadForCase(req);
  if (alert.resolved) throw AppError.badRequest('A resolved case cannot change status');
  const expected = expectedVersion(req);
  const ok = await alertCase.setStatus(alert.id, req.body.status, { actorId: req.user.id, expectedVersion: expected });
  if (!ok) throw await conflictFor(alert.id, 'This alert was changed by someone else since you opened it. Review the latest state and try again.', req.user.id);
  audit({ req, userId: req.user.id, username: req.user.username, action: 'alerts.status_change', targetType: 'alert', targetId: alert.id, outcome: 'success',
    details: { transaction_id: alert.transaction_id, before: { status: alert.status }, after: { status: req.body.status } } });
  const fresh = await alertRepository.findByIdWithDetails(alert.id);
  alertEvents.emit('status', fresh, { actor: req.user });
  res.json({ alert: alertCase.present(fresh) });
}));

// PATCH /:id/severity — re-triage; the SLA deadline is recomputed from creation time for the new severity.
router.patch('/:id/severity', ...caseRoute, validate({ ...idParams, body: alertSchemas.severityBody }), asyncHandler(async (req, res) => {
  const alert = await loadForCase(req);
  if (alert.resolved) throw AppError.badRequest('A resolved case cannot change severity');
  const ok = await alertCase.setSeverity(alert.id, req.body.severity, { actorId: req.user.id, expectedVersion: expectedVersion(req) });
  if (!ok) throw await conflictFor(alert.id, 'This alert was changed by someone else since you opened it. Review the latest state and try again.', req.user.id);
  const fresh = await alertRepository.findByIdWithDetails(alert.id);
  audit({ req, userId: req.user.id, username: req.user.username, action: 'alerts.severity_change', targetType: 'alert', targetId: alert.id, outcome: 'success',
    details: { transaction_id: alert.transaction_id, reason: req.body.reason, before: { severity: alert.severity, due_at: alert.due_at }, after: { severity: fresh.severity, due_at: fresh.due_at } } });
  alertEvents.emit('severity', fresh, { actor: req.user });
  res.json({ alert: alertCase.present(fresh) });
}));

// POST /:id/escalate — manual escalation (the scheduler escalates overdue cases automatically).
router.post('/:id/escalate', ...caseRoute, validate({ ...idParams, body: alertSchemas.escalateBody }), asyncHandler(async (req, res) => {
  const alert = await loadForCase(req);
  if (alert.resolved) throw AppError.badRequest('A resolved case cannot be escalated');
  if (alert.escalation_level >= config.alertCases.maxEscalationLevel) throw AppError.badRequest('This case is already at the highest escalation level');
  if (!(await alertCase.escalate(alert.id, alert.escalation_level))) throw await conflictFor(alert.id, 'This alert was just escalated or changed. Review the latest state.', req.user.id);
  const fresh = await alertRepository.findByIdWithDetails(alert.id);
  audit({ req, userId: req.user.id, username: req.user.username, action: 'alerts.escalate', targetType: 'alert', targetId: alert.id, outcome: 'success',
    details: { transaction_id: alert.transaction_id, reason: req.body.reason, manual: true, before: { escalation_level: alert.escalation_level, status: alert.status }, after: { escalation_level: fresh.escalation_level, status: fresh.status } } });
  alertEvents.emit('escalated', fresh, { actor: req.user });
  res.json({ alert: alertCase.present(fresh) });
}));

// Comments: append-only (no edit/delete) so the investigation record can't be rewritten.
router.get('/:id/comments', ...caseRoute, validate(idParams), asyncHandler(async (req, res) => {
  await loadForCase(req);
  res.json({ comments: await alertCase.listComments(req.params.id) });
}));
router.post('/:id/comments', ...caseRoute, validate({ ...idParams, body: alertSchemas.commentBody }), asyncHandler(async (req, res) => {
  const alert = await loadForCase(req);
  const comment = await alertCase.addComment(alert.id, req.user, req.body.body);
  audit({ req, userId: req.user.id, username: req.user.username, action: 'alerts.comment', targetType: 'alert', targetId: alert.id, outcome: 'success', details: { transaction_id: alert.transaction_id, comment_id: comment.id, length: req.body.body.length } });
  alertEvents.emit('comment', alert, { actor: req.user, extra: { comment_id: comment.id } });
  res.status(201).json({ comment });
}));

// Evidence ---------------------------------------------------------------
const EVIDENCE_TYPES = {
  'image/png': { ext: ['png'], magic: (b) => b.length > 8 && b.readUInt32BE(0) === 0x89504e47 },
  'image/jpeg': { ext: ['jpg', 'jpeg'], magic: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  'application/pdf': { ext: ['pdf'], magic: (b) => b.slice(0, 5).toString('latin1') === '%PDF-' },
  'text/plain': { ext: ['txt', 'log', 'csv', 'eml'], magic: (b) => !b.includes(0) && Buffer.from(b.toString('utf8'), 'utf8').equals(b) },
};
function detectType(buf) {
  return Object.keys(EVIDENCE_TYPES).find((t) => EVIDENCE_TYPES[t].magic(buf)) || null;
}
function safeFilename(name) {
  const base = String(name).split(/[\\/]/).pop().replace(/[^\w.\- ()]/g, '_').replace(/^\.+/, '').trim().slice(0, 120);
  return base || 'evidence';
}
const rawBody = (req, res, next) => express.raw({ type: () => true, limit: config.alertCases.evidenceMaxBytes })(req, res, (err) => {
  if (err?.type === 'entity.too.large') return next(AppError.badRequest(`Evidence files are limited to ${Math.round(config.alertCases.evidenceMaxBytes / 1024)} KB`));
  return next(err);
});

router.post('/:id/evidence', ...caseRoute, validate({ ...idParams, query: alertSchemas.evidenceQuery }), rawBody, asyncHandler(async (req, res) => {
  const alert = await loadForCase(req);
  const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  if (buf.length === 0) throw AppError.badRequest('Send the file as the raw request body');
  // The file's real type is decided by its CONTENT, never by the client's header or extension.
  const type = detectType(buf);
  if (!type) throw AppError.badRequest('Unsupported evidence type. Allowed: PNG, JPEG, PDF, plain text/CSV/log.');
  const filename = safeFilename(req.query.filename);
  const ext = filename.includes('.') ? filename.split('.').pop().toLowerCase() : '';
  if (!EVIDENCE_TYPES[type].ext.includes(ext)) throw AppError.badRequest(`The file content is ${type} but the name ends in .${ext || '(none)'}`);
  const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
  let rec;
  try {
    rec = await alertCase.addEvidence(alert.id, req.user, { filename, contentType: type, content: buf, sha256, description: req.query.description });
  } catch (err) {
    if (err.code === 'EVIDENCE_LIMIT') throw AppError.badRequest(`At most ${config.alertCases.evidenceMaxFiles} evidence files per case`);
    throw err;
  }
  audit({ req, userId: req.user.id, username: req.user.username, action: 'alerts.evidence_add', targetType: 'alert', targetId: alert.id, outcome: 'success',
    details: { transaction_id: alert.transaction_id, evidence_id: rec.id, filename, content_type: type, size_bytes: buf.length, sha256 } });
  alertEvents.emit('evidence', alert, { actor: req.user, extra: { evidence_id: rec.id } });
  res.status(201).json({ evidence: rec });
}));

router.get('/:id/evidence', ...caseRoute, validate(idParams), asyncHandler(async (req, res) => {
  await loadForCase(req);
  res.json({ evidence: await alertCase.listEvidence(req.params.id) });
}));

router.get('/:id/evidence/:evidenceId', ...caseRoute, validate({ params: alertSchemas.evidenceParams }), asyncHandler(async (req, res) => {
  const row = await alertCase.getEvidence(req.params.id, req.params.evidenceId);
  if (!row) throw AppError.notFound('Evidence not found');
  const content = Buffer.isBuffer(row.content) ? row.content : Buffer.from(row.content);
  if (crypto.createHash('sha256').update(content).digest('hex') !== row.sha256) {
    audit({ req, userId: req.user.id, username: req.user.username, action: 'alerts.evidence_integrity_failure', targetType: 'alert', targetId: row.alert_id, outcome: 'failure', details: { evidence_id: row.id } });
    throw new AppError('Stored evidence failed its integrity check', 500);
  }
  audit({ req, userId: req.user.id, username: req.user.username, action: 'alerts.evidence_view', targetType: 'alert', targetId: row.alert_id, outcome: 'success', details: { evidence_id: row.id } });
  // Always a download, never rendered in our origin; fixed type from content sniffing at upload.
  res.set({
    'Content-Type': row.content_type,
    'Content-Disposition': `attachment; filename="${row.filename.replace(/"/g, '')}"`,
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; sandbox",
    'Cache-Control': 'private, no-store',
  });
  res.send(content);
}));

// PATCH /:id/outcome — record loss / recovered / prevented amounts on a confirmed-fraud case, possibly long after resolution.
router.patch('/:id/outcome', ...caseRoute, validate({ ...idParams, body: alertSchemas.outcomeBody }), asyncHandler(async (req, res) => {
  const alert = await loadForCase(req);
  if (!alert.resolved || alert.verdict !== 'confirmed_fraud') throw AppError.badRequest('Outcome amounts apply only to resolved, confirmed-fraud cases');
  const merged = {
    prevented: req.body.prevented_amount !== undefined ? req.body.prevented_amount : alert.prevented_amount,
    recovered: req.body.recovered_amount !== undefined ? req.body.recovered_amount : alert.recovered_amount,
    loss: req.body.loss_amount !== undefined ? req.body.loss_amount : alert.loss_amount,
  };
  let amounts;
  try { amounts = alertCase.validateOutcome({ verdict: alert.verdict, transactionAmount: alert.amount, ...merged }); } catch (err) { throw AppError.badRequest(err.message); }
  const ok = await alertCase.setOutcome(alert.id, { ...amounts, expectedVersion: expectedVersion(req) });
  if (!ok) throw await conflictFor(alert.id, 'This alert was changed by someone else since you opened it. Review the latest state and try again.', req.user.id);
  audit({ req, userId: req.user.id, username: req.user.username, action: 'alerts.outcome_update', targetType: 'alert', targetId: alert.id, outcome: 'success',
    details: { transaction_id: alert.transaction_id, before: { prevented: alert.prevented_amount, recovered: alert.recovered_amount, loss: alert.loss_amount }, after: amounts } });
  const fresh = await alertRepository.findByIdWithDetails(alert.id);
  alertEvents.emit('outcome', fresh, { actor: req.user });
  res.json({ alert: alertCase.present(fresh) });
}));

module.exports = router;
