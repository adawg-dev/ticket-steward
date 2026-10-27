import { acquireRunLock } from "../core/lock.js";
import { publishOnly, redactOutcome, runJob } from "../core/pipeline.js";
import type { JobOutcome, RunContext } from "../core/types.js";
import { runAwaitReview } from "../greptile/await.js";
import { runFix } from "../greptile/fix.js";
import { publishImplementOnly, runImplement } from "../implement/pipeline.js";
import { notImplementedOutcome, unreadableOutcome, type AttemptPatch, type Job, type JobStatus, type Stores } from "../store/index.js";
import { errorMessage, fail, println, type CliContext } from "./context.js";
import { sleep } from "./probe.js";
import type { Runtime } from "./runtime.js";

const POLL_MS = 2_000;
const LOCK_HELD = "another steward process holds run.lock; if `steward serve` is running, let it pick the job up";

const attemptPatch = (outcome: JobOutcome): AttemptPatch => {
  if (outcome.status === "deferred") return {};
  if (outcome.status === "succeeded") return outcome.warning === undefined ? {} : { error: outcome.warning };
  return { error: outcome.error };
};

/** Dispatches the way the worker does: implement, await_review and fix jobs go to their pipelines, a stored result means publish-only. */
const dispatch = (job: Job, ctx: RunContext, runtime: Runtime): Promise<JobOutcome> => {
  const unreadable = unreadableOutcome(job);
  if (unreadable !== null) return Promise.resolve(unreadable);
  switch (job.kind) {
    case "enrich":
      return job.result === null ? runJob(ctx, runtime.deps) : publishOnly(ctx, runtime.deps);
    case "implement":
      return job.implementResult === null ? runImplement(ctx, runtime.deps) : publishImplementOnly(ctx, runtime.deps);
    case "await_review":
      return runAwaitReview(ctx, runtime.deps);
    case "fix":
      return runFix(ctx, runtime.deps);
    case "restart":
      return Promise.resolve(notImplementedOutcome(job.kind));
  }
};

const execute = async (job: Job, ctx: RunContext, runtime: Runtime): Promise<JobOutcome> => {
  try {
    const outcome = await dispatch(job, ctx, runtime);
    return redactOutcome(outcome, runtime.deps.redactor);
  } catch (err) {
    return redactOutcome({ status: "failed", error: errorMessage(err), retryable: false }, runtime.deps.redactor);
  }
};

const terminalOutcome = (status: JobStatus, error: string | null): JobOutcome | null => {
  if (status === "succeeded") return { status };
  if (status === "publish_failed") return { status, error: error ?? status };
  if (status === "failed" || status === "skipped") return { status: "failed", error: error ?? status, retryable: false };
  return null;
};

/** Runs `fn` under run.lock; fails the command when another steward process holds it. */
export const withRunLock = async <T>(runtime: Runtime, ctx: CliContext, fn: () => Promise<T>): Promise<T> => {
  const lock = acquireRunLock(runtime.loaded.config.dataDir);
  if (lock === null) return fail(ctx, LOCK_HELD);
  try {
    return await fn();
  } finally {
    lock.release();
  }
};

/** Prints each non-terminal status change of a job the worker is handling, then returns its terminal outcome. */
export const tailJob = async (stores: Stores, jobId: number, ctx: CliContext): Promise<JobOutcome> => {
  let last: JobStatus | null = null;
  for (;;) {
    const job = stores.jobs.get(jobId);
    if (job === null) return fail(ctx, `job ${jobId} disappeared`);
    const outcome = terminalOutcome(job.status, job.error);
    if (outcome !== null) return outcome;
    if (job.status !== last) {
      last = job.status;
      println(ctx, `job ${jobId} ${job.status}`);
    }
    await sleep(POLL_MS);
  }
};

/** Claims the job and runs it in this process under run.lock, the way the worker would. */
export const runInline = (runtime: Runtime, jobId: number, ctx: CliContext): Promise<JobOutcome> =>
  withRunLock(runtime, ctx, async () => {
    const { stores } = runtime;
    const job = stores.jobs.claimById(jobId);
    if (job === null) return fail(ctx, `job ${jobId} is already running`);
    const attempt = stores.attempts.start(jobId);
    println(ctx, `job ${jobId} running (attempt ${attempt.number})`);
    const outcome = await execute(
      job,
      { jobId, attempt: attempt.number, issueId: job.issueId, identifier: job.identifier, teamKey: job.teamKey, trigger: job.trigger, dryRun: false },
      runtime,
    );
    if (outcome.status === "deferred") {
      stores.attempts.finish(attempt.id, {});
      stores.jobs.defer(jobId, outcome.until);
      println(ctx, `job ${jobId} waiting until ${outcome.until.toISOString()}`);
      return outcome;
    }
    stores.jobs.finish(jobId, outcome);
    stores.attempts.finish(attempt.id, attemptPatch(outcome));
    return outcome;
  });

/** Prints the outcome and exits non-zero unless the job succeeded or is waiting (deferred, already reported by `runInline`). */
export const reportOutcome = (ctx: CliContext, jobId: number, outcome: JobOutcome): void => {
  if (outcome.status === "deferred") return;
  if (outcome.status === "succeeded") {
    println(ctx, outcome.warning === undefined ? `job ${jobId} succeeded` : `job ${jobId} succeeded with warning: ${outcome.warning}`);
    return;
  }
  fail(ctx, `job ${jobId} ${outcome.status}: ${outcome.error}`);
};
