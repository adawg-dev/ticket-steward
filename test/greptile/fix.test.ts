import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { INTERRUPTED_ERROR } from "../../src/brain/index.js";
import type { BrainInput, BrainRun } from "../../src/brain/types.js";
import type { StewardConfig } from "../../src/config/schema.js";
import type { PipelineDeps } from "../../src/core/deps.js";
import { Redactor } from "../../src/core/redact.js";
import type { RunContext } from "../../src/core/types.js";
import { stableWorktreeName } from "../../src/core/workspace.js";
import { runFix } from "../../src/greptile/fix.js";
import { runRestart } from "../../src/greptile/start.js";
import { LOOP_MARKER } from "../../src/greptile/publish.js";
import type { FixResult } from "../../src/greptile/result.js";
import { storeLedger } from "../../src/push/ledger.js";
import { pushFromWorktree, type PushResult } from "../../src/push/service.js";
import { PushTargetSchema, type PushTarget } from "../../src/push/target.js";
import { PERSON_COMMITS_MARKER } from "../../src/run/execute.js";
import type { RunExecutor } from "../../src/run/executor.js";
import { RunSpecSchema, type RunReport, type RunSpec, type WorkReport } from "../../src/run/protocol.js";
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
const LABELS = { implement: "ready-for-agent", needsInfo: "needs-info", readyForHuman: "ready-for-human", implemented: "agent-implemented", approved: "agent-approved" };
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
  summary: "Added the null check the review asked for.",
  checksRun: ["tsc: ok"],
  failureDetail: null,
  media: [],
});

const declined = (discussionId: string): FixResult => ({
  outcome: "no_changes",
  threads: [{ discussionId, action: "declined", reply: "The chunk can never be null here: the reader filters empty reads." }],
  summary: "Declined: the finding does not apply.",
  checksRun: [],
  failureDetail: null,
  media: [],
});

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);

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
  tracker: { kind: "linear", teams: ["API"], labels: LABELS },
  codehost: { kind: "gitlab", baseUrl: "https://gitlab.example", project: "acme/repo" },
  workspace: { fetchUrl: repo.repo, baseBranch: "main", overlayDir: repo.overlayDir, setup: [], setupTimeoutMinutes: 1, port, keepOnFailure: false },
  retention: { keptWorktrees: 3, days: 30 },
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

/** The push target the steward gave the run's push server, read back from its command line. */
const pushTargetOf = (input: BrainInput): PushTarget | null => {
  const spec = input.mcpServers.push;
  const args = spec?.type === "http" ? undefined : spec?.args;
  if (args === undefined) return null;
  return PushTargetSchema.parse(JSON.parse(args[args.indexOf("--target") + 1] ?? "null"));
};

/** The agent's commit in its worktree. */
const agentCommit = async (workspace: string, subject: string, file = "src/adapter.ts", content = "export const adapter = 3;\n"): Promise<string> => {
  await mkdir(join(workspace, file, ".."), { recursive: true });
  await writeFile(join(workspace, file), content);
  await git(workspace, ["add", "--", file]);
  await git(workspace, ["commit", "-q", "-m", subject]);
  return git(workspace, ["rev-parse", "HEAD"]);
};

type AgentStep = (workspace: string, push: () => Promise<PushResult>) => Promise<void>;

/** Commits the null check and pushes it, as the prompt asks. */
const commitAndPush: AgentStep = async (workspace, push) => {
  await agentCommit(workspace, "API-1: Check for a null chunk");
  await push();
};

/**
 * A brain that acts like the agent: `act` commits in the worktree and calls the push tool, here the real push service
 * with the target the steward put on the push server's command line, bound to the job's deps by `makeDeps`.
 */
class AgentBrain extends FakeBrain {
  deps: PipelineDeps | null = null;
  readonly pushes: PushResult[] = [];

  constructor(options: FakeBrainOptions, private readonly act: AgentStep) {
    super(options);
  }

  override async run(input: BrainInput, onMessage: (line: string) => void): Promise<BrainRun> {
    const run = await super.run(input, onMessage);
    const target = pushTargetOf(input);
    await this.act(input.workspacePath, async () => {
      if (target === null || this.deps === null) throw new Error("the run has no push tool");
      // The MCP server turns a thrown error into a refusal; so does this stand-in.
      const pushed = await pushFromWorktree({ deps: { ...this.deps, ledger: storeLedger(this.deps) }, target, branchType: null }).catch((err: unknown): PushResult => ({ ok: false, reason: "push failed", detail: String(err) }));
      this.pushes.push(pushed);
      return pushed;
    });
    return run;
  }
}

const makeDeps = (brain: FakeBrain): PipelineDeps => {
  const deps = baseDeps(brain);
  if (brain instanceof AgentBrain) brain.deps = deps;
  return deps;
};

const baseDeps = (brain: FakeBrain): PipelineDeps => ({
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

/** An agent that commits and pushes its fix (or does what `act` says), then returns its result. */
const editing = (options: FakeBrainOptions, act: AgentStep = commitAndPush): AgentBrain => new AgentBrain({ sessionId: "session-2", ...options }, act);

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
  it("resumes the session with the push tool; the agent's fast-forward push is replied to, resolved and the next await queued", async () => {
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
    expect(pushTargetOf(brain.lastInput())).toMatchObject({ mode: "fastForward", branch: BRANCH, baseSha, loopId: id, identifier: "API-1", issueId: "issue-1" });
    expect(brain.pushes).toEqual([{ ok: true, branch: BRANCH, sha: pushed, commits: 1 }]);
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

  it("posts the round's screenshots in a note on the MR once its threads are answered, and stores them with the round", async () => {
    const id = createLoop();
    const brain = editing({ result: { ...changed(finding), media: [{ path: "after.png", caption: "The last chunk now renders" }] } });
    const deps: PipelineDeps = {
      ...makeDeps(brain),
      runBrain: async (_config, input) => {
        await writeFile(join(input.artifactsDir, "after.png"), PNG);
        return brain.run(input, () => undefined);
      },
    };
    const ctx = claim(id);

    expect(await runFix(ctx, deps)).toEqual({ status: "succeeded" });

    expect(gitlab.uploads).toEqual([{ project: 42, filename: "after.png", bytes: PNG.length }]);
    expect(stores.jobs.get(ctx.jobId)?.fixResult?.media).toEqual({ embeds: [{ caption: "The last chunk now renders", markdown: "![after.png](/uploads/1/after.png)" }], rejected: [] });
    expect(gitlab.notes).toHaveLength(1);
    expect(gitlab.notes[0]).toContain("Round 1: Added the null check the review asked for.");
    expect(gitlab.notes[0]).toContain("**Screenshots and recordings**\n\nThe last chunk now renders\n\n![after.png](/uploads/1/after.png)");
    expect(gitlab.notes[0]).toContain(LOOP_MARKER(id, "round 0 media after=start"));
    expect(loopOf(id)).toMatchObject({ round: 1, state: "awaiting_review" });
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

  it("hands back a round with no push when Greptile's summary has no review counter to wait past", async () => {
    gitlab.mr.description = `<h3>Greptile Summary</h3>\n\n### Confidence Score: 3/5\n\n<sub>Last reviewed commit: [fix](https://gitlab.example/acme/repo/-/commit/${headSha})</sub>`;
    const id = createLoop();

    const outcome = await runFix(claim(id), makeDeps(new FakeBrain({ result: declined(finding) })));

    expect(outcome).toEqual({ status: "succeeded", warning: "handed back: Greptile's summary has no review counter, so its next review cannot be told apart" });
    expect(loopOf(id)).toMatchObject({ state: "handed_back", round: 0, reviewCountAtTrigger: null });
    expect(gitlab.replies).toEqual([]);
    expect(gitlab.resolved).toEqual([]);
    expect(gitlab.notes.some((note) => note.includes("@greptileai"))).toBe(false);
    expect(tracker.labelsOf("issue-1")).toEqual(["ready-for-human"]);
    expect(queuedAwaits()).toEqual([]);
  });

  it("hands back when the agent changes nothing two rounds running", async () => {
    const id = createLoop();
    stores.loops.appendRound(id, { round: 0, headSha, score: 3, pipeline: "success", fixed: 0, declined: 1, outcome: "no_changes" });
    stores.loops.update(id, { round: 1 });

    const outcome = await runFix(claim(id), makeDeps(new FakeBrain({ result: declined(finding) })));

    expect(outcome.status).toBe("succeeded");
    expect(loopOf(id).state).toBe("handed_back");
    expect(gitlab.notes.some((note) => note.includes("disagree"))).toBe(true);
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

  it("gives the agent the MR notes people posted since the last hand-back, not bots', Greptile's or the steward's", async () => {
    gitlab.addDiscussion("ada", "Before the hand-back", { createdAt: "2026-10-27T08:00:00.000Z" });
    gitlab.addDiscussion("ada", "Please keep the old buffer size", { createdAt: "2026-10-27T10:00:00.000Z" });
    gitlab.addDiscussion("sam", "And log the dropped chunk", { createdAt: "2026-10-27T09:30:00.000Z" });
    gitlab.addDiscussion("ada", "changed the description", { createdAt: "2026-10-27T10:05:00.000Z", system: true });
    gitlab.addDiscussion(GREPTILE, "Greptile says hello after the hand-back", { createdAt: "2026-10-27T10:10:00.000Z", resolved: true });
    gitlab.addDiscussion("project_42_bot_0123abcd", "Bot note after the hand-back", { createdAt: "2026-10-27T10:15:00.000Z" });
    gitlab.addDiscussion("steward-bot", "The steward's own note", { createdAt: "2026-10-27T10:20:00.000Z" });
    gitlab.addDiscussion("ada", "Handed back\n\n<!-- ticket-steward:loop id=1 handback -->", { createdAt: "2026-10-27T10:30:00.000Z" });
    const id = createLoop();
    stores.loops.update(id, { handedBackAt: "2026-10-27T09:00:00.000Z" });
    const brain = editing({ result: changed(finding) });

    await runFix(claim(id), makeDeps(brain));

    const prompt = brain.lastInput().prompt;
    expect(prompt).toContain("## New comments on the merge request");
    expect(prompt.indexOf("**sam:** And log the dropped chunk")).toBeGreaterThan(-1);
    expect(prompt.indexOf("**ada:** Please keep the old buffer size")).toBeGreaterThan(prompt.indexOf("**sam:** And log the dropped chunk"));
    for (const skipped of ["Before the hand-back", "changed the description", "Greptile says hello", "Bot note", "The steward's own note", "ticket-steward:loop"]) {
      expect(prompt).not.toContain(skipped);
    }
  });

  it("gives the agent the decisions people made on the merge request, never to undo", async () => {
    const id = createLoop();
    stores.loops.appendDecisions(id, ["Keep the v1 endpoint", "Don't rename the queue"]);
    const brain = editing({ result: changed(finding) });

    await runFix(claim(id), makeDeps(brain));

    const prompt = brain.lastInput().prompt;
    expect(prompt).toContain("## Decisions a person made on this merge request: never undo these\n\n- Keep the v1 endpoint\n- Don't rename the queue\n");
  });

  it("gives the agent no MR notes when the loop was never handed back", async () => {
    gitlab.addDiscussion("ada", "Please keep the old buffer size", { createdAt: "2026-10-27T10:00:00.000Z" });
    const id = createLoop();
    const brain = editing({ result: changed(finding) });

    await runFix(claim(id), makeDeps(brain));

    expect(brain.lastInput().prompt).not.toContain("Please keep the old buffer size");
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
    expect(brain.lastInput().prompt).toContain(`- ${personHead.slice(0, 7)} Test add docs/notes.md`);
    expect(loopOf(id).adoptedFrom).toBeNull();
  });

  it("after a restart, gives the agent the person's commits and the MR notes since the hand-back", async () => {
    await git(repo.repo, ["checkout", "-q", BRANCH]);
    const personHead = await commitFile(repo.repo, "docs/notes.md", "notes\n");
    await git(repo.repo, ["checkout", "-q", "main"]);
    await repo.mirror.fetch();
    gitlab.mr = fakeMergeRequest({ sha: personHead, sourceBranch: BRANCH, description: summaryBody(3, personHead), headPipeline: { id: 9, sha: personHead, status: "success" } });
    gitlab.openMr = gitlab.mr;
    gitlab.discussions = [];
    finding = gitlab.addDiscussion(GREPTILE, "Null check missing on the last chunk.");
    gitlab.addDiscussion("ada", "Keep the old buffer size when you fix it", { createdAt: "2026-10-27T10:00:00.000Z" });
    const id = createLoop();
    stores.loops.update(id, { state: "handed_back", round: 3, handedBackAt: "2026-10-27T09:00:00.000Z" });
    const restart: TriggerEvent = { kind: "loop", issueId: "issue-1", identifier: "API-1", teamKey: "API", loopId: id, step: "restart", labelDriven: true };
    const restartJob = stores.jobs.enqueue(restart);
    stores.jobs.claimById(restartJob);
    const deps = makeDeps(editing({ result: changed(finding) }));
    expect(await runRestart({ jobId: restartJob, attempt: 1, issueId: "issue-1", identifier: "API-1", teamKey: "API", trigger: restart, dryRun: false }, deps))
      .toEqual({ status: "succeeded" });
    // The await job finds Greptile's 3/5 on the person's head and queues the fix.
    stores.loops.update(id, { state: "fixing" });
    const brain = editing({ result: changed(finding) });
    const fixDeps: PipelineDeps = { ...deps, brain, runBrain: (_config, input) => brain.run(input, () => undefined) };
    brain.deps = fixDeps;

    const outcome = await runFix(claim(id), fixDeps);

    expect(outcome).toEqual({ status: "succeeded" });
    expect(brain.lastInput().prompt).toContain(`- ${personHead.slice(0, 7)} Test add docs/notes.md`);
    expect(brain.lastInput().prompt).toContain("Keep the old buffer size when you fix it");
    expect(loopOf(id)).toMatchObject({ round: 1, adoptedFrom: null });
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
    // The push tool moved the loop's head, so the gate reads the MR at the pushed commit as the loop's own.
    expect(loopOf(id)).toMatchObject({ state: "fixing", headSha: pushed, pendingPush: { sha: pushed, pushed: true } });
    gitlab.mr = { ...gitlab.mr, sha: pushed };

    const second_ = await runFix(retry(ctx), makeDeps(brain));

    expect(second_).toEqual({ status: "succeeded" });
    expect(brain.runs).toBe(1);
    expect(gitlab.replies.map((reply) => reply.discussionId)).toEqual([finding, second]);
    expect(gitlab.resolved).toEqual([finding, second]);
    expect(await git(repo.repo, ["rev-parse", BRANCH])).toBe(pushed);
    expect(loopOf(id)).toMatchObject({ round: 1, headSha: pushed, state: "awaiting_review", pendingPush: null });
    expect(loopOf(id).history).toEqual([expect.objectContaining({ round: 0, headSha, outcome: "changed" })]);
    expect(brain.pushes).toHaveLength(1);
  });

  it("settles a push the tool recorded but never marked from the MR's head on retry, without pushing again", async () => {
    const id = createLoop();
    const brain = editing({ result: changed(finding) });
    gitlab.replyToDiscussion = async () => {
      throw new Error("GitLab down");
    };
    const ctx = claim(id);
    expect((await runFix(ctx, makeDeps(brain))).status).toBe("publish_failed");
    const pushed = await git(repo.repo, ["rev-parse", BRANCH]);
    // As if the push server stopped between the push landing and its record.
    stores.loops.update(id, { headSha, pendingPush: { sha: pushed, pushed: false } });
    gitlab.replyToDiscussion = FakeGitLabMr.prototype.replyToDiscussion.bind(gitlab);
    gitlab.mr = { ...gitlab.mr, sha: pushed };

    const outcome = await runFix(retry(ctx), makeDeps(brain));

    expect(outcome).toEqual({ status: "succeeded" });
    expect(brain.runs).toBe(1);
    expect(brain.pushes).toHaveLength(1);
    expect(loopOf(id)).toMatchObject({ round: 1, headSha: pushed, state: "awaiting_review", pendingPush: null });
  });

  it("hands back on retry when a push the tool recorded never reached the MR", async () => {
    const id = createLoop();
    const brain = editing({ result: changed(finding) });
    gitlab.replyToDiscussion = async () => {
      throw new Error("GitLab down");
    };
    const ctx = claim(id);
    expect((await runFix(ctx, makeDeps(brain))).status).toBe("publish_failed");
    const pushed = await git(repo.repo, ["rev-parse", BRANCH]);
    stores.loops.update(id, { headSha, pendingPush: { sha: pushed, pushed: false } });

    const outcome = await runFix(retry(ctx), makeDeps(brain));

    expect(outcome).toEqual({ status: "succeeded", warning: "handed back: the push did not complete" });
    expect(brain.runs).toBe(1);
    expect(loopOf(id).state).toBe("handed_back");
  });

  it("hands back without running the brain again when an interrupted attempt had pushed", async () => {
    const id = createLoop();
    const brain = editing({ fail: true, error: INTERRUPTED_ERROR });
    const ctx = claim(id);
    expect(await runFix(ctx, makeDeps(brain))).toEqual({ status: "failed", error: INTERRUPTED_ERROR, retryable: true });
    const pushed = await git(repo.repo, ["rev-parse", BRANCH]);
    expect(pushed).not.toBe(headSha);
    stores.jobs.finish(ctx.jobId, { status: "failed", error: INTERRUPTED_ERROR, retryable: true });
    stores.jobs.claimById(ctx.jobId);
    const next = { ...ctx, attempt: stores.attempts.start(ctx.jobId).number };
    gitlab.mr = { ...gitlab.mr, sha: pushed };

    const outcome = await runFix(next, makeDeps(brain));

    expect(outcome).toEqual({ status: "succeeded", warning: "handed back: an earlier attempt stopped after the agent pushed" });
    expect(brain.runs).toBe(1);
    expect(brain.pushes).toHaveLength(1);
    expect(loopOf(id)).toMatchObject({ state: "handed_back", headSha: pushed });
  });

  it("hands back when the agent reports a change it did not push", async () => {
    const id = createLoop();
    const brain = editing({ result: changed(finding) }, async (workspace) => {
      await agentCommit(workspace, "API-1: Check for a null chunk");
    });

    const outcome = await runFix(claim(id), makeDeps(brain));

    expect(outcome).toEqual({ status: "succeeded", warning: "handed back: the agent did not push its change" });
    expect(await git(repo.repo, ["rev-parse", BRANCH])).toBe(headSha);
    expect(gitlab.replies).toEqual([]);
    expect(loopOf(id)).toMatchObject({ state: "handed_back", headSha, pendingPush: null });
    expect(gitlab.notes.join("\n")).toContain("commits not pushed:");
    expect(gitlab.notes.join("\n")).toContain("API-1: Check for a null chunk");
  });

  it("hands back when the push tool refused because the branch moved", async () => {
    await git(repo.repo, ["checkout", "-q", BRANCH]);
    const moved = await commitFile(repo.repo, "docs/notes.md", "notes\n");
    await git(repo.repo, ["checkout", "-q", "main"]);
    const id = createLoop();
    const brain = editing({ result: changed(finding) });

    const outcome = await runFix(claim(id), makeDeps(brain));

    expect(brain.pushes).toEqual([expect.objectContaining({ ok: false, reason: "the push was rejected" })]);
    expect(outcome).toEqual({ status: "succeeded", warning: "handed back: the agent did not push its change" });
    expect(await git(repo.repo, ["rev-parse", BRANCH])).toBe(moved);
    expect(gitlab.replies).toEqual([]);
    expect(loopOf(id)).toMatchObject({ state: "handed_back", headSha, pendingPush: null });
  });

  it("hands back when the agent pushed but left uncommitted work behind", async () => {
    const id = createLoop();
    const brain = editing({ result: changed(finding) }, async (workspace, push) => {
      await commitAndPush(workspace, push);
      await writeFile(join(workspace, "src/extra.ts"), "export const extra = 1;\n");
    });

    const outcome = await runFix(claim(id), makeDeps(brain));

    expect(outcome).toEqual({ status: "succeeded", warning: "handed back: the agent left unpushed work" });
    expect(gitlab.replies).toEqual([]);
    expect(gitlab.notes.join("\n")).toContain("src/extra.ts");
    expect(loopOf(id).state).toBe("handed_back");
  });

  it("hands back a no_changes round that left edits behind", async () => {
    const id = createLoop();
    const brain = editing({ result: declined(finding) }, async (workspace) => {
      await writeFile(join(workspace, "src/adapter.ts"), "export const adapter = 4;\n");
    });

    const outcome = await runFix(claim(id), makeDeps(brain));

    expect(outcome).toEqual({ status: "succeeded", warning: "handed back: the agent left unpushed work" });
    expect(gitlab.notes.some((note) => note.includes("@greptileai"))).toBe(false);
    expect(loopOf(id).state).toBe("handed_back");
  });

  it("hands back a no_changes round whose agent pushed anyway", async () => {
    const id = createLoop();
    const brain = editing({ result: declined(finding) });

    const outcome = await runFix(claim(id), makeDeps(brain));

    expect(outcome).toEqual({ status: "succeeded", warning: "handed back: the agent pushed a change but reported no changes" });
    expect(gitlab.notes.some((note) => note.includes("@greptileai"))).toBe(false);
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

describe("runFix through an executor", () => {
  const reportOf = (spec: RunSpec, patch: Partial<RunReport> = {}): RunReport => ({
    runId: spec.runId, ok: true, error: null, interrupted: false, setupFailed: false, sessionId: "session-x", output: declined(finding), usage: { inputTokens: 1, outputTokens: 1 }, ...patch,
  });

  /** An executor that records the specs it is handed and reports `patch` and `work` for each. */
  const executing = (patch: Partial<RunReport> = {}, work: Partial<WorkReport> = {}): RunExecutor & { specs: RunSpec[] } => {
    const specs: RunSpec[] = [];
    return {
      specs,
      execute: async (spec) => {
        specs.push(spec);
        return { report: reportOf(spec, patch), work: { runId: spec.runId, unpushed: "", pushedSha: null, ...work } };
      },
    };
  };

  it("hands back the unpushed work the executor found, with its detail", async () => {
    const id = createLoop();
    const executor = executing({}, { unpushed: "a1b2c3d API-1: wip" });

    const outcome = await runFix(claim(id), { ...makeDeps(new FakeBrain()), executor });

    expect(outcome).toEqual({ status: "succeeded", warning: "handed back: the agent left unpushed work" });
    expect(gitlab.notes.join("\n")).toContain("a1b2c3d API-1: wip");
    expect(gitlab.replies).toEqual([]);
    expect(loopOf(id).state).toBe("handed_back");
    expect(loopOf(id).sessionId).toBe("session-x");
  });

  it("hands the executor a fix spec on the loop's head that resumes its session and carries no secret", async () => {
    const id = createLoop();
    stores.loops.update(id, { adoptedFrom: baseSha });
    const executor = executing();
    const ctx = claim(id);

    await runFix(ctx, { ...makeDeps(new FakeBrain()), executor });

    const worktreePath = join(repo.dataDir, "work", "ticket-API-1");
    expect(executor.specs).toHaveLength(1);
    expect(RunSpecSchema.parse(JSON.parse(JSON.stringify(executor.specs[0])))).toMatchObject({
      runId: `${ctx.jobId}-1`,
      kind: "fix",
      output: "fix",
      checkout: { ref: BRANCH, sha: headSha },
      baseSha,
      worktreePath,
      personCommits: { from: baseSha, to: headSha },
      resumeSessionId: "session-1",
      limits: { timeoutMinutes: 2, maxTurns: 7 },
      push: { jobId: ctx.jobId, mode: "fastForward", branch: BRANCH, baseSha, loopId: id, worktreePath },
      interactive: false,
    });
    expect(executor.specs[0]?.prompt).toContain(`- ${PERSON_COMMITS_MARKER}`);
    expect(JSON.stringify(executor.specs[0])).not.toContain("glpat-push-token-value");
  });

  it("gives a loop with no adopted head no person commits", async () => {
    const id = createLoop();
    const executor = executing();

    await runFix(claim(id), { ...makeDeps(new FakeBrain()), executor });

    expect(executor.specs[0]?.personCommits).toBeNull();
    expect(executor.specs[0]?.prompt).not.toContain(PERSON_COMMITS_MARKER);
  });

  it("retries an interrupted run, and hands back one whose session could not be resumed", async () => {
    const first = createLoop();
    const interrupted = executing({ ok: false, error: "interrupted", interrupted: true, sessionId: null, output: null });
    expect(await runFix(claim(first), { ...makeDeps(new FakeBrain()), executor: interrupted })).toEqual({ status: "failed", error: INTERRUPTED_ERROR, retryable: true });
    expect(loopOf(first).state).toBe("fixing");

    const lost = executing({ ok: false, error: "No conversation found with session ID: session-1", sessionId: null, output: null });
    expect(await runFix(claim(first), { ...makeDeps(new FakeBrain()), executor: lost })).toEqual({ status: "succeeded", warning: "handed back: the agent's session could not be resumed" });
    expect(loopOf(first).state).toBe("handed_back");
  });

  it("fails retryably and keeps the tail when setup fails, and when the executor cannot start the run", async () => {
    const id = createLoop();
    const setup = executing({ ok: false, error: "setup failed:\npnpm: not found\n", setupFailed: true, sessionId: null, output: null });
    const ctx = claim(id);

    expect(await runFix(ctx, { ...makeDeps(new FakeBrain()), executor: setup })).toEqual({ status: "failed", error: "setup failed:\npnpm: not found\n", retryable: true });
    expect(stores.attempts.forJob(ctx.jobId)[0]?.setupTail).toBe("pnpm: not found\n");
    expect(loopOf(id).state).toBe("fixing");

    const failing: RunExecutor = { execute: () => Promise.reject(new Error("cannot create the run's Job")) };
    expect(await runFix(claim(id), { ...makeDeps(new FakeBrain()), executor: failing })).toEqual({ status: "failed", error: "cannot create the run's Job", retryable: true });
  });
});
