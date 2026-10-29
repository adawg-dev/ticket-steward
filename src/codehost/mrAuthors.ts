import { BOT_USER, type GitLabMrApi, type MrDiscussion, type MrNote, type ProjectRef } from "./gitlabMr.js";

/**
 * Who wrote an MR note, as the review loop and note intake both judge it: the steward's own account, a bot the steward
 * listens to, a person who may give it work, or an outsider whose note is never work.
 */
export type AuthorKind = "steward" | "bot" | "person" | "outsider";

/** GitLab's Developer role: the lowest that may give the steward work, people and bots alike. */
export const DEVELOPER_ACCESS = 30;

/** Every steward note carries a hidden `ticket-steward:` marker; it counts only on a note the steward's account wrote. */
export const STEWARD_MARKER = "<!-- ticket-steward:";

export interface AuthorPolicy {
  /** The steward's GitLab username. */
  steward: string;
  /** Bots listened to whatever their membership (the configured Greptile user). */
  trustedBots: readonly string[];
}

export interface Author {
  username: string;
  /** GitLab's `bot` flag on the author. */
  bot: boolean;
}

/** A bot by GitLab's flag, a project/group bot name, or a trusted name. Being one gives no right to be listened to. */
export const looksLikeBot = (author: Author, trustedBots: readonly string[]): boolean =>
  author.bot || BOT_USER.test(author.username) || isTrustedBot(author.username, trustedBots);

export const isTrustedBot = (username: string, trustedBots: readonly string[]): boolean =>
  trustedBots.some((name) => name.toLowerCase() === username.toLowerCase());

/**
 * One rule for intake and rounds: the steward by its account; a trusted bot; else anyone below Developer (`level` null
 * for a non-member) is an outsider, and a Developer or higher is a bot (by `looksLikeBot`) or a person.
 */
export const classifyAuthor = (author: Author, level: number | null, policy: AuthorPolicy): AuthorKind => {
  if (author.username.toLowerCase() === policy.steward.toLowerCase()) return "steward";
  if (isTrustedBot(author.username, policy.trustedBots)) return "bot";
  if (level === null || level < DEVELOPER_ACCESS) return "outsider";
  return looksLikeBot(author, policy.trustedBots) ? "bot" : "person";
};

/** Whether a note needs its author's access level to be classified: neither a system note, the steward's, nor a trusted bot's. */
const needsLevel = (note: MrNote, policy: AuthorPolicy): boolean =>
  !note.system && note.author.toLowerCase() !== policy.steward.toLowerCase() && !isTrustedBot(note.author, policy.trustedBots);

/**
 * The round's classifier: reads each author's access level once (a failed read throws, so the round retries) and
 * classifies every note of `discussions` by it.
 */
export const readAuthorKinds = async (
  gitlab: Pick<GitLabMrApi, "memberAccessLevel">, project: ProjectRef, discussions: MrDiscussion[], policy: AuthorPolicy,
): Promise<(note: MrNote) => AuthorKind> => {
  const levels = new Map<number, number | null>();
  for (const note of discussions.flatMap((discussion) => discussion.notes)) {
    if (!needsLevel(note, policy) || levels.has(note.authorId)) continue;
    levels.set(note.authorId, await gitlab.memberAccessLevel(project, note.authorId));
  }
  return (note) => classifyAuthor({ username: note.author, bot: note.authorBot }, levels.get(note.authorId) ?? null, policy);
};
