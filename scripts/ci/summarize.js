#!/usr/bin/env node
/**
 * Renders test + coverage results as Markdown for $GITHUB_STEP_SUMMARY.
 * Usage: node scripts/ci/summarize.js "<Title>" [--junit file.xml] [--coverage coverage-summary.json] [--perf perf-results/dir]
 * Never fails the build itself: the test/coverage steps own pass/fail; this only makes results visible.
 */
const fs = require('fs');
const path = require('path');

const [title = 'Results', ...rest] = process.argv.slice(2);
const arg = (n) => { const i = rest.indexOf(`--${n}`); return i >= 0 ? rest[i + 1] : null; };
const out = [`### ${title}`, ''];
const attr = (xml, name) => { const m = new RegExp(`${name}="(\\d+(?:\\.\\d+)?)"`).exec(xml); return m ? Number(m[1]) : 0; };

try {
  const j = arg('junit');
  if (j && fs.existsSync(j)) {
    const xml = fs.readFileSync(j, 'utf8');
    const head = /<testsuites[^>]*>/.exec(xml)?.[0] || '';
    const tests = attr(head, 'tests'); const fail = attr(head, 'failures') + attr(head, 'errors'); const time = attr(head, 'time');
    out.push(`${fail ? '❌' : '✅'} **${tests - fail}/${tests} tests passed** in ${time.toFixed(1)}s`, '');
    const failed = [...xml.matchAll(/<testcase[^>]*classname="([^"]*)"[^>]*name="([^"]*)"[^>]*>\s*<failure/g)].slice(0, 20);
    if (failed.length) out.push('<details open><summary>Failed tests</summary>', '', ...failed.map((m) => `- ${m[1]} › ${m[2]}`), '', '</details>', '');
  }
  const c = arg('coverage');
  if (c && fs.existsSync(c)) {
    const t = JSON.parse(fs.readFileSync(c, 'utf8')).total;
    out.push('| Lines | Statements | Branches | Functions |', '|---|---|---|---|', `| ${t.lines.pct}% | ${t.statements.pct}% | ${t.branches.pct}% | ${t.functions.pct}% |`, '');
  }
  const p = arg('perf');
  if (p && fs.existsSync(p)) {
    out.push('| Measurement | Value | Budget |', '|---|---|---|');
    for (const f of fs.readdirSync(p).filter((x) => x.endsWith('.json'))) {
      const d = JSON.parse(fs.readFileSync(path.join(p, f), 'utf8'));
      for (const r of d.results) out.push(`| ${r.name} (${d.dialect}) | ${r.value} ${r.unit} | ${r.budget ? `${r.budget} ${r.unit}` : '—'} |`);
    }
    out.push('');
  }
} catch (e) { out.push(`_could not summarize: ${e.message}_`); }

const text = out.join('\n');
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n`); else console.log(text);
