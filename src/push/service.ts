import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { buildWorkspaceEnv } from "../brain/env.js";
import type { PipelineDeps } from "../core/deps.js";
import { closedReason } from "../core/intake.js";
import { errorMessage, jobDirOf } from "../core/workspace.js";
import { branchName } from "../implement/branch.js";
import { BranchExistsError, guardRange, linearRangeProblem, pushCommit, remoteTicketBranches, saveBundle, uncommittedPaths, type PushMode } from "../implement/git.js";
import { CHECK_TAIL_BYTES, guardSecrets, lsRemoteSite, settingsOf, stewardChecks, stewardCopies } from "../implement/pipeline.js";
import { transaction, type Push } from "../store/index.js";
import { gitOrThrow } from "../workspace/git.js";
import type { RemoteCredentials } from "../workspace/mirror.js";
import { runSetup } from "../workspace/setup.js";
import type { PushTarget } from "./target.js";

const MINUTE_MS = 60_000;
const PUSH_BUNDLE = "push.bundle";
const PUSH_REPO = "push.git";
const NO_REPLACE = { GIT_NO_REPLACE_OBJECTS: "1" };

export type PushDeps = Pick<PipelineDeps, "config" | "secrets" | "stores" | "mirror" | "tracker" | "redactor">;

export type PushResult = { ok: true; branch: string; sha: string; commits: number } | { ok: false; reason: string; detail: string };

/** Where a push starts: a new branch on the job's base, or the branch's last steward-pushed head. */
type Start = { kind: "create"; base: string } | { kind: "fastForward"; branch: string; base: string };

const refuse = (reason: string, detail = ""): PushResult => ({ ok: false, reason, detail });

const short = (sha: string): string => sha.slice(0, 7);

/** Records a landed push everywhere the steward reads it: the push row, the implement job, or the loop's head. */
const markLanded = (deps: PushDeps, target: PushTarget, push: Pick<Push, "id" | "sha">): void => {
  const { stores } = deps;
  transaction(stores.db, () => {
    stores.pushes.markPushed(push.id);
    // The loop's head moves with the push, so the gate reads it as the loop's own and never as a person's.
    if (target.loopId !== null) stores.loops.update(target.loopId, { pendingPush: { sha: push.sha, pushed: true }, headSha: push.sha });
    else stores.jobs.markPushed(target.jobId);
  });
};

/** The job's or loop's push record before this push, put back if the push does not land. */
type Prior = { kind: "loop"; loopId: number; pendingPush: { sha: string; pushed: boolean } | null } | { kind: "job"; jobId: number; branch: string | null; commitSha: string | null; pushed: boolean };

const priorOf = (deps: PushDeps, target: PushTarget): Prior => {
  if (target.loopId !== null) return { kind: "loop", loopId: target.loopId, pendingPush: deps.stores.loops.get(target.loopId)?.pendingPush ?? null };
  const job = deps.stores.jobs.get(target.jobId);
  return { kind: "job", jobId: target.jobId, branch: job?.branch ?? null, commitSha: job?.commitSha ?? null, pushed: (job?.pushedAt ?? null) !== null };
};

/**
 * After a push that did not land, so a refused push never reads as unpushed work over a push that did land. A first push
 * has nothing to go back to; its commit stays recorded as not pushed.
 */
const restorePrior = (deps: PushDeps, prior: Prior): void => {
  const { stores } = deps;
  if (prior.kind === "loop") {
    stores.loops.update(prior.loopId, { pendingPush: prior.pendingPush });
    return;
  }
  const { jobId, branch, commitSha } = prior;
  if (branch === null || commitSha === null || !prior.pushed) return;
  transaction(stores.db, () => {
    stores.jobs.recordCommit(jobId, branch, commitSha);
    stores.jobs.markPushed(jobId);
  });
};

/**
 * A push recorded but not marked (the steward stopped between the push and its record): landed when the remote branch
 * is at its commit, so the next push starts from there instead of being refused by the lease.
 */
export const settleUnfinished = async (deps: PushDeps, target: PushTarget, remote: RemoteCredentials): Promise<void> => {
  const latest = deps.stores.pushes.latest(target.jobId);
  if (latest === null || latest.pushedAt !== null) return;
  const site = await lsRemoteSite({ jobDir: jobDirOf(deps.config.dataDir, target.jobId) }, remote);
  const branches = await remoteTicketBranches(site.remote, site.cwd, target.identifier);
  if (branches.some(({ ref, sha }) => ref === `refs/heads/${latest.branch}` && sha === latest.sha)) markLanded(deps, target, latest);
};

/** A loop pushes onto its head; a job that pushed already this run onto its last push; otherwise `target` decides. */
const startOf = (deps: PushDeps, target: PushTarget): Start | PushResult => {
  if (target.loopId !== null) {
    const loop = deps.stores.loops.get(target.loopId);
    if (loop === null) return refuse("this run's fix loop no longer exists");
    return { kind: "fastForward", branch: loop.branch, base: loop.headSha };
  }
  const last = deps.stores.pushes.latestPushed(target.jobId);
  if (last !== null) return { kind: "fastForward", branch: last.branch, base: last.sha };
  if (target.mode === "create") return { kind: "create", base: target.baseSha };
  if (target.branch === null) return refuse("this run has no branch to push to");
  return { kind: "fastForward", branch: target.branch, base: target.baseSha };
};

/** Commits in `base..head` whose subject does not start with `<identifier>: `. */
const unprefixed = async (worktreePath: string, base: string, head: string, identifier: string): Promise<string[]> => {
  const log = await gitOrThrow(["log", "--format=%h %s", `${base}..${head}`], worktreePath, NO_REPLACE);
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

  await settleUnfinished(deps, target, remote);
  const start = startOf(deps, target);
  if ("ok" in start) return start;

  // 1. Only committed work is pushed.
  const { files: overlayFiles, secrets } = await guardSecrets(deps.config.workspace.overlayDir, deps.secrets);
  const stewardFiles = await stewardCopies(deps.config.workspace.skillsDir, overlayFiles);
  const dirty = await uncommittedPaths(worktreePath, stewardFiles);
  if (dirty.length > 0) return refuse("commit or discard your changes first", dirty.join("\n"));

  // 2. New, merge-free commits on the head the push starts from.
  const sha = await gitOrThrow(["rev-parse", "HEAD"], worktreePath);
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
  const checked = await runSetup(stewardChecks(settings.checks, target.baseSha), worktreePath, buildWorkspaceEnv(target.port), {
    timeoutMs: settings.checksTimeoutMinutes * MINUTE_MS,
    tailBytes: CHECK_TAIL_BYTES,
  });
  if (!checked.ok) return refuse("the steward's checks failed", deps.redactor.redact(checked.tail));

  // 6. The run can last an hour; never push for a ticket closed meanwhile.
  const ticket = await deps.tracker.fetchTicket(target.issueId);
  const closed = closedReason(target.identifier, ticket.state);
  if (closed !== null) return refuse(closed);

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
  const { stores } = deps;
  const prior = priorOf(deps, target);
  const pushId = transaction(stores.db, () => {
    const id = stores.pushes.record({ jobId: target.jobId, loopId: target.loopId, branch, sha, previousSha: start.kind === "create" ? null : start.base, note: input.note ?? null });
    if (target.loopId !== null) stores.loops.update(target.loopId, { pendingPush: { sha, pushed: false } });
    else stores.jobs.recordCommit(target.jobId, branch, sha);
    return id;
  });
  try {
    await mkdir(jobDir, { recursive: true, mode: 0o700 });
    await saveBundle(worktreePath, start.base, join(jobDir, PUSH_BUNDLE));
    await pushFromBundle(deps, jobDir, { remote, sha, base: start.base, branch, identifier: target.identifier, branchTypes: settings.branchTypes, mode });
  } catch (err) {
    restorePrior(deps, prior);
    if (err instanceof BranchExistsError) return refuse(`a branch for ${target.identifier} already exists`, err.ref.replace(/^refs\/heads\//, ""));
    return refuse("the push was rejected", deps.redactor.redact(errorMessage(err)));
  }
  markLanded(deps, target, { id: pushId, sha });
  const commits = Number(await gitOrThrow(["rev-list", "--count", `${start.base}..${sha}`], worktreePath));
  return { ok: true, branch, sha, commits };
};
