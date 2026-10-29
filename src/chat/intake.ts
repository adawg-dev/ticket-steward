import type { GitLabMrApi } from "../codehost/gitlabMr.js";
import { fromOwnProject, type GitlabNote, type GitlabWakeEvent } from "../codehost/gitlabWebhook.js";
import { DEVELOPER_ACCESS, isTrustedBot, looksLikeBot } from "../codehost/mrAuthors.js";
import type { StewardConfig } from "../config/schema.js";
import { errorMessage } from "../core/workspace.js";
import { isUnassigned, restoreDelegate, reviveTicket, type DelegateDeps } from "../linear/assignment.js";
import { logger } from "../log.js";
import type { RunChannels } from "../run/channel.js";
import { DEFAULT_SETTINGS, type Settings } from "../settings/schema.js";
import { ACTIVE_LOOP_STATES, loopSubject, transaction, type Loop, type LoopState, type Stores } from "../store/index.js";
import type { TriggerEvent } from "../tracker/types.js";
import { CHAT_MARKER, NO_SESSION_REPLY } from "./result.js";
import { latestSession } from "./session.js";

export type ChatAction = "chat" | "chat_revive" | "chat_denied" | "chat_ignored" | "chat_duplicate" | "chat_no_session" | "chat_failed";

/** With `linear` and `tracker`, a note that revives an unassigned loop sets the steward back as the issue's delegate. */
export interface ChatIntakeDeps extends DelegateDeps {
  config: StewardConfig;
  stores: Stores;
  gitlab?: GitLabMrApi;
  /** `linear.reviveByMention` off, a note on an unassigned loop is not acted on; absent, its default (on) applies. */
  settings?: { get(): Settings };
}

/**
 * The message after `prefix` when the note's first line starts with it (case-insensitive, after trimming, as a whole
 * word), else null. The message keeps the rest of the first line and every later line.
 */
export const addressedMessage = (body: string, prefix: string): string | null => {
  const text = body.trim();
  if (!text.toLowerCase().startsWith(prefix.toLowerCase())) return null;
  const rest = text.slice(prefix.length);
  if (rest !== "" && !/^\s/.test(rest)) return null;
  return rest.trim();
};

/** The delivery key of a note: a note id is seen once, whether GitLab sends it again or the note is edited. */
export const noteDeliveryKey = (noteId: number): string => `gitlab-note:${noteId}`;

/** Bots the steward listens to whatever their membership: the configured Greptile user. */
const trustedBots = (config: StewardConfig): string[] => (config.greptile === undefined ? [] : [config.greptile.botUsername]);

/** Looks like a bot (GitLab's flag, a project/group bot name, a trusted name): it never starts a chat. */
const fromBot = (config: StewardConfig, note: GitlabNote): boolean =>
  looksLikeBot({ username: note.authorUsername, bot: note.authorIsBot }, trustedBots(config));

/** The steward's GitLab username, read once per client. */
const stewardNames = new WeakMap<GitLabMrApi, string>();

/**
 * GitLab wrote it (a system note) or the steward's own account did. A hidden steward marker on anyone else's note
 * counts for nothing. Null when the steward's account could not be read.
 */
const fromSteward = async (gitlab: GitLabMrApi, note: GitlabNote): Promise<boolean | null> => {
  if (note.system) return true;
  let steward = stewardNames.get(gitlab);
  if (steward === undefined) {
    try {
      steward = (await gitlab.currentUser()).username;
    } catch (err) {
      logger.warn({ noteId: note.id, err: errorMessage(err) }, "note: the steward's GitLab account could not be read");
      return null;
    }
    stewardNames.set(gitlab, steward);
  }
  return note.authorUsername.toLowerCase() === steward.toLowerCase();
};

/** The configured project, and the MR's own branch: a fork's MR never reaches a steward branch's ticket. */
const isOurProject = (event: GitlabWakeEvent, project: string): boolean =>
  (event.projectPath === project || String(event.projectId) === project) && fromOwnProject(event);

interface Ticket {
  issueId: string;
  identifier: string;
  teamKey: string;
  loop: Loop | null;
}

/**
 * The ticket whose steward branch is the MR's source branch: its loop's, else its implement job's. A loop that knows its
 * MR claims only that MR's notes: another MR from a branch of the same name is not the ticket's.
 */
const ticketOf = (stores: Stores, event: GitlabWakeEvent): Ticket | null => {
  const loop = stores.loops.latestForBranch(event.branch);
  if (loop !== null && (loop.projectId === null || loop.projectId === event.projectId)) {
    if (loop.mrIid !== null && event.mrIid !== null && loop.mrIid !== event.mrIid) return null;
    return { issueId: loop.issueId, identifier: loop.identifier, teamKey: loop.teamKey, loop };
  }
  const job = stores.jobs.latestImplementForBranch(event.branch);
  return job === null ? null : { issueId: job.issueId, identifier: job.identifier, teamKey: job.teamKey, loop: null };
};

/** Says once, in the note's discussion, that the MR has no agent session to talk to. */
const replyNoSession = async (gitlab: GitLabMrApi, event: GitlabWakeEvent, mrIid: number, note: GitlabNote): Promise<void> => {
  const body = `${NO_SESSION_REPLY}\n\n${CHAT_MARKER}`;
  if (note.discussionId === null) await gitlab.createNote(event.projectId, mrIid, body);
  else await gitlab.replyToDiscussion(event.projectId, mrIid, note.discussionId, body);
};

/**
 * A `chat.prefix` note from a Developer (or higher) on a steward MR: enqueues a `chat` job. On an unassigned loop it is
 * the mention that revives it: the loop's restart step resumes it on the MR head, the chat follows, and the steward is set
 * back as the issue's delegate. Null when the event is not a chat request at all, so the caller handles it as a plain
 * wake. Only GitLab is called before the note id is recorded; each note id is acted on once.
 */
export const chatIntake = async (deps: ChatIntakeDeps, event: GitlabWakeEvent): Promise<{ action: ChatAction; loopId: number | null } | null> => {
  const { config, stores, gitlab } = deps;
  const chat = config.chat;
  const note = event.note;
  if (chat === undefined || gitlab === undefined || config.codehost.kind !== "gitlab") return null;
  if (event.kind !== "note" || note === undefined || event.mrIid === null) return null;
  const message = addressedMessage(note.body, chat.prefix);
  if (message === null || !isOurProject(event, config.codehost.project)) return null;
  const mrIid = event.mrIid;
  // A bare prefix asks nothing; resuming the agent on an empty message would only spend a run. Bots never start a chat.
  if (fromBot(config, note) || message.trim() === "") return { action: "chat_ignored", loopId: null };
  const steward = await fromSteward(gitlab, note);
  if (steward === null) return { action: "chat_failed", loopId: null };
  if (steward) return { action: "chat_ignored", loopId: null };
  if (stores.deliveries.seen(noteDeliveryKey(note.id))) return { action: "chat_duplicate", loopId: null };

  let level: number | null;
  try {
    level = await gitlab.memberAccessLevel(event.projectId, note.authorId);
  } catch (err) {
    logger.warn({ noteId: note.id, err: errorMessage(err) }, "chat: member access could not be read");
    return { action: "chat_failed", loopId: null };
  }
  if (level === null || level < DEVELOPER_ACCESS) return { action: "chat_denied", loopId: null };

  const ticket = ticketOf(stores, event);
  const loop = ticket?.loop ?? null;
  // Removed as the delegate, with or without a loop: the note is the mention that revives the ticket.
  const parked = ticket !== null && isUnassigned(stores, ticket.issueId, loop);
  if (parked && deps.settings?.get()["linear.reviveByMention"] === false) return { action: "chat_ignored", loopId: loop?.id ?? null };
  if (ticket === null || latestSession(stores, ticket.issueId) === null) {
    if (!stores.deliveries.markSeen(noteDeliveryKey(note.id))) return { action: "chat_duplicate", loopId: null };
    try {
      await replyNoSession(gitlab, event, mrIid, note);
    } catch (err) {
      logger.warn({ noteId: note.id, err: errorMessage(err) }, "chat: no-session reply failed");
    }
    return { action: "chat_no_session", loopId: loop?.id ?? null };
  }

  const { issueId, identifier, teamKey } = ticket;
  const chatJob: TriggerEvent = {
    kind: "chat", issueId, identifier, teamKey, loopId: loop?.id ?? null, projectId: event.projectId, mrIid,
    discussionId: note.discussionId, noteId: note.id, author: note.authorUsername, message,
  };
  const result = transaction(stores.db, (): { action: ChatAction; loopId: number | null } => {
    if (!stores.deliveries.markSeen(noteDeliveryKey(note.id))) return { action: "chat_duplicate", loopId: loop?.id ?? null };
    if (parked) {
      // The restart runs first: the chat shares the loop's subject, so it follows on the resumed loop.
      reviveTicket(stores, issueId, loop, chatJob);
      return { action: "chat_revive", loopId: loop?.id ?? null };
    }
    stores.jobs.enqueue(chatJob);
    return { action: "chat", loopId: loop?.id ?? null };
  });
  // Best effort, after the jobs are recorded: a delegate that could not be set is logged.
  if (result.action === "chat_revive") void restoreDelegate(deps, issueId);
  return result;
};

export type NoteAction = ChatAction | "queued_round" | "steered" | "ignored" | "denied";

export interface NoteIntakeDeps extends ChatIntakeDeps {
  /** The open runs' channels: a note on a ticket whose run is open is passed into that run. */
  channels?: Pick<RunChannels, "active" | "steer">;
  /** The clock the quiet window counts from; the wall clock when absent. */
  now?: () => Date;
}

/** Loops a note wakes: running, or passed (a new comment starts a round). A handed-back loop wakes for a person only. */
const WAKEABLE_STATES: readonly LoopState[] = [...ACTIVE_LOOP_STATES, "passed"];

const wakes = (loop: Loop, bot: boolean): boolean => WAKEABLE_STATES.includes(loop.state) || (loop.state === "handed_back" && !bot);

/** What the open run is told of a note: context for now, answered in its thread by the next round. */
export const steeringNote = (author: string, body: string): string =>
  `New comment from ${author} on the MR (answer it in the next round, not now):\n${body}`;

/** Whether the note's author may give the steward work: a Developer or higher, bots included. Null when GitLab could not say. */
const mayInstruct = async (gitlab: GitLabMrApi, event: GitlabWakeEvent, note: GitlabNote): Promise<boolean | null> => {
  try {
    const level = await gitlab.memberAccessLevel(event.projectId, note.authorId);
    return level !== null && level >= DEVELOPER_ACCESS;
  } catch (err) {
    logger.warn({ noteId: note.id, err: errorMessage(err) }, "note: member access could not be read");
    return null;
  }
};

/**
 * Makes the loop's next round start a quiet window after this note: the queued await is moved (or one is queued, opening
 * a passed loop again), but never past twice the window after the batch's first note. A loop step already running, or a
 * queued fix or restart, reads the MR's discussions itself, so nothing is queued for it. One transaction, synchronous.
 */
const queueRound = (stores: Stores, loop: Loop, now: Date, quietMinutes: number): void => {
  transaction(stores.db, () => {
    const step = stores.jobs.pendingStep(loopSubject(loop.id));
    if (step !== null && (step.kind !== "await_review" || step.status === "running")) return;
    // The batch's start counts only while its await is still queued; anything else starts a new batch.
    const since = step !== null && loop.pendingNotesSince !== null ? new Date(loop.pendingNotesSince) : now;
    const quietMs = quietMinutes * 60_000;
    const due = new Date(Math.min(now.getTime() + quietMs, since.getTime() + 2 * quietMs));
    let awaitId = step?.id ?? null;
    if (awaitId === null) {
      if (loop.state === "passed") stores.loops.update(loop.id, { state: "awaiting_review", waitStartedAt: null, endedAt: null });
      awaitId = stores.jobs.enqueue({ kind: "loop", issueId: loop.issueId, identifier: loop.identifier, teamKey: loop.teamKey, loopId: loop.id, step: "await" });
    }
    stores.jobs.postpone(awaitId, due);
    stores.loops.update(loop.id, { pendingNotesSince: since.toISOString() });
  });
};

/**
 * Any note on a steward MR. A `chat.prefix` note keeps the chat path (`chatIntake`). Otherwise the steward's own notes and
 * system notes are ignored, and an author below Developer is denied, bots included: only the configured Greptile user
 * needs no role. A note on a running or passed
 * loop is passed into the ticket's open run when there is one (the next round answers it), and otherwise wakes the loop
 * after a quiet window (`queueRound`). A person's note on a handed-back loop restarts it on the MR head. Unassigned and
 * stopped loops are left alone: only a `chat.prefix` mention revives them.
 */
export const noteIntake = async (deps: NoteIntakeDeps, event: GitlabWakeEvent, note: GitlabNote): Promise<{ action: NoteAction; loopId: number | null }> => {
  const { config, stores, gitlab } = deps;
  const chat = await chatIntake(deps, { ...event, note });
  if (chat !== null) return chat;
  if (gitlab === undefined || config.codehost.kind !== "gitlab" || event.mrIid === null) return { action: "ignored", loopId: null };
  if (!isOurProject(event, config.codehost.project)) return { action: "ignored", loopId: null };
  if ((await fromSteward(gitlab, note)) !== false) return { action: "ignored", loopId: null };
  const found = ticketOf(stores, event)?.loop ?? null;
  const bot = fromBot(config, note);
  if (found === null) return { action: "ignored", loopId: null };
  if (!wakes(found, bot) || isUnassigned(stores, found.issueId, found)) return { action: "ignored", loopId: found.id };
  if (!isTrustedBot(note.authorUsername, trustedBots(config))) {
    const allowed = await mayInstruct(gitlab, event, note);
    if (allowed === null) return { action: "ignored", loopId: found.id };
    if (!allowed) return { action: "denied", loopId: found.id };
  }

  // Read again after GitLab answered: the loop may have moved meanwhile. Everything from here is synchronous.
  const loop = stores.loops.get(found.id);
  if (loop === null || !wakes(loop, bot)) return { action: "ignored", loopId: found.id };
  if (loop.state === "handed_back") {
    transaction(stores.db, () => reviveTicket(stores, loop.issueId, loop, null));
    return { action: "queued_round", loopId: loop.id };
  }
  const quietMinutes = deps.settings?.get()["review.quietMinutes"] ?? DEFAULT_SETTINGS["review.quietMinutes"];
  const runId = deps.channels?.active(loop.issueId) ?? null;
  if (runId !== null && deps.channels?.steer(runId, steeringNote(note.authorUsername, note.body)) === true) {
    // A running loop's own next round answers it; a passed loop (the run is a chat) is opened again for that round.
    if (loop.state === "passed") queueRound(stores, loop, deps.now?.() ?? new Date(), quietMinutes);
    return { action: "steered", loopId: loop.id };
  }
  queueRound(stores, loop, deps.now?.() ?? new Date(), quietMinutes);
  return { action: "queued_round", loopId: loop.id };
};
