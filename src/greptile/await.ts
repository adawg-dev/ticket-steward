import type { MergeRequestInfo, MrDiscussion } from "../codehost/gitlabMr.js";
import type { PipelineDeps } from "../core/deps.js";
import { CLOSED_STATE_TYPES } from "../core/intake.js";
import type { JobOutcome, RunContext } from "../core/types.js";
import { errorMessage } from "../core/workspace.js";
import { logger } from "../log.js";
import { buildImplementSummary } from "../implement/publish.js";
import { ACTIVE_LOOP_STATES, transaction, type Loop } from "../store/index.js";
import { linearSessionFor, mergeRequestOpened } from "../linear/session.js";
import { seedSettings, type Settings } from "../settings/schema.js";
import { evaluateRound, startedBy, workList, type RoundInput } from "./evaluate.js";
import { LOOP_MARKER, noteOnce, publishHandback, publishPassed, publishStop } from "./publish.js";
import { findSummary } from "./summary.js";
import { triageFailures, type Triage } from "./triage.js";

interface Observed {
  ticketClosed: boolean;
  mr: MergeRequestInfo | null;
  discussions: MrDiscussion[];
  /** The steward's GitLab account, whose notes answer a discussion; null while there is no MR. */
  steward: string | null;
}

const fail = (error: string): JobOutcome => ({ status: "failed", error, retryable: false });

const reload = (deps: PipelineDeps, id: number): Loop => {
  const loop = deps.stores.loops.get(id);
  if (loop === null) throw new Error(`loop ${id} not found`);
  return loop;
};

/**
 * One poll: the ticket's state, the MR (looked up by branch until found, then stored), its discussions and the steward's
 * account. Finding the MR
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
      // Once, as the loop first finds it: the agent session links the MR and the ticket moves to review.
      await mergeRequestOpened(deps, loop.issueId, mr.webUrl);
    }
  } else {
    mr = await gitlab.getMergeRequest(loop.projectId, loop.mrIid);
  }
  const discussions = mr === null ? [] : await gitlab.listDiscussions(mr.projectId, mr.iid);
  const steward = mr === null ? null : (await gitlab.currentUser()).username;
  return { ticketClosed, mr, discussions, steward };
};

/**
 * The implement job's summary, posted on the MR the first poll that finds it (Linear gets no comments). Checked against the
 * discussions already read, so later polls cost nothing; a loop whose implement job stored no result posts nothing.
 */
const postImplementSummary = async (deps: PipelineDeps, loop: Loop, discussions: MrDiscussion[]): Promise<void> => {
  const marker = LOOP_MARKER(loop.id, "implement-summary");
  if (discussions.some((discussion) => discussion.notes.some((note) => note.body.includes(marker)))) return;
  const stored = deps.stores.jobs.get(loop.implementJobId)?.implementResult ?? null;
  if (stored === null || stored.result === null || stored.handback !== null) return;
  const media = stored.media === undefined ? {} : { media: stored.media };
  await noteOnce(deps, loop, marker, buildImplementSummary({ jobId: loop.implementJobId, identifier: loop.identifier, result: stored.result, ...media }));
};

/** The next poll: one interval out, but no later than just past the wait's deadline, so a timeout never overruns by a poll. */
const nextPoll = (now: Date, pollSeconds: number, deadline: Date | null): Date => {
  const interval = now.getTime() + pollSeconds * 1000;
  return new Date(deadline === null ? interval : Math.min(interval, deadline.getTime() + 1));
};

/**
 * CI triage of the head's red pipeline: when every failed job is an infrastructure failure or looks flaky, they are
 * retried and the loop waits for the pipeline again (a fresh wait), with no round counted; the MR and the agent panel say
 * what was retried. Null when nothing was retried, and the round goes on.
 */
const retryFailures = async (
  deps: PipelineDeps, loop: Loop, mr: MergeRequestInfo, pipelineId: number, settings: Settings, now: Date, pollSeconds: number,
): Promise<JobOutcome | null> => {
  const gitlab = deps.gitlab;
  if (gitlab === undefined) throw new Error("no GitLab client");
  let triage: Triage;
  try {
    const failed = await gitlab.failedJobs(mr.projectId, pipelineId);
    const orbit = (await deps.orbit?.()) ?? null;
    const target = { project: mr.projectId, pipelineId, sha: mr.sha, defaultBranch: mr.targetBranch, branch: loop.branch };
    triage = await triageFailures({ gitlab, orbit, settings, now }, loop, failed, target);
    if (triage.retry.length === 0) return null;
    // Recorded first, so a retry that fails partway never retries a job past its limit.
    deps.stores.loops.update(loop.id, { ciRetries: triage.ciRetries, waitStartedAt: now.toISOString() });
    for (const job of triage.retry) await gitlab.retryJob(mr.projectId, job.id);
  } catch (err) {
    return { status: "failed", error: errorMessage(err), retryable: true };
  }
  // The jobs are retried: telling the MR and the panel is best effort, since a rerun of this job would find the pipeline running.
  const { notes, ciRetries } = triage;
  try {
    const counts = triage.retry.map((job) => `${job.name}:${ciRetries[job.name]?.infra ?? 0}/${ciRetries[job.name]?.flaky ?? 0}`);
    await noteOnce(deps, reload(deps, loop.id), LOOP_MARKER(loop.id, `ci-retry head=${mr.sha.slice(0, 7)} ${counts.join(",")}`), notes.join("\n\n"));
  } catch (err) {
    logger.warn({ loopId: loop.id, err: errorMessage(err) }, "ci triage: the merge request could not be told about the retries");
  }
  try {
    const panel = linearSessionFor(deps, loop.issueId);
    for (const note of notes) panel.thought(note);
    await panel.poster?.flush();
  } catch (err) {
    logger.warn({ loopId: loop.id, err: errorMessage(err) }, "ci triage: the agent panel could not be told about the retries");
  }
  return { status: "deferred", until: nextPoll(now, pollSeconds, null) };
};

/**
 * The await-review job: polls the MR, its discussions, its Greptile review (when on) and its pipeline, then waits, passes,
 * queues a fix or ends the loop. A fix round started by bots alone (or a red pipeline) counts toward the bot-round cap; one
 * a person started resets it.
 */
export const runAwaitReview = async (ctx: RunContext, deps: PipelineDeps): Promise<JobOutcome> => {
  const { config, stores } = deps;
  if (ctx.trigger.kind !== "loop") return fail("await_review needs a loop trigger");
  const greptile = config.greptile;
  if (greptile === undefined || deps.gitlab === undefined || config.codehost.kind !== "gitlab") {
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
    if (observed.mr?.state === "opened") await postImplementSummary(deps, reload(deps, loopId), observed.discussions);
  } catch (err) {
    return { status: "failed", error: errorMessage(err), retryable: true };
  }
  // Waits count from the first poll, so a job that sat in the queue is not timed out on arrival.
  if (stored.waitStartedAt === null) stores.loops.update(loopId, { waitStartedAt: now.toISOString() });
  const loop = reload(deps, loopId);
  // Parked (the steward was unassigned) while this poll read GitLab: nothing more for it to do.
  if (!ACTIVE_LOOP_STATES.includes(loop.state)) return { status: "succeeded", warning: `loop ${loopId} is already ${loop.state}` };
  const { mr } = observed;
  const settings = deps.settings?.get() ?? seedSettings(config);
  const work = observed.steward === null ? [] : workList(observed.discussions, observed.steward, [greptile.botUsername]);
  const input: RoundInput = {
    loop,
    config: greptile,
    settings,
    now,
    ticketClosed: observed.ticketClosed,
    mr,
    greptile: mr === null ? null : findSummary(mr, observed.discussions, greptile.botUsername),
    workList: work,
    startedBy: startedBy(work),
    greptileStatus: null,
    ciTriaged: false,
  };
  let decision = evaluateRound(input);
  // A red pipeline whose failures were all retried waits for its rerun: no round, and the bot-round cap is not reached.
  if (decision.kind === "triage" && mr !== null) {
    const retried = await retryFailures(deps, loop, mr, decision.pipelineId, settings, now, greptile.pollSeconds);
    if (retried !== null) return retried;
    decision = evaluateRound({ ...input, ciTriaged: true });
  }

  switch (decision.kind) {
    case "wait":
      return { status: "deferred", until: nextPoll(now, greptile.pollSeconds, decision.deadline) };
    case "passed": {
      const head = mr?.sha ?? loop.headSha;
      const last = loop.history.at(-1);
      // A retried publish must not record the passing round twice.
      if (last?.outcome !== "passed" || last.headSha !== head) {
        stores.loops.appendRound(loopId, {
          round: loop.round, headSha: head, score: decision.summary?.score ?? null, pipeline: mr?.headPipeline?.status ?? null,
          fixed: 0, declined: 0, outcome: "passed",
        });
      }
      return publishPassed(deps, reload(deps, loopId), decision.summary);
    }
    case "fix":
      transaction(stores.db, () => {
        stores.loops.update(loopId, { state: "fixing", waitStartedAt: null, botRounds: decision.startedBy === "bot" ? loop.botRounds + 1 : 0 });
        stores.jobs.enqueue({ kind: "loop", issueId: loop.issueId, identifier: loop.identifier, teamKey: loop.teamKey, loopId, step: "fix" });
      });
      return { status: "succeeded" };
    case "triage":
      return fail("CI triage did not settle the round");
    case "handback":
      return publishHandback(deps, loop, decision.reason);
    case "stop":
      return publishStop(deps, loop, decision.reason, decision.note);
  }
};
