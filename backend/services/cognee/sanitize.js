/**
 * Minimisation + redaction for everything that leaves FraudGuard for the memory store.
 * (cognee_service/app/sanitize.py enforces the same rules again on the receiving side.)
 */
const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
const JWT = /\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}/g;
const KEYISH = /\b(?:sk|pk|rk|key|tok|ghp|xox[abp])[-_][A-Za-z0-9_-]{16,}\b/gi;
const LONG_SECRET = /\b[A-Za-z0-9+/_-]{40,}={0,2}\b/g;
const SSN = /\b\d{3}-\d{2}-\d{4}\b/g;
const IPV4 = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
const IPV6 = /\b(?:[0-9a-fA-F]{1,4}:){3,7}[0-9a-fA-F]{1,4}\b/g;
const CARD = /\b(?:\d[ -]?){13,19}\b/g;
const PHONE = /(?<![\w.])\+?\d[\d\s().-]{7,}\d(?![\w.])/g;
// eslint-disable-next-line no-control-regex
const CTRL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

function redact(text, maxLen = 600) {
  if (text === null || text === undefined) return '';
  let out = String(text).replace(CTRL, ' ');
  out = out.replace(EMAIL, '[redacted-email]').replace(JWT, '[redacted-token]').replace(KEYISH, '[redacted-token]')
    .replace(SSN, '[redacted-id]').replace(IPV6, '[redacted-ip]').replace(IPV4, '[redacted-ip]')
    .replace(CARD, (m) => ((m.match(/\d/g) || []).length >= 13 ? '[redacted-number]' : m))
    .replace(PHONE, '[redacted-number]').replace(LONG_SECRET, '[redacted-token]');
  return out.replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

/** Columns that must never be selected for the memory projection. Used by tests as a guard. */
const NEVER_PROJECT = ['password', 'totp_secret', 'totp_backup_codes', 'email', 'ip_address', 'device_fingerprint', 'card_type', 'content'];

module.exports = { redact, NEVER_PROJECT };
