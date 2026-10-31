const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const transactionRepository = require('../models/transactionRepository');
const { flexibleAuth, requireScope } = require('../middleware/apiKeyAuth');
const { idempotency } = require('../middleware/idempotency');
const { AppError, asyncHandler } = require('../middleware/errorHandler');
const { validate } = require('../middleware/validate');
const { transactionLimiter } = require('../middleware/rateLimiters');
const transactionSchemas = require('../schemas/transactionSchemas');
const { pagination, paginationMeta } = require('../schemas/paginationSchema');
const { analyzeTransactionHybrid } = require('../models/fraudEngine');
const riskPolicyRepository = require('../models/riskPolicyRepository');
const { networkRiskForTransaction } = require('../models/networkRepository');
const fraudRuleRepository = require('../models/fraudRuleRepository');
const { publish: publishEvents } = require('../realtime/socketServer');
const { persistScoredTransaction } = require('../services/transactionPipeline');
const { buildDecisionSpec, publicAnalysis } = require('../services/decisionSnapshot');
const shadowScoreRepository = require('../models/shadowScoreRepository');
const config = require('../config/env');
const geoVelocity = require('../models/geoVelocity');
const logger = require('../config/logger');
const { audit } = require('../middleware/auditLog');
const webhookService = require('../services/webhookService');
const webhookRepository = require('../models/webhookRepository');
const stepUpRepository = require('../models/stepUpRepository');
const verificationService = require('../services/verificationService');
const inferenceLog = require('../services/inferenceLog');
const verificationPolicyRepository = require('../models/verificationPolicyRepository');
const { evaluate: evaluateVerification } = require('../models/verificationPolicy');
const csvService = require('../services/csvService');
const metrics = require('../middleware/metrics');

/**
 * Lightweight device fingerprint: hash of the User-Agent header. A
 * simplified stand-in for a real client-side fingerprinting library
 * (e.g. FingerprintJS) — see ml_service/README.md's caveat section.
 */
function fingerprintDevice(req) {
  const ua = req.headers['user-agent'] || 'unknown';
  return crypto.createHash('sha256').update(ua).digest('hex').slice(0, 16);
}

function clientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  return (forwarded ? forwarded.split(',')[0].trim() : req.socket.remoteAddress) || null;
}

// GET /api/transactions?page=&limit=&merchant=&category=&riskLevel=&dateFrom=&dateTo=&amountMin=&amountMax=
// Paginated + filterable transactions for the logged-in user (admin sees all).
// flexibleAuth: a merchant's backend can call this with an API key
// (X-API-Key) instead of a human's JWT session — see middleware/apiKeyAuth.js.
const listQuerySchema = pagination.merge(transactionSchemas.listQuery);
router.get('/', flexibleAuth, requireScope('transactions:read'), validate({ query: listQuerySchema }), asyncHandler(async (req, res) => {
  const { page, limit, ...filters } = req.query;
  const { rows: transactions, total } = req.user.role === 'admin'
    ? await transactionRepository.allWithUsername({ page, limit, ...filters })
    : await transactionRepository.forUser(req.user.id, { page, limit, ...filters });
  res.json({ transactions, pagination: paginationMeta({ page, limit, total }) });
}));

// Core "score, persist, alert, notify" pipeline shared by a single
// POST /api/transactions and the bulk import endpoint below — every
// side effect (alert creation, live feed, webhook dispatch, step-up
// eligibility) is identical either way; only the HTTP-level concerns
// (idempotency, per-row error isolation, response shape) differ
// between the two call sites.
async function scoreAndCreateTransaction(req, txnData) {
  // ---- Phase 1: score. Slow (ML call) and side-effect free, so it runs
  // OUTSIDE any database transaction.
  // Recent history + dynamic blacklist so the fraud engine can derive
  // velocity, spending deviation, geo-distance, repeat-retailer, and
  // device/IP novelty features (see ml_service/README.md).
  const [recentTxns, blacklist, ruleSet, policy] = await Promise.all([
    transactionRepository.recentForUser(req.user.id),
    transactionRepository.fraudDeviceAndIpBlacklist(),
    fraudRuleRepository.getActiveRuleSet(), // rules + the version/hash recorded with the decision
    riskPolicyRepository.getActive(), // admin-configurable thresholds, versioned
  ]);

  const enrichedTxnData = {
    ...txnData,
    device_fingerprint: fingerprintDevice(req),
    ip_address: clientIp(req),
  };

  // Network/graph fraud-ring signal (models/networkRepository.js) — does
  // this account's device/IP tie it into a cluster of other accounts,
  // and does that cluster reach a confirmed-fraud account (even through
  // an intermediary)? See fraudEngine.js's checkNetworkRisk for how this
  // is combined with the hard-rule/ML/rule-engine layers.
  const networkRisk = await networkRiskForTransaction(enrichedTxnData, req.user.id);

  const rawAnalysis = await analyzeTransactionHybrid(enrichedTxnData, recentTxns, blacklist, undefined, networkRisk, ruleSet.config, policy);

  // Geo-velocity (models/geoVelocity.js): city-level, uncertainty-adjusted, and capped at MEDIUM on its own.
  const prevLocated = geoVelocity.pickPrevious(recentTxns);
  const geo = geoVelocity.evaluate(prevLocated && { location: prevLocated.location, at: prevLocated.created_at }, { location: enrichedTxnData.location, at: Date.now() });
  const analysis = geoVelocity.applyToAnalysis(rawAnalysis, geo, config.geoVelocity.mode, policy);

  // Risk-based verification (models/verificationPolicy.js). With the policy in `off` mode (default) this is exactly the
  // legacy step-up hook: a medium-risk transaction is HELD only for accounts that integrated the callback (a webhook
  // subscribed to 'transaction.step_up_required' or '*'), because nobody else could ever resolve the hold. `advisory`
  // records what the policy would do without changing that; `enforce` applies the policy's approve/challenge/decline.
  const verificationPolicy = await verificationPolicyRepository.getActive();
  let hasChannel = false;
  if (analysis.risk_level !== 'low') {
    hasChannel = (await webhookRepository.forUserAndEvent(req.user.id, 'transaction.step_up_required')).length > 0;
  }
  const verification = evaluateVerification({ policy: verificationPolicy, level: analysis.risk_level, amount: enrichedTxnData.amount, hasChannel });
  const requiresStepUp = verification.effective === 'challenge';
  const declined = verification.effective === 'decline';

  const flagged = analysis.risk_level === 'high' || analysis.risk_level === 'medium';
  const alertSpec = flagged
    ? {
        risk_level: analysis.risk_level,
        username: req.user.username,
        message: `${analysis.risk_level === 'high' ? 'High risk' : 'Medium risk'} transaction detected at ${enrichedTxnData.merchant}. Amount: $${enrichedTxnData.amount.toFixed(2)}`,
      }
    : null;

  const buildBody = ({ newTxn, stepUpChallenge }) => ({
    transaction: newTxn,
    // Step-up contract (feature: step-up authentication): when present,
    // the calling merchant is expected to run their own OTP/3DS flow
    // out-of-band using `challenge.token` to correlate, then call
    // POST /api/transactions/:id/step-up/verify with the outcome. The
    // transaction stays in status 'pending_step_up' — NOT counted as
    // completed or fraudulent — until that call resolves it.
    step_up: stepUpChallenge && {
      required: true,
      transaction_id: newTxn.id,
      challenge_token: stepUpChallenge.challenge_token,
      method: stepUpChallenge.method,
      expires_at: stepUpChallenge.expires_at,
      verify_url: `/api/transactions/${newTxn.id}/step-up/verify`,
    },
    // Authorization stays with the integrator: this is a recommendation + a record, never a payment action.
    verification: {
      mode: verification.mode, recommended_action: verification.recommended, applied_action: verification.effective,
      enforced: verification.enforced, reason: verification.reason, policy_version: verificationPolicy.version,
      authorization: { performed: false, note: 'FraudGuard does not authorize or move payments; your payment system acts on this decision.' },
    },
    geo_velocity: { mode: config.geoVelocity.mode, ...geo },
    analysis: {
      is_fraud: analysis.is_fraud,
      fraud_score: analysis.fraud_score,
      risk_level: analysis.risk_level,
      fraud_reasons: analysis.fraud_reasons,
      scoring_method: analysis.scoring_method,
      model_used: analysis.model_used || null,
      model_version: analysis.model_version || null,
      hard_flag_triggered: analysis.hard_flag_triggered || null,
      shap_explanation: analysis.shap_explanation || [],
      message: declined
        ? '⛔ Declined by the risk-based verification policy.'
        : requiresStepUp
        ? '🔐 Additional verification required before this transaction can complete.'
        : analysis.is_fraud
        ? '🚨 Fraud detected! This transaction has been flagged.'
        : analysis.risk_level === 'medium'
        ? '⚠️ Suspicious transaction. Please review carefully.'
        : '✅ Transaction looks safe.',
    },
  });

  // ---- Phase 2: persist, atomically (services/transactionPipeline.js).
  // Transaction + decision + alert + step-up challenge + real-time events +
  // idempotency record commit together or not at all.
  const persisted = await persistScoredTransaction({
    txn: {
      user_id: req.user.id,
      ...enrichedTxnData,
      is_fraud: analysis.is_fraud,
      fraud_score: analysis.fraud_score,
      risk_level: analysis.risk_level,
      fraud_reasons: analysis.fraud_reasons,
      scoring_method: analysis.scoring_method,
      model_version: analysis.model_version,
      hard_flag_triggered: analysis.hard_flag_triggered,
      shap_explanation: analysis.shap_explanation,
      model_probability: analysis.model_probability,
      policy_version: analysis.policy_version,
      ml_latency_ms: analysis.ml_latency_ms,
      status: requiresStepUp ? 'pending_step_up' : declined ? 'blocked' : 'completed',
      verification_action: verification.recommended,
      verification_mode: verification.mode,
      verification_policy_version: verificationPolicy.version,
      verification_enforced: verification.enforced,
      verification_note: verification.reason,
      geo_velocity_status: config.geoVelocity.mode === 'off' ? null : geo.status,
      geo_distance_km: geo.effective_distance_km,
      geo_required_kmh: geo.required_kmh,
    },
    decision: buildDecisionSpec({ analysis, ruleSet, historyCount: recentTxns.length }),
    alert: alertSpec,
    requiresStepUp,
    challengeOptions: { ttlMs: verificationPolicy.ttl_seconds * 1000, policyVersion: verificationPolicy.version, riskLevel: analysis.risk_level, amount: enrichedTxnData.amount },
    idempotencyRowId: req.idempotencyRowId,
    buildEvents: ({ newTxn, newAlert, alertCreated }) => [
      { type: 'transaction:new', userId: req.user.id, riskLevel: newTxn.risk_level, payload: { transaction: newTxn, source: 'live' } },
      ...(alertCreated ? [{ type: 'alert:new', userId: req.user.id, riskLevel: newAlert.risk_level, payload: { alert: newAlert, source: 'live' } }] : []),
    ],
    buildResponse: (parts) => ({ status: 201, body: buildBody(parts) }),
  });
  if (req.idempotencyRowId) req.idempotencyCompletedInTx = true;

  const { newTxn, newAlert, stepUpChallenge } = persisted;

  // ---- Phase 3: after commit — best-effort side effects. None of these can
  // un-commit the transaction, and the events are already durable in the log.
  inferenceLog.record({ transactionId: newTxn.id, analysis, txn: enrichedTxnData });
  shadowScoreRepository.record(newTxn.id, analysis).catch((err) => logger.warn('Could not record shadow score', { error: err.message }));
  metrics.transactionsScoredTotal.inc({ risk_level: analysis.risk_level, scoring_method: analysis.scoring_method });
  if (persisted.alertCreated) metrics.alertsCreatedTotal.inc({ risk_level: analysis.risk_level });

  publishEvents(persisted.events);

  // Outbound webhooks (feature: webhook notifications) — fires on the
  // same medium/high-risk condition that creates an alert above, not a
  // separate threshold, so "you got an alert" and "your webhook fired"
  // always agree. Never awaited: a slow or broken receiving endpoint
  // must not add latency to this response — see services/webhookService.js.
  if (requiresStepUp) {
    webhookService.dispatch(req.user.id, 'transaction.step_up_required', {
      transaction: newTxn,
      analysis: publicAnalysis(analysis),
      challenge: { token: stepUpChallenge.challenge_token, method: stepUpChallenge.method, expires_at: stepUpChallenge.expires_at },
    });
  } else if (declined) {
    webhookService.dispatch(req.user.id, 'transaction.declined', { transaction: newTxn, analysis: publicAnalysis(analysis), policy_version: verificationPolicy.version });
  } else if (newAlert) {
    webhookService.dispatch(req.user.id, 'transaction.flagged', { transaction: newTxn, analysis: publicAnalysis(analysis) });
  }

  return persisted.response.body;
}

// POST /api/transactions - create new transaction
// idempotency: an optional `Idempotency-Key` header makes a retried
// POST safe — see middleware/idempotency.js. Placed after validate()
// so it hashes the coerced/normalized body, and after flexibleAuth so
// it has req.user to scope the key by.
router.post('/', flexibleAuth, requireScope('transactions:write'), transactionLimiter, validate({ body: transactionSchemas.create }), idempotency, asyncHandler(async (req, res) => {
  const { amount, merchant, category, location, card_type } = req.body;
  const result = await scoreAndCreateTransaction(req, { amount, merchant, category, location, card_type });

  // Traceability for the API-key integration surface specifically —
  // human/browser-session transaction creation isn't audited (it'd just
  // duplicate middleware/requestLogger.js's access log at high volume
  // for no extra signal), but a service credential creating a
  // transaction on an account's behalf is exactly the kind of "who/what
  // did this" question worth being able to answer later.
  if (req.authMethod === 'api_key') {
    audit({
      req, userId: req.user.id, username: req.user.username,
      action: 'transactions.create_via_api_key', targetType: 'transaction', targetId: result.transaction.id, outcome: 'success',
      details: { apiKeyId: req.apiKey.id, apiKeyName: req.apiKey.name },
    });
  }

  res.status(201).json(result);
}));

// POST /api/transactions/bulk - feature: bulk transaction import/batch
// scoring. Scores every row through the exact same pipeline as a single
// POST above — the same alerts, webhooks, live feed, and step-up
// eligibility — so a batch-imported transaction is never a
// second-class citizen next to one entered through the Simulator. A
// malformed row fails validation for the whole request before anything
// is created (see transactionSchemas.bulkCreate); a row that throws
// DURING scoring (rare — e.g. a transient error) is reported per-row
// instead of failing the rest of the batch. No idempotency support
// here — the key scheme is built around a single transaction body, not
// an array of them; retry a bulk request cautiously.
//
// Always audit-logged regardless of auth method (unlike the single-
// transaction endpoint above) — creating many transactions in one call
// is a more consequential action than one, worth a "who did this and
// how many" record even for a human, logged-in session.
router.post('/bulk', flexibleAuth, requireScope('transactions:write'), transactionLimiter, validate({ body: transactionSchemas.bulkCreate }), asyncHandler(async (req, res) => {
  const results = [];
  let completed = 0;
  let flagged = 0;
  let heldForStepUp = 0;
  let failed = 0;

  for (let i = 0; i < req.body.transactions.length; i += 1) {
    const { amount, merchant, category, location, card_type } = req.body.transactions[i];
    try {
      // eslint-disable-next-line no-await-in-loop -- each row must see
      // the effects (recent-history, blacklist) of the ones before it
      // in the same batch, so this can't be parallelized with Promise.all.
      const result = await scoreAndCreateTransaction(req, { amount, merchant, category, location, card_type });
      results.push({ index: i, ...result });
      completed += 1;
      if (result.step_up) heldForStepUp += 1;
      else if (result.analysis.risk_level !== 'low') flagged += 1;
    } catch (err) {
      results.push({ index: i, error: err.message || 'Failed to score this transaction' });
      failed += 1;
    }
  }

  audit({
    req, userId: req.user.id, username: req.user.username,
    action: 'transactions.bulk_create', outcome: failed === 0 ? 'success' : 'failure',
    details: {
      rowCount: req.body.transactions.length, completed, flagged, heldForStepUp, failed,
      ...(req.authMethod === 'api_key' ? { apiKeyId: req.apiKey.id, apiKeyName: req.apiKey.name } : {}),
    },
  });

  res.status(201).json({
    summary: { total: req.body.transactions.length, completed, flagged, held_for_step_up: heldForStepUp, failed },
    results,
  });
}));

// GET /api/transactions/stats - dashboard stats for logged-in user
router.get('/stats', flexibleAuth, requireScope('transactions:read'), asyncHandler(async (req, res) => {
  const stats = req.user.role === 'admin'
    ? await transactionRepository.statsGlobal()
    : await transactionRepository.statsForUser(req.user.id);

  const total = Number(stats.total) || 0;
  const fraudCount = Number(stats.fraud_count) || 0;
  const fraud_rate = total > 0 ? ((fraudCount / total) * 100).toFixed(2) : '0.00';

  res.json({
    total_transactions: total,
    fraud_count: fraudCount,
    fraud_rate: parseFloat(fraud_rate),
    total_amount: parseFloat((Number(stats.total_amount) || 0).toFixed(2)),
    avg_fraud_score: parseFloat((Number(stats.avg_fraud_score) || 0).toFixed(2)),
    medium_count: Number(stats.medium_count) || 0,
    declined_count: Number(stats.declined_count) || 0,
    held_count: Number(stats.held_count) || 0,
  });
}));

// GET /api/transactions/export?<same filters as GET />
// CSV export (feature: CSV export) — same filter/role scoping as the
// list endpoint, capped at EXPORT_ROW_CAP rows so one request can't
// pull the whole table into memory. Registered before /:id, or "export"
// itself would be swallowed as an :id path param.
const EXPORT_ROW_CAP = 10000;
router.get('/export', flexibleAuth, requireScope('transactions:read'), validate({ query: transactionSchemas.listQuery }), asyncHandler(async (req, res) => {
  const filters = req.query;
  const { rows: transactions } = req.user.role === 'admin'
    ? await transactionRepository.allWithUsername({ page: 1, limit: EXPORT_ROW_CAP, ...filters })
    : await transactionRepository.forUser(req.user.id, { page: 1, limit: EXPORT_ROW_CAP, ...filters });

  const csv = csvService.toCsv(transactions, [
    { key: 'id', header: 'ID' },
    { key: 'created_at', header: 'Date' },
    { key: 'username', header: 'User' }, // only populated for admin exports; blank cell otherwise
    { key: 'merchant', header: 'Merchant' },
    { key: 'category', header: 'Category' },
    { key: 'amount', header: 'Amount' },
    { key: 'card_type', header: 'Card Type' },
    { key: 'location', header: 'Location' },
    { key: 'risk_level', header: 'Risk Level' },
    { key: 'fraud_score', header: 'Fraud Score' },
    { key: 'scoring_method', header: 'Scoring Method' },
  ]);

  audit({ req, userId: req.user.id, username: req.user.username, action: 'transactions.export', outcome: 'success', details: { rowCount: transactions.length, filters } });

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="transactions-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send(csv);
}));

// GET /api/transactions/:id - view a single transaction's full record
// (including its SHAP explanation) — registered after /stats so that
// path isn't shadowed by this one matching "stats" as an :id. Audit-
// logged the same way alerts.view is, since this is the same kind of
// "who looked at this specific record" question an investigation might
// ask later.
router.get('/:id', flexibleAuth, requireScope('transactions:read'), validate({ params: transactionSchemas.idParam }), asyncHandler(async (req, res) => {
  const txn = await transactionRepository.findById(req.params.id);
  if (!txn) throw AppError.notFound('Transaction not found');
  if (req.user.role !== 'admin' && txn.user_id !== req.user.id) {
    throw AppError.forbidden('Not authorized');
  }

  audit({ req, userId: req.user.id, username: req.user.username, action: 'transactions.view', targetType: 'transaction', targetId: txn.id, outcome: 'success' });

  res.json({ transaction: txn });
}));

// --- Step-up authentication hook (feature: step-up authentication) ------
//
// Contract for an integrating merchant:
//   1. POST /api/transactions returns `step_up: { required: true,
//      challenge_token, method, expires_at, verify_url }` when a
//      medium-risk transaction is held. The transaction sits in
//      status 'pending_step_up' — not completed, not fraudulent — and a
//      'transaction.step_up_required' webhook fires with the same info.
//   2. The merchant runs ITS OWN OTP/3DS/step-up flow against the
//      customer, out of band. FraudGuard has no opinion on how — this
//      is a hold-and-notify contract, not an OTP provider.
//   3. The merchant calls back here with the outcome. This resolves the
//      hold: 'success' completes the transaction, 'failure' blocks it —
//      a failed step-up is itself a meaningful fraud signal, not just a
//      cancelled purchase.

// POST /api/transactions/:id/step-up/verify - resolve a pending challenge.
router.post('/:id/step-up/verify', flexibleAuth, requireScope('transactions:write'), validate({ params: transactionSchemas.idParam, body: transactionSchemas.stepUpVerifyBody }), asyncHandler(async (req, res) => {
  const txn = await transactionRepository.findById(req.params.id);
  if (!txn) throw AppError.notFound('Transaction not found');
  if (req.user.role !== 'admin' && txn.user_id !== req.user.id) throw AppError.forbidden('Not authorized');

  let challenge = await stepUpRepository.findByToken(req.body.challenge_token);
  if (!challenge || challenge.transaction_id !== txn.id) {
    throw AppError.notFound('No matching step-up challenge for this transaction/token');
  }
  challenge = await verificationService.expireIfDue(challenge);
  if (challenge.status !== 'pending') {
    // Replay / late callback: counted, logged, and never applied.
    await verificationService.recordReplay(challenge, { actor: req.user.username, outcome: req.body.outcome });
    audit({ req, userId: req.user.id, username: req.user.username, action: 'transactions.step_up_rejected', targetType: 'transaction', targetId: txn.id, outcome: 'failure',
      details: { challenge_id: challenge.id, challenge_status: challenge.status, attempted_outcome: req.body.outcome } });
    const e = AppError.conflict(`This challenge is already "${challenge.status}" and cannot be verified again`);
    e.details = { code: challenge.status === 'expired' ? 'CHALLENGE_EXPIRED' : 'CHALLENGE_REPLAY', challenge_status: challenge.status };
    throw e;
  }

  // Compare-and-set inside one database transaction (verificationService.resolve): of several simultaneous
  // callers (or the expiry sweep) only the one that moves the challenge out of 'pending' may also move the
  // transaction; the others get a 409 and change nothing.
  const resolved = await verificationService.resolve(challenge, req.body.outcome, { actor: req.user.username, reason: req.body.outcome === 'success' ? null : `reported ${req.body.outcome} by integrator` });
  if (!resolved) {
    await verificationService.recordReplay(await stepUpRepository.findById(challenge.id), { actor: req.user.username, outcome: req.body.outcome });
    const e = AppError.conflict('This challenge was already resolved by another request');
    e.details = { code: 'CHALLENGE_REPLAY' };
    throw e;
  }
  const newTxn = resolved.updated;

  webhookService.dispatch(req.user.id, verificationService.WEBHOOK_EVENT[resolved.status], { transaction: newTxn });

  audit({
    req, userId: req.user.id, username: req.user.username,
    action: 'transactions.step_up_verify', targetType: 'transaction', targetId: txn.id, outcome: 'success',
    details: { challenge_id: challenge.id, verify_outcome: req.body.outcome, challenge_status: resolved.status },
  });

  res.json({ transaction: newTxn, step_up_outcome: req.body.outcome, challenge_status: resolved.status });
}));

// GET /api/transactions/:id/step-up - poll the current challenge status
// (e.g. a merchant's own UI checking whether a customer finished the
// OTP flow in another tab).
router.get('/:id/step-up', flexibleAuth, requireScope('transactions:read'), validate({ params: transactionSchemas.idParam }), asyncHandler(async (req, res) => {
  const txn = await transactionRepository.findById(req.params.id);
  if (!txn) throw AppError.notFound('Transaction not found');
  if (req.user.role !== 'admin' && txn.user_id !== req.user.id) throw AppError.forbidden('Not authorized');

  let challenge = await stepUpRepository.findByTransactionId(txn.id);
  if (!challenge) throw AppError.notFound('This transaction has no step-up challenge');
  challenge = await verificationService.expireIfDue(challenge);
  const fresh = await transactionRepository.findById(txn.id);

  res.json({
    transaction_id: txn.id,
    transaction_status: fresh.status,
    challenge: {
      status: challenge.status,
      method: challenge.method,
      expires_at: challenge.expires_at,
      verified_at: challenge.verified_at,
      // Safe to return here even though POST .../verify doesn't require
      // this endpoint to have been called first: this route already
      // enforces the exact same ownership/admin check the resolve
      // endpoint does (see the authorization check above), so a caller
      // who can reach this can already reach that. Without this, a
      // transaction abandoned mid-flow (e.g. the Simulator tab closed
      // before the challenge was resolved) would be stuck in
      // pending_step_up forever — the token was otherwise only ever
      // shown once, at creation.
      challenge_token: challenge.status === 'pending' ? challenge.challenge_token : undefined,
    },
  });
}));

module.exports = router;
