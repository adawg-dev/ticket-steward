import { join } from "node:path";
import { INTERRUPTED_ERROR } from "../brain/index.js";
import { acquireRunLock } from "../core/lock.js";
import { publishOnly, redactOutcome, runJob, type PipelineDeps } from "../core/pipeline.js";
import type { JobOutcome, RunContext } from "../core/types.js";
import { logger } from "../log.js";
import type { Attempt, AttemptPatch, Job } from "../store/index.js";
import { sweep } from "../workspace/retention.js";

export interface WorkerOptions {
  pollMs?: number;
  maxAttempts?: number;
  backoffMs?: number[];
  sweepMs?: number;
  runJob?: typeof runJob;
  publishOnly?: typeof publishOnly;
}

export type WorkerDeps = PipelineDeps & WorkerOptions;

export interface WorkerHandle {
  state: () => { running: number | null };
  stop: () => Promise<void>;
}

interface InFlight {
  job: Job;
  attempt: Attempt;
}

const DEFAULT_POLL_MS = 2_000;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BACKOFF_MS = [60_000, 300_000];
const DEFAULT_SWEEP_MS = 60 * 60 * 1000;
const DELIVERY_RETENTION_DAYS = 7;

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

const firstLine = (text: string): string => text.split("\n")[0] ?? text;

const isRetryable = (outcome: JobOutcome): outcome is Exclude<JobOutcome, { status: "succeeded" }> =>
  outcome.status === "publish_failed" || (outcome.status === "failed" && outcome.retryable);

const isInterrupted = (outcome: JobOutcome): boolean => outcome.status === "failed" && outcome.error === INTERRUPTED_ERROR;

const attemptPatch = (outcome: JobOutcome): AttemptPatch => {
  if (outcome.status === "succeeded") return outcome.warning === undefined ? {} : { error: outcome.warning };
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
  private readonly abort = new AbortController();
  private readonly sweepTimer: NodeJS.Timeout;
  private readonly loopDone: Promise<void>;
  private readonly onSigterm = (): void => void this.stop();
  private inFlight: InFlight | null = null;
  private stopped = false;
  private stopping: Promise<void> | null = null;
  private wake: (() => void) | null = null;

  constructor(
    private readonly deps: WorkerDeps,
    private readonly lock: { release: () => void },
  ) {
    this.pollMs = deps.pollMs ?? DEFAULT_POLL_MS;
    this.maxAttempts = deps.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.backoffMs = deps.backoffMs ?? DEFAULT_BACKOFF_MS;
    this.execute = deps.runJob ?? runJob;
    this.republish = deps.publishOnly ?? publishOnly;
    const { requeued, failed } = deps.stores.jobs.requeueInterrupted(this.maxAttempts);
    logger.info({ requeued, failed }, "worker started");
    this.sweepTimer = setInterval(() => void this.sweep(), deps.sweepMs ?? DEFAULT_SWEEP_MS).unref();
    process.once("SIGTERM", this.onSigterm);
    this.loopDone = this.sweep()
      .then(() => this.loop())
      .catch((err: unknown) => logger.error({ err: errorMessage(err) }, "worker loop crashed"));
  }

  state(): { running: number | null } {
    return { running: this.inFlight?.job.id ?? null };
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
    this.wake?.();
    try {
      await this.loopDone;
    } finally {
      this.lock.release();
    }
    logger.info("worker stopped");
  }

  private async loop(): Promise<void> {
    while (!this.stopped) {
      const job = this.claim();
      if (job === null) {
        await this.idle();
        continue;
      }
      await this.process(job);
    }
  }

  private claim(): Job | null {
    const { jobs, tokens } = this.deps.stores;
    return tokens.isAuthBroken() ? null : jobs.claimNext();
  }

  private idle(): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.wake = null;
        resolve();
      }, this.pollMs);
      this.wake = () => {
        clearTimeout(timer);
        this.wake = null;
        resolve();
      };
    });
  }

  private async process(job: Job): Promise<void> {
    const { stores, redactor } = this.deps;
    try {
      const attempt = stores.attempts.start(job.id);
      this.inFlight = { job, attempt };
      const outcome = redactOutcome(await this.run(job, runContext(job, attempt)), redactor);
      await this.record(job, attempt, outcome);
      logger.info({ jobId: job.id, attempt: attempt.number, status: outcome.status }, "job finished");
    } catch (err) {
      logger.error({ jobId: job.id, err: errorMessage(err) }, "job bookkeeping failed");
      this.failBestEffort(job, errorMessage(err));
    } finally {
      this.inFlight = null;
    }
  }

  private async run(job: Job, ctx: RunContext): Promise<JobOutcome> {
    const deps: PipelineDeps = { ...this.deps, signal: this.abort.signal };
    try {
      return job.result === null ? await this.execute(ctx, deps) : await this.republish(ctx, deps);
    } catch (err) {
      return { status: "failed", error: errorMessage(err), retryable: false };
    }
  }

  /** Persists the outcome: interrupted runs stay queued, retryable ones wait out the backoff in the queue, the rest are terminal. */
  private async record(job: Job, attempt: Attempt, outcome: JobOutcome): Promise<void> {
    const { jobs, attempts } = this.deps.stores;
    if (isInterrupted(outcome)) {
      jobs.requeueInterrupted(this.maxAttempts);
      return;
    }
    attempts.finish(attempt.id, attemptPatch(outcome));
    if (isRetryable(outcome) && job.attempts < this.maxAttempts) {
      const delay = this.backoffMs[job.attempts - 1] ?? this.backoffMs.at(-1) ?? 0;
      jobs.scheduleRetry(job.id, new Date(Date.now() + delay), outcome.error);
      logger.info({ jobId: job.id, attempt: job.attempts, delayMs: delay }, "job retry scheduled");
      return;
    }
    jobs.finish(job.id, outcome);
    if (isRetryable(outcome)) await this.reportExhausted(job, outcome);
  }

  private failBestEffort(job: Job, error: string): void {
    try {
      this.deps.stores.jobs.finish(job.id, { status: "failed", error, retryable: false });
    } catch (err) {
      logger.error({ jobId: job.id, err: errorMessage(err) }, "job could not be marked failed");
    }
  }

  private async reportExhausted(job: Job, outcome: JobOutcome): Promise<void> {
    const sessionId = this.deps.stores.jobs.get(job.id)?.sessionId ?? job.sessionId;
    if (sessionId === null || outcome.status === "succeeded") return;
    try {
      await this.deps.tracker.agentSession.error(
        sessionId,
        `Enrichment failed after ${job.attempts} attempts: ${firstLine(outcome.error)}`,
      );
    } catch (err) {
      logger.warn({ jobId: job.id, err: errorMessage(err) }, "session error activity failed");
    }
  }

  private async sweep(): Promise<void> {
    const { config, stores } = this.deps;
    const workRoot = join(config.dataDir, "work");
    const current = this.inFlight;
    try {
      const removed = await sweep({
        workRoot,
        jobsDir: join(config.dataDir, "jobs"),
        keptWorktrees: config.retention.keptWorktrees,
        days: config.retention.days,
        protect: current === null ? [] : [join(workRoot, `${current.job.id}-${current.attempt.number}`)],
      });
      const deliveries = stores.deliveries.prune(DELIVERY_RETENTION_DAYS);
      logger.info({ ...removed, deliveries }, "retention sweep complete");
    } catch (err) {
      logger.warn({ err: errorMessage(err) }, "retention sweep failed");
    }
  }
}

export const startWorker = (deps: WorkerDeps): WorkerHandle => {
  const lock = acquireRunLock(deps.config.dataDir);
  if (lock === null) throw new Error(`another steward process holds ${join(deps.config.dataDir, "run.lock")}`);
  const worker = new Worker(deps, lock);
  return { state: () => worker.state(), stop: () => worker.stop() };
};
