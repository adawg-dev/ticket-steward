import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { StewardConfig } from "../../src/config/schema.js";
import type { PipelineDeps } from "../../src/core/pipeline.js";
import { Redactor } from "../../src/core/redact.js";
import type { RunContext } from "../../src/core/types.js";
import { runAwaitReview } from "../../src/greptile/await.js";
import { LOOP_MARKER, publishHandback } from "../../src/greptile/publish.js";
import { openStores, type Loop, type Stores } from "../../src/store/index.js";
import type { TicketBundle, TriggerEvent } from "../../src/tracker/types.js";
import { Mirror } from "../../src/workspace/mirror.js";
import { FakeBrain } from "../fakes/fakeBrain.js";
import { FakeCodeHost } from "../fakes/fakeCodeHost.js";
import { FakeGitLabMr, fakeMergeRequest } from "../fakes/fakeGitLabMr.js";
import { FakeTracker } from "../fakes/fakeTracker.js";
import { freshDataDir } from "../store/helpers.js";

const NOW = new Date("2026-10-27T12:00:00.000Z");
const SHA = "c".repeat(40);
const GREPTILE = "greptile-bot";
const LABELS = { triage: "needs-triage", implement: "ready-for-agent", needsInfo: "needs-info", readyForHuman: "ready-for-human", implemented: "agent-implemented", approved: "agent-approved" };

const issue: TicketBundle = {
  id: "issue-1",
  identifier: "API-1",
  url: "https://linear.app/acme/issue/API-1",
  title: "Adapter drops the last chunk",
  description: "The adapter loses the final chunk.",
  team: { id: "team-1", key: "API", name: "API" },
  state: { name: "In Review", type: "started" },
  labels: ["agent-implemented"],
  priority: 2,
  creator: { name: "Ada", isBot: false },
  createdAt: "2026-10-27T00:00:00.000Z",
  comments: [],
  attachments: [],
  appliedTemplate: null,
  templates: [],
};

const summaryBody = (score: number, sha = SHA): string =>
  `<h3>Greptile Summary</h3>\n\n### Confidence Score: ${score}/5\n\n<sub>Reviews (1): Last reviewed commit: [fix](https://gitlab.example/acme/repo/-/commit/${sha})</sub>`;

let dataDir: string;
let stores: Stores;
let tracker: FakeTracker;
let gitlab: FakeGitLabMr;

const makeConfig = (): StewardConfig => ({
  dataDir,
  brain: { kind: "claude-code", model: "claude-test", maxTurns: 5, timeoutMinutes: 1 },
  tracker: { kind: "linear", teams: ["API"], gatewayIssues: "enrich", bugLabels: ["Bug"], labels: LABELS },
  codehost: { kind: "gitlab", baseUrl: "https://gitlab.example", project: "acme/repo" },
  workspace: { fetchUrl: "https://gitlab.example/acme/repo.git", baseBranch: "dev", overlayDir: join(dataDir, "overlay"), setup: [], setupTimeoutMinutes: 1, port: 4100, keepOnFailure: false },
  retention: { keptWorktrees: 3, days: 30 },
  prompt: join(dataDir, "prompt.md"),
  server: { port: 3020, publicUrl: "https://steward.example" },
  implement: {
    prompt: join(dataDir, "implement.md"),
    branchTypes: ["fix"],
    checks: [],
    checksTimeoutMinutes: 1,
    commitAuthor: { name: "Ticket Steward", email: "steward@example.com" },
    timeoutMinutes: 1,
    maxTurns: 5,
    protectedBranches: ["main"],
  },
  greptile: {
    botUsername: GREPTILE, maxRounds: 5, prompt: join(dataDir, "fix.md"), pollSeconds: 60, mrTimeoutMinutes: 60,
    reviewTimeoutMinutes: 30, pipelineTimeoutMinutes: 60, ciLogLines: 200,
  },
});

const makeDeps = (): PipelineDeps => ({
  config: makeConfig(),
  secrets: {},
  configPath: join(dataDir, "steward.config.ts"),
  binPath: join(dataDir, "bin", "steward.js"),
  tracker,
  brain: new FakeBrain(),
  codehost: new FakeCodeHost(),
  gitlab,
  mirror: new Mirror(join(dataDir, "repo.git"), "https://gitlab.example/acme/repo.git"),
  stores,
  redactor: new Redactor([]),
  now: () => NOW,
});

/** A finished implement job for the loop to come from. */
const implementJob = (): number => {
  const jobId = stores.jobs.enqueue({ kind: "cli", issueId: "issue-1", identifier: "API-1", teamKey: "API", action: "implement" });
  stores.jobs.claimById(jobId);
  stores.jobs.finish(jobId, { status: "succeeded" });
  return jobId;
};

const createLoop = (labelDriven = true): number =>
  stores.loops.create({
    issueId: "issue-1", identifier: "API-1", teamKey: "API", implementJobId: implementJob(), branch: "api-1-fix", baseSha: "a".repeat(40),
    headSha: SHA, worktreeName: "API-1-1", labelDriven, sessionId: "session-1",
  });

/** A loop whose MR is already known, as after a first successful poll. */
const knownMrLoop = (labelDriven = true): number => {
  const id = createLoop(labelDriven);
  stores.loops.update(id, { projectId: 42, mrIid: 7, mrUrl: gitlab.mr.webUrl, state: "awaiting_review", waitStartedAt: NOW.toISOString() });
  return id;
};

const claim = (loopId: number): RunContext => {
  const trigger: TriggerEvent = { kind: "loop", issueId: "issue-1", identifier: "API-1", teamKey: "API", loopId, step: "await" };
  const jobId = stores.jobs.enqueue(trigger);
  stores.jobs.claimById(jobId);
  stores.attempts.start(jobId);
  return { jobId, attempt: 1, issueId: "issue-1", identifier: "API-1", teamKey: "API", trigger, dryRun: false };
};

const loopOf = (id: number): Loop => {
  const loop = stores.loops.get(id);
  if (loop === null) throw new Error(`loop ${id} missing`);
  return loop;
};

beforeEach(() => {
  dataDir = freshDataDir();
  stores = openStores(dataDir);
  tracker = new FakeTracker([structuredClone(issue)]);
  gitlab = new FakeGitLabMr(fakeMergeRequest({ sha: SHA, headPipeline: { id: 9, sha: SHA, status: "success" } }));
});

afterEach(() => {
  stores.db.close();
});

describe("runAwaitReview", () => {
  it("defers a poll later while no MR is open, and starts the wait clock", async () => {
    const id = createLoop();

    const outcome = await runAwaitReview(claim(id), makeDeps());

    expect(outcome).toEqual({ status: "deferred", until: new Date(NOW.getTime() + 60_000) });
    expect(loopOf(id)).toMatchObject({ waitStartedAt: NOW.toISOString(), mrIid: null, state: "awaiting_mr" });
  });

  it("stores the MR once found and moves to awaiting_review", async () => {
    const id = createLoop();
    gitlab.openMr = fakeMergeRequest({ sha: SHA });

    const outcome = await runAwaitReview(claim(id), makeDeps());

    expect(outcome.status).toBe("deferred");
    expect(loopOf(id)).toMatchObject({ projectId: 42, mrIid: 7, mrUrl: gitlab.mr.webUrl, state: "awaiting_review" });
  });

  it("passes a 5/5 MR with a green pipeline and no findings", async () => {
    const id = knownMrLoop();
    gitlab.mr.description = summaryBody(5);

    const outcome = await runAwaitReview(claim(id), makeDeps());

    expect(outcome).toEqual({ status: "succeeded" });
    const [comment] = tracker.comments("issue-1");
    expect(comment).toContain("Greptile 5/5 after 0 fix rounds: https://gitlab.example/acme/repo/-/merge_requests/7");
    expect(comment).toContain("round 0: 5/5, pipeline success, 0 fixed, 0 declined");
    expect(comment).toContain(LOOP_MARKER(id, "passed"));
    expect(tracker.labelsOf("issue-1")).toEqual(["agent-approved"]);
    const loop = loopOf(id);
    expect(loop.state).toBe("passed");
    expect(loop.history).toEqual([{ round: 0, headSha: SHA, score: 5, pipeline: "success", fixed: 0, declined: 0, outcome: "passed" }]);
    expect(gitlab.notes).toEqual([]);
  });

  it("queues a fix job for a 3/5 with an open finding", async () => {
    const id = knownMrLoop();
    gitlab.mr.description = summaryBody(3);
    gitlab.addDiscussion(GREPTILE, "Null check missing");

    const outcome = await runAwaitReview(claim(id), makeDeps());

    expect(outcome).toEqual({ status: "succeeded" });
    const queued = stores.db.prepare<[], { kind: string; subject: string; trigger: string }>("SELECT kind, subject, trigger FROM jobs WHERE status = 'queued'").all();
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ kind: "fix", subject: `loop:${id}` });
    expect(JSON.parse(queued[0]?.trigger ?? "{}")).toMatchObject({ kind: "loop", loopId: id, step: "fix" });
    expect(loopOf(id)).toMatchObject({ state: "fixing", waitStartedAt: null });
    expect(tracker.comments("issue-1")).toEqual([]);
  });

  it("hands back when a person pushed to the branch", async () => {
    const id = knownMrLoop();
    gitlab.mr = fakeMergeRequest({ sha: "d".repeat(40), description: summaryBody(5, "d".repeat(40)) });

    const outcome = await runAwaitReview(claim(id), makeDeps());

    expect(outcome).toEqual({ status: "succeeded", warning: "handed back: a person pushed to the branch; the loop stopped" });
    const [comment] = tracker.comments("issue-1");
    expect(comment).toContain("a person pushed");
    expect(comment).toContain(gitlab.mr.webUrl);
    expect(tracker.labelsOf("issue-1")).toEqual(["ready-for-human"]);
    expect(gitlab.notes).toHaveLength(1);
    expect(gitlab.notes[0]).toContain("Ticket Steward stopped: a person pushed to the branch; the loop stopped");
    expect(loopOf(id)).toMatchObject({ state: "handed_back", handedBackAt: NOW.toISOString() });
  });

  it("stops without touching labels when the MR was merged", async () => {
    const id = knownMrLoop();
    gitlab.mr.state = "merged";

    const outcome = await runAwaitReview(claim(id), makeDeps());

    expect(outcome.status).toBe("succeeded");
    expect(tracker.labelSwaps()).toEqual([]);
    expect(tracker.comments("issue-1")[0]).toContain("the merge request was merged");
    expect(gitlab.notes).toEqual([]);
    expect(loopOf(id).state).toBe("stopped");
  });

  it("changes no labels for a loop that was not label-driven", async () => {
    const id = knownMrLoop(false);
    gitlab.mr.description = summaryBody(5);

    await runAwaitReview(claim(id), makeDeps());

    expect(tracker.labelSwaps()).toEqual([]);
    expect(tracker.comments("issue-1")[0]).toContain("Greptile 5/5");
    expect(loopOf(id).state).toBe("passed");
  });

  it("retries a GitLab error", async () => {
    const id = knownMrLoop();
    gitlab.getMergeRequest = async () => {
      throw new Error("GitLab down");
    };

    expect(await runAwaitReview(claim(id), makeDeps())).toEqual({ status: "failed", error: "GitLab down", retryable: true });
  });

  it("keeps the loop open when the hand-back cannot be published", async () => {
    const id = knownMrLoop();
    gitlab.mr = fakeMergeRequest({ sha: "d".repeat(40) });
    tracker.failNextWrite();

    const outcome = await runAwaitReview(claim(id), makeDeps());

    expect(outcome.status).toBe("publish_failed");
    expect(loopOf(id).state).toBe("awaiting_review");
  });
});

describe("publishHandback", () => {
  it("posts each comment once when run twice", async () => {
    const id = knownMrLoop();
    const deps = makeDeps();

    await publishHandback(deps, loopOf(id), "Greptile did not review ccccccc");
    await publishHandback(deps, loopOf(id), "Greptile did not review ccccccc");

    expect(tracker.comments("issue-1")).toHaveLength(1);
    expect(gitlab.notes).toHaveLength(1);
    expect(loopOf(id)).toMatchObject({ state: "handed_back", handedBackAt: NOW.toISOString() });
  });

  it("changes no labels for a loop that was not label-driven", async () => {
    const id = knownMrLoop(false);

    await publishHandback(makeDeps(), loopOf(id), "Greptile did not review ccccccc");

    expect(tracker.labelSwaps()).toEqual([]);
  });
});
