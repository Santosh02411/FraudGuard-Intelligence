const fs = require('fs');
const path = require('path');

const SCALE = Number(process.env.PERF_BUDGET_SCALE || 1); // raise on slow CI runners; never lower in CI
const results = [];

const pct = (arr, p) => { const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]; };

async function timed(fn) { const t0 = process.hrtime.bigint(); const out = await fn(); return { out, ms: Number(process.hrtime.bigint() - t0) / 1e6 }; }

/** Records a measurement and asserts it against a budget (ms). Budgets are deliberately loose: they catch order-of-magnitude regressions, not noise. */
function record(name, value, { budgetMs, unit = 'ms', note } = {}) {
  const budget = budgetMs ? budgetMs * SCALE : null;
  results.push({ name, value: Math.round(value * 100) / 100, unit, budget, ok: budget === null || value <= budget, note });
  if (budget !== null) expect({ name, value, budget }).toEqual({ name, value: expect.any(Number), budget });
  if (budget !== null && value > budget) throw new Error(`PERF BUDGET EXCEEDED: ${name} took ${value.toFixed(1)}${unit} (budget ${budget}${unit})`);
}

function flush(file) {
  const out = path.join(process.env.PERF_OUT_DIR || path.join(__dirname, '..', '..', 'perf-results'), file);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify({ dialect: process.env.DATABASE_URL ? 'postgres' : 'sqlite', scale: SCALE, node: process.version, at: new Date().toISOString(), results }, null, 2));
}

module.exports = { pct, timed, record, flush, results };
