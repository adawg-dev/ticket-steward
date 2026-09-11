import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { execa } from "execa";

import { gitEnvRecord } from "../../src/workspace/git.js";
import { Mirror, createWorktree } from "../../src/workspace/index.js";
import { commitFile, makeSourceRepo, removeDir, tmpDir } from "./helpers.js";

describe("createWorktree", () => {
  let root: string;
  let mirror: Mirror;
  let sha: string;
  let workRoot: string;

  beforeEach(async () => {
    vi.restoreAllMocks();
    root = await tmpDir();
    const source = await makeSourceRepo(root);
    sha = source.sha;
    mirror = await Mirror.init(join(root, "repo.git"), source.repo);
    workRoot = join(root, "work");
  });

  afterEach(async () => {
    await removeDir(root);
  });

  it("checks out the requested sha's tree at <workRoot>/<name>", async () => {
    const worktree = await createWorktree(mirror, workRoot, "7-1", sha);

    expect(worktree.path).toBe(join(workRoot, "7-1"));
    expect(worktree.sha).toBe(sha);
    expect(await readFile(join(worktree.path, "README.md"), "utf8")).toBe("hello\n");
  });

  it("checks out an older sha when asked", async () => {
    const older = await commitFile(join(root, "source"), "a.txt", "a\n");
    await commitFile(join(root, "source"), "b.txt", "b\n");
    await mirror.fetch();

    const worktree = await createWorktree(mirror, workRoot, "1-1", older);

    expect(await readFile(join(worktree.path, "a.txt"), "utf8")).toBe("a\n");
    await expect(readFile(join(worktree.path, "b.txt"), "utf8")).rejects.toThrow();
  });

  it("rejects git push from inside the worktree", async () => {
    const worktree = await createWorktree(mirror, workRoot, "7-1", sha);

    const push = await execa("git", ["push", "origin", "HEAD:refs/heads/steward-test"], {
      cwd: worktree.path,
      env: gitEnvRecord(),
      extendEnv: false,
      reject: false,
    });

    expect(push.exitCode).not.toBe(0);
  });

  it("creating the same name twice replaces the first worktree", async () => {
    const first = await createWorktree(mirror, workRoot, "7-1", sha);
    const second = await createWorktree(mirror, workRoot, "7-1", sha);

    expect(second.path).toBe(first.path);
    expect(await readFile(join(second.path, "README.md"), "utf8")).toBe("hello\n");
  });

  it("destroy removes the checkout", async () => {
    const worktree = await createWorktree(mirror, workRoot, "7-1", sha);

    await worktree.destroy();

    await expect(readFile(join(worktree.path, "README.md"), "utf8")).rejects.toThrow();
  });
});
