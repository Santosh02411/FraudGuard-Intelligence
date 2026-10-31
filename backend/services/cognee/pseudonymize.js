/**
 * Pseudonymisation for the Cognee memory.
 *
 * Customer account ids and device fingerprints are replaced by keyed HMAC-SHA256 digests, so the
 * same account/device always maps to the same reference (which is what makes the graph useful)
 * but the reference cannot be reversed or recomputed without COGNEE_PSEUDONYM_SECRET.
 * The kind is part of the HMAC input, so an account and a device never share a reference.
 *
 * This is pseudonymisation, not anonymisation: whoever holds the secret can re-link references to
 * records, and transaction details may still be identifying. Rotate the secret and run a full
 * re-sync to re-key everything.
 */
const crypto = require('crypto');
const config = require('../../config/env');

function pseudonym(kind, value) {
  if (value === null || value === undefined || value === '') return null;
  const digest = crypto.createHmac('sha256', config.cognee.pseudonymSecret).update(`fraudguard:${kind}:${String(value)}`).digest('hex');
  return `${kind === 'account' ? 'acct' : 'dev'}_${digest.slice(0, 24)}`;
}

const accountRef = (userId) => pseudonym('account', userId);
const deviceRef = (fingerprint) => pseudonym('device', fingerprint);

module.exports = { accountRef, deviceRef, pseudonym };
