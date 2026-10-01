import { chmod, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { BrainInput, BrainRun } from "../../src/brain/types.js";
import type { StewardConfig } from "../../src/config/schema.js";
import type { PipelineDeps } from "../../src/core/pipeline.js";
import { Redactor } from "../../src/core/redact.js";
import type { RunContext } from "../../src/core/types.js";
import type { ImplementResult } from "../../src/implement/result.js";
import { publishImplementOnly, runImplement } from "../../src/implement/pipeline.js";
import { openStores, type Stores } from "../../src/store/index.js";
import type { IssueTrigger, TicketBundle } from "../../src/tracker/types.js";
import { FakeBrain } from "../fakes/fakeBrain.js";
import { FakeCodeHost } from "../fakes/fakeCodeHost.js";
import { FakeTracker } from "../fakes/fakeTracker.js";
import { freeTcpPort, tmpRepo, type TmpRepo } from "../fakes/tmpRepo.js";
import { commitFile, git } from "../workspace/helpers.js";

const IMPLEMENT_PROMPT = fileURLToPath(new URL("../../prompts/implement.md", import.meta.url));
const LABELS = { triage: "needs-triage", implement: "ready-for-agent", needsInfo: "needs-info", readyForHuman: "ready-for-human", implemented: "agent-implemented" };

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

const trigger: IssueTrigger = { kind: "issue.labeled", issueId: "issue-1", identifier: "API-1", teamKey: "API", deliveryId: "d-1", description: issue.description, stateType: "unstarted", action: "implement" };

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

const claim = (event: IssueTrigger = trigger): RunContext => {
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

  it("hands back when the agent picks a branch type outside the list", async () => {
    const ctx = claim();
    const outcome = await runImplement(ctx, makeDeps(editingBrain({ ...implemented, branchType: "hotfix" }).runBrain));
    expect(outcome).toMatchObject({ status: "succeeded", warning: expect.stringContaining("handed back:") });
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
    expect(outcome).toEqual({ status: "succeeded", warning: "handed back: the change contains a secret value from the overlay" });
    expect(tracker.comments("issue-1")[0]).not.toContain("supersecretvalue123");
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

  it("pushes from the bundle on retry after the first push was rejected", async () => {
    const marker = join(repo.root, "reject-push");
    const hook = join(repo.repo, ".git", "hooks", "pre-receive");
    await writeFile(hook, `#!/bin/sh\nif [ -e '${marker}' ]; then echo rejected >&2; exit 1; fi\n`);
    await chmod(hook, 0o755);
    await writeFile(marker, "");
    const ctx = claim();

    const first = await runImplement(ctx, makeDeps(editingBrain(implemented).runBrain));
    expect(first).toMatchObject({ status: "publish_failed", error: expect.stringContaining("push:") });
    expect(stores.jobs.get(ctx.jobId)?.pushedAt ?? null).toBeNull();
    expect(tracker.comments("issue-1")).toEqual([]);
    expect(tracker.labelsOf("issue-1")).toEqual(["ready-for-agent"]);

    await rm(marker);
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

  it("does not record a push when the remote is unreachable", async () => {
    const ctx = claim();
    const deps = makeDeps(editingBrain(implemented).runBrain);
    const unreachable = { ...deps, config: { ...deps.config, workspace: { ...deps.config.workspace, fetchUrl: join(repo.root, "missing.git") } } };

    const outcome = await runImplement(ctx, unreachable);

    expect(outcome).toMatchObject({ status: "failed", retryable: true });
    expect(stores.jobs.get(ctx.jobId)?.pushedAt ?? null).toBeNull();
  });
});
