import { existsSync } from "node:fs";
import { chmod, mkdir, open, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { execa } from "execa";
import { git, gitEnvRecord, gitOrThrow, scrubCredentials } from "../workspace/git.js";
import type { RemoteCredentials } from "../workspace/mirror.js";
import { branchRefPattern, carriesTicket } from "./branch.js";

const MIN_SECRET_LENGTH = 8;
/** Hooks that run before the commit object exists; post-commit is left out so nothing can change HEAD after the commit. */
const GIT_HOOKS = new Set(["pre-commit", "prepare-commit-msg", "commit-msg"]);

export type GuardResult = { ok: true; paths: string[] } | { ok: false; reason: string; detail: string };

const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

/**
 * `stewardFiles` are the worktree-relative paths the steward copied in (overlay env files, its own skills): never staged,
 * and refused if a hook stages one anyway. `maxDiffBytes` caps one file's scanned diff (default `MAX_DIFF_BYTES`); a
 * larger one is refused, never truncated.
 */
export type GuardInput = { stewardFiles: string[]; secretValues: string[]; maxDiffBytes?: number };

const MAX_DIFF_BYTES = 64 * 1024 * 1024;

const SECRET_DIFF_FLAGS = ["--no-color", "--unified=0", "--text", "--no-ext-diff", "--no-textconv"];
/** Each path is passed back to git as a pathspec; literal, so a name like `:(glob)x` names that file and not a pattern. */
const LITERAL_PATHSPECS = { GIT_LITERAL_PATHSPECS: "1" };

/**
 * The added lines of a diff, read by position: `---`/`+++` are file headers only before a file's first `@@` hunk;
 * inside a hunk every `+` line is content, including one whose text starts with `++`.
 */
export const addedLines = (diff: string): string[] => {
  const added: string[] = [];
  let inHunk = false;
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff ")) inHunk = false;
    else if (line.startsWith("@@")) inHunk = true;
    else if (inHunk && line.startsWith("+")) added.push(line.slice(1));
  }
  return added;
};

const usableSecrets = (values: string[]): string[] => values.filter((value) => value.length >= MIN_SECRET_LENGTH);

type ScanDiff = { ok: true; diff: string } | { ok: false; reason: string };

/** One file's diff for the secret scan. Fails closed: a git error or output over `maxBytes` is a refusal, never a partial pass. */
const scanDiff = async (cwd: string, args: string[], env: Record<string, string>, maxBytes: number): Promise<ScanDiff> => {
  const result = await execa("git", args, { cwd, env: { ...gitEnvRecord(), ...env }, extendEnv: false, reject: false, maxBuffer: { stdout: maxBytes } });
  if (result.isMaxBuffer) return { ok: false, reason: "the change is too large to scan for secrets" };
  if (result.exitCode !== 0) return { ok: false, reason: "the change could not be scanned for secrets" };
  return { ok: true, diff: result.stdout };
};

/**
 * The shared path guard and secret scan, over `git diff <range>`: `--cached` for the index, `<base> <sha>` for a commit.
 * Refuses an empty change, steward-copied files (overlay, skills) and added lines carrying a secret value.
 */
const guardDiff = async (cwd: string, range: string[], input: GuardInput, env: Record<string, string> = {}, allowEmpty = false): Promise<GuardResult> => {
  const paths = (await gitOrThrow(["diff", "--name-only", "-z", ...range], cwd, env)).split("\0").filter((path) => path !== "");
  if (paths.length === 0 && !allowEmpty) return { ok: false, reason: "the agent reported the work as implemented but changed nothing", detail: "" };
  const steward = new Set(input.stewardFiles);
  const copied = paths.filter((path) => steward.has(path));
  if (copied.length > 0) return { ok: false, reason: "the change would commit files the steward copied in", detail: copied.join("\n") };
  const secrets = usableSecrets(input.secretValues);
  if (secrets.length > 0) {
    const leaking: string[] = [];
    for (const path of paths) {
      const scanned = await scanDiff(cwd, ["diff", ...SECRET_DIFF_FLAGS, ...range, "--", path], { ...env, ...LITERAL_PATHSPECS }, input.maxDiffBytes ?? MAX_DIFF_BYTES);
      if (!scanned.ok) return { ok: false, reason: scanned.reason, detail: path };
      if (addedLines(scanned.diff).some((line) => secrets.some((secret) => line.includes(secret)))) leaking.push(path);
    }
    if (leaking.length > 0) return { ok: false, reason: "the change contains a secret value", detail: leaking.join("\n") };
  }
  return { ok: true, paths };
};

/**
 * Stages everything except the steward's own copies and refuses (nothing committed) if the change is empty or leaks a
 * secret. The copies are left out rather than refused: the target repo need not gitignore them.
 */
export const stageAndGuard = async (input: GuardInput & { worktreePath: string }): Promise<GuardResult> => {
  await gitOrThrow(["add", "-A"], input.worktreePath);
  // Unstaging restores a tracked path to HEAD in the index and drops an untracked one; a path that is absent is a no-op.
  if (input.stewardFiles.length > 0) await gitOrThrow(["reset", "-q", "--", ...input.stewardFiles], input.worktreePath, LITERAL_PATHSPECS);
  return guardDiff(input.worktreePath, ["--cached"], input);
};

const NO_REPLACE = { GIT_NO_REPLACE_OBJECTS: "1" };

/** The message part of a raw commit object. */
const messageOf = (raw: string): string => {
  const headerEnd = raw.indexOf("\n\n");
  return headerEnd === -1 ? "" : raw.slice(headerEnd + 2);
};

/**
 * The guard over everything `baseSha..headSha` would push. Each commit is guarded on its own, since every commit reaches
 * the remote: a secret added in one commit and removed in the next still leaks. The range must change something overall,
 * and no commit message may carry a secret value. The caller has checked the range is linear on the base.
 * Replace refs are ignored, so the diffs are of the real objects that get pushed.
 */
export const guardRange = async (input: GuardInput & { worktreePath: string; baseSha: string; headSha: string }): Promise<GuardResult> => {
  const overall = await guardDiff(input.worktreePath, [input.baseSha, input.headSha], input, NO_REPLACE);
  if (!overall.ok) return overall;
  const secrets = usableSecrets(input.secretValues);
  const commits = (await gitOrThrow(["rev-list", "--reverse", "--parents", `${input.baseSha}..${input.headSha}`], input.worktreePath, NO_REPLACE))
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => line.split(" "));
  for (const [sha = "", parent = ""] of commits) {
    if (commits.length > 1) {
      const own = await guardDiff(input.worktreePath, [parent, sha], input, NO_REPLACE, true);
      if (!own.ok) return { ...own, detail: own.detail === "" ? `commit ${sha.slice(0, 7)}` : `commit ${sha.slice(0, 7)}: ${own.detail}` };
    }
    // The agent wrote the messages and its commit hooks could rewrite them: they are pushed too, so they get the same scan.
    const message = messageOf(await gitOrThrow(["cat-file", "commit", sha], input.worktreePath, NO_REPLACE));
    if (secrets.some((secret) => message.includes(secret))) return { ok: false, reason: "the commit message contains a secret value", detail: `commit ${sha.slice(0, 7)}` };
  }
  return overall;
};

/**
 * Re-checks what was actually committed, since the repo's hooks (which the agent can edit) run between the staged
 * guard and the commit: the commit must sit directly on `baseSha` and pass `guardRange`.
 */
export const guardCommit = async (input: GuardInput & { worktreePath: string; baseSha: string; sha: string }): Promise<GuardResult> => {
  const parents = (await gitOrThrow(["rev-list", "--parents", "-n", "1", input.sha], input.worktreePath, NO_REPLACE)).split(" ").slice(1);
  if (parents.length !== 1 || parents[0] !== input.baseSha) {
    return { ok: false, reason: "the commit is not a single commit on top of the base", detail: `parents: ${parents.join(" ") || "(none)"}` };
  }
  const guarded = await guardRange({ ...input, headSha: input.sha });
  if (!guarded.ok && guarded.reason === "the commit message contains a secret value") return { ...guarded, detail: "commit message" };
  return guarded;
};

/**
 * Why `baseSha..sha` is not a non-empty, merge-free series of commits on top of `baseSha`, or null when it is.
 * The range is what a fast-forward from `baseSha` would push.
 */
export const linearRangeProblem = async (cwd: string, baseSha: string, sha: string): Promise<string | null> => {
  const ancestor = await git(["merge-base", "--is-ancestor", baseSha, sha], cwd, NO_REPLACE);
  if (ancestor.exitCode !== 0) return `${sha.slice(0, 7)} does not descend from ${baseSha.slice(0, 7)}`;
  const lines = (await gitOrThrow(["rev-list", "--parents", `${baseSha}..${sha}`], cwd, NO_REPLACE)).split("\n").filter((line) => line !== "");
  if (lines.length === 0) return `there are no commits on top of ${baseSha.slice(0, 7)}`;
  const merge = lines.find((line) => line.split(" ").length !== 2);
  if (merge !== undefined) return `${merge.slice(0, 7)} is a merge commit; the history on top of ${baseSha.slice(0, 7)} must be linear`;
  return null;
};

/**
 * Writes wrappers for the repo's Husky hooks into `hooksDir` (outside the worktree), so one commit can run them
 * via `-c core.hooksPath` without `husky install` touching the shared mirror config.
 */
export const installHookWrappers = async (worktreePath: string, hooksDir: string): Promise<string[]> => {
  // Steward-owned; cleared so a wrapper from an earlier attempt never survives.
  await rm(hooksDir, { recursive: true, force: true });
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

/** How to push: create a new branch, or fast-forward an existing one that must still be at `previousHead`. */
export type PushMode = { kind: "create" } | { kind: "fastForward"; previousHead: string };

/**
 * Pushes `sha` after checking the ref pattern, that it is a linear series of commits on `baseSha` (create) or on the previous
 * head (fast-forward), and (create) that no branch carries the ticket. Never a plain force. `baseSha` is the bundle's base.
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
  mode: PushMode;
}): Promise<void> => {
  const ref = `refs/heads/${input.branch}`;
  if (!branchRefPattern(input.branchTypes, input.identifier).test(ref)) throw new Error(`refusing to push to ${ref}: not a ${input.branchTypes.join("|")}/${input.identifier}-<slug> branch`);
  await rm(input.scratchDir, { recursive: true, force: true });
  await gitOrThrow(["init", "--bare", "--quiet", input.scratchDir]);
  await mkdir(join(input.scratchDir, "objects", "info"), { recursive: true });
  await writeFile(join(input.scratchDir, "objects", "info", "alternates"), `${input.objectsDir}\n`);
  await restoreFromBundle(input.scratchDir, input.bundlePath, input.sha);
  // A fast-forward checks from the head the lease expects, so nothing on the branch is ever dropped.
  const from = input.mode.kind === "create" ? input.baseSha : input.mode.previousHead;
  const problem = await linearRangeProblem(input.scratchDir, from, input.sha);
  if (problem !== null) throw new Error(`refusing to push: ${problem}`);
  if (input.mode.kind === "create") {
    const existing = await remoteTicketBranches(input.remote, input.scratchDir, input.identifier);
    if (existing[0] !== undefined) throw new BranchExistsError(existing[0].ref);
  }
  // Create: the empty expected value makes git refuse if the ref exists by push time. Fast-forward: the lease is the previous head,
  // so a branch that moved since is refused. Never a plain force.
  const expected = input.mode.kind === "create" ? "" : input.mode.previousHead;
  const pushed = await git(
    ["-c", "core.hooksPath=/dev/null", "push", "--quiet", "--porcelain", `--force-with-lease=${ref}:${expected}`, input.remote.url, `${input.sha}:${ref}`],
    input.scratchDir,
    input.remote.env,
  );
  if (pushed.exitCode !== 0) throw new Error(`git push exited ${pushed.exitCode}: ${scrubCredentials(pushed.stderr)}`);
};
