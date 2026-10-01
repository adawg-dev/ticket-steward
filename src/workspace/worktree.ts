import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

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
