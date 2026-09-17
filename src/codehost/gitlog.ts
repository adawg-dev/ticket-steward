import { execa } from "execa";

export interface Commit {
  sha: string;
  author: string;
  at: string;
  subject: string;
}

const FIELD_SEPARATOR = "\x1f";

export const recentCommits = async (worktreePath: string, paths: string[], sinceDays: number): Promise<Commit[]> => {
  const { stdout } = await execa(
    "git",
    ["log", `--since=${sinceDays} days ago`, `--format=%H%x1f%an%x1f%aI%x1f%s`, "--", ...paths],
    { cwd: worktreePath, env: { GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" } },
  );
  return stdout
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => {
      const [sha = "", author = "", at = "", subject = ""] = line.split(FIELD_SEPARATOR);
      return { sha, author, at, subject };
    });
};
