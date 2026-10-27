import type { PipelineDeps } from "../core/deps.js";
import { transaction, type Job } from "../store/index.js";
import type { TriggerEvent } from "../tracker/types.js";

/** Where the implement push left the ticket: the base it branched from and the worktree its brain session ran in. */
export interface LoopStart {
  baseSha: string;
  worktreeName: string;
}

/** A trigger from the implement label (on a new ticket or added later), as opposed to the CLI or a loop step. */
export const isLabelImplement = (trigger: TriggerEvent): boolean =>
  (trigger.kind === "issue.created" || trigger.kind === "issue.labeled") && trigger.action === "implement";

/**
 * Starts the Greptile fix loop for a pushed, label-triggered implement job: creates the loop at round 0 and enqueues its
 * first await. Returns the existing loop's id when the job already has one, and null when no loop applies.
 */
export const startLoop = (deps: Pick<PipelineDeps, "config" | "stores">, job: Job, start: LoopStart): number | null => {
  const { stores } = deps;
  const existing = stores.loops.forImplementJob(job.id);
  if (existing !== null) return existing.id;
  if (deps.config.greptile === undefined || !isLabelImplement(job.trigger) || job.pushedAt === null) return null;
  const { branch, commitSha } = job;
  if (branch === null || commitSha === null) return null;
  return transaction(stores.db, () => {
    const loopId = stores.loops.create({
      issueId: job.issueId,
      identifier: job.identifier,
      teamKey: job.teamKey,
      implementJobId: job.id,
      branch,
      baseSha: start.baseSha,
      headSha: commitSha,
      worktreeName: start.worktreeName,
      labelDriven: true,
      sessionId: job.sessionId,
    });
    stores.jobs.enqueue({ kind: "loop", issueId: job.issueId, identifier: job.identifier, teamKey: job.teamKey, loopId, step: "await" });
    return loopId;
  });
};
