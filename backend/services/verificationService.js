/**
 * Risk-based verification: challenge lifecycle, expiry, replay protection, effectiveness measurement.
 *
 * A challenge ends in exactly one of: verified (completed) | failed | abandoned | expired.
 * Every ending is ONE database transaction that (a) moves the challenge out of 'pending' with a
 * compare-and-set, (b) moves the held transaction out of 'pending_step_up' (completed on success,
 * blocked otherwise), (c) appends a verification event and the real-time event. Of any number of racing
 * resolvers (the customer's callback, a second callback, the expiry sweep) exactly one wins.
 *
 * FraudGuard records and recommends; the integrator's payment system authorizes. See models/verificationPolicy.js.
 */
const db = require('../config/database');
const config = require('../config/env');
const logger = require('../config/logger');
const transactionRepository = require('../models/transactionRepository');
const realtimeEvents = require('../models/realtimeEventRepository');
const { publish: publishEvents } = require('../realtime/socketServer');
const { wilson } = require('./modelPerformanceService');

const TARGET = { success: 'verified', failure: 'failed', abandoned: 'abandoned', expired: 'expired' };
const WEBHOOK_EVENT = { verified: 'transaction.step_up_verified', failed: 'transaction.step_up_failed', abandoned: 'transaction.step_up_abandoned', expired: 'transaction.step_up_expired' };
const nowIso = () => new Date().toISOString();
const r4 = (x) => (x === null || x === undefined || Number.isNaN(x) ? null : Math.round(x * 10000) / 10000);

async function addEvent(challengeId, transactionId, kind, actor, detail) {
  await db.run('INSERT INTO verification_events (challenge_id, transaction_id, kind, actor, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    [challengeId, transactionId, kind, actor || 'system', detail ? JSON.stringify(detail) : null, nowIso()]);
}

/**
 * Resolves a pending challenge. Returns null when another resolver got there first.
 * @param {'success'|'failure'|'abandoned'|'expired'} outcome
 */
async function resolve(challenge, outcome, { actor = 'system', reason = null } = {}) {
  const target = TARGET[outcome];
  const out = await db.transaction(async () => {
    const t = nowIso();
    const r = await db.run(
      `UPDATE step_up_challenges SET status = ?, resolved_at = ?, outcome_reason = ?${target === 'verified' ? ', verified_at = ?' : ''} WHERE id = ? AND status = 'pending'`,
      target === 'verified' ? [target, t, reason, t, challenge.id] : [target, t, reason, challenge.id]);
    if (r.changes === 0) return null;
    await transactionRepository.updateStatus(challenge.transaction_id, target === 'verified' ? 'completed' : 'blocked', { onlyFrom: 'pending_step_up' });
    const updated = await transactionRepository.findById(challenge.transaction_id);
    await addEvent(challenge.id, challenge.transaction_id, target, actor, { reason });
    const [event] = await realtimeEvents.append([{ type: 'transaction:new', userId: updated.user_id, riskLevel: updated.risk_level, payload: { transaction: updated, source: 'live' } }]);
    return { updated, event, status: target };
  });
  if (out) publishEvents([out.event]);
  return out;
}

/** Lazily resolves a due-but-pending challenge to 'expired' (and blocks the hold). Returns the fresh challenge row. */
async function expireIfDue(challenge) {
  if (challenge.status === 'pending' && new Date(challenge.expires_at).getTime() < Date.now()) {
    const res = await resolve(challenge, 'expired', { reason: 'ttl elapsed' });
    if (res) require('./webhookService').dispatch(res.updated.user_id, WEBHOOK_EVENT.expired, { transaction: res.updated });
    return db.get('SELECT * FROM step_up_challenges WHERE id = ?', [challenge.id]);
  }
  return challenge;
}

/** A verify call that hit a challenge that is no longer pending: counted and logged, never applied. */
async function recordReplay(challenge, { actor, outcome } = {}) {
  await db.run('UPDATE step_up_challenges SET replay_attempts = replay_attempts + 1 WHERE id = ?', [challenge.id]);
  await addEvent(challenge.id, challenge.transaction_id, 'replay_rejected', actor, { status_at_attempt: challenge.status, attempted_outcome: outcome });
}

/** Expires every due challenge. Safe to run from several instances: each resolution is compare-and-set. */
async function sweepExpired({ limit = 200 } = {}) {
  const due = await db.all("SELECT * FROM step_up_challenges WHERE status = 'pending' AND expires_at < ? ORDER BY expires_at LIMIT ?", [nowIso(), limit]);
  let expired = 0;
  for (const c of due) {
    try { const res = await resolve(c, 'expired', { reason: 'ttl elapsed (sweep)' });
      if (res) { expired += 1; require('./webhookService').dispatch(res.updated.user_id, WEBHOOK_EVENT.expired, { transaction: res.updated }); }
    } catch (err) { logger.warn('Verification sweep: could not expire a challenge', { challengeId: c.id, error: err.message }); }
  }
  return { examined: due.length, expired };
}

let timer = null;
function start() {
  if (timer || !config.verification.sweepIntervalMs) return;
  timer = setInterval(() => { sweepExpired().catch((e) => logger.error('Verification sweep failed', { error: e.message })); }, config.verification.sweepIntervalMs);
  timer.unref?.();
}
function stop() { if (timer) { clearInterval(timer); timer = null; } }

// ---------------------------------------------------------------- measurement

const dateFilter = (col) => (db.dialect === 'postgres' ? `${col}::timestamptz >= ?::timestamptz` : `${col} >= ?`);
const ms = (v) => { if (!v) return null; const s = v instanceof Date ? v.toISOString() : String(v); const t = new Date(s.includes('T') ? s : `${s.replace(' ', 'T')}Z`).getTime(); return Number.isFinite(t) ? t : null; };
const labelOf = (r) => (r.verdict === 'confirmed_fraud' || r.dispute_id ? 'fraud' : r.verdict === 'false_positive' ? 'legit' : 'unknown');
const pctile = (arr, p) => { if (!arr.length) return null; const a = [...arr].sort((x, y) => x - y); return a[Math.min(a.length - 1, Math.floor(p * a.length))]; };

async function loadRows(days, now) {
  const cutoff = new Date(now - days * 86400000).toISOString();
  return db.all(
    `SELECT t.id, t.amount, t.risk_level, t.status, t.verification_action, t.verification_mode, t.verification_enforced, t.verification_policy_version,
            c.id AS cid, c.status AS cstatus, c.created_at AS c_created, c.resolved_at, c.replay_attempts,
            a.id AS alert_id, a.verdict, d.id AS dispute_id
       FROM transactions t
       LEFT JOIN step_up_challenges c ON c.transaction_id = t.id
       LEFT JOIN alerts a ON a.transaction_id = t.id
       LEFT JOIN disputes d ON d.transaction_id = t.id
      WHERE t.is_synthetic = 0 AND ${dateFilter('t.created_at')}
      LIMIT 200000`, [cutoff]);
}

/**
 * Effect of challenges on fraud loss and on legitimate-user friction. OBSERVATIONAL: it compares groups that were
 * treated differently, not a randomized experiment, so differences can come from who was selected as well as from the challenge.
 */
async function effectiveness({ days = 30, now = Date.now() } = {}) {
  const rows = await loadRows(days, now);
  const challenged = rows.filter((r) => r.cid);
  const declined = rows.filter((r) => !r.cid && r.verification_action === 'decline' && Number(r.verification_enforced) === 1);
  const flaggedOnly = rows.filter((r) => !r.cid && !declined.includes(r) && r.risk_level !== 'low');

  const by = { verified: 0, failed: 0, abandoned: 0, expired: 0, pending: 0 };
  for (const r of challenged) by[r.cstatus] = (by[r.cstatus] || 0) + 1;
  const resolved = challenged.length - by.pending;
  const completeMs = challenged.filter((r) => r.cstatus === 'verified').map((r) => (ms(r.resolved_at) - ms(r.c_created)) / 1000).filter((x) => Number.isFinite(x) && x >= 0);

  const sumAmt = (arr) => Math.round(arr.reduce((a, r) => a + Number(r.amount), 0) * 100) / 100;
  const isNoCompletion = (r) => ['failed', 'abandoned', 'expired'].includes(r.cstatus);
  const fraudCh = challenged.filter((r) => labelOf(r) === 'fraud');
  const legitCh = challenged.filter((r) => labelOf(r) === 'legit');
  const unknownCh = challenged.filter((r) => labelOf(r) === 'unknown');
  const completedFraudAll = rows.filter((r) => r.status === 'completed' && labelOf(r) === 'fraud');

  const matrix = {};
  for (const r of challenged) { const k = r.cstatus; matrix[k] = matrix[k] || { fraud: 0, legit: 0, unknown: 0 }; matrix[k][labelOf(r)] += 1; }

  const group = (arr) => {
    const f = arr.filter((r) => labelOf(r) === 'fraud'); const l = arr.filter((r) => labelOf(r) === 'legit');
    return { count: arr.length, amount: sumAmt(arr), fraud: f.length, fraud_amount: sumAmt(f), legit_confirmed: l.length, unlabelled: arr.length - f.length - l.length };
  };
  const policyKey = (r) => `${r.verification_mode || 'none'}|${r.verification_action || 'none'}|v${r.verification_policy_version ?? '-'}`;
  const byPolicy = {};
  for (const r of rows.filter((x) => x.risk_level !== 'low' || x.cid)) (byPolicy[policyKey(r)] = byPolicy[policyKey(r)] || []).push(r);

  const [fLo, fHi] = wilson(by.failed, resolved);
  return {
    window_days: days, total_transactions: rows.length,
    challenges: {
      issued: challenged.length, ...by, resolved,
      completion_rate: resolved ? r4(by.verified / resolved) : null,
      abandonment_rate: resolved ? r4((by.abandoned + by.expired) / resolved) : null,
      failure_rate: resolved ? r4(by.failed / resolved) : null, failure_rate_ci: [fLo, fHi],
      median_seconds_to_complete: r4(pctile(completeMs, 0.5)), p90_seconds_to_complete: r4(pctile(completeMs, 0.9)),
      replay_attempts_rejected: challenged.reduce((a, r) => a + Number(r.replay_attempts || 0), 0),
      per_1000_transactions: rows.length ? r4((challenged.length / rows.length) * 1000) : null,
    },
    outcome_by_label: matrix,
    fraud_loss: {
      stopped_by_challenge: { count: fraudCh.filter(isNoCompletion).length, amount: sumAmt(fraudCh.filter(isNoCompletion)) },
      passed_challenge: { count: fraudCh.filter((r) => r.cstatus === 'verified').length, amount: sumAmt(fraudCh.filter((r) => r.cstatus === 'verified')) },
      stopped_by_decline: { count: declined.filter((r) => labelOf(r) === 'fraud').length, amount: sumAmt(declined.filter((r) => labelOf(r) === 'fraud')) },
      flagged_not_challenged: { count: flaggedOnly.filter((r) => r.status === 'completed' && labelOf(r) === 'fraud').length, amount: sumAmt(flaggedOnly.filter((r) => r.status === 'completed' && labelOf(r) === 'fraud')) },
      all_completed_fraud: { count: completedFraudAll.length, amount: sumAmt(completedFraudAll) },
    },
    friction: {
      legit_confirmed_challenged: legitCh.length,
      legit_confirmed_not_completed: legitCh.filter(isNoCompletion).length,
      legit_confirmed_not_completed_amount: sumAmt(legitCh.filter(isNoCompletion)),
      unlabelled_challenged: unknownCh.length,
      unlabelled_not_completed: unknownCh.filter(isNoCompletion).length,
      declined: declined.length,
    },
    groups: { challenged: group(challenged), declined: group(declined), flagged_not_challenged: group(flaggedOnly) },
    by_policy: Object.fromEntries(Object.entries(byPolicy).map(([k, v]) => [k, group(v)])),
    caveats: [
      'Observational, not an experiment: challenged and unchallenged groups differ in who was selected, and policy settings change over time.',
      'A challenge that was failed, abandoned or expired and has no analyst verdict is NOT counted as stopped fraud or as a lost good customer: without a label we cannot tell which it was.',
      '"Fraud" means an analyst-confirmed alert or a customer dispute; fraud nobody reported is invisible here, so loss figures are lower bounds.',
      'FraudGuard records and recommends; whether a payment was actually authorized or refused is decided by the integrating payment system.',
    ],
  };
}

/** What a candidate policy would have done to the recent history, with the labels we have. Read-only. */
async function previewPolicy(policy, { days = 30, now = Date.now() } = {}) {
  const { evaluate } = require('../models/verificationPolicy');
  const rows = await loadRows(days, now);
  const out = { window_days: days, evaluated: rows.length, actions: { approve: 0, challenge: 0, decline: 0 }, by_level: {}, challenged_labels: { fraud: 0, legit: 0, unknown: 0 }, declined_labels: { fraud: 0, legit: 0, unknown: 0 } };
  for (const r of rows) {
    // channel availability is not replayed: assume one exists, so this is the policy's INTENT (enforcement may degrade per account)
    const v = evaluate({ policy: { ...policy, mode: 'enforce' }, level: r.risk_level, amount: Number(r.amount), hasChannel: true });
    out.actions[v.effective] += 1;
    out.by_level[r.risk_level] = out.by_level[r.risk_level] || { approve: 0, challenge: 0, decline: 0 };
    out.by_level[r.risk_level][v.effective] += 1;
    if (v.effective === 'challenge') out.challenged_labels[labelOf(r)] += 1;
    if (v.effective === 'decline') out.declined_labels[labelOf(r)] += 1;
  }
  out.share_challenged = rows.length ? r4(out.actions.challenge / rows.length) : null;
  out.share_declined = rows.length ? r4(out.actions.decline / rows.length) : null;
  out.caveats = ['Assumes every account has a way to be challenged; accounts without a step_up_required webhook are not held in enforce mode.', 'Labels are analyst verdicts and disputes only; "unknown" means no label yet, not "legitimate".'];
  return out;
}

async function recentChallenges({ status, limit = 50 } = {}) {
  const rows = await db.all(
    `SELECT c.id, c.transaction_id, c.status, c.method, c.risk_level, c.amount, c.policy_version, c.created_at, c.expires_at, c.resolved_at, c.outcome_reason, c.replay_attempts
       FROM step_up_challenges c ${status ? 'WHERE c.status = ?' : ''} ORDER BY c.id DESC LIMIT ?`, status ? [status, limit] : [limit]);
  return rows.map((r) => ({ ...r, id: Number(r.id), transaction_id: Number(r.transaction_id), replay_attempts: Number(r.replay_attempts || 0) }));
}

module.exports = { resolve, expireIfDue, recordReplay, sweepExpired, start, stop, effectiveness, previewPolicy, recentChallenges, WEBHOOK_EVENT, TARGET };
