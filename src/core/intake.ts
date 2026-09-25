import type { TriggerEvent } from "../tracker/types.js";
import { isGatewayIssue } from "./gateway.js";

export const STEWARD_BEGIN = "<!-- ticket-steward:begin -->";
export const STEWARD_END = "<!-- ticket-steward:end -->";

export type IntakeDecision = { action: "enqueue" } | { action: "attach" } | { action: "skip"; reason: string };

export const shouldEnqueue = (input: {
  event: TriggerEvent;
  allowlist: string[];
  gatewayIssues: "enrich" | "skip";
  priorSuccess: boolean;
  hasQueuedJob: boolean;
}): IntakeDecision => {
  const { event, allowlist, gatewayIssues, priorSuccess, hasQueuedJob } = input;
  if (allowlist.length > 0 && !allowlist.includes(event.teamKey)) {
    return { action: "skip", reason: `Ticket Steward is not configured for team ${event.teamKey}` };
  }
  if (event.kind === "issue.created" && gatewayIssues === "skip" && isGatewayIssue(event.description)) {
    return { action: "skip", reason: `${event.identifier} was created by ticket-gateway, which enriches its own tickets (tracker.gatewayIssues: skip)` };
  }
  if (event.kind === "issue.created" && priorSuccess) {
    return { action: "skip", reason: `${event.identifier} was already enriched` };
  }
  if (event.kind === "issue.created" && event.description.includes(STEWARD_BEGIN)) {
    return { action: "skip", reason: `${event.identifier} already carries an Enrichment section` };
  }
  if (hasQueuedJob) return { action: "attach" };
  return { action: "enqueue" };
};
