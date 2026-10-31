const assert = require('assert'); const { load } = require('./harness');
let pass = 0; const t = async (n, f) => { try { await f(); pass++; console.log('  ✓', n); } catch (e) { const loc=(e.stack.split('\n').find((l)=>l.includes('live.test.js'))||'').trim(); console.log('  ✗', n, '\n     ', e.message.split('\n')[0], loc); process.exitCode = 1; } };
(async () => {
  if (!process.env.FG_LIVE_API) { console.log('skipped: set FG_LIVE_API (e.g. http://localhost:5055/api/v1) and FG_LIVE_USER / FG_LIVE_PASS for an admin of a running backend with Cognee configured'); process.exit(0); }
  const base = process.env.FG_LIVE_API;
  const tok = (await (await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: process.env.FG_LIVE_USER || 'admin', password: process.env.FG_LIVE_PASS || 'admin123' }) })).json()).accessToken;
  assert(tok, 'could not log in to the live backend');
  const d = await load(); const { ev, tick, w } = d; ev("ACT.login('admin')"); await tick(); w.location.hash = '#/memory'; await tick(60);

  await t('a wrong token is rejected and the demo stays offline', async () => {
    w.eval("ACT.memConnectOpen()"); await tick();
    w.document.querySelector('#lv-url').value = base; w.document.querySelector('#lv-tok').value = 'not-a-token';
    await w.eval("ACT.memConnect()"); await tick(100);
    assert.strictEqual(ev('MEM.live'), null); assert(/err-box/.test(w.document.querySelector('#lv-err').innerHTML));
    w.eval('closeModal()');
  });
  await t('connecting with a real admin token switches the screens to the live backend', async () => {
    w.eval("ACT.memConnectOpen()"); await tick();
    w.document.querySelector('#lv-url').value = base; w.document.querySelector('#lv-tok').value = tok;
    await w.eval("ACT.memConnect()");
    for (let i = 0; i < 40 && !/healthy/.test(d.text()); i++) await tick(100);   // poll: the health call is async
    assert(ev('MEM.live') && ev('MEM.live.base') === base); assert(d.text().includes('LIVE:')); assert(/Cognee service healthy/.test(d.text()));
  });
  let first;
  await t('live sync ingests the real seeded records into the real Cognee graph', async () => {
    first = await ev("MEMAPI.sync({ mode: 'full', force: true })");   // forced so the test is repeatable (a normal sync would correctly send nothing)
    assert.strictEqual(first.status, 'completed'); assert(first.ingested > 20, `ingested ${first.ingested}`);
    const st = await ev('MEMAPI.stats()'); assert(st.memory.structured_entities.Transaction > 20); assert(st.memory.edges_total > 40);
    const again = await ev("MEMAPI.sync({ mode: 'incremental' })"); assert.strictEqual(again.ingested, 0);
  });
  await t('live search returns real evidence; the UI renders it from the real API shape', async () => {
    ev("ACT.memTab('search')"); await tick(80); w.document.querySelector('#mem-q').value = 'high risk transaction flagged for review'; await w.eval('ACT.memSearch()'); await tick(400);
    const cards = w.document.querySelectorAll('[data-testid^="evidence-"]'); assert(cards.length >= 1, 'no live evidence cards');
    assert(/Open record/.test(w.document.querySelector('#mem-res').innerHTML));
    assert(!/live\.exists/.test(d.errors.join()), d.errors.join()); assert.deepStrictEqual(d.errors, [], d.errors.join('\n'));
  });
  await t('live entity list and graph', async () => {
    const r = await ev("MEMAPI.entities({ type: 'Customer' })"); assert(r.total >= 1 && r.entities[0].label.startsWith('acct_'));
    const g = await ev(`MEMAPI.related(${JSON.stringify(r.entities[0].id)})`); assert(g.nodes.length >= 2);
    ev("ACT.memTab('graph')"); await tick(300); assert(w.document.querySelector('#mem-glist [data-act="memGraphOpen"]'));
  });
  await t('live assistant returns the three separate layers (ai is null without an LLM in this environment)', async () => {
    const tx = (await (await fetch(`${base}/transactions?limit=1`, { headers: { Authorization: `Bearer ${tok}` } })).json()).transactions[0];
    const r = await ev(`MEMAPI.assist({ kind: 'transaction', id: ${tx.id} })`);
    assert(/FraudGuard record facts/.test(r.subject.label)); assert(/not generated/.test(r.evidence.label)); assert(['ok', 'llm_not_configured', 'generation_failed'].includes(r.ai_status));
    assert(!JSON.stringify(r).includes(tx.ip_address || 'no-ip'), 'raw IP must not appear');
  });
  await t('disconnecting returns to the offline engine', async () => { ev("ACT.memDisconnect()"); await tick(80); assert.strictEqual(ev('MEM.live'), null); assert(!d.text().includes('LIVE:')); });
  console.log(`\n${pass} passed`); process.exit(process.exitCode || 0);
})().catch((e) => { console.error('HARNESS ERROR', e); process.exit(2); });
