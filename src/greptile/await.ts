import type { MergeRequestInfo, MrDiscussion } from "../codehost/gitlabMr.js";
import type { PipelineDeps } from "../core/deps.js";
import { CLOSED_STATE_TYPES } from "../core/intake.js";
import type { JobOutcome, RunContext } from "../core/types.js";
import { errorMessage } from "../core/workspace.js";
import { ACTIVE_LOOP_STATES, transaction, type Loop } from "../store/index.js";
import { evaluateRound } from "./evaluate.js";
import { publishHandback, publishPassed, publishStop } from "./publish.js";
import { findSummary, openFindings } from "./summary.js";

interface Observed {
  ticketClosed: boolean;
  mr: MergeRequestInfo | null;
  discussions: MrDiscussion[];
}

const fail = (error: string): JobOutcome => ({ status: "failed", error, retryable: false });

const reload = (deps: PipelineDeps, id: number): Loop => {
  const loop = deps.stores.loops.get(id);
  if (loop === null) throw new Error(`loop ${id} not found`);
  return loop;
};

/**
 * One poll: the ticket's state, the MR (looked up by branch until found, then stored) and its discussions. Finding the MR
 * ends the MR wait, so the review and pipeline waits start their own clock at `now`.
 */
const observe = async (deps: PipelineDeps, loop: Loop, project: string, now: Date): Promise<Observed> => {
  const gitlab = deps.gitlab;
  if (gitlab === undefined) throw new Error("no GitLab client");
  const ticket = await deps.tracker.fetchTicket(loop.issueId);
  const ticketClosed = CLOSED_STATE_TYPES.includes(ticket.state.type);
  let mr: MergeRequestInfo | null;
  if (loop.projectId === null || loop.mrIid === null) {
    mr = await gitlab.findOpenMergeRequest(project, loop.branch);
    if (mr !== null) {
      deps.stores.loops.update(loop.id, { projectId: mr.projectId, mrIid: mr.iid, mrUrl: mr.webUrl, state: "awaiting_review", waitStartedAt: now.toISOString() });
    }
  } else {
    mr = await gitlab.getMergeRequest(loop.projectId, loop.mrIid);
  }
  const discussions = mr === null ? [] : await gitlab.listDiscussions(mr.projectId, mr.iid);
  return { ticketClosed, mr, discussions };
};

/** The await-review job: polls the MR, its Greptile review and its pipeline, then waits, passes, queues a fix or ends the loop. */
export const runAwaitReview = async (ctx: RunContext, deps: PipelineDeps): Promise<JobOutcome> => {
  const { config, stores } = deps;
  if (ctx.trigger.kind !== "loop") return fail("await_review needs a loop trigger");
  const settings = config.greptile;
  if (settings === undefined || deps.gitlab === undefined || config.codehost.kind !== "gitlab") {
    return fail("the Greptile loop needs greptile configured, a GitLab code host and GITLAB_TOKEN");
  }
  const loopId = ctx.trigger.loopId;
  const stored = stores.loops.get(loopId);
  if (stored === null) return fail(`loop ${loopId} not found`);
  if (!ACTIVE_LOOP_STATES.includes(stored.state)) return { status: "succeeded", warning: `loop ${loopId} is already ${stored.state}` };

  const now = deps.now();
  let observed: Observed;
  try {
    observed = await observe(deps, stored, config.codehost.project, now);
  } catch (err) {
    return { status: "failed", error: errorMessage(err), retryable: true };
  }
  // Waits count from the first poll, so a job that sat in the queue is not timed out on arrival.
  if (stored.waitStartedAt === null) stores.loops.update(loopId, { waitStartedAt: now.toISOString() });
  const loop = reload(deps, loopId);
  const { mr } = observed;
  const decision = evaluateRound({
    loop,
    settings,
    now,
    ticketClosed: observed.ticketClosed,
    mr,
    summary: mr === null ? null : findSummary(mr, observed.discussions, settings.botUsername),
    findings: openFindings(observed.discussions, settings.botUsername),
    greptileStatus: null,
  });

  switch (decision.kind) {
    case "wait":
      return { status: "deferred", until: new Date(now.getTime() + settings.pollSeconds * 1000) };
    case "passed": {
      const head = mr?.sha ?? loop.headSha;
      const last = loop.history.at(-1);
      // A retried publish must not record the passing round twice.
      if (last?.outcome !== "passed" || last.headSha !== head) {
        stores.loops.appendRound(loopId, {
          round: loop.round, headSha: head, score: decision.summary.score, pipeline: mr?.headPipeline?.status ?? null,
          fixed: 0, declined: 0, outcome: "passed",
        });
      }
      return publishPassed(deps, reload(deps, loopId), decision.summary);
    }
    case "fix":
      transaction(stores.db, () => {
        stores.loops.update(loopId, { state: "fixing", waitStartedAt: null });
        stores.jobs.enqueue({ kind: "loop", issueId: loop.issueId, identifier: loop.identifier, teamKey: loop.teamKey, loopId, step: "fix" });
      });
      return { status: "succeeded" };
    case "handback":
      return publishHandback(deps, loop, decision.reason);
    case "stop":
      return publishStop(deps, loop, decision.reason, decision.comment);
  }
};
