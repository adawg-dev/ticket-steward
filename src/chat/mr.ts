import type { MergeRequestInfo } from "../codehost/gitlabMr.js";
import type { StewardConfig } from "../config/schema.js";
import type { Settings } from "../settings/schema.js";

/**
 * `/agent` on a merge request the steward did not open (an MR chat). It has no Linear ticket of its own, so the MR stands
 * in for one: `mr:<projectId>!<iid>` takes the place of the issue id, which keys the job queue (one job per MR at a time),
 * the agent session and the push ledger. Linear issue ids are UUIDs, so the two never collide.
 */
const MR_ISSUE = /^mr:(\d+)!(\d+)$/;

export const mrIssueId = (projectId: number, mrIid: number): string => `mr:${projectId}!${mrIid}`;

/** The MR an MR chat's issue id names; null for a Linear issue id. */
export const mrChatOf = (issueId: string): { projectId: number; mrIid: number } | null => {
  const match = MR_ISSUE.exec(issueId);
  return match === null ? null : { projectId: Number(match[1]), mrIid: Number(match[2]) };
};

/** How an MR chat shows in job lists and logs, where a ticket shows its key. */
export const mrIdentifier = (mrIid: number): string => `!${mrIid}`;

/** The worktree an MR's chats share, so a later chat resumes the session in the same checkout. */
export const mrWorktreeName = (mrIid: number): string => `mr-${mrIid}`;

/** The config allows MR chats and the runtime setting has not switched them off. */
export const mrChatsEnabled = (config: Pick<StewardConfig, "chat">, settings: Pick<Settings, "chat.anyMergeRequest">): boolean =>
  config.chat?.anyMergeRequest === true && settings["chat.anyMergeRequest"];

/**
 * The Linear key the MR's branch (any case) or else its title names, among the teams the steward serves; null when
 * neither does. It sets the commit subject prefix and lets the agent read the ticket, never assigns it.
 */
export const ticketKeyOf = (mr: Pick<MergeRequestInfo, "sourceBranch" | "title">, teams: readonly string[]): string | null => {
  const served = new Set(teams.map((team) => team.toUpperCase()));
  for (const text of [mr.sourceBranch, mr.title]) {
    for (const match of text.matchAll(/(?<![A-Za-z0-9])([A-Za-z][A-Za-z0-9]*)-(\d+)(?![0-9])/g)) {
      const team = (match[1] ?? "").toUpperCase();
      if (served.has(team)) return `${team}-${match[2] ?? ""}`;
    }
  }
  return null;
};

/**
 * Why the steward will not work on this MR's branch, or null when it will: only an open MR (drafts included) from the
 * project's own branch, never the base branch or a protected one. The reason is posted as the reply.
 */
export const mrChatRefusal = (
  mr: Pick<MergeRequestInfo, "state" | "sourceBranch" | "sourceProjectId" | "projectId">,
  p: { baseBranch: string; protectedSource: boolean },
): string | null => {
  if (mr.state !== "opened") return `This merge request is ${mr.state}, so I won't work on it.`;
  if (mr.sourceProjectId !== null && mr.sourceProjectId !== mr.projectId) return "This merge request comes from a fork, which I can't push to.";
  if (mr.sourceBranch === p.baseBranch) return `This merge request's branch is \`${p.baseBranch}\`, the base branch, which I don't push to.`;
  if (p.protectedSource) return `This merge request's branch \`${mr.sourceBranch}\` is protected, so I won't push to it.`;
  return null;
};
