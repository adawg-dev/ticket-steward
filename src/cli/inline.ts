import { acquireRunLock } from "../core/lock.js";
import type { JobOutcome } from "../core/types.js";
import type { JobStatus, Stores } from "../store/index.js";
import { fail, println, type CliContext } from "./context.js";
import { sleep } from "./probe.js";
import type { Runtime } from "./runtime.js";

/** How often a tailed job is read again. */
export const TAIL_POLL_MS = 2_000;
const LOCK_HELD = "another steward process holds run.lock; if `steward serve` is running, let it pick the job up";

/** The outcome a finished job ended with; null while it is queued or running. */
export const terminalOutcome = (status: string, error: string | null): JobOutcome | null => {
  if (status === "succeeded") return { status };
  if (status === "publish_failed") return { status, error: error ?? status };
  if (status === "failed" || status === "skipped") return { status: "failed", error: error ?? status, retryable: false };
  return null;
};

/** Runs `fn` under run.lock; fails the command when another steward process holds it. */
export const withRunLock = async <T>(runtime: Pick<Runtime, "loaded">, ctx: CliContext, fn: () => Promise<T>): Promise<T> => {
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
    await sleep(TAIL_POLL_MS);
  }
};

/** Prints the outcome and exits non-zero unless the job succeeded or is waiting (deferred). */
export const reportOutcome = (ctx: CliContext, jobId: number, outcome: JobOutcome): void => {
  if (outcome.status === "deferred") return;
  if (outcome.status === "succeeded") {
    println(ctx, outcome.warning === undefined ? `job ${jobId} succeeded` : `job ${jobId} succeeded with warning: ${outcome.warning}`);
    return;
  }
  fail(ctx, `job ${jobId} ${outcome.status}: ${outcome.error}`);
};
