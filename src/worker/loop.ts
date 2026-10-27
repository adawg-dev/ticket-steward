import { join } from "node:path";
import { INTERRUPTED_ERROR } from "../brain/index.js";
import { acquireRunLock } from "../core/lock.js";
import { publishOnly, redactOutcome, runJob, type PipelineDeps } from "../core/pipeline.js";
import type { JobOutcome, RunContext } from "../core/types.js";
import { runAwaitReview } from "../greptile/await.js";
import { publishImplementOnly, runImplement } from "../implement/pipeline.js";
import { logger } from "../log.js";
import { notImplementedOutcome, unreadableOutcome, type Attempt, type AttemptPatch, type Job } from "../store/index.js";
import { sweep } from "../workspace/retention.js";

export interface WorkerOptions {
  pollMs?: number;
  maxAttempts?: number;
  backoffMs?: number[];
  sweepMs?: number;
  runJob?: typeof runJob;
  publishOnly?: typeof publishOnly;
  runImplement?: typeof runImplement;
  publishImplementOnly?: typeof publishImplementOnly;
  runAwaitReview?: typeof runAwaitReview;
}

export type WorkerDeps = PipelineDeps & WorkerOptions;

/** The jobs running right now, one entry per busy slot (slot 1 when `slots` is not configured). */
export interface WorkerState {
  running: Array<{ slot: number; jobId: number }>;
}

export interface WorkerHandle {
  state: () => WorkerState;
  stop: () => Promise<void>;
}

interface InFlight {
  job: Job;
  attempt: Attempt;
}

/** One worker loop; it owns its slot for its whole life. */
interface Lane {
  slot: number;
  inFlight: InFlight | null;
  wake: (() => void) | null;
}

const DEFAULT_POLL_MS = 2_000;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BACKOFF_MS = [60_000, 300_000];
const DEFAULT_SWEEP_MS = 60 * 60 * 1000;
const DELIVERY_RETENTION_DAYS = 7;
/** The helper serves slots 1-9 whatever slots.count is. */
const HELPER_SLOTS = 9;

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

const isRetryable = (outcome: JobOutcome): outcome is Extract<JobOutcome, { status: "failed" | "publish_failed" }> =>
  outcome.status === "publish_failed" || (outcome.status === "failed" && outcome.retryable);

const isInterrupted = (outcome: JobOutcome): boolean => outcome.status === "failed" && outcome.error === INTERRUPTED_ERROR;

const attemptPatch = (outcome: JobOutcome): AttemptPatch => {
  if (outcome.status === "deferred") return {};
  if (outcome.status === "succeeded") return outcome.warning === undefined ? {} : { error: outcome.warning };
  return { error: outcome.error };
};

/** What the log line adds to the status: the warning, the error, or when a deferred job runs again. */
const outcomeDetail = (outcome: JobOutcome): Record<string, string> => {
  if (outcome.status === "deferred") return { until: outcome.until.toISOString() };
  if (outcome.status === "succeeded") return outcome.warning === undefined ? {} : { warning: outcome.warning };
  return { error: outcome.error };
};

const runContext = (job: Job, attempt: Attempt): RunContext => ({
  jobId: job.id,
  attempt: attempt.number,
  issueId: job.issueId,
  identifier: job.identifier,
  teamKey: job.teamKey,
  trigger: job.trigger,
  dryRun: false,
});

class Worker {
  private readonly pollMs: number;
  private readonly maxAttempts: number;
  private readonly backoffMs: number[];
  private readonly execute: typeof runJob;
  private readonly republish: typeof publishOnly;
  private readonly implement: typeof runImplement;
  private readonly republishImplement: typeof publishImplementOnly;
  private readonly awaitReview: typeof runAwaitReview;
  private readonly abort = new AbortController();
  private readonly sweepTimer: NodeJS.Timeout;
  private readonly lanes: Lane[];
  private readonly loopsDone: Promise<void>;
  private readonly onSigterm = (): void => void this.stop();
  private stopped = false;
  private stopping: Promise<void> | null = null;
  /** True while retention runs; claims wait, so no job starts while worktree directories are being removed. */
  private sweeping = false;

  constructor(
    private readonly deps: WorkerDeps,
    private readonly lock: { release: () => void },
  ) {
    this.pollMs = deps.pollMs ?? DEFAULT_POLL_MS;
    this.maxAttempts = deps.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.backoffMs = deps.backoffMs ?? DEFAULT_BACKOFF_MS;
    this.execute = deps.runJob ?? runJob;
    this.republish = deps.publishOnly ?? publishOnly;
    this.implement = deps.runImplement ?? runImplement;
    this.republishImplement = deps.publishImplementOnly ?? publishImplementOnly;
    this.awaitReview = deps.runAwaitReview ?? runAwaitReview;
    this.lanes = Array.from({ length: deps.config.slots?.count ?? 1 }, (_, index): Lane => ({ slot: index + 1, inFlight: null, wake: null }));
    const { requeued, failed } = deps.stores.jobs.requeueInterrupted(this.maxAttempts);
    logger.info({ requeued, failed, slots: this.lanes.length }, "worker started");
    this.sweepTimer = setInterval(() => void this.sweepWhenIdle(), deps.sweepMs ?? DEFAULT_SWEEP_MS).unref();
    process.once("SIGTERM", this.onSigterm);
    // A crash can leave a slot's containers behind: every slot goes down before any loop claims.
    this.loopsDone = this.downAll()
      .then(() => this.sweep())
      .then(() => Promise.all(this.lanes.map((lane) => this.loop(lane).catch((err: unknown) => logger.error({ slot: lane.slot, err: errorMessage(err) }, "worker loop crashed")))))
      .then(() => undefined)
      .catch((err: unknown) => logger.error({ err: errorMessage(err) }, "worker crashed"));
  }

  state(): WorkerState {
    return { running: this.lanes.flatMap((lane) => (lane.inFlight === null ? [] : [{ slot: lane.slot, jobId: lane.inFlight.job.id }])) };
  }

  stop(): Promise<void> {
    this.stopping ??= this.shutdown();
    return this.stopping;
  }

  private async shutdown(): Promise<void> {
    this.stopped = true;
    process.removeListener("SIGTERM", this.onSigterm);
    clearInterval(this.sweepTimer);
    this.abort.abort();
    for (const lane of this.lanes) lane.wake?.();
    try {
      await this.loopsDone;
      await this.downAll();
    } finally {
      this.lock.release();
    }
    logger.info("worker stopped");
  }

  /** Brings the helper's whole slot range down, so slots the agent started itself or left over after lowering `slots.count` are cleaned; without `slots` there are no containers. */
  private async downAll(): Promise<void> {
    const ref = this.deps.slot;
    if (ref === undefined) return;
    await Promise.all(Array.from({ length: HELPER_SLOTS }, (_, i) => ref.client.down(i + 1)));
  }

  private async loop(lane: Lane): Promise<void> {
    while (!this.stopped) {
      let job: Job | null;
      try {
        job = this.claim();
      } catch (err) {
        // A store error while claiming must not end the loop; wait out the poll interval and try again.
        logger.error({ slot: lane.slot, err: errorMessage(err) }, "job claim failed");
        job = null;
      }
      if (job === null) {
        await this.idle(lane);
        continue;
      }
      await this.process(lane, job);
    }
  }

  /** A rejected Linear API key pauses the queue: jobs stay queued until the steward restarts with a working key. */
  private claim(): Job | null {
    if (this.sweeping || this.deps.tracker.apiKeyRejected()) return null;
    return this.deps.stores.jobs.claimNext();
  }

  private idle(lane: Lane): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        lane.wake = null;
        resolve();
      }, this.pollMs);
      lane.wake = () => {
        clearTimeout(timer);
        lane.wake = null;
        resolve();
      };
    });
  }

  private async process(lane: Lane, job: Job): Promise<void> {
    const { stores, redactor } = this.deps;
    try {
      const attempt = stores.attempts.start(job.id);
      lane.inFlight = { job, attempt };
      const outcome = redactOutcome(await this.run(lane, job, runContext(job, attempt)), redactor);
      await this.record(job, attempt, outcome);
      const fields = { jobId: job.id, slot: lane.slot, kind: job.kind, identifier: job.identifier, attempt: attempt.number, status: outcome.status, ...outcomeDetail(outcome) };
      if (outcome.status === "succeeded" || outcome.status === "deferred") logger.info(fields, "job finished");
      else logger.warn(fields, "job finished");
    } catch (err) {
      logger.error({ jobId: job.id, err: errorMessage(err) }, "job bookkeeping failed");
      this.failBestEffort(job, errorMessage(err));
    } finally {
      lane.inFlight = null;
    }
  }

  private async run(lane: Lane, job: Job, ctx: RunContext): Promise<JobOutcome> {
    const slot = this.deps.slot === undefined ? {} : { slot: { n: lane.slot, client: this.deps.slot.client } };
    const deps: PipelineDeps = { ...this.deps, signal: this.abort.signal, ...slot };
    // An unreadable stored result fails the job here, before any dispatch could re-run the brain or push again.
    const unreadable = unreadableOutcome(job);
    if (unreadable !== null) return unreadable;
    try {
      switch (job.kind) {
        case "enrich":
          return job.result === null ? await this.execute(ctx, deps) : await this.republish(ctx, deps);
        case "implement":
          return job.implementResult === null ? await this.implement(ctx, deps) : await this.republishImplement(ctx, deps);
        case "await_review":
          return await this.awaitReview(ctx, deps);
        case "fix":
        case "restart":
          return notImplementedOutcome(job.kind);
      }
    } catch (err) {
      return { status: "failed", error: errorMessage(err), retryable: false };
    }
  }

  /** Persists the outcome: deferred and interrupted runs stay queued, a run that hit a rejected API key goes back to the queue with its attempt refunded, retryable ones wait out the backoff in the queue, the rest are terminal. */
  private async record(job: Job, attempt: Attempt, outcome: JobOutcome): Promise<void> {
    const { jobs, attempts } = this.deps.stores;
    if (outcome.status === "deferred") {
      // Waiting is not a failure: no retry accounting, and the claimed attempt is given back.
      attempts.finish(attempt.id, {});
      jobs.defer(job.id, outcome.until);
      return;
    }
    if (isInterrupted(outcome)) {
      // This job only: another slot's job may still be running.
      jobs.requeueInterruptedJob(job.id, this.maxAttempts);
      return;
    }
    attempts.finish(attempt.id, attemptPatch(outcome));
    if (outcome.status !== "succeeded" && this.deps.tracker.apiKeyRejected()) {
      jobs.releaseClaim(job.id, outcome.error);
      logger.warn({ jobId: job.id }, "job returned to the queue: Linear rejected the API key");
      return;
    }
    if (isRetryable(outcome) && job.attempts < this.maxAttempts) {
      const delay = this.backoffMs[job.attempts - 1] ?? this.backoffMs.at(-1) ?? 0;
      jobs.scheduleRetry(job.id, new Date(Date.now() + delay), outcome.error);
      logger.info({ jobId: job.id, identifier: job.identifier, attempt: job.attempts, delayMs: delay, error: outcome.error }, "job retry scheduled");
      return;
    }
    jobs.finish(job.id, outcome);
  }

  private failBestEffort(job: Job, error: string): void {
    try {
      this.deps.stores.jobs.finish(job.id, { status: "failed", error, retryable: false });
    } catch (err) {
      logger.error({ jobId: job.id, err: errorMessage(err) }, "job could not be marked failed");
    }
  }

  /** The timer's sweep: skipped while any job runs (the next interval tries again), so it never removes a worktree in use. */
  private async sweepWhenIdle(): Promise<void> {
    if (this.stopped || this.sweeping || this.lanes.some((lane) => lane.inFlight !== null)) return;
    await this.sweep();
  }

  private async sweep(): Promise<void> {
    const { config, stores } = this.deps;
    this.sweeping = true;
    try {
      const removed = await sweep({
        workRoot: join(config.dataDir, "work"),
        jobsDir: join(config.dataDir, "jobs"),
        keptWorktrees: config.retention.keptWorktrees,
        days: config.retention.days,
        protect: [],
      });
      const deliveries = stores.deliveries.prune(DELIVERY_RETENTION_DAYS);
      logger.info({ ...removed, deliveries }, "retention sweep complete");
    } catch (err) {
      logger.warn({ err: errorMessage(err) }, "retention sweep failed");
    } finally {
      this.sweeping = false;
    }
  }
}

export const startWorker = (deps: WorkerDeps): WorkerHandle => {
  if (deps.config.slots !== undefined && deps.slot === undefined) throw new Error("slots is configured but the worker was given no slot client");
  const lock = acquireRunLock(deps.config.dataDir);
  if (lock === null) throw new Error(`another steward process holds ${join(deps.config.dataDir, "run.lock")}`);
  const worker = new Worker(deps, lock);
  return { state: () => worker.state(), stop: () => worker.stop() };
};
