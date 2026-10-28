import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { INTERRUPTED_ERROR, type BrainInput, type BrainRun } from "../../src/brain/types.js";
import type { StewardConfig } from "../../src/config/schema.js";
import type { PipelineDeps } from "../../src/core/deps.js";
import { Redactor } from "../../src/core/redact.js";
import type { RunContext } from "../../src/core/types.js";
import type { ImplementResult } from "../../src/implement/result.js";
import { publishImplementOnly, runImplement } from "../../src/implement/pipeline.js";
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

const implemented: ImplementResult = {
  outcome: "implemented",
  branchType: "fix",
  commitMessage: "Keep the last chunk\n\nFlush the buffer before closing.",
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

/** A brain that edits the worktree, then returns `result`. */
const editingBrain = (result: unknown, edit: (workspace: string) => Promise<void> = async (w) => writeFile(join(w, "src/adapter.ts"), "export const adapter = 2;\n")) => {
  const calls: BrainInput[] = [];
  const runBrain = async (_config: unknown, input: BrainInput): Promise<BrainRun> => {
    calls.push(input);
    await edit(input.workspacePath);
    return { ok: true, output: result };
  };
  return { calls, runBrain };
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

describe("runImplement", () => {
  it("commits, pushes the branch, comments and swaps to agent-implemented", async () => {
    const brain = editingBrain(implemented);
    const ctx = claim();

    const outcome = await runImplement(ctx, makeDeps(brain.runBrain));

    expect(outcome).toEqual({ status: "succeeded" });
    const job = stores.jobs.get(ctx.jobId);
    expect(job?.branch).toBe("fix/API-1-adapter-drops-the-last-chunk");
    expect(await git(repo.repo, ["rev-parse", "refs/heads/fix/API-1-adapter-drops-the-last-chunk"])).toBe(job?.commitSha);
    expect(await git(repo.repo, ["log", "-1", "--format=%s", "refs/heads/fix/API-1-adapter-drops-the-last-chunk"])).toBe("API-1: Keep the last chunk");
    expect(job?.pushedAt).not.toBeNull();
    expect(tracker.comments("issue-1")[0]).toContain("fix/API-1-adapter-drops-the-last-chunk");
    expect(tracker.labelsOf("issue-1")).toEqual(["agent-implemented"]);
    expect(brain.calls[0]?.output).toBe("implement");
    expect(brain.calls[0]?.timeoutMs).toBe(60_000);
  });

  it("pushes the agent's change without the steward's skills when the repo does not gitignore them", async () => {
    const skillsDir = join(repo.root, "skills");
    await mkdir(join(skillsDir, "verify"), { recursive: true });
    await writeFile(join(skillsDir, "README.md"), "steward skills\n");
    await writeFile(join(skillsDir, "verify/SKILL.md"), "verify\n");
    const config = makeConfig();
    const ctx = claim();

    const outcome = await runImplement(ctx, makeDeps(editingBrain(implemented).runBrain, { ...config, workspace: { ...config.workspace, skillsDir } }));

    expect(outcome).toEqual({ status: "succeeded" });
    const sha = stores.jobs.get(ctx.jobId)?.commitSha ?? "";
    expect(await git(repo.repo, ["diff-tree", "--no-commit-id", "--name-only", "-r", sha])).toBe("src/adapter.ts");
    expect(tracker.labelsOf("issue-1")).toEqual(["agent-implemented"]);
  });

  it("hands back to needs-info without touching git", async () => {
    const ctx = claim();
    const outcome = await runImplement(ctx, makeDeps(editingBrain({ ...implemented, outcome: "needs_info", branchType: null, questions: ["Which stream?"] }, async () => undefined).runBrain));

    expect(outcome).toEqual({ status: "succeeded", warning: "handed back: the ticket needs more information" });
    expect(tracker.labelsOf("issue-1")).toEqual(["needs-info"]);
    expect(tracker.comments("issue-1")[0]).toContain("1. Which stream?");
    expect(await git(repo.repo, ["branch", "--list", "*/API-1-*"])).toBe("");
  });

  it("hands back to ready-for-human when the agent failed", async () => {
    const ctx = claim();
    await runImplement(ctx, makeDeps(editingBrain({ ...implemented, outcome: "failed", branchType: null, failureDetail: "the streaming test keeps failing" }).runBrain));
    expect(tracker.labelsOf("issue-1")).toEqual(["ready-for-human"]);
    expect(tracker.comments("issue-1")[0]).toContain("the streaming test keeps failing");
  });

  it("hands back without running the brain when a branch already carries the ticket", async () => {
    await git(repo.repo, ["branch", "feature/API-1-by-hand"]);
    const brain = editingBrain(implemented);
    const ctx = claim();

    const outcome = await runImplement(ctx, makeDeps(brain.runBrain));

    expect(outcome).toEqual({ status: "succeeded", warning: "handed back: a branch for API-1 already exists" });
    expect(brain.calls).toHaveLength(0);
    expect(tracker.comments("issue-1")[0]).toContain("feature/API-1-by-hand");
    expect(tracker.labelsOf("issue-1")).toEqual(["ready-for-human"]);
  });

  it.each(["hotfix", "Fix"])("hands back when the agent picks a branch type outside the list (%s)", async (branchType) => {
    const ctx = claim();
    const outcome = await runImplement(ctx, makeDeps(editingBrain({ ...implemented, branchType }).runBrain));
    expect(outcome).toEqual({ status: "succeeded", warning: "handed back: the agent's result was invalid" });
    expect(tracker.labelsOf("issue-1")).toEqual(["ready-for-human"]);
    expect(await git(repo.repo, ["branch", "--list", "*/API-1-*"])).toBe("");
  });

  it("hands back when the steward's checks fail", async () => {
    const ctx = claim();
    const outcome = await runImplement(ctx, makeDeps(editingBrain(implemented).runBrain, makeConfig({ checks: ["echo 'type error in adapter.ts'; exit 2"] })));
    expect(outcome).toEqual({ status: "succeeded", warning: "handed back: the steward's checks failed" });
    expect(tracker.comments("issue-1")[0]).toContain("type error in adapter.ts");
    expect(await git(repo.repo, ["branch", "--list", "*/API-1-*"])).toBe("");
  });

  it("hands back when the change contains an overlay secret", async () => {
    await writeFile(join(repo.overlayDir, ".env"), "API_SECRET=supersecretvalue123\n");
    const ctx = claim();
    const brain = editingBrain(implemented, async (w) => writeFile(join(w, "src/adapter.ts"), 'export const s = "supersecretvalue123";\n'));
    const outcome = await runImplement(ctx, makeDeps(brain.runBrain));
    expect(outcome).toEqual({ status: "succeeded", warning: "handed back: the change contains a secret value" });
    expect(tracker.comments("issue-1")[0]).not.toContain("supersecretvalue123");
  });

  it("hands back when a pre-commit hook force-adds a gitignored overlay secret, pushing nothing", async () => {
    await writeFile(join(repo.overlayDir, ".env"), "API_SECRET=supersecretvalue123\n");
    const ctx = claim();
    const brain = editingBrain(implemented, async (w) => {
      await writeFile(join(w, "src/adapter.ts"), "export const adapter = 2;\n");
      await mkdir(join(w, ".husky"), { recursive: true });
      await writeFile(join(w, ".husky/pre-commit"), "git add -f .env\n");
    });

    const outcome = await runImplement(ctx, makeDeps(brain.runBrain));

    expect(outcome).toEqual({ status: "succeeded", warning: "handed back: the change would commit files the steward copied in" });
    expect(tracker.comments("issue-1")[0]).toContain(".env");
    expect(tracker.labelsOf("issue-1")).toEqual(["ready-for-human"]);
    expect(await git(repo.repo, ["branch", "--list", "*/API-1-*"])).toBe("");
    expect(stores.jobs.get(ctx.jobId)?.pushedAt ?? null).toBeNull();
  });

  it("hands back when a pre-commit hook stages a secret the steward guard passed", async () => {
    await writeFile(join(repo.overlayDir, ".env"), "API_SECRET=supersecretvalue123\n");
    const ctx = claim();
    const brain = editingBrain(implemented, async (w) => {
      await writeFile(join(w, "src/adapter.ts"), "export const adapter = 2;\n");
      await mkdir(join(w, ".husky"), { recursive: true });
      await writeFile(join(w, ".husky/pre-commit"), "cp .env src/leak.txt\ngit add src/leak.txt\n");
    });

    const outcome = await runImplement(ctx, makeDeps(brain.runBrain));

    expect(outcome).toEqual({ status: "succeeded", warning: "handed back: the change contains a secret value" });
    expect(tracker.comments("issue-1")[0]).toContain("src/leak.txt");
    expect(await git(repo.repo, ["branch", "--list", "*/API-1-*"])).toBe("");
  });

  it("hands back when a commit-msg hook appends a secret to the message, pushing nothing", async () => {
    await writeFile(join(repo.overlayDir, ".env"), "API_SECRET=supersecretvalue123\n");
    const ctx = claim();
    const brain = editingBrain(implemented, async (w) => {
      await writeFile(join(w, "src/adapter.ts"), "export const adapter = 2;\n");
      await mkdir(join(w, ".husky"), { recursive: true });
      // Read from the overlay at commit time, so the hook file itself carries no secret for the change guard to see.
      await writeFile(join(w, ".husky/commit-msg"), 'cut -d= -f2 .env >> "$1"\n');
    });

    const outcome = await runImplement(ctx, makeDeps(brain.runBrain));

    expect(outcome).toEqual({ status: "succeeded", warning: "handed back: the commit message contains a secret value" });
    expect(tracker.comments("issue-1")[0]).toContain("commit message");
    expect(tracker.comments("issue-1")[0]).not.toContain("supersecretvalue123");
    expect(tracker.labelsOf("issue-1")).toEqual(["ready-for-human"]);
    expect(await git(repo.repo, ["branch", "--list", "*/API-1-*"])).toBe("");
    expect(stores.jobs.get(ctx.jobId)?.pushedAt ?? null).toBeNull();
  });

  it("hands back when the change contains one of the steward's own secrets", async () => {
    const ctx = claim();
    const brain = editingBrain(implemented, async (w) => writeFile(join(w, "src/adapter.ts"), 'export const k = "sk-ant-steward-brain-key";\n'));
    const deps = { ...makeDeps(brain.runBrain), secrets: { GITLAB_PUSH_TOKEN: "glpat-push-token-value", ANTHROPIC_API_KEY: "sk-ant-steward-brain-key" } };

    const outcome = await runImplement(ctx, deps);

    expect(outcome).toEqual({ status: "succeeded", warning: "handed back: the change contains a secret value" });
    expect(await git(repo.repo, ["branch", "--list", "*/API-1-*"])).toBe("");
  });

  it("treats a shutdown during the checks as an interruption, not a hand-back", async () => {
    const abort = new AbortController();
    const ctx = claim();
    const brain = editingBrain(implemented, async (w) => {
      await writeFile(join(w, "src/adapter.ts"), "export const adapter = 2;\n");
      setTimeout(() => abort.abort(), 300);
    });
    const deps = { ...makeDeps(brain.runBrain, makeConfig({ checks: ["sleep 10"] })), signal: abort.signal };

    const outcome = await runImplement(ctx, deps);

    expect(outcome).toEqual({ status: "failed", error: INTERRUPTED_ERROR, retryable: true });
    expect(stores.jobs.get(ctx.jobId)?.implementResult ?? null).toBeNull();
    expect(tracker.comments("issue-1")).toEqual([]);
    expect(tracker.labelSwaps()).toEqual([]);
  });

  it("includes the hand-back detail in a dry run", async () => {
    const ctx = { ...claim(), dryRun: true };
    const outcome = await runImplement(ctx, makeDeps(editingBrain(implemented).runBrain, makeConfig({ checks: ["echo 'type error in adapter.ts'; exit 2"] })));
    expect(outcome).toMatchObject({ status: "succeeded", warning: expect.stringMatching(/^dry run: would hand back: the steward's checks failed\n[\s\S]*type error in adapter\.ts/) });
    expect(tracker.comments("issue-1")).toEqual([]);
  });

  it("refuses a Done ticket without running the brain", async () => {
    tracker.addIssue({ ...issue, state: { name: "Done", type: "completed" } });
    const brain = editingBrain(implemented);
    const outcome = await runImplement(claim(), makeDeps(brain.runBrain));
    expect(outcome).toEqual({ status: "failed", error: "API-1 is Done; Ticket Steward does not work on Done or Canceled tickets", retryable: false });
    expect(brain.calls).toHaveLength(0);
  });

  it("does not commit or push when the ticket is closed while the agent runs", async () => {
    const brain = editingBrain(implemented, async (w) => {
      await writeFile(join(w, "src/adapter.ts"), "export const adapter = 2;\n");
      tracker.addIssue({ ...issue, state: { name: "Canceled", type: "canceled" } });
    });
    const outcome = await runImplement(claim(), makeDeps(brain.runBrain));
    expect(outcome).toEqual({ status: "failed", error: "API-1 is Canceled; Ticket Steward does not work on Done or Canceled tickets", retryable: false });
    expect(await git(repo.repo, ["branch", "--list", "*/API-1-*"])).toBe("");
    expect(tracker.comments("issue-1")).toEqual([]);
  });

  it("does not hand back when the ticket is closed while the agent runs", async () => {
    const brain = editingBrain({ ...implemented, outcome: "needs_info", branchType: null, questions: ["Which stream?"] }, async () => {
      tracker.addIssue({ ...issue, state: { name: "Done", type: "completed" } });
    });
    const outcome = await runImplement(claim(), makeDeps(brain.runBrain));
    expect(outcome).toEqual({ status: "failed", error: "API-1 is Done; Ticket Steward does not work on Done or Canceled tickets", retryable: false });
    expect(tracker.comments("issue-1")).toEqual([]);
    expect(tracker.labelSwaps()).toEqual([]);
  });

  it("ignores git config planted in the job dir by an earlier attempt", async () => {
    const ctx = claim();
    const jobDir = join(repo.dataDir, "jobs", String(ctx.jobId));
    await git(repo.root, ["init", "--quiet", "--bare", jobDir]);
    await git(jobDir, ["config", `url.${join(repo.root, "nowhere.git")}.insteadOf`, repo.repo]);

    const outcome = await runImplement(ctx, makeDeps(editingBrain(implemented).runBrain));

    expect(outcome).toEqual({ status: "succeeded" });
    expect(await git(repo.repo, ["rev-parse", "--verify", "refs/heads/fix/API-1-adapter-drops-the-last-chunk"])).toBe(stores.jobs.get(ctx.jobId)?.commitSha);
  });

  it("leaves labels alone for a CLI-triggered job", async () => {
    await runImplement(claim({ kind: "cli", issueId: "issue-1", identifier: "API-1", teamKey: "API", action: "implement" }), makeDeps(editingBrain(implemented).runBrain));
    expect(tracker.labelSwaps()).toEqual([]);
  });

  it("runs the brain and the steward's checks against the slot's app port", async () => {
    const appPortBase = (await freeTcpPort()) - 1;
    const runner = fakeSlotRunner();
    const slots = { count: 1, socket: "/run/steward-slot.sock", appPortBase, upTimeoutSeconds: 180, env: {} };
    const base = makeConfig({ checks: [`test "$STEWARD_PORT" = "${appPortBase + 1}"`] });
    const brain = editingBrain(implemented);
    const ctx = claim();

    const outcome = await runImplement(ctx, {
      ...makeDeps(brain.runBrain, { ...base, workspace: { ...base.workspace, port: undefined }, slots }),
      slot: { n: 1, client: new SlotClient(slots, runner.run) },
    });

    expect(outcome).toEqual({ status: "succeeded" });
    expect(stores.jobs.get(ctx.jobId)?.pushedAt).not.toBeNull();
    expect(brain.calls[0]?.env.STEWARD_PORT).toBe(String(appPortBase + 1));
    expect(runner.calls).toEqual([["down", "1"], ["up", "1"], ["ports", "1"], ["down", "1"]]);
  });
});

/** Makes the source repo reject pushes until the returned function is called. */
const rejectPushes = async (): Promise<() => Promise<void>> => {
  const marker = join(repo.root, "reject-push");
  const hook = join(repo.repo, ".git", "hooks", "pre-receive");
  await writeFile(hook, `#!/bin/sh\nif [ -e '${marker}' ]; then echo rejected >&2; exit 1; fi\n`);
  await chmod(hook, 0o755);
  await writeFile(marker, "");
  return () => rm(marker);
};

describe("the fix loop start", () => {
  const GREPTILE = {
    botUsername: "greptile-bot", maxRounds: 5, prompt: "/dev/null", pollSeconds: 60, mrTimeoutMinutes: 60,
    reviewTimeoutMinutes: 30, pipelineTimeoutMinutes: 60, ciLogLines: 200,
  };
  const withGreptile = (): StewardConfig => ({ ...makeConfig(), greptile: GREPTILE });

  /** A fake brain that edits the adapter, returns `implemented` and leaves session `session-impl`; run through `runBrain`. */
  const sessionBrain = (): { brain: FakeBrain; runBrain: NonNullable<PipelineDeps["runBrain"]> } => {
    const brain = new FakeBrain({ result: implemented, editWorkspace: { "src/adapter.ts": "export const adapter = 2;\n" }, sessionId: "session-impl" });
    return { brain, runBrain: async (_config, input) => brain.run(input, () => undefined) };
  };

  const awaitJobs = () => stores.jobs.list({ limit: 50 }).filter((job) => job.kind === "await_review");

  it("starts a loop on a stable worktree after a label-triggered push", async () => {
    const { brain, runBrain } = sessionBrain();
    const ctx = claim();

    const outcome = await runImplement(ctx, makeDeps(runBrain, withGreptile()));

    expect(outcome).toEqual({ status: "succeeded" });
    expect(brain.lastInput().workspacePath).toBe(join(repo.dataDir, "work", "ticket-API-1"));
    const job = stores.jobs.get(ctx.jobId);
    expect(job?.sessionId).toBe("session-impl");
    const loop = stores.loops.forImplementJob(ctx.jobId);
    expect(loop).toMatchObject({ headSha: job?.commitSha, sessionId: "session-impl", worktreeName: "ticket-API-1", branch: "fix/API-1-adapter-drops-the-last-chunk", labelDriven: true, round: 0 });
    expect(loop?.baseSha).toBe(await git(repo.repo, ["rev-parse", "main"]));
    expect(awaitJobs().map((row) => row.trigger)).toEqual([{ kind: "loop", issueId: "issue-1", identifier: "API-1", teamKey: "API", loopId: loop?.id, step: "await" }]);
  });

  it("starts no loop for a cli trigger, which keeps the per-attempt worktree", async () => {
    const { brain, runBrain } = sessionBrain();
    const ctx = claim({ kind: "cli", issueId: "issue-1", identifier: "API-1", teamKey: "API", action: "implement" });

    expect(await runImplement(ctx, makeDeps(runBrain, withGreptile()))).toEqual({ status: "succeeded" });

    expect(brain.lastInput().workspacePath).toBe(join(repo.dataDir, "work", `${ctx.jobId}-1`));
    expect(stores.loops.forImplementJob(ctx.jobId)).toBeNull();
    expect(awaitJobs()).toEqual([]);
  });

  it("starts no loop without greptile configured", async () => {
    const { brain, runBrain } = sessionBrain();
    const ctx = claim();

    expect(await runImplement(ctx, makeDeps(runBrain))).toEqual({ status: "succeeded" });

    expect(brain.lastInput().workspacePath).toBe(join(repo.dataDir, "work", `${ctx.jobId}-1`));
    expect(stores.loops.forImplementJob(ctx.jobId)).toBeNull();
  });

  it("starts the loop exactly once when publishImplementOnly retries after a crash", async () => {
    const { runBrain } = sessionBrain();
    const ctx = claim();
    vi.spyOn(stores.jobs, "markPushed").mockImplementationOnce(() => {
      throw new Error("crashed after push");
    });
    expect((await runImplement(ctx, makeDeps(runBrain, withGreptile()))).status).toBe("failed");
    expect(stores.loops.forImplementJob(ctx.jobId)).toBeNull();

    tracker.failNextWrite();
    expect((await publishImplementOnly({ ...ctx, attempt: 2 }, makeDeps(undefined, withGreptile()))).status).toBe("publish_failed");
    const retry = await publishImplementOnly({ ...ctx, attempt: 3 }, makeDeps(undefined, withGreptile()));

    expect(retry).toEqual({ status: "succeeded" });
    const job = stores.jobs.get(ctx.jobId);
    expect(stores.loops.forImplementJob(ctx.jobId)).toMatchObject({ headSha: job?.commitSha, sessionId: "session-impl", worktreeName: "ticket-API-1", baseSha: await git(repo.repo, ["rev-parse", "main"]) });
    expect(awaitJobs()).toHaveLength(1);
  });
});

describe("publishImplementOnly", () => {
  it("re-publishes after a failed comment without pushing again", async () => {
    const ctx = claim();
    tracker.failNextWrite();
    const first = await runImplement(ctx, makeDeps(editingBrain(implemented).runBrain));
    expect(first.status).toBe("publish_failed");
    const pushed = await git(repo.repo, ["rev-parse", "refs/heads/fix/API-1-adapter-drops-the-last-chunk"]);

    const retry = await publishImplementOnly({ ...ctx, attempt: 2 }, makeDeps(undefined));

    expect(retry).toEqual({ status: "succeeded" });
    expect(await git(repo.repo, ["rev-parse", "refs/heads/fix/API-1-adapter-drops-the-last-chunk"])).toBe(pushed);
    expect(tracker.labelsOf("issue-1")).toEqual(["agent-implemented"]);
  });

  it("does not post the implement comment twice when a label-swap failure is retried", async () => {
    const ctx = claim();
    tracker.failNextSwap();
    const first = await runImplement(ctx, makeDeps(editingBrain(implemented).runBrain));
    expect(first).toEqual({ status: "publish_failed", error: "labels: Linear down" });
    expect(tracker.comments("issue-1")).toHaveLength(1);

    const retry = await publishImplementOnly({ ...ctx, attempt: 2 }, makeDeps(undefined));

    expect(retry).toEqual({ status: "succeeded" });
    expect(tracker.comments("issue-1")).toHaveLength(1);
    expect(tracker.labelsOf("issue-1")).toEqual(["agent-implemented"]);
  });

  it("pushes from the bundle on retry after the first push was rejected", async () => {
    const allowPushes = await rejectPushes();
    const ctx = claim();

    const first = await runImplement(ctx, makeDeps(editingBrain(implemented).runBrain));
    expect(first).toMatchObject({ status: "publish_failed", error: expect.stringContaining("push:") });
    expect(stores.jobs.get(ctx.jobId)?.pushedAt ?? null).toBeNull();
    expect(tracker.comments("issue-1")).toEqual([]);
    expect(tracker.labelsOf("issue-1")).toEqual(["ready-for-agent"]);

    await allowPushes();
    const retry = await publishImplementOnly({ ...ctx, attempt: 2 }, makeDeps(undefined));

    expect(retry).toEqual({ status: "succeeded" });
    const job = stores.jobs.get(ctx.jobId);
    expect(await git(repo.repo, ["rev-parse", "refs/heads/fix/API-1-adapter-drops-the-last-chunk"])).toBe(job?.commitSha);
    expect(job?.pushedAt).not.toBeNull();
    expect(tracker.labelsOf("issue-1")).toEqual(["agent-implemented"]);
  });

  it("treats its own already-landed push as pushed when the record was lost", async () => {
    const ctx = claim();
    tracker.failNextWrite();
    await runImplement(ctx, makeDeps(editingBrain(implemented).runBrain));
    stores.db.prepare("UPDATE jobs SET pushed_at = NULL WHERE id = ?").run(ctx.jobId);

    const retry = await publishImplementOnly({ ...ctx, attempt: 2 }, makeDeps(undefined));

    expect(retry).toEqual({ status: "succeeded" });
    expect(stores.jobs.get(ctx.jobId)?.pushedAt).not.toBeNull();
    expect(tracker.labelsOf("issue-1")).toEqual(["agent-implemented"]);
  });

  it("does not push on retry when the ticket was canceled after a failed push", async () => {
    const allowPushes = await rejectPushes();
    const ctx = claim();
    expect((await runImplement(ctx, makeDeps(editingBrain(implemented).runBrain))).status).toBe("publish_failed");
    tracker.addIssue({ ...issue, state: { name: "Canceled", type: "canceled" } });
    await allowPushes();

    const retry = await publishImplementOnly({ ...ctx, attempt: 2 }, makeDeps(undefined));

    expect(retry).toEqual({ status: "failed", error: "API-1 is Canceled; Ticket Steward does not work on Done or Canceled tickets", retryable: false });
    expect(await git(repo.repo, ["branch", "--list", "*/API-1-*"])).toBe("");
    expect(tracker.comments("issue-1")).toEqual([]);
    expect(tracker.labelSwaps()).toEqual([]);
  });

  it("routes a crash right after the push to the retry path, which publishes without pushing again", async () => {
    const ctx = claim();
    vi.spyOn(stores.jobs, "markPushed").mockImplementationOnce(() => {
      throw new Error("crashed after push");
    });
    expect((await runImplement(ctx, makeDeps(editingBrain(implemented).runBrain))).status).toBe("failed");
    const job = stores.jobs.get(ctx.jobId);
    expect(job?.implementResult).not.toBeNull();
    expect(job?.pushedAt ?? null).toBeNull();
    expect(tracker.comments("issue-1")).toEqual([]);
    const pushed = await git(repo.repo, ["rev-parse", "refs/heads/fix/API-1-adapter-drops-the-last-chunk"]);
    expect(pushed).toBe(job?.commitSha);

    const retry = await publishImplementOnly({ ...ctx, attempt: 2 }, makeDeps(undefined));

    expect(retry).toEqual({ status: "succeeded" });
    expect(stores.jobs.get(ctx.jobId)?.pushedAt).not.toBeNull();
    expect(await git(repo.repo, ["rev-parse", "refs/heads/fix/API-1-adapter-drops-the-last-chunk"])).toBe(pushed);
    expect(tracker.labelsOf("issue-1")).toEqual(["agent-implemented"]);
  });

  it("hands back on retry when someone else's branch now carries the ticket", async () => {
    const allowPushes = await rejectPushes();
    const ctx = claim();
    expect((await runImplement(ctx, makeDeps(editingBrain(implemented).runBrain))).status).toBe("publish_failed");
    await git(repo.repo, ["branch", "feature/API-1-by-hand"]);
    await allowPushes();

    const retry = await publishImplementOnly({ ...ctx, attempt: 2 }, makeDeps(undefined));

    expect(retry).toEqual({ status: "succeeded", warning: "handed back: a branch for API-1 already exists" });
    expect(await git(repo.repo, ["branch", "--list", "fix/API-1-*"])).toBe("");
    expect(tracker.comments("issue-1")[0]).toContain("feature/API-1-by-hand");
    expect(tracker.labelsOf("issue-1")).toEqual(["ready-for-human"]);
    expect(stores.jobs.get(ctx.jobId)?.implementResult?.handback).toMatchObject({ reason: "a branch for API-1 already exists", detail: "feature/API-1-by-hand" });
  });

  it("does not record a push when the remote is unreachable", async () => {
    const ctx = claim();
    const deps = makeDeps(editingBrain(implemented).runBrain);
    const unreachable = { ...deps, config: { ...deps.config, workspace: { ...deps.config.workspace, fetchUrl: join(repo.root, "missing.git") } } };

    const outcome = await runImplement(ctx, unreachable);

    expect(outcome).toMatchObject({ status: "failed", retryable: true });
    expect(stores.jobs.get(ctx.jobId)?.pushedAt ?? null).toBeNull();
  });
});
