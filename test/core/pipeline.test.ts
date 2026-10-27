import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { INTERRUPTED_ERROR, runBrainDetached } from "../../src/brain/index.js";
import type { FakeBrainPids } from "../../src/brain/fake.js";
import type { BrainInput, BrainRun } from "../../src/brain/types.js";
import type { BrainConfig, StewardConfig } from "../../src/config/schema.js";
import { runJob, publishOnly, type PipelineDeps } from "../../src/core/pipeline.js";
import { Redactor } from "../../src/core/redact.js";
import type { BrainResult } from "../../src/core/result.js";
import type { RunContext } from "../../src/core/types.js";
import { openStores, type Stores } from "../../src/store/index.js";
import { ReadOnlyTracker } from "../../src/tracker/readOnly.js";
import type { TriggerEvent, TicketBundle } from "../../src/tracker/types.js";
import { isPortFree } from "../../src/workspace/retention.js";
import { SlotClient } from "../../src/workspace/slots.js";
import { fakeSlotRunner, type FakeSlotRunner } from "../fakes/fakeSlotRunner.js";
import { FakeBrain, type FakeBrainOptions } from "../fakes/fakeBrain.js";
import { FakeCodeHost } from "../fakes/fakeCodeHost.js";
import { FakeTracker } from "../fakes/fakeTracker.js";
import { freeTcpPort, tmpRepo, type TmpRepo } from "../fakes/tmpRepo.js";

const PROMPT_TEMPLATE = "Ticket:\n{{ticket}}\n\nWorkspace: {{workspacePath}} @ {{sha}}\n";
const DEFAULT_PROMPT_PATH = fileURLToPath(new URL("../../prompts/enrich.md", import.meta.url));
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
  stateType: "triage",
};

const brainResult: BrainResult = {
  template: { matched: "Bugs", conforms: false, missing: ["Repro Steps"] },
  summary: "The adapter truncates the final chunk.",
  enrichment: "See `src/adapter.ts:12`.",
  attachments: [],
  confidence: "high",
  repro: null,
  triage: { state: "ready-for-human", questions: [], agentBrief: "Goal: keep the last chunk." },
};

const expectedSection = (sha: string, jobId: number, extra = ""): string =>
  [
    "<!-- ticket-steward:begin -->",
    "## Enrichment",
    `_Ticket Steward · 2026-09-11 14:02 UTC · main@${sha.slice(0, 7)} · confidence: high · job ${jobId}_`,
    "",
    "**Template:** Bugs — missing: Repro Steps",
    "",
    `See [src/adapter.ts:12](https://fake.example/blob/${sha}/src/adapter.ts#L12).`,
    "",
    "### Agent brief",
    "<!-- ticket-steward:brief:begin -->",
    "Goal: keep the last chunk.",
    `<!-- ticket-steward:brief:end -->${extra}`,
    "<!-- ticket-steward:end -->",
  ].join("\n");

const expectedComment = (jobId: number): string =>
  `Triage (job ${jobId}, confidence high): ready to build; the agent brief is in the Enrichment section. The adapter truncates the final chunk.`;

const LABELS = { triage: "needs-triage", implement: "ready-for-agent", needsInfo: "needs-info", readyForHuman: "ready-for-human", implemented: "agent-implemented", approved: "agent-approved" };
const withLabels = (config: StewardConfig): StewardConfig => ({ ...config, tracker: { ...config.tracker, labels: LABELS } });

let repo: TmpRepo;
let stores: Stores;
let tracker: FakeTracker;
let port: number;

const makeConfig = (overrides: Partial<StewardConfig["workspace"]> = {}): StewardConfig => ({
  dataDir: repo.dataDir,
  brain: { kind: "claude-code", model: "claude-test", maxTurns: 5, timeoutMinutes: 1 },
  tracker: { kind: "linear", teams: ["API"], gatewayIssues: "enrich", bugLabels: ["Bug"] },
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

const detachedDeps = (config: StewardConfig): PipelineDeps => ({
  ...makeDeps(brainWith(), { config: { ...config, brain: fakeBrainConfig } }),
  runBrain: (brain, input, redactor, opts) => runBrainDetached(brain, { ...input, env: { ...input.env, NODE_ENV: "test" } }, redactor, opts),
});

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

  it("swaps needs-triage for ready-for-human last when triggered by the triage label", async () => {
    tracker.addIssue({ ...issue, labels: ["bug", "needs-triage"] });
    const ctx = claimJob({ ...createdTrigger, action: "triage" });

    const outcome = await runJob(ctx, makeDeps(brainWith(), { config: withLabels(makeConfig()) }));

    expect(outcome).toEqual({ status: "succeeded" });
    expect(tracker.labelSwaps()).toEqual([{ issueId: "issue-1", from: "needs-triage", to: "ready-for-human" }]);
    expect(tracker.labelsOf("issue-1")).toEqual(["bug", "ready-for-human"]);
  });

  it("swaps to needs-info for a needs-info verdict", async () => {
    tracker.addIssue({ ...issue, labels: ["needs-triage"] });
    const ctx = claimJob({ ...createdTrigger, action: "triage" });
    const brain = brainWith({ result: { ...brainResult, triage: { state: "needs-info", questions: ["Which page?"], agentBrief: null } } });

    await runJob(ctx, makeDeps(brain, { config: withLabels(makeConfig()) }));

    expect(tracker.labelsOf("issue-1")).toEqual(["needs-info"]);
  });

  it("leaves labels alone for a job without the triage action", async () => {
    const ctx = claimJob(createdTrigger);
    await runJob(ctx, makeDeps(brainWith(), { config: withLabels(makeConfig()) }));
    expect(tracker.labelSwaps()).toEqual([]);
  });

  it("keeps needs-triage and reports publish_failed when the label swap fails", async () => {
    tracker.addIssue({ ...issue, labels: ["needs-triage"] });
    const ctx = claimJob({ ...createdTrigger, action: "triage" });
    tracker.failNextSwap();
    const outcome = await runJob(ctx, makeDeps(brainWith(), { config: withLabels(makeConfig()) }));

    expect(outcome).toEqual({ status: "publish_failed", error: "labels: Linear down" });
    expect(tracker.labelsOf("issue-1")).toEqual(["needs-triage"]);
  });

  it("does not post the triage comment twice when a label-swap failure is retried", async () => {
    tracker.addIssue({ ...issue, labels: ["needs-triage"] });
    const ctx = claimJob({ ...createdTrigger, action: "triage" });
    const brain = brainWith();
    tracker.failNextSwap();
    const first = await runJob(ctx, makeDeps(brain, { config: withLabels(makeConfig()) }));
    expect(first).toEqual({ status: "publish_failed", error: "labels: Linear down" });
    expect(tracker.comments("issue-1")).toHaveLength(1);

    stores.jobs.finish(ctx.jobId, first);
    stores.jobs.claimById(ctx.jobId);
    stores.attempts.start(ctx.jobId);
    const second = await publishOnly({ ...ctx, attempt: 2 }, makeDeps(brain, { config: withLabels(makeConfig()) }));

    expect(second).toEqual({ status: "succeeded" });
    expect(tracker.comments("issue-1")).toHaveLength(1);
    expect(tracker.labelsOf("issue-1")).not.toContain("needs-triage");
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

  it.each([
    ["completed", "Done"],
    ["canceled", "Canceled"],
  ])("fails without retry and never runs the brain for a %s ticket", async (type, name) => {
    tracker.addIssue({ ...issue, state: { name, type } });
    const brain = brainWith();
    const ctx = claimJob(createdTrigger);

    const outcome = await runJob(ctx, makeDeps(brain));

    expect(outcome).toEqual({ status: "failed", error: `API-1 is ${name}; Ticket Steward does not enrich Done or Canceled tickets`, retryable: false });
    expect(brain.runs).toBe(0);
    expect(tracker.getDescription("issue-1")).toBe(issue.description);
    expect(tracker.comments("issue-1")).toEqual([]);
  });

  it("writes nothing when the ticket is closed while the brain runs", async () => {
    const ctx = claimJob(createdTrigger);

    const outcome = await runJob(ctx, makeDeps(brainWith(), { afterBrain: () => tracker.addIssue({ ...issue, state: { name: "Done", type: "completed" } }) }));

    expect(outcome).toEqual({ status: "failed", error: "API-1 is Done; Ticket Steward does not enrich Done or Canceled tickets", retryable: false });
    expect(tracker.getDescription("issue-1")).toBe(issue.description);
    expect(tracker.comments("issue-1")).toEqual([]);
  });

  it("stores the recipe for a bug ticket", async () => {
    const recipe = { status: "reproduced" as const, method: "http" as const, command: "curl -s localhost:4100/x", steps: [], files: [], expected: "200", observed: "500" };
    const ctx = claimJob(createdTrigger);
    const outcome = await runJob(ctx, makeDeps(brainWith({ result: { ...brainResult, repro: recipe } })));
    expect(outcome.status).toBe("succeeded");
    expect(stores.jobs.get(ctx.jobId)?.result?.repro).toEqual(recipe);
  });

  it("renders the recipe into the Enrichment section and keeps no copy of its files", async () => {
    const recipe = { status: "reproduced" as const, method: "test" as const, command: "node repro.mjs", steps: [], files: ["repro.mjs"], expected: "ok", observed: "boom" };
    const ctx = claimJob(createdTrigger);
    const brain = brainWith({ result: { ...brainResult, repro: recipe } });
    const deps = makeDeps(brain, {
      afterBrain: async () => {
        await writeFile(join(brain.lastInput().workspacePath, "repro.mjs"), "throw new Error('boom');\n");
      },
    });
    expect((await runJob(ctx, deps)).status).toBe("succeeded");
    expect(stores.jobs.get(ctx.jobId)?.result?.repro).toEqual(recipe);
    expect(tracker.getDescription("issue-1")).toContain("### Reproduction");
    expect(tracker.getDescription("issue-1")).toContain("`repro.mjs`");
    expect(existsSync(join(repo.dataDir, "repros"))).toBe(false);
  });

  it("drops the recipe for a ticket without a bug label", async () => {
    tracker.addIssue({ ...issue, labels: ["Feature"] });
    const recipe = { status: "reproduced" as const, method: "http" as const, command: "curl -s localhost:4100/x", steps: [], files: [], expected: "200", observed: "500" };
    const ctx = claimJob(createdTrigger);
    await runJob(ctx, makeDeps(brainWith({ result: { ...brainResult, repro: recipe } })));
    expect(stores.jobs.get(ctx.jobId)?.result?.repro).toBeNull();
  });

  it("keeps a description edit made while the brain was running", async () => {
    const ctx = claimJob(createdTrigger);
    const deps = makeDeps(brainWith(), { afterBrain: () => tracker.setDescription("issue-1", "Edited during the run.") });

    await runJob(ctx, deps);

    expect(tracker.getDescription("issue-1")).toBe(`Edited during the run.\n\n${expectedSection(repo.sha, ctx.jobId)}`);
  });

  it("fails without retry and writes nothing when the brain output is invalid", async () => {
    const ctx = claimJob(createdTrigger);

    const outcome = await runJob(ctx, makeDeps(brainWith({ result: { summary: "" } })));

    expect(outcome).toEqual({ status: "failed", error: expect.any(String), retryable: false });
    expect(tracker.getDescription("issue-1")).toBe("The adapter loses the final chunk.");
    expect(tracker.comments("issue-1")).toEqual([]);
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

  it("redacts secrets from the agent brief and the triage comment", async () => {
    const secret = "sk-ant-brief-secret-value";
    const ready = brainWith({ result: { ...brainResult, triage: { state: "ready-for-human", questions: [], agentBrief: `Goal: use ${secret}.` } } });
    const ctx = claimJob(createdTrigger);
    await runJob(ctx, { ...makeDeps(ready), redactor: new Redactor([secret]) });
    expect(tracker.getDescription("issue-1")).not.toContain(secret);

    tracker.addIssue({ ...issue, id: "issue-2", identifier: "ENG-2" });
    const asking = brainWith({ result: { ...brainResult, triage: { state: "needs-info", questions: [`Is ${secret} right?`], agentBrief: null } } });
    const ctx2 = claimJob({ ...createdTrigger, issueId: "issue-2", identifier: "ENG-2" });
    await runJob(ctx2, { ...makeDeps(asking), redactor: new Redactor([secret]) });
    expect(tracker.comments("issue-2").join("\n")).not.toContain(secret);
    expect(tracker.comments("issue-2").join("\n")).toContain("1. Is ");
  });

  it("re-swaps the label on publishOnly after a failed swap", async () => {
    tracker.addIssue({ ...issue, labels: ["needs-triage"] });
    const ctx = claimJob({ ...createdTrigger, action: "triage" });
    const brain = brainWith();
    tracker.failNextSwap();
    const first = await runJob(ctx, makeDeps(brain, { config: withLabels(makeConfig()) }));
    expect(first.status).toBe("publish_failed");

    stores.jobs.finish(ctx.jobId, first);
    stores.jobs.claimById(ctx.jobId);
    stores.attempts.start(ctx.jobId);
    const second = await publishOnly({ ...ctx, attempt: 2 }, makeDeps(brain, { config: withLabels(makeConfig()) }));

    expect(second).toEqual({ status: "succeeded" });
    expect(brain.runs).toBe(1);
    expect(tracker.labelsOf("issue-1")).toEqual(["ready-for-human"]);
  });

  it("keeps needs-triage and reports publish_failed when the triage comment fails, then publishOnly swaps", async () => {
    tracker.addIssue({ ...issue, labels: ["needs-triage"] });
    const ctx = claimJob({ ...createdTrigger, action: "triage" });
    const brain = brainWith({ result: { ...brainResult, triage: { state: "needs-info", questions: ["Which page?"], agentBrief: null } } });
    vi.spyOn(tracker, "postComment").mockRejectedValueOnce(new Error("comment down"));

    const first = await runJob(ctx, makeDeps(brain, { config: withLabels(makeConfig()) }));

    expect(first).toEqual({ status: "publish_failed", error: "comment: comment down" });
    expect(tracker.labelSwaps()).toEqual([]);
    expect(tracker.labelsOf("issue-1")).toEqual(["needs-triage"]);

    stores.jobs.finish(ctx.jobId, first);
    stores.jobs.claimById(ctx.jobId);
    stores.attempts.start(ctx.jobId);
    const second = await publishOnly({ ...ctx, attempt: 2 }, makeDeps(brain, { config: withLabels(makeConfig()) }));

    expect(second).toEqual({ status: "succeeded" });
    expect(tracker.comments("issue-1")[0]).toContain("1. Which page?");
    expect(tracker.labelsOf("issue-1")).toEqual(["needs-info"]);
  });

  it("still succeeds with a warning when the comment fails on a job that swaps no labels", async () => {
    const ctx = claimJob(createdTrigger);
    vi.spyOn(tracker, "postComment").mockRejectedValueOnce(new Error("comment down"));

    const outcome = await runJob(ctx, makeDeps(brainWith(), { config: withLabels(makeConfig()) }));

    expect(outcome).toEqual({ status: "succeeded", warning: "comment down" });
    expect(tracker.labelSwaps()).toEqual([]);
  });

  it("re-publishes a stored result from before triage existed: no brief, the old comment, no label swap", async () => {
    tracker.addIssue({ ...issue, labels: ["needs-triage"] });
    const ctx = claimJob({ ...createdTrigger, action: "triage" });
    const legacy: Record<string, unknown> = { ...brainResult };
    delete legacy.triage;
    stores.db.prepare("UPDATE jobs SET status = 'publish_failed', result = ?, result_sha = ? WHERE id = ?").run(JSON.stringify(legacy), repo.sha, ctx.jobId);
    stores.jobs.claimById(ctx.jobId);
    stores.attempts.start(ctx.jobId);

    const outcome = await publishOnly({ ...ctx, attempt: 2 }, makeDeps(brainWith(), { config: withLabels(makeConfig()) }));

    expect(outcome).toEqual({ status: "succeeded" });
    expect(stores.jobs.get(ctx.jobId)?.result?.triage).toBeNull();
    const description = tracker.getDescription("issue-1");
    expect(description).toContain("## Enrichment");
    expect(description).not.toContain("Agent brief");
    expect(tracker.comments("issue-1")).toEqual([`Enrichment added (job ${ctx.jobId}, confidence high). The adapter truncates the final chunk.`]);
    expect(tracker.labelSwaps()).toEqual([]);
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

  it("renders the prompt with the ticket title", async () => {
    const ctx = claimJob(createdTrigger);
    const brain = brainWith();

    await runJob(ctx, makeDeps(brain));

    const input = brain.lastInput();
    expect(input.prompt).toContain("Adapter drops the last chunk");
    expect(input.workspacePath).toBe(join(repo.dataDir, "work", `${ctx.jobId}-1`));
    expect(input.artifactsDir).toBe(join(repo.dataDir, "jobs", String(ctx.jobId), "artifacts"));
    expect(input.transcriptPath).toBe(join(repo.dataDir, "jobs", String(ctx.jobId), "attempt-1.jsonl"));
    expect(input.denyPaths).toEqual([repo.mirror.path, join(repo.dataDir, "steward.db"), repo.overlayDir, repo.root]);
    expect(Object.keys(input.mcpServers).sort()).toEqual(["codehost", "playwright"]);
    expect(input.mcpServers.playwright?.args.slice(-2)).toEqual(["--console-level", "warning"]);
    expect(input.inlineSkills).toEqual([]);
    expect(input.env.ANTHROPIC_API_KEY).toBe("sk-ant-test-key-value");
    expect(input.env.STEWARD_PORT).toBe(String(port));
  });

  it("tells the brain about a ticket-gateway ticket and its routing", async () => {
    const gatewayIssue: TicketBundle = {
      ...issue,
      description: "The adapter loses the final chunk.\n\n---\n\n_Routed by ticket-gateway · class `billing` (p=0.91, margin 0.40, auto) → PLAT · reported by Ana via Slack /ticket_",
    };
    tracker = new FakeTracker([gatewayIssue]);
    const ctx = claimJob(createdTrigger);
    const brain = brainWith();

    await runJob(ctx, makeDeps(brain, { config: { ...makeConfig(), prompt: DEFAULT_PROMPT_PATH } }));

    expect(brain.lastInput().prompt).toContain("routed it as class `billing` to team PLAT");
  });

  it("leaves the gateway block out of the prompt for an ordinary ticket", async () => {
    const ctx = claimJob(createdTrigger);
    const brain = brainWith();

    await runJob(ctx, makeDeps(brain, { config: { ...makeConfig(), prompt: DEFAULT_PROMPT_PATH } }));

    expect(brain.lastInput().prompt).not.toContain("ticket-gateway");
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
    expect(tracker.comments("issue-1")).toEqual([]);
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

describe("runJob on a slot", () => {
  const OVERLAY_ENV = "DB_PORT=5432\nREDIS_CLUSTER_NODES=10.2.0.51:7000\nBASE_URL=http://localhost:3000\n";
  let appPortBase: number;
  let runner: FakeSlotRunner;

  beforeEach(async () => {
    vi.restoreAllMocks();
    repo = await tmpRepo(PROMPT_TEMPLATE);
    stores = openStores(repo.dataDir);
    tracker = new FakeTracker([issue]);
    port = await freeTcpPort();
    // Slot 2's app port is appPortBase + 2: a port nothing listens on, so freePort never kills anything.
    appPortBase = (await freeTcpPort()) - 2;
    runner = fakeSlotRunner();
    await mkdir(join(repo.overlayDir, "e2e", "user"), { recursive: true });
    await writeFile(join(repo.overlayDir, "e2e", "user", ".env"), OVERLAY_ENV);
  });

  afterEach(async () => {
    stores.db.close();
    await repo.cleanup();
  });

  const slotsFor = (env: Record<string, string | null>) => ({ count: 2, socket: "/run/steward-slot.sock", appPortBase, upTimeoutSeconds: 180, env });

  const slotConfig = (env: Record<string, string | null>): StewardConfig => ({
    ...makeConfig({ port: undefined, portRewrite: { from: 3000 } }),
    slots: slotsFor(env),
  });

  const slotDeps = (brain: FakeBrain, env: Record<string, string | null>, options: { afterBrain?: () => Promise<void>; signal?: AbortSignal } = {}): PipelineDeps => ({
    ...makeDeps(brain, { config: slotConfig(env), ...options }),
    slot: { n: 2, client: new SlotClient(slotsFor(env), runner.run) },
  });

  it("brings the slot up fresh, points the job's overlay copy at it and brings it down afterwards", async () => {
    const ctx = claimJob(createdTrigger);
    const brain = brainWith();
    let copied = "";
    const deps = slotDeps(brain, { DB_PORT: "{{postgres}}", REDIS_CLUSTER_NODES: null }, {
      afterBrain: async () => {
        copied = await readFile(join(repo.dataDir, "work", `${ctx.jobId}-1`, "e2e", "user", ".env"), "utf8");
      },
    });

    expect(await runJob(ctx, deps)).toEqual({ status: "succeeded" });

    expect(runner.calls).toEqual([["down", "2"], ["up", "2"], ["ports", "2"], ["down", "2"]]);
    expect(copied).toBe(`DB_PORT=15232\nBASE_URL=http://localhost:${appPortBase + 2}\n`);
    expect(brain.lastInput().env.STEWARD_PORT).toBe(String(appPortBase + 2));
    expect(await readFile(join(repo.overlayDir, "e2e", "user", ".env"), "utf8")).toBe(OVERLAY_ENV);
  });

  it("fails retryably with the helper's tail when the slot does not come up, and still brings it down", async () => {
    const ctx = claimJob(createdTrigger);
    runner.respond("up", { exitCode: 1, output: "Error response from daemon: port is already allocated\n" });

    const outcome = await runJob(ctx, slotDeps(brainWith(), {}));

    expect(outcome).toEqual({ status: "failed", error: "setup failed: slot 2: Error response from daemon: port is already allocated\n[exit 1]", retryable: true });
    expect(stores.attempts.forJob(ctx.jobId)[0]?.setupTail).toBe("Error response from daemon: port is already allocated\n[exit 1]");
    expect(runner.calls).toEqual([["down", "2"], ["up", "2"], ["down", "2"]]);
  });

  it("fails without a retry when an override key is in no overlay file, naming only the key", async () => {
    const ctx = claimJob(createdTrigger);

    const outcome = await runJob(ctx, slotDeps(brainWith(), { DB_PORT: "{{postgres}}", MISSING_KEY: "hunter2-value" }));

    expect(outcome).toEqual({ status: "failed", error: "slot override keys not found in the overlay: MISSING_KEY", retryable: false });
    expect(runner.calls.at(-1)).toEqual(["down", "2"]);
  });

  it("reports an interrupted run when shutdown aborts a slot that is still coming up", async () => {
    const ctx = claimJob(createdTrigger);
    runner.hang("up");
    const controller = new AbortController();

    const running = runJob(ctx, slotDeps(brainWith(), {}, { signal: controller.signal }));
    await vi.waitFor(() => expect(runner.calls).toContainEqual(["up", "2"]));
    controller.abort();

    expect(await running).toEqual({ status: "failed", error: INTERRUPTED_ERROR, retryable: true });
    expect(runner.calls.at(-1)).toEqual(["down", "2"]);
  });

  it("refuses to run without a slot when slots is configured", async () => {
    const ctx = claimJob(createdTrigger);

    const outcome = await runJob(ctx, makeDeps(brainWith(), { config: slotConfig({}) }));

    expect(outcome).toEqual({ status: "failed", error: "slots is configured but this run has no slot", retryable: true });
    expect(runner.calls).toEqual([]);
  });
});
