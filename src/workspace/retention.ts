import { existsSync } from "node:fs";
import { readdir, rm, stat } from "node:fs/promises";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { execa } from "execa";

import { gitEnvRecord } from "./git.js";

const DAY_MS = 24 * 60 * 60 * 1000;

interface Entry {
  path: string;
  mtimeMs: number;
}

/** Subdirectories of `dir` sorted oldest first; empty when `dir` is missing. */
const subdirsByAge = async (dir: string): Promise<Entry[]> => {
  if (!existsSync(dir)) return [];
  const names = await readdir(dir, { withFileTypes: true });
  const entries: Entry[] = [];
  for (const name of names) {
    if (!name.isDirectory()) continue;
    const path = join(dir, name.name);
    entries.push({ path, mtimeMs: (await stat(path)).mtimeMs });
  }
  return entries.sort((a, b) => a.mtimeMs - b.mtimeMs);
};

const removeAll = async (entries: Entry[]): Promise<string[]> => {
  for (const entry of entries) {
    await rm(entry.path, { recursive: true, force: true });
  }
  return entries.map((entry) => entry.path);
};

export const sweep = async (p: {
  workRoot: string;
  jobsDir: string;
  keptWorktrees: number;
  days: number;
  protect: string[];
}): Promise<{ removedWorktrees: string[]; removedJobDirs: string[] }> => {
  const protectedPaths = new Set(p.protect.map((path) => resolve(path)));
  const worktrees = (await subdirsByAge(p.workRoot)).filter((entry) => !protectedPaths.has(resolve(entry.path)));
  const excess = Math.max(0, worktrees.length - p.keptWorktrees);
  const removedWorktrees = await removeAll(worktrees.slice(0, excess));

  const cutoff = Date.now() - p.days * DAY_MS;
  const staleJobs = (await subdirsByAge(p.jobsDir)).filter((entry) => entry.mtimeMs < cutoff);
  const removedJobDirs = await removeAll(staleJobs);

  return { removedWorktrees, removedJobDirs };
};

export const freePort = async (port: number): Promise<{ killed: number[] }> => {
  const result = await execa("lsof", ["-t", "-i", `:${port}`], { env: gitEnvRecord(), extendEnv: false, reject: false });
  const pids = result.stdout
    .split("\n")
    .map((line) => Number.parseInt(line.trim(), 10))
    .filter((pid) => Number.isInteger(pid) && pid > 0);
  const killed: number[] = [];
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGKILL");
      killed.push(pid);
    } catch {
      // already gone
    }
  }
  return { killed };
};

export const isPortFree = (port: number): Promise<boolean> =>
  new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen(port, () => {
      server.close(() => resolve(true));
    });
  });
