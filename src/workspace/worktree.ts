import { existsSync } from "node:fs";
import { mkdir, realpath, rm } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

import { git, gitOrThrow } from "./git.js";
import { Mirror } from "./mirror.js";

export interface Worktree {
  path: string;
  sha: string;
  destroy(): Promise<void>;
}

/** Removes a worktree and prunes its record; the caller holds the mirror's lock. */
const removeWorktree = async (mirror: Mirror, path: string): Promise<void> => {
  const removed = await git(["worktree", "remove", "--force", path], mirror.path);
  if (removed.exitCode !== 0 || existsSync(path)) {
    await rm(path, { recursive: true, force: true });
  }
  await git(["worktree", "prune"], mirror.path);
};

export const createWorktree = async (mirror: Mirror, workRoot: string, name: string, sha: string): Promise<Worktree> => {
  const path = join(workRoot, name);
  await mkdir(workRoot, { recursive: true, mode: 0o700 });
  // prune, remove and add all write the mirror's worktree records: under its lock, so parallel jobs never collide.
  await mirror.exclusive(async () => {
    await gitOrThrow(["worktree", "prune"], mirror.path);
    if (existsSync(path)) await removeWorktree(mirror, path);
    await gitOrThrow(["worktree", "add", "--quiet", "--detach", path, sha], mirror.path);
  });
  // The mirror is bare; without this override git refuses work-tree commands (add, commit) inside the worktree.
  await gitOrThrow(["config", "--worktree", "core.bare", "false"], path);
  await gitOrThrow(["config", "--worktree", "remote.origin.pushurl", "/dev/null"], path);
  return { path, sha, destroy: () => mirror.exclusive(() => removeWorktree(mirror, path)) };
};

/**
 * The worktree at `<workRoot>/<name>` when it is a live checkout of this mirror (its common git dir is the mirror's),
 * as it stands: nothing in it is changed. Null when the path is missing or is not one of the mirror's worktrees.
 */
export const openWorktree = async (mirror: Mirror, workRoot: string, name: string): Promise<Worktree | null> => {
  const path = join(workRoot, name);
  if (!existsSync(path)) return null;
  const common = await git(["rev-parse", "--path-format=absolute", "--git-common-dir"], path);
  const head = await git(["rev-parse", "--verify", "HEAD^{commit}"], path);
  if (common.exitCode !== 0 || head.exitCode !== 0 || !isAbsolute(common.stdout)) return null;
  const top = await git(["rev-parse", "--show-toplevel"], path);
  if (top.exitCode !== 0 || (await realpath(top.stdout)) !== (await realpath(path))) return null;
  if ((await realpath(common.stdout)) !== (await realpath(resolve(mirror.path)))) return null;
  return { path, sha: head.stdout, destroy: () => mirror.exclusive(() => removeWorktree(mirror, path)) };
};
