import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { StewardConfig } from "../../src/config/schema.js";
import type { PipelineDeps } from "../../src/core/deps.js";
import { Redactor } from "../../src/core/redact.js";
import type { RunContext } from "../../src/core/types.js";
import { runAwaitReview } from "../../src/greptile/await.js";
import { LOOP_MARKER, publishHandback, requestReview } from "../../src/greptile/publish.js";
import type { ImplementResult } from "../../src/implement/result.js";
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
const LABELS = { implement: "ready-for-agent", needsInfo: "needs-info", readyForHuman: "ready-for-human", implemented: "agent-implemented", approved: "agent-approved" };

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

const implemented: ImplementResult = {
  outcome: "implemented",
  branchType: "fix",
  commitMessage: "Keep the last chunk",
  summary: "Flush the buffer before closing the stream.",
  reviewNotes: ["Check the streaming test."],
  checksRun: ["tsc: ok"],
  questions: [],
  failureDetail: null,
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
  tracker: { kind: "linear", teams: ["API"], labels: LABELS },
  codehost: { kind: "gitlab", baseUrl: "https://gitlab.example", project: "acme/repo" },
  workspace: { fetchUrl: "https://gitlab.example/acme/repo.git", baseBranch: "dev", overlayDir: join(dataDir, "overlay"), setup: [], setupTimeoutMinutes: 1, port: 4100, keepOnFailure: false },
  retention: { keptWorktrees: 3, days: 30 },
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

/** A finished implement job for the loop to come from, with the result its push stored. */
const implementJob = (): number => {
  const jobId = stores.jobs.enqueue({ kind: "cli", issueId: "issue-1", identifier: "API-1", teamKey: "API", action: "implement" });
  stores.jobs.claimById(jobId);
  stores.jobs.saveImplementResult(jobId, { result: implemented, handback: null });
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

  it("polls at the wait's deadline when it comes before the next poll, and hands back right after it", async () => {
    const id = knownMrLoop();
    gitlab.mr = fakeMergeRequest({ sha: SHA });
    const deadline = new Date(NOW.getTime() + 20_000);
    stores.loops.update(id, { waitStartedAt: new Date(deadline.getTime() - 30 * 60_000).toISOString() });

    expect(await runAwaitReview(claim(id), makeDeps())).toEqual({ status: "deferred", until: new Date(deadline.getTime() + 1) });

    const atDeadline = { ...makeDeps(), now: () => deadline };
    expect(await runAwaitReview(claim(id), atDeadline)).toEqual({ status: "deferred", until: new Date(deadline.getTime() + 1) });

    const after = { ...makeDeps(), now: () => new Date(deadline.getTime() + 1) };
    expect((await runAwaitReview(claim(id), after)).status).toBe("succeeded");
    expect(loopOf(id).state).toBe("handed_back");
  });

  it("defers a full poll interval while the deadline is far off", async () => {
    const id = knownMrLoop();
    gitlab.mr = fakeMergeRequest({ sha: SHA });

    expect(await runAwaitReview(claim(id), makeDeps())).toEqual({ status: "deferred", until: new Date(NOW.getTime() + 60_000) });
  });

  it("stores the MR once found and moves to awaiting_review", async () => {
    const id = createLoop();
    gitlab.openMr = fakeMergeRequest({ sha: SHA });

    const outcome = await runAwaitReview(claim(id), makeDeps());

    expect(outcome.status).toBe("deferred");
    expect(loopOf(id)).toMatchObject({ projectId: 42, mrIid: 7, mrUrl: gitlab.mr.webUrl, state: "awaiting_review" });
  });

  it("posts the implement summary on the MR the first time it finds it, and never again", async () => {
    const id = createLoop();
    gitlab.openMr = fakeMergeRequest({ sha: SHA });

    await runAwaitReview(claim(id), makeDeps());
    await runAwaitReview(claim(id), makeDeps());

    expect(gitlab.notes).toHaveLength(1);
    const [note] = gitlab.notes;
    expect(note).toContain(`Ticket Steward implemented API-1 (job ${loopOf(id).implementJobId}).`);
    expect(note).toContain("Flush the buffer before closing the stream.");
    expect(note).toContain("**For the reviewer**\n- Check the streaming test.");
    expect(note).toContain("**Checks the agent ran**\n- tsc: ok");
    expect(note).toContain(LOOP_MARKER(id, "implement-summary"));
  });

  it("posts nothing while no MR is open", async () => {
    const id = createLoop();

    await runAwaitReview(claim(id), makeDeps());

    expect(gitlab.notes).toEqual([]);
  });

  it("retries the poll when the implement summary cannot be posted, then posts it once", async () => {
    const id = createLoop();
    gitlab.openMr = fakeMergeRequest({ sha: SHA });
    gitlab.failNextNote();

    expect(await runAwaitReview(claim(id), makeDeps())).toEqual({ status: "failed", error: "GitLab down", retryable: true });
    expect((await runAwaitReview(claim(id), makeDeps())).status).toBe("deferred");

    expect(gitlab.notes).toHaveLength(1);
    expect(gitlab.notes[0]).toContain(LOOP_MARKER(id, "implement-summary"));
  });

  it("gives the review its own wait once the MR is found, however long the MR took", async () => {
    const id = createLoop();
    stores.loops.update(id, { waitStartedAt: new Date(NOW.getTime() - 35 * 60_000).toISOString() });
    gitlab.openMr = fakeMergeRequest({ sha: SHA });

    const outcome = await runAwaitReview(claim(id), makeDeps());

    expect(outcome).toEqual({ status: "deferred", until: new Date(NOW.getTime() + 60_000) });
    expect(loopOf(id)).toMatchObject({ state: "awaiting_review", mrIid: 7, waitStartedAt: NOW.toISOString() });
  });

  it("passes a 5/5 MR with a green pipeline and no findings", async () => {
    const id = knownMrLoop();
    gitlab.mr.description = summaryBody(5);

    const outcome = await runAwaitReview(claim(id), makeDeps());

    expect(outcome).toEqual({ status: "succeeded" });
    const passed = gitlab.notes.filter((note) => note.includes(LOOP_MARKER(id, "passed")));
    expect(passed).toHaveLength(1);
    expect(passed[0]).toContain("Greptile 5/5 after 0 fix rounds.");
    expect(passed[0]).toContain("round 0: 5/5, pipeline success, 0 fixed, 0 declined");
    expect(tracker.labelsOf("issue-1")).toEqual(["agent-approved"]);
    const loop = loopOf(id);
    expect(loop.state).toBe("passed");
    expect(loop.history).toEqual([{ round: 0, headSha: SHA, score: 5, pipeline: "success", fixed: 0, declined: 0, outcome: "passed" }]);
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
    expect(gitlab.notes.filter((note) => !note.includes("implement-summary"))).toEqual([]);
  });

  it("hands back when a person pushed to the branch", async () => {
    const id = knownMrLoop();
    gitlab.mr = fakeMergeRequest({ sha: "d".repeat(40), description: summaryBody(5, "d".repeat(40)) });

    const outcome = await runAwaitReview(claim(id), makeDeps());

    expect(outcome).toEqual({ status: "succeeded", warning: "handed back: a person pushed to the branch; the loop stopped" });
    const handbacks = gitlab.notes.filter((note) => note.includes("handback round="));
    expect(handbacks).toHaveLength(1);
    expect(handbacks[0]).toContain("Ticket Steward stopped and handed this back: a person pushed to the branch; the loop stopped.");
    expect(handbacks[0]).toContain("Last Greptile score: none yet");
    expect(tracker.labelsOf("issue-1")).toEqual(["ready-for-human"]);
    expect(loopOf(id)).toMatchObject({ state: "handed_back", handedBackAt: NOW.toISOString() });
  });

  it("stops without touching labels when the MR was merged", async () => {
    const id = knownMrLoop();
    gitlab.mr.state = "merged";

    const outcome = await runAwaitReview(claim(id), makeDeps());

    expect(outcome.status).toBe("succeeded");
    expect(tracker.labelSwaps()).toEqual([]);
    expect(gitlab.notes).toHaveLength(1);
    expect(gitlab.notes[0]).toContain("Ticket Steward stopped the Greptile loop: the merge request was merged.");
    expect(gitlab.notes[0]).toContain(LOOP_MARKER(id, "stop"));
    expect(loopOf(id).state).toBe("stopped");
  });

  it("changes no labels for a loop that was not label-driven", async () => {
    const id = knownMrLoop(false);
    gitlab.mr.description = summaryBody(5);

    await runAwaitReview(claim(id), makeDeps());

    expect(tracker.labelSwaps()).toEqual([]);
    expect(gitlab.notes.some((note) => note.includes("Greptile 5/5"))).toBe(true);
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
    // The summary is already on the MR, so the failing note is the hand-back.
    gitlab.addDiscussion("steward-bot", LOOP_MARKER(id, "implement-summary"), { resolvable: false });
    gitlab.failNextNote();

    const outcome = await runAwaitReview(claim(id), makeDeps());

    expect(outcome.status).toBe("publish_failed");
    expect(loopOf(id).state).toBe("awaiting_review");
  });
});

describe("publishHandback", () => {
  it("posts its MR note, detail included, once when a retry runs it again", async () => {
    const id = knownMrLoop();
    const deps = makeDeps();
    // A retry sees the loop as it was before the publish: the hand-back time is written only once every step succeeded.
    const before = loopOf(id);

    await publishHandback(deps, before, "Greptile did not review ccccccc", "output tail");
    await publishHandback(deps, before, "Greptile did not review ccccccc", "output tail");

    expect(gitlab.notes).toHaveLength(1);
    expect(gitlab.notes[0]).toContain("```\noutput tail\n```");
    expect(tracker.labelsOf("issue-1")).toEqual(["ready-for-human"]);
    expect(loopOf(id)).toMatchObject({ state: "handed_back", handedBackAt: NOW.toISOString() });
  });

  it("posts its MR note once when the first try failed part-way", async () => {
    const id = knownMrLoop();
    const deps = makeDeps();
    tracker.failNextSwap();

    expect((await publishHandback(deps, loopOf(id), "Greptile did not review ccccccc")).status).toBe("publish_failed");
    expect(loopOf(id).handedBackAt).toBeNull();
    await publishHandback(deps, loopOf(id), "Greptile did not review ccccccc");

    expect(gitlab.notes).toHaveLength(1);
    expect(loopOf(id).state).toBe("handed_back");
  });

  it("posts again when a restarted loop is handed back at the same round and head", async () => {
    const id = knownMrLoop();
    const deps = makeDeps();
    await publishHandback(deps, loopOf(id), "Greptile did not review ccccccc");
    // A restart without a push: round 0 again on the same head, the hand-back time kept.
    stores.loops.update(id, { state: "awaiting_review", round: 0, endedAt: null });

    await publishHandback({ ...deps, now: () => new Date(NOW.getTime() + 3_600_000) }, loopOf(id), "Greptile did not review ccccccc");

    expect(gitlab.notes).toHaveLength(2);
    expect(loopOf(id).handedBackAt).toBe(new Date(NOW.getTime() + 3_600_000).toISOString());
  });

  it("changes no labels for a loop that was not label-driven", async () => {
    const id = knownMrLoop(false);

    await publishHandback(makeDeps(), loopOf(id), "Greptile did not review ccccccc");

    expect(tracker.labelSwaps()).toEqual([]);
  });

  it("only swaps the label for a loop whose MR never appeared", async () => {
    const id = createLoop();

    expect(await publishHandback(makeDeps(), loopOf(id), "no merge request appeared")).toEqual({ status: "succeeded", warning: "handed back: no merge request appeared" });

    expect(gitlab.notes).toEqual([]);
    expect(tracker.labelsOf("issue-1")).toEqual(["ready-for-human"]);
  });
});

describe("requestReview", () => {
  it("asks once per round and head, and again in a restarted loop's life", async () => {
    const id = knownMrLoop();
    const deps = makeDeps();

    await requestReview(deps, loopOf(id));
    await requestReview(deps, loopOf(id));
    expect(gitlab.notes).toHaveLength(1);

    stores.loops.update(id, { handedBackAt: NOW.toISOString() });
    await requestReview(deps, loopOf(id));

    expect(gitlab.notes).toHaveLength(2);
    expect(gitlab.notes.every((note) => note.startsWith("@greptileai review"))).toBe(true);
  });
});
