import { createHmac } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import type { StewardConfig } from "../../src/config/schema.js";
import { buildServer } from "../../src/server/app.js";
import { openStores, type Stores } from "../../src/store/index.js";
import { FakeTracker } from "../fakes/fakeTracker.js";

const WEBHOOK_SECRET = "webhook-secret-value";
const WORKER_IDLE = { running: [] };

let dataDir: string;
let stores: Stores;
let tracker: FakeTracker;
let app: FastifyInstance;

const LABELS = { triage: "needs-triage", implement: "ready-for-agent", needsInfo: "needs-info", readyForHuman: "ready-for-human", implemented: "agent-implemented", approved: "agent-approved" };

const IMPLEMENT = {
  prompt: "./prompts/implement.md",
  branchTypes: ["feature", "fix", "chore", "refactor"],
  checks: [],
  checksTimeoutMinutes: 20,
  commitAuthor: { name: "Ticket Steward", email: "steward@example.com" },
  timeoutMinutes: 60,
  maxTurns: 150,
  protectedBranches: ["main", "staging", "dev"],
};

const makeConfig = (gatewayIssues: "enrich" | "skip" = "enrich", labels?: typeof LABELS, implement?: typeof IMPLEMENT): StewardConfig => ({
  dataDir,
  brain: { kind: "claude-code", model: "claude-test", maxTurns: 5, timeoutMinutes: 1 },
  tracker: { kind: "linear", teams: ["API"], gatewayIssues, bugLabels: ["Bug"], ...(labels === undefined ? {} : { labels }) },
  codehost: { kind: "gitlab", baseUrl: "https://gitlab.example", project: "acme/repo" },
  workspace: {
    fetchUrl: "https://gitlab.example/acme/repo.git",
    baseBranch: "dev",
    overlayDir: join(dataDir, "overlay"),
    setup: [],
    setupTimeoutMinutes: 1,
    port: 4100,
    keepOnFailure: true,
  },
  retention: { keptWorktrees: 3, days: 30 },
  prompt: join(dataDir, "prompt.md"),
  server: { port: 3020, publicUrl: "https://steward.example" },
  ...(implement === undefined ? {} : { implement }),
});

const issueCreatePayload = (teamKey = "API", description = "The adapter loses the final chunk.") =>
  JSON.stringify({
    action: "create",
    type: "Issue",
    data: { id: "issue-1", identifier: `${teamKey}-1`, description, team: { key: teamKey } },
  });

const sign = (body: string): string => createHmac("sha256", WEBHOOK_SECRET).update(body).digest("hex");

const post = (event: string, delivery: string, body: string, signature = sign(body)) =>
  app.inject({
    method: "POST",
    url: "/webhooks/linear",
    headers: {
      "content-type": "application/json",
      "linear-event": event,
      "linear-delivery": delivery,
      "linear-signature": signature,
    },
    payload: body,
  });

describe("buildServer", () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    dataDir = await mkdtemp(join(tmpdir(), "steward-server-"));
    stores = openStores(dataDir);
    tracker = new FakeTracker();
    app = buildServer({
      config: makeConfig(),
      secrets: { LINEAR_WEBHOOK_SECRET: WEBHOOK_SECRET, LINEAR_API_KEY: "lin_api_test" },
      stores,
      tracker,
      workerState: () => WORKER_IDLE,
    });
  });

  afterEach(async () => {
    await app.close();
    stores.db.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  describe("POST /webhooks/linear", () => {
    it("rejects an unsigned delivery and stores nothing", async () => {
      const response = await post("Issue", "delivery-1", issueCreatePayload(), "");

      expect(response.statusCode).toBe(401);
      expect(stores.jobs.list({ limit: 10 })).toEqual([]);
    });

    it("rejects a tampered body", async () => {
      const response = await post("Issue", "delivery-1", issueCreatePayload("API", "tampered"), sign(issueCreatePayload()));

      expect(response.statusCode).toBe(401);
      expect(stores.jobs.list({ limit: 10 })).toEqual([]);
    });

    it("queues a job for a signed Issue create", async () => {
      const response = await post("Issue", "delivery-1", issueCreatePayload());

      expect(response.statusCode).toBe(200);
      const jobs = stores.jobs.list({ limit: 10 });
      expect(jobs.length).toBe(1);
      expect(jobs[0]?.status).toBe("queued");
      expect(jobs[0]?.issueId).toBe("issue-1");
      expect(jobs[0]?.trigger).toEqual({
        kind: "issue.created",
        issueId: "issue-1",
        identifier: "API-1",
        teamKey: "API",
        deliveryId: "delivery-1",
        description: "The adapter loses the final chunk.",
        stateType: null,
      });
    });

    it("skips a gateway-created issue when gatewayIssues is skip", async () => {
      await app.close();
      app = buildServer({
        config: makeConfig("skip"),
        secrets: { LINEAR_WEBHOOK_SECRET: WEBHOOK_SECRET, LINEAR_API_KEY: "lin_api_test" },
        stores,
        tracker,
        workerState: () => WORKER_IDLE,
      });
      const description = "Body\n\n---\n\n_Routed by ticket-gateway · class `gateway` (p=0.91, margin 0.40, auto) → API · reported by Ana via Slack /ticket_";
      const response = await post("Issue", "delivery-1", issueCreatePayload("API", description));

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ ok: true, action: "skip" });
      expect(stores.jobs.list({ limit: 10 })).toEqual([]);
    });

    it("answers 200 for a repeated delivery without a second job", async () => {
      await post("Issue", "delivery-1", issueCreatePayload());
      const response = await post("Issue", "delivery-1", issueCreatePayload());

      expect(response.statusCode).toBe(200);
      expect(stores.jobs.list({ limit: 10 }).length).toBe(1);
    });

    it("ignores an Issue create for a team outside the allowlist", async () => {
      const response = await post("Issue", "delivery-1", issueCreatePayload("OPS"));

      expect(response.statusCode).toBe(200);
      expect(stores.jobs.list({ limit: 10 })).toEqual([]);
    });

    it("ignores an Issue update", async () => {
      const body = JSON.stringify({ action: "update", type: "Issue", data: { id: "issue-1", identifier: "API-1", team: { key: "API" } } });
      const response = await post("Issue", "delivery-1", body);

      expect(response.statusCode).toBe(200);
      expect(stores.jobs.list({ limit: 10 })).toEqual([]);
    });

    describe("with labels", () => {
      const labelUpdate = (stateType: string, previousLabelIds: string[]) =>
        JSON.stringify({
          action: "update",
          type: "Issue",
          data: {
            id: "issue-1",
            identifier: "API-1",
            description: "The adapter loses the final chunk.",
            team: { key: "API" },
            state: { name: "Todo", type: stateType },
            labels: [{ id: "label-triage", name: "needs-triage" }],
          },
          updatedFrom: { labelIds: previousLabelIds },
        });

      const readyForAgentUpdate = () =>
        JSON.stringify({
          action: "update",
          type: "Issue",
          data: {
            id: "issue-1",
            identifier: "API-1",
            description: "Body\n\n<!-- ticket-steward:begin -->\n## Enrichment\n<!-- ticket-steward:end -->",
            team: { key: "API" },
            state: { name: "Todo", type: "unstarted" },
            labels: [{ id: "label-agent", name: "ready-for-agent" }],
          },
          updatedFrom: { labelIds: [] },
        });

      const rebuild = async (implement?: typeof IMPLEMENT) => {
        await app.close();
        app = buildServer({
          config: makeConfig("enrich", LABELS, implement),
          secrets: { LINEAR_WEBHOOK_SECRET: WEBHOOK_SECRET, LINEAR_API_KEY: "lin_api_test" },
          stores,
          tracker,
          workerState: () => WORKER_IDLE,
        });
      };

      beforeEach(async () => {
        await app.close();
        app = buildServer({
          config: makeConfig("enrich", LABELS),
          secrets: { LINEAR_WEBHOOK_SECRET: WEBHOOK_SECRET, LINEAR_API_KEY: "lin_api_test" },
          stores,
          tracker,
          workerState: () => WORKER_IDLE,
        });
      });

      it("ignores an Issue create without the label", async () => {
        const response = await post("Issue", "delivery-1", issueCreatePayload());

        expect(response.json()).toEqual({ ok: true, action: "ignored" });
        expect(stores.jobs.list({ limit: 10 })).toEqual([]);
      });

      it("queues a job when the label is added", async () => {
        const response = await post("Issue", "delivery-1", labelUpdate("unstarted", []));

        expect(response.json()).toEqual({ ok: true, action: "enqueue" });
        expect(stores.jobs.list({ limit: 10 })[0]?.trigger.kind).toBe("issue.labeled");
        expect(stores.jobs.list({ limit: 10 })[0]?.trigger).toMatchObject({ kind: "issue.labeled", action: "triage" });
      });

      it("skips a Done ticket when the label is added", async () => {
        const response = await post("Issue", "delivery-1", labelUpdate("completed", []));

        expect(response.json()).toEqual({ ok: true, action: "skip" });
        expect(stores.jobs.list({ limit: 10 })).toEqual([]);
      });

      it("queues an implement job when ready-for-agent is added to an enriched ticket", async () => {
        await rebuild(IMPLEMENT);
        const response = await post("Issue", "delivery-9", readyForAgentUpdate());

        expect(response.json()).toEqual({ ok: true, action: "enqueue" });
        expect(stores.jobs.list({ limit: 10 })[0]?.kind).toBe("implement");
      });

      const createLoop = (state: "awaiting_review" | "handed_back"): number => {
        const jobId = stores.jobs.enqueue({ kind: "cli", issueId: "issue-1", identifier: "API-1", teamKey: "API", action: "implement" });
        stores.jobs.claimById(jobId);
        stores.jobs.finish(jobId, { status: "succeeded" });
        const id = stores.loops.create({
          issueId: "issue-1", identifier: "API-1", teamKey: "API", implementJobId: jobId, branch: "feature/api-1", baseSha: "a".repeat(40), headSha: "b".repeat(40),
          worktreeName: "api-1", labelDriven: false, sessionId: null,
        });
        stores.loops.update(id, { state });
        return id;
      };

      it("queues a restart job when ready-for-agent is added to a handed-back loop", async () => {
        await rebuild(IMPLEMENT);
        const loopId = createLoop("handed_back");
        const before = stores.jobs.list({ limit: 10 }).length;
        const response = await post("Issue", "delivery-9", readyForAgentUpdate());

        expect(response.json()).toEqual({ ok: true, action: "restart" });
        const queued = stores.jobs.list({ status: "queued", limit: 10 });
        expect(queued).toHaveLength(1);
        expect(stores.jobs.list({ limit: 10 })).toHaveLength(before + 1);
        expect(queued[0]).toMatchObject({ kind: "restart", subject: `loop:${loopId}` });
        expect(queued[0]?.trigger).toMatchObject({ kind: "loop", step: "restart", loopId, labelDriven: true });
      });

      it("skips ready-for-agent while the loop is awaiting a review", async () => {
        await rebuild(IMPLEMENT);
        createLoop("awaiting_review");
        const response = await post("Issue", "delivery-9", readyForAgentUpdate());

        expect(response.json()).toEqual({ ok: true, action: "skip" });
        expect(stores.jobs.list({ status: "queued", limit: 10 })).toEqual([]);
      });

      it("ignores ready-for-agent when implement is not configured", async () => {
        const response = await post("Issue", "delivery-9", readyForAgentUpdate());

        expect(response.json()).toEqual({ ok: true, action: "ignored" });
        expect(stores.jobs.list({ limit: 10 })).toEqual([]);
      });

      it("triages a ticket created with both labels when implement is not configured", async () => {
        const body = JSON.stringify({
          action: "create",
          type: "Issue",
          data: {
            id: "issue-1",
            identifier: "API-1",
            description: "The adapter loses the final chunk.",
            team: { key: "API" },
            state: { name: "Todo", type: "unstarted" },
            labels: [
              { id: "label-triage", name: "needs-triage" },
              { id: "label-agent", name: "ready-for-agent" },
            ],
          },
        });

        const response = await post("Issue", "delivery-10", body);

        expect(response.json()).toEqual({ ok: true, action: "enqueue" });
        expect(stores.jobs.list({ limit: 10 })[0]).toMatchObject({ kind: "enrich", trigger: { kind: "issue.created", action: "triage" } });
      });

      it("ignores an update to a ticket that already had the label", async () => {
        const response = await post("Issue", "delivery-1", labelUpdate("unstarted", ["label-triage"]));

        expect(response.json()).toEqual({ ok: true, action: "ignored" });
        expect(stores.jobs.list({ limit: 10 })).toEqual([]);
      });
    });

    it("ignores an AgentSessionEvent delivery", async () => {
      const body = JSON.stringify({
        action: "created",
        type: "AgentSessionEvent",
        agentSession: { id: "session-1", issueId: "issue-1", issue: { identifier: "API-1", team: { key: "API" } } },
      });
      const response = await post("AgentSessionEvent", "delivery-1", body);

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ ok: true, action: "ignored" });
      expect(stores.jobs.list({ limit: 10 })).toEqual([]);
    });
  });

  it("has no GitLab webhook route", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/webhooks/gitlab",
      headers: { "content-type": "application/json", "x-gitlab-event": "Merge Request Hook" },
      payload: "{}",
    });
    expect(response.statusCode).toBe(404);
    expect(stores.jobs.list({ limit: 10 })).toEqual([]);
  });

  describe("GET /health", () => {
    it("reports ok with counts and worker state", async () => {
      stores.jobs.enqueue({ kind: "cli", issueId: "issue-1", identifier: "API-1", teamKey: "API" });

      const response = await app.inject({ method: "GET", url: "/health" });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        ok: true,
        apiKeyRejected: false,
        worker: { running: [] },
        counts: { queued: 1, failedLast24h: 0 },
        lastSuccessAt: null,
      });
    });

    it("counts recent failures and reports the last success", async () => {
      const failedId = stores.jobs.enqueue({ kind: "cli", issueId: "issue-1", identifier: "API-1", teamKey: "API" });
      stores.jobs.claimById(failedId);
      stores.jobs.finish(failedId, { status: "failed", error: "boom", retryable: false });
      const succeededId = stores.jobs.enqueue({ kind: "cli", issueId: "issue-2", identifier: "API-2", teamKey: "API" });
      stores.jobs.claimById(succeededId);
      stores.jobs.finish(succeededId, { status: "succeeded" });

      const response = await app.inject({ method: "GET", url: "/health" });

      expect(response.json().counts).toEqual({ queued: 0, failedLast24h: 1 });
      expect(response.json().lastSuccessAt).toBe(stores.jobs.get(succeededId)?.finishedAt);
    });

    it("answers 503 once Linear rejected the API key", async () => {
      tracker.rejectApiKey();

      const response = await app.inject({ method: "GET", url: "/health" });

      expect(response.statusCode).toBe(503);
      expect(response.json().ok).toBe(false);
      expect(response.json().apiKeyRejected).toBe(true);
    });

    it("lists every running slot", async () => {
      await app.close();
      const running = { running: [{ slot: 1, jobId: 12 }, { slot: 2, jobId: 14 }] };
      app = buildServer({ config: makeConfig(), secrets: {}, stores, tracker, workerState: () => running });

      expect((await app.inject({ method: "GET", url: "/health" })).json().worker).toEqual(running);
    });
  });

  it("serves no OAuth callback route", async () => {
    const response = await app.inject({ method: "GET", url: "/oauth/linear/callback?code=abc&state=nope" });

    expect(response.statusCode).toBe(404);
  });
});
