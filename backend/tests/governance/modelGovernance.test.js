/**
 * Model promotion governance, through the real HTTP API and real database,
 * with the ML service replaced by a controllable fake (its own behaviour is
 * tested in ml_service/tests/test_governance.py).
 */
jest.mock("../../services/mlAdminClient");

const mlAdminClient = require("../../services/mlAdminClient");
const { deleteTransactions } = require("../helpers/purge");
const config = require("../../config/env");
const db = require("../../config/database");
const {
  start,
  stop,
  call,
  registerAndLogin,
  adminToken,
  secondAdmin,
} = require("../concurrency/helpers");
const modelEvaluation = require("../../services/modelEvaluationService");
const modelHealth = require("../../services/modelHealthService");
const governance = require("../../services/modelGovernanceService");

const CHECKLIST = {
  gates_reviewed: true,
  comparison_reviewed: true,
  thresholds_reviewed: true,
  rollback_plan: true,
  stakeholders_notified: true,
};
const ROLLBACK_CHECKLIST = { impact_understood: true, target_verified: true };
const REASON =
  "Retrained on the latest data; comparison and gates reviewed by the fraud team.";

let admin1;
let admin2;
let admin3;
let user;
const fake = { active: "v3", gates: {}, activateImpl: null };

const gate = (id, status = "pass", extra = {}) => ({
  id,
  title: id,
  status,
  hard: false,
  detail: `${id} ${status}`,
  ...extra,
});
function defaultGates() {
  return [
    gate("artifact_integrity", "pass", { hard: true }),
    gate("runtime_compat", "pass", { hard: true }),
    gate("feature_schema", "pass", { hard: true }),
    gate("smoke_score", "pass", { hard: true }),
    gate("calibrated", "pass", { hard: true }),
    gate("required_metrics", "pass", { hard: true }),
    gate("benchmark_comparison", "pass", {
      data: { benchmark: { synthetic: true } },
    }),
  ];
}
const setGates = (version, gates) => {
  fake.gates[version] = gates;
};

beforeAll(async () => {
  await start();
  admin1 = { token: await adminToken() };
  admin2 = await secondAdmin();
  admin3 = await secondAdmin();
  user = await registerAndLogin("gov_user");
});
afterAll(stop);

beforeEach(async () => {
  jest.clearAllMocks();
  config.modelGovernance.allowSelfApproval = false;
  config.modelGovernance.autoRollback = false;
  fake.active = "v3";
  fake.gates = { v4: defaultGates(), v3: defaultGates(), v2: defaultGates() };
  fake.activateImpl = null;
  mlAdminClient.listVersions.mockImplementation(async () => ({
    active: fake.active,
    versions: [{ version: "v2" }, { version: "v3" }, { version: "v4" }],
  }));
  mlAdminClient.getGates.mockImplementation(async (version) => ({
    version,
    gates: fake.gates[version] || [
      gate("artifact_integrity", "fail", { hard: true }),
    ],
  }));
  mlAdminClient.getBaseline.mockResolvedValue({ version: "v3", score: null });
  mlAdminClient.activate.mockImplementation(async (a) => {
    if (fake.activateImpl) return fake.activateImpl(a);
    const previous = fake.active;
    fake.active = a.version;
    return {
      status: "activated",
      version: a.version,
      previous_version: previous,
    };
  });
  await db.run(
    "UPDATE model_change_requests SET status = 'cancelled' WHERE status IN ('pending_approval','approved','applying')",
  );
});

const request = (token, body = {}) =>
  call("POST", "/admin/ml/change-requests", {
    token,
    body: {
      action: "promote",
      version: "v4",
      reason: REASON,
      checklist: CHECKLIST,
      ...body,
    },
  });
const approve = (token, id, body = {}) =>
  call("POST", `/admin/ml/change-requests/${id}/approve`, {
    token,
    body: {
      note: "Reviewed the report; acknowledging the open items.",
      ...body,
    },
  });
const ACK_ALL = ["outcome_evidence", "benchmark_comparison"];

describe("requesting a change", () => {
  test("only admins can use the workflow", async () => {
    for (const [m, p] of [
      ["GET", "/admin/ml/change-requests"],
      ["POST", "/admin/ml/change-requests"],
      ["GET", "/admin/ml/health"],
    ]) {
      expect(
        (
          await call(m, p, {
            token: user.token,
            body: m === "POST" ? {} : undefined,
          })
        ).status,
      ).toBe(403);
    }
  });

  test("every checklist item must be confirmed", async () => {
    const r = await request(admin1.token, {
      checklist: { ...CHECKLIST, rollback_plan: false },
    });
    expect(r.status).toBe(400);
    expect(r.body.details.code).toBe("CHECKLIST_INCOMPLETE");
    expect(r.body.details.missing).toEqual(["rollback_plan"]);
  });

  test("a reason of substance is mandatory", async () => {
    expect((await request(admin1.token, { reason: "ship it" })).status).toBe(
      400,
    );
  });

  test("a hard gate failure (artifact integrity) blocks the request: nothing is stored", async () => {
    setGates(
      "v4",
      defaultGates().map((g) =>
        g.id === "artifact_integrity" ? { ...g, status: "fail" } : g,
      ),
    );
    const before = (
      await call("GET", "/admin/ml/change-requests", { token: admin1.token })
    ).body.changes.length;
    const r = await request(admin1.token);
    expect(r.status).toBe(422);
    expect(r.body.details.code).toBe("GATES_BLOCK");
    expect(r.body.details.gate_report.summary.blocking).toContain(
      "artifact_integrity",
    );
    expect(
      (await call("GET", "/admin/ml/change-requests", { token: admin1.token }))
        .body.changes.length,
    ).toBe(before);
  });

  test('a challenger worse than the incumbent on labelled data is blocked even though that gate is not "hard"', async () => {
    setGates(
      "v4",
      defaultGates().map((g) =>
        g.id === "benchmark_comparison"
          ? { ...g, status: "fail", detail: "PR-AUC regression" }
          : g,
      ),
    );
    const r = await request(admin1.token);
    expect(r.status).toBe(422);
    expect(r.body.details.gate_report.summary.blocking).toEqual([
      "benchmark_comparison",
    ]);
  });

  test("a valid request waits for approval and changes nothing", async () => {
    const r = await request(admin1.token);
    expect(r.status).toBe(201);
    expect(r.body.change).toMatchObject({
      status: "pending_approval",
      action: "promote",
      target_version: "v4",
      from_version: "v3",
      requested_by_username: "admin",
    });
    expect(r.body.change.reason).toBe(REASON);
    expect(r.body.change.checklist).toEqual(CHECKLIST);
    expect(mlAdminClient.activate).not.toHaveBeenCalled();
    expect(fake.active).toBe("v3");
  });

  test("the gate report is honest about evidence: no shadow outcomes and a synthetic benchmark both need acknowledgement", async () => {
    const r = await request(admin1.token);
    const byId = Object.fromEntries(
      r.body.change.gate_report.gates.map((g) => [g.id, g]),
    );
    expect(byId.outcome_evidence.status).toBe("insufficient");
    expect(byId.outcome_evidence.detail).toMatch(/AGREEMENT would not count/);
    expect(byId.benchmark_comparison.status).toBe("warn"); // passed, but synthetic
    expect(byId.benchmark_comparison.detail).toMatch(
      /NOT evidence of real-world accuracy/,
    );
    expect(
      r.body.change.gate_report.summary.needs_acknowledgement.sort(),
    ).toEqual(ACK_ALL.sort());
  });

  test("only one promotion can be open at a time (database-enforced)", async () => {
    expect((await request(admin1.token)).status).toBe(201);
    const second = await request(admin2.token);
    expect(second.status).toBe(409);
    expect(second.body.details.code).toBe("CHANGE_ALREADY_OPEN");
  });

  test("cannot promote the version already serving, or one that does not exist", async () => {
    expect((await request(admin1.token, { version: "v3" })).status).toBe(409);
    expect((await request(admin1.token, { version: "v9" })).status).toBe(404);
  });
});

describe("approval", () => {
  test("four eyes: the requester cannot approve their own request", async () => {
    const id = (await request(admin1.token)).body.change.id;
    const r = await approve(admin1.token, id, { acknowledged_gates: ACK_ALL });
    expect(r.status).toBe(403);
    expect(r.body.details.code).toBe("FOUR_EYES");
    expect(mlAdminClient.activate).not.toHaveBeenCalled();
  });

  test("insufficient / warning gates must be acknowledged by id", async () => {
    const id = (await request(admin1.token)).body.change.id;
    const r = await approve(admin2.token, id, {
      acknowledged_gates: ["benchmark_comparison"],
    });
    expect(r.status).toBe(400);
    expect(r.body.details.code).toBe("GATES_NOT_ACKNOWLEDGED");
    expect(r.body.details.missing).toEqual(["outcome_evidence"]);
    expect(mlAdminClient.activate).not.toHaveBeenCalled();
  });

  test("approval by a second admin applies the change and records who, why and with what evidence", async () => {
    const id = (await request(admin1.token)).body.change.id;
    const r = await approve(admin2.token, id, {
      acknowledged_gates: ACK_ALL,
      note: "Second review done; acknowledging synthetic benchmark.",
    });
    expect(r.status).toBe(200);
    expect(r.body.change).toMatchObject({
      status: "applied",
      requested_by_username: "admin",
      decided_by_username: admin2.username,
    });
    expect(r.body.change.acknowledged_gates.sort()).toEqual(ACK_ALL.sort());
    expect(r.body.change.gate_report_at_apply.gates.length).toBeGreaterThan(0);
    expect(mlAdminClient.activate).toHaveBeenCalledTimes(1);
    expect(mlAdminClient.activate).toHaveBeenCalledWith(
      expect.objectContaining({
        version: "v4",
        kind: "promote",
        changeId: id,
        actor: admin2.username,
      }),
    );
    expect(mlAdminClient.activate.mock.calls[0][0].reason).toContain(REASON);
    expect(fake.active).toBe("v4");
    const history = (
      await call("GET", "/admin/ml/change-requests", { token: admin1.token })
    ).body.changes;
    expect(history.find((c) => c.id === id)).toMatchObject({
      status: "applied",
      from_version: "v3",
      target_version: "v4",
    });
    const audit = await db.all(
      "SELECT action FROM audit_logs WHERE target_type = 'model_change' AND target_id = ?",
      [id],
    );
    expect(audit.map((a) => a.action)).toEqual(
      expect.arrayContaining([
        "ml.change_requested",
        "ml.change_approved",
        "ml.promoted",
      ]),
    );
  });

  test("self-approval exists only as an explicit opt-in and is marked as such", async () => {
    config.modelGovernance.allowSelfApproval = true;
    const id = (await request(admin1.token)).body.change.id;
    const r = await approve(admin1.token, id, { acknowledged_gates: ACK_ALL });
    expect(r.status).toBe(200);
    expect(r.body.change.decision_note).toMatch(/^\[SELF-APPROVED\]/);
  });

  test("two admins approving at the same instant: the model is switched exactly once", async () => {
    const id = (await request(admin1.token)).body.change.id;
    const results = await Promise.all(
      [admin2, admin3].map((a) =>
        approve(a.token, id, { acknowledged_gates: ACK_ALL }),
      ),
    );
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(mlAdminClient.activate).toHaveBeenCalledTimes(1);
  });

  test("a stale approval is refused: the serving model changed after the request", async () => {
    const id = (await request(admin1.token)).body.change.id;
    fake.active = "v2"; // someone rolled back in between
    const r = await approve(admin2.token, id, { acknowledged_gates: ACK_ALL });
    expect(r.status).toBe(409);
    expect(r.body.details.code).toBe("STALE_BASE");
    expect(mlAdminClient.activate).not.toHaveBeenCalled();
    expect(
      (
        await call("GET", `/admin/ml/change-requests/${id}`, {
          token: admin1.token,
        })
      ).body.change.status,
    ).toBe("apply_failed");
  });

  test("hard gates are re-run at apply time: an artifact tampered after the request is not activated", async () => {
    const id = (await request(admin1.token)).body.change.id;
    setGates(
      "v4",
      defaultGates().map((g) =>
        g.id === "artifact_integrity"
          ? { ...g, status: "fail", detail: "sha256 mismatch" }
          : g,
      ),
    );
    const r = await approve(admin2.token, id, { acknowledged_gates: ACK_ALL });
    expect(r.status).toBe(409);
    expect(r.body.details.code).toBe("GATES_FAILED_AT_APPLY");
    expect(mlAdminClient.activate).not.toHaveBeenCalled();
    expect(fake.active).toBe("v3");
  });

  test("if the ML service refuses the switch, the request is recorded as failed and the incumbent keeps serving", async () => {
    fake.activateImpl = async () => {
      throw new Error("v4 failed integrity verification");
    };
    const id = (await request(admin1.token)).body.change.id;
    const r = await approve(admin2.token, id, { acknowledged_gates: ACK_ALL });
    expect(r.status).toBe(409);
    const stored = (
      await call("GET", `/admin/ml/change-requests/${id}`, {
        token: admin1.token,
      })
    ).body.change;
    expect(stored.status).toBe("apply_failed");
    expect(stored.apply_result.error).toMatch(/integrity/);
    expect(fake.active).toBe("v3");
    // and the slot is free again for a corrected request
    expect((await request(admin1.token)).status).toBe(201);
  });

  test("rejection needs a note, is final, and changes nothing", async () => {
    const id = (await request(admin1.token)).body.change.id;
    expect(
      (
        await call("POST", `/admin/ml/change-requests/${id}/reject`, {
          token: admin2.token,
          body: { note: "no" },
        })
      ).status,
    ).toBe(400);
    const r = await call("POST", `/admin/ml/change-requests/${id}/reject`, {
      token: admin2.token,
      body: { note: "Thresholds not reviewed yet; resubmit." },
    });
    expect(r.body.change).toMatchObject({
      status: "rejected",
      decided_by_username: admin2.username,
    });
    expect(
      (await approve(admin3.token, id, { acknowledged_gates: ACK_ALL })).status,
    ).toBe(409);
    expect(mlAdminClient.activate).not.toHaveBeenCalled();
  });

  test("only the requester can cancel", async () => {
    const id = (await request(admin1.token)).body.change.id;
    expect(
      (
        await call("POST", `/admin/ml/change-requests/${id}/cancel`, {
          token: admin2.token,
          body: {},
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await call("POST", `/admin/ml/change-requests/${id}/cancel`, {
          token: admin1.token,
          body: {},
        })
      ).body.change.status,
    ).toBe("cancelled");
  });

  test("the legacy direct shadow promotion route is gone", async () => {
    expect(
      (await call("POST", "/admin/ml/shadow/promote", { token: admin1.token }))
        .status,
    ).toBe(410);
  });
});

describe("rollback", () => {
  test("uses the same approval path with its own checklist and gates, and is recorded", async () => {
    fake.active = "v4";
    const r = await call("POST", "/admin/ml/change-requests", {
      token: admin1.token,
      body: {
        action: "rollback",
        version: "v3",
        reason: "Latency regression after the v4 promotion.",
        checklist: ROLLBACK_CHECKLIST,
      },
    });
    expect(r.status).toBe(201);
    expect(
      r.body.change.gate_report.gates.some((g) => g.id === "outcome_evidence"),
    ).toBe(false); // no challenger evidence for a rollback
    const done = await approve(admin2.token, r.body.change.id, {
      acknowledged_gates:
        r.body.change.gate_report.summary.needs_acknowledgement,
    });
    expect(done.body.change).toMatchObject({
      status: "applied",
      action: "rollback",
      from_version: "v4",
      target_version: "v3",
    });
    expect(fake.active).toBe("v3");
  });
});

// ---------------------------------------------------------------------------------------------

async function insertTxn(
  userId,
  {
    fraud_score = 5,
    probability = 0.05,
    version = "v4",
    latency = 100,
    method = "ml_model",
    synthetic = 0,
  } = {},
) {
  return (
    await db.insert(
      `INSERT INTO transactions (user_id, amount, merchant, category, location, card_type, fraud_score, risk_level, scoring_method, model_version, model_probability, ml_latency_ms, is_synthetic)
     VALUES (?, 10, 'M', 'food', 'NY', 'credit', ?, 'low', ?, ?, ?, ?, ?)`,
      [userId, fraud_score, method, version, probability, latency, synthetic],
    )
  ).lastInsertRowid;
}
async function insertAlert(txnId, userId, verdict) {
  return (
    await db.insert(
      `INSERT INTO alerts (transaction_id, user_id, message, risk_level, resolved, status, verdict, resolved_at) VALUES (?, ?, 'm', 'medium', 1, 'resolved', ?, CURRENT_TIMESTAMP)`,
      [txnId, userId, verdict],
    )
  ).lastInsertRowid;
}

describe("judging a challenger on real outcomes (not on agreement)", () => {
  const sc = { n: 0 };
  beforeEach(async () => {
    await db.run("DELETE FROM shadow_scores");
    sc.n = 0;
  });
  async function seed({ n = 160, challengerBetter }) {
    const userId = user.user.id;
    const rnd = (() => {
      let a = 12345;
      return () => {
        a = (a * 1664525 + 1013904223) % 4294967296;
        return a / 4294967296;
      };
    })();
    for (let i = 0; i < n; i += 1) {
      const fraud = i % 3 === 0;
      const base = fraud ? 0.35 + rnd() * 0.4 : 0.15 + rnd() * 0.45; // incumbent: decent but overlapping
      const good = fraud ? 0.8 + rnd() * 0.19 : rnd() * 0.3; // clearly separates
      const bad = rnd(); // pure noise
      const t = await insertTxn(userId, { probability: base, version: "v3" });
      await insertAlert(
        t,
        userId,
        fraud ? "confirmed_fraud" : "false_positive",
      );
      await db.run(
        "INSERT INTO shadow_scores (transaction_id, shadow_version, shadow_probability, incumbent_version, incumbent_probability) VALUES (?, ?, ?, ?, ?)",
        [t, "v4", challengerBetter ? good : bad, "v3", base],
      );
    }
  }

  test("shadow scores without verdicts are NOT evidence, however closely they agree", async () => {
    const userId = user.user.id;
    for (let i = 0; i < 300; i += 1) {
      const t = await insertTxn(userId, { probability: 0.2, version: "v3" });
      await db.run(
        "INSERT INTO shadow_scores (transaction_id, shadow_version, shadow_probability, incumbent_version, incumbent_probability) VALUES (?, ?, 0.2, ?, 0.2)",
        [t, "v4", "v3"],
      );
    }
    const ev = await modelEvaluation.evaluateChallenger("v4");
    expect(ev.status).toBe("insufficient");
    expect(ev.shadow_scored_transactions).toBeGreaterThanOrEqual(300);
    expect(ev.labelled).toBe(0);
    const r = await request(admin1.token);
    expect(
      r.body.change.gate_report.gates.find((g) => g.id === "outcome_evidence")
        .status,
    ).toBe("insufficient");
  });

  test("a challenger that ranks confirmed fraud better is shown as better, with a paired interval", async () => {
    await seed({ challengerBetter: true });
    const ev = await modelEvaluation.evaluateChallenger("v4");
    expect(["pass_better", "pass"]).toContain(ev.status);
    expect(ev.challenger.roc_auc).toBeGreaterThan(ev.incumbent.roc_auc);
    expect(ev.paired_difference.roc_auc.ci95[0]).toBeGreaterThan(0);
    expect(ev.caveats.join(" ")).toMatch(/biased toward the incumbent/);
  });

  test("a challenger that is worse on confirmed outcomes cannot be requested", async () => {
    await seed({ challengerBetter: false });
    const ev = await modelEvaluation.evaluateChallenger("v4");
    expect(ev.status).toBe("fail");
    const r = await request(admin1.token);
    expect(r.status).toBe(422);
    expect(r.body.details.gate_report.summary.blocking).toContain(
      "outcome_evidence",
    );
  });

  test("synthetic transactions are never counted as outcomes", async () => {
    const userId = user.user.id;
    for (let i = 0; i < 200; i += 1) {
      const t = await insertTxn(userId, {
        synthetic: 1,
        version: "v3",
        probability: 0.5,
      });
      await insertAlert(
        t,
        userId,
        i % 2 ? "confirmed_fraud" : "false_positive",
      );
      await db.run(
        "INSERT INTO shadow_scores (transaction_id, shadow_version, shadow_probability, incumbent_probability) VALUES (?, ?, 0.5, 0.5)",
        [t, "v4"],
      );
    }
    expect((await modelEvaluation.evaluateChallenger("v4")).labelled).toBe(0);
  });
});

describe("metric helpers", () => {
  test("ROC-AUC and average precision on known cases", () => {
    expect(modelEvaluation.rocAuc([0, 0, 1, 1], [0.1, 0.2, 0.8, 0.9])).toBe(1);
    expect(modelEvaluation.rocAuc([0, 0, 1, 1], [0.9, 0.8, 0.2, 0.1])).toBe(0);
    expect(modelEvaluation.rocAuc([0, 1, 0, 1], [0.5, 0.5, 0.5, 0.5])).toBe(
      0.5,
    );
    expect(modelEvaluation.rocAuc([1, 1], [0.1, 0.2])).toBeNull();
    expect(
      modelEvaluation.averagePrecision([1, 0, 1, 0], [0.9, 0.8, 0.7, 0.1]),
    ).toBeCloseTo((1 + 2 / 3) / 2, 6);
  });
  test("Wilson interval and PSI behave", () => {
    const w = modelHealth.wilson(5, 100);
    expect(w.lo).toBeLessThan(0.05);
    expect(w.hi).toBeGreaterThan(0.05);
    expect(w.hi).toBeLessThan(0.12);
    const edges = [0, 1, 2, 5, 10, 20, 50, 100.0001];
    const baseline = [0.5, 0.2, 0.15, 0.08, 0.04, 0.02, 0.01];
    expect(
      modelHealth.psi(
        baseline,
        edges,
        Array.from(
          { length: 1000 },
          (_, i) =>
            ({ 0: 0.5, 1: 1.5, 2: 3, 3: 7, 4: 15, 5: 30, 6: 70 })[i % 7],
        ),
      ),
    ).toBeGreaterThan(0.25);
  });
});

describe("rollback triggers (from stored production data)", () => {
  beforeEach(async () => {
    await db.run("DELETE FROM shadow_scores");
    await db.run("DELETE FROM alerts");
    await deleteTransactions();
    await db.run("DELETE FROM model_health_events");
    config.modelGovernance.minSamples = 20;
    config.modelGovernance.minVerdicts = 10;
  });
  const trig = (rep, name) => rep.triggers.find((t) => t.name === name);

  test("healthy traffic: nothing fires; thin traffic is reported as insufficient_data, never ok", async () => {
    fake.active = "v4";
    let rep = await modelHealth.evaluate();
    expect(trig(rep, "latency_p95").status).toBe("insufficient_data");
    for (let i = 0; i < 40; i += 1)
      await insertTxn(user.user.id, { latency: 80 + (i % 10) });
    rep = await modelHealth.evaluate();
    expect(trig(rep, "latency_p95").status).toBe("ok");
    expect(trig(rep, "fallback_rate").status).toBe("ok");
    expect(rep.status).toBe("ok");
  });

  test("latency p95 above the limit is critical", async () => {
    fake.active = "v4";
    for (let i = 0; i < 40; i += 1)
      await insertTxn(user.user.id, { latency: i < 30 ? 3100 : 100 });
    const rep = await modelHealth.evaluate();
    expect(trig(rep, "latency_p95")).toMatchObject({
      status: "critical",
      value: 3100,
    });
  });

  test("error rate: the share of transactions the ML service did not score", async () => {
    fake.active = "v4";
    for (let i = 0; i < 40; i += 1)
      await insertTxn(user.user.id, {
        method: i < 10 ? "rule_engine_fallback" : "ml_model",
      });
    expect(trig(await modelHealth.evaluate(), "fallback_rate")).toMatchObject({
      status: "critical",
      value: 0.25,
    });
  });

  test("score-distribution shift against the version's training baseline", async () => {
    fake.active = "v4";
    mlAdminClient.getBaseline.mockResolvedValue({
      version: "v4",
      score: {
        hist_edges: [0, 1, 2, 5, 10, 20, 50, 100.0001],
        hist: [0.8, 0.1, 0.05, 0.03, 0.01, 0.005, 0.005],
      },
    });
    for (let i = 0; i < 60; i += 1)
      await insertTxn(user.user.id, { probability: 0.3 }); // everything scores 30
    expect(
      trig(await modelHealth.evaluate(), "score_distribution").status,
    ).toBe("critical");
  });

  test("confirmed fraud outcomes: flags that are mostly false positives, with confidence", async () => {
    fake.active = "v4";
    for (let i = 0; i < 30; i += 1) {
      const t = await insertTxn(user.user.id, {});
      await insertAlert(
        t,
        user.user.id,
        i < 2 ? "confirmed_fraud" : "false_positive",
      );
    }
    expect(
      trig(await modelHealth.evaluate(), "confirmed_outcomes"),
    ).toMatchObject({ status: "critical", confirmed_fraud: 2, n: 30 });
  });

  test("synthetic traffic never influences the triggers", async () => {
    fake.active = "v4";
    for (let i = 0; i < 60; i += 1)
      await insertTxn(user.user.id, {
        latency: 9000,
        method: "rule_engine_fallback",
        synthetic: 1,
      });
    const rep = await modelHealth.evaluate();
    expect(rep.transactions_in_window).toBe(0);
    expect(trig(rep, "latency_p95").status).toBe("insufficient_data");
  });

  async function promoteV4ThroughTheWorkflow() {
    const id = (await request(admin1.token)).body.change.id;
    expect(
      (await approve(admin2.token, id, { acknowledged_gates: ACK_ALL })).status,
    ).toBe(200);
    expect(fake.active).toBe("v4");
  }

  test("default: a breach is recorded and a rollback is RECOMMENDED, nothing is switched automatically", async () => {
    await promoteV4ThroughTheWorkflow();
    for (let i = 0; i < 40; i += 1)
      await insertTxn(user.user.id, { latency: 4000 });
    const rep = await modelHealth.run({ governance });
    expect(rep.status).toBe("critical");
    expect(rep.action).toBe("recommend_rollback_to_v3");
    expect(fake.active).toBe("v4");
    const events = await modelHealth.recentEvents();
    expect(events[0]).toMatchObject({
      model_version: "v4",
      trigger_name: "latency_p95",
      severity: "critical",
      action_taken: "recommend_rollback_to_v3",
    });
    await modelHealth.run({ governance }); // same breach again within the hour: no duplicate event
    expect((await modelHealth.recentEvents()).length).toBe(events.length);
  });

  test("opt-in automatic rollback switches back, recorded in the promotion history under the system actor", async () => {
    config.modelGovernance.autoRollback = true;
    await promoteV4ThroughTheWorkflow();
    for (let i = 0; i < 40; i += 1)
      await insertTxn(user.user.id, { latency: 4000 });
    const rep = await modelHealth.run({ governance });
    expect(rep.action).toBe("auto_rolled_back_to_v3");
    expect(fake.active).toBe("v3");
    const last = (
      await call("GET", "/admin/ml/change-requests?limit=1", {
        token: admin1.token,
      })
    ).body.changes[0];
    expect(last).toMatchObject({
      action: "rollback",
      status: "applied",
      from_version: "v4",
      target_version: "v3",
      requested_by_username: "system",
    });
    expect(last.reason).toMatch(/AUTOMATIC rollback: trigger "latency_p95"/);
    expect(mlAdminClient.activate).toHaveBeenLastCalledWith(
      expect.objectContaining({
        kind: "rollback",
        actor: "system:rollback-trigger",
      }),
    );
  });

  test("no automatic rollback when the serving model was not promoted by the workflow (nothing known-good to go back to)", async () => {
    config.modelGovernance.autoRollback = true;
    fake.active = "v4";
    await db.run(
      "UPDATE model_change_requests SET status = 'cancelled' WHERE target_version = 'v4' AND status = 'applied'",
    );
    for (let i = 0; i < 40; i += 1)
      await insertTxn(user.user.id, { latency: 4000 });
    const rep = await modelHealth.run({ governance });
    expect(rep.action).toMatch(/^recommend_review/);
    expect(fake.active).toBe("v4");
  });

  test("the health endpoint returns triggers and recent events", async () => {
    fake.active = "v4";
    const r = await call("GET", "/admin/ml/health", { token: admin1.token });
    expect(r.status).toBe(200);
    expect(r.body.triggers.map((t) => t.name)).toEqual([
      "latency_p95",
      "fallback_rate",
      "score_distribution",
      "confirmed_outcomes",
    ]);
  });
});
