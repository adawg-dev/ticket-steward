import type { IssueTrigger } from "../tracker/types.js";
import { isGatewayIssue } from "./gateway.js";

export const STEWARD_BEGIN = "<!-- ticket-steward:begin -->";
export const STEWARD_END = "<!-- ticket-steward:end -->";

/** Linear state types for Done and Canceled; the steward never enriches a ticket in either. */
export const CLOSED_STATE_TYPES: readonly string[] = ["completed", "canceled"];

export type IntakeDecision = { action: "enqueue" } | { action: "attach" } | { action: "skip"; reason: string };

export const shouldEnqueue = (input: {
  event: IssueTrigger;
  allowlist: string[];
  gatewayIssues: "enrich" | "skip";
  priorSuccess: boolean;
  hasQueuedJob: boolean;
}): IntakeDecision => {
  const { event, allowlist, gatewayIssues, priorSuccess, hasQueuedJob } = input;
  if (allowlist.length > 0 && !allowlist.includes(event.teamKey)) {
    return { action: "skip", reason: `Ticket Steward is not configured for team ${event.teamKey}` };
  }
  if (event.kind === "cli") return hasQueuedJob ? { action: "attach" } : { action: "enqueue" };
  if (event.stateType !== null && CLOSED_STATE_TYPES.includes(event.stateType)) {
    return { action: "skip", reason: `${event.identifier} is closed (completed or canceled)` };
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
