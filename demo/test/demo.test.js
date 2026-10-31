const crypto = require("crypto");
const assert = require("assert");
const { load } = require("./harness");
let pass = 0;
const t = async (name, fn) => {
  try {
    await fn();
    pass++;
    console.log("  ✓", name);
  } catch (e) {
    const loc = (
      e.stack.split("\n").find((l) => l.includes("demo.test.js")) || ""
    ).trim();
    console.log("  ✗", name, "\n     ", e.message.split("\n")[0], loc);
    process.exitCode = 1;
  }
};

(async () => {
  const d = await load();
  const { ev, tick, click, w } = d;
  await t("page boots without script errors and shows the login", async () => {
    assert.deepStrictEqual(d.errors, []);
    assert(d.text().includes("Sign in"));
  });

  await t(
    "SHA-256 and HMAC match Node crypto (ascii, unicode, >64 bytes, empty)",
    async () => {
      for (const s of [
        "",
        "abc",
        "héllo wörld ✓ 日本語",
        "x".repeat(200),
        "The quick brown fox jumps over the lazy dog".repeat(5),
      ]) {
        assert.strictEqual(
          ev(`sha256(${JSON.stringify(s)})`),
          crypto.createHash("sha256").update(s).digest("hex"),
          `sha256 of ${s.slice(0, 10)}`,
        );
      }
      for (const [k, m] of [
        ["key", "message"],
        ["k".repeat(100), "long key"],
        ["", "x"],
      ])
        assert.strictEqual(
          ev(`hmacSha256(${JSON.stringify(k)}, ${JSON.stringify(m)})`),
          crypto.createHmac("sha256", k).update(m).digest("hex"),
        );
    },
  );

  ev("ACT.login('admin')");
  await tick();
  const go = async (h) => {
    w.location.hash = h;
    await tick(60);
  };
  await go("#/memory");

  await t(
    "AI Memory is in the admin nav and renders before any sync",
    async () => {
      assert(d.text().includes("AI Memory / Fraud Intelligence"));
      assert(d.text().includes("No synchronisation has run yet"));
      assert.strictEqual(ev("MEM.nodes.size"), 0);
    },
  );

  const realTx = ev("S.txns.filter((t) => !t.synthetic).length"),
    cases = ev("S.cases.length");
  await t(
    "first sync ingests every real transaction and case; cursor advances",
    async () => {
      const r = await ev("MEMAPI.sync({ mode: 'incremental' })");
      assert.strictEqual(r.status, "completed");
      assert.strictEqual(
        r.ingested,
        realTx + cases,
        `ingested ${r.ingested} vs ${realTx + cases}`,
      );
      assert(ev("MEM.cursor") > 0);
      assert(ev("MEM.nodes.size") > realTx);
    },
  );
  await t(
    "an immediate second sync sends NOTHING (dedup by content hash)",
    async () => {
      const r = await ev("MEMAPI.sync({ mode: 'incremental' })");
      assert.strictEqual(r.ingested, 0);
      assert(r.skippedUnchanged > 0);
      const f = await ev("MEMAPI.sync({ mode: 'full' })");
      assert.strictEqual(f.ingested, 0);
    },
  );
  await t(
    "resolving ONE alert re-sends exactly that transaction (and nothing else)",
    async () => {
      const id = ev(
        "(() => { const a = S.alerts.find((x) => x.status !== 'resolved'); a.status = 'resolved'; a.outcome = 'confirmed_fraud'; a.notes.push({ at: Date.now(), who: 'admin', text: 'Customer confirmed theft; contact a@b.com' }); return a.transaction_id; })()",
      );
      const before = ev('MEM.records.get("transaction:' + id + '").hash');
      const r = await ev("MEMAPI.sync({ mode: 'incremental' })");
      assert.strictEqual(
        r.ingested >= 1 && r.ingested <= 2,
        true,
        `ingested ${r.ingested}`,
      ); // the txn (+ its case if it belongs to one)
      assert.notStrictEqual(
        ev('MEM.records.get("transaction:' + id + '").hash'),
        before,
      );
      assert(
        !ev('MEM.nodes.get("Transaction:' + id + '").summary').includes(
          "a@b.com",
        ),
        "email must be redacted",
      );
      assert(
        ev('MEM.nodes.get("Transaction:' + id + '").summary').includes(
          "confirmed_fraud",
        ),
      );
    },
  );
  await t(
    "a newly submitted transaction is picked up incrementally",
    async () => {
      const before = ev("S.txns.length");
      ev(
        "submitTxn({ user_id: S.users[0].id, amount: 777, merchant: 'Casino Vegas', category: 'gambling', location: 'Lagos, NG', card_type: 'credit', device: 'dev-new-xyz', ip: '203.0.113.9' })",
      );
      assert.strictEqual(ev("S.txns.length"), before + 1);
      const r = await ev("MEMAPI.sync({ mode: 'incremental' })");
      assert(r.ingested >= 1, `ingested ${r.ingested}`);
    },
  );
  await t(
    "an outage fails the run cleanly and the record is NOT lost afterwards",
    async () => {
      ev(
        "submitTxn({ user_id: S.users[1].id, amount: 55, merchant: 'Starbucks', category: 'food', location: 'New York, US', card_type: 'debit', device: 'dev-q', ip: '203.0.113.10' })",
      );
      ev("MEM.outage = true");
      const cur = ev("MEM.cursor");
      await assert.rejects(
        ev("MEMAPI.sync({ mode: 'incremental' })"),
        /unreachable/,
      );
      assert.strictEqual(ev("MEM.cursor"), cur);
      assert.strictEqual(ev("MEM.runs[0].status"), "failed");
      assert.strictEqual(ev("MEM.running"), false);
      ev("MEM.outage = false");
      const r = await ev("MEMAPI.sync({ mode: 'incremental' })");
      assert.strictEqual(r.ingested, 1);
    },
  );
  await t("concurrent runs are refused (409)", async () => {
    ev("MEM.running = true");
    await assert.rejects(ev("MEMAPI.sync({})"), /already in progress/);
    ev("MEM.running = false");
  });

  await t(
    "no raw identifiers anywhere in the memory (IPs, device fingerprints, usernames, emails)",
    async () => {
      const blob = ev(
        "JSON.stringify([...MEM.nodes.values()]) + JSON.stringify([...MEM.docs.values()]) + JSON.stringify([...MEM.edges.values()])",
      );
      for (const leak of [
        "198.51.100.23",
        "203.0.113.77",
        "dev-7f3a91c2",
        "dev-b20c44e1",
        "maria.k",
        "sara.analyst",
      ])
        assert(!blob.includes(leak), `leaked ${leak}`);
      assert(/acct_[a-f0-9]{24}/.test(blob) && /dev_[a-f0-9]{24}/.test(blob));
      assert.strictEqual(ev("pseud('account', 5)"), ev("pseud('account', 5)"));
      assert.notStrictEqual(
        ev("pseud('account', 5)"),
        ev("pseud('account', 6)"),
      );
    },
  );
  await t(
    "shared-device ring is detected as suspicious in the graph",
    async () => {
      const r = await ev(
        "MEMAPI.entities({ type: 'Device', suspiciousOnly: true })",
      );
      assert(r.entities.length >= 1, "no suspicious devices");
      assert(
        r.entities.every(
          (e) => e.signals.accounts >= 2 || e.signals.confirmed_fraud > 0,
        ),
      );
    },
  );
  await t(
    "related-entity graph returns real nodes/edges; unknown id is a 404",
    async () => {
      const dev = (
        await ev("MEMAPI.entities({ type: 'Device', suspiciousOnly: true })")
      ).entities[0];
      const g = await ev(`MEMAPI.related(${JSON.stringify(dev.id)})`);
      assert(g.nodes.length > 2 && g.edges.length > 1);
      assert(
        g.nodes.some((n) => n.type === "Customer") &&
          g.nodes.some((n) => n.type === "Transaction"),
      );
      await assert.rejects(ev("MEMAPI.related('nope')"), /not found/);
    },
  );

  await t(
    "natural-language search ranks relevant history first and cross-checks live records",
    async () => {
      const r = await ev(
        "MEMAPI.search({ query: 'crypto or wire transfer at a high-risk location', topK: 5 })",
      );
      assert(r.evidence.items.length >= 3);
      const top = r.evidence.items[0];
      assert(
        /crypto|wire|lagos|proxy|unknown/i.test(top.snippet),
        top.snippet.slice(0, 120),
      );
      assert(r.evidence.items.every((e) => e.live.exists === true));
      assert.strictEqual(r.answer, null);
      assert(
        r.evidence.items.every(
          (e, i, a) => !i || a[i - 1].relevance >= e.relevance,
        ),
      );
      const none = await ev("MEMAPI.search({ query: 'zzzz qqqq xxxx' })");
      assert.strictEqual(none.evidence.items.length, 0);
      const cases = await ev(
        "MEMAPI.search({ query: 'shared device pool accounts', sourceTypes: ['investigation'] })",
      );
      assert(
        cases.evidence.items.every((e) => e.source_type === "investigation"),
      );
    },
  );
  await t(
    'a record changed after sync is flagged "changed since last sync" in search results',
    async () => {
      const id = ev(
        "(() => { const a = S.alerts.find((x) => x.status !== 'resolved'); a.status = 'resolved'; a.outcome = 'false_positive'; return a.transaction_id; })()",
      );
      const r = await ev(
        `MEMAPI.search({ query: 'transaction ${id} ', topK: 25 })`,
      );
      const hit = r.evidence.items.find(
        (e) => e.source_key === "transaction:" + id,
      );
      assert(hit && hit.live.memoryOutOfDate === true);
    },
  );

  await t(
    "assistant keeps facts, retrieved evidence and computed analysis apart, with valid citations",
    async () => {
      const id = ev(
        "S.txns.filter((t) => !t.synthetic && t.risk_level === 'high' && t.scenario === 'ring')[0].id",
      );
      const r = await ev(`MEMAPI.assist({ kind: 'transaction', id: ${id} })`);
      assert(
        r.subject.facts.includes("Transaction " + id) &&
          !r.subject.facts.includes("198.51.100"),
      );
      assert(/not generated/.test(r.evidence.label));
      assert(
        r.evidence.items.every((e) => e.source_key !== "transaction:" + id),
        "subject is not its own precedent",
      );
      assert.strictEqual(r.ai.generated, false);
      assert(/no LLM/.test(r.ai.label));
      const ids = new Set(r.evidence.items.map((e) => e.evidence_id));
      for (const f of [
        ...r.ai.explanation,
        ...r.ai.similar_patterns,
        ...r.ai.suggested_steps,
      ])
        assert(
          f.evidence_ids.every((x) => ids.has(x)),
          "dangling citation",
        );
      assert(r.ai.suggested_steps.length >= 1);
      assert(r.ai.similar_patterns.every((f) => f.grounded));
      const c = await ev(
        `MEMAPI.assist({ kind: 'investigation', id: ${ev("S.cases[0].id")} })`,
      );
      assert(c.ai.explanation.length >= 1);
      await assert.rejects(
        ev("MEMAPI.assist({ kind: 'transaction', id: 99999999 })"),
        /not found/,
      );
    },
  );

  await t(
    "the UI renders all four tabs and the search/assistant/graph interactions work end to end",
    async () => {
      await go("#/memory");
      assert(d.text().includes("Graph entities"));
      assert(d.text().includes("Recent ingestion activity"));
      await click('[data-arg="search"]');
      assert(w.document.querySelector("#mem-q"));
      w.document.querySelector("#mem-q").value =
        "card testing with many small purchases";
      await click('[data-act="memSearch"]');
      await tick(40);
      assert(
        w.document.querySelectorAll('[data-testid^="evidence-"]').length >= 1,
        "no evidence cards rendered",
      );
      assert(
        w.document.querySelector('section[aria-label="Retrieved evidence"]'),
      );
      await click('[data-arg="assistant"]');
      w.document.querySelector("#mem-aid").value = String(
        ev(
          "S.txns.filter((t) => !t.synthetic && t.risk_level === 'high')[0].id",
        ),
      );
      await click('[data-act="memAssist"]');
      await tick(40);
      for (const label of [
        "Current record facts",
        "Retrieved evidence",
        "AI-generated suggestions",
      ])
        assert(
          w.document.querySelector(`section[aria-label="${label}"]`),
          label,
        );
      assert(d.text().includes("COMPUTED (NO LLM)"));
      assert(!d.text().includes("AI-GENERATED"));
      await click('[data-arg="graph"]');
      await tick(40);
      assert(
        w.document.querySelector('#mem-glist [data-act="memGraphOpen"]'),
        "entity list empty",
      );
      await click('#mem-glist [data-act="memGraphOpen"]');
      await tick(40);
      assert(w.document.querySelector('#mem-ggraph svg[role="img"]'));
      assert.deepStrictEqual(d.errors, [], d.errors.join("\n"));
    },
  );

  await t(
    '"Exit demo" links appear only when the app serves the demo under /demo/',
    async () => {
      const hosted = await load(undefined, "http://localhost:3100/demo/");
      assert(
        hosted.text().includes("Back to FraudGuard sign in"),
        "login screen should link back",
      );
      assert.strictEqual(
        hosted.w.document
          .querySelector('a[href="/login"]')
          .textContent.includes("Back"),
        true,
      );
      hosted.ev("ACT.login('admin')");
      await hosted.tick();
      assert(
        hosted.w.document.querySelector('.banner a[href="/login"]'),
        "banner should have Exit demo",
      );
      assert.deepStrictEqual(hosted.errors, []);
      for (const url of [
        "http://localhost/demo.html",
        "file:///tmp/fraudguard-demo.html",
        "http://localhost:3100/other/",
      ]) {
        const other = await load(undefined, url);
        assert(
          !other.text().includes("Exit demo") &&
            !other.text().includes("Back to FraudGuard sign in"),
          url,
        );
      }
    },
  );
  await t(
    "analysts cannot open AI Memory (RBAC) and reset clears memory",
    async () => {
      ev("ACT.role('analyst')");
      await tick();
      await go("#/memory");
      assert(!d.text().includes("AI Memory / Fraud Intelligence"));
      ev("ACT.role('admin')");
      await tick();
      ev("ACT.reset()");
      await tick(60);
      assert.strictEqual(ev("MEM.nodes.size"), 0);
      assert.strictEqual(ev("MEM.runs.length"), 0);
    },
  );
  console.log(`\n${pass} passed${process.exitCode ? ", SOME FAILED" : ""}`);
  process.exit(process.exitCode || 0);
})().catch((e) => {
  console.error("HARNESS ERROR", e);
  process.exit(2);
});
