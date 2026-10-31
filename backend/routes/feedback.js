/** Fraud feedback & controlled retraining (admin). See models/labelFeedbackRepository.js and services/retrainingService.js. */
const express = require('express');
const router = express.Router();
const labels = require('../models/labelFeedbackRepository');
const retraining = require('../services/retrainingService');
const { authMiddleware, adminMiddleware } = require('../middleware/auth');
const { AppError, asyncHandler } = require('../middleware/errorHandler');
const { validate } = require('../middleware/validate');
const schemas = require('../schemas/feedbackSchemas');
const { audit } = require('../middleware/auditLog');

router.use(authMiddleware, adminMiddleware);

const STATUS = { NOT_FOUND: 404, INVALID: 400, SYNTHETIC: 422 };
function wrap(fn) {
  return asyncHandler(async (req, res) => {
    try { await fn(req, res); } catch (e) {
      if (e instanceof labels.FeedbackError || e instanceof retraining.RetrainError) {
        const status = STATUS[e.code] || (['NOT_ENOUGH_LABELS', 'DATASET_TOO_SMALL'].includes(e.code) ? 422 : 409);
        const err = new AppError(e.message, status); err.details = { code: e.code, ...e.extra }; throw err;
      }
      throw e;
    }
  });
}
const act = (req) => ({ id: req.user.id, username: req.user.username });
const log = (req, action, targetType, targetId, details) => audit({ req, userId: req.user.id, username: req.user.username, action, targetType, targetId, outcome: 'success', details });

// ---- labels ----
router.get('/labels', validate({ query: schemas.listQuery }), wrap(async (req, res) => res.json({ ...(await labels.list(req.query)), counts: await labels.counts() })));
router.get('/labels/:id/events', validate({ params: schemas.idParams }), wrap(async (req, res) => res.json({ events: await labels.events(req.params.id) })));
router.post('/labels', validate({ body: schemas.proposeBody }), wrap(async (req, res) => {
  const l = await labels.propose({ transactionId: req.body.transaction_id, label: req.body.label, evidence: req.body.evidence_note, actor: act(req) });
  log(req, 'feedback.label_proposed', 'transaction', l.transaction_id, { label: l.label, label_id: l.id });
  res.status(201).json({ label: l });
}));
router.post('/labels/import-outcomes', wrap(async (req, res) => {
  const r = await labels.importFromOutcomes(act(req));
  log(req, 'feedback.import_outcomes', 'label_feedback', null, r);
  res.json({ ...r, note: 'Imported labels are only PROPOSED; a different investigator must verify each before it can be used for training.' });
}));
for (const [name, fn] of [['verify', labels.verify], ['reject', labels.reject], ['withdraw', labels.withdraw]]) {
  router.post(`/labels/:id/${name}`, validate({ params: schemas.idParams, body: schemas.decisionBody }), wrap(async (req, res) => {
    const l = await fn(req.params.id, { actor: act(req), note: req.body.note });
    log(req, `feedback.label_${name}`, 'label_feedback', l.id, { label: l.label, transaction_id: l.transaction_id });
    res.json({ label: l });
  }));
}

// ---- retraining ----
router.get('/retraining/readiness', wrap(async (req, res) => res.json(await retraining.readiness())));
router.get('/retraining/datasets', wrap(async (req, res) => res.json({ datasets: await retraining.listDatasets() })));
router.get('/retraining/datasets/:id', validate({ params: schemas.idParams }), wrap(async (req, res) => {
  const d = await retraining.getDataset(req.params.id);
  if (!d) throw AppError.notFound('Dataset not found');
  res.json({ dataset: d });
}));
router.get('/retraining/datasets/:id/download', validate({ params: schemas.idParams }), wrap(async (req, res) => {
  const d = await retraining.getDataset(req.params.id, { withCsv: true });
  if (!d) throw AppError.notFound('Dataset not found');
  log(req, 'feedback.dataset_download', 'retraining_dataset', d.id, { sha256: d.content_sha256 });
  res.set('Content-Type', 'text/csv; charset=utf-8').set('Content-Disposition', `attachment; filename="fraudguard-labels-${d.id}.csv"`).set('X-Content-SHA256', d.content_sha256).send(d.csv);
}));
router.post('/retraining/datasets', validate({ body: schemas.datasetBody }), wrap(async (req, res) => {
  const d = await retraining.buildDataset({ actor: act(req), note: req.body.note, presumedPerLabel: req.body.presumed_negatives_per_label, maturityDays: req.body.maturity_days });
  log(req, 'feedback.dataset_built', 'retraining_dataset', d.id, { sha256: d.content_sha256, composition: d.composition });
  res.status(201).json({ dataset: d });
}));
router.get('/retraining/runs', wrap(async (req, res) => res.json({ runs: await retraining.listRuns() })));
router.get('/retraining/runs/:id', validate({ params: schemas.idParams }), wrap(async (req, res) => {
  const run = await retraining.refreshRun(req.params.id);
  if (!run) throw AppError.notFound('Run not found');
  res.json({ run, ...(run.status === 'candidate_ready' ? { next_step: retraining.NEXT_STEP } : {}) });
}));
router.post('/retraining/runs', validate({ body: schemas.runBody }), wrap(async (req, res) => {
  const run = await retraining.requestRun({ datasetId: req.body.dataset_id, note: req.body.note, actor: act(req) });
  log(req, 'feedback.retrain_requested', 'retraining_run', run.id, { dataset_id: run.dataset_id });
  res.status(201).json({ run });
}));
for (const [name, fn] of [['approve', retraining.approveRun], ['reject', retraining.rejectRun], ['cancel', retraining.cancelRun]]) {
  router.post(`/retraining/runs/:id/${name}`, validate({ params: schemas.idParams, body: schemas.decisionBody }), wrap(async (req, res) => {
    const run = await fn(req.params.id, act(req), req.body.note);
    log(req, `feedback.retrain_${name}`, 'retraining_run', run.id, { note: req.body.note });
    res.json({ run });
  }));
}
router.post('/retraining/runs/:id/start', validate({ params: schemas.idParams }), wrap(async (req, res) => {
  const run = await retraining.startRun(req.params.id, act(req));
  log(req, 'feedback.retrain_started', 'retraining_run', run.id, { status: run.status });
  res.status(202).json({ run, note: 'Training runs in the ML service and produces a CANDIDATE only. Poll GET /retraining/runs/:id.' });
}));

module.exports = router;
