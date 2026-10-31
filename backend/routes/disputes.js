/**
 * Chargeback/Dispute Tracking (feature: case management / compliance)
 * =======================================================================
 * See models/disputeRepository.js's header for the lifecycle and why
 * this is separate from alerts.verdict. Any account owner (or an admin,
 * on their behalf) can open a dispute on their own transaction; only an
 * admin (the compliance/fraud-ops role in this app) can advance its
 * status, since that's the "we reviewed the evidence, here's the
 * outcome" step — analogous to alerts.js's resolve endpoint being
 * admin-only for the same reason.
 */

const express = require('express');
const router = express.Router();
const disputeRepository = require('../models/disputeRepository');
const transactionRepository = require('../models/transactionRepository');
const { authMiddleware, adminMiddleware } = require('../middleware/auth');
const { AppError, asyncHandler } = require('../middleware/errorHandler');
const { validate } = require('../middleware/validate');
const disputeSchemas = require('../schemas/disputeSchemas');
const { audit } = require('../middleware/auditLog');
const csvService = require('../services/csvService');

// POST /api/disputes - open a new dispute on a transaction.
router.post('/', authMiddleware, validate({ body: disputeSchemas.openBody }), asyncHandler(async (req, res) => {
  const txn = await transactionRepository.findById(req.body.transaction_id);
  if (!txn) throw AppError.notFound('Transaction not found');
  if (req.user.role !== 'admin' && txn.user_id !== req.user.id) throw AppError.forbidden('Not authorized');

  try {
    const dispute = await disputeRepository.openDispute({
      transactionId: txn.id,
      amountDisputed: req.body.amount_disputed ?? txn.amount,
      reason: req.body.reason,
      openedBy: req.user.id,
    });

    audit({
      req, userId: req.user.id, username: req.user.username,
      action: 'disputes.open', targetType: 'dispute', targetId: dispute.id, outcome: 'success',
      details: { transaction_id: txn.id, amount_disputed: dispute.amount_disputed },
    });

    res.status(201).json({ message: 'Dispute opened', dispute });
  } catch (err) {
    if (err.code === 'ALREADY_DISPUTED') throw AppError.conflict(err.message);
    throw err;
  }
}));

// GET /api/disputes - list disputes. Admins see every case (optionally
// filtered by ?status=); everyone else sees only disputes on their own
// transactions — same ownership-scoping pattern as GET /api/transactions.
router.get('/', authMiddleware, validate({ query: disputeSchemas.listQuery }), asyncHandler(async (req, res) => {
  const all = await disputeRepository.list({ status: req.query.status });
  if (req.user.role === 'admin') return res.json({ disputes: all });

  // list() joins to the OWNING user's username for display, not their
  // id, so a regular user's own-case filter needs one lookup per row
  // rather than a filter over a field that isn't in that result set.
  const own = [];
  for (const d of all) {
    const txn = await transactionRepository.findById(d.transaction_id);
    if (txn && txn.user_id === req.user.id) own.push(d);
  }
  res.json({ disputes: own });
}));

// GET /api/disputes/export - CSV export (feature: CSV export), same
// ?status= filter and ownership scoping as the list endpoint above.
// Registered before /:id so "export" isn't swallowed as an id.
router.get('/export', authMiddleware, validate({ query: disputeSchemas.listQuery }), asyncHandler(async (req, res) => {
  const all = await disputeRepository.list({ status: req.query.status });

  let disputes = all;
  if (req.user.role !== 'admin') {
    disputes = [];
    for (const d of all) {
      const txn = await transactionRepository.findById(d.transaction_id);
      if (txn && txn.user_id === req.user.id) disputes.push(d);
    }
  }

  const csv = csvService.toCsv(disputes, [
    { key: 'id', header: 'ID' },
    { key: 'opened_at', header: 'Opened' },
    { key: 'account_username', header: 'Account' }, // only meaningful for admin exports
    { key: 'merchant', header: 'Merchant' },
    { key: 'amount_disputed', header: 'Amount Disputed' },
    { key: 'transaction_amount', header: 'Transaction Amount' },
    { key: 'status', header: 'Status' },
    { key: 'reason', header: 'Reason' },
    { key: 'evidence_note', header: 'Evidence Note' },
    { key: 'resolution_note', header: 'Resolution Note' },
    { key: 'opened_by_username', header: 'Opened By' },
    { key: 'resolved_at', header: 'Resolved' },
  ]);

  audit({ req, userId: req.user.id, username: req.user.username, action: 'disputes.export', outcome: 'success', details: { rowCount: disputes.length, status: req.query.status } });

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="disputes-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send(csv);
}));

// GET /api/disputes/financial-summary - admin rollup: total exposure,
// amount won back vs. lost to chargeback, win rate over resolved cases.
// Registered before /:id so "financial-summary" isn't swallowed as an id.
router.get('/financial-summary', authMiddleware, adminMiddleware, asyncHandler(async (req, res) => {
  const summary = await disputeRepository.financialSummary();
  res.json(summary);
}));

// GET /api/disputes/:id - view one case.
router.get('/:id', authMiddleware, validate({ params: disputeSchemas.idParam }), asyncHandler(async (req, res) => {
  const dispute = await disputeRepository.findById(req.params.id);
  if (!dispute) throw AppError.notFound('Dispute not found');
  if (req.user.role !== 'admin' && dispute.transaction_user_id !== req.user.id) throw AppError.forbidden('Not authorized');
  res.json({ dispute });
}));

// PATCH /api/disputes/:id - advance the lifecycle (admin only — see
// module header). Body: { status: 'evidence_submitted'|'won'|'lost', note? }.
router.patch('/:id', authMiddleware, adminMiddleware, validate({ params: disputeSchemas.idParam, body: disputeSchemas.transitionBody }), asyncHandler(async (req, res) => {
  try {
    const beforeDispute = await disputeRepository.findById(req.params.id);
    const ifMatch = /^"?(\d+)"?$/.exec(req.headers['if-match'] || '');
    const dispute = await disputeRepository.transition(
      req.params.id,
      { ...req.body, expectedVersion: req.body.version ?? (ifMatch ? Number(ifMatch[1]) : undefined) },
      req.user.id
    );
    if (!dispute) throw AppError.notFound('Dispute not found');

    audit({
      req, userId: req.user.id, username: req.user.username,
      action: 'disputes.transition', targetType: 'dispute', targetId: dispute.id, outcome: 'success',
      details: { transaction_id: dispute.transaction_id, before: { status: beforeDispute?.status ?? null, version: beforeDispute?.version ?? null }, after: { status: dispute.status, version: dispute.version }, new_status: req.body.status, hasNote: Boolean(req.body.note) },
    });

    res.json({ message: 'Dispute updated', dispute });
  } catch (err) {
    if (err.code === 'INVALID_TRANSITION') throw AppError.badRequest(err.message);
    if (err.code === 'VERSION_CONFLICT') {
      const conflict = AppError.conflict(err.message);
      conflict.details = { code: 'VERSION_CONFLICT', current: err.current };
      throw conflict;
    }
    throw err;
  }
}));

module.exports = router;
