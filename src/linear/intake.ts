import { latestSession } from "../chat/session.js";
import type { StewardConfig } from "../config/schema.js";
import type { Settings } from "../settings/schema.js";
import { transaction, type Loop, type Stores } from "../store/index.js";
import type { LinearEvent } from "../tracker/linear/webhook.js";
import type { TriggerEvent } from "../tracker/types.js";
import { reviveTicket } from "./assignment.js";

/**
 * What a Linear event led to. `implement`, `resume_implement`, `chat` and `wait_for_lease` enqueued a job; `steer` and
 * `stop` act on the ticket's running job, `unassign` and `revive` on its loop, and `assign_me` is answered in the panel.
 */
export type LinearIntakeAction =
  | "implement"
  | "resume_implement"
  | "chat"
  | "steer"
  | "stop"
  | "assign_me"
  | "unassign"
  | "revive"
  | "ignored"
  | "duplicate"
  | "wait_for_lease";

export interface LinearIntakeDeps {
  config: StewardConfig;
  stores: Stores;
  settings: { get(): Settings };
}

export interface LinearIntakeResult {
  action: LinearIntakeAction;
  jobId?: number;
}

/** The panel's answer to a mention on a ticket the steward never had. */
export const ASSIGN_ME_REPLY = "Assign me to the ticket to start work.";

type SessionEvent = Extract<LinearEvent, { kind: "session.created" | "session.prompted" }>;

const triggerOf = (event: SessionEvent, run: "implement" | "chat", message: string | null): TriggerEvent => ({
  kind: "linear", run, issueId: event.issueId, identifier: event.identifier, teamKey: event.teamKey, sessionId: event.sessionId, message,
  ...(event.kind === "session.prompted" ? { author: event.authorName } : {}),
});

const enqueue = (stores: Stores, event: SessionEvent, run: "implement" | "chat", message: string | null): number =>
  stores.jobs.enqueue(triggerOf(event, run, message));

/** A revive: the loop's restart queued (a running loop needs none), then the reviving chat, if any. */
const revive = (stores: Stores, loop: Loop, chat: TriggerEvent | null): LinearIntakeResult => {
  const jobId = reviveTicket(stores, loop, chat);
  return jobId === null ? { action: "revive" } : { action: "revive", jobId };
};

/** A queued or running implement: the ticket's work has started, though it has left no session yet. */
const implementPending = (stores: Stores, issueId: string): boolean => {
  const job = stores.jobs.latestOfKind(issueId, "implement");
  return job !== null && (job.status === "queued" || job.status === "running");
};

/** Something a chat can resume: the ticket's loop or a brain session, or an implement that will leave one. */
const hasWork = (stores: Stores, issueId: string, loop: Loop | null): boolean =>
  loop !== null || latestSession(stores, issueId) !== null || implementPending(stores, issueId);

/** A chat run with `message`; while a person holds the ticket in `steward chat` the claim waits for the lease to go. */
const chat = (stores: Stores, event: SessionEvent, message: string): LinearIntakeResult => {
  const jobId = enqueue(stores, event, "chat", message);
  const leased = stores.leases.active().some((lease) => lease.issueId === event.issueId);
  return { action: leased ? "wait_for_lease" : "chat", jobId };
};

/** The ticket's latest implement asked questions and nothing came after it: the reply continues that implement. */
const awaitsAnswers = (stores: Stores, issueId: string, loop: Loop | null): boolean => {
  const job = stores.jobs.latestOfKind(issueId, "implement");
  if (job === null || job.status !== "succeeded" || job.implementResult?.result?.outcome !== "needs_info") return false;
  return loop === null || loop.implementJobId < job.id;
};

/**
 * Delegated: a ticket the steward has a loop for is resumed from its MR head (never implemented twice); one it pushed a
 * branch for without a loop is left to its people; a new one is implemented.
 */
const onDelegated = (deps: LinearIntakeDeps, event: SessionEvent, loop: Loop | null): LinearIntakeResult => {
  const { stores } = deps;
  if (deps.config.implement === undefined) return { action: "ignored" };
  if (loop !== null) return revive(stores, loop, null);
  if (implementPending(stores, event.issueId)) return { action: "ignored" };
  if (stores.jobs.hasSucceeded(event.issueId, "implement")) return { action: "revive" };
  return { action: "implement", jobId: enqueue(stores, event, "implement", null) };
};

const onMention = (deps: LinearIntakeDeps, event: Extract<LinearEvent, { kind: "session.created" }>, loop: Loop | null): LinearIntakeResult => {
  const { stores } = deps;
  if (loop?.state === "unassigned") {
    return deps.settings.get()["linear.reviveByMention"] ? revive(stores, loop, triggerOf(event, "chat", event.commentBody ?? "")) : { action: "ignored" };
  }
  if (!hasWork(stores, event.issueId, loop)) return { action: "assign_me" };
  return chat(stores, event, event.commentBody ?? "");
};

const onPrompt = (deps: LinearIntakeDeps, event: Extract<LinearEvent, { kind: "session.prompted" }>, loop: Loop | null): LinearIntakeResult => {
  const { stores } = deps;
  // Unassigned, the steward answers only a mention.
  if (loop?.state === "unassigned") return { action: "ignored" };
  if (event.stop) return { action: "stop" };
  if (stores.jobs.runningForIssue(event.issueId) !== null) return { action: "steer" };
  if (awaitsAnswers(stores, event.issueId, loop)) return { action: "resume_implement", jobId: enqueue(stores, event, "implement", event.body) };
  if (!hasWork(stores, event.issueId, loop)) return { action: "assign_me" };
  return chat(stores, event, event.body);
};

const decide = (deps: LinearIntakeDeps, event: LinearEvent): LinearIntakeResult => {
  const { stores, config } = deps;
  if (!stores.deliveries.markSeen(event.deliveryId)) return { action: "duplicate" };
  const { teams } = config.tracker;
  if (teams.length > 0 && !teams.includes(event.teamKey)) return { action: "ignored" };
  if (event.kind === "issue.undelegated") return { action: "unassign" };
  // The steward's own comments and prompts reach it as events too; answering them would talk to itself.
  if (event.byApp) return { action: "ignored" };
  stores.agentSessions.record(event.sessionId, event.issueId, event.identifier);
  const loop = stores.loops.latestForIssue(event.issueId);
  if (event.kind === "session.prompted") return onPrompt(deps, event, loop);
  return event.delegated ? onDelegated(deps, event, loop) : onMention(deps, event, loop);
};

/**
 * Decides what a Linear event does and records it in one transaction: the delivery (each acted on once), the agent
 * session, and any job it enqueues. Never calls Linear; the caller answers in the panel after the webhook is answered.
 */
export const linearIntake = (deps: LinearIntakeDeps, event: LinearEvent): Promise<LinearIntakeResult> =>
  Promise.resolve(transaction(deps.stores.db, () => decide(deps, event)));
