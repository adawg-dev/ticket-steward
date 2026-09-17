import { acquireRunLock } from "../core/lock.js";
import { publishOnly, redactOutcome, runJob } from "../core/pipeline.js";
import type { JobOutcome, RunContext } from "../core/types.js";
import type { AttemptPatch, JobStatus, Stores } from "../store/index.js";
import { errorMessage, fail, println, type CliContext } from "./context.js";
import { sleep } from "./probe.js";
import type { Runtime } from "./runtime.js";

const POLL_MS = 2_000;
const LOCK_HELD = "another steward process holds run.lock; if `steward serve` is running, let it pick the job up";

const attemptPatch = (outcome: JobOutcome): AttemptPatch => {
  if (outcome.status === "succeeded") return outcome.warning === undefined ? {} : { error: outcome.warning };
  return { error: outcome.error };
};

const execute = async (ctx: RunContext, runtime: Runtime, publishOnlyRun: boolean): Promise<JobOutcome> => {
  try {
    const outcome = publishOnlyRun ? await publishOnly(ctx, runtime.deps) : await runJob(ctx, runtime.deps);
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
      { jobId, attempt: attempt.number, issueId: job.issueId, identifier: job.identifier, teamKey: job.teamKey, trigger: job.trigger, dryRun: false },
      runtime,
      job.result !== null,
    );
    stores.jobs.finish(jobId, outcome);
    stores.attempts.finish(attempt.id, attemptPatch(outcome));
    return outcome;
  });

/** Prints the outcome and exits non-zero unless the job succeeded. */
export const reportOutcome = (ctx: CliContext, jobId: number, outcome: JobOutcome): void => {
  if (outcome.status === "succeeded") {
    println(ctx, outcome.warning === undefined ? `job ${jobId} succeeded` : `job ${jobId} succeeded with warning: ${outcome.warning}`);
    return;
  }
  fail(ctx, `job ${jobId} ${outcome.status}: ${outcome.error}`);
};
