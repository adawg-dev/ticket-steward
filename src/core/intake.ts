import type { IssueTrigger } from "../tracker/types.js";
import { ACTIVE_LOOP_STATES, type Loop } from "../store/loops.js";
import { isGatewayIssue } from "./gateway.js";

export const STEWARD_BEGIN = "<!-- ticket-steward:begin -->";
export const STEWARD_END = "<!-- ticket-steward:end -->";

/** Linear state types for Done and Canceled; the steward never enriches a ticket in either. */
export const CLOSED_STATE_TYPES: readonly string[] = ["completed", "canceled"];

export type IssueJobKind = "enrich" | "implement";

export const jobKindFor = (event: IssueTrigger): IssueJobKind => (event.action === "implement" ? "implement" : "enrich");

export const closedReason = (identifier: string, state: { name: string; type: string }): string | null =>
  CLOSED_STATE_TYPES.includes(state.type) ? `${identifier} is ${state.name}; Ticket Steward does not work on Done or Canceled tickets` : null;

export type IntakeDecision = { action: "enqueue" } | { action: "restart" } | { action: "attach" } | { action: "skip"; reason: string };

export const shouldEnqueue = (input: {
  event: IssueTrigger;
  allowlist: string[];
  gatewayIssues: "enrich" | "skip";
  priorSuccess: boolean;
  hasQueuedJob: boolean;
  /** The ticket's latest fix loop (`loops.latestForIssue`), if it has had one. */
  loop: Pick<Loop, "state"> | null;
}): IntakeDecision => {
  const { event, allowlist, gatewayIssues, priorSuccess, hasQueuedJob, loop } = input;
  if (allowlist.length > 0 && !allowlist.includes(event.teamKey)) {
    return { action: "skip", reason: `Ticket Steward is not configured for team ${event.teamKey}` };
  }
  if (event.kind === "cli") return hasQueuedJob ? { action: "attach" } : { action: "enqueue" };
  if (event.stateType !== null && CLOSED_STATE_TYPES.includes(event.stateType)) {
    return { action: "skip", reason: `${event.identifier} is closed (completed or canceled)` };
  }
  if (jobKindFor(event) === "implement") {
    if (loop !== null && ACTIVE_LOOP_STATES.includes(loop.state)) return { action: "skip", reason: `${event.identifier} already has a fix loop running` };
    // A handed-back loop is restarted rather than skipped as "already implemented"; a queued restart absorbs repeat labels.
    if (loop?.state === "handed_back") return hasQueuedJob ? { action: "attach" } : { action: "restart" };
    if (priorSuccess) return { action: "skip", reason: `${event.identifier} was already implemented` };
    return hasQueuedJob ? { action: "attach" } : { action: "enqueue" };
  }
  if (gatewayIssues === "skip" && isGatewayIssue(event.description)) {
    return { action: "skip", reason: `${event.identifier} was created by ticket-gateway, which enriches its own tickets (tracker.gatewayIssues: skip)` };
  }
  if (priorSuccess) {
    return { action: "skip", reason: `${event.identifier} was already enriched` };
  }
  if (event.description.includes(STEWARD_BEGIN)) {
    return { action: "skip", reason: `${event.identifier} already carries an Enrichment section` };
  }
  if (hasQueuedJob) return { action: "attach" };
  return { action: "enqueue" };
};
