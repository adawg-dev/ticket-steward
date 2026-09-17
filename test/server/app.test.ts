import { createHmac } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import type { Mock } from "vitest";
import type { StewardConfig } from "../../src/config/schema.js";
import { buildServer } from "../../src/server/app.js";
import { openStores, type Stores } from "../../src/store/index.js";
import { FakeTracker } from "../fakes/fakeTracker.js";

const WEBHOOK_SECRET = "webhook-secret-value";
const WORKER_IDLE = { running: null };

let dataDir: string;
let stores: Stores;
let tracker: FakeTracker;
let app: FastifyInstance;
let fetchMock: Mock<typeof fetch>;

const makeConfig = (): StewardConfig => ({
  dataDir,
  brain: { kind: "claude-code", model: "claude-test", maxTurns: 5, timeoutMinutes: 1 },
  tracker: { kind: "linear", teams: ["API"] },
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
});

const issueCreatePayload = (teamKey = "API", description = "The adapter loses the final chunk.") =>
  JSON.stringify({
    action: "create",
    type: "Issue",
    data: { id: "issue-1", identifier: `${teamKey}-1`, description, team: { key: teamKey } },
  });

const sessionPayload = (action: "created" | "prompted", body?: string) =>
  JSON.stringify({
    action,
    type: "AgentSessionEvent",
    agentSession: { id: "session-1", issueId: "issue-1", issue: { identifier: "API-1", team: { key: "API" } } },
    ...(body === undefined ? {} : { agentActivity: { body } }),
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
    fetchMock = vi.fn<typeof fetch>();
    app = buildServer({
      config: makeConfig(),
      secrets: { LINEAR_WEBHOOK_SECRET: WEBHOOK_SECRET, LINEAR_CLIENT_ID: "client-id", LINEAR_CLIENT_SECRET: "client-secret" },
      stores,
      tracker,
      workerState: () => WORKER_IDLE,
      fetchImpl: fetchMock,
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
      });
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

    it("queues a session job and emits a thought after replying", async () => {
      const response = await post("AgentSessionEvent", "delivery-1", sessionPayload("created"));

      expect(response.statusCode).toBe(200);
      const jobs = stores.jobs.list({ limit: 10 });
      expect(jobs.length).toBe(1);
      expect(jobs[0]?.sessionId).toBe("session-1");
      await vi.waitFor(() => {
        expect(tracker.sessionActivities("session-1")).toEqual([
          { type: "thought", body: "Queued. I will check out `dev`, read the ticket, and enrich it." },
        ]);
      });
    });

    it("attaches a second session event to the queued job", async () => {
      await post("Issue", "delivery-1", issueCreatePayload());
      const response = await post("AgentSessionEvent", "delivery-2", sessionPayload("prompted", "Focus on streaming"));

      expect(response.statusCode).toBe(200);
      const jobs = stores.jobs.list({ limit: 10 });
      expect(jobs.length).toBe(1);
      expect(jobs[0]?.sessionId).toBe("session-1");
      expect(jobs[0]?.promptBody).toBe("Focus on streaming");
      await vi.waitFor(() => {
        expect(tracker.sessionActivities("session-1").length).toBe(1);
      });
    });

    it("tells a session for a non-allowlisted team that the steward is not configured", async () => {
      const body = JSON.stringify({
        action: "created",
        type: "AgentSessionEvent",
        agentSession: { id: "session-2", issueId: "issue-9", issue: { identifier: "OPS-9", team: { key: "OPS" } } },
      });
      const response = await post("AgentSessionEvent", "delivery-1", body);

      expect(response.statusCode).toBe(200);
      expect(stores.jobs.list({ limit: 10 })).toEqual([]);
      await vi.waitFor(() => {
        expect(tracker.sessionActivities("session-2")).toEqual([
          { type: "response", body: "Ticket Steward is not configured for team OPS" },
        ]);
      });
    });

    it("answers 200 even when the after-reply activity fails", async () => {
      tracker.failNextWrite();
      const response = await post("AgentSessionEvent", "delivery-1", sessionPayload("created"));

      expect(response.statusCode).toBe(200);
      expect(stores.jobs.list({ limit: 10 }).length).toBe(1);
    });
  });

  describe("GET /health", () => {
    it("reports ok with counts and worker state", async () => {
      stores.jobs.enqueue({ kind: "cli", issueId: "issue-1", identifier: "API-1", teamKey: "API" });

      const response = await app.inject({ method: "GET", url: "/health" });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        ok: true,
        authBroken: false,
        worker: { running: null },
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

    it("answers 503 when auth is broken", async () => {
      stores.tokens.setAuthBroken(true);

      const response = await app.inject({ method: "GET", url: "/health" });

      expect(response.statusCode).toBe(503);
      expect(response.json().ok).toBe(false);
      expect(response.json().authBroken).toBe(true);
    });
  });

  describe("GET /oauth/linear/callback", () => {
    it("rejects an unknown state", async () => {
      const response = await app.inject({ method: "GET", url: "/oauth/linear/callback?code=abc&state=nope" });

      expect(response.statusCode).toBe(400);
      expect(stores.tokens.get()).toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("rejects a missing code", async () => {
      const state = stores.tokens.createOauthState(60_000);
      const response = await app.inject({ method: "GET", url: `/oauth/linear/callback?state=${state}` });

      expect(response.statusCode).toBe(400);
      expect(stores.tokens.get()).toBeNull();
    });

    it("exchanges the code, stores the pair with the viewer id and clears auth_broken", async () => {
      stores.tokens.setAuthBroken(true);
      const state = stores.tokens.createOauthState(60_000);
      fetchMock
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ access_token: "access-1", refresh_token: "refresh-1", expires_in: 86_400 }), { status: 200 }),
        )
        .mockResolvedValueOnce(new Response(JSON.stringify({ data: { viewer: { id: "app-user-1" } } }), { status: 200 }));

      const response = await app.inject({ method: "GET", url: `/oauth/linear/callback?code=abc&state=${state}` });

      expect(response.statusCode).toBe(200);
      expect(stores.tokens.get()).toEqual({
        accessToken: "access-1",
        refreshToken: "refresh-1",
        expiresAt: expect.any(String),
        appUserId: "app-user-1",
      });
      expect(stores.tokens.isAuthBroken()).toBe(false);
      expect(stores.tokens.consumeOauthState(state)).toBe(false);
      expect(fetchMock.mock.calls[0]?.[0]).toBe("https://api.linear.app/oauth/token");
      expect(fetchMock.mock.calls[1]?.[0]).toBe("https://api.linear.app/graphql");
    });
  });
});
