import type { PipelineDeps } from "../core/deps.js";
import type { JobOutcome } from "../core/types.js";
import { errorMessage } from "../core/workspace.js";
import { loopSubject, type Job } from "../store/index.js";
import { publishHandback } from "./publish.js";

/** One stranded loop the sweep tried to hand back, and how that went. */
export interface StrandedHandback {
  loopId: number;
  identifier: string;
  reason: string;
  outcome: JobOutcome;
}

/** The hand-back reason for a loop whose last job ended for good. */
const strandedReason = (job: Job | null): string => {
  if (job === null) return "the loop had no job left to run";
  const how = job.status === "publish_failed" ? "could not publish" : job.status;
  return `the loop's ${job.kind} job ${how}${job.error === null ? "" : `: ${job.error}`}`;
};

/**
 * Hands back every running loop that has no queued or running job, giving its last job's error as the reason: an await,
 * fix or hand-back job that failed for good leaves its loop running with nothing to move it, and intake and `steward fix`
 * both leave a running loop alone. Best effort: a hand-back that cannot publish leaves the loop stranded for the next sweep.
 */
export const handBackStranded = async (deps: PipelineDeps): Promise<StrandedHandback[]> => {
  const done: StrandedHandback[] = [];
  for (const loop of deps.stores.loops.stranded()) {
    const reason = strandedReason(deps.stores.jobs.latestForSubject(loopSubject(loop.id)));
    let outcome: JobOutcome;
    try {
      outcome = await publishHandback(deps, loop, reason);
    } catch (err) {
      outcome = { status: "publish_failed", error: errorMessage(err) };
    }
    done.push({ loopId: loop.id, identifier: loop.identifier, reason, outcome });
  }
  return done;
};
