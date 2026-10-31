const express = require('express');
const config = require('../config/env');
const router = express.Router();
const userRepository = require('../models/userRepository');
const transactionRepository = require('../models/transactionRepository');
const alertRepository = require('../models/alertRepository');
const { authMiddleware, adminMiddleware } = require('../middleware/auth');
const { AppError, asyncHandler } = require('../middleware/errorHandler');
const { validate } = require('../middleware/validate');
const adminSchemas = require('../schemas/adminSchemas');
const simulator = require('../realtime/simulator');
const auditLogRepository = require('../models/auditLogRepository');
const refreshTokenRepository = require('../models/refreshTokenRepository');
const { audit } = require('../middleware/auditLog');
const { paginationMeta } = require('../schemas/paginationSchema');
const csvService = require('../services/csvService');
const networkRepository = require('../models/networkRepository');
const mlAdminClient = require('../services/mlAdminClient');
const fraudRuleRepository = require('../models/fraudRuleRepository');
const riskPolicyRepository = require('../models/riskPolicyRepository');
const riskPolicyAnalytics = require('../services/riskPolicyAnalytics');
const sarReportService = require('../services/sarReportService');
const modelGovernance = require('../services/modelGovernanceService');
const modelChangeRepository = require('../models/modelChangeRepository');
const modelHealthService = require('../services/modelHealthService');
const modelEvaluationService = require('../services/modelEvaluationService');
const modelPerformance = require('../services/modelPerformanceService');

// All admin routes require auth + admin role
router.use(authMiddleware, adminMiddleware);

// GET /api/admin/users
router.get('/users', asyncHandler(async (req, res) => {
  const users = await userRepository.listWithStats();
  res.json({ users });
}));

// PATCH /api/admin/users/:id/role
router.patch(
  '/users/:id/role',
  validate({ params: adminSchemas.updateRoleParams, body: adminSchemas.updateRoleBody }),
  asyncHandler(async (req, res) => {
    const { role } = req.body;
    const { id } = req.params;

    if (id === req.user.id && role === 'user') {
      throw AppError.badRequest('Cannot demote yourself');
    }

    const user = await userRepository.findById(id);
    if (!user) throw AppError.notFound('User not found');

    await userRepository.updateRole(id, role);
    // A role change invalidates trust in that account's existing
    // sessions (e.g. a demoted admin shouldn't keep admin-level access
    // via a refresh token minted before the demotion) — force
    // re-authentication everywhere it's logged in.
    await refreshTokenRepository.revokeAllForUser(id);

    audit({
      req, userId: req.user.id, username: req.user.username,
      action: 'admin.role_change', targetType: 'user', targetId: Number(id), outcome: 'success',
      details: { targetUsername: user.username, oldRole: user.role, newRole: role },
    });

    res.json({ message: `User role updated to ${role}` });
  })
);

// GET /api/admin/stats
router.get('/stats', asyncHandler(async (req, res) => {
  const [userCount, txnStats, alertCount] = await Promise.all([
    userRepository.count(),
    transactionRepository.adminSummary(),
    alertRepository.countUnresolved(),
  ]);

  const total = Number(txnStats.total) || 0;
  const fraudCount = Number(txnStats.fraud_count) || 0;
  const fraud_rate = total > 0 ? parseFloat(((fraudCount / total) * 100).toFixed(2)) : 0;

  res.json({
    total_users: userCount,
    total_transactions: total,
    active_alerts: alertCount,
    system_fraud_rate: fraud_rate,
  });
}));

// --- Live transaction feed simulation (realtime/simulator.js) ---
// Demo feature: generates synthetic transactions on an interval, scored
// by the real fraud engine, broadcast to every connected client's Live
// Feed view over the 'simulation-feed' socket room. Admin-only to
// start/stop since it writes synthetic rows attributed to real demo
// accounts; GET /status is safe for any authenticated caller to poll,
// though the socket 'simulation:status' event makes that unnecessary
// for the frontend.

// POST /api/admin/simulation/start
router.post('/simulation/start', validate({ body: adminSchemas.simulationStart }), asyncHandler(async (req, res) => {
  try {
    const status = simulator.start({ ...req.body, startedBy: req.user.username });
    res.json({ message: 'Simulation started', status });
  } catch (err) {
    if (err.code === 'ALREADY_RUNNING') throw AppError.conflict(err.message);
    throw err;
  }
}));

// POST /api/admin/simulation/stop
router.post('/simulation/stop', asyncHandler(async (req, res) => {
  try {
    const status = simulator.stop();
    res.json({ message: 'Simulation stopped', status });
  } catch (err) {
    if (err.code === 'NOT_RUNNING') throw AppError.conflict(err.message);
    throw err;
  }
}));

// GET /api/admin/simulation/status
router.get('/simulation/status', asyncHandler(async (req, res) => {
  res.json({ status: simulator.getStatus() });
}));

// --- Audit trail (feature: who viewed/resolved which alert and when;
// RBAC decisions logged) ---

// GET /api/admin/audit-logs?page=&limit=&action=&targetType=&targetId=&userId=
router.get('/audit-logs', validate({ query: adminSchemas.auditLogQuery }), asyncHandler(async (req, res) => {
  const { page, limit, action, targetType, targetId, userId } = req.query;
  const { rows: logs, total } = await auditLogRepository.list({ page, limit, action, targetType, targetId, userId });
  res.json({ logs, pagination: paginationMeta({ page, limit, total }) });
}));

// GET /api/admin/audit-logs/export?<same filters, no page/limit>
// CSV export (feature: CSV export) — the audit trail is the one export
// source with no per-user ownership scoping to worry about (this whole
// router is admin-only already, via router.use above).
const AUDIT_EXPORT_ROW_CAP = 10000;
router.get('/audit-logs/export', validate({ query: adminSchemas.auditLogExportQuery }), asyncHandler(async (req, res) => {
  const { action, targetType, targetId, userId } = req.query;
  const { rows: logs } = await auditLogRepository.list({ page: 1, limit: AUDIT_EXPORT_ROW_CAP, action, targetType, targetId, userId });

  const csv = csvService.toCsv(logs, [
    { key: 'id', header: 'ID' },
    { key: 'created_at', header: 'Date' },
    { key: 'username', header: 'User' },
    { key: 'action', header: 'Action' },
    { key: 'target_type', header: 'Target Type' },
    { key: 'target_id', header: 'Target ID' },
    { key: 'outcome', header: 'Outcome' },
    { key: 'ip_address', header: 'IP Address' },
  ]);

  audit({ req, userId: req.user.id, username: req.user.username, action: 'admin.audit_logs_export', outcome: 'success', details: { rowCount: logs.length, filters: req.query } });

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="audit-logs-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send(csv);
}));

// GET /api/admin/audit-logs/alert/:id — full "who viewed/resolved this
// alert, and when" history for one specific alert.
router.get('/audit-logs/alert/:id', validate({ params: adminSchemas.idParam }), asyncHandler(async (req, res) => {
  const logs = await auditLogRepository.forTarget('alert', req.params.id);
  res.json({ logs });
}));


// ---------------------------------------------------------------------
// Risk policy (feature: configurable, versioned thresholds + measurement).
// The model outputs a calibrated PROBABILITY; where "review" and "high"
// start is a business POLICY, set here, versioned, audited — and
// measurable against analyst verdicts before and after a change.
// See models/riskPolicyRepository.js and services/riskPolicyAnalytics.js.
// ---------------------------------------------------------------------

function assertValidThresholds(body) {
  const problems = riskPolicyRepository.validateThresholds(body.medium_threshold, body.high_threshold);
  if (problems.length) throw AppError.badRequest('Invalid risk thresholds', problems);
}

// GET /api/admin/risk-policy — the policy in force, its history, the guard
// rails, and what a score means.
router.get('/risk-policy', asyncHandler(async (req, res) => {
  const [active, history] = await Promise.all([riskPolicyRepository.getActive(), riskPolicyRepository.history(20)]);
  res.json({
    active,
    history,
    defaults: riskPolicyRepository.DEFAULT_POLICY,
    limits: riskPolicyRepository.LIMITS,
    score_meaning: 'A score is the ML model\'s calibrated probability of fraud x 100 (a score of 80 = about 80 in 100 similar transactions were fraud in validation data). '
      + 'Risk levels are a policy applied to that probability: score >= medium_threshold is sent to review, >= high_threshold is treated as fraud. Hard-rule overrides bypass the model and are measured separately.',
  });
}));

// PUT /api/admin/risk-policy — save new thresholds as a NEW VERSION (history
// is append-only). Takes effect on the next transaction scored. A change
// note is mandatory and, with before/after values, goes in the audit log.
router.put('/risk-policy', requireProposalPath, validate({ body: adminSchemas.riskPolicyBody }), asyncHandler(async (req, res) => {
  assertValidThresholds(req.body);
  const previous = await riskPolicyRepository.getActive();
  const capacity = req.body.review_capacity_per_day ?? null;
  if (previous.medium_threshold === req.body.medium_threshold
    && previous.high_threshold === req.body.high_threshold
    && previous.review_capacity_per_day === capacity) {
    throw AppError.badRequest('These settings are identical to the policy already in force');
  }
  const policy = await riskPolicyRepository.create({ ...req.body, review_capacity_per_day: capacity, createdBy: req.user.id });

  audit({
    req, userId: req.user.id, username: req.user.username,
    action: 'risk_policy.update', targetType: 'risk_policy', targetId: policy.version, outcome: 'success',
    details: {
      previous: { version: previous.version, medium: previous.medium_threshold, high: previous.high_threshold, capacity: previous.review_capacity_per_day },
      new: { version: policy.version, medium: policy.medium_threshold, high: policy.high_threshold, capacity: policy.review_capacity_per_day },
      note: req.body.note,
    },
  });

  res.json({ message: 'Risk policy updated', policy, previous });
}));

// POST /api/admin/risk-policy/simulate — dry-run candidate thresholds against
// reviewed history: how much fraud would be missed, how many legitimate
// transactions flagged, how much review volume. Changes nothing.
router.post('/risk-policy/simulate', validate({ body: adminSchemas.riskPolicySimulateBody }), asyncHandler(async (req, res) => {
  assertValidThresholds(req.body);
  const active = await riskPolicyRepository.getActive();
  res.json(await riskPolicyAnalytics.simulate(req.body, active));
}));

// GET /api/admin/risk-policy/calibration — does a score still mean what it
// claims? Predicted vs observed fraud rate per score bucket from analyst
// verdicts, plus the hard-rule overrides evaluated on their own.
router.get('/risk-policy/calibration', validate({ query: adminSchemas.riskPolicyWindowQuery }), asyncHandler(async (req, res) => {
  const active = await riskPolicyRepository.getActive();
  res.json(await riskPolicyAnalytics.calibrationReport({ days: req.query.days }, active));
}));

// GET /api/admin/alerts/:id/sar-report?format=pdf|csv (feature: SAR-style
// exportable reports) — see services/sarReportService.js for exactly
// what this is and, importantly, what it is NOT (a completed regulatory
// filing). Combines the transaction, why it was flagged, its network/
// dispute status, and its full audit trail into one compliance-ready
// document.
router.get('/alerts/:id/sar-report', validate({ params: adminSchemas.idParam, query: adminSchemas.sarReportQuery }), asyncHandler(async (req, res) => {
  const caseData = await sarReportService.buildCaseData(req.params.id);
  if (!caseData) throw AppError.notFound('Alert not found');

  audit({
    req, userId: req.user.id, username: req.user.username,
    action: 'compliance.sar_export', targetType: 'alert', targetId: caseData.alert_id, outcome: 'success',
    details: { format: req.query.format },
  });

  const filenameBase = `sar-report-alert-${caseData.alert_id}`;
  if (req.query.format === 'csv') {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filenameBase}.csv"`);
    return res.send(sarReportService.toCsv(caseData));
  }

  const pdfBuffer = await sarReportService.toPdfBuffer(caseData);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${filenameBase}.pdf"`);
  res.send(pdfBuffer);
}));

// --- Model performance & outcome feedback center ---
// GET /api/admin/model-performance?days=&maturity_days=&format=json|csv
// Predictions vs confirmed outcomes: precision / recall / FPR / PR-AUC over
// time, by risk band / category / merchant / cohort, by model version, plus
// the unreviewed-prediction backlog. See services/modelPerformanceService.js
// for exactly what each label source can and cannot tell us.
router.get('/model-performance', validate({ query: adminSchemas.modelPerformanceQuery }), asyncHandler(async (req, res) => {
  const { days, maturity_days: maturityDays, format } = req.query;
  const rep = await modelPerformance.report({ days, maturityDays });
  if (format === 'csv') {
    audit({ req, userId: req.user.id, username: req.user.username, action: 'model_performance.export', outcome: 'success', details: { days, maturityDays, format } });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="model-performance-${new Date().toISOString().slice(0, 10)}.csv"`);
    return res.send(csvService.toCsv(modelPerformance.toRows(rep), modelPerformance.CSV_COLUMNS));
  }
  if (req.query.download === '1') res.setHeader('Content-Disposition', 'attachment; filename="model-performance.json"');
  return res.json(rep);
}));

// --- Fraud rings (feature: network/graph-based fraud ring detection —
// models/networkRepository.js) ---

// GET /api/admin/fraud-rings — every cluster of >= 2 accounts linked by
// a shared device fingerprint or IP address, with a risk verdict
// ('high' = includes a confirmed-fraud account, 'watch' = unusually
// large cluster with none confirmed yet, 'low' = small overlap).
router.get('/fraud-rings', asyncHandler(async (req, res) => {
  const rings = await networkRepository.detectRings({ minSize: 2 });
  res.json({ rings });
}));

// --- ML model monitoring & shadow/canary deployment (proxied to
// ml_service — see services/mlAdminClient.js) ---

// GET /api/admin/ml/drift — feature distribution / score drift report
// for the currently-active model version (Population Stability Index
// per feature, plus a score-distribution comparison).
router.get('/ml/drift', asyncHandler(async (req, res) => {
  const drift = await mlAdminClient.getDrift();
  res.json(drift);
}));

// POST /api/admin/ml/drift/reset — clears the live-traffic buffer the
// drift report is computed from (e.g. right after promoting a new
// model, so drift is measured against fresh traffic, not the old
// model's).
router.post('/ml/drift/reset', asyncHandler(async (req, res) => {
  const result = await mlAdminClient.resetDrift();
  audit({ req, userId: req.user.id, username: req.user.username, action: 'ml.drift_reset', outcome: 'success' });
  res.json(result);
}));

// GET /api/admin/ml/versions — every version in the model registry.
router.get('/ml/versions', asyncHandler(async (req, res) => {
  const result = await mlAdminClient.listVersions();
  res.json(result);
}));

// GET /api/admin/ml/shadow/status — comparison stats between the
// primary (serving) model and a shadow/canary model scoring the same
// live traffic in parallel, without affecting any actual decision.
router.get('/ml/shadow/status', asyncHandler(async (req, res) => {
  const status = await mlAdminClient.getShadowStatus();
  res.json(status);
}));

// POST /api/admin/ml/shadow/set { version } — starts shadow-scoring a
// registry version alongside the active one.
router.post('/ml/shadow/set', validate({ body: adminSchemas.shadowSetBody }), asyncHandler(async (req, res) => {
  const result = await mlAdminClient.setShadow(req.body.version);
  audit({ req, userId: req.user.id, username: req.user.username, action: 'ml.shadow_set', outcome: 'success', details: { version: req.body.version } });
  res.json(result);
}));

// POST /api/admin/ml/shadow/clear — stops shadow-scoring.
router.post('/ml/shadow/clear', asyncHandler(async (req, res) => {
  const result = await mlAdminClient.clearShadow();
  audit({ req, userId: req.user.id, username: req.user.username, action: 'ml.shadow_clear', outcome: 'success' });
  res.json(result);
}));

// POST /api/admin/ml/shadow/promote — REMOVED as a promotion path. Shadow-score
// agreement is not evidence of accuracy; promotion needs the change workflow below.
router.post('/ml/shadow/promote', asyncHandler(async (req, res) => {
  res.status(410).json({
    error: 'Direct shadow promotion is disabled. Request the change through POST /api/admin/ml/change-requests '
      + '(gates, labelled comparison with the incumbent, a second admin\'s approval).',
    code: 'USE_CHANGE_WORKFLOW',
  });
}));

// --- Model change workflow (promotion & rollback with approval) ---

// GET /api/admin/ml/change-requests/checklist — the checklists the requester must confirm.
router.get('/ml/change-requests/checklist', (req, res) => {
  res.json({ checklists: modelGovernance.CHECKLISTS });
});

// GET /api/admin/ml/change-requests — the promotion history (who/when/why/evidence), newest first.
router.get('/ml/change-requests', validate({ query: adminSchemas.modelChangeListQuery }), asyncHandler(async (req, res) => {
  res.json({ changes: await modelChangeRepository.list({ status: req.query.status, limit: req.query.limit }) });
}));

router.get('/ml/change-requests/:id', validate({ params: adminSchemas.modelChangeIdParams }), asyncHandler(async (req, res) => {
  const change = await modelChangeRepository.get(req.params.id);
  if (!change) throw AppError.notFound('Model change request not found');
  res.json({ change });
}));

// POST /api/admin/ml/change-requests — body { action, version, reason, checklist }.
// Runs the gates (the same-benchmark comparison can take a while); 422 GATES_BLOCK with the report when blocked.
router.post('/ml/change-requests', validate({ body: adminSchemas.modelChangeRequestBody }), asyncHandler(async (req, res) => {
  const change = await modelGovernance.requestChange({ ...req.body, user: req.user, req });
  res.status(201).json({ change });
}));

// POST /api/admin/ml/change-requests/:id/approve — a DIFFERENT admin; applies the change on success.
router.post('/ml/change-requests/:id/approve', validate({ params: adminSchemas.modelChangeIdParams, body: adminSchemas.modelChangeApproveBody }), asyncHandler(async (req, res) => {
  const change = await modelGovernance.approve({
    id: req.params.id, user: req.user, note: req.body.note, acknowledgedGates: req.body.acknowledged_gates,
    expectedVersion: req.body.version ?? (req.get('If-Match') ? Number(String(req.get('If-Match')).replace(/"/g, '')) : undefined), req,
  });
  res.json({ change });
}));

router.post('/ml/change-requests/:id/reject', validate({ params: adminSchemas.modelChangeIdParams, body: adminSchemas.modelChangeRejectBody }), asyncHandler(async (req, res) => {
  res.json({ change: await modelGovernance.reject({ id: req.params.id, user: req.user, note: req.body.note, expectedVersion: req.body.version, req }) });
}));

router.post('/ml/change-requests/:id/cancel', validate({ params: adminSchemas.modelChangeIdParams, body: adminSchemas.modelChangeCancelBody }), asyncHandler(async (req, res) => {
  res.json({ change: await modelGovernance.cancel({ id: req.params.id, user: req.user, note: req.body.note, req }) });
}));

// GET /api/admin/ml/gates/:version — a dry-run of the gates for a version (add ?compare=true for the labelled benchmark).
router.get('/ml/gates/:version', asyncHandler(async (req, res) => {
  if (!/^v\d+$/.test(req.params.version)) throw AppError.badRequest('version must look like "v4"');
  const { active } = await mlAdminClient.listVersions();
  res.json(await modelGovernance.buildGateReport(req.query.compare === 'false' ? 'rollback' : 'promote', req.params.version, active));
}));

// GET /api/admin/ml/outcome-evaluation/:version — challenger vs incumbent on analyst verdicts.
router.get('/ml/outcome-evaluation/:version', asyncHandler(async (req, res) => {
  if (!/^v\d+$/.test(req.params.version)) throw AppError.badRequest('version must look like "v4"');
  res.json(await modelEvaluationService.evaluateChallenger(req.params.version));
}));

// GET /api/admin/ml/health — rollback triggers for the serving model; POST evaluates now (and acts per MODEL_AUTO_ROLLBACK).
router.get('/ml/health', asyncHandler(async (req, res) => {
  res.json({ ...(await modelHealthService.evaluate()), recent_events: await modelHealthService.recentEvents(20) });
}));
router.post('/ml/health/evaluate', asyncHandler(async (req, res) => {
  res.json(await modelHealthService.run({ governance: modelGovernance }));
}));

// When RULE_CHANGES_REQUIRE_PROPOSAL=true, live rules/policy change only through the Rule Lab lifecycle
// (draft -> simulate -> approve -> activate), never by direct edit.
function requireProposalPath(req, res, next) {
  if (!config.ruleLifecycle.requireProposal) return next();
  const e = new AppError('Direct edits are disabled: propose this change in the Rule Lab (simulate, approve, activate).', 409);
  e.details = { code: 'PROPOSAL_REQUIRED', proposals_endpoint: '/api/v1/rule-proposals' };
  return next(e);
}

// --- Configurable fraud rules (feature: admin rule builder — see
// models/fraudRuleRepository.js, fraudEngine.js's checkHardRules) ---

// GET /api/admin/fraud-rules — every rule, enabled or not, newest edits
// visible via updated_by_username/updated_at.
router.get('/fraud-rules', asyncHandler(async (req, res) => {
  const rules = await fraudRuleRepository.listRules();
  res.json({ rules });
}));

// POST /api/admin/fraud-rules — add a new blacklist entry or amount cap.
// Takes effect on the very next transaction scored (routes/transactions.js
// re-reads getActiveRuleConfig() per request — no restart/deploy needed,
// which is the entire point of this feature over the old hardcoded
// HARD_RULES_CONFIG).
router.post('/fraud-rules', requireProposalPath, validate({ body: adminSchemas.fraudRuleCreateBody }), asyncHandler(async (req, res) => {
  const rule = await fraudRuleRepository.createRule({ ...req.body, createdBy: req.user.id });

  audit({
    req, userId: req.user.id, username: req.user.username,
    action: 'fraud_rules.create', targetType: 'fraud_rule', targetId: rule.id, outcome: 'success',
    details: { rule_type: rule.rule_type, after: { value: rule.value, threshold: rule.threshold, enabled: !!rule.enabled } },
  });

  res.status(201).json({ message: 'Rule created', rule });
}));

// POST /api/admin/fraud-rules/preview — feature: rule impact preview.
// Dry-runs a candidate rule (same body shape as create — rule_type plus
// value or threshold) against transactions already on file, WITHOUT
// creating it, so an admin can see how broad a new blacklist entry or a
// lower amount cap would actually be before turning it on. Registered
// before PATCH/DELETE .../:id below, but that's moot anyway since this
// is POST to a literal "preview" segment, never confusable with a
// numeric :id regardless of method.
router.post('/fraud-rules/preview', validate({ body: adminSchemas.fraudRuleCreateBody }), asyncHandler(async (req, res) => {
  const { matched_count, sample } = await fraudRuleRepository.previewImpact(req.body);
  res.json({ matched_count, sample });
}));

// PATCH /api/admin/fraud-rules/:id — edit or enable/disable a rule.
router.patch('/fraud-rules/:id', requireProposalPath, validate({ params: adminSchemas.idParam, body: adminSchemas.fraudRuleUpdateBody }), asyncHandler(async (req, res) => {
  const existing = await fraudRuleRepository.findById(req.params.id);
  if (!existing) throw AppError.notFound('Fraud rule not found');

  const rule = await fraudRuleRepository.updateRule(req.params.id, req.body, req.user.id);

  audit({
    req, userId: req.user.id, username: req.user.username,
    action: 'fraud_rules.update', targetType: 'fraud_rule', targetId: rule.id, outcome: 'success',
    details: { before: { value: existing.value, threshold: existing.threshold, enabled: !!existing.enabled }, after: { value: rule.value, threshold: rule.threshold, enabled: !!rule.enabled }, changes: req.body },
  });

  res.json({ message: 'Rule updated', rule });
}));

// DELETE /api/admin/fraud-rules/:id — permanently remove a rule (as
// opposed to PATCH { enabled: false }, which keeps it around, disabled,
// for re-enabling later — both are exposed since "turn it off" and
// "this was a mistake, remove it" are different admin intents worth
// distinguishing in the audit trail).
router.delete('/fraud-rules/:id', requireProposalPath, validate({ params: adminSchemas.idParam }), asyncHandler(async (req, res) => {
  const existing = await fraudRuleRepository.findById(req.params.id);
  if (!existing) throw AppError.notFound('Fraud rule not found');

  await fraudRuleRepository.deleteRule(req.params.id, req.user.id);

  audit({
    req, userId: req.user.id, username: req.user.username,
    action: 'fraud_rules.delete', targetType: 'fraud_rule', targetId: existing.id, outcome: 'success',
    details: { rule_type: existing.rule_type, before: { value: existing.value, threshold: existing.threshold, enabled: !!existing.enabled } },
  });

  res.json({ message: 'Rule deleted' });
}));

// ---------------------------------------------------------------------------
// Decision auditability: append-only decision history, rescoring, retention
// ---------------------------------------------------------------------------
const decisionRepository = require('../models/decisionRepository');
const rescoreService = require('../services/rescoreService');
const retentionService = require('../services/retentionService');
const db = require('../config/database');

// GET /api/admin/transactions/:id/decision-history — every decision ever made about the
// transaction (original first, never overwritten) merged with the investigator/admin
// actions on it, plus the hash-chain verdict.
router.get('/transactions/:id/decision-history', validate({ params: adminSchemas.idParam }), asyncHandler(async (req, res) => {
  const txn = await transactionRepository.findById(req.params.id);
  if (!txn) throw AppError.notFound('Transaction not found');
  await decisionRepository.ensureBaseline(txn);
  const decisions = await decisionRepository.list(txn.id);
  const chain = await decisionRepository.verifyChain(txn.id);

  const alertRow = await db.get('SELECT id FROM alerts WHERE transaction_id = ?', [txn.id]);
  const disputeRow = await db.get('SELECT id FROM disputes WHERE transaction_id = ?', [txn.id]);
  const clauses = ["(target_type = 'transaction' AND target_id = ?)"];
  const params = [txn.id];
  if (alertRow) { clauses.push("(target_type = 'alert' AND target_id = ?)"); params.push(alertRow.id); }
  if (disputeRow) { clauses.push("(target_type = 'dispute' AND target_id = ?)"); params.push(disputeRow.id); }
  const auditRows = await db.all(`SELECT * FROM audit_logs WHERE ${clauses.join(' OR ')} ORDER BY id ASC`, params);

  const timeline = [
    ...decisions.map((d) => ({ at: d.created_at, kind: 'decision', seq: d.seq, decision: d })),
    ...auditRows.map((a) => ({ at: decisionRepository.toIso(a.created_at), kind: 'audit', action: a.action, actor: a.username, outcome: a.outcome, details: JSON.parse(a.details || '{}') })),
  ].sort((x, y) => String(x.at).localeCompare(String(y.at)));

  audit({ req, userId: req.user.id, username: req.user.username, action: 'decisions.history_view', targetType: 'transaction', targetId: txn.id, outcome: 'success' });
  res.json({
    transaction_id: txn.id,
    current: { is_fraud: !!txn.is_fraud, fraud_score: txn.fraud_score, risk_level: txn.risk_level, scoring_method: txn.scoring_method, model_version: txn.model_version },
    chain, holds: await retentionService.holds(txn.id), timeline,
  });
}));

// POST /api/admin/transactions/:id/rescore { reason, apply? } — appends a rescore record;
// the original decision is preserved either way.
router.post('/transactions/:id/rescore', validate({ params: adminSchemas.idParam, body: adminSchemas.rescoreBody }), asyncHandler(async (req, res) => {
  const result = await rescoreService.rescore({
    transactionId: Number(req.params.id), actor: { id: req.user.id, username: req.user.username }, reason: req.body.reason, apply: req.body.apply,
  });
  audit({
    req, userId: req.user.id, username: req.user.username, action: req.body.apply ? 'decisions.rescore_applied' : 'decisions.rescore_recorded',
    targetType: 'transaction', targetId: result.transaction_id, outcome: 'success',
    details: { reason: req.body.reason, recorded_seq: result.recorded_seq, before: result.before, after: result.after, changed: result.changed },
  });
  res.status(201).json(result);
}));

router.get('/transactions/:id/decision-history/verify', validate({ params: adminSchemas.idParam }), asyncHandler(async (req, res) => {
  res.json(await decisionRepository.verifyChain(Number(req.params.id)));
}));

// Legal holds: a held transaction's decision history and audit rows are never retention-deleted.
router.post('/transactions/:id/legal-holds', validate({ params: adminSchemas.idParam, body: adminSchemas.legalHoldBody }), asyncHandler(async (req, res) => {
  if (!(await transactionRepository.findById(req.params.id))) throw AppError.notFound('Transaction not found');
  const id = await retentionService.placeHold({ transactionId: Number(req.params.id), reason: req.body.reason, userId: req.user.id });
  audit({ req, userId: req.user.id, username: req.user.username, action: 'retention.hold_placed', targetType: 'transaction', targetId: Number(req.params.id), outcome: 'success', details: { hold_id: id, reason: req.body.reason } });
  res.status(201).json({ hold_id: id });
}));
router.delete('/transactions/:id/legal-holds/:holdId', validate({ params: adminSchemas.holdParams }), asyncHandler(async (req, res) => {
  const ok = await retentionService.releaseHold({ holdId: Number(req.params.holdId), userId: req.user.id });
  if (!ok) throw AppError.notFound('No active hold with that id');
  audit({ req, userId: req.user.id, username: req.user.username, action: 'retention.hold_released', targetType: 'transaction', targetId: Number(req.params.id), outcome: 'success', details: { hold_id: Number(req.params.holdId) } });
  res.json({ released: true });
}));

router.get('/retention', asyncHandler(async (req, res) => {
  res.json({ policy: retentionService.policy(), runs: await retentionService.history() });
}));
// Runs are dry by default; a real run needs dry_run:false AND a reason.
router.post('/retention/run', validate({ body: adminSchemas.retentionRunBody }), asyncHandler(async (req, res) => {
  if (!req.body.dry_run && !req.body.reason) throw AppError.badRequest('A reason is required for a real (non-dry) retention run');
  const out = await retentionService.run({ dryRun: req.body.dry_run, actor: req.user.username });
  audit({ req, userId: req.user.id, username: req.user.username, action: 'retention.run', outcome: 'success', details: { dry_run: req.body.dry_run, reason: req.body.reason, results: out.results } });
  res.json(out);
}));

module.exports = router;
