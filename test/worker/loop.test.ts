import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Mock } from "vitest";
import { INTERRUPTED_ERROR } from "../../src/brain/index.js";
import type { StewardConfig } from "../../src/config/schema.js";
import { acquireRunLock } from "../../src/core/lock.js";
import type { PipelineDeps, publishOnly, runJob } from "../../src/core/pipeline.js";
import { Redactor } from "../../src/core/redact.js";
import type { BrainResult } from "../../src/core/result.js";
import type { JobOutcome, RunContext } from "../../src/core/types.js";
import { openStores, type Stores } from "../../src/store/index.js";
import type { TriggerEvent } from "../../src/tracker/types.js";
import { Mirror } from "../../src/workspace/mirror.js";
import { SlotClient } from "../../src/workspace/slots.js";
import { startWorker, type WorkerDeps, type WorkerHandle } from "../../src/worker/loop.js";
import { FakeBrain } from "../fakes/fakeBrain.js";
import { FakeCodeHost } from "../fakes/fakeCodeHost.js";
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

let dataDir: string;
let stores: Stores;
let tracker: FakeTracker;
let runJobMock: Mock<typeof runJob>;
let publishOnlyMock: Mock<typeof publishOnly>;
let worker: WorkerHandle | null;

const makeConfig = (): StewardConfig => ({
  dataDir,
  brain: { kind: "claude-code", model: "claude-test", maxTurns: 5, timeoutMinutes: 1 },
  tracker: { kind: "linear", teams: ["API"], gatewayIssues: "enrich", bugLabels: ["Bug"] },
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
  prompt: join(dataDir, "prompt.md"),
  server: { port: 3020, publicUrl: "https://steward.example" },
});

const makeDeps = (overrides: Partial<WorkerDeps> = {}): WorkerDeps => ({
  config: makeConfig(),
  secrets: { ANTHROPIC_API_KEY: "sk-ant-test-key-value" },
  configPath: join(dataDir, "steward.config.ts"),
  binPath: join(dataDir, "bin", "steward.js"),
  tracker,
  brain: new FakeBrain({ result: brainResult }),
  codehost: new FakeCodeHost(),
  mirror: new Mirror(join(dataDir, "repo.git"), "https://gitlab.example/acme/repo.git"),
  stores,
  redactor: new Redactor([]),
  now: () => NOW,
  runJob: runJobMock,
  publishOnly: publishOnlyMock,
  pollMs: 5,
  backoffMs: [5, 5],
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

/** A runJob that holds each job until `release(jobId)`, or answers INTERRUPTED when the worker aborts. */
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

const issue2 = { ...createdTrigger, issueId: "issue-2", identifier: "API-2", deliveryId: "delivery-9" };

/** The helper serves slots 1-9; down covers all of them so slots the agent brought up itself are cleaned too. */
const ALL_SLOTS_DOWN = Array.from({ length: 9 }, (_, i) => ["down", String(i + 1)]);

describe("startWorker", () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    dataDir = await mkdtemp(join(tmpdir(), "steward-worker-"));
    stores = openStores(dataDir);
    tracker = new FakeTracker();
    runJobMock = vi.fn<typeof runJob>().mockResolvedValue(SUCCEEDED);
    publishOnlyMock = vi.fn<typeof publishOnly>().mockResolvedValue(SUCCEEDED);
    worker = null;
  });

  afterEach(async () => {
    await worker?.stop();
    stores.db.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  it("dispatches implement jobs to runImplement and republish to publishImplementOnly", async () => {
    const runImplement = vi.fn(async () => ({ status: "succeeded" }) as const);
    const handle = start({ runImplement });
    const jobId = stores.jobs.enqueue({ ...createdTrigger, action: "implement" });
    await waitForStatus(jobId, "succeeded");
    expect(runImplement).toHaveBeenCalledTimes(1);
    await handle.stop();
  });

  it("dispatches an implement job with a saved result to publishImplementOnly, not runImplement", async () => {
    const runImplement = vi.fn(async () => ({ status: "succeeded" }) as const);
    const publishImplementOnly = vi.fn(async () => ({ status: "succeeded" }) as const);
    const jobId = stores.jobs.enqueue({ ...createdTrigger, action: "implement" });
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
    expect(runJobMock).toHaveBeenCalledTimes(1);
    expect(runJobMock.mock.calls[0]?.[0]).toEqual(expectedCtx);
    expect(publishOnlyMock).not.toHaveBeenCalled();
    expect(stores.jobs.get(jobId)?.attempts).toBe(1);
    const attempts = stores.attempts.forJob(jobId);
    expect(attempts.length).toBe(1);
    expect(attempts[0]?.number).toBe(1);
    expect(attempts[0]?.finishedAt).toEqual(expect.any(String));
    expect(attempts[0]?.error).toBeNull();
    expect(handle.state()).toEqual({ running: [] });
  });

  it("records a success warning on the attempt row", async () => {
    runJobMock.mockResolvedValue({ status: "succeeded", warning: "comment failed" });
    const jobId = stores.jobs.enqueue(createdTrigger);
    start();

    await waitForStatus(jobId, "succeeded");

    expect(stores.jobs.get(jobId)?.error).toBeNull();
    expect(stores.attempts.forJob(jobId)[0]?.error).toBe("comment failed");
  });

  it("retries a retryable failure after the backoff and succeeds on the second attempt", async () => {
    runJobMock.mockResolvedValueOnce(RETRYABLE).mockResolvedValueOnce(SUCCEEDED);
    const jobId = stores.jobs.enqueue(createdTrigger);
    start();

    await waitForStatus(jobId, "succeeded");

    expect(runJobMock).toHaveBeenCalledTimes(2);
    expect(runJobMock.mock.calls[1]?.[0].attempt).toBe(2);
    expect(stores.jobs.get(jobId)?.attempts).toBe(2);
    const attempts = stores.attempts.forJob(jobId);
    expect(attempts.length).toBe(2);
    expect(attempts[0]?.error).toBe("mirror fetch failed");
    expect(attempts[1]?.error).toBeNull();
  });

  it("keeps a retryable failure queued with not_before while it waits for the backoff", async () => {
    runJobMock.mockResolvedValue(RETRYABLE);
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
    expect(runJobMock).toHaveBeenCalledTimes(1);
  });

  it("runs the second attempt from a fresh worker when the first one stopped during the backoff", async () => {
    runJobMock.mockResolvedValueOnce(RETRYABLE).mockResolvedValueOnce(SUCCEEDED);
    const jobId = stores.jobs.enqueue(createdTrigger);
    const first = start({ backoffMs: [50] });
    await vi.waitFor(() => {
      expect(stores.jobs.get(jobId)?.notBefore).toEqual(expect.any(String));
    });
    await first.stop();
    expect(runJobMock).toHaveBeenCalledTimes(1);

    start({ backoffMs: [50] });

    await waitForStatus(jobId, "succeeded");
    expect(runJobMock).toHaveBeenCalledTimes(2);
    expect(runJobMock.mock.calls[1]?.[0].attempt).toBe(2);
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
    const runImplement = vi.fn(async () => ({ status: "succeeded" }) as const);
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
    expect(runImplement).not.toHaveBeenCalled();
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
    expect(runJobMock).toHaveBeenCalledTimes(1);
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
    runJobMock.mockImplementationOnce(
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
    expect(runJobMock).toHaveBeenCalledTimes(1);
    expect(handle.state()).toEqual({ running: [] });
  });

  it("fails an interrupted job that has used its last attempt", async () => {
    runJobMock.mockResolvedValue(INTERRUPTED);
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
    runJobMock.mockResolvedValue(RETRYABLE);
    const jobId = stores.jobs.enqueue(createdTrigger);
    start();

    await vi.waitFor(() => {
      expect(runJobMock).toHaveBeenCalledTimes(3);
    });
    await waitForStatus(jobId, "failed");

    expect(stores.jobs.get(jobId)?.attempts).toBe(3);
    expect(stores.jobs.get(jobId)?.error).toBe("mirror fetch failed");
    await sleep(20);
    expect(runJobMock).toHaveBeenCalledTimes(3);
  });

  it("does not retry a terminal failure", async () => {
    runJobMock.mockResolvedValue({ status: "failed", error: "invalid output", retryable: false });
    const jobId = stores.jobs.enqueue(createdTrigger);
    start();

    await waitForStatus(jobId, "failed");
    await sleep(20);

    expect(runJobMock).toHaveBeenCalledTimes(1);
    expect(stores.jobs.get(jobId)?.attempts).toBe(1);
  });

  it("resumes at publish for a job whose result is stored after a publish failure", async () => {
    runJobMock.mockImplementationOnce(async (ctx) => {
      stores.jobs.saveResult(ctx.jobId, brainResult, "abc1234");
      return { status: "publish_failed", error: "linear 502" };
    });
    const jobId = stores.jobs.enqueue(createdTrigger);
    start();

    await waitForStatus(jobId, "succeeded");

    expect(runJobMock).toHaveBeenCalledTimes(1);
    expect(publishOnlyMock).toHaveBeenCalledTimes(1);
    expect(publishOnlyMock.mock.calls[0]?.[0].attempt).toBe(2);
    expect(stores.jobs.get(jobId)?.attempts).toBe(2);
    expect(stores.attempts.forJob(jobId)[0]?.error).toBe("linear 502");
  });

  it("stop() waits for the in-flight job, stops claiming and releases the lock", async () => {
    let finish: (outcome: JobOutcome) => void = () => undefined;
    runJobMock.mockImplementationOnce(
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
    expect(runJobMock).toHaveBeenCalledTimes(1);
  });

  it("claims nothing while the tracker reports a rejected API key", async () => {
    tracker.rejectApiKey();
    const jobId = stores.jobs.enqueue(createdTrigger);
    start();
    await sleep(30);

    expect(stores.jobs.get(jobId)?.status).toBe("queued");
    expect(runJobMock).not.toHaveBeenCalled();
  });

  it("stops claiming after a job hits a rejected API key and keeps that job queued with its attempt refunded", async () => {
    runJobMock.mockImplementationOnce(async () => {
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

    expect(runJobMock).toHaveBeenCalledTimes(1);
    expect(stores.jobs.get(firstId)?.status).toBe("queued");
    expect(stores.jobs.get(firstId)?.attempts).toBe(0);
    expect(stores.jobs.get(firstId)?.notBefore).toBeNull();
    expect(stores.jobs.get(secondId)?.status).toBe("queued");
    expect(stores.jobs.get(secondId)?.attempts).toBe(0);
  });

  it("does not fail a job on its last attempt when that attempt hits a rejected API key", async () => {
    runJobMock.mockImplementationOnce(async () => {
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
    expect(runJobMock).toHaveBeenCalledTimes(1);
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
    runJobMock.mockImplementation(held.impl);
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
    runJobMock.mockImplementation(held.impl);
    const runImplement = vi.fn(async () => ({ status: "succeeded" }) as const);
    const first = stores.jobs.enqueue(createdTrigger);
    const second = stores.jobs.enqueue({ ...createdTrigger, action: "implement", deliveryId: "delivery-2" });
    const handle = start({ ...onSlots(fakeSlotRunner()), runImplement });

    await vi.waitFor(() => expect(handle.state().running.map((entry) => entry.jobId)).toEqual([first]));
    await sleep(30);
    expect(runImplement).not.toHaveBeenCalled();
    expect(stores.jobs.get(second)?.status).toBe("queued");

    held.release(first);
    await waitForStatus(second, "succeeded");
    expect(runImplement).toHaveBeenCalledTimes(1);
  });

  it("brings every slot of the helper's range down at startup before claiming, whatever slots.count is", async () => {
    const runner = fakeSlotRunner();
    const jobId = stores.jobs.enqueue(createdTrigger);
    start(onSlots(runner, slotConfig(3)));

    await waitForStatus(jobId, "succeeded");
    expect(runner.calls).toEqual(ALL_SLOTS_DOWN);
  });

  it("stop aborts every running job, waits for all of them, brings every slot down, then releases the lock", async () => {
    const held = heldRuns();
    runJobMock.mockImplementation(held.impl);
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
    runJobMock.mockImplementation((ctx, deps) => {
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
    runJobMock.mockImplementation(held.impl);
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
});
