/**
 * Test double for the Cognee memory service: a tiny in-memory implementation of the HTTP contract
 * served by cognee_service/ (ingest / search / entities / assistant / health / stats), installed as
 * global.fetch. It lets the backend's real sync, projection, hashing, retry and route code run
 * end-to-end without a Python process. The real service contract is exercised by cognee_service/tests.
 */
function installFakeCognee({ failIngest = 0, failKeys = [], unreachable = false, delayMs = 0 } = {}) {
  const state = { ingestCalls: [], store: new Map(), failIngest, failKeys: new Set(failKeys), unreachable, searches: [], assistant: [], headers: [], calls: 0 };
  const original = global.fetch;
  global.fetch = async (url, init = {}) => {
    state.calls += 1;
    const path = new URL(url).pathname + new URL(url).search;
    state.headers.push(init.headers || {});
    if (state.unreachable) throw new TypeError('fetch failed');
    const body = init.body ? JSON.parse(init.body) : undefined;
    const reply = (status, json) => ({ ok: status < 400, status, text: async () => JSON.stringify(json) });
    if (path === '/v1/health') return reply(200, { status: 'ok', llm_configured: true, narrative_layer: 'available', checks: { graph_store: { ok: true }, vector_store: { ok: true } }, cognee_version: 'test' });
    if (path === '/v1/stats') return reply(200, { dataset: 'fraudguard-test', nodes_total: state.store.size, edges_total: 0, structured_entities: { Transaction: [...state.store.keys()].filter((k) => k.startsWith('transaction:')).length }, cognify: { status: 'idle' } });
    if (path === '/v1/ingest') {
      state.ingestCalls.push(body);
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      if (state.failIngest > 0) { state.failIngest -= 1; return reply(503, { detail: 'busy' }); }
      const results = [...body.transactions, ...body.investigations].map((r) => {
        const key = `${r.source_type}:${r.source_id}`;
        if (state.failKeys.has(key)) return { source_key: key, status: 'failed', narrative: 'disabled', error: 'simulated record failure' };
        state.store.set(key, r);
        return { source_key: key, status: 'ingested', narrative: 'stored' };
      });
      return reply(200, { ingested: results.filter((r) => r.status === 'ingested').length, failed: results.filter((r) => r.status === 'failed').length, results, cognify: { status: 'idle' } });
    }
    if (path === '/v1/search') {
      state.searches.push(body);
      const hits = [...state.store.entries()].filter(([, r]) => JSON.stringify(r).toLowerCase().includes(body.query.toLowerCase().split(' ')[0])).slice(0, body.top_k);
      return reply(200, { evidence: hits.map(([key, r]) => ({ id: key, source_type: r.source_type, source_id: r.source_id, source_key: key, distance: 0.2, relevance: 0.8, matched_via: ['graph_summary_vector'], snippet: r.merchant || r.title || '', properties: { verdict: r.verdict ?? undefined, outcome: r.outcome ?? undefined, status: r.status }, connected: [] })), answer: body.include_answer ? { text: 'generated text', generated: true, source: 'cognee.GRAPH_COMPLETION' } : null, diagnostics: { retrieval: ['graph_summary_vector'] } });
    }
    if (path.startsWith('/v1/entities/') && path.includes('/related')) {
      if (path.includes('missing-entity')) return reply(404, { detail: 'Entity not found' });
      return reply(200, { center: 'x', nodes: [], edges: [], depth: 1 });
    }
    if (path.startsWith('/v1/entities')) return reply(200, { total: 0, entities: [] });
    if (path === '/v1/assistant') {
      state.assistant.push(body);
      return reply(200, { subject: { kind: body.subject.kind, source_id: body.subject.source_id, facts: body.subject.summary }, evidence: { label: 'Retrieved from Cognee memory - historical records, not generated', items: [] }, ai: null, ai_status: 'llm_not_configured' });
    }
    return reply(404, { detail: 'not found' });
  };
  return { state, restore: () => { global.fetch = original; } };
}
module.exports = { installFakeCognee };
