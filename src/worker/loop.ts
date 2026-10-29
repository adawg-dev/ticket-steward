import { join } from "node:path";
import { INTERRUPTED_ERROR } from "../brain/index.js";
import { kubernetesRuntime, MAX_SLOTS, RESOURCE_GUARD_DEFAULTS, type ResourceGuardConfig } from "../config/schema.js";
import { runChat } from "../chat/run.js";
import { retentionProtection } from "../chat/session.js";
import { acquireRunLock } from "../core/lock.js";
import { redactOutcome, sessionsDir } from "../core/workspace.js";
import type { PipelineDeps } from "../core/deps.js";
import type { JobOutcome, RunContext } from "../core/types.js";
import { runAwaitReview } from "../greptile/await.js";
import { runFix } from "../greptile/fix.js";
import { runRestart } from "../greptile/start.js";
import { handBackStranded } from "../greptile/stranded.js";
import { publishImplementOnly, runImplement } from "../implement/pipeline.js";
import { logger } from "../log.js";
import type { RunSpec } from "../run/protocol.js";
import { RETIRED_KIND_ERROR, unreadableOutcome, type Attempt, type AttemptPatch, type Job } from "../store/index.js";
import { sweep } from "../workspace/retention.js";
import { holdReason, sampleResources, type Hold, type ResourceSample } from "./resources.js";

export interface WorkerOptions {
  pollMs?: number;
  maxAttempts?: number;
  backoffMs?: number[];
  sweepMs?: number;
  /** How often running fix loops left with no job are handed back. */
  strandedMs?: number;
  runImplement?: typeof runImplement;
  publishImplementOnly?: typeof publishImplementOnly;
  runAwaitReview?: typeof runAwaitReview;
  runFix?: typeof runFix;
  runRestart?: typeof runRestart;
  runChat?: typeof runChat;
  /** Samples host memory and load for the resource guard. */
  resources?: () => ResourceSample;
  /**
   * Kubernetes: run pods the executor reattached to after a restart. Their jobs stay running and are finished first, each
   * on the attempt its pod runs as; `release` stops a pod whose job ended without waiting on it.
   */
  resume?: { specs: RunSpec[]; release: (runId: string) => Promise<void> };
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

/** A reattached run pod's job, its attempt and the spec the pod runs. */
interface Resumed extends InFlight {
  spec: RunSpec;
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
const DEFAULT_STRANDED_MS = 5 * 60 * 1000;
const DELIVERY_RETENTION_DAYS = 7;

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
  private readonly implement: typeof runImplement;
  private readonly republishImplement: typeof publishImplementOnly;
  private readonly awaitReview: typeof runAwaitReview;
  private readonly fix: typeof runFix;
  private readonly restart: typeof runRestart;
  private readonly chat: typeof runChat;
  private readonly guard: ResourceGuardConfig;
  private readonly resources: () => ResourceSample;
  /** Kubernetes: a job interrupted by shutdown stays running, since its run pod goes on and the next start reattaches. */
  private readonly detachOnStop: boolean;
  private readonly resumed: Resumed[];
  /** When the last heavy job was claimed (epoch ms), for the guard's start spacing. */
  private lastHeavyStart = Number.NEGATIVE_INFINITY;
  /** The shortage holding heavy starts, so the log notes only when that changes. */
  private held: string | null = null;
  private readonly abort = new AbortController();
  private readonly sweepTimer: NodeJS.Timeout;
  private readonly strandedTimer: NodeJS.Timeout;
  private readonly lanes: Lane[];
  private readonly loopsDone: Promise<void>;
  private readonly onSigterm = (): void => void this.stop();
  private stopped = false;
  private stopping: Promise<void> | null = null;
  /** True while retention runs; claims wait, so no job starts while worktree directories are being removed. */
  private sweeping = false;
  /** The hand-back of stranded loops in progress, so two never overlap and shutdown can wait for it. */
  private rescuing: Promise<void> | null = null;

  constructor(
    private readonly deps: WorkerDeps,
    private readonly lock: { release: () => void },
  ) {
    this.pollMs = deps.pollMs ?? DEFAULT_POLL_MS;
    this.maxAttempts = deps.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.backoffMs = deps.backoffMs ?? DEFAULT_BACKOFF_MS;
    this.implement = deps.runImplement ?? runImplement;
    this.republishImplement = deps.publishImplementOnly ?? publishImplementOnly;
    this.awaitReview = deps.runAwaitReview ?? runAwaitReview;
    this.fix = deps.runFix ?? runFix;
    this.restart = deps.runRestart ?? runRestart;
    this.chat = deps.runChat ?? runChat;
    const kubernetes = kubernetesRuntime(deps.config);
    this.detachOnStop = kubernetes !== null;
    // Run pods are scheduled by the cluster, on their own requests and limits: the host's memory and load say nothing.
    this.guard = kubernetes !== null ? { ...RESOURCE_GUARD_DEFAULTS, enabled: false } : (deps.config.resourceGuard ?? RESOURCE_GUARD_DEFAULTS);
    this.resources = deps.resources ?? sampleResources;
    const lanes = kubernetes?.maxConcurrent ?? deps.config.slots?.count ?? 1;
    this.lanes = Array.from({ length: lanes }, (_, index): Lane => ({ slot: index + 1, inFlight: null, wake: null }));
    // Before requeueing: a running job of a removed kind must fail, not go back to the queue.
    const retired = deps.stores.jobs.failRetiredKinds();
    this.resumed = this.resumable();
    const { requeued, failed } = deps.stores.jobs.requeueInterrupted(this.maxAttempts, this.resumed.map(({ job }) => job.id));
    logger.info({ requeued, failed, retired, resumed: this.resumed.length, slots: this.lanes.length }, "worker started");
    this.sweepTimer = setInterval(() => void this.sweepWhenIdle(), deps.sweepMs ?? DEFAULT_SWEEP_MS).unref();
    this.strandedTimer = setInterval(() => void this.rescueStranded(), deps.strandedMs ?? DEFAULT_STRANDED_MS).unref();
    process.once("SIGTERM", this.onSigterm);
    // A crash can leave a slot's containers behind: every slot goes down before any loop claims.
    this.loopsDone = this.downAll()
      .then(() => this.sweep())
      .then(() => {
        // Not awaited: a stranded loop has no job, so the lanes never touch it.
        void this.rescueStranded();
      })
      .then(() => Promise.all(this.lanes.map((lane) => this.loop(lane).catch((err: unknown) => logger.error({ slot: lane.slot, err: errorMessage(err) }, "worker loop crashed")))))
      .then(() => undefined)
      .catch((err: unknown) => logger.error({ err: errorMessage(err) }, "worker crashed"));
  }

  /** The reattached runs whose job is still running on the attempt the pod runs as; any other is released. */
  private resumable(): Resumed[] {
    const { jobs, attempts } = this.deps.stores;
    return (this.deps.resume?.specs ?? []).flatMap((spec) => {
      const job = jobs.get(spec.jobId);
      const attempt = attempts.forJob(spec.jobId).find((candidate) => `${spec.jobId}-${candidate.number}` === spec.runId);
      if (job?.status === "running" && attempt !== undefined && attempt.finishedAt === null) return [{ job, attempt, spec }];
      this.releaseRun(spec.runId);
      return [];
    });
  }

  private releaseRun(runId: string): void {
    this.deps.resume?.release(runId).catch((err: unknown) => logger.warn({ runId, err: errorMessage(err) }, "a reattached run pod could not be stopped"));
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
    clearInterval(this.strandedTimer);
    this.abort.abort();
    for (const lane of this.lanes) lane.wake?.();
    try {
      await this.loopsDone;
      await this.rescuing;
      await this.downAll();
    } finally {
      this.lock.release();
    }
    logger.info("worker stopped");
  }

  /**
   * Brings the helper's whole slot range down, so slots the agent started itself or left over after lowering `slots.count`
   * are cleaned; without `slots` there are no containers. A slot an open `steward chat` leased is its, and stays up.
   */
  private async downAll(): Promise<void> {
    const ref = this.deps.slot;
    if (ref === undefined) return;
    const leased = new Set(this.deps.stores.leases.active().flatMap((lease) => (lease.slot === null ? [] : [lease.slot])));
    const slots = Array.from({ length: MAX_SLOTS }, (_, i) => i + 1).filter((n) => !leased.has(n));
    await Promise.all(slots.map((n) => ref.client.down(n)));
  }

  private async loop(lane: Lane): Promise<void> {
    while (!this.stopped) {
      const resumed = this.resumed.shift();
      if (resumed !== undefined) {
        await this.process(lane, resumed.job, resumed);
        continue;
      }
      let job: Job | null;
      try {
        job = this.claim(lane);
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

  /**
   * A rejected Linear API key pauses the queue: jobs stay queued until the steward restarts with a working key. While the
   * resource guard holds, only await_review jobs are claimed; claims are synchronous, so two lanes never pass it together.
   * A lane whose slot a `steward chat` leased claims nothing until the lease ends.
   */
  private claim(lane: Lane): Job | null {
    if (this.sweeping || this.deps.tracker.apiKeyRejected()) return null;
    const hold = this.heavyHold();
    const job = this.deps.stores.jobs.claimNext({ waitsOnly: hold !== null, slot: lane.slot });
    if (job !== null && job.kind !== "await_review") this.lastHeavyStart = Date.now();
    return job;
  }

  /** The guard's verdict for a heavy start now; logs when a shortage starts or ends holding them. */
  private heavyHold(): Hold | null {
    let hold: Hold | null = null;
    try {
      hold = this.guard.enabled ? holdReason(this.guard, this.resources(), Date.now() - this.lastHeavyStart) : null;
    } catch (err) {
      // A sampler failure must not stop the queue: start jobs as if the guard were off.
      logger.warn({ err: errorMessage(err) }, "resource sample failed");
    }
    const shortage = hold?.cause === "shortage" ? hold.reason : null;
    if (shortage !== null && this.held === null) logger.info({ reason: shortage }, "heavy job starts held");
    if (shortage === null && this.held !== null) logger.info({ was: this.held }, "heavy job starts resumed");
    this.held = shortage;
    return hold;
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

  /** Runs a claimed job on a new attempt, or a reattached run pod's job on the attempt it runs as. */
  private async process(lane: Lane, job: Job, resumed?: Resumed): Promise<void> {
    const { stores, redactor } = this.deps;
    try {
      const attempt = resumed?.attempt ?? stores.attempts.start(job.id);
      lane.inFlight = { job, attempt };
      const ctx = runContext(job, attempt);
      const outcome = redactOutcome(await this.run(lane, job, resumed === undefined ? ctx : { ...ctx, resume: resumed.spec }), redactor);
      await this.record(job, attempt, outcome);
      const fields = { jobId: job.id, slot: lane.slot, kind: job.kind, identifier: job.identifier, attempt: attempt.number, status: outcome.status, ...outcomeDetail(outcome) };
      if (outcome.status === "succeeded" || outcome.status === "deferred") logger.info(fields, "job finished");
      else logger.warn(fields, "job finished");
    } catch (err) {
      logger.error({ jobId: job.id, err: errorMessage(err) }, "job bookkeeping failed");
      this.failBestEffort(job, errorMessage(err));
    } finally {
      lane.inFlight = null;
      // A no-op once the job's executor waited on the pod; otherwise the job ended another way and the pod must go.
      if (resumed !== undefined) this.releaseRun(resumed.spec.runId);
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
          // failRetiredKinds fails these at start; one requeued by hand still never runs.
          return { status: "failed", error: RETIRED_KIND_ERROR, retryable: false };
        case "implement":
          return job.implementResult === null ? await this.implement(ctx, deps) : await this.republishImplement(ctx, deps);
        case "await_review":
          return await this.awaitReview(ctx, deps);
        case "fix":
          return await this.fix(ctx, deps);
        case "restart":
          return await this.restart(ctx, deps);
        case "chat":
          return await this.chat(ctx, deps);
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
      // Left running: its run pod goes on, and the next start reattaches to it or requeues the job.
      if (this.stopped && this.detachOnStop) return;
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
    // A loop step that ended for good leaves its loop with nothing to move it: hand it back now, not at the next timer.
    if (outcome.status !== "succeeded" && (job.kind === "await_review" || job.kind === "fix")) void this.rescueStranded();
  }

  private failBestEffort(job: Job, error: string): void {
    try {
      this.deps.stores.jobs.finish(job.id, { status: "failed", error, retryable: false });
    } catch (err) {
      logger.error({ jobId: job.id, err: errorMessage(err) }, "job could not be marked failed");
    }
  }

  /** Hands back running loops left with no job (best effort; a failed hand-back is tried again on the next timer). */
  private rescueStranded(): Promise<void> {
    if (this.stopped || this.deps.tracker.apiKeyRejected()) return Promise.resolve();
    this.rescuing ??= this.handBackStranded().finally(() => {
      this.rescuing = null;
    });
    return this.rescuing;
  }

  private async handBackStranded(): Promise<void> {
    try {
      for (const { loopId, identifier, reason, outcome } of await handBackStranded(this.deps)) {
        const fields = { loopId, identifier, reason, status: outcome.status, ...outcomeDetail(outcome) };
        if (outcome.status === "succeeded") logger.warn(fields, "stranded fix loop handed back");
        else logger.error(fields, "stranded fix loop could not be handed back");
      }
    } catch (err) {
      logger.error({ err: errorMessage(err) }, "stranded fix loop sweep failed");
    }
  }

  /** The timer's sweep: skipped while any job runs (the next interval tries again), so it never removes a worktree in use. */
  private async sweepWhenIdle(): Promise<void> {
    if (this.stopped || this.sweeping || this.lanes.some((lane) => lane.inFlight !== null)) return;
    await this.sweep();
  }

  private async sweep(): Promise<void> {
    const { config, stores } = this.deps;
    const workRoot = join(config.dataDir, "work");
    this.sweeping = true;
    try {
      const removed = await sweep({
        workRoot,
        jobsDir: join(config.dataDir, "jobs"),
        keptWorktrees: config.retention.keptWorktrees,
        days: config.retention.days,
        ...retentionProtection(stores, config),
        sessionsDir: sessionsDir(config),
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
  if (deps.config.slots !== undefined && deps.slot === undefined && kubernetesRuntime(deps.config) === null) throw new Error("slots is configured but the worker was given no slot client");
  const lock = acquireRunLock(deps.config.dataDir);
  if (lock === null) throw new Error(`another steward process holds ${join(deps.config.dataDir, "run.lock")}`);
  const worker = new Worker(deps, lock);
  return { state: () => worker.state(), stop: () => worker.stop() };
};
