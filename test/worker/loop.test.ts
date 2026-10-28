import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Mock } from "vitest";
import { INTERRUPTED_ERROR } from "../../src/brain/index.js";
import type { StewardConfig } from "../../src/config/schema.js";
import { acquireRunLock } from "../../src/core/lock.js";
import type { PipelineDeps } from "../../src/core/deps.js";
import { Redactor } from "../../src/core/redact.js";
import type { JobOutcome, RunContext } from "../../src/core/types.js";
import { openStores, type Stores } from "../../src/store/index.js";
import type { TicketBundle, TriggerEvent } from "../../src/tracker/types.js";
import { Mirror } from "../../src/workspace/mirror.js";
import { SlotClient } from "../../src/workspace/slots.js";
import type { publishImplementOnly, runImplement } from "../../src/implement/pipeline.js";
import { startWorker, type WorkerDeps, type WorkerHandle } from "../../src/worker/loop.js";
import type { ResourceSample } from "../../src/worker/resources.js";
import { FakeBrain } from "../fakes/fakeBrain.js";
import { FakeCodeHost } from "../fakes/fakeCodeHost.js";
import { FakeGitLabMr } from "../fakes/fakeGitLabMr.js";
import { fakeSlotRunner, type FakeSlotRunner } from "../fakes/fakeSlotRunner.js";
import { FakeTracker } from "../fakes/fakeTracker.js";

const NOW = new Date("2026-09-11T14:02:30.000Z");
const SUCCEEDED: JobOutcome = { status: "succeeded" };
const RETRYABLE: JobOutcome = { status: "failed", error: "mirror fetch failed", retryable: true };
const INTERRUPTED: JobOutcome = { status: "failed", error: INTERRUPTED_ERROR, retryable: true };

const createdTrigger: TriggerEvent = {
  kind: "issue.created",
  issueId: "issue-1",
  identifier: "API-1",
  teamKey: "API",
  deliveryId: "delivery-1",
  description: "The adapter loses the final chunk.",
  stateType: null,
  action: "implement",
};

const LABELS = { implement: "ready-for-agent", needsInfo: "needs-info", readyForHuman: "ready-for-human", implemented: "agent-implemented", approved: "agent-approved" };

let dataDir: string;
let stores: Stores;
let tracker: FakeTracker;
let gitlab: FakeGitLabMr;
let runImplementMock: Mock<typeof runImplement>;
let publishImplementOnlyMock: Mock<typeof publishImplementOnly>;
let worker: WorkerHandle | null;

const makeConfig = (): StewardConfig => ({
  dataDir,
  brain: { kind: "claude-code", model: "claude-test", maxTurns: 5, timeoutMinutes: 1 },
  tracker: { kind: "linear", teams: ["API"], labels: LABELS },
  codehost: { kind: "gitlab", baseUrl: "https://gitlab.example", project: "acme/repo" },
  workspace: {
    fetchUrl: "https://gitlab.example/acme/repo.git",
    baseBranch: "dev",
    overlayDir: join(dataDir, "overlay"),
    setup: [],
    setupTimeoutMinutes: 1,
    port: 4100,
    keepOnFailure: true,
  },
  retention: { keptWorktrees: 3, days: 30 },
  server: { port: 3020, publicUrl: "https://steward.example" },
  resourceGuard: { enabled: false, minAvailableMemoryMb: 4096, maxLoadPerCpu: 1.5, startSpacingSeconds: 30 },
});

const AMPLE: ResourceSample = { availableMemoryMb: 64_000, loadPerCpu: 0.1 };

const makeDeps = (overrides: Partial<WorkerDeps> = {}): WorkerDeps => ({
  config: makeConfig(),
  secrets: { ANTHROPIC_API_KEY: "sk-ant-test-key-value" },
  configPath: join(dataDir, "steward.config.ts"),
  binPath: join(dataDir, "bin", "steward.js"),
  tracker,
  brain: new FakeBrain({ result: {} }),
  codehost: new FakeCodeHost(),
  gitlab,
  mirror: new Mirror(join(dataDir, "repo.git"), "https://gitlab.example/acme/repo.git"),
  stores,
  redactor: new Redactor([]),
  now: () => NOW,
  runImplement: runImplementMock,
  publishImplementOnly: publishImplementOnlyMock,
  pollMs: 5,
  backoffMs: [5, 5],
  resources: () => AMPLE,
  ...overrides,
});

const start = (overrides: Partial<WorkerDeps> = {}): WorkerHandle => {
  worker = startWorker(makeDeps(overrides));
  return worker;
};

const waitForStatus = (jobId: number, status: string): Promise<void> =>
  vi.waitFor(() => {
    expect(stores.jobs.get(jobId)?.status).toBe(status);
  });

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const SLOTS = { count: 2, socket: "/run/steward-slot.sock", appPortBase: 4100, upTimeoutSeconds: 180, env: {} };

const slotConfig = (count = 2): StewardConfig => {
  const base = makeConfig();
  return { ...base, workspace: { ...base.workspace, port: undefined }, slots: { ...SLOTS, count } };
};

const onSlots = (runner: FakeSlotRunner, config: StewardConfig = slotConfig()): Partial<WorkerDeps> => ({
  config,
  slot: { n: 1, client: new SlotClient(SLOTS, runner.run) },
});

/** A runImplement that holds each job until `release(jobId)`, or answers INTERRUPTED when the worker aborts. */
const heldRuns = () => {
  const releases = new Map<number, (outcome: JobOutcome) => void>();
  const slots = new Map<number, number | undefined>();
  const impl = (ctx: RunContext, deps: PipelineDeps): Promise<JobOutcome> =>
    new Promise<JobOutcome>((resolve) => {
      releases.set(ctx.jobId, resolve);
      slots.set(ctx.jobId, deps.slot?.n);
      deps.signal?.addEventListener("abort", () => resolve(INTERRUPTED), { once: true });
    });
  return { impl, slots, release: (jobId: number) => releases.get(jobId)?.(SUCCEEDED) };
};

const ticket: TicketBundle = {
  id: "issue-1",
  identifier: "API-1",
  url: "https://linear.app/acme/issue/API-1",
  title: "Adapter drops the last chunk",
  description: "The adapter loses the final chunk.",
  team: { id: "team-1", key: "API", name: "API" },
  state: { name: "In Review", type: "started" },
  labels: [],
  priority: 2,
  creator: { name: "Ada", isBot: false },
  createdAt: "2026-09-11T00:00:00.000Z",
  comments: [],
  attachments: [],
  appliedTemplate: null,
  templates: [],
};

/** A fix loop for issue-1 in `state`, as its await or fix step would leave it. */
const runningLoop = (state: "awaiting_review" | "fixing"): number => {
  const implementId = stores.jobs.enqueue({ kind: "cli", issueId: "issue-1", identifier: "API-1", teamKey: "API", action: "implement" });
  stores.jobs.claimById(implementId);
  stores.jobs.finish(implementId, SUCCEEDED);
  const id = stores.loops.create({
    issueId: "issue-1", identifier: "API-1", teamKey: "API", implementJobId: implementId, branch: "fix/API-1-chunk",
    baseSha: "a".repeat(40), headSha: "b".repeat(40), worktreeName: "ticket-API-1", labelDriven: false, sessionId: "session-1",
  });
  stores.loops.update(id, { state, projectId: 42, mrIid: 7, mrUrl: "https://gitlab.example/acme/repo/-/merge_requests/7" });
  return id;
};

const loopStep = (loopId: number, step: "await" | "fix"): TriggerEvent => ({ kind: "loop", issueId: "issue-1", identifier: "API-1", teamKey: "API", loopId, step });

const issue2 = { ...createdTrigger, issueId: "issue-2", identifier: "API-2", deliveryId: "delivery-9" };

/** The helper serves slots 1-20; down covers all of them so slots the agent brought up itself are cleaned too. */
const ALL_SLOTS_DOWN = Array.from({ length: 20 }, (_, i) => ["down", String(i + 1)]);

describe("startWorker", () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    dataDir = await mkdtemp(join(tmpdir(), "steward-worker-"));
    stores = openStores(dataDir);
    tracker = new FakeTracker();
    gitlab = new FakeGitLabMr();
    runImplementMock = vi.fn<typeof runImplement>().mockResolvedValue(SUCCEEDED);
    publishImplementOnlyMock = vi.fn<typeof publishImplementOnly>().mockResolvedValue(SUCCEEDED);
    worker = null;
  });

  afterEach(async () => {
    await worker?.stop();
    stores.db.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  it("fails a queued enrich job left from before enrich was removed, before claiming anything", async () => {
    const insert = stores.db.prepare(
      "INSERT INTO jobs (issue_id, identifier, team_key, trigger, status, created_at, kind) VALUES ('issue-1', 'API-1', 'API', ?, 'queued', ?, 'enrich')",
    );
    const retired = Number(insert.run(JSON.stringify({ ...createdTrigger, action: undefined }), new Date().toISOString()).lastInsertRowid);
    const jobId = stores.jobs.enqueue(createdTrigger);
    start();

    await waitForStatus(jobId, "succeeded");

    expect(stores.jobs.get(retired)).toMatchObject({ status: "failed", error: "enrich was removed; this job will not run", attempts: 0 });
    expect(stores.attempts.forJob(retired)).toEqual([]);
    expect(runImplementMock).toHaveBeenCalledTimes(1);
  });

  it("dispatches an implement job with a saved result to publishImplementOnly, not runImplement", async () => {
    const runImplement = vi.fn(async () => ({ status: "succeeded" }) as const);
    const publishImplementOnly = vi.fn(async () => ({ status: "succeeded" }) as const);
    const jobId = stores.jobs.enqueue(createdTrigger);
    stores.jobs.saveImplementResult(jobId, { result: null, handback: { label: "readyForHuman", reason: "a branch for API-1 already exists", detail: "feature/API-1-x" } });
    const handle = start({ runImplement, publishImplementOnly });
    await waitForStatus(jobId, "succeeded");
    expect(publishImplementOnly).toHaveBeenCalledTimes(1);
    expect(runImplement).not.toHaveBeenCalled();
    await handle.stop();
  });

  it("claims a queued job, runs it with an attempt row and finishes it succeeded", async () => {
    const jobId = stores.jobs.enqueue(createdTrigger);
    const handle = start();

    await waitForStatus(jobId, "succeeded");

    const expectedCtx: RunContext = {
      jobId,
      attempt: 1,
      issueId: "issue-1",
      identifier: "API-1",
      teamKey: "API",
      trigger: createdTrigger,
      dryRun: false,
    };
    expect(runImplementMock).toHaveBeenCalledTimes(1);
    expect(runImplementMock.mock.calls[0]?.[0]).toEqual(expectedCtx);
    expect(publishImplementOnlyMock).not.toHaveBeenCalled();
    expect(stores.jobs.get(jobId)?.attempts).toBe(1);
    const attempts = stores.attempts.forJob(jobId);
    expect(attempts.length).toBe(1);
    expect(attempts[0]?.number).toBe(1);
    expect(attempts[0]?.finishedAt).toEqual(expect.any(String));
    expect(attempts[0]?.error).toBeNull();
    expect(handle.state()).toEqual({ running: [] });
  });

  it("records a success warning on the attempt row", async () => {
    runImplementMock.mockResolvedValue({ status: "succeeded", warning: "comment failed" });
    const jobId = stores.jobs.enqueue(createdTrigger);
    start();

    await waitForStatus(jobId, "succeeded");

    expect(stores.jobs.get(jobId)?.error).toBeNull();
    expect(stores.attempts.forJob(jobId)[0]?.error).toBe("comment failed");
  });

  it("leaves a deferred job queued until the given time, its attempt closed and given back", async () => {
    const until = new Date(Date.now() + 3_600_000);
    runImplementMock.mockResolvedValue({ status: "deferred", until });
    const jobId = stores.jobs.enqueue(createdTrigger);
    start();

    await vi.waitFor(() => {
      expect(stores.attempts.forJob(jobId)[0]?.finishedAt).toEqual(expect.any(String));
      expect(stores.jobs.get(jobId)?.status).toBe("queued");
    });

    const job = stores.jobs.get(jobId);
    expect(job?.notBefore).toBe(until.toISOString());
    expect(job?.attempts).toBe(0);
    expect(job?.error).toBeNull();
    expect(stores.attempts.forJob(jobId)[0]?.error).toBeNull();
    expect(runImplementMock).toHaveBeenCalledTimes(1);
  });

  it("dispatches an await_review job to runAwaitReview", async () => {
    const runAwaitReview = vi.fn(async () => ({ status: "succeeded" }) as const);
    const jobId = stores.jobs.enqueue({ kind: "loop", issueId: "issue-1", identifier: "API-1", teamKey: "API", loopId: 1, step: "await" });
    start({ runAwaitReview });

    await waitForStatus(jobId, "succeeded");

    expect(runAwaitReview).toHaveBeenCalledTimes(1);
    expect(runImplementMock).not.toHaveBeenCalled();
  });

  it("dispatches a fix job to runFix", async () => {
    const runFix = vi.fn(async () => ({ status: "succeeded" }) as const);
    const jobId = stores.jobs.enqueue({ kind: "loop", issueId: "issue-1", identifier: "API-1", teamKey: "API", loopId: 1, step: "fix" });
    start({ runFix });

    await waitForStatus(jobId, "succeeded");

    expect(runFix).toHaveBeenCalledTimes(1);
    expect(runImplementMock).not.toHaveBeenCalled();
  });

  it("dispatches a restart job to runRestart", async () => {
    const runRestart = vi.fn(async () => ({ status: "succeeded" }) as const);
    const jobId = stores.jobs.enqueue({ kind: "loop", issueId: "issue-1", identifier: "API-1", teamKey: "API", loopId: 1, step: "restart" });
    start({ runRestart });

    await waitForStatus(jobId, "succeeded");

    expect(runRestart).toHaveBeenCalledTimes(1);
    expect(runImplementMock).not.toHaveBeenCalled();
  });

  it("dispatches a chat job to runChat", async () => {
    const runChat = vi.fn(async () => ({ status: "succeeded" }) as const);
    const jobId = stores.jobs.enqueue({
      kind: "chat", issueId: "issue-1", identifier: "API-1", teamKey: "API", loopId: null, projectId: 42, mrIid: 7, discussionId: "d1", noteId: 9, author: "ada", message: "hi",
    });
    start({ runChat });

    await waitForStatus(jobId, "succeeded");

    expect(runChat).toHaveBeenCalledTimes(1);
    expect(runImplementMock).not.toHaveBeenCalled();
  });

  it("hands back a loop whose fix job failed for good, with the job's error", async () => {
    tracker.addIssue(ticket);
    const loopId = runningLoop("fixing");
    const jobId = stores.jobs.enqueue(loopStep(loopId, "fix"));
    const runFix = vi.fn(async () => ({ status: "failed", error: "crashed: boom", retryable: false }) as const);
    start({ runFix });

    await vi.waitFor(() => {
      expect(stores.loops.get(loopId)?.state).toBe("handed_back");
    });

    expect(stores.jobs.get(jobId)?.status).toBe("failed");
    expect(gitlab.notes).toHaveLength(1);
    expect(gitlab.notes[0]).toContain("Ticket Steward stopped and handed this back: the loop's fix job failed: crashed: boom.");
  });

  it("hands back at startup a loop an earlier run left with no job, and leaves a loop with a queued job alone", async () => {
    tracker.addIssue(ticket);
    const stranded = runningLoop("awaiting_review");
    const failed = stores.jobs.enqueue(loopStep(stranded, "await"));
    stores.jobs.claimById(failed);
    stores.jobs.finish(failed, { status: "publish_failed", error: "comment: Linear down" });
    const waiting = runningLoop("awaiting_review");
    const queued = stores.jobs.enqueue(loopStep(waiting, "await"));
    stores.jobs.defer(queued, new Date(Date.now() + 3_600_000));
    start();

    await vi.waitFor(() => {
      expect(stores.loops.get(stranded)?.state).toBe("handed_back");
    });

    expect(gitlab.notes[0]).toContain("the loop's await_review job could not publish: comment: Linear down");
    expect(stores.loops.get(waiting)?.state).toBe("awaiting_review");
  });

  it("tries a stranded loop's hand-back again on the next sweep when it could not publish", async () => {
    tracker.addIssue(ticket);
    gitlab.failNextNote();
    const loopId = runningLoop("awaiting_review");
    const failed = stores.jobs.enqueue(loopStep(loopId, "await"));
    stores.jobs.claimById(failed);
    stores.jobs.finish(failed, { status: "failed", error: "GitLab down", retryable: true });
    start({ strandedMs: 20 });

    await vi.waitFor(() => {
      expect(stores.loops.get(loopId)?.state).toBe("handed_back");
    });

    expect(gitlab.notes).toHaveLength(1);
  });

  it("does not add up an await job's retryable failures across the polls of a long wait", async () => {
    const polled: JobOutcome = { status: "deferred", until: new Date(0) };
    const runAwaitReview = vi.fn<() => Promise<JobOutcome>>()
      .mockResolvedValueOnce(RETRYABLE)
      .mockResolvedValueOnce(polled)
      .mockResolvedValueOnce(RETRYABLE)
      .mockResolvedValueOnce(polled)
      .mockResolvedValueOnce(RETRYABLE)
      .mockResolvedValueOnce(polled)
      .mockResolvedValueOnce(SUCCEEDED);
    const jobId = stores.jobs.enqueue(loopStep(1, "await"));
    start({ runAwaitReview, maxAttempts: 2 });

    await waitForStatus(jobId, "succeeded");

    expect(runAwaitReview).toHaveBeenCalledTimes(7);
  });

  it("retries a retryable failure after the backoff and succeeds on the second attempt", async () => {
    runImplementMock.mockResolvedValueOnce(RETRYABLE).mockResolvedValueOnce(SUCCEEDED);
    const jobId = stores.jobs.enqueue(createdTrigger);
    start();

    await waitForStatus(jobId, "succeeded");

    expect(runImplementMock).toHaveBeenCalledTimes(2);
    expect(runImplementMock.mock.calls[1]?.[0].attempt).toBe(2);
    expect(stores.jobs.get(jobId)?.attempts).toBe(2);
    const attempts = stores.attempts.forJob(jobId);
    expect(attempts.length).toBe(2);
    expect(attempts[0]?.error).toBe("mirror fetch failed");
    expect(attempts[1]?.error).toBeNull();
  });

  it("keeps a retryable failure queued with not_before while it waits for the backoff", async () => {
    runImplementMock.mockResolvedValue(RETRYABLE);
    const jobId = stores.jobs.enqueue(createdTrigger);
    start({ backoffMs: [60_000] });

    await vi.waitFor(() => {
      expect(stores.jobs.get(jobId)?.notBefore).toEqual(expect.any(String));
    });

    const job = stores.jobs.get(jobId);
    expect(job?.status).toBe("queued");
    expect(job?.attempts).toBe(1);
    expect(job?.error).toBe("mirror fetch failed");
    expect(job?.finishedAt).toBeNull();
    expect(stores.jobs.findQueued("issue-1")?.id).toBe(jobId);
    expect(runImplementMock).toHaveBeenCalledTimes(1);
  });

  it("runs the second attempt from a fresh worker when the first one stopped during the backoff", async () => {
    runImplementMock.mockResolvedValueOnce(RETRYABLE).mockResolvedValueOnce(SUCCEEDED);
    const jobId = stores.jobs.enqueue(createdTrigger);
    const first = start({ backoffMs: [50] });
    await vi.waitFor(() => {
      expect(stores.jobs.get(jobId)?.notBefore).toEqual(expect.any(String));
    });
    await first.stop();
    expect(runImplementMock).toHaveBeenCalledTimes(1);

    start({ backoffMs: [50] });

    await waitForStatus(jobId, "succeeded");
    expect(runImplementMock).toHaveBeenCalledTimes(2);
    expect(runImplementMock.mock.calls[1]?.[0].attempt).toBe(2);
    expect(stores.jobs.get(jobId)?.notBefore).toBeNull();
  });

  it("survives a store error while finishing a job and keeps processing", async () => {
    const finishSpy = vi.spyOn(stores.jobs, "finish").mockImplementationOnce(() => {
      throw new Error("Intended Test Error");
    });
    const jobId = stores.jobs.enqueue(createdTrigger);
    const handle = start();

    await waitForStatus(jobId, "failed");
    const laterJobId = stores.jobs.enqueue({ ...createdTrigger, issueId: "issue-2", identifier: "API-2", deliveryId: "delivery-9" });
    await waitForStatus(laterJobId, "succeeded");

    expect(finishSpy).toHaveBeenCalledTimes(3);
    expect(handle.state()).toEqual({ running: [] });
  });

  it("fails a job with an unreadable stored implement_result without re-running it, and keeps processing", async () => {
    const runImplement = vi.fn<typeof runImplementMock>().mockResolvedValue(SUCCEEDED);
    const publishImplementOnly = vi.fn(async () => ({ status: "succeeded" }) as const);
    const badId = stores.jobs.enqueue({ ...createdTrigger, action: "implement" });
    stores.db.prepare("UPDATE jobs SET implement_result = ? WHERE id = ?").run('{"handback":"x"}', badId);
    const laterId = stores.jobs.enqueue({ ...createdTrigger, issueId: "issue-2", identifier: "API-2", deliveryId: "delivery-9" });
    const handle = start({ runImplement, publishImplementOnly });

    await waitForStatus(laterId, "succeeded");
    const bad = stores.jobs.get(badId);
    expect(bad?.status).toBe("failed");
    expect(bad?.error).toContain("implement_result");
    expect(bad?.attempts).toBe(1);
    expect(runImplement.mock.calls.map(([ctx]) => ctx.jobId)).toEqual([laterId]);
    expect(publishImplementOnly).not.toHaveBeenCalled();
    await handle.stop();
  });

  it("fails a job with an unreadable stored trigger instead of leaving it running", async () => {
    const badId = stores.jobs.enqueue(createdTrigger);
    stores.db.prepare("UPDATE jobs SET trigger = ? WHERE id = ?").run("{not json", badId);
    const laterId = stores.jobs.enqueue({ ...createdTrigger, issueId: "issue-2", identifier: "API-2", deliveryId: "delivery-9" });
    const handle = start();

    await waitForStatus(laterId, "succeeded");
    expect(stores.jobs.get(badId)?.status).toBe("failed");
    expect(stores.jobs.get(badId)?.error).toContain("trigger");
    expect(runImplementMock).toHaveBeenCalledTimes(1);
    await handle.stop();
  });

  it("keeps the loop alive when claiming a job throws", async () => {
    const claimSpy = vi.spyOn(stores.jobs, "claimNext").mockImplementationOnce(() => {
      throw new Error("Intended Test Error");
    });
    const jobId = stores.jobs.enqueue(createdTrigger);
    const handle = start();

    await waitForStatus(jobId, "succeeded");
    expect(claimSpy.mock.calls.length).toBeGreaterThan(1);
    await handle.stop();
  });

  it("SIGTERM aborts the in-flight job, marks the attempt interrupted and leaves the job queued", async () => {
    runImplementMock.mockImplementationOnce(
      (_ctx, deps) =>
        new Promise<JobOutcome>((resolve) => {
          deps.signal?.addEventListener("abort", () => resolve(INTERRUPTED), { once: true });
        }),
    );
    const jobId = stores.jobs.enqueue(createdTrigger);
    const handle = start();
    await vi.waitFor(() => {
      expect(handle.state()).toEqual({ running: [{ slot: 1, jobId }] });
    });
    const laterJobId = stores.jobs.enqueue({ ...createdTrigger, issueId: "issue-2", identifier: "API-2", deliveryId: "delivery-9" });

    process.emit("SIGTERM");

    await waitForStatus(jobId, "queued");
    await vi.waitFor(() => {
      expect(acquireRunLock(dataDir)).not.toBeNull();
    });
    const [attempt] = stores.attempts.forJob(jobId);
    expect(attempt?.error).toBe(INTERRUPTED_ERROR);
    expect(attempt?.finishedAt).toEqual(expect.any(String));
    expect(stores.jobs.get(jobId)?.attempts).toBe(1);
    expect(stores.jobs.get(jobId)?.notBefore).toBeNull();
    expect(stores.jobs.get(laterJobId)?.status).toBe("queued");
    expect(runImplementMock).toHaveBeenCalledTimes(1);
    expect(handle.state()).toEqual({ running: [] });
  });

  it("fails an interrupted job that has used its last attempt", async () => {
    runImplementMock.mockResolvedValue(INTERRUPTED);
    const jobId = stores.jobs.enqueue(createdTrigger);
    stores.jobs.claimById(jobId);
    stores.jobs.finish(jobId, RETRYABLE);
    stores.jobs.claimById(jobId);
    stores.jobs.finish(jobId, RETRYABLE);
    stores.jobs.requeue(jobId);
    start();

    await waitForStatus(jobId, "failed");

    expect(stores.jobs.get(jobId)?.attempts).toBe(3);
    expect(stores.jobs.get(jobId)?.error).toBe(INTERRUPTED_ERROR);
    expect(stores.attempts.forJob(jobId)[0]?.error).toBe(INTERRUPTED_ERROR);
  });

  it("fails after the last retryable attempt", async () => {
    runImplementMock.mockResolvedValue(RETRYABLE);
    const jobId = stores.jobs.enqueue(createdTrigger);
    start();

    await vi.waitFor(() => {
      expect(runImplementMock).toHaveBeenCalledTimes(3);
    });
    await waitForStatus(jobId, "failed");

    expect(stores.jobs.get(jobId)?.attempts).toBe(3);
    expect(stores.jobs.get(jobId)?.error).toBe("mirror fetch failed");
    await sleep(20);
    expect(runImplementMock).toHaveBeenCalledTimes(3);
  });

  it("does not retry a terminal failure", async () => {
    runImplementMock.mockResolvedValue({ status: "failed", error: "invalid output", retryable: false });
    const jobId = stores.jobs.enqueue(createdTrigger);
    start();

    await waitForStatus(jobId, "failed");
    await sleep(20);

    expect(runImplementMock).toHaveBeenCalledTimes(1);
    expect(stores.jobs.get(jobId)?.attempts).toBe(1);
  });

  it("resumes at publish for a job whose result is stored after a publish failure", async () => {
    runImplementMock.mockImplementationOnce(async (ctx) => {
      stores.jobs.saveImplementResult(ctx.jobId, { result: null, handback: { label: "readyForHuman", reason: "the agent could not finish", detail: "" } });
      return { status: "publish_failed", error: "linear 502" };
    });
    const jobId = stores.jobs.enqueue(createdTrigger);
    start();

    await waitForStatus(jobId, "succeeded");

    expect(runImplementMock).toHaveBeenCalledTimes(1);
    expect(publishImplementOnlyMock).toHaveBeenCalledTimes(1);
    expect(publishImplementOnlyMock.mock.calls[0]?.[0].attempt).toBe(2);
    expect(stores.jobs.get(jobId)?.attempts).toBe(2);
    expect(stores.attempts.forJob(jobId)[0]?.error).toBe("linear 502");
  });

  it("stop() waits for the in-flight job, stops claiming and releases the lock", async () => {
    let finish: (outcome: JobOutcome) => void = () => undefined;
    runImplementMock.mockImplementationOnce(
      () =>
        new Promise<JobOutcome>((resolve) => {
          finish = resolve;
        }),
    );
    const jobId = stores.jobs.enqueue(createdTrigger);
    const handle = start();
    await vi.waitFor(() => {
      expect(handle.state()).toEqual({ running: [{ slot: 1, jobId }] });
    });

    const stopping = handle.stop();
    const laterJobId = stores.jobs.enqueue({ ...createdTrigger, issueId: "issue-2", identifier: "API-2", deliveryId: "delivery-9" });
    finish(SUCCEEDED);
    await stopping;

    expect(stores.jobs.get(jobId)?.status).toBe("succeeded");
    expect(handle.state()).toEqual({ running: [] });
    await sleep(20);
    expect(stores.jobs.get(laterJobId)?.status).toBe("queued");
    const lock = acquireRunLock(dataDir);
    expect(lock).not.toBeNull();
    lock?.release();
  });

  it("refuses to start while another process holds the run lock", () => {
    const lock = acquireRunLock(dataDir);

    expect(() => startWorker(makeDeps())).toThrow();

    lock?.release();
  });

  it("requeues an interrupted running job on start and fails one out of attempts", async () => {
    const interruptedId = stores.jobs.enqueue(createdTrigger);
    stores.jobs.claimById(interruptedId);
    const exhaustedId = stores.jobs.enqueue({ ...createdTrigger, issueId: "issue-2", identifier: "API-2", deliveryId: "delivery-9" });
    stores.jobs.claimById(exhaustedId);
    stores.jobs.finish(exhaustedId, RETRYABLE);
    stores.jobs.claimById(exhaustedId);
    stores.jobs.finish(exhaustedId, RETRYABLE);
    stores.jobs.claimById(exhaustedId);
    start();

    await waitForStatus(interruptedId, "succeeded");

    expect(stores.jobs.get(interruptedId)?.attempts).toBe(2);
    expect(stores.jobs.get(exhaustedId)?.status).toBe("failed");
    expect(stores.jobs.get(exhaustedId)?.error).toBe(INTERRUPTED_ERROR);
    expect(runImplementMock).toHaveBeenCalledTimes(1);
  });

  it("claims nothing while the tracker reports a rejected API key", async () => {
    tracker.rejectApiKey();
    const jobId = stores.jobs.enqueue(createdTrigger);
    start();
    await sleep(30);

    expect(stores.jobs.get(jobId)?.status).toBe("queued");
    expect(runImplementMock).not.toHaveBeenCalled();
  });

  it("stops claiming after a job hits a rejected API key and keeps that job queued with its attempt refunded", async () => {
    runImplementMock.mockImplementationOnce(async () => {
      tracker.rejectApiKey();
      return { status: "failed", error: "Linear rejected LINEAR_API_KEY (401): the key is invalid or revoked.", retryable: true };
    });
    const firstId = stores.jobs.enqueue(createdTrigger);
    const secondId = stores.jobs.enqueue({ ...createdTrigger, issueId: "issue-2", identifier: "API-2", deliveryId: "delivery-2" });
    start();

    await vi.waitFor(() => {
      expect(stores.attempts.forJob(firstId)[0]?.finishedAt).not.toBeNull();
    });
    await sleep(30);

    expect(runImplementMock).toHaveBeenCalledTimes(1);
    expect(stores.jobs.get(firstId)?.status).toBe("queued");
    expect(stores.jobs.get(firstId)?.attempts).toBe(0);
    expect(stores.jobs.get(firstId)?.notBefore).toBeNull();
    expect(stores.jobs.get(secondId)?.status).toBe("queued");
    expect(stores.jobs.get(secondId)?.attempts).toBe(0);
  });

  it("does not fail a job on its last attempt when that attempt hits a rejected API key", async () => {
    runImplementMock.mockImplementationOnce(async () => {
      tracker.rejectApiKey();
      return { status: "publish_failed", error: "Linear rejected LINEAR_API_KEY (401): the key is invalid or revoked." };
    });
    const jobId = stores.jobs.enqueue(createdTrigger);
    start({ maxAttempts: 1 });

    await vi.waitFor(() => {
      expect(stores.attempts.forJob(jobId)[0]?.finishedAt).not.toBeNull();
    });
    await sleep(30);

    expect(stores.jobs.get(jobId)?.status).toBe("queued");
    expect(stores.jobs.get(jobId)?.attempts).toBe(0);
    expect(runImplementMock).toHaveBeenCalledTimes(1);
  });

  it("sweeps worktrees beyond the kept count on start", async () => {
    const workRoot = join(dataDir, "work");
    await mkdir(join(workRoot, "1-1"), { recursive: true });
    await mkdir(join(workRoot, "2-1"), { recursive: true });
    await mkdir(join(workRoot, "3-1"), { recursive: true });
    await mkdir(join(workRoot, "4-1"), { recursive: true });
    start({ config: { ...makeConfig(), retention: { keptWorktrees: 1, days: 30 } } });

    await vi.waitFor(async () => {
      expect((await readdir(workRoot)).length).toBe(1);
    });
  });

  it("runs jobs for two tickets at once, one per slot", async () => {
    const held = heldRuns();
    runImplementMock.mockImplementation(held.impl);
    const first = stores.jobs.enqueue(createdTrigger);
    const second = stores.jobs.enqueue(issue2);
    const handle = start(onSlots(fakeSlotRunner()));

    await vi.waitFor(() => expect(handle.state().running).toHaveLength(2));
    expect(new Set(handle.state().running.map((entry) => entry.slot))).toEqual(new Set([1, 2]));
    expect(new Set(handle.state().running.map((entry) => entry.jobId))).toEqual(new Set([first, second]));
    expect(new Set([held.slots.get(first), held.slots.get(second)])).toEqual(new Set([1, 2]));

    held.release(first);
    held.release(second);
    await waitForStatus(first, "succeeded");
    await waitForStatus(second, "succeeded");
    await vi.waitFor(() => expect(handle.state()).toEqual({ running: [] }));
  });

  it("runs two jobs for the same ticket one after the other", async () => {
    const held = heldRuns();
    runImplementMock.mockImplementation(held.impl);
    const first = stores.jobs.enqueue(createdTrigger);
    const second = stores.jobs.enqueue({ ...createdTrigger, deliveryId: "delivery-2" });
    const handle = start(onSlots(fakeSlotRunner()));

    await vi.waitFor(() => expect(handle.state().running.map((entry) => entry.jobId)).toEqual([first]));
    await sleep(30);
    expect(runImplementMock).toHaveBeenCalledTimes(1);
    expect(stores.jobs.get(second)?.status).toBe("queued");

    held.release(first);
    await vi.waitFor(() => expect(runImplementMock).toHaveBeenCalledTimes(2));
    held.release(second);
    await waitForStatus(second, "succeeded");
  });

  it("brings every slot of the helper's range down at startup before claiming, whatever slots.count is", async () => {
    const runner = fakeSlotRunner();
    const jobId = stores.jobs.enqueue(createdTrigger);
    start(onSlots(runner, slotConfig(3)));

    await waitForStatus(jobId, "succeeded");
    expect(runner.calls).toEqual(ALL_SLOTS_DOWN);
  });

  it("leaves a slot a steward chat leased up, and its lane claims nothing while the lease lives", async () => {
    const held = heldRuns();
    runImplementMock.mockImplementation(held.impl);
    const runner = fakeSlotRunner();
    stores.leases.create({ issueId: "issue-9", worktreeName: "ticket-API-9", slot: 1, pid: process.pid });
    const jobId = stores.jobs.enqueue(createdTrigger);
    const handle = start(onSlots(runner));

    await vi.waitFor(() => expect(handle.state().running).toEqual([{ slot: 2, jobId }]));
    expect(runner.calls.filter((call) => call[0] === "down")).toEqual(ALL_SLOTS_DOWN.filter((call) => call[1] !== "1"));
    held.release(jobId);
    await waitForStatus(jobId, "succeeded");
  });

  it("stop aborts every running job, waits for all of them, brings every slot down, then releases the lock", async () => {
    const held = heldRuns();
    runImplementMock.mockImplementation(held.impl);
    const runner = fakeSlotRunner();
    const first = stores.jobs.enqueue(createdTrigger);
    const second = stores.jobs.enqueue(issue2);
    const handle = start(onSlots(runner));
    await vi.waitFor(() => expect(handle.state().running).toHaveLength(2));

    await handle.stop();

    expect(stores.jobs.get(first)?.status).toBe("queued");
    expect(stores.jobs.get(second)?.status).toBe("queued");
    expect(handle.state()).toEqual({ running: [] });
    expect(runner.calls).toEqual([...ALL_SLOTS_DOWN, ...ALL_SLOTS_DOWN]);
    const lock = acquireRunLock(dataDir);
    expect(lock).not.toBeNull();
    lock?.release();
  });

  it("an interrupted job leaves the job on the other slot running", async () => {
    const held = heldRuns();
    const other = stores.jobs.enqueue(issue2);
    const interrupted = stores.jobs.enqueue(createdTrigger);
    let interruptedRuns = 0;
    runImplementMock.mockImplementation((ctx, deps) => {
      if (ctx.jobId !== interrupted) return held.impl(ctx, deps);
      interruptedRuns += 1;
      return Promise.resolve(interruptedRuns === 1 ? INTERRUPTED : SUCCEEDED);
    });
    start(onSlots(fakeSlotRunner()));

    await waitForStatus(interrupted, "succeeded");
    expect(stores.jobs.get(other)?.status).toBe("running");
    expect(stores.attempts.forJob(other)[0]?.finishedAt).toBeNull();

    held.release(other);
    await waitForStatus(other, "succeeded");
  });

  it("skips the timer's sweep while a job runs and sweeps once the worker is idle", async () => {
    const held = heldRuns();
    runImplementMock.mockImplementation(held.impl);
    const jobId = stores.jobs.enqueue(createdTrigger);
    const handle = start({ ...onSlots(fakeSlotRunner(), { ...slotConfig(), retention: { keptWorktrees: 0, days: 30 } }), sweepMs: 10 });
    await vi.waitFor(() => expect(handle.state().running).toHaveLength(1));
    const stale = join(dataDir, "work", "old-1");
    await mkdir(stale, { recursive: true });

    await sleep(60);
    expect(existsSync(stale)).toBe(true);

    held.release(jobId);
    await vi.waitFor(() => expect(existsSync(stale)).toBe(false));
  });

  it("refuses to start with slots configured but no slot client", () => {
    expect(() => startWorker(makeDeps({ config: slotConfig() }))).toThrow("slots is configured but the worker was given no slot client");
  });
  describe("resource guard", () => {
    const guarded = (spacingSeconds: number, count = 2): StewardConfig => ({
      ...slotConfig(count),
      resourceGuard: { enabled: true, minAvailableMemoryMb: 4096, maxLoadPerCpu: 1.5, startSpacingSeconds: spacingSeconds },
    });

    it("holds a heavy job while memory is short, still runs an await_review, and starts the heavy job once memory frees up", async () => {
      let sample: ResourceSample = { availableMemoryMb: 1024, loadPerCpu: 0.1 };
      const runAwaitReview = vi.fn(async () => ({ status: "succeeded" }) as const);
      const heavy = stores.jobs.enqueue(createdTrigger);
      const loopId = runningLoop("awaiting_review");
      const waitId = stores.jobs.enqueue(loopStep(loopId, "await"));
      start({ ...onSlots(fakeSlotRunner(), guarded(0)), runAwaitReview, resources: () => sample });

      await waitForStatus(waitId, "succeeded");
      await sleep(30);
      expect(stores.jobs.get(heavy)?.status).toBe("queued");
      expect(runImplementMock).not.toHaveBeenCalled();

      sample = AMPLE;
      await waitForStatus(heavy, "succeeded");
    });

    it("holds a heavy job while the load per CPU is over the ceiling", async () => {
      let sample: ResourceSample = { availableMemoryMb: 64_000, loadPerCpu: 2 };
      const heavy = stores.jobs.enqueue(createdTrigger);
      start({ ...onSlots(fakeSlotRunner(), guarded(0)), resources: () => sample });

      await sleep(30);
      expect(stores.jobs.get(heavy)?.status).toBe("queued");

      sample = AMPLE;
      await waitForStatus(heavy, "succeeded");
    });

    it("starts heavy jobs at least startSpacingSeconds apart, even with free slots", async () => {
      const held = heldRuns();
      runImplementMock.mockImplementation(held.impl);
      const first = stores.jobs.enqueue(createdTrigger);
      const second = stores.jobs.enqueue(issue2);
      const handle = start(onSlots(fakeSlotRunner(), guarded(0.3)));

      await vi.waitFor(() => expect(handle.state().running.map((entry) => entry.jobId)).toEqual([first]));
      await sleep(100);
      expect(stores.jobs.get(second)?.status).toBe("queued");

      await waitForStatus(second, "running");
      held.release(first);
      held.release(second);
      await waitForStatus(second, "succeeded");
    });

    it("lets nothing through the guard when it is disabled", async () => {
      const heavy = stores.jobs.enqueue(createdTrigger);
      start({ resources: () => ({ availableMemoryMb: 0, loadPerCpu: 99 }) });

      await waitForStatus(heavy, "succeeded");
    });
  });
});
