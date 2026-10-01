import { existsSync } from "node:fs";
import { chmod, mkdir, open, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { git, gitOrThrow, scrubCredentials } from "../workspace/git.js";
import type { RemoteCredentials } from "../workspace/mirror.js";
import { branchRefPattern, carriesTicket } from "./branch.js";

const MIN_SECRET_LENGTH = 8;
const GIT_HOOKS = new Set(["pre-commit", "prepare-commit-msg", "commit-msg", "post-commit"]);

export type GuardResult = { ok: true; paths: string[] } | { ok: false; reason: string; detail: string };

const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

const stagedPaths = async (worktreePath: string): Promise<string[]> => {
  const out = await gitOrThrow(["diff", "--cached", "--name-only", "-z"], worktreePath);
  return out.split("\0").filter((path) => path !== "");
};

/** Stages everything and refuses (nothing committed) if the change is empty, includes steward-copied files, or leaks an overlay secret. */
export const stageAndGuard = async (input: { worktreePath: string; overlayFiles: string[]; skillsPrefix: string; secretValues: string[] }): Promise<GuardResult> => {
  await gitOrThrow(["add", "-A"], input.worktreePath);
  const paths = await stagedPaths(input.worktreePath);
  if (paths.length === 0) return { ok: false, reason: "the agent reported the work as implemented but changed nothing", detail: "" };
  const overlay = new Set(input.overlayFiles);
  const copied = paths.filter((path) => overlay.has(path) || path.startsWith(input.skillsPrefix));
  if (copied.length > 0) return { ok: false, reason: "the change would commit files the steward copied in", detail: copied.join("\n") };
  const secrets = input.secretValues.filter((value) => value.length >= MIN_SECRET_LENGTH);
  if (secrets.length > 0) {
    const leaking: string[] = [];
    for (const path of paths) {
      const diff = await git(["diff", "--cached", "--no-color", "--unified=0", "--text", "--no-ext-diff", "--no-textconv", "--", path], input.worktreePath);
      const added = diff.stdout.split("\n").filter((line) => line.startsWith("+") && !line.startsWith("+++"));
      if (added.some((line) => secrets.some((secret) => line.includes(secret)))) leaking.push(path);
    }
    if (leaking.length > 0) return { ok: false, reason: "the change contains a secret value from the overlay", detail: leaking.join("\n") };
  }
  return { ok: true, paths };
};

/**
 * Writes wrappers for the repo's Husky hooks into `hooksDir` (outside the worktree), so one commit can run them
 * via `-c core.hooksPath` without `husky install` touching the shared mirror config.
 */
export const installHookWrappers = async (worktreePath: string, hooksDir: string): Promise<string[]> => {
  await mkdir(hooksDir, { recursive: true, mode: 0o700 });
  const huskyDir = join(worktreePath, ".husky");
  if (!existsSync(huskyDir)) return [];
  const installed: string[] = [];
  for (const name of (await readdir(huskyDir)).sort()) {
    if (!GIT_HOOKS.has(name) || !(await stat(join(huskyDir, name))).isFile()) continue;
    const wrapper = join(hooksDir, name);
    await writeFile(wrapper, `#!/bin/sh\nexec sh ${shellQuote(join(huskyDir, name))} "$@"\n`);
    await chmod(wrapper, 0o755);
    installed.push(name);
  }
  return installed;
};

export const commitWithHooks = async (input: {
  worktreePath: string;
  hooksDir: string;
  messagePath: string;
  message: string;
  author: { name: string; email: string };
  env: Record<string, string>;
}): Promise<{ ok: true; sha: string } | { ok: false; output: string }> => {
  await writeFile(input.messagePath, `${input.message.trim()}\n`, { mode: 0o600 });
  const path = `${join(input.worktreePath, "node_modules", ".bin")}:${input.env.PATH ?? process.env.PATH ?? "/usr/bin:/bin"}`;
  const result = await git(
    ["-c", `core.hooksPath=${input.hooksDir}`, "-c", `user.name=${input.author.name}`, "-c", `user.email=${input.author.email}`, "commit", "--quiet", "--no-gpg-sign", "-F", input.messagePath],
    input.worktreePath,
    { ...input.env, PATH: path },
  );
  if (result.exitCode !== 0) return { ok: false, output: [result.stdout, result.stderr].filter((part) => part !== "").join("\n") };
  return { ok: true, sha: await gitOrThrow(["rev-parse", "HEAD"], input.worktreePath) };
};

/** Keeps the commit on disk after the worktree is gone, so a failed push can be retried. */
export const saveBundle = async (worktreePath: string, baseSha: string, bundlePath: string): Promise<void> => {
  await gitOrThrow(["bundle", "create", "--quiet", bundlePath, `${baseSha}..HEAD`], worktreePath);
};

const BUNDLE_SIGNATURES = new Set(["# v2 git bundle", "# v3 git bundle"]);
const BUNDLE_HEADER_MAX_BYTES = 64 * 1024;

/** The bundle's single prerequisite commit (the job's base), read from its text header without running git. */
export const bundleBase = async (bundlePath: string): Promise<string> => {
  const handle = await open(bundlePath, "r");
  let header: string;
  try {
    const buffer = Buffer.alloc(BUNDLE_HEADER_MAX_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, BUNDLE_HEADER_MAX_BYTES, 0);
    header = buffer.subarray(0, bytesRead).toString("latin1");
  } finally {
    await handle.close();
  }
  const end = header.indexOf("\n\n");
  if (end === -1) throw new Error(`${bundlePath} has no complete bundle header`);
  const [signature = "", ...lines] = header.slice(0, end).split("\n");
  if (!BUNDLE_SIGNATURES.has(signature)) throw new Error(`${bundlePath} is not a v2/v3 git bundle`);
  const prerequisites = lines.filter((line) => line.startsWith("-")).map((line) => line.slice(1).split(" ")[0] ?? "");
  const [base] = prerequisites;
  if (prerequisites.length !== 1 || base === undefined || !/^[0-9a-f]{40}$/.test(base)) {
    throw new Error(`${bundlePath} must have exactly one prerequisite commit, found ${prerequisites.length}`);
  }
  return base;
};

export const restoreFromBundle = async (repoPath: string, bundlePath: string, sha: string): Promise<void> => {
  await gitOrThrow(["fetch", "--quiet", bundlePath, "HEAD"], repoPath);
  await gitOrThrow(["cat-file", "-e", `${sha}^{commit}`], repoPath);
};

export const remoteTicketBranches = async (remote: RemoteCredentials, cwd: string, identifier: string): Promise<Array<{ ref: string; sha: string }>> => {
  const out = await gitOrThrow(["ls-remote", "--heads", remote.url], cwd, remote.env);
  return out
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => {
      const [sha = "", ref = ""] = line.split("\t");
      return { ref, sha };
    })
    .filter(({ ref }) => carriesTicket(ref, identifier));
};

export class BranchExistsError extends Error {
  constructor(readonly ref: string) {
    super(`${ref} already exists on the remote`);
    this.name = "BranchExistsError";
  }
}

/**
 * Pushes `sha` to a new branch after checking the ref pattern, the ancestry, and that no branch carries the ticket. Never forces.
 * Runs in a fresh scratch repo (never the worktree or mirror, whose config the agent may have set) with hooks disabled, so the
 * push credentials only reach git itself. Objects come from the bundle plus the mirror's objects (via alternates) for the base.
 */
export const pushCommit = async (input: {
  scratchDir: string;
  objectsDir: string;
  bundlePath: string;
  remote: RemoteCredentials;
  sha: string;
  baseSha: string;
  branch: string;
  identifier: string;
  branchTypes: string[];
}): Promise<void> => {
  const ref = `refs/heads/${input.branch}`;
  if (!branchRefPattern(input.branchTypes, input.identifier).test(ref)) throw new Error(`refusing to push to ${ref}: not a ${input.branchTypes.join("|")}/${input.identifier}-<slug> branch`);
  await rm(input.scratchDir, { recursive: true, force: true });
  await gitOrThrow(["init", "--bare", "--quiet", input.scratchDir]);
  await mkdir(join(input.scratchDir, "objects", "info"), { recursive: true });
  await writeFile(join(input.scratchDir, "objects", "info", "alternates"), `${input.objectsDir}\n`);
  await restoreFromBundle(input.scratchDir, input.bundlePath, input.sha);
  const parents = (await gitOrThrow(["rev-list", "--parents", "-n", "1", input.sha], input.scratchDir)).split(" ").slice(1);
  if (parents.length !== 1 || parents[0] !== input.baseSha) throw new Error(`refusing to push: ${input.sha.slice(0, 7)} is not a single commit on top of ${input.baseSha.slice(0, 7)}`);
  const existing = await remoteTicketBranches(input.remote, input.scratchDir, input.identifier);
  if (existing[0] !== undefined) throw new BranchExistsError(existing[0].ref);
  // Create-only: the empty expected value makes git refuse if the ref exists by push time (never a force).
  const pushed = await git(
    ["-c", "core.hooksPath=/dev/null", "push", "--quiet", "--porcelain", `--force-with-lease=${ref}:`, input.remote.url, `${input.sha}:${ref}`],
    input.scratchDir,
    input.remote.env,
  );
  if (pushed.exitCode !== 0) throw new Error(`git push exited ${pushed.exitCode}: ${scrubCredentials(pushed.stderr)}`);
};
