const path = require('path'); const { JSDOM } = require(path.join(__dirname, '..', '..', 'frontend', 'node_modules', 'jsdom'));
(async () => {
  const errors = [];
  const dom = await JSDOM.fromURL(process.argv[2], { runScripts: 'dangerously', resources: 'usable', pretendToBeVisual: true, beforeParse(w) { w.TextEncoder = TextEncoder; w.scrollTo = () => {}; w.addEventListener('error', (e) => errors.push(e.message)); } });
  await new Promise((r) => setTimeout(r, 800)); const w = dom.window; const txt = () => w.document.querySelector('#root').textContent;
  console.log('boots over http:', txt().includes('Sign in'), '| back-link on login:', txt().includes('Back to FraudGuard sign in'));
  w.eval("ACT.login('admin')"); await new Promise((r) => setTimeout(r, 100));
  console.log('exit link in banner:', !!w.document.querySelector('.banner a[href="/login"]'), '| script errors:', JSON.stringify(errors));
  process.exit(0);
})();
