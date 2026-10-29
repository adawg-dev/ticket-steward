import type { MergeRequestInfo } from "../codehost/gitlabMr.js";
import type { PipelineDeps } from "../core/deps.js";
import type { JobOutcome, RunContext } from "../core/types.js";
import { errorMessage } from "../core/workspace.js";
import { transaction, type Job, type Loop } from "../store/index.js";
import type { TriggerEvent } from "../tracker/types.js";
import { LOOP_MARKER, noteOnce } from "./publish.js";

/** Where the implement push left the ticket: the base it branched from and the worktree its brain session ran in. */
export interface LoopStart {
  baseSha: string;
  worktreeName: string;
}

/** An implement from Linear (delegation, or the label trigger before it), as opposed to the CLI or a loop step. */
export const isLinearImplement = (trigger: TriggerEvent): boolean => trigger.kind === "linear" && trigger.run === "implement";

/**
 * Starts the Greptile fix loop for a pushed implement job from Linear: creates the loop at round 0 and enqueues its
 * first await. Returns the existing loop's id when the job already has one, and null when no loop applies.
 */
export const startLoop = (deps: Pick<PipelineDeps, "config" | "stores">, job: Job, start: LoopStart): number | null => {
  const { stores } = deps;
  const existing = stores.loops.forImplementJob(job.id);
  if (existing !== null) return existing.id;
  if (deps.config.greptile === undefined || !isLinearImplement(job.trigger) || job.pushedAt === null) return null;
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

type RestartDeps = Pick<PipelineDeps, "config" | "stores" | "gitlab" | "redactor">;

const fail = (error: string): JobOutcome => ({ status: "failed", error, retryable: false });

/** Back to `awaiting_review` at round 0 on the open MR, adopting its head; the history and hand-back time are kept. */
const resumeLoop = async (deps: RestartDeps, loop: Loop, mr: MergeRequestInfo, labelDriven: boolean): Promise<JobOutcome> => {
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
      labelDriven,
    });
    stores.jobs.enqueue({ kind: "loop", issueId: loop.issueId, identifier: loop.identifier, teamKey: loop.teamKey, loopId: loop.id, step: "await" });
  });
  return { status: "succeeded" };
};

/**
 * No open MR to resume on: says so on the loop's last MR, if it had one, and queues an implement, which hands back with "a branch already exists"
 * while the branch is there. A label restart queues a Linear implement in the ticket's current agent session; a CLI one otherwise.
 */
const restartImplement = async (deps: RestartDeps, ctx: RunContext, loop: Loop, labelDriven: boolean): Promise<JobOutcome> => {
  try {
    await noteOnce(deps, loop, LOOP_MARKER(loop.id, `restart job=${ctx.jobId}`), `No open merge request for ${loop.branch}; Ticket Steward is starting a fresh implement.`);
  } catch (err) {
    return { status: "failed", error: `merge request note: ${errorMessage(err)}`, retryable: true };
  }
  const { issueId, identifier, teamKey } = loop;
  const trigger: TriggerEvent = labelDriven
    ? { kind: "linear", run: "implement", issueId, identifier, teamKey, sessionId: deps.stores.agentSessions.current(issueId), message: null }
    : { kind: "cli", issueId, identifier, teamKey, action: "implement" };
  deps.stores.jobs.enqueue(trigger);
  return { status: "succeeded" };
};

/** The restart job: resumes a handed-back loop on its open MR, or falls back to a fresh implement when there is none. */
export const runRestart = async (ctx: RunContext, deps: RestartDeps): Promise<JobOutcome> => {
  const { config, gitlab } = deps;
  if (ctx.trigger.kind !== "loop") return fail("restart needs a loop trigger");
  if (config.greptile === undefined || gitlab === undefined || config.codehost.kind !== "gitlab") {
    return fail("the Greptile loop needs greptile configured, a GitLab code host and GITLAB_TOKEN");
  }
  const loopId = ctx.trigger.loopId;
  const loop = deps.stores.loops.get(loopId);
  if (loop === null) return fail(`loop ${loopId} not found`);
  if (loop.state !== "handed_back") return { status: "succeeded", warning: `loop ${loopId} is ${loop.state}, not handed back` };
  const labelDriven = ctx.trigger.labelDriven === true;
  let mr: MergeRequestInfo | null;
  try {
    mr = await gitlab.findOpenMergeRequest(config.codehost.project, loop.branch);
  } catch (err) {
    return { status: "failed", error: errorMessage(err), retryable: true };
  }
  return mr === null ? restartImplement(deps, ctx, loop, labelDriven) : resumeLoop(deps, loop, mr, labelDriven);
};
