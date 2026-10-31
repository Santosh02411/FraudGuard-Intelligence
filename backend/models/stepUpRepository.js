/**
 * Step-Up Authentication Repository
 * ====================================
 * Feature: step-up auth hook. Backs the webhook/API contract that lets
 * a medium-risk transaction be HELD for an extra verification step
 * (OTP, 3DS, or whatever the calling merchant's own auth stack uses)
 * instead of only alerting an analyst after the money has already
 * moved — see routes/transactions.js for the full contract
 * (transaction.step_up_required webhook out, POST .../step-up/verify
 * callback in).
 */

const crypto = require('crypto');
const db = require('../config/database');
const config = require('../config/env');

function generateToken() {
  return crypto.randomBytes(24).toString('hex');
}

/** @param {{transactionId: number, method?: string}} params */
async function createChallenge({ transactionId, method = 'otp', ttlMs = config.stepUpChallengeTtlMs, policyVersion = null, riskLevel = null, amount = null }) {
  const token = generateToken();
  const expiresAt = new Date(Date.now() + ttlMs).toISOString();
  const { lastInsertRowid } = await db.insert(
    `INSERT INTO step_up_challenges (transaction_id, status, method, challenge_token, expires_at, policy_version, risk_level, amount)
     VALUES (?, 'pending', ?, ?, ?, ?, ?, ?)`,
    [transactionId, method, token, expiresAt, policyVersion, riskLevel, amount]
  );
  await db.run(
    'INSERT INTO verification_events (challenge_id, transaction_id, kind, actor, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    [lastInsertRowid, transactionId, 'issued', 'system', JSON.stringify({ expires_at: expiresAt, policy_version: policyVersion, risk_level: riskLevel }), new Date().toISOString()]
  );
  return findById(lastInsertRowid);
}

async function findById(id) {
  return db.get('SELECT * FROM step_up_challenges WHERE id = ?', [id]);
}

async function findByTransactionId(transactionId) {
  return db.get('SELECT * FROM step_up_challenges WHERE transaction_id = ? ORDER BY created_at DESC LIMIT 1', [transactionId]);
}

async function findByToken(token) {
  return db.get('SELECT * FROM step_up_challenges WHERE challenge_token = ?', [token]);
}

function isExpired(challenge) {
  return new Date(challenge.expires_at).getTime() < Date.now();
}

/**
 * Lazily resolves an already-due-but-still-"pending" challenge to
 * "expired" — there's no background sweep for this (unlike the webhook
 * retry queue, an expired challenge doesn't need to DO anything on
 * expiry, just stop being valid), so the check happens at the two
 * points that actually care: verify() below, and GET .../step-up status
 * checks.
 */
async function expireIfDue(challenge) {
  if (challenge.status === 'pending' && isExpired(challenge)) {
    await db.run("UPDATE step_up_challenges SET status = 'expired' WHERE id = ?", [challenge.id]);
    return { ...challenge, status: 'expired' };
  }
  return challenge;
}

/** Both resolvers are compare-and-set on status = 'pending': of several
 * simultaneous verify calls exactly one wins; the rest see `won: false`. */
async function markVerified(id) {
  const { changes } = await db.run("UPDATE step_up_challenges SET status = 'verified', verified_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'pending'", [id]);
  return { won: changes === 1, challenge: await findById(id) };
}

async function markFailed(id) {
  const { changes } = await db.run("UPDATE step_up_challenges SET status = 'failed' WHERE id = ? AND status = 'pending'", [id]);
  return { won: changes === 1, challenge: await findById(id) };
}

module.exports = { createChallenge, findById, findByTransactionId, findByToken, isExpired, expireIfDue, markVerified, markFailed };
