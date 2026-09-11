import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { INTERRUPTED_ERROR, runBrainDetached } from "../../src/brain/index.js";
import type { FakeBrainPids } from "../../src/brain/fake.js";
import type { BrainConfig, StewardConfig } from "../../src/config/schema.js";
import { runJob, publishOnly, type PipelineDeps } from "../../src/core/pipeline.js";
import { Redactor } from "../../src/core/redact.js";
import type { BrainResult } from "../../src/core/result.js";
import type { RunContext } from "../../src/core/types.js";
import { openStores, type Stores } from "../../src/store/index.js";
import { ReadOnlyTracker } from "../../src/tracker/readOnly.js";
import type { TicketBundle, TriggerEvent } from "../../src/tracker/types.js";
import { isPortFree } from "../../src/workspace/retention.js";
import { FakeBrain, type FakeBrainOptions } from "../fakes/fakeBrain.js";
import { FakeCodeHost } from "../fakes/fakeCodeHost.js";
import { FakeTracker } from "../fakes/fakeTracker.js";
import { freeTcpPort, tmpRepo, type TmpRepo } from "../fakes/tmpRepo.js";

const PROMPT_TEMPLATE = "Ticket:\n{{ticket}}\n\nOperator: {{operatorInstructions}}\nWorkspace: {{workspacePath}} @ {{sha}}\n";
const NOW = new Date("2026-09-11T14:02:30.000Z");

const issue: TicketBundle = {
  id: "issue-1",
  identifier: "API-1",
  url: "https://linear.app/acme/issue/API-1",
  title: "Adapter drops the last chunk",
  description: "The adapter loses the final chunk.",
  team: { id: "team-1", key: "API", name: "API" },
  state: { name: "Triage", type: "triage" },
  labels: ["bug"],
  priority: 2,
  creator: { name: "Ada", isBot: false },
  createdAt: "2026-09-11T00:00:00.000Z",
  comments: [],
  attachments: [],
  appliedTemplate: null,
  templates: [],
};

const createdTrigger: TriggerEvent = {
  kind: "issue.created",
  issueId: "issue-1",
  identifier: "API-1",
  teamKey: "API",
  deliveryId: "delivery-1",
  description: issue.description,
};

const sessionTrigger: TriggerEvent = {
  kind: "agent.session",
  action: "prompted",
  issueId: "issue-1",
  identifier: "API-1",
  teamKey: "API",
  sessionId: "session-1",
  deliveryId: "delivery-2",
  promptBody: "Focus on the streaming adapter",
};

const brainResult: BrainResult = {
  template: { matched: "Bugs", conforms: false, missing: ["Repro Steps"] },
  summary: "The adapter truncates the final chunk.",
  enrichment: "See `src/adapter.ts:12`.",
  attachments: [],
  confidence: "high",
};

const expectedSection = (sha: string, jobId: number, extra = ""): string =>
  [
    "<!-- ticket-steward:begin -->",
    "## Enrichment",
    `_Ticket Steward · 2026-09-11 14:02 UTC · main@${sha.slice(0, 7)} · confidence: high · job ${jobId}_`,
    "",
    "**Template:** Bugs — missing: Repro Steps",
    "",
    `See [src/adapter.ts:12](https://fake.example/blob/${sha}/src/adapter.ts#L12).${extra}`,
    "<!-- ticket-steward:end -->",
  ].join("\n");

const expectedComment = (jobId: number): string =>
  `Enrichment added (job ${jobId}, confidence high). The adapter truncates the final chunk.\n@mention or assign me to re-run.`;

let repo: TmpRepo;
let stores: Stores;
let tracker: FakeTracker;
let port: number;

const makeConfig = (overrides: Partial<StewardConfig["workspace"]> = {}): StewardConfig => ({
  dataDir: repo.dataDir,
  brain: { kind: "claude-code", model: "claude-test", maxTurns: 5, timeoutMinutes: 1 },
  tracker: { kind: "linear", teams: ["API"] },
  codehost: { kind: "gitlab", baseUrl: "https://gitlab.example", project: "acme/repo" },
  workspace: {
    fetchUrl: repo.repo,
    baseBranch: "main",
    overlayDir: repo.overlayDir,
    setup: [],
    setupTimeoutMinutes: 1,
    port,
    keepOnFailure: true,
    ...overrides,
  },
  retention: { keptWorktrees: 3, days: 30 },
  prompt: repo.promptPath,
  server: { port: 3020, publicUrl: "https://steward.example" },
});

const makeDeps = (
  brain: FakeBrain,
  options: { config?: StewardConfig; tracker?: PipelineDeps["tracker"]; afterBrain?: () => Promise<void> | void; signal?: AbortSignal } = {},
): PipelineDeps => ({
  config: options.config ?? makeConfig(),
  secrets: { ANTHROPIC_API_KEY: "sk-ant-test-key-value" },
  configPath: join(repo.root, "steward.config.ts"),
  binPath: join(repo.root, "bin", "steward.js"),
  tracker: options.tracker ?? tracker,
  brain,
  codehost: new FakeCodeHost(),
  mirror: repo.mirror,
  stores,
  redactor: new Redactor([]),
  now: () => NOW,
  runBrain: async (_config, input: BrainInput): Promise<BrainRun> => {
    const run = await brain.run(input, () => undefined);
    await options.afterBrain?.();
    return run;
  },
  ...(options.signal === undefined ? {} : { signal: options.signal }),
});

/** The in-repo fake brain kind, run through the real detached runner (it only activates under NODE_ENV=test). */
const fakeBrainConfig = { kind: "fake", model: "fake", maxTurns: 1, timeoutMinutes: 1 } as unknown as BrainConfig;

const detachedDeps = (config: StewardConfig): PipelineDeps => {
  const { runBrain: _ignored, ...deps } = makeDeps(brainWith(), { config: { ...config, brain: fakeBrainConfig } });
  return {
    ...deps,
    runBrain: (brain, input, redactor, opts) => runBrainDetached(brain, { ...input, env: { ...input.env, NODE_ENV: "test" } }, redactor, opts),
  };
};

const claimJob = (trigger: TriggerEvent): RunContext => {
  const jobId = stores.jobs.enqueue(trigger);
  stores.jobs.claimById(jobId);
  stores.attempts.start(jobId);
  return { jobId, attempt: 1, issueId: trigger.issueId, identifier: trigger.identifier, teamKey: trigger.teamKey, trigger, dryRun: false };
};

const brainWith = (options: FakeBrainOptions = {}): FakeBrain => new FakeBrain({ result: brainResult, ...options });

describe("runJob", () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    repo = await tmpRepo(PROMPT_TEMPLATE);
    stores = openStores(repo.dataDir);
    tracker = new FakeTracker([issue]);
    port = await freeTcpPort();
  });

  afterEach(async () => {
    stores.db.close();
    await repo.cleanup();
  });

  it("writes the section between markers and posts a comment for issue.created", async () => {
    const ctx = claimJob(createdTrigger);

    const outcome = await runJob(ctx, makeDeps(brainWith()));

    expect(outcome).toEqual({ status: "succeeded" });
    expect(tracker.getDescription("issue-1")).toBe(`The adapter loses the final chunk.\n\n${expectedSection(repo.sha, ctx.jobId)}`);
    expect(tracker.comments("issue-1")).toEqual([expectedComment(ctx.jobId)]);
    expect(stores.jobs.get(ctx.jobId)?.result).toEqual(brainResult);
    expect(stores.jobs.get(ctx.jobId)?.resultSha).toBe(repo.sha);
  });

  it("emits thought and response activities instead of a comment for agent.session", async () => {
    const ctx = claimJob(sessionTrigger);

    const outcome = await runJob(ctx, makeDeps(brainWith()));

    expect(outcome).toEqual({ status: "succeeded" });
    expect(tracker.comments("issue-1")).toEqual([]);
    expect(tracker.sessionActivities("session-1")).toEqual([
      { type: "thought", body: `Investigating \`main@${repo.sha.slice(0, 7)}\`: reading the ticket and locating the relevant code.` },
      { type: "response", body: expectedComment(ctx.jobId) },
    ]);
    expect(tracker.getDescription("issue-1")).toBe(`The adapter loses the final chunk.\n\n${expectedSection(repo.sha, ctx.jobId)}`);
  });

  it("keeps a description edit made while the brain was running", async () => {
    const ctx = claimJob(createdTrigger);
    const deps = makeDeps(brainWith(), { afterBrain: () => tracker.setDescription("issue-1", "Edited during the run.") });

    await runJob(ctx, deps);

    expect(tracker.getDescription("issue-1")).toBe(`Edited during the run.\n\n${expectedSection(repo.sha, ctx.jobId)}`);
  });

  it("fails without retry and emits a session error when the brain output is invalid", async () => {
    const ctx = claimJob(sessionTrigger);

    const outcome = await runJob(ctx, makeDeps(brainWith({ result: { summary: "" } })));

    expect(outcome).toEqual({ status: "failed", error: expect.any(String), retryable: false });
    expect(tracker.getDescription("issue-1")).toBe("The adapter loses the final chunk.");
    expect(tracker.sessionActivities("session-1").length).toBe(2);
    expect(tracker.sessionActivities("session-1")[1]?.type).toBe("error");
    expect(stores.jobs.get(ctx.jobId)?.result).toBeNull();
  });

  it("fails without retry when the brain reports ok:false", async () => {
    const ctx = claimJob(createdTrigger);

    const outcome = await runJob(ctx, makeDeps(brainWith({ fail: true })));

    expect(outcome).toEqual({ status: "failed", error: expect.any(String), retryable: false });
    expect(tracker.comments("issue-1")).toEqual([]);
  });

  it("uploads an attachment the brain wrote and embeds it in the section", async () => {
    const ctx = claimJob(createdTrigger);
    const withShot: BrainResult = { ...brainResult, attachments: [{ file: "shot.png", caption: "Login page" }] };

    const outcome = await runJob(ctx, makeDeps(brainWith({ result: withShot, writeFiles: { "shot.png": "png-bytes" } })));

    expect(outcome).toEqual({ status: "succeeded" });
    expect(tracker.uploads()).toEqual([
      { path: join(repo.dataDir, "jobs", String(ctx.jobId), "artifacts", "shot.png"), contentType: "image/png" },
    ]);
    expect(tracker.getDescription("issue-1")).toBe(
      `The adapter loses the final chunk.\n\n${expectedSection(repo.sha, ctx.jobId, "\n\n![Login page](https://uploads.fake/shot.png)")}`,
    );
  });

  it("drops an attachment that escapes the artifacts dir and notes it in the section", async () => {
    const ctx = claimJob(createdTrigger);
    const jobDir = join(repo.dataDir, "jobs", String(ctx.jobId));
    await mkdir(jobDir, { recursive: true });
    await writeFile(join(jobDir, "evil.png"), "png-bytes");
    const escaping: BrainResult = { ...brainResult, attachments: [{ file: "../evil.png", caption: "Escape" }] };

    const outcome = await runJob(ctx, makeDeps(brainWith({ result: escaping })));

    expect(outcome).toEqual({ status: "succeeded" });
    expect(tracker.uploads()).toEqual([]);
    expect(tracker.getDescription("issue-1")).toBe(
      `The adapter loses the final chunk.\n\n${expectedSection(repo.sha, ctx.jobId, "\n\n_Note: Attachment `../evil.png` dropped: outside the artifacts directory._")}`,
    );
  });

  it("returns publish_failed when the description write fails, then publishOnly succeeds without the brain", async () => {
    const ctx = claimJob(createdTrigger);
    const brain = brainWith();
    tracker.failNextWrite();

    const first = await runJob(ctx, makeDeps(brain));

    expect(first).toEqual({ status: "publish_failed", error: expect.any(String) });
    expect(tracker.getDescription("issue-1")).toBe("The adapter loses the final chunk.");
    expect(stores.jobs.get(ctx.jobId)?.result).toEqual(brainResult);

    stores.jobs.finish(ctx.jobId, first);
    stores.jobs.claimById(ctx.jobId);
    stores.attempts.start(ctx.jobId);
    const second = await publishOnly({ ...ctx, attempt: 2 }, makeDeps(brain));

    expect(second).toEqual({ status: "succeeded" });
    expect(brain.runs).toBe(1);
    expect(tracker.getDescription("issue-1")).toBe(`The adapter loses the final chunk.\n\n${expectedSection(repo.sha, ctx.jobId)}`);
    expect(tracker.comments("issue-1")).toEqual([expectedComment(ctx.jobId)]);
  });

  it("records writes in dry-run and leaves the description and store untouched", async () => {
    const readOnly = new ReadOnlyTracker(tracker);
    const ctx: RunContext = { jobId: 0, attempt: 1, issueId: "issue-1", identifier: "API-1", teamKey: "API", trigger: createdTrigger, dryRun: true };

    const outcome = await runJob(ctx, makeDeps(brainWith(), { tracker: readOnly }));

    expect(outcome).toEqual({ status: "succeeded" });
    expect(readOnly.writes).toEqual([
      { method: "writeDescription", args: ["issue-1", `The adapter loses the final chunk.\n\n${expectedSection(repo.sha, 0)}`] },
      { method: "postComment", args: ["issue-1", expectedComment(0)] },
    ]);
    expect(tracker.getDescription("issue-1")).toBe("The adapter loses the final chunk.");
    expect(tracker.comments("issue-1")).toEqual([]);
    expect(stores.jobs.list({ limit: 10 })).toEqual([]);
  });

  it("removes the worktree after success", async () => {
    const ctx = claimJob(createdTrigger);

    await runJob(ctx, makeDeps(brainWith()));

    expect(existsSync(join(repo.dataDir, "work", `${ctx.jobId}-1`))).toBe(false);
  });

  it("keeps the worktree after a failure when keepOnFailure is set", async () => {
    const ctx = claimJob(createdTrigger);

    await runJob(ctx, makeDeps(brainWith({ fail: true })));

    expect(existsSync(join(repo.dataDir, "work", `${ctx.jobId}-1`))).toBe(true);
  });

  it("removes the worktree after a failure when keepOnFailure is off", async () => {
    const ctx = claimJob(createdTrigger);

    await runJob(ctx, makeDeps(brainWith({ fail: true }), { config: makeConfig({ keepOnFailure: false }) }));

    expect(existsSync(join(repo.dataDir, "work", `${ctx.jobId}-1`))).toBe(false);
  });

  it("classifies a setup failure as retryable", async () => {
    const ctx = claimJob(createdTrigger);

    const outcome = await runJob(ctx, makeDeps(brainWith(), { config: makeConfig({ setup: ["exit 1"] }) }));

    expect(outcome).toEqual({ status: "failed", error: expect.any(String), retryable: true });
    expect(stores.attempts.forJob(ctx.jobId)[0]?.setupTail).toBe("$ exit 1\n[exit 1]\n");
  });

  it("classifies a ticket fetch failure as retryable", async () => {
    const ctx = claimJob({ ...createdTrigger, issueId: "missing" });

    const outcome = await runJob(ctx, makeDeps(brainWith()));

    expect(outcome).toEqual({ status: "failed", error: expect.any(String), retryable: true });
  });

  it("renders the prompt with the ticket title and the operator instructions", async () => {
    const ctx = claimJob(sessionTrigger);
    const brain = brainWith();

    await runJob(ctx, makeDeps(brain));

    const input = brain.lastInput();
    expect(input.prompt).toContain("Adapter drops the last chunk");
    expect(input.prompt).toContain("Operator: Focus on the streaming adapter");
    expect(input.workspacePath).toBe(join(repo.dataDir, "work", `${ctx.jobId}-1`));
    expect(input.artifactsDir).toBe(join(repo.dataDir, "jobs", String(ctx.jobId), "artifacts"));
    expect(input.transcriptPath).toBe(join(repo.dataDir, "jobs", String(ctx.jobId), "attempt-1.jsonl"));
    expect(input.denyPaths).toEqual([repo.mirror.path, join(repo.dataDir, "steward.db"), repo.overlayDir, repo.root]);
    expect(Object.keys(input.mcpServers).sort()).toEqual(["codehost", "playwright"]);
    expect(input.env.ANTHROPIC_API_KEY).toBe("sk-ant-test-key-value");
    expect(input.env.STEWARD_PORT).toBe(String(port));
  });

  it("stores the pre-write description on the attempt without closing it", async () => {
    const ctx = claimJob(createdTrigger);

    await runJob(ctx, makeDeps(brainWith()));

    const [attempt] = stores.attempts.forJob(ctx.jobId);
    expect(attempt?.preWriteDescription).toBe("The adapter loses the final chunk.");
    expect(attempt?.transcriptPath).toBe(join(repo.dataDir, "jobs", String(ctx.jobId), "attempt-1.jsonl"));
    expect(attempt?.finishedAt).toBeNull();
  });

  it("returns publish_failed and still cleans up when the artifacts dir vanished after the brain ran", async () => {
    const ctx = claimJob(createdTrigger);
    const artifactsDir = join(repo.dataDir, "jobs", String(ctx.jobId), "artifacts");
    const deps = makeDeps(brainWith(), { config: makeConfig({ keepOnFailure: false }), afterBrain: () => rm(artifactsDir, { recursive: true, force: true }) });

    const outcome = await runJob(ctx, deps);

    expect(outcome).toEqual({ status: "publish_failed", error: expect.any(String) });
    expect(stores.jobs.get(ctx.jobId)?.result).toEqual(brainResult);
    expect(existsSync(join(repo.dataDir, "work", `${ctx.jobId}-1`))).toBe(false);
  });

  it("redacts the attachment drop note and the outcome error", async () => {
    const ctx = claimJob(createdTrigger);
    const escaping: BrainResult = { ...brainResult, attachments: [{ file: "../glpat-AbCdEfGhIjKlMnOpQrSt.png", caption: "Escape" }] };
    tracker.failNextWrite();
    const deps = { ...makeDeps(brainWith({ result: escaping })), redactor: new Redactor(["fake tracker write failure"]) };

    const outcome = await runJob(ctx, deps);

    expect(outcome).toEqual({ status: "publish_failed", error: "***" });
    stores.jobs.finish(ctx.jobId, outcome);
    stores.jobs.claimById(ctx.jobId);
    stores.attempts.start(ctx.jobId);

    await publishOnly({ ...ctx, attempt: 2 }, makeDeps(brainWith()));

    expect(tracker.getDescription("issue-1")).toBe(
      `The adapter loses the final chunk.\n\n${expectedSection(repo.sha, ctx.jobId, "\n\n_Note: Attachment `../***.png` dropped: file not found._")}`,
    );
  });

  it("stores and throws the redacted setup tail", async () => {
    const ctx = claimJob(createdTrigger);
    const deps = { ...makeDeps(brainWith(), { config: makeConfig({ setup: ["echo glpat-AbCdEfGhIjKlMnOpQrSt; exit 1"] }) }) };

    const outcome = await runJob(ctx, deps);

    expect(outcome).toEqual({ status: "failed", error: "setup failed:\n$ echo ***; exit 1\n***\n[exit 1]\n", retryable: true });
    expect(stores.attempts.forJob(ctx.jobId)[0]?.setupTail).toBe("$ echo ***; exit 1\n***\n[exit 1]\n");
  });

  it("classifies a setup that ran past the deadline as retryable with a timed-out tail", async () => {
    const ctx = claimJob(createdTrigger);
    const deps = makeDeps(brainWith(), { config: makeConfig({ setup: ["sleep 5"], setupTimeoutMinutes: 0.005 }) });

    const outcome = await runJob(ctx, deps);

    expect(outcome).toEqual({ status: "failed", error: expect.any(String), retryable: true });
    expect(stores.attempts.forJob(ctx.jobId)[0]?.setupTail).toBe("$ sleep 5\n[timed out]\n");
  });

  it("reports an interrupted run when the signal aborts during setup", async () => {
    const ctx = claimJob(createdTrigger);
    const controller = new AbortController();
    const deps = makeDeps(brainWith(), { config: makeConfig({ setup: ["sleep 5"] }), signal: controller.signal });

    const running = runJob(ctx, deps);
    controller.abort();
    const outcome = await running;

    expect(outcome).toEqual({ status: "failed", error: INTERRUPTED_ERROR, retryable: true });
    expect(stores.attempts.forJob(ctx.jobId)[0]?.setupTail).toBe("$ sleep 5\n[interrupted]\n");
    expect(tracker.sessionActivities("session-1")).toEqual([]);
  });

  it("uses a per-process worktree name for dry runs", async () => {
    const ctx: RunContext = { jobId: 0, attempt: 1, issueId: "issue-1", identifier: "API-1", teamKey: "API", trigger: createdTrigger, dryRun: true };
    const brain = brainWith();

    await runJob(ctx, makeDeps(brain, { tracker: new ReadOnlyTracker(tracker) }));

    expect(brain.lastInput().workspacePath).toBe(join(repo.dataDir, "work", `dry-${process.pid}`));
  });

  it("runs the brain detached, kills its process group and frees the port afterwards", async () => {
    const ctx = claimJob(createdTrigger);
    const listener = `node -e "require('net').createServer().listen(process.env.PORT)" >/dev/null 2>&1 &`;
    const deps = detachedDeps(makeConfig({ setup: [listener], keepOnFailure: false }));

    const outcome = await runJob(ctx, deps);

    expect(outcome).toEqual({ status: "failed", error: expect.any(String), retryable: false });
    expect(await isPortFree(port)).toBe(true);
    const transcript = await readFile(join(repo.dataDir, "jobs", String(ctx.jobId), "attempt-1.jsonl"), "utf8");
    const pids = JSON.parse(transcript.split("\n")[1] ?? "") as FakeBrainPids;
    expect(pids.type).toBe("fake-pids");
    expect(() => process.kill(pids.runnerPid, 0)).toThrow();
    expect(() => process.kill(pids.sleepPid ?? -1, 0)).toThrow();
    expect(existsSync(join(repo.dataDir, "work", `${ctx.jobId}-1`))).toBe(false);
  });
});
