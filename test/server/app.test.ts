import { createHmac } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import type { StewardConfig } from "../../src/config/schema.js";
import { RunChannels } from "../../src/run/channel.js";
import { buildServer } from "../../src/server/app.js";
import { seedSettings } from "../../src/settings/schema.js";
import { openStores, type Stores } from "../../src/store/index.js";
import type { ActivityContent, LinearAgentApi } from "../../src/tracker/linear/agent.js";
import { FakeGitLabMr } from "../fakes/fakeGitLabMr.js";
import { RecordingLinear } from "../fakes/fakeLinearAgent.js";
import { FAKE_APP_USER_ID, FakeTracker } from "../fakes/fakeTracker.js";

const WEBHOOK_SECRET = "webhook-secret-value";
const WORKER_IDLE = { running: [] };

let dataDir: string;
let stores: Stores;
let tracker: FakeTracker;
let app: FastifyInstance;


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

const makeConfig = (implement: typeof IMPLEMENT | null = IMPLEMENT): StewardConfig => ({
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
  server: { port: 3020, publicUrl: "https://steward.example" },
  ...(implement === null ? {} : { implement }),
});

const APP_USER = FAKE_APP_USER_ID;

const sessionCreated = (over: { teamKey?: string; comment?: { id: string; body: string; userId: string } } = {}) =>
  JSON.stringify({
    action: "created",
    type: "AgentSessionEvent",
    appUserId: APP_USER,
    agentSession: {
      id: "session-1",
      appUserId: APP_USER,
      issueId: "issue-1",
      issue: { id: "issue-1", identifier: "API-1", title: "Adapter", url: "https://linear.app/x/API-1", teamId: "t", team: { id: "t", key: over.teamKey ?? "API", name: "API" } },
      ...(over.comment === undefined ? {} : { comment: over.comment, commentId: over.comment.id }),
    },
    promptContext: "<issue/>",
  });

/** A Linear agent API whose calls are recorded and never answer, as when Linear is slow. */
class HangingLinear implements LinearAgentApi {
  readonly activities: Array<{ sessionId: string; content: ActivityContent }> = [];
  private readonly never = new Promise<never>(() => undefined);
  createActivity(sessionId: string, content: ActivityContent): Promise<void> {
    this.activities.push({ sessionId, content });
    return this.never;
  }
  setExternalUrls(): Promise<void> {
    return this.never;
  }
  setPlan(): Promise<void> {
    return this.never;
  }
  setDelegate(): Promise<void> {
    return this.never;
  }
  moveToState(): Promise<"moved"> {
    return this.never;
  }
  issueState(): Promise<{ type: string; name: string }> {
    return this.never;
  }
}

let linear: HangingLinear;

const serverDeps = (config: StewardConfig = makeConfig()) => ({
  config,
  secrets: { LINEAR_WEBHOOK_SECRET: WEBHOOK_SECRET, LINEAR_CLIENT_SECRET: "lin-secret-test" },
  stores,
  tracker,
  settings: { get: () => seedSettings(config) },
  linear,
  workerState: () => WORKER_IDLE,
});

const sign = (body: string): string => createHmac("sha256", WEBHOOK_SECRET).update(body).digest("hex");

/** Stamps a JSON body as Linear does (`webhookTimestamp`, ms), unless it carries one. */
const stamped = (raw: string, at = Date.now()): string => {
  const value: unknown = JSON.parse(raw);
  return typeof value === "object" && value !== null && !("webhookTimestamp" in value) ? JSON.stringify({ ...value, webhookTimestamp: at }) : raw;
};

const post = (event: string, delivery: string, raw: string, signature?: string) => {
  const body = stamped(raw);
  return postRaw(event, delivery, body, signature ?? sign(body));
};

const postRaw = (event: string, delivery: string, body: string, signature = sign(body)) =>
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
    linear = new HangingLinear();
    app = buildServer(serverDeps());
  });

  afterEach(async () => {
    await app.close();
    stores.db.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  describe("POST /webhooks/linear", () => {
    it("rejects an unsigned delivery and stores nothing", async () => {
      const response = await post("AgentSessionEvent", "delivery-1", sessionCreated(), "");

      expect(response.statusCode).toBe(401);
      expect(stores.jobs.list({ limit: 10 })).toEqual([]);
    });

    it("rejects a tampered body", async () => {
      const response = await post("AgentSessionEvent", "delivery-1", sessionCreated({ teamKey: "OPS" }), sign(sessionCreated()));

      expect(response.statusCode).toBe(401);
      expect(stores.jobs.list({ limit: 10 })).toEqual([]);
    });

    it("enqueues an implement when the steward is delegated a ticket", async () => {
      const response = await post("AgentSessionEvent", "delivery-1", sessionCreated());

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ ok: true, action: "implement" });
      expect(stores.jobs.list({ limit: 10 }).map((job) => job.trigger)).toEqual([
        { kind: "linear", run: "implement", issueId: "issue-1", identifier: "API-1", teamKey: "API", sessionId: "session-1", message: null },
      ]);
    });

    it("acts on a redelivery once", async () => {
      await post("AgentSessionEvent", "delivery-1", sessionCreated());
      const response = await post("AgentSessionEvent", "delivery-1", sessionCreated());

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ ok: true, action: "duplicate" });
      expect(stores.jobs.list({ limit: 10 })).toHaveLength(1);
    });

    it("acts on a replayed body once, whatever delivery header it comes with", async () => {
      const body = stamped(sessionCreated());
      await postRaw("AgentSessionEvent", "delivery-1", body);
      const replay = await postRaw("AgentSessionEvent", "delivery-forged", body);

      expect(replay.json()).toEqual({ ok: true, action: "duplicate" });
      expect(stores.jobs.list({ limit: 10 })).toHaveLength(1);
    });

    it("rejects a body signed more than a minute ago, or without a signed timestamp", async () => {
      const stale = stamped(sessionCreated(), Date.now() - 61_000);
      const bare = sessionCreated();

      expect((await postRaw("AgentSessionEvent", "delivery-1", stale)).statusCode).toBe(401);
      expect((await postRaw("AgentSessionEvent", "delivery-2", bare)).statusCode).toBe(401);
      expect(stores.jobs.list({ limit: 10 })).toEqual([]);
    });

    it("answers 200 before Linear does: a mention on an unknown ticket gets its reply posted after the response", async () => {
      const response = await post("AgentSessionEvent", "delivery-1", sessionCreated({ comment: { id: "c-1", body: "@steward hi", userId: "user-9" } }));

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ ok: true, action: "assign_me" });
      expect(linear.activities).toEqual([{ sessionId: "session-1", content: { type: "response", body: "Assign me to the ticket to start work." } }]);
      expect(stores.jobs.list({ limit: 10 })).toEqual([]);
    });

    it("ignores a session started from the steward's own comment", async () => {
      const response = await post("AgentSessionEvent", "delivery-1", sessionCreated({ comment: { id: "c-1", body: "Done.", userId: APP_USER } }));

      expect(response.json()).toEqual({ ok: true, action: "ignored" });
      expect(linear.activities).toEqual([]);
    });

    it("ignores a ticket of a team outside the allowlist", async () => {
      const response = await post("AgentSessionEvent", "delivery-1", sessionCreated({ teamKey: "OPS" }));

      expect(response.json()).toEqual({ ok: true, action: "ignored" });
      expect(stores.jobs.list({ limit: 10 })).toEqual([]);
    });

    it("ignores an Issue update that is not the steward losing the delegation, and the old label trigger", async () => {
      const update = JSON.stringify({
        action: "update",
        type: "Issue",
        data: { id: "issue-1", identifier: "API-1", team: { key: "API" }, labels: [{ id: "label-agent", name: "ready-for-agent" }] },
        updatedFrom: { labelIds: [] },
      });
      const response = await post("Issue", "delivery-1", update);

      expect(response.json()).toEqual({ ok: true, action: "ignored" });
      expect(stores.jobs.list({ limit: 10 })).toEqual([]);
    });

    it("unassigns when the steward is removed as the delegate", async () => {
      const update = JSON.stringify({
        action: "update",
        type: "Issue",
        data: { id: "issue-1", identifier: "API-1", team: { key: "API" }, delegateId: null },
        updatedFrom: { delegateId: APP_USER },
      });
      const response = await post("Issue", "delivery-1", update);

      expect(response.json()).toEqual({ ok: true, action: "unassign" });
    });

    it("posts the first thought after the reply, while the implement is still queued", async () => {
      await post("AgentSessionEvent", "delivery-1", sessionCreated());

      expect(linear.activities[0]).toEqual({ sessionId: "session-1", content: { type: "thought", body: "Picked this up; reading the ticket" } });
      expect(stores.jobs.list({ limit: 10 })[0]?.status).toBe("queued");
    });

    it("steers the ticket's open run with a prompt, naming its author", async () => {
      const channels = new RunChannels();
      await app.close();
      app = buildServer({ ...serverDeps(), channels });
      const jobId = stores.jobs.enqueue({ kind: "linear", run: "implement", issueId: "issue-1", identifier: "API-1", teamKey: "API", sessionId: "session-1", message: null });
      stores.jobs.claimById(jobId);
      channels.open(`${jobId}-1`, () => undefined, "issue-1");
      const prompt = JSON.stringify({
        action: "prompted",
        type: "AgentSessionEvent",
        appUserId: APP_USER,
        agentSession: { id: "session-1", issue: { id: "issue-1", identifier: "API-1", team: { key: "API" } } },
        agentActivity: { content: { body: "use v2" }, userId: "user-9", user: { name: "Ada" } },
      });

      const response = await post("AgentSessionEvent", "delivery-1", prompt);

      expect(response.json()).toEqual({ ok: true, action: "steer" });
      expect(await channels.next(`${jobId}-1`, 0)).toEqual([{ type: "steer", message: "Message from Ada in Linear while you were working:\nuse v2" }]);
    });

    it("logs a permission change and acts on nothing", async () => {
      const change = JSON.stringify({ type: "PermissionChange", action: "teamAccessChanged", addedTeamIds: [], removedTeamIds: ["team-9"], organizationId: "org-1" });

      const response = await post("PermissionChange", "delivery-1", change);

      expect(response.json()).toEqual({ ok: true, action: "logged" });
      expect(stores.jobs.list({ limit: 10 })).toEqual([]);
    });

    it("answers 503, recording nothing, while the app's own user cannot be read", async () => {
      vi.spyOn(tracker, "appUserId").mockRejectedValue(new Error("Linear down"));

      const response = await post("AgentSessionEvent", "delivery-1", sessionCreated());

      expect(response.statusCode).toBe(503);
      expect(stores.deliveries.seen("linear-session-created:session-1")).toBe(false);
    });
  });

  describe("POST /webhooks/gitlab", () => {
    const SIGNING_KEY = Buffer.from("0123456789abcdef0123456789abcdef");
    const SIGNING_TOKEN = `whsec_${SIGNING_KEY.toString("base64")}`;
    const BRANCH = "fix/API-1-keep";
    const GREPTILE = {
      botUsername: "greptile-bot", maxRounds: 5, prompt: "/dev/null", pollSeconds: 300, mrTimeoutMinutes: 30,
      reviewTimeoutMinutes: 30, pipelineTimeoutMinutes: 30, ciLogLines: 200,
    };

    const project = (id = 42, path = "acme/repo") => ({ id, path_with_namespace: path });
    const mrEvent = (over: { branch?: string; iid?: number; projectId?: number; path?: string } = {}) =>
      JSON.stringify({
        object_kind: "merge_request",
        project: project(over.projectId, over.path),
        object_attributes: { iid: over.iid ?? 7, source_branch: over.branch ?? BRANCH, action: "open" },
      });
    const noteEvent = (action: string) =>
      JSON.stringify({
        object_kind: "note",
        project: project(),
        object_attributes: { noteable_type: "MergeRequest", action },
        merge_request: { iid: 7, source_branch: BRANCH },
      });
    const pipelineEvent = () =>
      JSON.stringify({ object_kind: "pipeline", project: project(), object_attributes: { ref: BRANCH, status: "success" }, merge_request: null });

    const signedHeaders = (body: string, id = "msg_1"): Record<string, string> => {
      const ts = Math.floor(Date.now() / 1000);
      const signature = `v1,${createHmac("sha256", SIGNING_KEY).update(`${id}.${ts}.${body}`).digest("base64")}`;
      return { "webhook-id": id, "webhook-timestamp": String(ts), "webhook-signature": signature };
    };

    const postGitlab = (event: string, body: string, headers: Record<string, string> = signedHeaders(body)) =>
      app.inject({
        method: "POST",
        url: "/webhooks/gitlab",
        headers: { "content-type": "application/json", "x-gitlab-event": event, ...headers },
        payload: body,
      });

    /** A loop on BRANCH in `state`, with its await job deferred five minutes out. */
    const waitingLoop = (state: "awaiting_mr" | "awaiting_review" | "fixing", mr: { projectId: number; mrIid: number } | null = null) => {
      const implementJobId = stores.jobs.enqueue({ kind: "cli", issueId: "issue-1", identifier: "API-1", teamKey: "API", action: "implement" });
      stores.jobs.claimById(implementJobId);
      stores.jobs.finish(implementJobId, { status: "succeeded" });
      const loopId = stores.loops.create({
        issueId: "issue-1", identifier: "API-1", teamKey: "API", implementJobId, branch: BRANCH, baseSha: "b".repeat(40),
        headSha: "h".repeat(40), worktreeName: "API-1-1", labelDriven: true, sessionId: null,
      });
      stores.loops.update(loopId, { state, ...(mr === null ? {} : mr) });
      const jobId = stores.jobs.enqueue({ kind: "loop", issueId: "issue-1", identifier: "API-1", teamKey: "API", loopId, step: "await" });
      stores.jobs.claimById(jobId);
      stores.jobs.defer(jobId, new Date(Date.now() + 300_000));
      return { loopId, jobId };
    };

    const isDue = (jobId: number): boolean => {
      const notBefore = stores.jobs.get(jobId)?.notBefore;
      return notBefore !== null && notBefore !== undefined && Date.parse(notBefore) <= Date.now();
    };

    beforeEach(async () => {
      await app.close();
      app = buildServer({
        config: { ...makeConfig(), greptile: GREPTILE },
        secrets: { LINEAR_WEBHOOK_SECRET: WEBHOOK_SECRET, GITLAB_WEBHOOK_SIGNING_TOKEN: SIGNING_TOKEN },
        stores,
        tracker,
        settings: { get: () => seedSettings({}) },
        workerState: () => WORKER_IDLE,
      });
    });

    it("wakes the waiting loop on a signed merge request event", async () => {
      const { jobId } = waitingLoop("awaiting_mr");

      const response = await postGitlab("Merge Request Hook", mrEvent());

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ ok: true, action: "woken" });
      expect(isDue(jobId)).toBe(true);
      expect(stores.jobs.list({ limit: 10 })).toHaveLength(2);
    });

    it("rejects a bad signature with 401 and wakes nothing", async () => {
      const { jobId } = waitingLoop("awaiting_mr");
      const body = mrEvent();
      const headers = { ...signedHeaders(body), "webhook-signature": "v1,bogus" };

      const response = await postGitlab("Merge Request Hook", body, headers);

      expect(response.statusCode).toBe(401);
      expect(isDue(jobId)).toBe(false);
    });

    it("rejects a signed event with a stale timestamp", async () => {
      const { jobId } = waitingLoop("awaiting_mr");
      const body = mrEvent();
      const ts = Math.floor(Date.now() / 1000) - 301;
      const signature = `v1,${createHmac("sha256", SIGNING_KEY).update(`msg_1.${ts}.${body}`).digest("base64")}`;

      const response = await postGitlab("Merge Request Hook", body, { "webhook-id": "msg_1", "webhook-timestamp": String(ts), "webhook-signature": signature });

      expect(response.statusCode).toBe(401);
      expect(isDue(jobId)).toBe(false);
    });

    it("accepts a signed event larger than Fastify's default 1 MiB body limit", async () => {
      const { jobId } = waitingLoop("awaiting_mr");
      const body = JSON.stringify({ ...JSON.parse(mrEvent()), builds: "x".repeat(2 * 1024 * 1024) });

      const response = await postGitlab("Merge Request Hook", body);

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ ok: true, action: "woken" });
      expect(isDue(jobId)).toBe(true);
    });

    it("accepts the legacy secret token", async () => {
      await app.close();
      app = buildServer({
        config: { ...makeConfig(), greptile: GREPTILE },
        secrets: { GITLAB_WEBHOOK_SECRET: "gitlab-secret-value" },
        stores,
        tracker,
        settings: { get: () => seedSettings({}) },
        workerState: () => WORKER_IDLE,
      });
      const { jobId } = waitingLoop("awaiting_mr");

      const response = await postGitlab("Merge Request Hook", mrEvent(), { "x-gitlab-token": "gitlab-secret-value" });

      expect(response.json()).toEqual({ ok: true, action: "woken" });
      expect(isDue(jobId)).toBe(true);
    });

    it("ignores an event for another project", async () => {
      const { jobId } = waitingLoop("awaiting_mr");

      const response = await postGitlab("Merge Request Hook", mrEvent({ projectId: 99, path: "acme/other" }));

      expect(response.json()).toEqual({ ok: true, action: "ignored" });
      expect(isDue(jobId)).toBe(false);
    });

    it("compares by the loop's stored project id once it has one", async () => {
      const { jobId } = waitingLoop("awaiting_review", { projectId: 42, mrIid: 7 });

      expect((await postGitlab("Merge Request Hook", mrEvent({ projectId: 43 }))).json()).toEqual({ ok: true, action: "no_loop" });
      expect(isDue(jobId)).toBe(false);
      expect((await postGitlab("Merge Request Hook", mrEvent({ branch: "renamed", path: "acme/moved" }))).json()).toEqual({ ok: true, action: "woken" });
      expect(isDue(jobId)).toBe(true);
    });

    it("never wakes a loop on a note whose author and body it cannot read", async () => {
      const { jobId } = waitingLoop("awaiting_review", { projectId: 42, mrIid: 7 });

      const response = await postGitlab("Note Hook", noteEvent("update"));

      expect(response.json()).toEqual({ ok: true, action: "ignored" });
      expect(isDue(jobId)).toBe(false);
    });

    it("wakes the loop on a pipeline event for its branch", async () => {
      const { jobId } = waitingLoop("awaiting_review", { projectId: 42, mrIid: 7 });

      const response = await postGitlab("Pipeline Hook", pipelineEvent());

      expect(response.json()).toEqual({ ok: true, action: "woken" });
      expect(isDue(jobId)).toBe(true);
    });

    it("wakes a loop whose poll is running, so the poll's deferral comes due at once", async () => {
      const { jobId } = waitingLoop("awaiting_review", { projectId: 42, mrIid: 7 });
      stores.jobs.claimById(jobId);

      const response = await postGitlab("Pipeline Hook", pipelineEvent());

      expect(response.json()).toEqual({ ok: true, action: "woken" });
      expect(stores.jobs.get(jobId)?.wakeRequested).toBe(true);
      stores.jobs.defer(jobId, new Date(Date.now() + 300_000));
      expect(isDue(jobId)).toBe(true);
    });

    it("wakes a loop still waiting for its MR on that MR's pipeline", async () => {
      const { jobId } = waitingLoop("awaiting_mr");
      const body = JSON.stringify({
        object_kind: "pipeline",
        project: project(),
        object_attributes: { ref: "refs/merge-requests/7/head", status: "running" },
        merge_request: { iid: 7, source_branch: BRANCH },
      });

      const response = await postGitlab("Pipeline Hook", body);

      expect(response.json()).toEqual({ ok: true, action: "woken" });
      expect(isDue(jobId)).toBe(true);
    });

    it("reports no_loop when the matching loop has no await job to wake", async () => {
      const { jobId } = waitingLoop("awaiting_review", { projectId: 42, mrIid: 7 });
      stores.jobs.claimById(jobId);
      stores.jobs.finish(jobId, { status: "failed", error: "boom", retryable: false });

      const response = await postGitlab("Pipeline Hook", pipelineEvent());

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ ok: true, action: "no_loop" });
    });

    it("reports no_loop when no waiting loop matches", async () => {
      const { jobId } = waitingLoop("fixing");

      const response = await postGitlab("Pipeline Hook", pipelineEvent());

      expect(response.json()).toEqual({ ok: true, action: "no_loop" });
      expect(isDue(jobId)).toBe(false);
    });

    it("answers 200 to signed events it does not care about, and never enqueues", async () => {
      expect((await postGitlab("Push Hook", JSON.stringify({ object_kind: "push" }))).json()).toEqual({ ok: true, action: "ignored" });
      expect((await postGitlab("Merge Request Hook", "not json")).json()).toEqual({ ok: true, action: "ignored" });
      expect(stores.jobs.list({ limit: 10 })).toEqual([]);
    });

    describe("chat notes", () => {
      const DEVELOPER = 5;
      const REPORTER = 6;
      let gitlab: FakeGitLabMr;
      let recording: RecordingLinear;
      let noteIds = 900;

      const chatNote = (body: string, over: { branch?: string; username?: string; userId?: number; bot?: boolean; system?: boolean; noteId?: number; discussionId?: string } = {}) =>
        JSON.stringify({
          object_kind: "note",
          project: project(),
          user: { id: over.userId ?? DEVELOPER, username: over.username ?? "ada", ...(over.bot === undefined ? {} : { bot: over.bot }) },
          object_attributes: {
            id: over.noteId ?? noteIds++, noteable_type: "MergeRequest", action: "create", note: body, author_id: over.userId ?? DEVELOPER,
            discussion_id: over.discussionId ?? "disc-1", system: over.system ?? false,
          },
          merge_request: { iid: 7, source_branch: over.branch ?? BRANCH },
        });

      /** A loop on BRANCH with a session, in `state`. */
      const sessionLoop = (state: "awaiting_review" | "handed_back" | "unassigned" = "awaiting_review"): number => {
        const implementJobId = stores.jobs.enqueue({ kind: "cli", issueId: "issue-1", identifier: "API-1", teamKey: "API", action: "implement" });
        stores.jobs.claimById(implementJobId);
        stores.jobs.finish(implementJobId, { status: "succeeded" });
        const loopId = stores.loops.create({
          issueId: "issue-1", identifier: "API-1", teamKey: "API", implementJobId, branch: BRANCH, baseSha: "b".repeat(40),
          headSha: "h".repeat(40), worktreeName: "ticket-API-1", labelDriven: true, sessionId: "session-1",
        });
        stores.loops.update(loopId, { state, projectId: 42, mrIid: 7 });
        return loopId;
      };

      const jobsOfKind = (kind: string) => stores.jobs.list({ limit: 50 }).filter((job) => job.kind === kind);

      beforeEach(async () => {
        await app.close();
        gitlab = new FakeGitLabMr();
        gitlab.members.set(DEVELOPER, 30);
        gitlab.members.set(REPORTER, 20);
        recording = new RecordingLinear();
        app = buildServer({
          config: { ...makeConfig(), greptile: GREPTILE, chat: { prefix: "/agent", sessionRetentionDays: 180 } },
          secrets: { LINEAR_WEBHOOK_SECRET: WEBHOOK_SECRET, GITLAB_WEBHOOK_SIGNING_TOKEN: SIGNING_TOKEN },
          stores,
          tracker,
          settings: { get: () => seedSettings({}) },
          workerState: () => WORKER_IDLE,
          gitlab,
          linear: recording,
        });
      });

      it("enqueues a chat on the loop's subject for a Developer's prefixed note, with the message after the prefix", async () => {
        const loopId = sessionLoop();

        const response = await postGitlab("Note Hook", chatNote("  /AGENT why did you drop the retry?\nSee line 3.", { noteId: 501 }));

        expect(response.json()).toEqual({ ok: true, action: "chat" });
        const [chat] = jobsOfKind("chat");
        expect(chat?.subject).toBe(`loop:${loopId}`);
        expect(chat?.trigger).toEqual({
          kind: "chat", issueId: "issue-1", identifier: "API-1", teamKey: "API", loopId, projectId: 42, mrIid: 7,
          discussionId: "disc-1", noteId: 501, author: "ada", message: "why did you drop the retry?\nSee line 3.",
        });
        expect(gitlab.replies).toEqual([]);
      });

      it("queues one round a quiet window out for notes without the prefix, and no chat", async () => {
        const loopId = sessionLoop();

        expect((await postGitlab("Note Hook", chatNote("why did you drop the retry?"))).json()).toEqual({ ok: true, action: "queued_round" });
        expect((await postGitlab("Note Hook", chatNote("/agentic workflows are neat"))).json()).toEqual({ ok: true, action: "queued_round" });

        expect(jobsOfKind("chat")).toEqual([]);
        const awaits = jobsOfKind("await_review");
        expect(awaits.map((job) => job.subject)).toEqual([`loop:${loopId}`]);
        expect(isDue(awaits[0]?.id ?? 0)).toBe(false);
        expect(stores.loops.get(loopId)?.pendingNotesSince).toEqual(expect.any(String));
      });

      it("queues a round when Greptile edits its summary note", async () => {
        sessionLoop();

        const response = await postGitlab("Note Hook", chatNote("Confidence 3/5", { username: "greptile-bot", userId: 999, noteId: 950 }));

        expect(response.json()).toEqual({ ok: true, action: "queued_round" });
        expect(jobsOfKind("await_review")).toHaveLength(1);
      });

      it("keeps a batch's quiet window when the pipeline finishes meanwhile", async () => {
        const loopId = sessionLoop();
        await postGitlab("Note Hook", chatNote("please add a test"));
        const [batched] = jobsOfKind("await_review");

        const response = await postGitlab("Pipeline Hook", pipelineEvent());

        expect(response.json()).toEqual({ ok: true, action: "queued_round" });
        expect(stores.jobs.get(batched?.id ?? 0)?.notBefore).toBe(batched?.notBefore);
        expect(isDue(batched?.id ?? 0)).toBe(false);
        expect(stores.loops.get(loopId)?.state).toBe("awaiting_review");
      });

      it("ignores a bare prefix with no message", async () => {
        sessionLoop();

        expect((await postGitlab("Note Hook", chatNote("/agent"))).json()).toEqual({ ok: true, action: "chat_ignored" });
        expect((await postGitlab("Note Hook", chatNote("  /agent   "))).json()).toEqual({ ok: true, action: "chat_ignored" });
        expect(jobsOfKind("chat")).toEqual([]);
      });

      it("ignores a Reporter and a non-member silently", async () => {
        sessionLoop();

        expect((await postGitlab("Note Hook", chatNote("/agent hi", { userId: REPORTER }))).json()).toEqual({ ok: true, action: "chat_denied" });
        expect((await postGitlab("Note Hook", chatNote("/agent hi", { userId: 77 }))).json()).toEqual({ ok: true, action: "chat_denied" });
        expect(jobsOfKind("chat")).toEqual([]);
        expect(gitlab.replies).toEqual([]);
      });

      it("never answers bots, Greptile, system notes or the steward's own notes", async () => {
        sessionLoop();
        const ignored = [
          chatNote("/agent hi", { bot: true }),
          chatNote("/agent hi", { username: "project_42_bot_0a1b2c" }),
          chatNote("/agent hi", { username: "group_9_bot" }),
          chatNote("/agent hi", { username: "Greptile-Bot" }),
          chatNote("/agent hi", { system: true }),
          chatNote("/agent the agent says hi\n\n<!-- ticket-steward:chat -->", { username: "steward-bot" }),
          chatNote("/agent loop note\n\n<!-- ticket-steward:loop id=1 passed -->", { username: "steward-bot" }),
        ];
        for (const body of ignored) expect((await postGitlab("Note Hook", body)).json()).toEqual({ ok: true, action: "chat_ignored" });
        expect(jobsOfKind("chat")).toEqual([]);
        expect(gitlab.replies).toEqual([]);
      });

      it("acts on a note id once, however often it is delivered or edited", async () => {
        sessionLoop();

        expect((await postGitlab("Note Hook", chatNote("/agent hi", { noteId: 600 }))).json()).toEqual({ ok: true, action: "chat" });
        expect((await postGitlab("Note Hook", chatNote("/agent hi again", { noteId: 600 }))).json()).toEqual({ ok: true, action: "chat_duplicate" });
        expect(jobsOfKind("chat")).toHaveLength(1);
      });

      it("replies once, with the marker, on a merge request with no agent session", async () => {
        const body = chatNote("/agent hi", { branch: "feature/someone-elses", noteId: 700 });

        expect((await postGitlab("Note Hook", body)).json()).toEqual({ ok: true, action: "chat_no_session" });
        expect((await postGitlab("Note Hook", body)).json()).toEqual({ ok: true, action: "chat_duplicate" });

        expect(gitlab.replies).toEqual([{ discussionId: "disc-1", body: "No agent session is attached to this merge request.\n\n<!-- ticket-steward:chat -->" }]);
        expect(stores.jobs.list({ limit: 10 })).toEqual([]);
      });

      it("chats with an implement job's session on its branch when the ticket has no loop, serialized by the ticket", async () => {
        const jobId = stores.jobs.enqueue({ kind: "cli", issueId: "issue-2", identifier: "API-2", teamKey: "API", action: "implement" });
        stores.jobs.recordWorkspace(jobId, "3-1", "b".repeat(40));
        stores.jobs.recordCommit(jobId, "feature/API-2-thing", "c".repeat(40));
        stores.jobs.markPushed(jobId);
        stores.jobs.recordSession(jobId, "session-impl");

        expect((await postGitlab("Note Hook", chatNote("/agent hi", { branch: "feature/API-2-thing" }))).json()).toEqual({ ok: true, action: "chat" });
        const [chat] = jobsOfKind("chat");
        expect(chat).toMatchObject({ issueId: "issue-2", identifier: "API-2", subject: null, trigger: { loopId: null } });
      });

      it("revives an unassigned loop on a prefixed note: the steward delegated again, the loop resumed, the chat queued", async () => {
        const loopId = sessionLoop("unassigned");

        const response = await postGitlab("Note Hook", chatNote("/agent please continue", { noteId: 801 }));

        expect(response.json()).toEqual({ ok: true, action: "chat_revive" });
        expect(jobsOfKind("restart").map((job) => job.trigger)).toEqual([
          { kind: "loop", issueId: "issue-1", identifier: "API-1", teamKey: "API", loopId, step: "restart" },
        ]);
        expect(jobsOfKind("chat").map((job) => job.trigger)).toEqual([{
          kind: "chat", issueId: "issue-1", identifier: "API-1", teamKey: "API", loopId, projectId: 42, mrIid: 7,
          discussionId: "disc-1", noteId: 801, author: "ada", message: "please continue",
        }]);
        await vi.waitFor(() => expect(recording.calls).toEqual([{ kind: "delegate", issueId: "issue-1", appUserId: FAKE_APP_USER_ID }]));
      });

      it("treats a prefixed note on a ticket unassigned before it had a loop as the reviving mention", async () => {
        const jobId = stores.jobs.enqueue({ kind: "cli", issueId: "issue-2", identifier: "API-2", teamKey: "API", action: "implement" });
        stores.jobs.recordWorkspace(jobId, "3-1", "b".repeat(40));
        stores.jobs.recordCommit(jobId, "feature/API-2-thing", "c".repeat(40));
        stores.jobs.markPushed(jobId);
        stores.jobs.recordSession(jobId, "session-impl");
        stores.agentSessions.markUnassigned("issue-2");

        expect((await postGitlab("Note Hook", chatNote("/agent push it", { branch: "feature/API-2-thing" }))).json()).toEqual({ ok: true, action: "chat_revive" });
        expect(jobsOfKind("chat")).toHaveLength(1);
        expect(stores.agentSessions.isUnassigned("issue-2")).toBe(false);
        await vi.waitFor(() => expect(recording.calls).toEqual([{ kind: "delegate", issueId: "issue-2", appUserId: FAKE_APP_USER_ID }]));
      });

      it("leaves an unassigned loop alone on a note without the prefix", async () => {
        sessionLoop("unassigned");

        expect((await postGitlab("Note Hook", chatNote("please continue"))).json()).toEqual({ ok: true, action: "ignored" });
        expect(stores.jobs.list({ status: "queued", limit: 10 })).toEqual([]);
        expect(recording.calls).toEqual([]);
      });

      it("chats on a handed-back loop without restarting it, `/agent restart` included", async () => {
        sessionLoop("handed_back");

        expect((await postGitlab("Note Hook", chatNote("/agent restart"))).json()).toEqual({ ok: true, action: "chat" });
        expect(jobsOfKind("restart")).toEqual([]);
        expect(jobsOfKind("chat")).toHaveLength(1);
      });
    });
  });

  describe("GET /health", () => {
    it("reports ok with counts and worker state", async () => {
      stores.jobs.enqueue({ kind: "cli", issueId: "issue-1", identifier: "API-1", teamKey: "API" });

      const response = await app.inject({ method: "GET", url: "/health" });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        ok: true,
        credentialsRejected: false,
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

    it("answers 503 once Linear rejected the app credentials", async () => {
      tracker.rejectCredentials();

      const response = await app.inject({ method: "GET", url: "/health" });

      expect(response.statusCode).toBe(503);
      expect(response.json().ok).toBe(false);
      expect(response.json().credentialsRejected).toBe(true);
    });

    it("lists every running slot", async () => {
      await app.close();
      const running = { running: [{ slot: 1, jobId: 12 }, { slot: 2, jobId: 14 }] };
      app = buildServer({ config: makeConfig(), secrets: {}, stores, tracker, settings: { get: () => seedSettings({}) }, workerState: () => running });

      expect((await app.inject({ method: "GET", url: "/health" })).json().worker).toEqual(running);
    });
  });

  it("serves no OAuth callback route", async () => {
    const response = await app.inject({ method: "GET", url: "/oauth/linear/callback?code=abc&state=nope" });

    expect(response.statusCode).toBe(404);
  });
});
