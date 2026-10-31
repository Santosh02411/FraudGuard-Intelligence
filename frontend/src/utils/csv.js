/**
 * Minimal CSV parsing (feature: bulk transaction import). Mirrors
 * backend/services/csvService.js's "hand-rolled rather than a
 * dependency" approach — this only needs to handle the flat,
 * comma-separated, double-quote-escaped shape a spreadsheet tool
 * actually exports, not the full RFC 4180 surface.
 */

/** Splits one CSV line into fields, honoring double-quoted fields that
 * may contain a comma or an escaped `""` (a literal quote). */
function splitLine(line) {
  const fields = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (inQuotes) {
      if (char === '"' && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else if (char === '"') {
        inQuotes = false;
      } else {
        current += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === ',') {
      fields.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  fields.push(current);
  return fields.map(f => f.trim());
}

/**
 * Parses CSV text into `{ headers, rows }`, where each row is a plain
 * object keyed by the header row. Blank lines are skipped. Returns
 * `{ headers: [], rows: [] }` for empty input.
 */
export function parseCsv(text) {
  const lines = (text || '').split(/\r?\n/).filter(line => line.trim().length > 0);
  if (lines.length === 0) return { headers: [], rows: [] };

  const headers = splitLine(lines[0]).map(h => h.toLowerCase());
  const rows = lines.slice(1).map(line => {
    const cells = splitLine(line);
    const row = {};
    headers.forEach((h, i) => { row[h] = cells[i] ?? ''; });
    return row;
  });
  return { headers, rows };
}
