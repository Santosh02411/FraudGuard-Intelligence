/**
 * Atomic persistence of a scored transaction
 * ============================================
 * Scoring (ML call, rules) is slow and has no side effects, so it happens
 * BEFORE this module is called. Everything that must be all-or-nothing is
 * done here in ONE database transaction:
 *
 *   1. the transaction row, with its fraud decision
 *   2. its alert (exactly one per transaction — unique index + insertOnce)
 *   3. the step-up challenge, when the transaction is held
 *   4. the real-time events describing 1-3 (transactional outbox)
 *   5. the idempotency record carrying the response to replay
 *
 * If any step fails the whole thing rolls back: there is never a
 * transaction without its decision, an alert for a transaction that
 * doesn't exist, a hold with no challenge, an event for a change that
 * didn't commit, or an idempotency key marked complete for work that
 * didn't happen. Only after the commit does the caller publish the events
 * and fire webhooks (slow, best-effort, and safe to retry from the log).
 */

const db = require('../config/database');
const transactionRepository = require('../models/transactionRepository');
const alertRepository = require('../models/alertRepository');
const stepUpRepository = require('../models/stepUpRepository');
const idempotencyRepository = require('../models/idempotencyRepository');
const realtimeEvents = require('../models/realtimeEventRepository');
const decisionRepository = require('../models/decisionRepository');

/**
 * @param {object} p
 * @param {object} p.txn                 fields for transactionRepository.insert
 * @param {object} [p.alert]             { message, risk_level, username } — omit for low risk
 * @param {boolean} [p.requiresStepUp]
 * @param {number} [p.idempotencyRowId]  completes this key in the SAME transaction
 * @param {function} [p.buildEvents]     ({ newTxn, newAlert, alertCreated }) => event specs
 * @param {object} [p.decision]         decision spec (services/decisionSnapshot.buildDecisionSpec): appended as seq 1 of the
 *                                       append-only decision history in this same transaction
 * @param {function} p.buildResponse     ({ newTxn, newAlert, stepUpChallenge }) => { status, body }
 */
async function persistScoredTransaction({ txn, alert, requiresStepUp = false, challengeOptions = {}, idempotencyRowId, buildEvents, buildResponse, decision }) {
  return db.transaction(async () => {
    const { lastInsertRowid: txnId } = await transactionRepository.insert(txn);

    if (decision) await decisionRepository.append(txnId, decision);

    let newAlert = null;
    let alertCreated = false;
    if (alert) {
      const { alert: row, created } = await alertRepository.insertOnce({
        transaction_id: txnId, user_id: txn.user_id, message: alert.message, risk_level: alert.risk_level, amount: txn.amount,
      });
      alertCreated = created;
      newAlert = {
        ...row,
        merchant: txn.merchant,
        amount: txn.amount,
        ...(alert.username ? { username: alert.username } : {}),
      };
    }

    let stepUpChallenge = null;
    if (requiresStepUp) stepUpChallenge = await stepUpRepository.createChallenge({ transactionId: txnId, ...challengeOptions });

    const newTxn = await transactionRepository.findById(txnId);

    const events = buildEvents ? await realtimeEvents.append(buildEvents({ newTxn, newAlert, alertCreated })) : [];

    const response = buildResponse({ newTxn, newAlert, stepUpChallenge });
    if (idempotencyRowId) {
      await idempotencyRepository.complete(idempotencyRowId, response.status, JSON.stringify(response.body));
    }
    return { newTxn, newAlert, alertCreated, stepUpChallenge, events, response };
  });
}

module.exports = { persistScoredTransaction };
