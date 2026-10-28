import { BOT_USER, type GitLabMrApi } from "../codehost/gitlabMr.js";
import type { GitlabNote, GitlabWakeEvent } from "../codehost/gitlabWebhook.js";
import type { StewardConfig } from "../config/schema.js";
import { errorMessage } from "../core/workspace.js";
import { logger } from "../log.js";
import { transaction, type Loop, type Stores } from "../store/index.js";
import { CHAT_MARKER, NO_SESSION_REPLY } from "./result.js";
import { latestSession } from "./session.js";

export type ChatAction = "chat" | "chat_restart" | "chat_denied" | "chat_ignored" | "chat_duplicate" | "chat_no_session" | "chat_failed";

export interface ChatIntakeDeps {
  config: StewardConfig;
  stores: Stores;
  gitlab?: GitLabMrApi;
}

/** GitLab's Developer role: the lowest that may start a chat. */
const DEVELOPER = 30;

/** Every steward note carries a hidden `ticket-steward:` marker (chat replies, loop notes); none of them is a request. */
const STEWARD_MARKER = "<!-- ticket-steward:";

/** The second word that restarts a handed-back loop instead of chatting. */
const RESTART_WORD = "restart";

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

/** System notes, bots (by flag or project/group bot name), Greptile and anything the steward posted never start a chat. */
const fromMachine = (config: StewardConfig, note: GitlabNote): boolean => {
  const author = note.authorUsername.toLowerCase();
  return (
    note.system ||
    note.authorIsBot ||
    BOT_USER.test(note.authorUsername) ||
    (config.greptile !== undefined && author === config.greptile.botUsername.toLowerCase()) ||
    note.body.includes(STEWARD_MARKER) ||
    note.body.includes(CHAT_MARKER)
  );
};

const isOurProject = (event: GitlabWakeEvent, project: string): boolean => event.projectPath === project || String(event.projectId) === project;

interface Ticket {
  issueId: string;
  identifier: string;
  teamKey: string;
  loop: Loop | null;
}

/** The ticket whose steward branch is the MR's source branch: its loop's, else its implement job's. */
const ticketOf = (stores: Stores, event: GitlabWakeEvent): Ticket | null => {
  const loop = stores.loops.latestForBranch(event.branch);
  if (loop !== null && (loop.projectId === null || loop.projectId === event.projectId)) {
    return { issueId: loop.issueId, identifier: loop.identifier, teamKey: loop.teamKey, loop };
  }
  const job = stores.jobs.latestImplementForBranch(event.branch);
  return job === null ? null : { issueId: job.issueId, identifier: job.identifier, teamKey: job.teamKey, loop: null };
};

const isRestart = (message: string): boolean => message.split(/\s+/)[0]?.toLowerCase() === RESTART_WORD;

/** Says once, in the note's discussion, that the MR has no agent session to talk to. */
const replyNoSession = async (gitlab: GitLabMrApi, event: GitlabWakeEvent, mrIid: number, note: GitlabNote): Promise<void> => {
  const body = `${NO_SESSION_REPLY}\n\n${CHAT_MARKER}`;
  if (note.discussionId === null) await gitlab.createNote(event.projectId, mrIid, body);
  else await gitlab.replyToDiscussion(event.projectId, mrIid, note.discussionId, body);
};

/**
 * A `chat.prefix` note from a Developer (or higher) on a steward MR: enqueues a `chat` job (or, as `<prefix> restart`
 * on a handed-back loop, its restart step). Null when the event is not a chat request at all, so the caller handles it
 * as a plain wake. Only GitLab is called before the note id is recorded; each note id is acted on once.
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
  if (fromMachine(config, note)) return { action: "chat_ignored", loopId: null };
  if (stores.deliveries.seen(noteDeliveryKey(note.id))) return { action: "chat_duplicate", loopId: null };

  let level: number | null;
  try {
    level = await gitlab.memberAccessLevel(event.projectId, note.authorId);
  } catch (err) {
    logger.warn({ noteId: note.id, err: errorMessage(err) }, "chat: member access could not be read");
    return { action: "chat_failed", loopId: null };
  }
  if (level === null || level < DEVELOPER) return { action: "chat_denied", loopId: null };

  const ticket = ticketOf(stores, event);
  const loop = ticket?.loop ?? null;
  const restart = loop !== null && loop.state === "handed_back" && isRestart(message);
  if (ticket === null || (!restart && latestSession(stores, ticket.issueId) === null)) {
    if (!stores.deliveries.markSeen(noteDeliveryKey(note.id))) return { action: "chat_duplicate", loopId: null };
    try {
      await replyNoSession(gitlab, event, mrIid, note);
    } catch (err) {
      logger.warn({ noteId: note.id, err: errorMessage(err) }, "chat: no-session reply failed");
    }
    return { action: "chat_no_session", loopId: loop?.id ?? null };
  }

  const { issueId, identifier, teamKey } = ticket;
  return transaction(stores.db, () => {
    if (!stores.deliveries.markSeen(noteDeliveryKey(note.id))) return { action: "chat_duplicate", loopId: loop?.id ?? null };
    if (restart && loop !== null) {
      // A restart already waiting covers this one.
      if (stores.jobs.findQueued(issueId, "restart") === null) {
        stores.jobs.enqueue({ kind: "loop", issueId, identifier, teamKey, loopId: loop.id, step: "restart", labelDriven: false });
      }
      return { action: "chat_restart", loopId: loop.id };
    }
    stores.jobs.enqueue({
      kind: "chat", issueId, identifier, teamKey, loopId: loop?.id ?? null, projectId: event.projectId, mrIid,
      discussionId: note.discussionId, noteId: note.id, author: note.authorUsername, message,
    });
    return { action: "chat", loopId: loop?.id ?? null };
  });
};
