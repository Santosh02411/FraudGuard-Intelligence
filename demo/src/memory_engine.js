/* =====================================================================
   AI Memory / Fraud Intelligence — OFFLINE demo engine.
   Mirrors backend/services/cognee/* and cognee_service/app/*: the same minimised + pseudonymised records,
   SHA-256 content hashes (dedup), cursor, typed graph (Transaction/Customer/Merchant/Device/FraudPattern/
   Investigation), suspicious-device rule, and evidence/AI separation.
   What differs from the product (and the UI says so): retrieval here is TF-IDF cosine over each record's
   summary instead of Cognee embeddings, and there is no LLM, so the assistant's section is derived by
   deterministic rules from the graph and is labelled "Computed", never "AI-generated".
   Optional: connect to a real backend (API URL + admin token) and the same screens use the live endpoints.
   ===================================================================== */
const MEM = {
  secret: hex(32), records: new Map(), cursor: 0, runs: [], nextRun: 1, nodes: new Map(), edges: new Map(), docs: new Map(),
  index: null, auto: false, timer: null, outage: false, running: false, live: null,
};
const MEMUI = UI.mem = { tab: 'overview', q: '', kind: 'all', ans: false, gType: 'Device', gQ: '', gSus: false, aKind: 'transaction', aId: '', aQ: '' };

/* ---------- crypto: synchronous SHA-256 + HMAC (the page must stay offline and synchronous) ---------- */
const sha256 = (() => {
  const primes = []; for (let n = 2; primes.length < 64; n++) if (primes.every((p) => n % p)) primes.push(n);
  const fr = (x) => Math.floor((x - Math.floor(x)) * 4294967296) >>> 0;
  const K = primes.map((p) => fr(Math.cbrt(p))), H0 = primes.slice(0, 8).map((p) => fr(Math.sqrt(p)));
  const rotr = (x, n) => (x >>> n) | (x << (32 - n));
  return function (input) {
    const bytes = ArrayBuffer.isView(input) ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength) : new TextEncoder().encode(String(input));
    const l = bytes.length, total = ((l + 9 + 63) >> 6) << 6, buf = new Uint8Array(total);
    buf.set(bytes); buf[l] = 0x80;
    const dv = new DataView(buf.buffer); dv.setUint32(total - 4, (l * 8) >>> 0); dv.setUint32(total - 8, Math.floor((l * 8) / 4294967296));
    const h = H0.slice(), w = new Uint32Array(64);
    for (let o = 0; o < total; o += 64) {
      for (let i = 0; i < 16; i++) w[i] = dv.getUint32(o + i * 4);
      for (let i = 16; i < 64; i++) { const a = w[i - 15], b = w[i - 2]; w[i] = (w[i - 16] + (rotr(a, 7) ^ rotr(a, 18) ^ (a >>> 3)) + w[i - 7] + (rotr(b, 17) ^ rotr(b, 19) ^ (b >>> 10))) >>> 0; }
      let [a, b, c, d, e, f, g, hh] = h;
      for (let i = 0; i < 64; i++) {
        const t1 = (hh + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i]) >>> 0;
        const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
        hh = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
      }
      h[0] = (h[0] + a) >>> 0; h[1] = (h[1] + b) >>> 0; h[2] = (h[2] + c) >>> 0; h[3] = (h[3] + d) >>> 0; h[4] = (h[4] + e) >>> 0; h[5] = (h[5] + f) >>> 0; h[6] = (h[6] + g) >>> 0; h[7] = (h[7] + hh) >>> 0;
    }
    return h.map((x) => x.toString(16).padStart(8, '0')).join('');
  };
})();
const hexBytes = (s) => Uint8Array.from(s.match(/../g).map((x) => parseInt(x, 16)));
function hmacSha256(key, msg) {
  let k = new TextEncoder().encode(key); if (k.length > 64) k = hexBytes(sha256(k));
  const ipad = new Uint8Array(64).fill(0x36), opad = new Uint8Array(64).fill(0x5c);
  k.forEach((b, i) => { ipad[i] ^= b; opad[i] ^= b; });
  const m = new TextEncoder().encode(msg), inner = new Uint8Array(64 + m.length); inner.set(ipad); inner.set(m, 64);
  const outer = new Uint8Array(64 + 32); outer.set(opad); outer.set(hexBytes(sha256(inner)), 64);
  return sha256(outer);
}
const pseud = (kind, v) => (v === null || v === undefined || v === '' ? null : `${kind === 'account' ? 'acct' : 'dev'}_${hmacSha256(MEM.secret, `fraudguard:${kind}:${v}`).slice(0, 24)}`);
const canon = (v) => (Array.isArray(v) ? v.map(canon) : v && typeof v === 'object' ? Object.keys(v).sort().reduce((a, k) => { if (v[k] !== undefined) a[k] = canon(v[k]); return a; }, {}) : v);
const hashOf = (rec) => sha256(JSON.stringify(canon(rec)));

/* ---------- redaction (same rules as backend/services/cognee/sanitize.js) ---------- */
function redact(text, max = 600) {
  if (text === null || text === undefined) return '';
  return String(text).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ')
    .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, '[redacted-email]').replace(/\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}/g, '[redacted-token]')
    .replace(/\b(?:sk|pk|rk|key|tok|ghp|xox[abp])[-_][A-Za-z0-9_-]{16,}\b/gi, '[redacted-token]').replace(/\b\d{3}-\d{2}-\d{4}\b/g, '[redacted-id]')
    .replace(/\b(?:[0-9a-fA-F]{1,4}:){3,7}[0-9a-fA-F]{1,4}\b/g, '[redacted-ip]').replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '[redacted-ip]')
    .replace(/\b(?:\d[ -]?){13,19}\b/g, (m) => ((m.match(/\d/g) || []).length >= 13 ? '[redacted-number]' : m))
    .replace(/(?<![\w.])\+?\d[\d\s().-]{7,}\d(?![\w.])/g, '[redacted-number]').replace(/\b[A-Za-z0-9+/_-]{40,}={0,2}\b/g, '[redacted-token]')
    .replace(/\s+/g, ' ').trim().slice(0, max);
}
function patternLabel(reason) {
  let t = redact(reason, 160).toLowerCase(); const m = t.match(/^\s*model signal:\s*([^(]+)/);
  if (m) { const f = m[1].replace(/[^a-z\s_-]/g, ' ').replace(/\s+/g, ' ').trim(); return f ? `model signal ${f}`.slice(0, 80) : 'model signal'; }
  t = t.split(/[:(\[]/)[0].replace(/[\d$€£.,%]+/g, ' ').replace(/[^a-z\s_-]/g, ' ').replace(/\s+/g, ' ').trim();
  return t.slice(0, 80) || 'unspecified pattern';
}

/* ---------- projection of demo records (read-only; never mutates S) ---------- */
const caseOfTxn = (t) => { const al = alertOf(t.id); return S.cases.find((c) => (al && c.id === al.case_id) || c.txns.includes(t.id)); };
function projectTxn(t) {
  const al = alertOf(t.id), dp = S.disputes.find((d) => d.transaction_id === t.id), cs = caseOfTxn(t);
  const reasons = [...new Set([...(t.hard_flag_triggered || []).map((h) => `Hard rule: ${redact(h, 140)}`), ...(t.fraud_reasons || []).map((r) => redact(r, 160))])].filter(Boolean).slice(0, 20);
  const factors = (t.shap_explanation || []).filter((f) => f.effect === 'increased_risk').slice(0, 4).map((f) => `${redact(f.feature, 80)} (increased risk)`);
  const rec = {
    source_type: 'transaction', source_id: String(t.id), occurred_at: new Date(t.created_at).toISOString(), customer_ref: pseud('account', t.user_id),
    merchant: redact(t.merchant, 120), category: redact(t.category, 60), location: redact(t.location, 100), amount: t.amount, currency: 'unspecified',
    fraud_score: t.fraud_score, risk_level: t.risk_level, scoring_method: t.scoring_method, flagged: !!t.is_fraud, detection_reasons: reasons, model_factors: factors,
    device_ref: pseud('device', t.device), analyst_notes: al ? al.notes.slice(-8).map((n) => redact(n.text, 400)) : [],
  };
  if (t.model_version) rec.model_version = t.model_version;
  if (al) { rec.alert_status = al.status; if (al.outcome) rec.verdict = al.outcome; }
  if (dp) rec.dispute_status = dp.status;
  if (cs) rec.investigation_id = String(cs.id);
  rec.content_hash = hashOf(rec); return rec;
}
function projectCase(c) {
  const members = c.txns.map(txnOf).filter(Boolean);
  const rec = {
    source_type: 'investigation', source_id: String(c.id), occurred_at: new Date(c.created_at).toISOString(), title: redact(c.title, 200), status: c.status, priority: c.priority,
    timeline_notes: c.timeline.slice(-25).map((e) => `${e.kind}: ${redact(e.text, 250)}`), transaction_ids: c.txns.map(String),
    customer_refs: [...new Set(members.map((m) => pseud('account', m.user_id)))], exposure_amount: members.reduce((s, m) => s + m.amount, 0),
  };
  if (c.outcome) rec.outcome = c.outcome; if (c.closing_note) rec.outcome_note = redact(c.closing_note, 1500);
  rec.content_hash = hashOf(rec); return rec;
}
const mm = (v) => (v === undefined || v === null ? 'n/a' : Number(v).toFixed(2));
function describeTxn(r) {
  const L = [`Transaction ${r.source_id}: ${mm(r.amount)} at ${r.merchant} (${r.category}), location ${r.location}, ${r.occurred_at}.`, `Customer account ${r.customer_ref}. Device ${r.device_ref || 'not recorded'}.`,
    `Fraud risk ${r.risk_level} (score ${Math.round(r.fraud_score)}/100, ${r.scoring_method}${r.model_version ? ' model ' + r.model_version : ''}); flagged: ${r.flagged ? 'yes' : 'no'}.`];
  if (r.detection_reasons.length) L.push(`Detection reasons: ${r.detection_reasons.join('; ')}.`);
  if (r.model_factors.length) L.push(`Top model factors: ${r.model_factors.join('; ')}.`);
  L.push(`Analyst verdict: ${r.verdict || 'none yet'}; alert status: ${r.alert_status || 'no alert'}.`);
  if (r.analyst_notes.length) L.push(`Analyst notes: ${r.analyst_notes.join(' | ')}`);
  if (r.dispute_status) L.push(`Dispute status: ${r.dispute_status}.`);
  if (r.investigation_id) L.push(`Part of investigation ${r.investigation_id}.`);
  L.push(`Source key: transaction:${r.source_id}.`); return L.join('\n');
}
function describeCase(r) {
  const L = [`Investigation ${r.source_id}: "${r.title}" - status ${r.status}, priority ${r.priority}, outcome ${r.outcome || 'undecided'}.`];
  if (r.outcome_note) L.push(`Outcome / remediation decision: ${r.outcome_note}`);
  if (r.timeline_notes.length) L.push(`Analyst timeline: ${r.timeline_notes.join(' | ')}`);
  L.push(`Covers ${r.transaction_ids.length} transaction(s) across ${r.customer_refs.length} customer account(s); exposure ${mm(r.exposure_amount)}.`, `Source key: investigation:${r.source_id}.`); return L.join('\n');
}

/* ---------- graph ---------- */
function upNode(type, key, label, props = {}) { const id = `${type}:${key}`; MEM.nodes.set(id, Object.assign(MEM.nodes.get(id) || {}, { id, type, label, ...props })); return id; }
function upEdge(s, rel, t) { MEM.edges.set(`${s}|${rel}|${t}`, { source: s, target: t, relation: rel }); }
function ingestRecord(rec) {
  if (rec.source_type === 'transaction') {
    const tid = upNode('Transaction', rec.source_id, `transaction:${rec.source_id}`, { summary: describeTxn(rec), props: { risk_level: rec.risk_level, fraud_score: rec.fraud_score, verdict: rec.verdict, alert_status: rec.alert_status, amount: rec.amount, occurred_at: rec.occurred_at, flagged: rec.flagged, investigation_id: rec.investigation_id, merchant: rec.merchant } });
    upEdge(tid, 'made_by', upNode('Customer', rec.customer_ref, rec.customer_ref));
    upEdge(tid, 'at_merchant', upNode('Merchant', rec.merchant.toLowerCase(), rec.merchant));
    if (rec.device_ref) upEdge(tid, 'from_device', upNode('Device', rec.device_ref, rec.device_ref));
    new Set(rec.detection_reasons.map(patternLabel)).forEach((p) => upEdge(tid, 'exhibits_pattern', upNode('FraudPattern', p, p)));
    MEM.docs.set(`transaction:${rec.source_id}`, { text: MEM.nodes.get(tid).summary });
  } else {
    const iid = upNode('Investigation', rec.source_id, `investigation:${rec.source_id}`, { summary: describeCase(rec), props: { status: rec.status, priority: rec.priority, outcome: rec.outcome, occurred_at: rec.occurred_at, title: rec.title, outcome_note: rec.outcome_note } });
    const want = new Set(rec.transaction_ids.map((i) => `Transaction:${i}`).filter((id) => MEM.nodes.has(id)));
    [...MEM.edges.values()].filter((e) => e.source === iid && e.relation === 'investigates' && !want.has(e.target)).forEach((e) => MEM.edges.delete(`${e.source}|${e.relation}|${e.target}`));
    want.forEach((t) => upEdge(iid, 'investigates', t));
    MEM.docs.set(`investigation:${rec.source_id}`, { text: MEM.nodes.get(iid).summary });
  }
  MEM.index = null;
}
const adj = () => { const a = new Map(); for (const e of MEM.edges.values()) { (a.get(e.source) || a.set(e.source, new Set()).get(e.source)).add(e.target); (a.get(e.target) || a.set(e.target, new Set()).get(e.target)).add(e.source); } return a; };
function signals(id, a) {
  const n = MEM.nodes.get(id), s = {}, txs = [...(a.get(id) || [])].filter((x) => MEM.nodes.get(x)?.type === 'Transaction');
  if (['Device', 'Customer', 'Merchant', 'FraudPattern'].includes(n.type)) { s.transactions = txs.length; s.confirmed_fraud = txs.filter((t) => MEM.nodes.get(t).props.verdict === 'confirmed_fraud').length; s.flagged = txs.filter((t) => MEM.nodes.get(t).props.flagged).length; }
  if (n.type === 'Device') { const cs = new Set(txs.flatMap((t) => [...(a.get(t) || [])].filter((x) => MEM.nodes.get(x)?.type === 'Customer'))); s.accounts = cs.size; s.suspicious = cs.size >= 2 || s.confirmed_fraud > 0; }
  if (n.type === 'Customer') s.devices = new Set(txs.flatMap((t) => [...(a.get(t) || [])].filter((x) => MEM.nodes.get(x)?.type === 'Device'))).size;
  return s;
}

/* ---------- retrieval: TF-IDF cosine over record summaries (stand-in for Cognee embeddings) ---------- */
const STOP = new Set('a an and are as at be by for from has have in is it of on or that the this to was were with who what which how any all been had not'.split(' '));
const SYN = { stolen: ['theft', 'stole', 'unauthorized', 'unauthorised'], fraudulent: ['fraud'], gift: ['giftcard'], testing: ['test'], velocity: ['burst', 'rapid'], ring: ['shared', 'cluster'], takeover: ['ato', 'hijack'], fp: ['false', 'positive'], proxy: ['anonymous'], crypto: ['cryptoexchange'] };
const stem = (w) => w.replace(/(ing|ed|es|s)$/, (m, x, i) => (w.length - m.length >= 4 ? '' : m));
const toks = (s) => String(s).toLowerCase().split(/[^a-z0-9_]+/).filter((w) => w && !STOP.has(w)).flatMap((w) => [stem(w), ...(SYN[w] || []).map(stem)]);
function buildIndex() {
  const docs = [...MEM.docs.entries()].map(([k, d]) => ({ key: k, tf: toks(d.text).reduce((m, t) => m.set(t, (m.get(t) || 0) + 1), new Map()) }));
  const df = new Map(); docs.forEach((d) => d.tf.forEach((_, t) => df.set(t, (df.get(t) || 0) + 1)));
  const N = docs.length || 1, idf = (t) => Math.log(1 + N / (df.get(t) || 1));
  docs.forEach((d) => { d.vec = new Map([...d.tf].map(([t, c]) => [t, (1 + Math.log(c)) * idf(t)])); d.norm = Math.sqrt([...d.vec.values()].reduce((s, x) => s + x * x, 0)) || 1; });
  MEM.index = { docs, idf };
}
function localEvidence(query, topK, kinds, excludeKey) {
  if (!MEM.index) buildIndex();
  const q = toks(query).reduce((m, t) => m.set(t, (m.get(t) || 0) + 1), new Map()), { docs, idf } = MEM.index;
  const qv = new Map([...q].map(([t, c]) => [t, (1 + Math.log(c)) * idf(t)])), qn = Math.sqrt([...qv.values()].reduce((s, x) => s + x * x, 0)) || 1, a = adj();
  return docs.filter((d) => d.key !== excludeKey && (!kinds.length || kinds.includes(d.key.split(':')[0])))
    .map((d) => ({ d, s: [...qv].reduce((acc, [t, w]) => acc + w * (d.vec.get(t) || 0), 0) / (qn * d.norm) })).filter((x) => x.s > 0.04).sort((x, y) => y.s - x.s).slice(0, topK)
    .map(({ d, s }) => evidenceItem(d.key, s, a));
}
function evidenceItem(key, rel, a) {
  const [kind, sid] = key.split(':'), id = `${kind === 'transaction' ? 'Transaction' : 'Investigation'}:${sid}`, n = MEM.nodes.get(id);
  const conn = [...MEM.edges.values()].filter((e) => e.source === id || e.target === id).map((e) => ({ other: MEM.nodes.get(e.source === id ? e.target : e.source), rel: e.relation })).filter((x) => x.other).slice(0, 8)
    .map((x) => ({ id: x.other.id, type: x.other.type, label: x.other.label, relation: x.rel }));
  const stored = MEM.records.get(key), cur = kind === 'transaction' ? (txnOf(+sid) && projectTxn(txnOf(+sid))) : (S.cases.find((c) => c.id === +sid) && projectCase(S.cases.find((c) => c.id === +sid)));
  return { id, source_type: kind, source_id: sid, source_key: key, distance: 1 - rel, relevance: rel, matched_via: ['local_tfidf'], snippet: n.summary.slice(0, 900), connected: conn,
    properties: Object.fromEntries(Object.entries(n.props || {}).filter(([, v]) => v !== undefined && v !== null)),
    live: cur ? { exists: true, url: `/${kind === 'transaction' ? 'transactions' : 'cases'}/${sid}`, memoryOutOfDate: !!stored && stored.hash !== cur.content_hash } : { exists: false } };
}

/* ---------- synchronisation (same algorithm shape as backend/services/cognee/syncService.js) ---------- */
function collect(mode, force) {
  const work = []; let scanned = 0, skipped = 0; const start = mode === 'full' ? 0 : MEM.cursor, real = S.txns.filter((t) => !t.synthetic).sort((a, b) => a.id - b.id);
  for (const t of real) {
    const isNew = t.id > start, changeable = !!alertOf(t.id) || S.disputes.some((d) => d.transaction_id === t.id) || !!caseOfTxn(t);
    const failed = MEM.records.get(`transaction:${t.id}`)?.status === 'failed';
    if (!isNew && !changeable && !failed) continue;
    const rec = projectTxn(t), st = MEM.records.get(`transaction:${t.id}`); scanned++;
    if (!force && st && st.status === 'synced' && st.hash === rec.content_hash) { skipped++; continue; }
    work.push({ rec, isNew, id: t.id });
  }
  const invs = [];
  for (const c of S.cases) { const rec = projectCase(c), st = MEM.records.get(`investigation:${c.id}`); scanned++; if (!force && st && st.status === 'synced' && st.hash === rec.content_hash) { skipped++; continue; } invs.push({ rec, id: c.id }); }
  invs.forEach((i) => i.rec.transaction_ids.forEach((tid) => { if (!work.some((w) => w.id === +tid) && MEM.records.get(`transaction:${tid}`)?.status !== 'synced' && txnOf(+tid)) work.push({ rec: projectTxn(txnOf(+tid)), isNew: false, id: +tid }); }));
  return { work, invs, scanned, skipped };
}
function runSyncLocal({ mode = 'incremental', force = false, trigger = 'manual' } = {}) {
  if (MEM.running) { const e = new Error('A synchronisation run is already in progress'); e.status = 409; throw e; }
  MEM.running = true; const run = { id: MEM.nextRun++, trigger, mode, actor: trigger === 'scheduler' ? null : S.me.username, status: 'running', startedAt: new Date().toISOString(), scanned: 0, ingested: 0, skippedUnchanged: 0, failed: 0 };
  MEM.runs.unshift(run);
  try {
    if (MEM.outage) throw new Error('Cognee service is unreachable (simulated outage)');
    const { work, invs, scanned, skipped } = collect(mode, force); Object.assign(run, { scanned, skippedUnchanged: skipped });
    work.sort((a, b) => (+a.isNew - +b.isNew) || a.id - b.id);
    for (const w of work) { ingestRecord(w.rec); MEM.records.set(`transaction:${w.id}`, { hash: w.rec.content_hash, status: 'synced', at: Date.now() }); run.ingested++; if (w.isNew) MEM.cursor = Math.max(MEM.cursor, w.id); }
    for (const i of invs) { ingestRecord(i.rec); MEM.records.set(`investigation:${i.id}`, { hash: i.rec.content_hash, status: 'synced', at: Date.now() }); run.ingested++; }
    run.status = 'completed';
  } catch (e) { run.status = 'failed'; run.error = e.message; throw Object.assign(e, { status: 503 }); } finally { MEM.running = false; run.finishedAt = new Date().toISOString(); }
  return { runId: run.id, status: run.status, mode, trigger, scanned: run.scanned, ingested: run.ingested, skippedUnchanged: run.skippedUnchanged, failed: 0, morePending: false };
}

/* ---------- entities / related ---------- */
function localEntities({ type, q, suspiciousOnly, limit = 25, offset = 0 }) {
  const a = adj(), rows = [];
  for (const n of MEM.nodes.values()) {
    if (type && n.type !== type) continue; if (q && !n.label.toLowerCase().includes(q.toLowerCase())) continue;
    const sg = signals(n.id, a); if (suspiciousOnly && !sg.suspicious) continue; rows.push({ id: n.id, type: n.type, label: n.label, degree: (a.get(n.id) || new Set()).size, signals: sg });
  }
  rows.sort((x, y) => (+!!y.signals.suspicious - +!!x.signals.suspicious) || y.degree - x.degree || String(x.label).localeCompare(y.label));
  return { total: rows.length, entities: rows.slice(offset, offset + limit) };
}
function localRelated(id, depth = 1, limit = 60) {
  if (!MEM.nodes.has(id)) { const e = new Error('Entity not found'); e.status = 404; throw e; }
  const a = adj(), seen = new Map([[id, 0]]), q = [id];
  while (q.length && seen.size < limit) { const cur = q.shift(); if (seen.get(cur) >= depth) continue; for (const nx of [...(a.get(cur) || [])].sort()) { if (seen.has(nx)) continue; seen.set(nx, seen.get(cur) + 1); q.push(nx); if (seen.size >= limit) break; } }
  return { center: id, depth, truncated: seen.size >= limit, nodes: [...seen].map(([nid, level]) => { const n = MEM.nodes.get(nid); return { id: nid, type: n.type, label: n.label, level, signals: signals(nid, a), properties: n.props || {} }; }),
    edges: [...MEM.edges.values()].filter((e) => seen.has(e.source) && seen.has(e.target)) };
}

/* ---------- assistant: facts / evidence / COMPUTED analysis (no LLM offline) ---------- */
function localAssist(kind, id, question) {
  const rec = kind === 'transaction' ? (txnOf(id) && projectTxn(txnOf(id))) : (S.cases.find((c) => c.id === id) && projectCase(S.cases.find((c) => c.id === id)));
  if (!rec) { const e = new Error(`${kind === 'transaction' ? 'Transaction' : 'Case'} not found`); e.status = 404; throw e; }
  const facts = kind === 'transaction' ? describeTxn(rec) : describeCase(rec), own = `${kind}:${id}`;
  const items = localEvidence(facts + (question ? ' ' + question : ''), 6, [], own); items.forEach((e, i) => { e.evidence_id = `E${i + 1}`; });
  const f = (statement, ev = []) => ({ statement, evidence_ids: ev, grounded: ev.length > 0 });
  const expl = [], sim = [], steps = [], cav = ['Computed by deterministic rules over the memory graph in this offline demo - not a model. Connect the live backend to get LLM-written analysis from the same evidence.'];
  if (kind === 'transaction') {
    if (rec.detection_reasons.length) expl.push(f(`Detection reasons recorded at scoring time: ${rec.detection_reasons.slice(0, 3).join('; ')}.`));
    expl.push(f(`Score ${Math.round(rec.fraud_score)}/100 (${rec.risk_level}) against review thresholds ${CFG.policy.medium_threshold}/${CFG.policy.high_threshold}.`));
    const a = adj(), tn = `Transaction:${id}`, dev = [...(a.get(tn) || [])].find((x) => MEM.nodes.get(x)?.type === 'Device');
    const others = dev ? [...new Set([...(a.get(dev) || [])].filter((t) => t !== tn && MEM.nodes.get(t)?.type === 'Transaction').flatMap((t) => [...a.get(t)].filter((c) => MEM.nodes.get(c)?.type === 'Customer')))].filter((c) => !(a.get(tn) || new Set()).has(c)) : [];
    if (others.length) { const ev = items.filter((e) => e.connected.some((c) => c.label === rec.device_ref)).map((e) => e.evidence_id); sim.push(f(`Device ${rec.device_ref} is also used by ${others.length} other account(s): ${others.slice(0, 4).map((c) => MEM.nodes.get(c).label).join(', ')}.`, ev)); steps.push({ action: `Review the other account(s) on device ${rec.device_ref} for related activity`, rationale: 'A shared device is a lead, not proof - fingerprints are User-Agent hashes', evidence_ids: ev, grounded: ev.length > 0 }); }
    const same = items.filter((e) => e.connected.some((c) => c.type === 'Merchant' && c.label === rec.merchant)); const cf = same.filter((e) => e.properties.verdict === 'confirmed_fraud'), fp = same.filter((e) => e.properties.verdict === 'false_positive');
    if (same.length) sim.push(f(`${same.length} similar record(s) at ${rec.merchant}: ${cf.length} confirmed fraud, ${fp.length} false positive.`, same.map((e) => e.evidence_id)));
    const pats = new Set(rec.detection_reasons.map(patternLabel)); const shared = items.filter((e) => e.connected.some((c) => c.type === 'FraudPattern' && pats.has(c.label)) && !same.includes(e));
    if (shared.length) sim.push(f(`Detection pattern(s) also seen in ${shared.map((e) => e.evidence_id).join(', ')}.`, shared.map((e) => e.evidence_id)));
    items.filter((e) => e.source_type === 'investigation').slice(0, 2).forEach((e) => { sim.push(f(`Case #${e.source_id} (${e.properties.outcome || e.properties.status}) is a related precedent${e.properties.outcome_note ? ': ' + e.properties.outcome_note : ''}.`, [e.evidence_id])); steps.push({ action: `Compare with case #${e.source_id} and reuse its remediation if it fits`, rationale: 'Closest historical case retrieved from memory', evidence_ids: [e.evidence_id], grounded: true }); });
    if (items.some((e) => e.properties.verdict === 'confirmed_fraud')) steps.push({ action: 'Treat as a likely repeat of a confirmed pattern: prioritise review and consider holding related transactions', rationale: 'Retrieved precedents include confirmed fraud', evidence_ids: items.filter((e) => e.properties.verdict === 'confirmed_fraud').map((e) => e.evidence_id).slice(0, 3), grounded: true });
    else if (fp.length) steps.push({ action: 'Verify with the customer before blocking - similar past records were false positives', rationale: 'Retrieved precedents were cleared', evidence_ids: fp.map((e) => e.evidence_id), grounded: true });
    if (!items.length) steps.push({ action: 'No similar history found: treat as a new pattern and consider step-up verification', rationale: 'Nothing comparable in memory (or memory is not synced yet)', evidence_ids: [], grounded: false });
    if (!rec.investigation_id) steps.push({ action: 'If confirmed, attach it to a case so the outcome is remembered', rationale: 'Not yet part of an investigation', evidence_ids: [], grounded: false });
  } else {
    expl.push(f(`Case "${rec.title}" is ${rec.status} (${rec.outcome || 'no outcome yet'}), covering ${rec.transaction_ids.length} transaction(s) across ${rec.customer_refs.length} account(s).`));
    items.slice(0, 3).forEach((e) => sim.push(f(`${e.source_type === 'investigation' ? 'Case' : 'Transaction'} #${e.source_id} is related (${e.properties.outcome || e.properties.verdict || e.properties.risk_level}).`, [e.evidence_id])));
    steps.push({ action: rec.outcome ? 'Check that the remediation recorded on the case was applied to every linked account' : 'Record an outcome and remediation note so future cases can learn from this one', rationale: 'Case memory is only as useful as the notes in it', evidence_ids: [], grounded: false });
  }
  return { subject: { kind, source_id: String(id), facts, label: 'Current FraudGuard record facts (from the demo database, pseudonymised)' }, evidence: { label: 'Retrieved from the in-browser memory graph - historical records, not generated', items },
    ai: { label: 'Computed by rules over the graph (offline demo, no LLM) - verify against the evidence', generated: false, explanation: expl, similar_patterns: sim, suggested_steps: steps, caveats: cav }, ai_status: 'ok' };
}
const fakeStats = () => {
  const a = adj(), cnt = (t) => [...MEM.nodes.values()].filter((n) => n.type === t).length, by = (s, st) => [...MEM.records].filter(([k, v]) => k.startsWith(s) && v.status === st).length, last = MEM.runs[0] || null;
  const pend = S.txns.filter((t) => !t.synthetic && t.id > MEM.cursor).length, ok = MEM.runs.find((r) => r.status === 'completed');
  return { sync: { running: MEM.running, scheduler: { enabled: MEM.auto, intervalMs: 15000 }, records: { transaction: { synced: by('transaction', 'synced'), failed: by('transaction', 'failed') }, investigation: { synced: by('investigation', 'synced'), failed: 0 } }, pendingNewTransactions: pend, lastRun: last, lastSuccessfulSyncAt: ok ? ok.finishedAt : null },
    memory: { dataset: 'in-browser-demo', nodes_total: MEM.nodes.size, edges_total: MEM.edges.size, structured_entities: Object.fromEntries(['Transaction', 'Investigation', 'Customer', 'Merchant', 'Device', 'FraudPattern'].map((t) => [t, cnt(t)])), suspicious_devices: [...MEM.nodes.values()].filter((n) => n.type === 'Device' && signals(n.id, a).suspicious).length, narrative_documents: MEM.docs.size, cognify: { status: 'n/a (offline demo)' } } };
};

/* ---------- API facade: same data shapes from the in-browser engine or from a real backend ---------- */
const liveCall = async (method, path, body) => {
  const r = await fetch(`${MEM.live.base}/cognee-memory${path}`, { method, headers: { Authorization: `Bearer ${MEM.live.token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({})); if (!r.ok) throw Object.assign(new Error(j.error || j.message || `HTTP ${r.status}`), { status: r.status }); return j;
};
const guard = (fn) => new Promise((res, rej) => { try { res(fn()); } catch (e) { rej(e); } });
const MEMAPI = {
  health: () => (MEM.live ? liveCall('GET', '/health') : Promise.resolve({ configured: true, reachable: true, status: 'ok', service: { status: 'ok', llm_configured: false, narrative_layer: 'offline demo engine', cognee_version: 'in-browser demo', checks: { graph_store: { ok: true }, vector_store: { ok: true } } } })),
  stats: () => (MEM.live ? liveCall('GET', '/stats') : Promise.resolve(fakeStats())),
  runs: () => (MEM.live ? liveCall('GET', '/sync/runs?limit=8').then((r) => r.runs) : Promise.resolve(MEM.runs.slice(0, 8))),
  sync: (b) => (MEM.live ? liveCall('POST', '/sync', b) : guard(() => runSyncLocal(b))),
  search: (b) => (MEM.live ? liveCall('POST', '/search', b) : guard(() => ({ evidence: { label: 'Retrieved from the in-browser memory graph - historical records, not generated', items: localEvidence(b.query, b.topK, b.sourceTypes || []) }, answer: null }))),
  entities: (p) => (MEM.live ? liveCall('GET', `/entities?${new URLSearchParams({ ...(p.type ? { type: p.type } : {}), ...(p.q ? { q: p.q } : {}), suspiciousOnly: String(!!p.suspiciousOnly), limit: 25 })}`) : guard(() => localEntities(p))),
  related: (id) => (MEM.live ? liveCall('GET', `/entities/${encodeURIComponent(id)}/related?depth=2`) : guard(() => localRelated(id, 2))),
  assist: (b) => (MEM.live ? liveCall('POST', '/assistant', b) : guard(() => localAssist(b.kind, b.id, b.question))),
};
