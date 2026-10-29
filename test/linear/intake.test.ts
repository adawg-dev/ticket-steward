import { join } from "node:path";
import type { StewardConfig } from "../../src/config/schema.js";
import { linearIntake, type LinearIntakeDeps } from "../../src/linear/intake.js";
import { DEFAULT_SETTINGS, type Settings } from "../../src/settings/schema.js";
import { openStores, type LoopState, type Stores } from "../../src/store/index.js";
import type { LinearEvent } from "../../src/tracker/linear/webhook.js";
import type { TriggerEvent } from "../../src/tracker/types.js";
import { freshDataDir } from "../store/helpers.js";

const ISSUE = { issueId: "issue-1", identifier: "API-1", teamKey: "API" };

let dataDir: string;
let stores: Stores;
let settings: Settings;
let deliveries = 0;

const makeConfig = (over: Partial<StewardConfig> = {}): StewardConfig => ({
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
  implement: {
    prompt: "./prompts/implement.md",
    branchTypes: ["feature", "fix"],
    checks: [],
    checksTimeoutMinutes: 20,
    commitAuthor: { name: "Ticket Steward", email: "steward@example.com" },
    timeoutMinutes: 60,
    maxTurns: 150,
    protectedBranches: ["main"],
  },
  ...over,
});

const deps = (config: StewardConfig = makeConfig()): LinearIntakeDeps => ({ config, stores, settings: { get: () => settings } });

const delivery = (): string => `d-${(deliveries += 1)}`;

const created = (over: Partial<Extract<LinearEvent, { kind: "session.created" }>> = {}): LinearEvent => ({
  kind: "session.created", deliveryId: delivery(), sessionId: "session-1", ...ISSUE, delegated: true, commentBody: null, promptContext: "<issue/>", byApp: false, ...over,
});

const mention = (body = "@steward why is this slow?", over: Partial<Extract<LinearEvent, { kind: "session.created" }>> = {}): LinearEvent =>
  created({ sessionId: "session-2", delegated: false, commentBody: body, ...over });

const prompted = (over: Partial<Extract<LinearEvent, { kind: "session.prompted" }>> = {}): LinearEvent => ({
  kind: "session.prompted", deliveryId: delivery(), sessionId: "session-1", ...ISSUE, body: "use v2 instead", stop: false, authorName: "Ada", byApp: false, ...over,
});

const undelegated = (): LinearEvent => ({ kind: "issue.undelegated", deliveryId: delivery(), ...ISSUE });

const linearImplement: TriggerEvent = { kind: "linear", run: "implement", ...ISSUE, sessionId: "session-0", message: null };

/** A finished implement job that left a brain session; `pushed` gives it a branch. */
const finishedImplement = (pushed: boolean): number => {
  const jobId = stores.jobs.enqueue(linearImplement);
  stores.jobs.claimById(jobId);
  stores.jobs.recordWorkspace(jobId, "ticket-API-1", "a".repeat(40));
  stores.jobs.recordSession(jobId, "claude-session-1");
  if (pushed) {
    stores.jobs.recordCommit(jobId, "fix/API-1-keep", "b".repeat(40));
    stores.jobs.markPushed(jobId);
  }
  stores.jobs.finish(jobId, { status: "succeeded" });
  return jobId;
};

const loopIn = (state: LoopState): number => {
  const jobId = finishedImplement(true);
  const loopId = stores.loops.create({
    ...ISSUE, implementJobId: jobId, branch: "fix/API-1-keep", baseSha: "a".repeat(40), headSha: "b".repeat(40),
    worktreeName: "ticket-API-1", labelDriven: true, sessionId: "claude-session-1",
  });
  stores.loops.update(loopId, { state });
  return loopId;
};

const needsInfoImplement = (): number => {
  const jobId = stores.jobs.enqueue(linearImplement);
  stores.jobs.claimById(jobId);
  stores.jobs.recordWorkspace(jobId, "ticket-API-1", "a".repeat(40));
  stores.jobs.recordSession(jobId, "claude-session-1");
  stores.jobs.saveImplementResult(jobId, {
    result: { outcome: "needs_info", summary: "Which adapter?", reviewNotes: [], checksRun: [], questions: ["Which adapter?"], failureDetail: null, media: [] },
    handback: { label: "needsInfo", reason: "the ticket needs more information", detail: "" },
  });
  stores.jobs.finish(jobId, { status: "succeeded" });
  return jobId;
};

const queued = (): TriggerEvent[] => stores.jobs.list({ status: "queued", limit: 50 }).map((job) => job.trigger);

beforeEach(() => {
  vi.restoreAllMocks();
  dataDir = freshDataDir();
  stores = openStores(dataDir);
  settings = { ...DEFAULT_SETTINGS };
});

afterEach(() => {
  stores.db.close();
});

describe("linearIntake", () => {
  describe("a session created by delegation", () => {
    it("enqueues an implement job for a ticket the steward never had", async () => {
      const result = await linearIntake(deps(), created());

      expect(result.action).toBe("implement");
      const job = stores.jobs.get(result.jobId ?? -1);
      expect(job?.kind).toBe("implement");
      expect(job?.trigger).toEqual({ kind: "linear", run: "implement", ...ISSUE, sessionId: "session-1", message: null });
      expect(stores.agentSessions.current("issue-1")).toBe("session-1");
    });

    it("acts on a redelivery once", async () => {
      const event = created();

      expect((await linearIntake(deps(), event)).action).toBe("implement");
      expect(await linearIntake(deps(), event)).toEqual({ action: "duplicate" });
      expect(queued()).toHaveLength(1);
    });

    it.each<LoopState>(["unassigned", "handed_back", "stopped"])("resumes a ticket whose loop is %s at its MR head and starts no second implement", async (state) => {
      const loopId = loopIn(state);

      const result = await linearIntake(deps(), created());

      expect(result.action).toBe("revive");
      expect(stores.jobs.get(result.jobId ?? -1)?.trigger).toEqual({ kind: "loop", ...ISSUE, loopId, step: "restart" });
      expect(queued()).toEqual([{ kind: "loop", ...ISSUE, loopId, step: "restart" }]);
    });

    it("leaves a loop that is still running as it is", async () => {
      loopIn("awaiting_review");

      expect(await linearIntake(deps(), created())).toEqual({ action: "revive" });
      expect(queued()).toEqual([]);
    });

    it("revives a ticket whose implement pushed a branch without a loop", async () => {
      finishedImplement(true);

      expect((await linearIntake(deps(), created())).action).toBe("revive");
      expect(queued()).toEqual([]);
    });

    it("leaves a queued implement alone, the new session becoming current", async () => {
      stores.jobs.enqueue(linearImplement);

      expect((await linearIntake(deps(), created({ sessionId: "session-new" }))).action).toBe("ignored");
      expect(queued()).toHaveLength(1);
      expect(stores.agentSessions.current("issue-1")).toBe("session-new");
    });

    it("implements again after an implement that pushed nothing", async () => {
      finishedImplement(false);

      expect((await linearIntake(deps(), created())).action).toBe("implement");
    });

    it("ignores a ticket of a team outside the allowlist, and does nothing when implement is not configured", async () => {
      expect((await linearIntake(deps(), created({ teamKey: "OPS" }))).action).toBe("ignored");
      const noImplement = makeConfig();
      delete noImplement.implement;
      expect((await linearIntake(deps(noImplement), created())).action).toBe("ignored");
      expect(queued()).toEqual([]);
    });
  });

  describe("a session created by a mention", () => {
    it("answers assign_me on a ticket the steward never had", async () => {
      expect(await linearIntake(deps(), mention())).toEqual({ action: "assign_me" });
      expect(queued()).toEqual([]);
      expect(stores.agentSessions.current("issue-1")).toBe("session-2");
    });

    it("chats with the comment as the message when the ticket has a loop", async () => {
      loopIn("awaiting_review");

      const result = await linearIntake(deps(), mention("@steward also cover the retry path"));

      expect(result.action).toBe("chat");
      const job = stores.jobs.get(result.jobId ?? -1);
      expect(job?.kind).toBe("chat");
      expect(job?.trigger).toEqual({ kind: "linear", run: "chat", ...ISSUE, sessionId: "session-2", message: "@steward also cover the retry path" });
    });

    it("chats when the ticket has only an implement session", async () => {
      finishedImplement(false);

      expect((await linearIntake(deps(), mention())).action).toBe("chat");
    });

    it("revives an unassigned loop: its restart step, then a chat with the mention", async () => {
      const loopId = loopIn("unassigned");

      const result = await linearIntake(deps(), mention("@steward please continue"));

      expect(result.action).toBe("revive");
      const chat = { kind: "linear", run: "chat", ...ISSUE, sessionId: "session-2", message: "@steward please continue" };
      expect(stores.jobs.get(result.jobId ?? -1)?.trigger).toEqual(chat);
      expect(stores.jobs.queuedForIssue("issue-1").map((job) => job.trigger)).toEqual([{ kind: "loop", ...ISSUE, loopId, step: "restart" }, chat]);
    });

    it("ignores a mention on an unassigned loop with revive by mention off", async () => {
      loopIn("unassigned");
      settings = { ...settings, "linear.reviveByMention": false };

      expect((await linearIntake(deps(), mention())).action).toBe("ignored");
      expect(queued()).toEqual([]);
    });

    it("ignores a session started from a comment the steward wrote itself", async () => {
      loopIn("awaiting_review");

      expect((await linearIntake(deps(), mention("Picked this up", { byApp: true }))).action).toBe("ignored");
      expect(queued()).toEqual([]);
    });
  });

  describe("a prompt", () => {
    it("stops on the stop signal", async () => {
      loopIn("fixing");

      expect(await linearIntake(deps(), prompted({ stop: true }))).toEqual({ action: "stop" });
    });

    it("steers the run active on the ticket", async () => {
      const loopId = loopIn("fixing");
      stores.jobs.enqueue({ kind: "loop", ...ISSUE, loopId, step: "fix" });
      stores.jobs.claimNext();

      expect(await linearIntake(deps(), prompted())).toEqual({ action: "steer" });
      expect(queued()).toEqual([]);
    });

    it("resumes an implement that ended needing information, with the reply as its message", async () => {
      needsInfoImplement();

      const result = await linearIntake(deps(), prompted({ body: "The S3 adapter." }));

      expect(result.action).toBe("resume_implement");
      const job = stores.jobs.get(result.jobId ?? -1);
      expect(job?.kind).toBe("implement");
      expect(job?.trigger).toEqual({ kind: "linear", run: "implement", ...ISSUE, sessionId: "session-1", message: "The S3 adapter.", author: "Ada" });
    });

    it("waits for a terminal session's lease, its chat queued", async () => {
      loopIn("awaiting_review");
      stores.leases.create({ issueId: "issue-1", worktreeName: "ticket-API-1", slot: null, pid: 4242 });

      const result = await linearIntake(deps(), prompted());

      expect(result.action).toBe("wait_for_lease");
      expect(stores.jobs.get(result.jobId ?? -1)?.trigger).toMatchObject({ kind: "linear", run: "chat", message: "use v2 instead" });
    });

    it("chats otherwise", async () => {
      loopIn("awaiting_review");

      const result = await linearIntake(deps(), prompted());

      expect(result.action).toBe("chat");
      expect(stores.jobs.get(result.jobId ?? -1)?.kind).toBe("chat");
    });

    it("answers assign_me when the ticket has no session to chat with", async () => {
      expect((await linearIntake(deps(), prompted())).action).toBe("assign_me");
      expect(queued()).toEqual([]);
    });

    it("is ignored on an unassigned loop, even a stop", async () => {
      loopIn("unassigned");

      expect((await linearIntake(deps(), prompted())).action).toBe("ignored");
      expect((await linearIntake(deps(), prompted({ stop: true }))).action).toBe("ignored");
      expect(queued()).toEqual([]);
    });

    it("ignores a prompt by the steward itself", async () => {
      loopIn("awaiting_review");

      expect((await linearIntake(deps(), prompted({ byApp: true }))).action).toBe("ignored");
    });

    it("records the prompt's session for the ticket", async () => {
      loopIn("awaiting_review");

      await linearIntake(deps(), prompted({ sessionId: "session-7" }));

      expect(stores.agentSessions.issueOf("session-7")).toBe("issue-1");
    });
  });

  it("unassigns when the steward is removed as delegate", async () => {
    loopIn("awaiting_review");

    expect(await linearIntake(deps(), undelegated())).toEqual({ action: "unassign" });
  });
});
