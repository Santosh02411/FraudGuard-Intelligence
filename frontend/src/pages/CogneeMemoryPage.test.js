import React from "react";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import CogneeMemoryPage from "./CogneeMemoryPage";
import { layoutNodes } from "../components/memory/GraphExplorer";

const mockGet = jest.fn();
const mockPost = jest.fn();
jest.mock("../context/AuthContext", () => ({
  api: { get: (...a) => mockGet(...a), post: (...a) => mockPost(...a) },
}));

const health = (o = {}) => ({
  configured: true,
  reachable: true,
  status: "ok",
  service: {
    status: "ok",
    llm_configured: true,
    narrative_layer: "available",
    cognee_version: "1.6.6",
    checks: { graph_store: { ok: true }, vector_store: { ok: true } },
  },
  ...o,
});
const stats = () => ({
  sync: {
    running: false,
    scheduler: { enabled: true, intervalMs: 310000 },
    records: {
      transaction: { synced: 12, failed: 1 },
      investigation: { synced: 2, failed: 0 },
    },
    pendingNewTransactions: 3,
    lastSuccessfulSyncAt: "2026-10-30T10:00:00Z",
  },
  memory: {
    dataset: "fraudguard",
    nodes_total: 41,
    edges_total: 60,
    structured_entities: {
      Transaction: 12,
      Investigation: 2,
      Customer: 5,
      Merchant: 4,
      Device: 3,
      FraudPattern: 2,
    },
    suspicious_devices: 1,
    narrative_documents: 14,
    cognify: { status: "idle" },
  },
});
const runs = [
  {
    id: 2,
    trigger: "scheduler",
    mode: "incremental",
    actor: null,
    status: "completed",
    startedAt: "2026-10-30T10:00:00Z",
    ingested: 4,
    skippedUnchanged: 9,
    failed: 0,
  },
  {
    id: 1,
    trigger: "manual",
    mode: "full",
    actor: "admin",
    status: "completed_with_errors",
    startedAt: "2026-10-30T09:00:00Z",
    ingested: 10,
    skippedUnchanged: 0,
    failed: 1,
    error: "boom",
  },
];
const evidence = {
  label: "Retrieved from Cognee memory - not generated",
  items: [
    {
      evidence_id: "E1",
      source_type: "transaction",
      source_id: "7",
      source_key: "transaction:7",
      relevance: 0.82,
      matched_via: ["graph_summary_vector"],
      snippet: "Transaction 7: card testing",
      properties: { risk_level: "high", verdict: "confirmed_fraud" },
      connected: [
        { id: "a", type: "Device", label: "dev_abc", relation: "from_device" },
      ],
      live: { exists: true, url: "/transactions/7", memoryOutOfDate: true },
    },
  ],
};

function setup({ h = health(), url = "/fraud-intelligence" } = {}) {
  mockGet.mockImplementation((u) => {
    if (u === "/cognee-memory/health") return Promise.resolve({ data: h });
    if (u === "/cognee-memory/stats") return Promise.resolve({ data: stats() });
    if (u === "/cognee-memory/sync/runs")
      return Promise.resolve({ data: { runs } });
    if (u === "/cognee-memory/entities")
      return Promise.resolve({
        data: {
          total: 1,
          entities: [
            {
              id: "d1",
              type: "Device",
              label: "dev_shared",
              degree: 4,
              signals: { suspicious: true, accounts: 2 },
            },
          ],
        },
      });
    if (u.endsWith("/related"))
      return Promise.resolve({
        data: {
          center: "d1",
          truncated: false,
          nodes: [
            {
              id: "d1",
              type: "Device",
              label: "dev_shared",
              level: 0,
              signals: { suspicious: true },
            },
            { id: "c1", type: "Customer", label: "acct_1", level: 1 },
          ],
          edges: [{ source: "c1", target: "d1", relation: "from_device" }],
        },
      });
    return Promise.reject(new Error(u));
  });
  return render(
    <MemoryRouter initialEntries={[url]}>
      <CogneeMemoryPage />
    </MemoryRouter>,
  );
}
beforeEach(() => jest.clearAllMocks());

test("overview shows memory statistics, sync status and recent ingestion activity", async () => {
  setup();
  expect(await screen.findByText("41")).toBeInTheDocument(); // graph entities
  expect(
    screen.getByText("Devices (suspicious)").parentElement,
  ).toHaveTextContent("3 (1)");
  expect(screen.getByText(/Cognee service healthy/)).toBeInTheDocument();
  expect(screen.getByText(/every 5 min/)).toBeInTheDocument();
  expect(screen.getByText(/3 new transactions/)).toBeInTheDocument();
  const table = screen.getByRole("table");
  expect(within(table).getByText(/scheduled/)).toBeInTheDocument();
  expect(
    within(table).getByText(/manual \(admin\) · full/),
  ).toBeInTheDocument();
  expect(within(table).getByText("boom")).toBeInTheDocument();
});

test("not configured: explains how to configure and disables actions", async () => {
  setup({
    h: { configured: false, reachable: false, status: "not_configured" },
  });
  expect(
    await screen.findByText(/Cognee is not configured/),
  ).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /sync now/i })).toBeDisabled();
});

test("configured but unreachable shows an alert", async () => {
  setup({
    h: {
      configured: true,
      reachable: false,
      status: "unreachable",
      error: { message: "Cognee service is unreachable" },
    },
  });
  expect(await screen.findByRole("alert")).toHaveTextContent(/not reachable/);
});

test("Sync now posts an incremental sync and reports counts, then refreshes", async () => {
  mockPost.mockResolvedValue({
    data: {
      status: "completed",
      ingested: 5,
      skippedUnchanged: 8,
      failed: 0,
      morePending: false,
    },
  });
  setup();
  fireEvent.click(await screen.findByRole("button", { name: /sync now/i }));
  expect(await screen.findByRole("status")).toHaveTextContent(
    "5 sent, 8 unchanged",
  );
  expect(mockPost).toHaveBeenCalledWith("/cognee-memory/sync", {
    mode: "incremental",
  });
});

test("search shows retrieved evidence with live cross-check, separate from an AI summary", async () => {
  mockPost.mockResolvedValue({
    data: {
      evidence,
      answer: {
        text: "Looks like card testing.",
        label: "AI-generated summary",
        generated: true,
      },
    },
  });
  setup({ url: "/fraud-intelligence?tab=search" });
  fireEvent.change(await screen.findByLabelText(/ask the fraud history/i), {
    target: { value: "card testing at gift card merchants" },
  });
  fireEvent.click(screen.getByLabelText(/also generate a summary/i));
  fireEvent.click(screen.getByRole("button", { name: /search memory/i }));
  const ev = await screen.findByLabelText("Retrieved evidence");
  expect(within(ev).getByText("Retrieved evidence")).toBeInTheDocument();
  expect(within(ev).getByText(/changed since last sync/)).toBeInTheDocument();
  expect(
    within(ev).getByRole("link", { name: /open record/i }),
  ).toHaveAttribute("href", "/transactions/7");
  expect(
    within(screen.getByLabelText("AI-generated summary")).getByText(
      "AI-generated",
    ),
  ).toBeInTheDocument();
  expect(screen.getByLabelText("AI-generated summary")).not.toContainElement(
    ev,
  );
  expect(mockPost).toHaveBeenCalledWith("/cognee-memory/search", {
    query: "card testing at gift card merchants",
    topK: 8,
    includeAnswer: true,
    sourceTypes: [],
  });
});

test("assistant renders current facts, retrieved evidence and AI suggestions as three labelled layers", async () => {
  mockPost.mockResolvedValue({
    data: {
      subject: {
        label: "Current FraudGuard record facts",
        facts: "Transaction 9: 450.00 at Gift Shop",
      },
      evidence,
      ai_status: "ok",
      ai: {
        label: "AI-generated suggestions - verify",
        generated: true,
        explanation: [
          {
            statement: "Score driven by card testing.",
            evidence_ids: ["E1"],
            grounded: true,
          },
        ],
        similar_patterns: [],
        suggested_steps: [
          {
            action: "Check other accounts on dev_abc",
            rationale: "Shared device",
            evidence_ids: ["E1"],
            grounded: true,
          },
        ],
        caveats: ["Few matches"],
      },
    },
  });
  setup({ url: "/fraud-intelligence?tab=assistant&kind=transaction&id=9" });
  fireEvent.click(await screen.findByRole("button", { name: /investigate/i }));
  expect(
    await screen.findByLabelText("Current record facts"),
  ).toHaveTextContent("Transaction 9");
  expect(screen.getByLabelText("Retrieved evidence")).toBeInTheDocument();
  const ai = screen.getByLabelText("AI-generated suggestions");
  expect(ai).toHaveTextContent("Check other accounts on dev_abc");
  expect(ai).toHaveTextContent("E1");
  expect(mockPost).toHaveBeenCalledWith("/cognee-memory/assistant", {
    kind: "transaction",
    id: 9,
  });
});

test("assistant without an LLM shows evidence and explains why there are no suggestions", async () => {
  mockPost.mockResolvedValue({
    data: {
      subject: { label: "facts", facts: "Transaction 9" },
      evidence,
      ai: null,
      ai_status: "llm_not_configured",
    },
  });
  setup({ url: "/fraud-intelligence?tab=assistant&kind=transaction&id=9" });
  fireEvent.click(await screen.findByRole("button", { name: /investigate/i }));
  expect(await screen.findByText(/No LLM is configured/)).toBeInTheDocument();
  expect(screen.getByLabelText("Retrieved evidence")).toBeInTheDocument();
  expect(
    screen.queryByLabelText("AI-generated suggestions"),
  ).not.toBeInTheDocument();
});

test("assistant surfaces server errors", async () => {
  mockPost.mockRejectedValue({
    response: { data: { error: "Transaction not found" } },
  });
  setup({ url: "/fraud-intelligence?tab=assistant&kind=transaction&id=999" });
  fireEvent.click(await screen.findByRole("button", { name: /investigate/i }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Transaction not found",
  );
});

test("graph explorer lists entities, flags suspicious devices and draws the neighbourhood", async () => {
  setup({ url: "/fraud-intelligence?tab=graph" });
  const item = await screen.findByText("dev_shared");
  expect(screen.getByText("suspicious")).toBeInTheDocument();
  fireEvent.click(item);
  expect(
    await screen.findByRole("img", { name: /2 entities, 1 relationships/ }),
  ).toBeInTheDocument();
  expect(mockGet).toHaveBeenCalledWith("/cognee-memory/entities/d1/related", {
    params: { depth: 2 },
  });
});

test("layout puts the centre in the middle and each hop on its own ring", () => {
  const pos = layoutNodes([
    { id: "a", level: 0 },
    { id: "b", level: 1 },
    { id: "c", level: 1 },
    { id: "d", level: 2 },
  ]);
  expect(pos.get("a")).toEqual([230, 230]);
  const dist = (id) => Math.hypot(pos.get(id)[0] - 230, pos.get(id)[1] - 230);
  expect(Math.round(dist("b"))).toBe(85);
  expect(Math.round(dist("d"))).toBe(165);
});
