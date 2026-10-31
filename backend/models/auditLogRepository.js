/**
 * Audit trail (feature: who viewed/resolved which alert and when; RBAC
 * decisions logged). See middleware/auditLog.js for the write-side
 * helper routes call, and routes/admin.js's GET /audit-logs for the
 * read side.
 */

const db = require('../config/database');

// Keys whose VALUES must never be written to the audit trail, at any depth.
const SENSITIVE_KEY = /pass(word|wd)?|secret|token|authorization|api[_-]?key|cookie|otp|challenge|refresh|credential|private[_-]?key|signing|hmac|session|bearer|backup[_-]?code|cvv|card[_-]?number|pan\b/i;
// Values that look like secrets even under an innocent key.
const SECRET_VALUE = /(Bearer\s+[A-Za-z0-9._~+/-]{10,}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}|\bfg_(live|test)_[A-Za-z0-9]{8,}|\b[0-9a-f]{40,}\b)/g;
const MAX_STRING = 500;
const MAX_DEPTH = 6;

/** Removes secrets and bounds size before anything reaches audit_logs. Returns a new object. */
function sanitizeDetails(value, depth = 0, key = '') {
  if (value === null || value === undefined) return value;
  if (typeof value === 'number' && /id$/i.test(key)) return value; // e.g. tokenId: a row id, not a secret
  const labelKey = /(name|id|prefix|label|count|type|status)$/i.test(key); // descriptive fields, e.g. apiKeyName
  if (key && !labelKey && SENSITIVE_KEY.test(key) && typeof value !== 'boolean') return '[REDACTED]';
  if (typeof value === 'string') {
    const cleaned = value.replace(SECRET_VALUE, '[REDACTED]');
    return cleaned.length > MAX_STRING ? `${cleaned.slice(0, MAX_STRING)}…[truncated ${cleaned.length - MAX_STRING} chars]` : cleaned;
  }
  if (typeof value !== 'object') return value;
  if (depth >= MAX_DEPTH) return '[TRUNCATED: too deep]';
  if (Array.isArray(value)) return value.slice(0, 100).map((v) => sanitizeDetails(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value)) out[k] = sanitizeDetails(v, depth + 1, k);
  return out;
}

async function insert({ userId, username, action, targetType, targetId, outcome = 'success', ipAddress, details }) {
  return db.insert(
    `INSERT INTO audit_logs (user_id, username, action, target_type, target_id, outcome, ip_address, details)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      userId ?? null,
      username ?? null,
      action,
      targetType ?? null,
      targetId ?? null,
      outcome,
      ipAddress ?? null,
      JSON.stringify(sanitizeDetails(details ?? {})),
    ]
  );
}

function parseRow(row) {
  return { ...row, details: JSON.parse(row.details || '{}') };
}

/** All-comers admin view of the trail, newest first, optionally filtered. */
async function list({ page = 1, limit = 50, action, targetType, targetId, userId } = {}) {
  const offset = (page - 1) * limit;
  const clauses = [];
  const params = [];
  if (action) { clauses.push('action = ?'); params.push(action); }
  if (targetType) { clauses.push('target_type = ?'); params.push(targetType); }
  if (targetId) { clauses.push('target_id = ?'); params.push(targetId); }
  if (userId) { clauses.push('user_id = ?'); params.push(userId); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

  const rows = await db.all(
    `SELECT *, COUNT(*) OVER() as total FROM audit_logs ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );
  const total = rows.length > 0 ? Number(rows[0].total) : 0;
  return { rows: rows.map(({ total: _total, ...r }) => parseRow(r)), total };
}

/** Full history for one specific target (e.g. "every view/resolve of
 * alert #42, by whom, when") — the direct answer to "who viewed/resolved
 * which alert and when." */
async function forTarget(targetType, targetId) {
  const rows = await db.all(
    'SELECT * FROM audit_logs WHERE target_type = ? AND target_id = ? ORDER BY created_at DESC',
    [targetType, targetId]
  );
  return rows.map(parseRow);
}

module.exports = { insert, list, forTarget, sanitizeDetails };
