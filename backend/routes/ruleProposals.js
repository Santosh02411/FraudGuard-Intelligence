/**
 * Rule Lab: draft -> simulate -> approve -> activate -> (rollback) for fraud-rule and risk-policy changes.
 * Admin-only. Simulation reads history and writes only the proposal's own record; activation is the first
 * step that touches live rules, and only from the `approved` state.
 */
const express = require('express');
const router = express.Router();
const repo = require('../models/ruleProposalRepository');
const { authMiddleware, adminMiddleware } = require('../middleware/auth');
const { AppError, asyncHandler } = require('../middleware/errorHandler');
const { validate } = require('../middleware/validate');
const schemas = require('../schemas/ruleProposalSchemas');
const { paginationMeta } = require('../schemas/paginationSchema');
const { audit } = require('../middleware/auditLog');

router.use(authMiddleware, adminMiddleware);

const STATUS_FOR = { NOT_FOUND: 404, INVALID: 400 };
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
const A = (req, action, id, details) => audit({ req, userId: req.user.id, username: req.user.username, action, targetType: 'rule_proposal', targetId: id, outcome: 'success', details });

router.get('/state', asyncHandler(async (req, res) => res.json(await repo.state())));

router.get('/', validate({ query: schemas.listQuery }), asyncHandler(async (req, res) => {
  const { page, limit, status } = req.query;
  const { rows, total } = await repo.list({ status, page, limit });
  res.json({ proposals: rows, pagination: paginationMeta({ page, limit, total }) });
}));

// Ad-hoc "what if" — nothing is stored.
router.post('/simulate', validate({ body: schemas.adhocBody }), mapErrors(async (req, res) => {
  res.json(await repo.simulateContent(req.body));
}));

router.post('/', validate({ body: schemas.createBody }), mapErrors(async (req, res) => {
  const p = await repo.create(req.body, req.user);
  A(req, 'rule_proposal.create', p.id, { title: p.title, rule_changes: p.rule_changes.length, policy_change: !!p.policy_change });
  res.status(201).json({ proposal: p });
}));

router.get('/:id', validate({ params: schemas.idParams }), mapErrors(async (req, res) => {
  const p = await repo.findById(req.params.id);
  if (!p) throw AppError.notFound('Proposal not found');
  res.json({ proposal: p, events: await repo.events(p.id) });
}));

router.patch('/:id', validate({ params: schemas.idParams, body: schemas.updateBody }), mapErrors(async (req, res) => {
  const p = await repo.update(req.params.id, req.body, req.user);
  A(req, 'rule_proposal.update', p.id, { content_hash: p.content_hash });
  res.json({ proposal: p });
}));

router.post('/:id/simulate', validate({ params: schemas.idParams, body: schemas.simulateBody }), mapErrors(async (req, res) => {
  const p = await repo.runSimulation(req.params.id, req.body, req.user);
  A(req, 'rule_proposal.simulate', p.id, { delta: p.simulation?.delta });
  res.json({ proposal: p });
}));

router.post('/:id/approve', validate({ params: schemas.idParams, body: schemas.approveBody }), mapErrors(async (req, res) => {
  const p = await repo.approve(req.params.id, req.body, req.user);
  A(req, 'rule_proposal.approve', p.id, { note: req.body.note ?? null });
  res.json({ proposal: p });
}));

router.post('/:id/reject', validate({ params: schemas.idParams, body: schemas.reasonBody }), mapErrors(async (req, res) => {
  const p = await repo.reject(req.params.id, req.body, req.user);
  A(req, 'rule_proposal.reject', p.id, { reason: req.body.reason });
  res.json({ proposal: p });
}));

router.post('/:id/activate', validate({ params: schemas.idParams }), mapErrors(async (req, res) => {
  const p = await repo.activate(req.params.id, req.user);
  A(req, 'rule_proposal.activate', p.id, { rule_version: p.applied_rule_version, policy_version: p.applied_policy_version });
  res.json({ proposal: p });
}));

router.post('/:id/rollback', validate({ params: schemas.idParams, body: schemas.reasonBody }), mapErrors(async (req, res) => {
  const p = await repo.rollback(req.params.id, req.body, req.user);
  A(req, 'rule_proposal.rollback', p.id, { reason: req.body.reason });
  res.json({ proposal: p });
}));

module.exports = router;
