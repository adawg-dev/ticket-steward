import { safeGitOrThrow } from "../tools/gitSafe.js";

export interface Commit {
  sha: string;
  author: string;
  at: string;
  subject: string;
}

const FIELD_SEPARATOR = "\x1f";

/** Read from the agent's worktree, by a server holding the code host's token: its config must run nothing. */
export const recentCommits = async (worktreePath: string, paths: string[], sinceDays: number): Promise<Commit[]> => {
  const stdout = await safeGitOrThrow(["log", `--since=${sinceDays} days ago`, `--format=%H%x1f%an%x1f%aI%x1f%s`, "--", ...paths], worktreePath);
  return stdout
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => {
      const [sha = "", author = "", at = "", subject = ""] = line.split(FIELD_SEPARATOR);
      return { sha, author, at, subject };
    });
};
