import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { GreptileConfig, StewardConfig } from "../../src/config/schema.js";
import { Redactor } from "../../src/core/redact.js";
import type { RunContext } from "../../src/core/types.js";
import { runRestart, startLoop } from "../../src/greptile/start.js";
import { openStores, type Job, type Loop, type Stores } from "../../src/store/index.js";
import type { TicketBundle, TriggerEvent } from "../../src/tracker/types.js";
import { FakeGitLabMr, fakeMergeRequest } from "../fakes/fakeGitLabMr.js";
import { FakeTracker } from "../fakes/fakeTracker.js";
import { freshDataDir } from "../store/helpers.js";

const HEAD = "c".repeat(40);
const BASE = "a".repeat(40);
const PERSON = "d".repeat(40);
const HANDED_BACK_AT = "2026-10-27T09:00:00.000Z";

const GREPTILE: GreptileConfig = {
  botUsername: "greptile-bot", maxRounds: 5, prompt: "/dev/null", pollSeconds: 60, mrTimeoutMinutes: 60,
  reviewTimeoutMinutes: 30, pipelineTimeoutMinutes: 60, ciLogLines: 200,
};

const labeled: TriggerEvent = {
  kind: "issue.labeled", issueId: "issue-1", identifier: "API-1", teamKey: "API", deliveryId: "d-1", description: "", stateType: "unstarted", action: "implement",
};

let dataDir: string;
let stores: Stores;

const LABELS = { implement: "ready-for-agent", needsInfo: "needs-info", readyForHuman: "ready-for-human", implemented: "agent-implemented", approved: "agent-approved" };

const depsWith = (greptile: GreptileConfig | undefined): { config: StewardConfig; stores: Stores } => {
  const config: StewardConfig = {
    dataDir,
    brain: { kind: "claude-code", model: "claude-test", maxTurns: 5, timeoutMinutes: 1 },
    tracker: { kind: "linear", teams: ["API"], labels: LABELS },
    codehost: { kind: "gitlab", baseUrl: "https://gitlab.example", project: "acme/repo" },
    workspace: { fetchUrl: "https://gitlab.example/acme/repo.git", baseBranch: "dev", overlayDir: join(dataDir, "overlay"), setup: [], setupTimeoutMinutes: 1, port: 4100, keepOnFailure: false },
    retention: { keptWorktrees: 3, days: 30 },
    server: { port: 3020, publicUrl: "https://steward.example" },
    ...(greptile === undefined ? {} : { greptile }),
  };
  return { config, stores };
};

/** An implement job that committed on a branch, pushed it unless told otherwise, and left a session. */
const implementJob = (trigger: TriggerEvent = labeled, opts: { pushed?: boolean } = {}): Job => {
  const id = stores.jobs.enqueue(trigger);
  stores.jobs.claimById(id);
  stores.jobs.recordCommit(id, "fix/API-1-adapter", HEAD);
  stores.jobs.recordSession(id, "session-1");
  if (opts.pushed !== false) stores.jobs.markPushed(id);
  const job = stores.jobs.get(id);
  if (job === null) throw new Error("job not stored");
  return job;
};

const start = { baseSha: BASE, worktreeName: "ticket-API-1" };

beforeEach(() => {
  dataDir = freshDataDir();
  stores = openStores(dataDir);
});

afterEach(() => {
  stores.db.close();
});

describe("startLoop", () => {
  it("creates a loop at round 0 from the pushed implement job and enqueues its first await", () => {
    const job = implementJob();

    const id = startLoop(depsWith(GREPTILE), job, start);

    expect(id).not.toBeNull();
    expect(stores.loops.get(id ?? 0)).toMatchObject({
      issueId: "issue-1", identifier: "API-1", teamKey: "API", implementJobId: job.id, branch: "fix/API-1-adapter", baseSha: BASE, headSha: HEAD,
      worktreeName: "ticket-API-1", labelDriven: true, sessionId: "session-1", round: 0, state: "awaiting_mr",
    });
    const awaits = stores.jobs.list({ limit: 50 }).filter((row) => row.kind === "await_review");
    expect(awaits).toHaveLength(1);
    expect(awaits[0]?.trigger).toEqual({ kind: "loop", issueId: "issue-1", identifier: "API-1", teamKey: "API", loopId: id, step: "await" });
  });

  it("is idempotent: a second call returns the same loop and enqueues nothing more", () => {
    const job = implementJob();
    const first = startLoop(depsWith(GREPTILE), job, start);

    const second = startLoop(depsWith(GREPTILE), job, start);

    expect(second).toBe(first);
    expect(stores.jobs.list({ limit: 50 }).filter((row) => row.kind === "await_review")).toHaveLength(1);
  });

  it("starts from a new-ticket implement trigger too", () => {
    const job = implementJob({ ...labeled, kind: "issue.created" });

    expect(startLoop(depsWith(GREPTILE), job, start)).not.toBeNull();
  });

  it("returns null without greptile configured", () => {
    expect(startLoop(depsWith(undefined), implementJob(), start)).toBeNull();
    expect(stores.loops.latestForIssue("issue-1")).toBeNull();
  });

  it("returns null for a cli trigger", () => {
    const job = implementJob({ kind: "cli", issueId: "issue-1", identifier: "API-1", teamKey: "API", action: "implement" });

    expect(startLoop(depsWith(GREPTILE), job, start)).toBeNull();
    expect(stores.loops.latestForIssue("issue-1")).toBeNull();
  });

  it("returns null for a label trigger that is not implement", () => {
    const unlabeled: TriggerEvent = { kind: "issue.labeled", issueId: "issue-1", identifier: "API-1", teamKey: "API", deliveryId: "d-1", description: "", stateType: "unstarted" };
    expect(startLoop(depsWith(GREPTILE), implementJob(unlabeled), start)).toBeNull();
  });

  it("returns null before the push", () => {
    expect(startLoop(depsWith(GREPTILE), implementJob(labeled, { pushed: false }), start)).toBeNull();
    expect(stores.jobs.list({ limit: 50 }).filter((row) => row.kind === "await_review")).toHaveLength(0);
  });
});

const issue: TicketBundle = {
  id: "issue-1",
  identifier: "API-1",
  url: "https://linear.app/acme/issue/API-1",
  title: "Adapter drops the last chunk",
  description: "The adapter loses the final chunk.",
  team: { id: "team-1", key: "API", name: "API" },
  state: { name: "In Review", type: "started" },
  labels: ["ready-for-agent", "ready-for-human"],
  priority: 2,
  creator: { name: "Ada", isBot: false },
  createdAt: "2026-10-27T00:00:00.000Z",
  comments: [],
  attachments: [],
  appliedTemplate: null,
  templates: [],
};

describe("runRestart", () => {
  let tracker: FakeTracker;
  let gitlab: FakeGitLabMr;

  beforeEach(() => {
    tracker = new FakeTracker([structuredClone(issue)]);
    gitlab = new FakeGitLabMr();
  });

  const restartDeps = () => ({ ...depsWith(GREPTILE), tracker, gitlab, redactor: new Redactor([]) });

  const queued = (kind: string): Job[] => stores.jobs.list({ limit: 50 }).filter((row) => row.kind === kind && row.status === "queued");

  /** A loop that ran three rounds and was handed back; its first await has run. */
  const handedBackLoop = (): number => {
    const id = startLoop(depsWith(GREPTILE), implementJob(), start);
    if (id === null) throw new Error("no loop");
    for (const job of queued("await_review")) {
      stores.jobs.claimById(job.id);
      stores.jobs.finish(job.id, { status: "succeeded" });
    }
    stores.loops.appendRound(id, { round: 3, headSha: HEAD, score: 4, pipeline: "success", fixed: 1, declined: 0, outcome: "handed_back" });
    stores.loops.update(id, {
      projectId: 42, mrIid: 7, mrUrl: "https://gitlab.example/acme/repo/-/merge_requests/7", round: 3, state: "handed_back",
      waitStartedAt: "2026-10-27T08:00:00.000Z", reviewCountAtTrigger: 2, handedBackAt: HANDED_BACK_AT,
    });
    return id;
  };

  const claimRestart = (loopId: number, labelDriven: boolean): RunContext => {
    const trigger: TriggerEvent = { kind: "loop", issueId: "issue-1", identifier: "API-1", teamKey: "API", loopId, step: "restart", labelDriven };
    const jobId = stores.jobs.enqueue(trigger);
    stores.jobs.claimById(jobId);
    return { jobId, attempt: 1, issueId: "issue-1", identifier: "API-1", teamKey: "API", trigger, dryRun: false };
  };

  const loopOf = (id: number): Loop => {
    const loop = stores.loops.get(id);
    if (loop === null) throw new Error(`loop ${id} missing`);
    return loop;
  };

  it("adopts a person's head on the open MR, resets the round, queues an await and swaps the label back", async () => {
    gitlab.openMr = fakeMergeRequest({ sha: PERSON, sourceBranch: "fix/API-1-adapter" });
    const id = handedBackLoop();

    const outcome = await runRestart(claimRestart(id, true), restartDeps());

    expect(outcome).toEqual({ status: "succeeded" });
    const loop = loopOf(id);
    expect(loop).toMatchObject({
      state: "awaiting_review", round: 0, adoptedFrom: HEAD, headSha: PERSON, projectId: 42, mrIid: 7,
      mrUrl: "https://gitlab.example/acme/repo/-/merge_requests/7", waitStartedAt: null, reviewCountAtTrigger: null, endedAt: null,
      labelDriven: true, handedBackAt: HANDED_BACK_AT, sessionId: "session-1",
    });
    expect(loop.history).toHaveLength(1);
    expect(queued("await_review").map((job) => job.trigger)).toEqual([
      { kind: "loop", issueId: "issue-1", identifier: "API-1", teamKey: "API", loopId: id, step: "await" },
    ]);
    expect(tracker.labelSwaps()).toEqual([{ issueId: "issue-1", from: "ready-for-agent", to: "agent-implemented" }]);
  });

  it("adopts nothing when the MR is still at the steward's last push", async () => {
    gitlab.openMr = fakeMergeRequest({ sha: HEAD });
    const id = handedBackLoop();

    await runRestart(claimRestart(id, true), restartDeps());

    expect(loopOf(id)).toMatchObject({ adoptedFrom: null, headSha: HEAD, state: "awaiting_review" });
  });

  it("leaves labels alone for a steward fix restart and records the loop as not label-driven", async () => {
    gitlab.openMr = fakeMergeRequest({ sha: PERSON });
    const id = handedBackLoop();

    await runRestart(claimRestart(id, false), restartDeps());

    expect(loopOf(id).labelDriven).toBe(false);
    expect(tracker.labelSwaps()).toEqual([]);
  });

  it("with no open MR, says so on Linear and queues a fresh implement from the label", async () => {
    const id = handedBackLoop();

    const outcome = await runRestart(claimRestart(id, true), restartDeps());

    expect(outcome).toEqual({ status: "succeeded" });
    expect(tracker.comments("issue-1")).toHaveLength(1);
    expect(tracker.comments("issue-1")[0]).toContain("no open merge request for fix/API-1-adapter; starting a fresh implement");
    expect(tracker.comments("issue-1")[0]).toContain("<!-- ticket-steward:loop");
    const implement = queued("implement");
    expect(implement).toHaveLength(1);
    expect(implement[0]?.trigger).toMatchObject({ kind: "issue.labeled", issueId: "issue-1", identifier: "API-1", teamKey: "API", action: "implement" });
    expect(loopOf(id).state).toBe("handed_back");
  });

  it("with no open MR, a steward fix restart queues a CLI implement that leaves labels alone", async () => {
    const id = handedBackLoop();

    await runRestart(claimRestart(id, false), restartDeps());

    expect(queued("implement")[0]?.trigger).toEqual({ kind: "cli", issueId: "issue-1", identifier: "API-1", teamKey: "API", action: "implement" });
  });

  it("does nothing for a loop that is not handed back", async () => {
    gitlab.openMr = fakeMergeRequest({ sha: PERSON });
    const id = handedBackLoop();
    stores.loops.update(id, { state: "awaiting_review" });

    const outcome = await runRestart(claimRestart(id, true), restartDeps());

    expect(outcome).toEqual({ status: "succeeded", warning: `loop ${id} is awaiting_review, not handed back` });
    expect(loopOf(id).headSha).toBe(HEAD);
    expect(tracker.labelSwaps()).toEqual([]);
  });
});
