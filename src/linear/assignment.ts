import { logger } from "../log.js";
import type { RunChannels } from "../run/channel.js";
import { ACTIVE_LOOP_STATES, transaction, type Loop, type Stores } from "../store/index.js";
import type { LinearAgentApi } from "../tracker/linear/agent.js";
import type { Tracker, TriggerEvent } from "../tracker/types.js";

/** The error of a job canceled because the steward was removed as the ticket's delegate; it is not retried. */
export const UNASSIGNED_JOB_ERROR = "the steward was removed as the ticket's delegate";

/** The job kinds that run a brain, and so take a stop once their run opens. */
const BRAIN_KINDS: readonly string[] = ["implement", "fix", "chat"];

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export interface UnassignDeps {
  stores: Pick<Stores, "db" | "jobs" | "loops">;
  channels?: Pick<RunChannels, "active" | "stop" | "stopWhenOpened">;
}

/**
 * The steward was removed as the ticket's delegate: its loop is parked (`unassigned`) and its queued jobs canceled in one
 * transaction, then its open run is stopped (or a stop held for a brain job claimed before its run opened). The loop is
 * parked first, so the stopped run finds it parked and leaves it so. The branch and MR are left as they are.
 */
export const unassignTicket = (deps: UnassignDeps, issueId: string): void => {
  const { stores, channels } = deps;
  transaction(stores.db, () => {
    const loop = stores.loops.latestForIssue(issueId);
    if (loop !== null && loop.state !== "unassigned") stores.loops.update(loop.id, { state: "unassigned", waitStartedAt: null });
    for (const job of stores.jobs.queuedForIssue(issueId)) stores.jobs.cancelQueued(job.id, UNASSIGNED_JOB_ERROR);
  });
  if (channels === undefined) return;
  const runId = channels.active(issueId);
  if (runId !== null && channels.stop(runId)) return;
  const running = stores.jobs.runningForIssue(issueId);
  if (running !== null && BRAIN_KINDS.includes(running.kind)) channels.stopWhenOpened(running.id);
};

/**
 * Picks a parked or ended loop back up (a reviving mention, or the ticket delegated to the steward again): its restart
 * step, queued once, resumes it on the open MR's head. Then `chat`, the reviving message, if any. A loop still running is
 * left as it is. Returns the chat's job id, else the queued restart's, else null. Synchronous, so intake runs it in the
 * transaction that records the delivery.
 */
export const reviveTicket = (stores: Pick<Stores, "jobs">, loop: Loop, chat: TriggerEvent | null): number | null => {
  const { issueId, identifier, teamKey } = loop;
  let restartId: number | null = null;
  if (!ACTIVE_LOOP_STATES.includes(loop.state)) {
    restartId = stores.jobs.findQueued(issueId, "restart")?.id ?? stores.jobs.enqueue({ kind: "loop", issueId, identifier, teamKey, loopId: loop.id, step: "restart" });
  }
  return chat === null ? restartId : stores.jobs.enqueue(chat);
};

export interface DelegateDeps {
  linear?: LinearAgentApi;
  /** Knows the steward app's Linear user id. */
  tracker?: Pick<Tracker, "appUserId">;
}

/** Sets the steward back as the issue's delegate after a reviving mention. Never throws: a failure is logged. */
export const restoreDelegate = async (deps: DelegateDeps, issueId: string): Promise<void> => {
  const { linear, tracker } = deps;
  if (linear === undefined || tracker === undefined) {
    logger.warn({ issueId }, "linear: no agent API to set the steward back as the delegate");
    return;
  }
  try {
    await linear.setDelegate(issueId, await tracker.appUserId());
  } catch (err) {
    logger.warn({ issueId, err: errorMessage(err) }, "linear: the steward could not be set back as the delegate");
  }
};
