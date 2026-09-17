import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import { recentCommits } from "../../src/codehost/gitlog.js";

const gitEnv = {
  GIT_AUTHOR_NAME: "Ada",
  GIT_AUTHOR_EMAIL: "ada@example.com",
  GIT_COMMITTER_NAME: "Ada",
  GIT_COMMITTER_EMAIL: "ada@example.com",
  GIT_CONFIG_GLOBAL: "/dev/null",
};

const git = (cwd: string, args: string[], date?: string) =>
  execa("git", args, {
    cwd,
    env: date === undefined ? gitEnv : { ...gitEnv, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
  });

const repoWithTwoCommits = async (date?: string) => {
  const dir = await mkdtemp(join(tmpdir(), "steward-gitlog-"));
  await git(dir, ["init", "-q", "-b", "main"]);
  await writeFile(join(dir, "a.ts"), "a\n");
  await git(dir, ["add", "a.ts"]);
  await git(dir, ["commit", "-q", "-m", "touch a"], date);
  await writeFile(join(dir, "b.ts"), "b\n");
  await git(dir, ["add", "b.ts"]);
  await git(dir, ["commit", "-q", "-m", "touch b"], date);
  const { stdout } = await git(dir, ["log", "-1", "--format=%H%n%aI", "HEAD~1"]);
  const [shaA = "", atA = ""] = stdout.trim().split("\n");
  return { dir, shaA, atA };
};

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("recentCommits", () => {
  it("returns the commit that touched the path and not one that did not", async () => {
    const { dir, shaA, atA } = await repoWithTwoCommits();

    const commits = await recentCommits(dir, ["a.ts"], 30);

    expect(commits).toEqual([{ sha: shaA, author: "Ada", at: atA, subject: "touch a" }]);
  });

  it("returns nothing when no commit is within the window", async () => {
    const { dir } = await repoWithTwoCommits("2020-01-01T00:00:00Z");

    const commits = await recentCommits(dir, ["a.ts"], 30);

    expect(commits).toEqual([]);
  });
});
