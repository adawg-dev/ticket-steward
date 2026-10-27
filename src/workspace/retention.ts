import { existsSync } from "node:fs";
import { readdir, rm, stat } from "node:fs/promises";
import { createServer } from "node:net";
import { basename, join, resolve } from "node:path";
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

/** The SDK's cap on an encoded project dir name; longer ones are cut and get a hash suffix. */
const MAX_PROJECT_DIR_LENGTH = 200;

/** The SDK's string hash (`(h << 5) - h + code`, 32-bit), base 36 of its absolute value. */
const pathHash = (value: string): string => {
  let hash = 0;
  for (let i = 0; i < value.length; i++) hash = ((hash << 5) - hash + value.charCodeAt(i)) | 0;
  return Math.abs(hash).toString(36);
};

/**
 * The directory name under `<CLAUDE_CONFIG_DIR>/projects` that Claude Code uses for sessions started in `cwd`.
 * Derived from @anthropic-ai/claude-agent-sdk sdk.mjs (`om`/`Au`): every non-alphanumeric character becomes `-`;
 * a name over 200 characters is cut to 200 and gets `-<hash>` appended.
 */
export const sessionProjectDir = (cwd: string): string => {
  const encoded = cwd.replace(/[^a-zA-Z0-9]/g, "-");
  return encoded.length <= MAX_PROJECT_DIR_LENGTH ? encoded : `${encoded.slice(0, MAX_PROJECT_DIR_LENGTH)}-${pathHash(cwd)}`;
};

/** Worktree paths and session dir names to keep for the given loops (`work/<worktreeName>` each). */
export const loopProtection = (workRoot: string, loops: { worktreeName: string }[]): { protect: string[]; protectSessionPaths: string[] } => {
  const protect = loops.map((loop) => join(workRoot, loop.worktreeName));
  return { protect, protectSessionPaths: protect.map(sessionProjectDir) };
};

export const sweep = async (p: {
  workRoot: string;
  jobsDir: string;
  keptWorktrees: number;
  days: number;
  protect: string[];
  /** CLAUDE_CONFIG_DIR; its `projects/<dir>` entries older than `days` are removed. */
  sessionsDir: string;
  /** Names under `projects/` that belong to non-ended loops and are kept however old. */
  protectSessionPaths: string[];
}): Promise<{ removedWorktrees: string[]; removedJobDirs: string[]; removedSessionDirs: string[] }> => {
  const protectedPaths = new Set(p.protect.map((path) => resolve(path)));
  const worktrees = (await subdirsByAge(p.workRoot)).filter((entry) => !protectedPaths.has(resolve(entry.path)));
  const excess = Math.max(0, worktrees.length - p.keptWorktrees);
  const removedWorktrees = await removeAll(worktrees.slice(0, excess));

  const cutoff = Date.now() - p.days * DAY_MS;
  const staleJobs = (await subdirsByAge(p.jobsDir)).filter((entry) => entry.mtimeMs < cutoff);
  const removedJobDirs = await removeAll(staleJobs);

  const protectedSessions = new Set(p.protectSessionPaths);
  const staleSessions = (await subdirsByAge(join(p.sessionsDir, "projects"))).filter(
    (entry) => entry.mtimeMs < cutoff && !protectedSessions.has(basename(entry.path)),
  );
  const removedSessionDirs = await removeAll(staleSessions);

  return { removedWorktrees, removedJobDirs, removedSessionDirs };
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
