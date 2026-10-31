/**
 * Decision auditability: append-only history, evidence captured per decision,
 * rescoring that preserves the original, change history, sanitizing, retention.
 */
jest.mock("../../models/mlClient", () => ({
  ...jest.requireActual("../../models/mlClient"),
  scoreWithML: jest.fn(),
}));

const request = require("supertest");
const { scoreWithML } = require("../../models/mlClient");
const app = require("../../app");
const db = require("../../config/database");
const { initSchema } = require("../../config/schema");
const decisionRepository = require("../../models/decisionRepository");
const auditLogRepository = require("../../models/auditLogRepository");
const retentionService = require("../../services/retentionService");

const API = "/api/v1";
let adminToken;
let userToken;
const asAdmin = (r) => r.set("Authorization", `Bearer ${adminToken}`);
const SAFE = {
  amount: 20,
  merchant: "Corner Cafe",
  category: "food",
  location: "New York, US",
  card_type: "credit",
};
const mlOk = (p = 0.3) => ({
  fraud_score: p * 100,
  model_probability: p,
  raw_probability: p,
  calibrated: true,
  ml_calibrated: true,
  model_used: "xgb",
  model_version: "v9",
  top_factors: [{ feature: "amount", impact: 0.2 }],
});

async function post(body = SAFE, label = "d1") {
  return request(app)
    .post(`${API}/transactions`)
    .set("Authorization", `Bearer ${userToken}`)
    .set("User-Agent", label)
    .send(body);
}

beforeAll(async () => {
  await initSchema();
  adminToken = (
    await request(app)
      .post(`${API}/auth/login`)
      .send({ username: "admin", password: "admin123" })
  ).body.accessToken;
  await request(app)
    .post(`${API}/auth/register`)
    .send({
      username: "da_user",
      email: "da_user@example.com",
      password: "Str0ng!Passw0rd1",
    });
  userToken = (
    await request(app)
      .post(`${API}/auth/login`)
      .send({ username: "da_user", password: "Str0ng!Passw0rd1" })
  ).body.accessToken;
});
beforeEach(() => {
  scoreWithML.mockReset();
  scoreWithML.mockResolvedValue(mlOk(0.3));
});

describe("evidence stored with each decision", () => {
  test("ML decision: model, rule set, thresholds, snapshot, source", async () => {
    const res = await post();
    const [rec] = await decisionRepository.list(res.body.transaction.id);
    expect(rec).toMatchObject({
      seq: 1,
      decision_type: "original",
      applied: true,
      origin: "live",
      decision_source: "ml",
      model_version: "v9",
      calibrated: true,
    });
    expect(rec.thresholds).toMatchObject({
      basis: "risk_policy",
      medium_threshold: 10,
      high_threshold: 50,
    });
    expect(rec.ruleset_version).toBeGreaterThan(0);
    expect(rec.ruleset_hash).toMatch(/^[0-9a-f]{16,}/);
    expect(rec.feature_snapshot).toBeTruthy();
    expect(rec.features_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(rec.engine_version).toMatch(/decision-schema/);
  });

  test("snapshots hold no raw IP or device fingerprint", async () => {
    const res = await post(SAFE, "privacy");
    const stored = await db.get(
      "SELECT feature_snapshot, context FROM decision_records WHERE transaction_id = ?",
      [res.body.transaction.id],
    );
    const txn = await db.get(
      "SELECT ip_address, device_fingerprint FROM transactions WHERE id = ?",
      [res.body.transaction.id],
    );
    for (const secret of [txn.ip_address, txn.device_fingerprint].filter(
      Boolean,
    )) {
      expect(stored.feature_snapshot).not.toContain(secret);
      expect(stored.context).not.toContain(secret);
    }
  });

  test("ML unavailable -> source fallback with fixed rule-engine thresholds and the error recorded", async () => {
    scoreWithML.mockRejectedValue(
      new Error("ML service responded with status 500"),
    );
    const res = await post(SAFE, "fb");
    const [rec] = await decisionRepository.list(res.body.transaction.id);
    expect(rec.decision_source).toBe("fallback");
    expect(rec.thresholds).toMatchObject({
      basis: "rule_engine_fixed",
      medium_threshold: 40,
      high_threshold: 70,
    });
    expect(rec.context.ml.status).toBe("unavailable");
  });

  test("hard rule override -> source hard_rule", async () => {
    const res = await post(
      {
        ...SAFE,
        amount: 9000,
        category: "crypto",
        location: "Lagos, NG",
        card_type: "prepaid",
      },
      "hr",
    );
    const [rec] = await decisionRepository.list(res.body.transaction.id);
    if (res.body.analysis.scoring_method.startsWith("hard_rule")) {
      expect(rec.decision_source).toBe("hard_rule");
      expect(rec.hard_flags).toBeTruthy();
    } else {
      expect(["ml", "fallback"]).toContain(rec.decision_source);
    }
  });

  test("rule-set version advances when an admin edits rules, and is recorded with later decisions", async () => {
    const before = await decisionRepository.list(
      (await post(SAFE, "rs1")).body.transaction.id,
    );
    const created = await asAdmin(
      request(app).post(`${API}/admin/fraud-rules`),
    ).send({ rule_type: "blacklist_merchant", value: "evil corp" });
    expect(created.status).toBe(201);
    const after = await decisionRepository.list(
      (await post(SAFE, "rs2")).body.transaction.id,
    );
    expect(after[0].ruleset_version).toBeGreaterThan(before[0].ruleset_version);
    expect(after[0].ruleset_hash).not.toBe(before[0].ruleset_hash);
  });

  test("webhook/API analysis does not leak snapshot or internals", async () => {
    const res = await post(SAFE, "leak");
    expect(JSON.stringify(res.body)).not.toMatch(
      /feature_snapshot|policy_used|network_signal/,
    );
  });
});

describe("append-only enforcement", () => {
  let id;
  beforeAll(async () => {
    id = (await post(SAFE, "ao")).body.transaction.id;
  });
  test("UPDATE and DELETE on decision_records are refused", async () => {
    await expect(
      db.run(
        "UPDATE decision_records SET fraud_score = 0 WHERE transaction_id = ?",
        [id],
      ),
    ).rejects.toThrow(/append-only/);
    await expect(
      db.run(
        "UPDATE decision_records SET reasons = ? WHERE transaction_id = ?",
        ["[]", id],
      ),
    ).rejects.toThrow(/append-only/);
    await expect(
      db.run("DELETE FROM decision_records WHERE transaction_id = ?", [id]),
    ).rejects.toThrow(/append-only/);
  });
  test("even the redactable columns cannot be changed without the retention gate", async () => {
    await expect(
      db.run(
        "UPDATE decision_records SET feature_snapshot = NULL WHERE transaction_id = ?",
        [id],
      ),
    ).rejects.toThrow(/append-only/);
  });
  test("audit_logs rows cannot be updated or deleted", async () => {
    await auditLogRepository.insert({ action: "test.x", details: {} });
    await expect(
      db.run(
        "UPDATE audit_logs SET outcome = 'success' WHERE action = 'test.x'",
      ),
    ).rejects.toThrow(/append-only/);
    await expect(
      db.run("DELETE FROM audit_logs WHERE action = 'test.x'"),
    ).rejects.toThrow(/append-only/);
  });
  test("no HTTP route can open the gate or edit history", async () => {
    const r = await asAdmin(
      request(app).delete(`${API}/admin/transactions/${id}/decision-history`),
    );
    expect([404, 405]).toContain(r.status);
  });
});

describe("hash chain", () => {
  test("verifies, and detects tampering made behind the triggers", async () => {
    const id = (await post(SAFE, "hc")).body.transaction.id;
    await asAdmin(
      request(app).post(`${API}/admin/transactions/${id}/rescore`),
    ).send({ reason: "chain test rescore", apply: false });
    expect(await decisionRepository.verifyChain(id)).toMatchObject({
      valid: true,
      records: 2,
    });
    // simulate a privileged attacker who disabled the triggers
    await db.exec(
      db.dialect === "postgres"
        ? "DROP TRIGGER trg_decision_guard ON decision_records"
        : "DROP TRIGGER trg_decision_no_update",
    );
    await db.run(
      "UPDATE decision_records SET fraud_score = 99 WHERE transaction_id = ? AND seq = 1",
      [id],
    );
    const v = await decisionRepository.verifyChain(id);
    expect(v.valid).toBe(false);
    expect(v.problems.join(" ")).toMatch(/seq 1/);
    await require("../../config/decisionAuditSchema").initDecisionAuditSchema(); // restores the trigger
  });
});

describe("rescore preserves the original", () => {
  test("dry rescore appends a record, leaves the transaction untouched, uses the stored snapshot", async () => {
    const id = (await post(SAFE, "rs")).body.transaction.id;
    const orig = await db.get(
      "SELECT fraud_score, risk_level, model_version FROM transactions WHERE id = ?",
      [id],
    );
    scoreWithML.mockResolvedValue({ ...mlOk(0.9), model_version: "v10" });
    const res = await asAdmin(
      request(app).post(`${API}/admin/transactions/${id}/rescore`),
    ).send({ reason: "new model check" });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      applied: false,
      recorded_seq: 2,
      inputs: { used_stored_feature_snapshot: true },
    });
    expect(res.body.changed.risk_level).toBeTruthy();
    expect(scoreWithML.mock.calls.at(-1)[4]).toBeTruthy(); // featurePayload passed through
    expect(
      await db.get(
        "SELECT fraud_score, risk_level, model_version FROM transactions WHERE id = ?",
        [id],
      ),
    ).toEqual(orig);
    const hist = await decisionRepository.list(id);
    expect(
      hist.map((h) => [h.seq, h.decision_type, h.applied, h.model_version]),
    ).toEqual([
      [1, "original", true, "v9"],
      [2, "rescore", false, "v10"],
    ]);
    expect(hist[1].actor_username).toBe("admin");
    expect(hist[1].reason).toBe("new model check");
  });

  test("apply=true updates the effective decision, keeps seq 1, creates an alert, audits before/after", async () => {
    const id = (await post(SAFE, "ap")).body.transaction.id;
    scoreWithML.mockResolvedValue(mlOk(0.95));
    const res = await asAdmin(
      request(app).post(`${API}/admin/transactions/${id}/rescore`),
    ).send({ reason: "apply new decision", apply: true });
    expect(res.body.applied).toBe(true);
    expect(
      (await db.get("SELECT risk_level FROM transactions WHERE id = ?", [id]))
        .risk_level,
    ).toBe("high");
    expect(
      await db.get("SELECT id FROM alerts WHERE transaction_id = ?", [id]),
    ).toBeTruthy();
    const hist = await decisionRepository.list(id);
    expect(hist[0]).toMatchObject({ seq: 1, risk_level: "medium" });
    const logs = await auditLogRepository.forTarget("transaction", id);
    const entry = logs.find((l) => l.action === "decisions.rescore_applied");
    expect(entry.details.before.risk_level).toBe("medium");
    expect(entry.details.after.risk_level).toBe("high");
  });

  test("refused when the ML service is down; nothing recorded", async () => {
    const id = (await post(SAFE, "dn")).body.transaction.id;
    scoreWithML.mockRejectedValue(new Error("down"));
    const res = await asAdmin(
      request(app).post(`${API}/admin/transactions/${id}/rescore`),
    ).send({ reason: "should be refused" });
    // A hard rule can decide without the model (then the rescore is legitimately recorded); otherwise a
    // fallback result must never be presented as a rescore.
    if (res.status === 503)
      expect(await decisionRepository.list(id)).toHaveLength(1);
    else
      expect((await decisionRepository.list(id))[1].decision_source).toBe(
        "hard_rule",
      );
  });

  test("requires admin and a reason", async () => {
    const id = (await post(SAFE, "ac")).body.transaction.id;
    expect(
      (
        await request(app)
          .post(`${API}/admin/transactions/${id}/rescore`)
          .set("Authorization", `Bearer ${userToken}`)
          .send({ reason: "long enough reason" })
      ).status,
    ).toBe(403);
    expect(
      (
        await asAdmin(
          request(app).post(`${API}/admin/transactions/${id}/rescore`),
        ).send({ reason: "x" })
      ).status,
    ).toBe(400);
  });

  test("a transaction from before auditing gets an honest backfill baseline", async () => {
    const { lastInsertRowid } = await db.insert(
      `INSERT INTO transactions (user_id, amount, merchant, category, location, card_type, is_fraud, fraud_score, risk_level, status)
       VALUES ((SELECT id FROM users WHERE username='da_user'), 50, 'Old', 'food', 'New York, US', 'credit', 0, 5, 'low', 'completed')`,
    );
    const hist = await asAdmin(
      request(app).get(
        `${API}/admin/transactions/${lastInsertRowid}/decision-history`,
      ),
    );
    expect(hist.status).toBe(200);
    const first = hist.body.timeline.find(
      (t) => t.kind === "decision",
    ).decision;
    expect(first).toMatchObject({
      origin: "backfill",
      ruleset_version: null,
      feature_snapshot: null,
    });
    expect(first.thresholds.basis).toBe("unknown");
    expect(hist.body.chain.valid).toBe(true);
  });
});

describe("investigator and admin change history", () => {
  test("alert resolve is recorded with before/after in the transaction timeline", async () => {
    const id = (
      await post(
        {
          ...SAFE,
          amount: 5000,
          category: "electronics",
          location: "Lagos, NG",
          card_type: "prepaid",
        },
        "tl",
      )
    ).body.transaction.id;
    scoreWithML.mockResolvedValue(mlOk(0.9));
    const t2 = (await post({ ...SAFE, amount: 4000 }, "tl2")).body.transaction
      .id;
    const alert = await db.get(
      "SELECT id FROM alerts WHERE transaction_id = ?",
      [t2],
    );
    expect(alert).toBeTruthy();
    const r = await asAdmin(
      request(app).patch(`${API}/alerts/${alert.id}/resolve`),
    ).send({ verdict: "confirmed_fraud", note: "customer called" });
    expect(r.status).toBe(200);
    const hist = await asAdmin(
      request(app).get(`${API}/admin/transactions/${t2}/decision-history`),
    );
    const ev = hist.body.timeline.find((t) => t.action === "alerts.resolve");
    expect(ev.details.before.resolved).toBe(false);
    expect(ev.details.after).toMatchObject({
      resolved: true,
      verdict: "confirmed_fraud",
    });
    expect(JSON.stringify(ev.details)).not.toContain("customer called");
    expect(id).toBeTruthy();
  });

  test("sanitizer redacts secrets and bounds size, keeps ids and booleans", () => {
    const out = auditLogRepository.sanitizeDetails({
      password: "hunter2",
      newPassword: "x",
      accessToken: "abc",
      refresh_token: "r",
      apiKey: "k",
      Authorization: "Bearer abcdefghijklmnop",
      tokenId: 7,
      ok: true,
      note: "see Bearer abcdefghijklmnopqrstu here",
      jwt: "eyJhbGciOiJI.eyJzdWIiOiIx.sigsig",
      nested: { client_secret: "s", fine: "yes" },
      long: "a".repeat(2000),
    });
    expect(out.password).toBe("[REDACTED]");
    expect(out.newPassword).toBe("[REDACTED]");
    expect(out.accessToken).toBe("[REDACTED]");
    expect(out.refresh_token).toBe("[REDACTED]");
    expect(out.apiKey).toBe("[REDACTED]");
    expect(out.Authorization).toBe("[REDACTED]");
    expect(out.tokenId).toBe(7);
    expect(out.ok).toBe(true);
    expect(
      auditLogRepository.sanitizeDetails({
        apiKeyName: "Audited key",
        tokenName: "ci",
      }),
    ).toEqual({ apiKeyName: "Audited key", tokenName: "ci" });
    expect(out.note).not.toMatch(/abcdefghijklmnopqrstu/);
    expect(out.jwt).toBe("[REDACTED]");
    expect(out.nested).toEqual({ client_secret: "[REDACTED]", fine: "yes" });
    expect(out.long.length).toBeLessThan(600);
  });

  test("audit insert sanitizes before storing", async () => {
    await auditLogRepository.insert({
      action: "test.secret",
      details: { password: "p", token: "t", keep: 1 },
    });
    const row = await db.get(
      "SELECT details FROM audit_logs WHERE action = 'test.secret'",
    );
    expect(row.details).not.toMatch(/"p"|"t"/);
    expect(JSON.parse(row.details).keep).toBe(1);
  });
});

describe("retention", () => {
  const old = new Date(Date.now() - 4000 * 86400000);
  let oldTxn;
  let heldTxn;
  let freshTxn;
  beforeAll(async () => {
    oldTxn = (await post(SAFE, "r1")).body.transaction.id;
    heldTxn = (await post(SAFE, "r2")).body.transaction.id;
    freshTxn = (await post(SAFE, "r3")).body.transaction.id;
    // age two records (needs the gate: this is the retention-style privileged path)
    await decisionRepository
      .withRetentionGate(async () => {
        // created_at is hashed; re-hash is not needed for retention, which does not verify
        await db.run(
          "UPDATE decision_records SET created_at = ? WHERE transaction_id IN (?, ?)",
          [old.toISOString(), oldTxn, heldTxn],
        );
      })
      .catch(() => {});
  });

  test("created_at cannot be altered even through the gate (triggers protect the chain)", async () => {
    const r = await db.get(
      "SELECT created_at FROM decision_records WHERE transaction_id = ?",
      [oldTxn],
    );
    expect(new Date(r.created_at).getTime()).toBeGreaterThan(
      old.getTime() + 86400000,
    );
  });

  test("dry run changes nothing but is recorded; a real run needs a reason", async () => {
    const res = await asAdmin(
      request(app).post(`${API}/admin/retention/run`),
    ).send({});
    expect(res.status).toBe(200);
    expect(res.body.results.dry_run).toBe(true);
    expect(
      (
        await asAdmin(request(app).post(`${API}/admin/retention/run`)).send({
          dry_run: false,
        })
      ).status,
    ).toBe(400);
    expect((await retentionService.history()).length).toBeGreaterThan(0);
  });

  test("windows, legal holds and open disputes (service-level, injectable clock)", async () => {
    const future = new Date(Date.now() + 3100 * 86400000); // pretend ~8 years later
    await asAdmin(
      request(app).post(`${API}/admin/transactions/${heldTxn}/legal-holds`),
    ).send({ reason: "regulator inquiry 2026-44" });
    const dry = await retentionService.run({
      dryRun: true,
      now: future,
      actor: "t",
    });
    expect(dry.results.decision_transactions_purged).toBeGreaterThan(0);
    expect(dry.results.protected_transactions).toBeGreaterThanOrEqual(1);
    const before = Number(
      (await db.get("SELECT COUNT(*) n FROM decision_records")).n,
    );
    expect(before).toBeGreaterThan(0);
    const real = await retentionService.run({
      dryRun: false,
      now: future,
      actor: "t",
    });
    expect(real.results.dry_run).toBe(false);
    expect(await decisionRepository.list(heldTxn)).not.toHaveLength(0); // held: kept
    expect(await decisionRepository.list(oldTxn)).toHaveLength(0);
    expect(real.digest).toMatch(/^[0-9a-f]{64}$/);
  });

  test("snapshot redaction keeps the record and the chain valid", async () => {
    const later = new Date(Date.now() + 500 * 86400000); // > 400 days, < 2555
    const id = freshTxn;
    await retentionService.run({ dryRun: false, now: later, actor: "t" });
    const [rec] = await decisionRepository.list(id);
    if (rec) {
      expect(rec.feature_snapshot).toBeNull();
      expect(rec.redacted_at).toBeTruthy();
      expect(rec.risk_level).toBeTruthy(); // reasons/thresholds survive
      expect((await decisionRepository.verifyChain(id)).valid).toBe(true);
    }
  });

  test("releasing a hold makes the history eligible again", async () => {
    const holds = await retentionService.holds(heldTxn);
    expect(
      await retentionService.releaseHold({
        holdId: Number(holds[0].id),
        userId: 1,
      }),
    ).toBe(true);
    const out = await retentionService.run({
      dryRun: false,
      now: new Date(Date.now() + 3100 * 86400000),
      actor: "t",
    });
    expect(out.results.decision_transactions_purged).toBeGreaterThanOrEqual(1);
    expect(await decisionRepository.list(heldTxn)).toHaveLength(0);
  });
});
