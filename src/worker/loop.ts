import { join } from "node:path";
import { acquireRunLock } from "../core/lock.js";
import { publishOnly, runJob, type PipelineDeps } from "../core/pipeline.js";
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

const isRetryable = (outcome: JobOutcome): boolean =>
  outcome.status === "publish_failed" || (outcome.status === "failed" && outcome.retryable);

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
  private readonly timers = new Set<NodeJS.Timeout>();
  private readonly retryIds: number[] = [];
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
    this.loopDone = this.sweep().then(() => this.loop());
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
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    this.wake?.();
    await this.loopDone;
    this.lock.release();
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
    if (tokens.isAuthBroken()) return null;
    const retryId = this.retryIds.shift();
    return retryId === undefined ? jobs.claimNext() : jobs.claimById(retryId);
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
    const { stores } = this.deps;
    const attempt = stores.attempts.start(job.id);
    this.inFlight = { job, attempt };
    const ctx = runContext(job, attempt);
    const outcome = await this.run(job, ctx);
    stores.jobs.finish(job.id, outcome);
    stores.attempts.finish(attempt.id, attemptPatch(outcome));
    this.inFlight = null;
    logger.info({ jobId: job.id, attempt: attempt.number, status: outcome.status }, "job finished");
    if (!isRetryable(outcome)) return;
    if (job.attempts < this.maxAttempts) this.scheduleRetry(job);
    else await this.reportExhausted(job, outcome);
  }

  private async run(job: Job, ctx: RunContext): Promise<JobOutcome> {
    try {
      return job.result === null ? await this.execute(ctx, this.deps) : await this.republish(ctx, this.deps);
    } catch (err) {
      return { status: "failed", error: errorMessage(err), retryable: false };
    }
  }

  private scheduleRetry(job: Job): void {
    if (this.stopped) return;
    const delay = this.backoffMs[job.attempts - 1] ?? this.backoffMs.at(-1) ?? 0;
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      this.retryIds.push(job.id);
      this.wake?.();
    }, delay);
    this.timers.add(timer);
    logger.info({ jobId: job.id, attempt: job.attempts, delayMs: delay }, "job retry scheduled");
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
