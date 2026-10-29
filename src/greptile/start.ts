import type { MergeRequestInfo } from "../codehost/gitlabMr.js";
import { reviewConfigOf } from "../config/schema.js";
import type { PipelineDeps } from "../core/deps.js";
import type { JobOutcome, RunContext } from "../core/types.js";
import { errorMessage } from "../core/workspace.js";
import { linearSessionFor } from "../linear/session.js";
import { ACTIVE_LOOP_STATES, transaction, type Job, type Loop } from "../store/index.js";
import type { TriggerEvent } from "../tracker/types.js";

/** Where the implement push left the ticket: the base it branched from and the worktree its brain session ran in. */
export interface LoopStart {
  baseSha: string;
  worktreeName: string;
}

/** An implement from Linear (delegation, or the label trigger before it), as opposed to the CLI or a loop step. */
export const isLinearImplement = (trigger: TriggerEvent): boolean => trigger.kind === "linear" && trigger.run === "implement";

/**
 * Starts the review loop for a pushed implement job from Linear: creates the loop at round 0 and enqueues its
 * first await. Returns the existing loop's id when the job already has one, and null when no loop applies.
 */
export const startLoop = (deps: Pick<PipelineDeps, "config" | "stores">, job: Job, start: LoopStart): number | null => {
  const { stores } = deps;
  const existing = stores.loops.forImplementJob(job.id);
  if (existing !== null) return existing.id;
  if (reviewConfigOf(deps.config) === null || !isLinearImplement(job.trigger) || job.pushedAt === null) return null;
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

type RestartDeps = Pick<PipelineDeps, "config" | "stores" | "gitlab" | "redactor" | "linear" | "settings">;

const fail = (error: string): JobOutcome => ({ status: "failed", error, retryable: false });

/** Back to `awaiting_review` at round 0 on the open MR, adopting its head; the history and hand-back time are kept. */
const resumeLoop = (deps: RestartDeps, loop: Loop, mr: MergeRequestInfo): JobOutcome => {
  const { stores } = deps;
  transaction(stores.db, () => {
    stores.loops.update(loop.id, {
      state: "awaiting_review",
      round: 0,
      adoptedFrom: mr.sha === loop.headSha ? null : loop.headSha,
      headSha: mr.sha,
      projectId: mr.projectId,
      mrIid: mr.iid,
      mrUrl: mr.webUrl,
      waitStartedAt: null,
      reviewCountAtTrigger: null,
      endedAt: null,
    });
    stores.jobs.enqueue({ kind: "loop", issueId: loop.issueId, identifier: loop.identifier, teamKey: loop.teamKey, loopId: loop.id, step: "await" });
  });
  return { status: "succeeded" };
};

/** No open MR to resume on: the loop stops, and the panel says why. It never starts a second implement. */
const stopWithoutMr = async (deps: RestartDeps, loop: Loop): Promise<JobOutcome> => {
  const reason = `there is no open merge request for ${loop.branch}`;
  deps.stores.loops.update(loop.id, { state: "stopped" });
  await linearSessionFor(deps, loop.issueId).finish({ type: "response", body: `I could not pick the work back up: ${reason}.` });
  return { status: "succeeded", warning: `stopped: ${reason}` };
};

/**
 * The restart step, queued when a parked or ended loop is revived (a mention, or the ticket delegated to the steward
 * again): the loop resumes on its open MR's head, or stops when there is none. A loop already running is left alone.
 */
export const runRestart = async (ctx: RunContext, deps: RestartDeps): Promise<JobOutcome> => {
  const { config, gitlab } = deps;
  if (ctx.trigger.kind !== "loop") return fail("restart needs a loop trigger");
  if (reviewConfigOf(config) === null || gitlab === undefined || config.codehost.kind !== "gitlab") {
    return fail("the review loop needs reviewLoop configured, a GitLab code host and GITLAB_TOKEN");
  }
  const loopId = ctx.trigger.loopId;
  const loop = deps.stores.loops.get(loopId);
  if (loop === null) return fail(`loop ${loopId} not found`);
  if (ACTIVE_LOOP_STATES.includes(loop.state)) return { status: "succeeded", warning: `loop ${loopId} is ${loop.state}, already running` };
  let mr: MergeRequestInfo | null;
  try {
    mr = await gitlab.findOpenMergeRequest(config.codehost.project, loop.branch);
  } catch (err) {
    return { status: "failed", error: errorMessage(err), retryable: true };
  }
  return mr === null ? stopWithoutMr(deps, loop) : resumeLoop(deps, loop, mr);
};
