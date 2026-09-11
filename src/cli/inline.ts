import { acquireRunLock } from "../core/lock.js";
import { publishOnly, runJob } from "../core/pipeline.js";
import type { JobOutcome, RunContext } from "../core/types.js";
import type { AttemptPatch } from "../store/index.js";
import { errorMessage, fail, println, type CliContext } from "./context.js";
import type { Runtime } from "./runtime.js";

const attemptPatch = (outcome: JobOutcome): AttemptPatch => {
  if (outcome.status === "succeeded") return outcome.warning === undefined ? {} : { error: outcome.warning };
  return { error: outcome.error };
};

const execute = async (ctx: RunContext, runtime: Runtime, publishOnlyRun: boolean): Promise<JobOutcome> => {
  try {
    return publishOnlyRun ? await publishOnly(ctx, runtime.deps) : await runJob(ctx, runtime.deps);
  } catch (err) {
    return { status: "failed", error: errorMessage(err), retryable: false };
  }
};

/** Claims the job and runs it in this process under run.lock, the way the worker would. */
export const runInline = async (runtime: Runtime, jobId: number, ctx: CliContext): Promise<JobOutcome> => {
  const { stores, loaded } = runtime;
  const lock = acquireRunLock(loaded.config.dataDir);
  if (lock === null) return fail(ctx, "another steward process holds run.lock; if `steward serve` is running, let it pick the job up");
  try {
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
  } finally {
    lock.release();
  }
};

/** Prints the outcome and exits non-zero unless the job succeeded. */
export const reportOutcome = (ctx: CliContext, jobId: number, outcome: JobOutcome): void => {
  if (outcome.status === "succeeded") {
    println(ctx, outcome.warning === undefined ? `job ${jobId} succeeded` : `job ${jobId} succeeded with warning: ${outcome.warning}`);
    return;
  }
  fail(ctx, `job ${jobId} ${outcome.status}: ${outcome.error}`);
};
