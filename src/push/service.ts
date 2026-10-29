import { existsSync } from "node:fs";
import { mkdir, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import type { PipelineDeps } from "../core/deps.js";
import { errorMessage, jobDirOf } from "../core/workspace.js";
import { branchName } from "../implement/branch.js";
import { BranchExistsError, guardRange, linearRangeProblem, pushCommit, remoteTicketBranches, saveBundle, uncommittedPaths, type PushMode } from "../implement/git.js";
import { CHECK_TAIL_BYTES, guardSecrets, lsRemoteSite, settingsOf, stewardChecks, stewardCopies } from "../implement/pipeline.js";
import type { Mirror, RemoteCredentials } from "../workspace/mirror.js";
import { localCheckRunner, type CheckRunner } from "./checks.js";
import { safeGitArgs, safeGitEnv, safeGitOrThrow } from "../tools/gitSafe.js";
import { git } from "../workspace/git.js";
import type { PushLedger, RemoteHead } from "./ledger.js";
import type { PushTarget } from "./target.js";

export const MINUTE_MS = 60_000;
const PUSH_BUNDLE = "push.bundle";
const PUSH_REPO = "push.git";
const NO_REPLACE = { GIT_NO_REPLACE_OBJECTS: "1" };

/** What the push guards against: the worktree paths the steward copied in, and the values no commit may carry. */
export type PushGuard = { stewardFiles: string[]; secrets: string[] };

/**
 * `mirror` is the git directory the worktree must still use (the steward's mirror, or a run pod's clone). `checks` runs the
 * steward's checks, in-process by default; `guard` defaults to the overlay's and the steward's own secrets.
 */
export type PushDeps = Pick<PipelineDeps, "config" | "secrets" | "redactor"> & {
  mirror: Pick<Mirror, "path">;
  ledger: PushLedger;
  checks?: CheckRunner;
  guard?: () => Promise<PushGuard>;
};

/** The local runtime's guard: the overlay files and skills the steward copied in, the overlay's and the steward's secrets. */
export const localGuard = async (p: { overlayDir: string; skillsDir: string | undefined; secrets: Record<string, string | undefined> }): Promise<PushGuard> => {
  const { files, secrets } = await guardSecrets(p.overlayDir, p.secrets);
  return { stewardFiles: await stewardCopies(p.skillsDir, files), secrets };
};

export type PushResult = { ok: true; branch: string; sha: string; commits: number } | { ok: false; reason: string; detail: string };

const refuse = (reason: string, detail = ""): PushResult => ({ ok: false, reason, detail });

const short = (sha: string): string => sha.slice(0, 7);

/** The remote's head of `branch`, read with `ls-remote` from a scratch dir in the job dir. */
export const remoteHeadOf =
  (deps: Pick<PipelineDeps, "config">, target: PushTarget, remote: RemoteCredentials): RemoteHead =>
  async (branch) => {
    const site = await lsRemoteSite({ jobDir: jobDirOf(deps.config.dataDir, target.jobId) }, remote);
    const branches = await remoteTicketBranches(site.remote, site.cwd, target.identifier);
    return branches.find(({ ref }) => ref === `refs/heads/${branch}`)?.sha ?? null;
  };

/** Commits in `base..head` whose subject does not start with `<identifier>: `. */
const unprefixed = async (worktreePath: string, base: string, head: string, identifier: string): Promise<string[]> => {
  const log = await safeGitOrThrow(["log", "--format=%h %s", `${base}..${head}`], worktreePath, NO_REPLACE);
  return log
    .split("\n")
    .filter((line) => line !== "")
    .filter((line) => !line.slice(line.indexOf(" ") + 1).startsWith(`${identifier}: `));
};

/** Pushes from a scratch repo in the job dir, never from the worktree or mirror, whose config the agent can change. */
const pushFromBundle = async (deps: PushDeps, jobDir: string, input: { remote: RemoteCredentials; sha: string; base: string; branch: string; identifier: string; branchTypes: string[]; mode: PushMode }): Promise<void> => {
  const scratchDir = join(jobDir, PUSH_REPO);
  try {
    await pushCommit({
      scratchDir,
      objectsDir: join(deps.mirror.path, "objects"),
      bundlePath: join(jobDir, PUSH_BUNDLE),
      remote: input.remote,
      sha: input.sha,
      baseSha: input.base,
      branch: input.branch,
      identifier: input.identifier,
      branchTypes: input.branchTypes,
      mode: input.mode,
    });
  } finally {
    await rm(scratchDir, { recursive: true, force: true });
  }
};

/**
 * Why the worktree's git directory cannot be trusted for the checks, or null. The `.git` file is agent-writable: pointed at
 * another repository, or given grafts or a shallow file, it could hide a commit from the guard while the scratch repo
 * still pushes it. Its config could also set `core.worktree` or `core.bare`; the checks pin the working tree anyway, but a
 * worktree whose own git would look elsewhere is refused. That probe runs without the pin, and its output is not shown.
 */
const gitDirProblem = async (worktreePath: string, mirrorPath: string): Promise<string | null> => {
  const layout = await git([...safeGitArgs(), "rev-parse", "--is-bare-repository", "--show-toplevel"], worktreePath, safeGitEnv());
  const [bare, top] = layout.stdout.split("\n");
  if (layout.exitCode !== 0 || bare !== "false" || top === undefined || top === "" || (await realpath(top)) !== (await realpath(worktreePath))) {
    return "the git directory's config sets core.worktree or core.bare";
  }
  const common = await safeGitOrThrow(["rev-parse", "--path-format=absolute", "--git-common-dir"], worktreePath);
  if ((await realpath(common)) !== (await realpath(mirrorPath))) return `the git directory is ${common}, not the steward's mirror`;
  const hiding = ["shallow", join("info", "grafts")].find((file) => existsSync(join(common, file)));
  return hiding === undefined ? null : `${join(common, hiding)} is present`;
};

/**
 * Pushes the worktree's `HEAD` to the run's ticket branch under the steward's push rules: a clean worktree, a linear
 * series of commits prefixed with the identifier on the last pushed head (or the base, creating the branch), the secret
 * guard, the steward's checks, and an open ticket. Every refusal carries the reason the agent sees.
 */
export const pushFromWorktree = async (input: { deps: PushDeps; target: PushTarget; branchType: string | null; note?: string }): Promise<PushResult> => {
  const { deps, target } = input;
  const configured = settingsOf(deps);
  if (configured === null) return refuse("pushing is not configured (implement block and GITLAB_PUSH_TOKEN)");
  const { settings, remote } = configured;
  const worktreePath = target.worktreePath;
  const jobDir = jobDirOf(deps.config.dataDir, target.jobId);

  const start = await deps.ledger.start(target, remoteHeadOf(deps, target, remote));
  if (start.kind === "refused") return refuse(start.reason);

  // 0. The checks below read the worktree's git directory, so it must still be the steward's.
  const tampered = await gitDirProblem(worktreePath, deps.mirror.path);
  if (tampered !== null) return refuse("the worktree's git directory was changed; restore it before pushing", tampered);

  // 1. Only committed work is pushed.
  const { stewardFiles, secrets } = await (deps.guard ?? (() => localGuard({ overlayDir: deps.config.workspace.overlayDir, skillsDir: deps.config.workspace.skillsDir, secrets: deps.secrets })))();
  const dirty = await uncommittedPaths(worktreePath, stewardFiles);
  if (dirty.length > 0) return refuse("commit or discard your changes first", dirty.join("\n"));

  // 2. New, merge-free commits on the head the push starts from.
  const sha = await safeGitOrThrow(["rev-parse", "HEAD"], worktreePath);
  if (sha === start.base) return refuse(`nothing to push: HEAD is already at ${short(start.base)}`);
  const problem = await linearRangeProblem(worktreePath, start.base, sha);
  if (problem !== null) return refuse(`HEAD must be new commits on top of ${short(start.base)}`, problem);

  // 3. Every subject names the ticket.
  const offending = await unprefixed(worktreePath, start.base, sha, target.identifier);
  if (offending.length > 0) return refuse(`every commit subject must start with "${target.identifier}: "; amend or reword these commits`, offending.join("\n"));

  // 4. Nothing the steward copied in and no secret value, in the change or the messages.
  const guarded = await guardRange({ worktreePath, baseSha: start.base, headSha: sha, stewardFiles, secretValues: secrets });
  if (!guarded.ok) return refuse(guarded.reason, guarded.detail);

  // 5. The steward's checks, against the original base so a filtered check covers the whole branch.
  const checks = deps.checks ?? localCheckRunner({ worktreePath, port: target.port, timeoutMs: settings.checksTimeoutMinutes * MINUTE_MS, tailBytes: CHECK_TAIL_BYTES });
  const checked = await checks.run(stewardChecks(settings.checks, target.baseSha));
  if (!checked.ok) return refuse("the steward's checks failed", deps.redactor.redact(checked.tail));

  // 6. The run can last an hour; never push for a ticket closed meanwhile.
  const ticket = await deps.ledger.ticket(target);
  if (ticket.closed !== null) return refuse(ticket.closed);

  // 7. A first push names its branch the steward's way and never takes over a branch that already carries the ticket.
  let branch: string;
  let mode: PushMode;
  if (start.kind === "create") {
    if (input.branchType === null || !settings.branchTypes.includes(input.branchType)) {
      return refuse(`the first push needs a branchType, one of: ${settings.branchTypes.join(", ")}`);
    }
    branch = branchName(input.branchType, target.identifier, ticket.title);
    const site = await lsRemoteSite({ jobDir }, remote);
    const existing = await remoteTicketBranches(site.remote, site.cwd, target.identifier);
    if (existing[0] !== undefined) return refuse(`a branch for ${target.identifier} already exists`, existing[0].ref.replace(/^refs\/heads\//, ""));
    mode = { kind: "create" };
  } else {
    branch = start.branch;
    mode = { kind: "fastForward", previousHead: start.base };
  }

  // 8. Intent first, so a push that lands before its record is recognized as the steward's.
  const { id: pushId } = await deps.ledger.record(target, { branch, sha, previousSha: start.kind === "create" ? null : start.base, note: input.note ?? null });
  try {
    await mkdir(jobDir, { recursive: true, mode: 0o700 });
    await saveBundle(worktreePath, start.base, join(jobDir, PUSH_BUNDLE));
    await pushFromBundle(deps, jobDir, { remote, sha, base: start.base, branch, identifier: target.identifier, branchTypes: settings.branchTypes, mode });
  } catch (err) {
    await deps.ledger.revert(target, pushId);
    if (err instanceof BranchExistsError) return refuse(`a branch for ${target.identifier} already exists`, err.ref.replace(/^refs\/heads\//, ""));
    return refuse("the push was rejected", deps.redactor.redact(errorMessage(err)));
  }
  await deps.ledger.landed(target, pushId, sha);
  const commits = Number(await safeGitOrThrow(["rev-list", "--count", `${start.base}..${sha}`], worktreePath));
  return { ok: true, branch, sha, commits };
};
