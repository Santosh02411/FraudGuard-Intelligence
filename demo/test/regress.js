const {load}=require('./harness');
const run = async (file) => {
  const d = await load(file); const {ev,tick,w}=d; ev("ACT.login('admin')"); await tick();
  const routes = ev("NAV.flatMap((g) => g[1].map((n) => n[0]))").filter((r) => r !== 'memory');
  routes.push('transactions/1001', 'cases/31'); const bad = [];
  for (const r of routes) { w.location.hash = '#/' + r; await tick(40); const html = (w.document.querySelector('#page')||{}).innerHTML||''; if (/This view crashed/.test(html) || html.length < 200) bad.push(r); }
  // exercise a few original interactions
  const ok = []; try { ev("ACT.mlDown(true)"); ev("ACT.mlDown(false)"); ok.push('mlDown'); } catch (e) { bad.push('mlDown:'+e.message); }
  return { routes: routes.length, bad, errors: d.errors, navItems: ev("NAV.flatMap((g) => g[1]).length") };
};
(async()=>{
  const orig = await run(require('path').join(__dirname, '..', 'fraudguard-demo.base.html')), next = await run(require('path').join(__dirname, '..', 'fraudguard-demo.html'));
  console.log('original:', JSON.stringify(orig)); console.log('updated: ', JSON.stringify(next));
  const ok = next.bad.length === 0 && next.errors.length === 0 && next.navItems === orig.navItems + 1 && next.routes === orig.routes;
  console.log(ok ? 'NO REGRESSIONS: every original page renders; exactly one nav item added' : 'REGRESSION'); process.exit(ok ? 0 : 1);
})();
