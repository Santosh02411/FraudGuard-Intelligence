/* ---------- AI Memory UI (renders the same shapes whether data comes from the offline engine or a live backend) ---------- */
const MCOL = { Customer: '#22d3ee', Merchant: '#fbbf24', Device: '#f87171', FraudPattern: '#a78bfa', Transaction: '#94a3b8', Investigation: '#34d399' };
const mfmt = (v) => (v ? new Date(v).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—');
const mErr = (e) => `<div class="err-box" role="alert">${esc(e.message || e)}</div>`;
const verdictBdg = (v) => (v ? `<span class="bdg ${v === 'confirmed_fraud' ? 'hi' : 'ok'}">${esc(String(v).replace('_', ' '))}</span>` : '');
const evUrl = (u) => `#${u}`;

function evCard(e) {
  const tx = e.source_type === 'transaction', lv = e.live || {}, p = e.properties || {};
  return `<div class="card" style="margin:0 0 10px;padding:12px" data-testid="evidence-${esc(e.source_key)}">
    <div class="row" style="gap:8px;flex-wrap:wrap">${e.evidence_id ? `<span class="chip mono" style="color:#67e8f9">${esc(e.evidence_id)}</span>` : ''}<b>${tx ? 'Transaction #' : 'Case #'}${esc(e.source_id)}</b>
      ${p.risk_level ? bdgRisk(p.risk_level) : ''}${verdictBdg(p.verdict || p.outcome)}${e.relevance != null ? `<span class="chip">match ${Math.round(e.relevance * 100)}%</span>` : ''}
      ${lv.memoryOutOfDate ? '<span class="bdg me">changed since last sync</span>' : ''}${lv.exists === false ? '<span class="bdg me">record no longer exists</span>' : ''}
      <span style="margin-left:auto" class="row">${lv.exists && lv.url ? `<a href="${evUrl(lv.url)}">Open record</a>` : ''}<a data-act="memAssistOn" data-arg="${esc(e.source_type)}:${esc(e.source_id)}">Ask assistant</a></span></div>
    <p style="white-space:pre-line;margin:8px 0 0;color:var(--mut)">${esc(e.snippet)}</p>
    ${(e.connected || []).length ? `<div class="row" style="flex-wrap:wrap;gap:5px;margin-top:8px">${e.connected.map((c) => `<span class="chip"><i style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${MCOL[c.type] || '#888'};margin-right:5px"></i>${esc(c.type)}: <span class="mono">${esc(c.label)}</span></span>`).join('')}</div>` : ''}
    <div class="hint" style="margin-top:6px">Matched via ${esc((e.matched_via || []).join(', ').replace(/_/g, ' '))}</div></div>`;
}
const layer = (color, badge, label, inner, aria) => `<section class="card" aria-label="${aria}" style="border-color:${color}55;background:${color}0d"><div class="row" style="gap:8px;margin-bottom:8px"><span class="bdg" style="background:${color}33;color:${color}">${badge}</span><span class="hint">${esc(label || '')}</span></div>${inner}</section>`;
const evidenceBlock = (ev, empty) => layer('#22d3ee', 'RETRIEVED EVIDENCE', ev.label, (ev.items || []).length ? ev.items.map(evCard).join('') : `<p class="dim">${empty || 'No similar historical records were found.'}</p>`, 'Retrieved evidence');

function aiBlock(ai) {
  const cite = (ids) => (ids || []).map((i) => `<span class="chip mono" style="color:#67e8f9;padding:0 5px">${esc(i)}</span>`).join(' ');
  const li = (f) => `<li>${esc(f.statement)} ${cite(f.evidence_ids)}${f.grounded ? '' : ' <span class="hint">(from this record only)</span>'}</li>`;
  const sec = (t, inner) => (inner ? `<h4 style="margin:12px 0 4px;font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:#c4b5fd">${t}</h4>${inner}` : '');
  const badge = ai.generated ? 'AI-GENERATED' : 'COMPUTED (NO LLM)';
  return layer('#a78bfa', badge, ai.label,
    sec('Why this looks suspicious', ai.explanation?.length ? `<ul>${ai.explanation.map(li).join('')}</ul>` : '') + sec('Similar historical patterns', ai.similar_patterns?.length ? `<ul>${ai.similar_patterns.map(li).join('')}</ul>` : '')
    + sec('Suggested investigation steps', ai.suggested_steps?.length ? `<ol>${ai.suggested_steps.map((s) => `<li>${esc(s.action)} ${cite(s.evidence_ids)}${s.rationale ? `<div class="hint">${esc(s.rationale)}</div>` : ''}</li>`).join('')}</ol>` : '')
    + (ai.caveats?.length ? `<div class="hint" style="margin-top:10px;border-top:1px solid var(--line2);padding-top:8px">Caveats: ${ai.caveats.map(esc).join(' · ')}</div>` : ''), 'AI-generated suggestions');
}

function memHealthBar(h) {
  if (!h.configured) return '<div class="warn" role="status"><b>Cognee is not configured.</b> Set COGNEE_SERVICE_URL and COGNEE_SERVICE_API_KEY in backend/.env.</div>';
  if (!h.reachable) return `<div class="err-box" role="alert">The Cognee service is configured but not reachable: ${esc(h.error?.message || 'unknown error')}.</div>`;
  const s = h.service || {}, bad = Object.entries(s.checks || {}).filter(([, c]) => !c.ok).map(([n]) => n.replace('_', ' '));
  return `<div class="row" style="flex-wrap:wrap;gap:8px" aria-label="Integration health"><span class="pill ${h.status === 'ok' ? 'live' : ''}"><i class="dot"></i>${MEM.live ? 'Cognee service' : 'Memory engine'} ${h.status === 'ok' ? 'healthy' : 'degraded' + (bad.length ? ': ' + bad.join(', ') + ' failing' : '')}</span>
    <span class="pill">LLM: ${s.llm_configured ? 'configured' : MEM.live ? 'not configured (graph + vector search only)' : 'none in the offline demo'}</span><span class="pill">Narrative memory: ${esc(String(s.narrative_layer || 'n/a').replace(/_/g, ' '))}</span><span class="pill">${esc(s.cognee_version ? (MEM.live ? 'Cognee ' : '') + s.cognee_version : '')}</span></div>`;
}

async function memOverview() {
  const [h, st, runs] = await Promise.all([MEMAPI.health(), MEMAPI.stats().catch(() => null), MEMAPI.runs().catch(() => [])]);
  const m = st && st.memory && !st.memory.unavailable ? st.memory : null, ent = m?.structured_entities || {}, sy = st?.sync, v = (x) => (m ? Number(x ?? 0).toLocaleString() : '—');
  const sync = sy ? `<div class="grid g4" style="margin:10px 0">${stat('Last successful sync', sy.lastSuccessfulSyncAt ? mfmt(sy.lastSuccessfulSyncAt) : 'Never', 'activity')}${stat('Waiting to sync', `${sy.pendingNewTransactions ?? '—'} new txns`, 'list')}${stat('Scheduler', sy.scheduler?.intervalMs > 0 && sy.scheduler?.enabled ? `every ${Math.round(sy.scheduler.intervalMs / 1000)} s` : 'off (manual)', 'radio')}${stat('Synced / failed', `${(sy.records?.transaction?.synced || 0) + (sy.records?.investigation?.synced || 0)} / ${(sy.records?.transaction?.failed || 0) + (sy.records?.investigation?.failed || 0)}`, 'check')}</div>` : '';
  const rows = (runs || []).map((r) => `<tr><td>${mfmt(r.startedAt)}</td><td>${r.trigger === 'scheduler' ? 'scheduled' : 'manual' + (r.actor ? ' (' + esc(r.actor) + ')' : '')}${r.mode === 'full' ? ' · full' : ''}</td><td>${esc(String(r.status).replace(/_/g, ' '))}${r.error ? `<div class="hint" style="color:#fca5a5">${esc(r.error)}</div>` : ''}</td><td class="num">${r.ingested}</td><td class="num">${r.skippedUnchanged}</td><td class="num">${r.failed}</td></tr>`).join('');
  const off = !MEM.live;
  return `${memHealthBar(h)}
  <div class="grid g4" style="margin:14px 0">${stat('Graph entities', v(m?.nodes_total), 'net')}${stat('Relationships', v(m?.edges_total), 'trend')}${stat('Transactions remembered', v(ent.Transaction), 'list')}${stat('Cases remembered', v(ent.Investigation), 'folder')}
    ${stat('Customer accounts', v(ent.Customer), 'user')}${stat('Merchants', v(ent.Merchant), 'dollar')}${stat('Devices (suspicious)', m ? `${ent.Device ?? 0} (${m.suspicious_devices ?? 0})` : '—', 'alert', m?.suspicious_devices ? 'red' : '')}${stat('Fraud patterns', v(ent.FraudPattern), 'activity')}</div>
  <div class="card"><div class="row" style="justify-content:space-between;flex-wrap:wrap;gap:10px"><div><h2 style="font-size:16px">Synchronisation</h2><p class="hint" style="margin:2px 0 0">Read-only copy of minimised, pseudonymised records. Unchanged records are never re-sent.</p></div>
    <div class="row" style="gap:8px"><button class="btn pri" id="mem-sync" data-act="memSync" data-arg="incremental">Sync now</button><button class="btn" data-act="memSync" data-arg="full" title="Re-checks every record; only changed ones are sent">Full re-scan</button></div></div>
    ${sync}<div id="mem-msg" role="status"></div>
    ${off ? `<div class="row" style="gap:16px;flex-wrap:wrap;margin:6px 0"><label class="row" style="gap:6px"><input type="checkbox" ${MEM.auto ? 'checked' : ''} data-act="memAuto"> Auto-sync every 15 s (demo scheduler)</label><label class="row" style="gap:6px"><input type="checkbox" ${MEM.outage ? 'checked' : ''} data-act="memOutage"> Simulate a Cognee outage</label></div><div class="hint">Try it: sync once → resolve an alert or submit a transaction in the Simulator → sync again. Only the changed records are re-sent.</div>` : ''}
    <h3 style="font-size:14px;margin:14px 0 6px">Recent ingestion activity</h3>${rows ? `<div class="tw"><table><thead><tr><th>When</th><th>Trigger</th><th>Status</th><th class="num">Sent</th><th class="num">Unchanged</th><th class="num">Failed</th></tr></thead><tbody>${rows}</tbody></table></div>` : '<p class="dim">No synchronisation has run yet - click “Sync now”.</p>'}</div>
  <div class="info" style="margin-top:12px"><b>Privacy and scope.</b> Read-only: demo data is never modified. Customer accounts and devices become keyed HMAC pseudonyms (<span class="mono">acct_…</span> / <span class="mono">dev_…</span>); IP addresses, emails, card details and credentials are never included, and analyst notes are redacted first. Pseudonymisation is not anonymisation. Search results are an investigative aid, never a fraud decision.</div>`;
}

const kindOpts = (sel) => ['all|Transactions and cases', 'transaction|Transactions only', 'investigation|Cases only'].map((o) => { const [v, l] = o.split('|'); return `<option value="${v}" ${sel === v ? 'selected' : ''}>${l}</option>`; }).join('');
const EXAMPLES = ['accounts that shared a device and were confirmed fraud', 'card testing with many small purchases', 'cases closed as confirmed fraud and how they were remediated', 'crypto or wire transfer at a high-risk location'];
function memSearchBody() {
  return `<div class="card"><label class="f" for="mem-q"><b>Ask the fraud history</b></label><textarea id="mem-q" rows="2" maxlength="1000" placeholder="e.g. Have we seen a shared device across several accounts before?">${esc(MEMUI.q)}</textarea>
    <div class="row" style="flex-wrap:wrap;gap:6px;margin:8px 0">${EXAMPLES.map((x) => `<button class="btn sm" data-act="memExample" data-arg="${esc(x)}">${esc(x)}</button>`).join('')}</div>
    <div class="row" style="gap:12px;flex-wrap:wrap"><select id="mem-kind" aria-label="Record type" style="width:auto">${kindOpts(MEMUI.kind)}</select>${MEM.live ? `<label class="row" style="gap:6px"><input type="checkbox" id="mem-ans" ${MEMUI.ans ? 'checked' : ''}> Also generate a summary (uses the LLM)</label>` : ''}<button class="btn pri" style="margin-left:auto" data-act="memSearch">Search memory</button></div></div><div id="mem-res" style="margin-top:12px"></div>`;
}
function memAssistBody() {
  const cands = S.txns.filter((t) => !t.synthetic && t.risk_level !== 'low').slice(0, 12);
  return `<div class="card"><b>Investigation assistant</b><p class="hint">Explains a record using the demo's own data and similar history from memory. Three layers are always shown separately: current facts, retrieved evidence, and ${MEM.live ? 'AI-generated' : 'computed (no LLM offline)'} suggestions.</p>
    <div class="row" style="gap:10px;flex-wrap:wrap"><select id="mem-akind" aria-label="Record kind" style="width:auto"><option value="transaction" ${MEMUI.aKind === 'transaction' ? 'selected' : ''}>Transaction</option><option value="investigation" ${MEMUI.aKind === 'investigation' ? 'selected' : ''}>Case</option></select>
      <input id="mem-aid" list="mem-cands" inputmode="numeric" placeholder="Record #" aria-label="Record number" value="${esc(MEMUI.aId)}" style="width:130px"><datalist id="mem-cands">${cands.map((t) => `<option value="${t.id}">${esc(t.merchant)} · score ${t.fraud_score}</option>`).join('')}${S.cases.map((c) => `<option value="${c.id}">case: ${esc(c.title)}</option>`).join('')}</datalist></div>
    <input id="mem-aq" maxlength="1000" placeholder="Optional: e.g. Is this part of a ring?" aria-label="Optional question" value="${esc(MEMUI.aQ)}" style="margin-top:8px"><div style="margin-top:8px"><button class="btn pri" data-act="memAssist">Investigate</button></div></div><div id="mem-ares" style="margin-top:12px"></div>`;
}
function memGraphBody() {
  return `<div class="grid g2" style="align-items:start"><div class="card"><div class="row" style="gap:8px;flex-wrap:wrap"><select id="mem-gt" aria-label="Entity type" style="width:auto">${['Device', 'Customer', 'Merchant', 'FraudPattern', 'Transaction', 'Investigation'].map((t) => `<option ${MEMUI.gType === t ? 'selected' : ''}>${t}</option>`).join('')}</select><input id="mem-gq" aria-label="Filter entities" placeholder="Filter…" value="${esc(MEMUI.gQ)}" style="flex:1;min-width:110px"></div>
    <label class="row" style="gap:6px;margin:8px 0"><input type="checkbox" id="mem-gs" ${MEMUI.gSus ? 'checked' : ''}> Suspicious devices only (shared across accounts or tied to confirmed fraud)</label><div id="mem-glist" style="max-height:380px;overflow:auto"></div></div><div class="card" id="mem-ggraph"><p class="dim" style="text-align:center;padding:40px 10px">Select an entity to see its connected customers, merchants, devices, patterns and cases.</p></div></div>`;
}
function memGraphSvg(g) {
  const S_ = 460, C = S_ / 2, lv = new Map(); g.nodes.forEach((n) => (lv.get(n.level) || lv.set(n.level, []).get(n.level)).push(n));
  const pos = new Map(); for (const [l, list] of lv) list.forEach((n, i) => { if (l === 0) pos.set(n.id, [C, C]); else { const r = 85 + (l - 1) * 80, a = (2 * Math.PI * i) / list.length - Math.PI / 2; pos.set(n.id, [C + r * Math.cos(a), C + r * Math.sin(a)]); } });
  return `<svg viewBox="0 0 ${S_} ${S_}" role="img" aria-label="Entity graph: ${g.nodes.length} entities, ${g.edges.length} relationships" style="width:100%;max-width:520px;display:block;margin:auto">${g.edges.map((e) => { const a = pos.get(e.source), b = pos.get(e.target); return a && b ? `<line x1="${a[0]}" y1="${a[1]}" x2="${b[0]}" y2="${b[1]}" stroke="#475569"><title>${esc(e.relation.replace(/_/g, ' '))}</title></line>` : ''; }).join('')}
    ${g.nodes.map((n) => { const p = pos.get(n.id); if (!p) return ''; const sus = n.signals?.suspicious; return `<g transform="translate(${p[0]},${p[1]})" data-act="memGraphOpen" data-arg="${esc(n.id)}" style="cursor:pointer"><circle r="${n.level === 0 ? 15 : 10}" fill="${MCOL[n.type]}" stroke="${sus ? '#ef4444' : n.level === 0 ? '#fff' : 'none'}" stroke-width="${sus ? 3 : 2}"/><title>${esc(n.type + ': ' + n.label + (sus ? ' — shared across accounts / tied to confirmed fraud' : ''))}</title><text y="${n.level === 0 ? 28 : 22}" text-anchor="middle" font-size="8.5" fill="#cbd5e1">${esc(n.label.length > 16 ? n.label.slice(0, 15) + '…' : n.label)}</text></g>`; }).join('')}</svg>
    <div class="row" style="flex-wrap:wrap;gap:10px;justify-content:center;margin-top:8px">${Object.keys(MCOL).map((t) => `<span class="hint"><i style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${MCOL[t]};margin-right:4px"></i>${t}</span>`).join('')}</div>`;
}
async function memGraphList() {
  const box = $('#mem-glist'); if (!box) return;
  try {
    const r = await MEMAPI.entities({ type: MEMUI.gType, q: MEMUI.gQ || undefined, suspiciousOnly: MEMUI.gSus });
    box.innerHTML = r.entities.length ? r.entities.map((e) => `<div class="clk" data-act="memGraphOpen" data-arg="${esc(e.id)}" style="padding:7px 4px;border-bottom:1px solid var(--line2);display:flex;gap:8px;align-items:center"><i style="width:9px;height:9px;border-radius:50%;background:${MCOL[e.type]};flex:none"></i><span class="mono" style="font-size:12px;overflow:hidden;text-overflow:ellipsis">${esc(e.label)}</span>${e.signals?.suspicious ? '<span class="bdg hi">suspicious</span>' : ''}<span class="hint" style="margin-left:auto;white-space:nowrap">${e.signals?.accounts ? e.signals.accounts + ' accts · ' : ''}${e.degree} links</span></div>`).join('') + `<div class="hint" style="padding-top:6px">${r.total} total</div>` : `<p class="dim">No ${esc(MEMUI.gType.toLowerCase())} entities in memory yet${MEM.live ? '' : ' — sync first'}.</p>`;
  } catch (e) { box.innerHTML = mErr(e); }
}

async function memHydrate() {
  const body = $('#mem-body'); if (!body || route().name !== 'memory') return;
  try {
    if (MEMUI.tab === 'overview') body.innerHTML = await memOverview();
    else if (MEMUI.tab === 'search') { body.innerHTML = memSearchBody(); if (MEMUI.lastRes) $('#mem-res').innerHTML = MEMUI.lastRes; }
    else if (MEMUI.tab === 'assistant') { body.innerHTML = memAssistBody(); if (MEMUI.lastA) $('#mem-ares').innerHTML = MEMUI.lastA; }
    else { body.innerHTML = memGraphBody(); memGraphList(); }
  } catch (e) { body.innerHTML = mErr(e); }
}
const MTABS = [['overview', 'Overview'], ['search', 'Search history'], ['assistant', 'Assistant'], ['graph', 'Entities & graph']];
V.memory = () => {
  queueMicrotask(memHydrate);
  return `${heading('brain', 'AI Memory / Fraud Intelligence', 'Memory of past transactions, cases and outcomes — search it, explore the entity graph, ask the assistant.', MEM.live ? '<button class="btn sm" data-act="memDisconnect">Disconnect live backend</button>' : '<button class="btn sm" data-act="memConnectOpen">Connect live backend (optional)</button>')}
  ${MEM.live ? `<div class="warn" role="status"><b>LIVE:</b> this screen is using the real backend at <span class="mono">${esc(MEM.live.base)}</span>. Requests and results leave your browser.</div>` : '<div class="info"><b>Offline demo engine.</b> Everything below runs in your browser on this demo’s synthetic data, using the same records, pseudonyms, hashes and graph as the real integration. Retrieval is TF-IDF instead of Cognee embeddings, and there is no LLM. Connect a live backend to use real Cognee.</div>'}
  <div class="tabs" role="tablist">${MTABS.map(([k, l]) => `<button class="tab ${MEMUI.tab === k ? 'on' : ''}" role="tab" aria-selected="${MEMUI.tab === k}" data-act="memTab" data-arg="${k}">${l}</button>`).join('')}</div><div id="mem-body" style="margin-top:12px"><p class="dim">Loading…</p></div>`;
};

const memFail = (e) => toast(esc(e.message || String(e)), 'bad');
Object.assign(ACT, {
  memTab(k) { MEMUI.tab = k; render(); },
  memExample(q) { MEMUI.q = q; const el = $('#mem-q'); if (el) el.value = q; },
  async memSync(mode) {
    const msg = $('#mem-msg'), btn = $('#mem-sync'); if (btn) btn.disabled = true;
    try { const r = await MEMAPI.sync({ mode }); if (msg) msg.innerHTML = `<div class="${r.failed ? 'warn' : 'ok-box'}">Sync ${esc(String(r.status).replace(/_/g, ' '))}: ${r.ingested} sent, ${r.skippedUnchanged} unchanged${r.failed ? ', ' + r.failed + ' failed' : ''}${r.morePending ? ' — more pending, run again' : ''}.</div>`; toast(`Memory sync: ${r.ingested} sent, ${r.skippedUnchanged} unchanged`, 'ok'); }
    catch (e) { if (msg) msg.innerHTML = mErr(e); }
    if (route().name === 'memory' && MEMUI.tab === 'overview') { const keep = $('#mem-msg')?.innerHTML; await memHydrate(); const m2 = $('#mem-msg'); if (m2 && keep) m2.innerHTML = keep; }
  },
  memAuto() {
    MEM.auto = !MEM.auto; clearInterval(MEM.timer);
    if (MEM.auto) MEM.timer = setInterval(() => { try { runSyncLocal({ trigger: 'scheduler' }); } catch (e) { /* recorded in the run log */ } if (route().name === 'memory' && MEMUI.tab === 'overview') memHydrate(); }, 15000);
    toast(MEM.auto ? 'Auto-sync on (every 15 s)' : 'Auto-sync off', '');
  },
  memOutage() { MEM.outage = !MEM.outage; toast(MEM.outage ? 'Cognee outage simulated: the next sync will fail and retry later' : 'Cognee is back', MEM.outage ? 'warn' : 'ok'); },
  async memSearch() {
    const q = ($('#mem-q').value || '').trim(); MEMUI.q = q; MEMUI.kind = $('#mem-kind').value; MEMUI.ans = !!$('#mem-ans')?.checked; const box = $('#mem-res');
    if (q.length < 2) { box.innerHTML = mErr('Enter at least 2 characters.'); return; }
    box.innerHTML = '<p class="dim">Searching…</p>';
    try {
      const r = await MEMAPI.search({ query: q, topK: 8, sourceTypes: MEMUI.kind === 'all' ? [] : [MEMUI.kind], includeAnswer: MEMUI.ans });
      MEMUI.lastRes = (r.answer ? layer('#a78bfa', 'AI-GENERATED', r.answer.label, `<p style="white-space:pre-line">${esc(r.answer.text)}</p>`, 'AI-generated summary') : '') + evidenceBlock(r.evidence, MEM.live || MEM.records.size ? undefined : 'Memory is empty - open Overview and click “Sync now” first.');
      box.innerHTML = MEMUI.lastRes;
    } catch (e) { box.innerHTML = mErr(e); }
  },
  memAssistOn(arg) { const [k, id] = arg.split(':'); Object.assign(MEMUI, { tab: 'assistant', aKind: k, aId: id, lastA: '' }); render(); },
  async memAssist() {
    const kind = $('#mem-akind').value, id = Number($('#mem-aid').value), q = ($('#mem-aq').value || '').trim(), box = $('#mem-ares'); Object.assign(MEMUI, { aKind: kind, aId: $('#mem-aid').value, aQ: q });
    if (!Number.isInteger(id) || id < 1) { box.innerHTML = mErr('Enter a valid record number.'); return; }
    box.innerHTML = '<p class="dim">Investigating…</p>';
    try {
      const r = await MEMAPI.assist({ kind, id, ...(q ? { question: q } : {}) });
      const facts = layer('#9ca3af', 'CURRENT FACTS', r.subject.label, `<pre style="white-space:pre-wrap;margin:0;font:inherit;color:var(--mut)">${esc(r.subject.facts)}</pre>`, 'Current record facts');
      const aiPart = r.ai ? aiBlock(r.ai) : `<div class="info">${r.ai_status === 'llm_not_configured' ? 'No LLM is configured for the Cognee service, so only retrieved evidence is shown.' : 'The LLM call failed; the evidence above is still valid.'}</div>`;
      MEMUI.lastA = `<div class="col" style="gap:12px">${facts}${evidenceBlock(r.evidence, 'No similar historical records were found — this may be a new pattern, or memory may not be synced yet.')}${aiPart}</div>`; box.innerHTML = MEMUI.lastA;
    } catch (e) { box.innerHTML = mErr(e); }
  },
  memGraphOpen(id) { MEMAPI.related(id).then((g) => { $('#mem-ggraph').innerHTML = memGraphSvg(g) + (g.truncated ? '<p class="hint" style="text-align:center">Showing a subset of connections.</p>' : ''); }).catch((e) => { $('#mem-ggraph').innerHTML = mErr(e); }); },
  memConnectOpen() {
    openModal(`<h2 style="font-size:18px">Connect a live backend</h2><p class="hint">Uses the real <span class="mono">/cognee-memory</span> API (real Cognee). Paste a short-lived <b>admin</b> access token; it is kept in memory only (never saved) and sent only to the URL below. The backend must allow this page’s origin in <span class="mono">CORS_ALLOWED_ORIGINS</span> - serve this file over http (e.g. <span class="mono">python -m http.server</span>), not file://.</p>
      <div class="col">${field('API base URL', '<input id="lv-url" value="http://localhost:5000/api/v1">', '')}${field('Admin access token', '<textarea id="lv-tok" rows="3" placeholder="eyJ…" autocomplete="off"></textarea>', '')}<div id="lv-err"></div><div class="row"><button class="btn pri" data-act="memConnect">Connect</button><button class="btn" onclick="closeModal()">Cancel</button></div></div>`);
  },
  async memConnect() {
    const base = $('#lv-url').value.trim().replace(/\/+$/, ''), token = $('#lv-tok').value.trim(); if (!/^https?:\/\//.test(base) || !token) { $('#lv-err').innerHTML = mErr('Enter an http(s) URL and a token.'); return; }
    MEM.live = { base, token }; try { const h = await liveCall('GET', '/health'); if (!h.configured) throw new Error('Connected, but the backend says Cognee is not configured.'); closeModal(); Object.assign(MEMUI, { lastRes: '', lastA: '' }); render(); toast('Connected to the live backend', 'ok'); }
    catch (e) { MEM.live = null; $('#lv-err').innerHTML = mErr(/Failed to fetch|NetworkError/.test(e.message) ? 'Could not reach the backend (network or CORS). Check the URL and CORS_ALLOWED_ORIGINS.' : e); }
  },
  memDisconnect() { MEM.live = null; Object.assign(MEMUI, { lastRes: '', lastA: '' }); render(); toast('Back to the offline demo engine', ''); },
});
document.addEventListener('change', (e) => {
  if (e.target.id === 'mem-gt') { MEMUI.gType = e.target.value; memGraphList(); }
  if (e.target.id === 'mem-gs') { MEMUI.gSus = e.target.checked; memGraphList(); }
  if (e.target.id === 'mem-kind') MEMUI.kind = e.target.value;
});
document.addEventListener('input', (e) => { if (e.target.id === 'mem-gq') { MEMUI.gQ = e.target.value; clearTimeout(MEMUI.gt); MEMUI.gt = setTimeout(memGraphList, 200); } });
const _reset = ACT.reset, _logout = ACT.logout;
const memClear = () => { clearInterval(MEM.timer); Object.assign(MEM, { records: new Map(), cursor: 0, runs: [], nextRun: 1, nodes: new Map(), edges: new Map(), docs: new Map(), index: null, auto: false, timer: null, outage: false, running: false, secret: hex(32) }); Object.assign(MEMUI, { lastRes: '', lastA: '' }); };
ACT.reset = function () { memClear(); return _reset.apply(this, arguments); };
ACT.logout = function () { clearInterval(MEM.timer); MEM.auto = false; MEM.live = null; return _logout.apply(this, arguments); };
