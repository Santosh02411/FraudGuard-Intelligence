const path = require('path'); const fs = require('fs');
// jsdom ships with the frontend's dev dependencies (run `npm ci` in ../frontend first)
const { JSDOM } = require(path.join(__dirname, '..', '..', 'frontend', 'node_modules', 'jsdom'));
exports.load = async (file = path.join(__dirname, '..', 'fraudguard-demo.html'), url = 'http://localhost/demo.html') => {
  const errors = [];
  const dom = new JSDOM(fs.readFileSync(file, 'utf8'), {
    runScripts: 'dangerously', pretendToBeVisual: true, url,
    beforeParse(w) { w.TextEncoder = TextEncoder; w.fetch = (...a) => fetch(...a); w.scrollTo = () => {}; w.addEventListener('error', (e) => errors.push(e.message)); },
  });
  const w = dom.window; w.console.error = (...a) => errors.push(a.join(' '));
  const ev = (code) => w.eval(code);
  const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
  const click = async (sel) => { const el = w.document.querySelector(sel); if (!el) throw new Error(`no element ${sel}`); el.click(); await tick(30); return el; };
  return { w, ev, tick, click, errors, text: () => (w.document.querySelector('#root') || w.document.body).textContent };
};
