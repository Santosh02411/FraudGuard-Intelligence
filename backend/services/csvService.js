/**
 * Minimal CSV encoding (feature: CSV export). Hand-rolled rather than a
 * dependency — RFC 4180 quoting is a handful of lines, and pulling in a
 * library for it would be more surface area than the problem needs.
 */

/** Quotes a field only when it actually needs it (contains a comma,
 * quote, or newline) — matches how spreadsheet tools themselves write
 * CSV, and keeps the common case (a plain number or short word)
 * readable without quotes wrapping everything. */
function escapeField(value) {
  if (value === null || value === undefined) return '';
  let str = String(value);
  // CSV/formula injection: a text value (merchant names, notes — all customer-controlled)
  // that starts with = + - @ or a control char would be executed by Excel/Sheets.
  // Genuine numbers are left alone; text gets a leading apostrophe.
  if (typeof value === 'string' && /^[=+\-@\t\r]/.test(str)) str = `'${str}`;
  if (/[",\n\r]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/**
 * `columns` is an ordered array of `{ key, header }` — `key` supports
 * dot-paths for nested fields (e.g. 'transaction.merchant'), since
 * several of this app's export sources (alerts, in particular) join in
 * fields from a related row.
 */
function toCsv(rows, columns) {
  const header = columns.map((c) => escapeField(c.header)).join(',');
  const lines = rows.map((row) =>
    columns.map((c) => escapeField(getPath(row, c.key))).join(',')
  );
  return [header, ...lines].join('\r\n') + '\r\n';
}

function getPath(obj, path) {
  return path.split('.').reduce((acc, key) => (acc === null || acc === undefined ? acc : acc[key]), obj);
}

module.exports = { toCsv };
