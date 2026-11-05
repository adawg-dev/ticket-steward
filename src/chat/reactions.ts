import type { GitLabMrApi } from "../codehost/gitlabMr.js";
import { errorMessage } from "../core/workspace.js";
import { logger } from "../log.js";

/** The steward took the `/agent` note: its chat is queued. */
export const ACK_EMOJI = "eyes";
/** The agent answered the note. */
export const DONE_EMOJI = "thumbsup";
/** The steward answered without the agent doing what was asked: its run failed, or the steward refused the MR. */
export const FAILED_EMOJI = "x";

/** The `/agent` note a reaction goes on. */
export interface NoteRef {
  projectId: number;
  mrIid: number;
  noteId: number;
}

/** Best effort: a reaction GitLab will not take is logged, never a reason to fail the chat. */
const quietly = async (what: string, note: NoteRef, call: () => Promise<void>): Promise<void> => {
  try {
    await call();
  } catch (err) {
    logger.warn({ noteId: note.noteId, mrIid: note.mrIid, err: errorMessage(err) }, `chat: ${what} failed`);
  }
};

/** Reacts with eyes as soon as the chat is queued, so the person sees it was picked up. */
export const ackNote = (gitlab: GitLabMrApi, note: NoteRef): Promise<void> =>
  quietly("the acknowledging reaction", note, () => gitlab.awardNoteEmoji(note.projectId, note.mrIid, note.noteId, ACK_EMOJI));

/** Once the reply is posted: takes back the eyes and reacts with a thumbs up, or a cross when it did not do what was asked. */
export const settleNote = async (gitlab: GitLabMrApi, note: NoteRef, failed: boolean): Promise<void> => {
  await quietly("removing the acknowledging reaction", note, () => gitlab.removeOwnNoteEmoji(note.projectId, note.mrIid, note.noteId, ACK_EMOJI));
  await quietly("the closing reaction", note, () => gitlab.awardNoteEmoji(note.projectId, note.mrIid, note.noteId, failed ? FAILED_EMOJI : DONE_EMOJI));
};
