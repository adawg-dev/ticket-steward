import type { IssueTrigger } from "../tracker/types.js";
import { ACTIVE_LOOP_STATES, type Loop } from "../store/loops.js";

/** Linear state types for Done and Canceled; the steward never works on a ticket in either. */
export const CLOSED_STATE_TYPES: readonly string[] = ["completed", "canceled"];

export const closedReason = (identifier: string, state: { name: string; type: string }): string | null =>
  CLOSED_STATE_TYPES.includes(state.type) ? `${identifier} is ${state.name}; Ticket Steward does not work on Done or Canceled tickets` : null;

export type IntakeDecision = { action: "enqueue" } | { action: "restart" } | { action: "attach" } | { action: "skip"; reason: string };

export const shouldEnqueue = (input: {
  event: IssueTrigger;
  allowlist: string[];
  priorSuccess: boolean;
  hasQueuedJob: boolean;
  /** The ticket's latest fix loop (`loops.latestForIssue`), if it has had one. */
  loop: Pick<Loop, "state"> | null;
}): IntakeDecision => {
  const { event, allowlist, priorSuccess, hasQueuedJob, loop } = input;
  if (allowlist.length > 0 && !allowlist.includes(event.teamKey)) {
    return { action: "skip", reason: `Ticket Steward is not configured for team ${event.teamKey}` };
  }
  if (event.kind === "cli") return hasQueuedJob ? { action: "attach" } : { action: "enqueue" };
  // Only the implement label starts work; a ticket created without it is left alone.
  if (event.action !== "implement") return { action: "skip", reason: "no implement label" };
  if (event.stateType !== null && CLOSED_STATE_TYPES.includes(event.stateType)) {
    return { action: "skip", reason: `${event.identifier} is closed (completed or canceled)` };
  }
  if (loop !== null && ACTIVE_LOOP_STATES.includes(loop.state)) return { action: "skip", reason: `${event.identifier} already has a fix loop running` };
  // A handed-back loop is restarted rather than skipped as "already implemented"; a queued restart absorbs repeat labels.
  if (loop?.state === "handed_back") return hasQueuedJob ? { action: "attach" } : { action: "restart" };
  if (priorSuccess) return { action: "skip", reason: `${event.identifier} was already implemented` };
  return hasQueuedJob ? { action: "attach" } : { action: "enqueue" };
};
