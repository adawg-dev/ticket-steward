import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { StewardConfig } from "../../src/config/schema.js";
import type { PipelineDeps } from "../../src/core/pipeline.js";
import { Redactor } from "../../src/core/redact.js";
import type { RunContext } from "../../src/core/types.js";
import { stableWorktreeName } from "../../src/core/workspace.js";
import { runFix } from "../../src/greptile/fix.js";
import { LOOP_MARKER } from "../../src/greptile/publish.js";
import type { FixResult } from "../../src/greptile/result.js";
import { openStores, type Loop, type Stores } from "../../src/store/index.js";
import type { TicketBundle, TriggerEvent } from "../../src/tracker/types.js";
import { FakeBrain, type FakeBrainOptions } from "../fakes/fakeBrain.js";
import { FakeCodeHost } from "../fakes/fakeCodeHost.js";
import { FakeGitLabMr, fakeMergeRequest } from "../fakes/fakeGitLabMr.js";
import { FakeTracker } from "../fakes/fakeTracker.js";
import { freeTcpPort, tmpRepo, type TmpRepo } from "../fakes/tmpRepo.js";
import { commitFile, git } from "../workspace/helpers.js";

const IMPLEMENT_PROMPT = fileURLToPath(new URL("../../prompts/implement.md", import.meta.url));
const FIX_PROMPT = fileURLToPath(new URL("../../prompts/fix.md", import.meta.url));
const LABELS = { triage: "needs-triage", implement: "ready-for-agent", needsInfo: "needs-info", readyForHuman: "ready-for-human", implemented: "agent-implemented", approved: "agent-approved" };
const GREPTILE = "greptile-bot";
const BRANCH = "fix/API-1-adapter-drops-the-last-chunk";
const NOW = new Date("2026-10-27T12:00:00.000Z");

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

const summaryBody = (score: number, sha: string, reviews = 3): string =>
  `<h3>Greptile Summary</h3>\n\n### Confidence Score: ${score}/5\n\n<sub>Reviews (${reviews}): Last reviewed commit: [fix](https://gitlab.example/acme/repo/-/commit/${sha})</sub>`;

const changed = (discussionId: string): FixResult => ({
  outcome: "changed",
  threads: [{ discussionId, action: "fixed", reply: "Added the null check." }],
  commitMessage: "Check for a null chunk",
  summary: "Added the null check the review asked for.",
  checksRun: ["tsc: ok"],
  failureDetail: null,
});

const declined = (discussionId: string): FixResult => ({
  outcome: "no_changes",
  threads: [{ discussionId, action: "declined", reply: "The chunk can never be null here: the reader filters empty reads." }],
  commitMessage: "",
  summary: "Declined: the finding does not apply.",
  checksRun: [],
  failureDetail: null,
});

let repo: TmpRepo;
let stores: Stores;
let tracker: FakeTracker;
let gitlab: FakeGitLabMr;
let port: number;
let baseSha: string;
let headSha: string;
let finding: string;

const makeConfig = (): StewardConfig => ({
  dataDir: repo.dataDir,
  brain: { kind: "claude-code", model: "claude-test", maxTurns: 5, timeoutMinutes: 1 },
  tracker: { kind: "linear", teams: ["API"], gatewayIssues: "enrich", bugLabels: ["Bug"], labels: LABELS },
  codehost: { kind: "gitlab", baseUrl: "https://gitlab.example", project: "acme/repo" },
  workspace: { fetchUrl: repo.repo, baseBranch: "main", overlayDir: repo.overlayDir, setup: [], setupTimeoutMinutes: 1, port, keepOnFailure: false },
  retention: { keptWorktrees: 3, days: 30 },
  prompt: repo.promptPath,
  server: { port: 3020, publicUrl: "https://steward.example" },
  implement: {
    prompt: IMPLEMENT_PROMPT,
    branchTypes: ["feature", "fix", "chore", "refactor"],
    checks: [],
    checksTimeoutMinutes: 1,
    commitAuthor: { name: "Ticket Steward", email: "steward@example.com" },
    timeoutMinutes: 2,
    maxTurns: 7,
    protectedBranches: ["main"],
  },
  greptile: {
    botUsername: GREPTILE, maxRounds: 5, prompt: FIX_PROMPT, pollSeconds: 60, mrTimeoutMinutes: 60,
    reviewTimeoutMinutes: 30, pipelineTimeoutMinutes: 60, ciLogLines: 200,
  },
});

const makeDeps = (brain: FakeBrain): PipelineDeps => ({
  config: makeConfig(),
  secrets: { GITLAB_PUSH_TOKEN: "glpat-push-token-value" },
  configPath: join(repo.root, "steward.config.ts"),
  binPath: join(repo.root, "bin", "steward.js"),
  tracker,
  brain,
  codehost: new FakeCodeHost(),
  gitlab,
  mirror: repo.mirror,
  stores,
  redactor: new Redactor([]),
  now: () => NOW,
  runBrain: (_config, input) => brain.run(input, () => undefined),
});

const editing = (options: FakeBrainOptions): FakeBrain => new FakeBrain({ editWorkspace: { "src/adapter.ts": "export const adapter = 3;\n" }, sessionId: "session-2", ...options });

/** A loop at round 0 whose implement push is the branch head, now fixing. */
const createLoop = (): number => {
  const jobId = stores.jobs.enqueue({ kind: "cli", issueId: "issue-1", identifier: "API-1", teamKey: "API", action: "implement" });
  stores.jobs.claimById(jobId);
  stores.jobs.finish(jobId, { status: "succeeded" });
  const id = stores.loops.create({
    issueId: "issue-1", identifier: "API-1", teamKey: "API", implementJobId: jobId, branch: BRANCH, baseSha, headSha,
    worktreeName: stableWorktreeName("API-1"), labelDriven: true, sessionId: "session-1",
  });
  stores.loops.update(id, { projectId: 42, mrIid: 7, mrUrl: gitlab.mr.webUrl, state: "fixing" });
  return id;
};

const claim = (loopId: number): RunContext => {
  const trigger: TriggerEvent = { kind: "loop", issueId: "issue-1", identifier: "API-1", teamKey: "API", loopId, step: "fix" };
  const jobId = stores.jobs.enqueue(trigger);
  stores.jobs.claimById(jobId);
  const attempt = stores.attempts.start(jobId);
  return { jobId, attempt: attempt.number, issueId: "issue-1", identifier: "API-1", teamKey: "API", trigger, dryRun: false };
};

/** The same job's next attempt, as the worker retries a publish failure. */
const retry = (ctx: RunContext): RunContext => {
  stores.jobs.finish(ctx.jobId, { status: "publish_failed", error: "retry" });
  stores.jobs.claimById(ctx.jobId);
  const attempt = stores.attempts.start(ctx.jobId);
  return { ...ctx, attempt: attempt.number };
};

const loopOf = (id: number): Loop => {
  const loop = stores.loops.get(id);
  if (loop === null) throw new Error(`loop ${id} missing`);
  return loop;
};

const queuedAwaits = (): unknown[] =>
  stores.db.prepare<[], { trigger: string }>("SELECT trigger FROM jobs WHERE status = 'queued' AND kind = 'await_review'").all().map((row) => JSON.parse(row.trigger));

beforeEach(async () => {
  repo = await tmpRepo("unused");
  await commitFile(repo.repo, ".gitignore", ".env\n");
  baseSha = await git(repo.repo, ["rev-parse", "main"]);
  await git(repo.repo, ["checkout", "-q", "-b", BRANCH]);
  headSha = await commitFile(repo.repo, "src/adapter.ts", "export const adapter = 2;\n");
  await git(repo.repo, ["checkout", "-q", "main"]);
  await repo.mirror.fetch();
  stores = openStores(repo.dataDir);
  tracker = new FakeTracker([structuredClone(issue)]);
  gitlab = new FakeGitLabMr(fakeMergeRequest({ sha: headSha, sourceBranch: BRANCH, description: summaryBody(3, headSha), headPipeline: { id: 9, sha: headSha, status: "success" } }));
  finding = gitlab.addDiscussion(GREPTILE, "Null check missing on the last chunk.");
  port = await freeTcpPort();
});

afterEach(async () => {
  stores.db.close();
  await repo.cleanup();
});

describe("runFix", () => {
  it("resumes the session, pushes one fast-forward commit, replies, resolves and queues the next await", async () => {
    const id = createLoop();
    const brain = editing({ result: changed(finding) });

    const outcome = await runFix(claim(id), makeDeps(brain));

    expect(outcome).toEqual({ status: "succeeded" });
    const pushed = await git(repo.repo, ["rev-parse", BRANCH]);
    expect(await git(repo.repo, ["rev-parse", `${pushed}^`])).toBe(headSha);
    expect(await git(repo.repo, ["rev-list", "--count", `${headSha}..${pushed}`])).toBe("1");
    expect(await git(repo.repo, ["log", "-1", "--format=%s", pushed])).toBe("API-1: Check for a null chunk");
    expect(brain.lastInput().resumeSessionId).toBe("session-1");
    expect(brain.lastInput().output).toBe("fix");
    expect(brain.lastInput().timeoutMs).toBe(120_000);
    expect(brain.lastInput().workspacePath).toBe(join(repo.dataDir, "work", "ticket-API-1"));
    expect(gitlab.replies).toHaveLength(1);
    expect(gitlab.replies[0]?.discussionId).toBe(finding);
    expect(gitlab.replies[0]?.body).toContain(`Added the null check.\n\nFixed in ${pushed.slice(0, 7)}.`);
    expect(gitlab.replies[0]?.body).toContain(LOOP_MARKER(id, `reply ${finding} ${pushed}`));
    expect(gitlab.resolved).toEqual([finding]);
    expect(gitlab.notes).toEqual([]);
    const loop = loopOf(id);
    expect(loop).toMatchObject({ round: 1, headSha: pushed, state: "awaiting_review", sessionId: "session-2", pendingPush: null, waitStartedAt: null, reviewCountAtTrigger: null });
    expect(loop.history).toEqual([{ round: 0, headSha, score: 3, pipeline: "success", fixed: 1, declined: 0, outcome: "changed" }]);
    expect(queuedAwaits()).toEqual([{ kind: "loop", issueId: "issue-1", identifier: "API-1", teamKey: "API", loopId: id, step: "await" }]);
  });

  it("declines every finding: no push, replies and resolves, then asks Greptile for a review", async () => {
    const id = createLoop();

    const outcome = await runFix(claim(id), makeDeps(new FakeBrain({ result: declined(finding) })));

    expect(outcome).toEqual({ status: "succeeded" });
    expect(await git(repo.repo, ["rev-parse", BRANCH])).toBe(headSha);
    expect(gitlab.replies.map((reply) => reply.discussionId)).toEqual([finding]);
    expect(gitlab.replies[0]?.body).not.toContain("Fixed in");
    expect(gitlab.replies[0]?.body).toContain(LOOP_MARKER(id, `reply ${finding} nopush`));
    expect(gitlab.resolved).toEqual([finding]);
    expect(gitlab.notes).toHaveLength(1);
    expect(gitlab.notes[0]).toContain("@greptileai review");
    const loop = loopOf(id);
    expect(loop).toMatchObject({ round: 1, headSha, state: "awaiting_review", reviewCountAtTrigger: 3 });
    expect(loop.history).toEqual([{ round: 0, headSha, score: 3, pipeline: "success", fixed: 0, declined: 1, outcome: "no_changes" }]);
    expect(queuedAwaits()).toHaveLength(1);
  });

  it("hands back when the agent changes nothing two rounds running", async () => {
    const id = createLoop();
    stores.loops.appendRound(id, { round: 0, headSha, score: 3, pipeline: "success", fixed: 0, declined: 1, outcome: "no_changes" });
    stores.loops.update(id, { round: 1 });

    const outcome = await runFix(claim(id), makeDeps(new FakeBrain({ result: declined(finding) })));

    expect(outcome.status).toBe("succeeded");
    expect(loopOf(id).state).toBe("handed_back");
    expect(tracker.comments("issue-1")[0]).toContain("disagree");
    expect(tracker.labelsOf("issue-1")).toEqual(["ready-for-human"]);
    expect(gitlab.notes.some((note) => note.includes("@greptileai"))).toBe(false);
    expect(queuedAwaits()).toEqual([]);
  });

  it("hands back without a review request when nothing is open, the pipeline is green and nothing changed", async () => {
    gitlab.discussions = [];
    const id = createLoop();
    const result: FixResult = { ...declined(finding), threads: [] };

    const outcome = await runFix(claim(id), makeDeps(new FakeBrain({ result })));

    expect(outcome).toEqual({ status: "succeeded", warning: "handed back: Greptile scored 3/5 with nothing open and the agent changed nothing" });
    expect(loopOf(id).state).toBe("handed_back");
    expect(gitlab.notes.some((note) => note.includes("@greptileai"))).toBe(false);
    expect(queuedAwaits()).toEqual([]);
  });

  it("gives the agent the failed CI jobs and their log tails", async () => {
    gitlab.mr.headPipeline = { id: 9, sha: headSha, status: "failed" };
    gitlab.failed = [{ id: 31, name: "unit-tests", stage: "test", webUrl: "https://gitlab.example/acme/repo/-/jobs/31" }];
    gitlab.traces.set(31, "setup\nFAIL adapter.test.ts > keeps the last chunk\n");
    const id = createLoop();
    const brain = editing({ result: changed(finding) });

    await runFix(claim(id), makeDeps(brain));

    expect(brain.lastInput().prompt).toContain("unit-tests");
    expect(brain.lastInput().prompt).toContain("FAIL adapter.test.ts > keeps the last chunk");
    expect(loopOf(id).history[0]?.pipeline).toBe("failed");
  });

  it("gives the agent the ticket comments posted since the last hand-back, not the steward's own", async () => {
    tracker.addIssue({
      ...structuredClone(issue),
      comments: [
        { author: "Ada", body: "Before the hand-back", createdAt: "2026-10-27T08:00:00.000Z" },
        { author: "Ada", body: "Please keep the old buffer size", createdAt: "2026-10-27T10:00:00.000Z" },
        { author: "Ticket Steward", body: "Handed back\n\n<!-- ticket-steward:loop id=1 handback -->", createdAt: "2026-10-27T10:30:00.000Z" },
      ],
    });
    const id = createLoop();
    stores.loops.update(id, { handedBackAt: "2026-10-27T09:00:00.000Z" });
    const brain = editing({ result: changed(finding) });

    await runFix(claim(id), makeDeps(brain));

    expect(brain.lastInput().prompt).toContain("Please keep the old buffer size");
    expect(brain.lastInput().prompt).not.toContain("Before the hand-back");
    expect(brain.lastInput().prompt).not.toContain("ticket-steward:loop");
  });

  it("lists a person's commits since the adopted head", async () => {
    await git(repo.repo, ["checkout", "-q", BRANCH]);
    const personHead = await commitFile(repo.repo, "docs/notes.md", "notes\n");
    await git(repo.repo, ["checkout", "-q", "main"]);
    await repo.mirror.fetch();
    gitlab.mr = fakeMergeRequest({ sha: personHead, sourceBranch: BRANCH, description: summaryBody(3, personHead), headPipeline: { id: 9, sha: personHead, status: "success" } });
    gitlab.discussions = [];
    finding = gitlab.addDiscussion(GREPTILE, "Null check missing on the last chunk.");
    const id = createLoop();
    stores.loops.update(id, { headSha: personHead, adoptedFrom: headSha });
    const brain = editing({ result: changed(finding) });

    const outcome = await runFix(claim(id), makeDeps(brain));

    expect(outcome).toEqual({ status: "succeeded" });
    expect(brain.lastInput().prompt).toContain("- add docs/notes.md");
    expect(loopOf(id).adoptedFrom).toBeNull();
  });

  it("retries a publish failure after the push without running the brain or replying twice", async () => {
    const second = gitlab.addDiscussion(GREPTILE, "Rename the buffer.");
    const id = createLoop();
    const result: FixResult = { ...changed(finding), threads: [...changed(finding).threads, { discussionId: second, action: "declined", reply: "The name matches the stream API." }] };
    const brain = editing({ result });
    const failingReply = gitlab.replyToDiscussion.bind(gitlab);
    let calls = 0;
    gitlab.replyToDiscussion = async (project, iid, discussionId, body) => {
      calls += 1;
      if (calls === 2) throw new Error("GitLab down");
      return failingReply(project, iid, discussionId, body);
    };
    const ctx = claim(id);

    const first = await runFix(ctx, makeDeps(brain));

    expect(first.status).toBe("publish_failed");
    const pushed = await git(repo.repo, ["rev-parse", BRANCH]);
    expect(loopOf(id)).toMatchObject({ state: "fixing", headSha, pendingPush: { sha: pushed, pushed: true } });
    gitlab.mr = { ...gitlab.mr, sha: pushed };

    const second_ = await runFix(retry(ctx), makeDeps(brain));

    expect(second_).toEqual({ status: "succeeded" });
    expect(brain.runs).toBe(1);
    expect(gitlab.replies.map((reply) => reply.discussionId)).toEqual([finding, second]);
    expect(gitlab.resolved).toEqual([finding, second]);
    expect(await git(repo.repo, ["rev-parse", BRANCH])).toBe(pushed);
    expect(loopOf(id)).toMatchObject({ round: 1, headSha: pushed, state: "awaiting_review", pendingPush: null });
    expect(loopOf(id).history).toHaveLength(1);
  });

  it("hands back when the push is rejected because the branch moved", async () => {
    await git(repo.repo, ["checkout", "-q", BRANCH]);
    const moved = await commitFile(repo.repo, "docs/notes.md", "notes\n");
    await git(repo.repo, ["checkout", "-q", "main"]);
    const id = createLoop();

    const outcome = await runFix(claim(id), makeDeps(editing({ result: changed(finding) })));

    expect(outcome).toEqual({ status: "succeeded", warning: "handed back: the push was rejected" });
    expect(await git(repo.repo, ["rev-parse", BRANCH])).toBe(moved);
    expect(gitlab.replies).toEqual([]);
    expect(loopOf(id).state).toBe("handed_back");
  });

  it("hands back when the session cannot be resumed", async () => {
    const id = createLoop();
    const brain = new FakeBrain({ fail: true, error: "No conversation found with session ID: session-1" });

    const outcome = await runFix(claim(id), makeDeps(brain));

    expect(outcome).toEqual({ status: "succeeded", warning: "handed back: the agent's session could not be resumed" });
    expect(loopOf(id).state).toBe("handed_back");
    expect(await git(repo.repo, ["rev-parse", BRANCH])).toBe(headSha);
  });

  it("hands back without running the brain when a person pushed to the branch", async () => {
    gitlab.mr = { ...gitlab.mr, sha: "d".repeat(40) };
    const id = createLoop();
    const brain = new FakeBrain({ result: changed(finding) });

    const outcome = await runFix(claim(id), makeDeps(brain));

    expect(outcome).toEqual({ status: "succeeded", warning: "handed back: a person pushed to the branch; the loop stopped" });
    expect(brain.runs).toBe(0);
    expect(loopOf(id).state).toBe("handed_back");
  });

  it("stops quietly without running the brain when the MR was merged", async () => {
    gitlab.mr.state = "merged";
    const id = createLoop();
    const brain = new FakeBrain({ result: changed(finding) });

    const outcome = await runFix(claim(id), makeDeps(brain));

    expect(outcome).toEqual({ status: "succeeded", warning: "stopped: the merge request was merged" });
    expect(brain.runs).toBe(0);
    expect(loopOf(id).state).toBe("stopped");
  });

  it("does nothing for a loop that is no longer fixing", async () => {
    const id = createLoop();
    stores.loops.update(id, { state: "awaiting_review" });
    const brain = new FakeBrain({ result: changed(finding) });

    const outcome = await runFix(claim(id), makeDeps(brain));

    expect(outcome.status).toBe("succeeded");
    expect(brain.runs).toBe(0);
  });
});
