import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Mock } from "vitest";
import type { StewardConfig } from "../../src/config/schema.js";
import { acquireRunLock } from "../../src/core/lock.js";
import type { publishOnly, runJob } from "../../src/core/pipeline.js";
import { Redactor } from "../../src/core/redact.js";
import type { BrainResult } from "../../src/core/result.js";
import type { JobOutcome, RunContext } from "../../src/core/types.js";
import { openStores, type Stores } from "../../src/store/index.js";
import type { TriggerEvent } from "../../src/tracker/types.js";
import { Mirror } from "../../src/workspace/mirror.js";
import { startWorker, type WorkerDeps, type WorkerHandle } from "../../src/worker/loop.js";
import { FakeBrain } from "../fakes/fakeBrain.js";
import { FakeCodeHost } from "../fakes/fakeCodeHost.js";
import { FakeTracker } from "../fakes/fakeTracker.js";

const NOW = new Date("2026-09-11T14:02:30.000Z");
const SUCCEEDED: JobOutcome = { status: "succeeded" };
const RETRYABLE: JobOutcome = { status: "failed", error: "mirror fetch failed", retryable: true };

const createdTrigger: TriggerEvent = {
  kind: "issue.created",
  issueId: "issue-1",
  identifier: "API-1",
  teamKey: "API",
  deliveryId: "delivery-1",
  description: "The adapter loses the final chunk.",
};

const sessionTrigger: TriggerEvent = {
  kind: "agent.session",
  action: "created",
  issueId: "issue-1",
  identifier: "API-1",
  teamKey: "API",
  sessionId: "session-1",
  deliveryId: "delivery-2",
};

const brainResult: BrainResult = {
  template: { matched: "Bugs", conforms: false, missing: ["Repro Steps"] },
  summary: "The adapter truncates the final chunk.",
  enrichment: "See `src/adapter.ts:12`.",
  attachments: [],
  confidence: "high",
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
  tracker: { kind: "linear", teams: ["API"] },
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
    expect(handle.state()).toEqual({ running: null });
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

  it("fails after the last retryable attempt and reports the session error", async () => {
    runJobMock.mockResolvedValue(RETRYABLE);
    const jobId = stores.jobs.enqueue(sessionTrigger);
    start();

    await vi.waitFor(() => {
      expect(runJobMock).toHaveBeenCalledTimes(3);
    });
    await waitForStatus(jobId, "failed");

    expect(stores.jobs.get(jobId)?.attempts).toBe(3);
    expect(stores.jobs.get(jobId)?.error).toBe("mirror fetch failed");
    await vi.waitFor(() => {
      expect(tracker.sessionActivities("session-1").length).toBe(1);
    });
    expect(tracker.sessionActivities("session-1")[0]?.type).toBe("error");
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
      expect(handle.state()).toEqual({ running: jobId });
    });

    const stopping = handle.stop();
    const laterJobId = stores.jobs.enqueue({ ...createdTrigger, issueId: "issue-2", identifier: "API-2", deliveryId: "delivery-9" });
    finish(SUCCEEDED);
    await stopping;

    expect(stores.jobs.get(jobId)?.status).toBe("succeeded");
    expect(handle.state()).toEqual({ running: null });
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
    expect(stores.jobs.get(exhaustedId)?.error).toBe("interrupted");
    expect(runJobMock).toHaveBeenCalledTimes(1);
  });

  it("pauses claiming while auth is broken and resumes once it clears", async () => {
    stores.tokens.setAuthBroken(true);
    const jobId = stores.jobs.enqueue(createdTrigger);
    start();
    await sleep(30);

    expect(stores.jobs.get(jobId)?.status).toBe("queued");
    expect(runJobMock).not.toHaveBeenCalled();

    stores.tokens.setAuthBroken(false);
    await waitForStatus(jobId, "succeeded");
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
});
