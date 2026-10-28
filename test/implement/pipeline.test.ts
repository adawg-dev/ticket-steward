import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { BrainInput, BrainRun } from "../../src/brain/types.js";
import type { StewardConfig } from "../../src/config/schema.js";
import type { PipelineDeps } from "../../src/core/deps.js";
import { Redactor } from "../../src/core/redact.js";
import type { RunContext } from "../../src/core/types.js";
import type { ImplementResult } from "../../src/implement/result.js";
import { publishImplementOnly, runImplement } from "../../src/implement/pipeline.js";
import { pushFromWorktree, type PushResult } from "../../src/push/service.js";
import { PushTargetSchema, type PushTarget } from "../../src/push/target.js";
import { openStores, type Stores } from "../../src/store/index.js";
import type { TriggerEvent, TicketBundle } from "../../src/tracker/types.js";
import { SlotClient } from "../../src/workspace/slots.js";
import { fakeSlotRunner } from "../fakes/fakeSlotRunner.js";
import { FakeBrain } from "../fakes/fakeBrain.js";
import { FakeCodeHost } from "../fakes/fakeCodeHost.js";
import { FakeTracker } from "../fakes/fakeTracker.js";
import { freeTcpPort, tmpRepo, type TmpRepo } from "../fakes/tmpRepo.js";
import { commitFile, git } from "../workspace/helpers.js";

const IMPLEMENT_PROMPT = fileURLToPath(new URL("../../prompts/implement.md", import.meta.url));
const LABELS = { implement: "ready-for-agent", needsInfo: "needs-info", readyForHuman: "ready-for-human", implemented: "agent-implemented", approved: "agent-approved" };

const issue: TicketBundle = {
  id: "issue-1",
  identifier: "API-1",
  url: "https://linear.app/acme/issue/API-1",
  title: "Adapter drops the last chunk",
  description: "The adapter loses the final chunk.",
  team: { id: "team-1", key: "API", name: "API" },
  state: { name: "Todo", type: "unstarted" },
  labels: ["ready-for-agent"],
  priority: 2,
  creator: { name: "Ada", isBot: false },
  createdAt: "2026-09-11T00:00:00.000Z",
  comments: [],
  attachments: [],
  appliedTemplate: null,
  templates: [],
};

const trigger: TriggerEvent = { kind: "issue.labeled", issueId: "issue-1", identifier: "API-1", teamKey: "API", deliveryId: "d-1", description: issue.description, stateType: "unstarted", action: "implement" };

const BRANCH = "fix/API-1-adapter-drops-the-last-chunk";

const implemented: ImplementResult = {
  outcome: "implemented",
  summary: "Flush the buffer before closing the stream.",
  reviewNotes: ["Check the streaming test."],
  checksRun: ["tsc: ok"],
  questions: [],
  failureDetail: null,
};

let repo: TmpRepo;
let stores: Stores;
let tracker: FakeTracker;
let port: number;

const makeConfig = (implement: Partial<NonNullable<StewardConfig["implement"]>> = {}): StewardConfig => ({
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
    timeoutMinutes: 1,
    maxTurns: 5,
    protectedBranches: ["main"],
    ...implement,
  },
});

/** The push target the steward gave the run's push server, read back from its command line. */
const pushTargetOf = (input: BrainInput): PushTarget | null => {
  const args = input.mcpServers.push?.args;
  if (args === undefined) return null;
  return PushTargetSchema.parse(JSON.parse(args[args.indexOf("--target") + 1] ?? "null"));
};

/** The agent's commit in its worktree. */
const agentCommit = async (workspace: string, subject: string, file = "src/adapter.ts", content = "export const adapter = 2;\n"): Promise<string> => {
  await mkdir(join(workspace, file, ".."), { recursive: true });
  await writeFile(join(workspace, file), content);
  await git(workspace, ["add", "--", file]);
  await git(workspace, ["commit", "-q", "-m", subject]);
  return git(workspace, ["rev-parse", "HEAD"]);
};

type AgentStep = (workspace: string, push: (branchType?: string | null) => Promise<PushResult>) => Promise<void>;

/** Commits the adapter fix and pushes it as a `fix` branch, as the prompt asks. */
const commitAndPush: AgentStep = async (workspace, push) => {
  await agentCommit(workspace, "API-1: Keep the last chunk");
  await push("fix");
};

/**
 * A brain that acts like the agent: `act` edits and commits in the worktree and calls the push tool, here the real push
 * service with the target the steward put on the push server's command line. Returns `result`.
 */
const agentBrain = (result: unknown, act: AgentStep = commitAndPush) => {
  const calls: BrainInput[] = [];
  const pushes: PushResult[] = [];
  let deps: PipelineDeps | null = null;
  const runBrain = async (_config: unknown, input: BrainInput): Promise<BrainRun> => {
    calls.push(input);
    const target = pushTargetOf(input);
    await act(input.workspacePath, async (branchType = null) => {
      if (target === null || deps === null) throw new Error("the run has no push tool");
      // The MCP server turns a thrown error into a refusal; so does this stand-in.
      const pushed = await pushFromWorktree({ deps, target, branchType }).catch((err: unknown): PushResult => ({ ok: false, reason: "push failed", detail: String(err) }));
      pushes.push(pushed);
      return pushed;
    });
    return { ok: true, output: result };
  };
  return {
    calls,
    pushes,
    runBrain,
    /** The push service runs with the job's own deps, as `steward mcp push` builds them from the same config. */
    bind: (bound: PipelineDeps): PipelineDeps => {
      deps = bound;
      return bound;
    },
  };
};

const makeDeps = (runBrain: PipelineDeps["runBrain"], config: StewardConfig = makeConfig()): PipelineDeps => ({
  config,
  secrets: { GITLAB_PUSH_TOKEN: "glpat-push-token-value" },
  configPath: join(repo.root, "steward.config.ts"),
  binPath: join(repo.root, "bin", "steward.js"),
  tracker,
  brain: new FakeBrain(),
  codehost: new FakeCodeHost(),
  mirror: repo.mirror,
  stores,
  redactor: new Redactor([]),
  now: () => new Date("2026-09-30T12:00:00.000Z"),
  ...(runBrain === undefined ? {} : { runBrain }),
});

/** The job's stored result and hand-back, where a hand-back's reason lives now that Linear gets no comments. */
const recorded = (jobId: number): string => JSON.stringify(stores.jobs.get(jobId)?.implementResult ?? null);

const claim = (event: TriggerEvent = trigger): RunContext => {
  const jobId = stores.jobs.enqueue(event);
  stores.jobs.claimById(jobId);
  stores.attempts.start(jobId);
  return { jobId, attempt: 1, issueId: event.issueId, identifier: event.identifier, teamKey: event.teamKey, trigger: event, dryRun: false };
};

beforeEach(async () => {
  repo = await tmpRepo("unused");
  await commitFile(repo.repo, ".gitignore", ".env\n");
  await repo.mirror.fetch();
  stores = openStores(repo.dataDir);
  tracker = new FakeTracker([issue]);
  port = await freeTcpPort();
});

afterEach(async () => {
  vi.restoreAllMocks();
  stores.db.close();
  await repo.cleanup();
});


type AgentBrain = ReturnType<typeof agentBrain>;

/** The job's deps with the agent's push tool bound to them. */
const depsFor = (brain: AgentBrain, config: StewardConfig = makeConfig()): PipelineDeps => brain.bind(makeDeps(brain.runBrain, config));

const remoteBranches = (): Promise<string> => git(repo.repo, ["branch", "--list", "*/API-1-*"]);

describe("runImplement", () => {
  it("succeeds once the agent pushed through the push tool, swapping to agent-implemented and nothing else", async () => {
    const brain = agentBrain(implemented);
    const ctx = claim();

    const outcome = await runImplement(ctx, depsFor(brain));

    expect(outcome).toEqual({ status: "succeeded" });
    expect(brain.pushes).toMatchObject([{ ok: true, branch: BRANCH, commits: 1 }]);
    const job = stores.jobs.get(ctx.jobId);
    expect(job?.branch).toBe(BRANCH);
    expect(await git(repo.repo, ["rev-parse", `refs/heads/${BRANCH}`])).toBe(job?.commitSha);
    expect(await git(repo.repo, ["log", "-1", "--format=%s", `refs/heads/${BRANCH}`])).toBe("API-1: Keep the last chunk");
    expect(job?.pushedAt).not.toBeNull();
    expect(job?.implementResult).toEqual({ result: implemented, handback: null, baseSha: await git(repo.repo, ["rev-parse", "main"]) });
    expect(tracker.labelSwaps()).toEqual([{ issueId: "issue-1", from: "ready-for-agent", to: "agent-implemented" }]);
    expect(tracker.labelsOf("issue-1")).toEqual(["agent-implemented"]);
    expect(brain.calls[0]?.output).toBe("implement");
    expect(brain.calls[0]?.timeoutMs).toBe(60_000);
  });

  it("gives the run a push tool that creates the ticket branch on the job's base", async () => {
    const brain = agentBrain(implemented);
    const ctx = claim();

    await runImplement(ctx, depsFor(brain));

    const input = brain.calls[0];
    expect(input === undefined ? null : pushTargetOf(input)).toEqual({
      jobId: ctx.jobId, worktreePath: input?.workspacePath, identifier: "API-1", issueId: "issue-1", mode: "create", branch: null,
      baseSha: await git(repo.repo, ["rev-parse", "main"]), loopId: null, port,
    });
  });

  it("keeps every commit of a series the agent pushed in two pushes", async () => {
    const brain = agentBrain(implemented, async (workspace, push) => {
      await agentCommit(workspace, "API-1: Keep the last chunk");
      await push("fix");
      await agentCommit(workspace, "API-1: Test it", "test/adapter.test.ts", "test\n");
      await push();
    });
    const ctx = claim();

    expect(await runImplement(ctx, depsFor(brain))).toEqual({ status: "succeeded" });

    expect(brain.pushes.map((pushed) => pushed.ok)).toEqual([true, true]);
    expect(await git(repo.repo, ["log", "--format=%s", `main..refs/heads/${BRANCH}`])).toBe("API-1: Test it\nAPI-1: Keep the last chunk");
    expect(await git(repo.repo, ["rev-parse", `refs/heads/${BRANCH}`])).toBe(stores.jobs.get(ctx.jobId)?.commitSha);
  });

  it("hands back when the agent reports implemented without pushing, and the steward neither commits nor pushes", async () => {
    const brain = agentBrain(implemented, async (workspace) => writeFile(join(workspace, "src/adapter.ts"), "export const adapter = 2;\n"));
    const ctx = claim();

    const outcome = await runImplement(ctx, depsFor(brain));

    expect(outcome).toEqual({ status: "succeeded", warning: "handed back: the agent did not push its change" });
    expect(stores.jobs.get(ctx.jobId)?.implementResult?.handback).toEqual({ label: "readyForHuman", reason: "the agent did not push its change", detail: "uncommitted:\n  src/adapter.ts" });
    expect(await remoteBranches()).toBe("");
    expect(tracker.labelsOf("issue-1")).toEqual(["ready-for-human"]);
  });

  it("hands back with the commits when the agent committed but its push was refused", async () => {
    const brain = agentBrain(implemented, async (workspace, push) => {
      await agentCommit(workspace, "keep the last chunk");
      await push("fix");
    });
    const ctx = claim();

    const outcome = await runImplement(ctx, depsFor(brain));

    expect(outcome).toEqual({ status: "succeeded", warning: "handed back: the agent did not push its change" });
    expect(brain.pushes).toMatchObject([{ ok: false, reason: 'every commit subject must start with "API-1: "; amend or reword these commits' }]);
    expect(stores.jobs.get(ctx.jobId)?.implementResult?.handback?.detail).toMatch(/^commits not pushed:\n {2}[0-9a-f]{7} keep the last chunk$/);
    expect(await remoteBranches()).toBe("");
  });

  it("hands back when the agent left work after its push, never pushing it", async () => {
    const brain = agentBrain(implemented, async (workspace, push) => {
      await agentCommit(workspace, "API-1: Keep the last chunk");
      await push("fix");
      await agentCommit(workspace, "API-1: Test it", "test/adapter.test.ts", "test\n");
      await writeFile(join(workspace, "notes.md"), "draft\n");
    });
    const ctx = claim();

    const outcome = await runImplement(ctx, depsFor(brain));

    expect(outcome).toEqual({ status: "succeeded", warning: "handed back: the agent left unpushed work" });
    const detail = stores.jobs.get(ctx.jobId)?.implementResult?.handback?.detail ?? "";
    expect(detail).toMatch(/^uncommitted:\n {2}notes\.md\ncommits not pushed:\n {2}[0-9a-f]{7} API-1: Test it$/);
    expect(await git(repo.repo, ["log", "--format=%s", `main..refs/heads/${BRANCH}`])).toBe("API-1: Keep the last chunk");
    expect(tracker.labelsOf("issue-1")).toEqual(["ready-for-human"]);
  });

  it("does not count the files the steward copied in as unpushed work", async () => {
    const skillsDir = join(repo.root, "skills");
    await mkdir(join(skillsDir, "verify"), { recursive: true });
    await writeFile(join(skillsDir, "verify/SKILL.md"), "verify\n");
    await writeFile(join(repo.overlayDir, "steward.json"), "{}\n");
    const config = makeConfig();
    const ctx = claim();

    const outcome = await runImplement(ctx, depsFor(agentBrain(implemented), { ...config, workspace: { ...config.workspace, skillsDir } }));

    expect(outcome).toEqual({ status: "succeeded" });
    const sha = stores.jobs.get(ctx.jobId)?.commitSha ?? "";
    expect(await git(repo.repo, ["diff-tree", "--no-commit-id", "--name-only", "-r", sha])).toBe("src/adapter.ts");
  });

  it("marks a push that landed before the tool recorded it, so the job succeeds without pushing again", async () => {
    const brain = agentBrain(implemented);
    const ctx = claim();
    vi.spyOn(stores.jobs, "markPushed").mockImplementationOnce(() => {
      throw new Error("stopped after the push");
    });

    const outcome = await runImplement(ctx, depsFor(brain));

    expect(brain.pushes).toMatchObject([{ ok: false, reason: "push failed" }]);
    expect(outcome).toEqual({ status: "succeeded" });
    const job = stores.jobs.get(ctx.jobId);
    expect(job?.pushedAt).not.toBeNull();
    expect(stores.pushes.forJob(ctx.jobId)).toMatchObject([{ sha: job?.commitSha, pushedAt: expect.any(String) }]);
    expect(tracker.labelsOf("issue-1")).toEqual(["agent-implemented"]);
  });

  it("hands back to needs-info without touching git", async () => {
    const ctx = claim();
    const outcome = await runImplement(ctx, depsFor(agentBrain({ ...implemented, outcome: "needs_info", questions: ["Which stream?"] }, async () => undefined)));

    expect(outcome).toEqual({ status: "succeeded", warning: "handed back: the ticket needs more information" });
    expect(tracker.labelsOf("issue-1")).toEqual(["needs-info"]);
    expect(stores.jobs.get(ctx.jobId)?.implementResult?.result?.questions).toEqual(["Which stream?"]);
    expect(await remoteBranches()).toBe("");
  });

  it("hands back to ready-for-human when the agent failed", async () => {
    const ctx = claim();
    await runImplement(ctx, depsFor(agentBrain({ ...implemented, outcome: "failed", failureDetail: "the streaming test keeps failing" }, async () => undefined)));
    expect(tracker.labelsOf("issue-1")).toEqual(["ready-for-human"]);
    expect(recorded(ctx.jobId)).toContain("the streaming test keeps failing");
  });

  it("hands back without running the brain when a branch already carries the ticket", async () => {
    await git(repo.repo, ["branch", "feature/API-1-by-hand"]);
    const brain = agentBrain(implemented);
    const ctx = claim();

    const outcome = await runImplement(ctx, depsFor(brain));

    expect(outcome).toEqual({ status: "succeeded", warning: "handed back: a branch for API-1 already exists" });
    expect(brain.calls).toHaveLength(0);
    expect(recorded(ctx.jobId)).toContain("feature/API-1-by-hand");
    expect(tracker.labelsOf("issue-1")).toEqual(["ready-for-human"]);
  });

  it("does not run the brain again when an earlier attempt's agent pushed before the attempt stopped", async () => {
    const ctx = claim();
    const interrupted = agentBrain(implemented, async (workspace, push) => {
      await commitAndPush(workspace, push);
      throw new Error("steward stopped");
    });
    expect((await runImplement(ctx, depsFor(interrupted))).status).toBe("failed");
    const pushed = await git(repo.repo, ["rev-parse", `refs/heads/${BRANCH}`]);

    const again = agentBrain(implemented);
    const outcome = await runImplement({ ...ctx, attempt: 2 }, depsFor(again));

    expect(outcome).toEqual({ status: "succeeded", warning: "handed back: an earlier attempt stopped after the agent pushed" });
    expect(again.calls).toHaveLength(0);
    expect(await git(repo.repo, ["rev-parse", `refs/heads/${BRANCH}`])).toBe(pushed);
    expect(stores.jobs.get(ctx.jobId)?.implementResult?.handback?.detail).toBe(BRANCH);
  });

  it("includes the hand-back detail in a dry run", async () => {
    const ctx = { ...claim(), dryRun: true };
    const outcome = await runImplement(ctx, depsFor(agentBrain({ ...implemented, summary: "" }, async () => undefined)));
    expect(outcome).toEqual({ status: "succeeded", warning: "dry run: would hand back: the agent's result was invalid\nsummary is empty" });
    expect(tracker.labelSwaps()).toEqual([]);
  });

  it("refuses a Done ticket without running the brain", async () => {
    tracker.addIssue({ ...issue, state: { name: "Done", type: "completed" } });
    const brain = agentBrain(implemented);
    const outcome = await runImplement(claim(), depsFor(brain));
    expect(outcome).toEqual({ status: "failed", error: "API-1 is Done; Ticket Steward does not work on Done or Canceled tickets", retryable: false });
    expect(brain.calls).toHaveLength(0);
  });

  it("pushes nothing when the ticket is closed while the agent runs", async () => {
    const brain = agentBrain(implemented, async (workspace, push) => {
      tracker.addIssue({ ...issue, state: { name: "Canceled", type: "canceled" } });
      await commitAndPush(workspace, push);
    });
    const outcome = await runImplement(claim(), depsFor(brain));
    expect(brain.pushes).toMatchObject([{ ok: false, reason: "API-1 is Canceled; Ticket Steward does not work on Done or Canceled tickets" }]);
    expect(outcome).toEqual({ status: "failed", error: "API-1 is Canceled; Ticket Steward does not work on Done or Canceled tickets", retryable: false });
    expect(await remoteBranches()).toBe("");
    expect(tracker.labelSwaps()).toEqual([]);
  });

  it("does not hand back when the ticket is closed while the agent runs", async () => {
    const brain = agentBrain({ ...implemented, outcome: "needs_info", questions: ["Which stream?"] }, async () => {
      tracker.addIssue({ ...issue, state: { name: "Done", type: "completed" } });
    });
    const outcome = await runImplement(claim(), depsFor(brain));
    expect(outcome).toEqual({ status: "failed", error: "API-1 is Done; Ticket Steward does not work on Done or Canceled tickets", retryable: false });
    expect(tracker.labelSwaps()).toEqual([]);
  });

  it("ignores git config planted in the job dir by an earlier attempt", async () => {
    const ctx = claim();
    const jobDir = join(repo.dataDir, "jobs", String(ctx.jobId));
    await git(repo.root, ["init", "--quiet", "--bare", jobDir]);
    await git(jobDir, ["config", `url.${join(repo.root, "nowhere.git")}.insteadOf`, repo.repo]);

    const outcome = await runImplement(ctx, depsFor(agentBrain(implemented)));

    expect(outcome).toEqual({ status: "succeeded" });
    expect(await git(repo.repo, ["rev-parse", "--verify", `refs/heads/${BRANCH}`])).toBe(stores.jobs.get(ctx.jobId)?.commitSha);
  });

  it("leaves labels alone for a CLI-triggered job", async () => {
    await runImplement(claim({ kind: "cli", issueId: "issue-1", identifier: "API-1", teamKey: "API", action: "implement" }), depsFor(agentBrain(implemented)));
    expect(tracker.labelSwaps()).toEqual([]);
  });

  it("runs the brain and the push tool's checks against the slot's app port", async () => {
    const appPortBase = (await freeTcpPort()) - 1;
    const runner = fakeSlotRunner();
    const slots = { count: 1, socket: "/run/steward-slot.sock", appPortBase, upTimeoutSeconds: 180, env: {} };
    const base = makeConfig({ checks: [`test "$STEWARD_PORT" = "${appPortBase + 1}"`] });
    const brain = agentBrain(implemented);
    const ctx = claim();

    const deps = depsFor(brain, { ...base, workspace: { ...base.workspace, port: undefined }, slots });
    const outcome = await runImplement(ctx, brain.bind({ ...deps, slot: { n: 1, client: new SlotClient(slots, runner.run) } }));

    expect(outcome).toEqual({ status: "succeeded" });
    expect(brain.pushes).toMatchObject([{ ok: true }]);
    expect(brain.calls[0]?.env.STEWARD_PORT).toBe(String(appPortBase + 1));
    expect(runner.calls).toEqual([["down", "1"], ["up", "1"], ["ports", "1"], ["down", "1"]]);
  });
});

describe("the fix loop start", () => {
  const GREPTILE = {
    botUsername: "greptile-bot", maxRounds: 5, prompt: "/dev/null", pollSeconds: 60, mrTimeoutMinutes: 60,
    reviewTimeoutMinutes: 30, pipelineTimeoutMinutes: 60, ciLogLines: 200,
  };
  const withGreptile = (): StewardConfig => ({ ...makeConfig(), greptile: GREPTILE });

  /** An agent that commits, pushes and leaves session `session-impl`. */
  const sessionBrain = (): AgentBrain => {
    const brain = agentBrain(implemented);
    return { ...brain, runBrain: async (config: unknown, input: BrainInput) => ({ ...(await brain.runBrain(config, input)), sessionId: "session-impl" }) };
  };

  const awaitJobs = () => stores.jobs.list({ limit: 50 }).filter((job) => job.kind === "await_review");

  it("starts a loop on a stable worktree after a label-triggered push", async () => {
    const brain = sessionBrain();
    const ctx = claim();

    const outcome = await runImplement(ctx, depsFor(brain, withGreptile()));

    expect(outcome).toEqual({ status: "succeeded" });
    expect(brain.calls[0]?.workspacePath).toBe(join(repo.dataDir, "work", "ticket-API-1"));
    const job = stores.jobs.get(ctx.jobId);
    expect(job?.sessionId).toBe("session-impl");
    expect(job).toMatchObject({ worktreeName: "ticket-API-1", baseSha: await git(repo.repo, ["rev-parse", "main"]) });
    const loop = stores.loops.forImplementJob(ctx.jobId);
    expect(loop).toMatchObject({ headSha: job?.commitSha, sessionId: "session-impl", worktreeName: "ticket-API-1", branch: BRANCH, labelDriven: true, round: 0 });
    expect(loop?.baseSha).toBe(await git(repo.repo, ["rev-parse", "main"]));
    expect(awaitJobs().map((row) => row.trigger)).toEqual([{ kind: "loop", issueId: "issue-1", identifier: "API-1", teamKey: "API", loopId: loop?.id, step: "await" }]);
  });

  it("starts no loop when the agent left unpushed work", async () => {
    const brain = agentBrain(implemented, async (workspace, push) => {
      await commitAndPush(workspace, push);
      await writeFile(join(workspace, "notes.md"), "draft\n");
    });
    const ctx = claim();

    expect(await runImplement(ctx, depsFor(brain, withGreptile()))).toEqual({ status: "succeeded", warning: "handed back: the agent left unpushed work" });
    expect(stores.loops.forImplementJob(ctx.jobId)).toBeNull();
    expect(awaitJobs()).toEqual([]);
  });

  it("starts no loop for a cli trigger, which keeps the per-attempt worktree", async () => {
    const brain = sessionBrain();
    const ctx = claim({ kind: "cli", issueId: "issue-1", identifier: "API-1", teamKey: "API", action: "implement" });

    expect(await runImplement(ctx, depsFor(brain, withGreptile()))).toEqual({ status: "succeeded" });

    expect(brain.calls[0]?.workspacePath).toBe(join(repo.dataDir, "work", `${ctx.jobId}-1`));
    expect(stores.loops.forImplementJob(ctx.jobId)).toBeNull();
    expect(awaitJobs()).toEqual([]);
  });

  it("starts no loop without greptile configured", async () => {
    const brain = sessionBrain();
    const ctx = claim();

    expect(await runImplement(ctx, depsFor(brain))).toEqual({ status: "succeeded" });

    expect(brain.calls[0]?.workspacePath).toBe(join(repo.dataDir, "work", `${ctx.jobId}-1`));
    expect(stores.loops.forImplementJob(ctx.jobId)).toBeNull();
  });

  it("starts the loop exactly once, on the stored base, when publishImplementOnly retries after a crash", async () => {
    const brain = sessionBrain();
    const ctx = claim();
    vi.spyOn(stores.loops, "create").mockImplementationOnce(() => {
      throw new Error("crashed before the loop");
    });
    expect((await runImplement(ctx, depsFor(brain, withGreptile()))).status).toBe("failed");
    expect(stores.loops.forImplementJob(ctx.jobId)).toBeNull();

    tracker.failNextSwap();
    expect((await publishImplementOnly({ ...ctx, attempt: 2 }, makeDeps(undefined, withGreptile()))).status).toBe("publish_failed");
    const retry = await publishImplementOnly({ ...ctx, attempt: 3 }, makeDeps(undefined, withGreptile()));

    expect(retry).toEqual({ status: "succeeded" });
    const job = stores.jobs.get(ctx.jobId);
    expect(stores.loops.forImplementJob(ctx.jobId)).toMatchObject({ headSha: job?.commitSha, sessionId: "session-impl", worktreeName: "ticket-API-1", baseSha: await git(repo.repo, ["rev-parse", "main"]) });
    expect(awaitJobs()).toHaveLength(1);
    expect(brain.calls).toHaveLength(1);
  });
});

describe("publishImplementOnly", () => {
  it("re-publishes after a failed label swap without pushing again", async () => {
    const ctx = claim();
    tracker.failNextSwap();
    const first = await runImplement(ctx, depsFor(agentBrain(implemented)));
    expect(first.status).toBe("publish_failed");
    const pushed = await git(repo.repo, ["rev-parse", `refs/heads/${BRANCH}`]);

    const retry = await publishImplementOnly({ ...ctx, attempt: 2 }, makeDeps(undefined));

    expect(retry).toEqual({ status: "succeeded" });
    expect(await git(repo.repo, ["rev-parse", `refs/heads/${BRANCH}`])).toBe(pushed);
    expect(tracker.labelsOf("issue-1")).toEqual(["agent-implemented"]);
  });

  it("treats its own already-landed push as pushed when the record was lost", async () => {
    const ctx = claim();
    tracker.failNextSwap();
    await runImplement(ctx, depsFor(agentBrain(implemented)));
    stores.db.prepare("UPDATE jobs SET pushed_at = NULL WHERE id = ?").run(ctx.jobId);

    const retry = await publishImplementOnly({ ...ctx, attempt: 2 }, makeDeps(undefined));

    expect(retry).toEqual({ status: "succeeded" });
    expect(stores.jobs.get(ctx.jobId)?.pushedAt).not.toBeNull();
    expect(tracker.labelsOf("issue-1")).toEqual(["agent-implemented"]);
  });

  it("hands back without pushing when the recorded push never landed", async () => {
    const ctx = claim();
    const sha = await git(repo.repo, ["rev-parse", "main"]);
    stores.jobs.recordCommit(ctx.jobId, BRANCH, sha);
    stores.jobs.saveImplementResult(ctx.jobId, { result: implemented, handback: null, baseSha: sha });

    const retry = await publishImplementOnly({ ...ctx, attempt: 2 }, makeDeps(undefined));

    expect(retry).toEqual({ status: "succeeded", warning: "handed back: the push did not complete" });
    expect(await remoteBranches()).toBe("");
    expect(stores.jobs.get(ctx.jobId)?.implementResult?.handback).toEqual({ label: "readyForHuman", reason: "the push did not complete", detail: BRANCH });
    expect(tracker.labelsOf("issue-1")).toEqual(["ready-for-human"]);
  });

  it("does not record a push when the remote is unreachable", async () => {
    const ctx = claim();
    const deps = depsFor(agentBrain(implemented));
    const unreachable = { ...deps, config: { ...deps.config, workspace: { ...deps.config.workspace, fetchUrl: join(repo.root, "missing.git") } } };

    const outcome = await runImplement(ctx, unreachable);

    expect(outcome).toMatchObject({ status: "failed", retryable: true });
    expect(stores.jobs.get(ctx.jobId)?.pushedAt ?? null).toBeNull();
  });
});
