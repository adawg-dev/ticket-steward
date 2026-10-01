import { existsSync } from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { buildBrainEnv, buildWorkspaceEnv, INTERRUPTED_ERROR, runBrainDetached } from "../brain/index.js";
import type { BrainRun } from "../brain/types.js";
import type { ImplementConfig } from "../config/schema.js";
import { renderTicketMarkdown } from "../core/context.js";
import type { PipelineDeps } from "../core/deps.js";
import { closedReason } from "../core/intake.js";
import { collectSecretValues } from "../core/redact.js";
import type { JobOutcome, RunContext } from "../core/types.js";
import { brainInput, cleanupWorkspace, crashed, errorMessage, jobPaths, patchAttempt, prepareWorkspace, redactOutcome, type JobPaths } from "../core/workspace.js";
import type { TicketBundle } from "../tracker/types.js";
import { listFiles } from "../workspace/files.js";
import { git } from "../workspace/git.js";
import { injectToken, splitCredentials, type RemoteCredentials } from "../workspace/mirror.js";
import { runSetup } from "../workspace/setup.js";
import type { Worktree } from "../workspace/worktree.js";
import { branchName } from "./branch.js";
import { extractAgentBrief } from "./brief.js";
import { BranchExistsError, bundleBase, commitWithHooks, guardCommit, installHookWrappers, pushCommit, remoteTicketBranches, saveBundle, stageAndGuard } from "./git.js";
import { renderImplementPrompt } from "./prompt.js";
import { branchUrl, publishImplement } from "./publish.js";
import { validateImplementResult, type Handback, type StoredImplement } from "./result.js";

const MINUTE_MS = 60_000;
const CHECK_TAIL_BYTES = 8 * 1024;
const BUNDLE_FILE = "implement.bundle";
const PUSH_REPO = "push.git";
const LS_REMOTE_DIR = "ls-remote";
const SKILLS_PREFIX = ".claude/skills/";

const stewardChecks = (checks: string[], baseSha: string): string[] => checks.map((command) => command.replaceAll("{{baseSha}}", baseSha));

/** The worktree paths the steward copied in: overlay files at their own paths, its skills under `.claude/skills/`. */
const stewardCopies = async (skillsDir: string | undefined, overlayFiles: string[]): Promise<string[]> => {
  const skills = skillsDir !== undefined && existsSync(skillsDir) ? await listFiles(skillsDir) : [];
  return [...overlayFiles, ...skills.map((file) => `${SKILLS_PREFIX}${file}`)];
};

const notConfigured: JobOutcome = { status: "failed", error: "implement is not configured (implement block and GITLAB_PUSH_TOKEN)", retryable: false };

type Settings = { settings: ImplementConfig; remote: RemoteCredentials };

const settingsOf = (deps: PipelineDeps): Settings | null => {
  const settings = deps.config.implement;
  const token = deps.secrets.GITLAB_PUSH_TOKEN;
  if (settings === undefined || token === undefined || token === "") return null;
  return { settings, remote: splitCredentials(injectToken(deps.config.workspace.fetchUrl, token)) };
};

/**
 * A fresh, empty, steward-made directory for token-carrying `ls-remote`. The ceiling stops git's repository discovery
 * from reaching the job dir (where an earlier attempt's agent could have planted repo files), so no repo config applies.
 */
const lsRemoteSite = async (paths: JobPaths, remote: RemoteCredentials): Promise<{ cwd: string; remote: RemoteCredentials }> => {
  await mkdir(paths.jobDir, { recursive: true, mode: 0o700 });
  const cwd = join(paths.jobDir, LS_REMOTE_DIR);
  await rm(cwd, { recursive: true, force: true });
  await mkdir(cwd, { mode: 0o700 });
  return { cwd, remote: { url: remote.url, env: { ...remote.env, GIT_CEILING_DIRECTORIES: paths.jobDir } } };
};

/** Pushes the bundled commit from a scratch repo in the job dir; never from the worktree or mirror (agent-writable config). */
const pushFromBundle = async (input: { paths: JobPaths; deps: PipelineDeps; remote: RemoteCredentials; sha: string; baseSha: string; branch: string; identifier: string; branchTypes: string[] }): Promise<void> => {
  const scratchDir = join(input.paths.jobDir, PUSH_REPO);
  try {
    await pushCommit({
      scratchDir,
      objectsDir: join(input.deps.mirror.path, "objects"),
      bundlePath: join(input.paths.jobDir, BUNDLE_FILE),
      remote: input.remote,
      sha: input.sha,
      baseSha: input.baseSha,
      branch: input.branch,
      identifier: input.identifier,
      branchTypes: input.branchTypes,
    });
  } finally {
    await rm(scratchDir, { recursive: true, force: true });
  }
};

const shortRef = (ref: string): string => ref.replace(/^refs\/heads\//, "");

const handback = (label: Handback["label"], reason: string, detail = ""): Handback => ({ label, reason, detail });

const commitMessage = (identifier: string, message: string): string => {
  const [subject = "", ...body] = message.trim().split("\n");
  return [`${identifier}: ${subject.trim()}`, ...body].join("\n");
};

const dryRunHandback = ({ reason, detail }: Handback): string => (detail === "" ? `dry run: would hand back: ${reason}` : `dry run: would hand back: ${reason}\n${detail}`);

/** Stored, then published; dry runs stop before storing. */
const finish = async (ctx: RunContext, deps: PipelineDeps, stored: StoredImplement, branch: string | null): Promise<JobOutcome> => {
  if (ctx.dryRun) return { status: "succeeded", warning: stored.handback === null ? `dry run: would push ${branch ?? "?"}` : dryRunHandback(stored.handback) };
  deps.stores.jobs.saveImplementResult(ctx.jobId, stored);
  return publishImplement({
    ctx,
    tracker: deps.tracker,
    redactor: deps.redactor,
    labels: deps.config.tracker.labels,
    stored,
    branch,
    branchUrl: branch === null ? null : branchUrl(deps.config.codehost, branch),
  });
};

/** Overlay files (never to be committed) and every secret the change must not carry: the overlay's and the steward's own. */
const guardSecrets = async (overlayDir: string, stewardSecrets: Record<string, string | undefined>): Promise<{ files: string[]; secrets: string[] }> => {
  const files = existsSync(overlayDir) ? await listFiles(overlayDir) : [];
  return { files, secrets: collectSecretValues(stewardSecrets, files.map((file) => join(overlayDir, file))) };
};

const executeImplement = async (ctx: RunContext, deps: PipelineDeps, onWorktree: (worktree: Worktree) => void): Promise<JobOutcome> => {
  const configured = settingsOf(deps);
  if (configured === null) return notConfigured;
  const { settings, remote } = configured;
  const paths = jobPaths(ctx, deps);

  let bundle: TicketBundle;
  let baseSha: string;
  let existing: Array<{ ref: string; sha: string }>;
  try {
    bundle = await deps.tracker.fetchTicket(ctx.issueId);
    const closed = closedReason(ctx.identifier, bundle.state);
    if (closed !== null) return { status: "failed", error: closed, retryable: false };
    await deps.mirror.fetch();
    baseSha = await deps.mirror.resolveSha(deps.config.workspace.baseBranch);
    const site = await lsRemoteSite(paths, remote);
    existing = await remoteTicketBranches(site.remote, site.cwd, ctx.identifier);
  } catch (err) {
    return { status: "failed", error: errorMessage(err), retryable: true };
  }
  if (existing[0] !== undefined) {
    return finish(ctx, deps, { result: null, handback: handback("readyForHuman", `a branch for ${ctx.identifier} already exists`, shortRef(existing[0].ref)) }, null);
  }

  const env = buildBrainEnv(deps.secrets, deps.config.brain, deps.config.workspace.port);
  let worktree: Worktree;
  let prompt: string;
  try {
    worktree = await prepareWorkspace(ctx, deps, paths, env, baseSha, onWorktree);
    const brief = extractAgentBrief(bundle.description);
    prompt = renderImplementPrompt(await readFile(settings.prompt, "utf8"), {
      identifier: ctx.identifier,
      teamKey: ctx.teamKey,
      teamName: bundle.team.name,
      ticket: renderTicketMarkdown(bundle),
      workspacePath: worktree.path,
      baseBranch: deps.config.workspace.baseBranch,
      sha: baseSha,
      artifactsDir: paths.artifactsDir,
      stewardPort: deps.config.workspace.port,
      hasBrief: brief !== null,
      brief: brief ?? "",
      branchTypes: settings.branchTypes.join(", "),
      hasChecks: settings.checks.length > 0,
      checks: stewardChecks(settings.checks, baseSha).map((command) => `- \`${command}\``).join("\n"),
    });
  } catch (err) {
    return { status: "failed", error: deps.signal?.aborted === true ? INTERRUPTED_ERROR : errorMessage(err), retryable: true };
  }

  let run: BrainRun;
  try {
    run = await (deps.runBrain ?? runBrainDetached)(
      deps.config.brain,
      brainInput(deps, paths, worktree, prompt, env, "implement", { timeoutMinutes: settings.timeoutMinutes, maxTurns: settings.maxTurns }),
      deps.redactor,
      { ...(deps.signal === undefined ? {} : { signal: deps.signal }) },
    );
  } catch (err) {
    return { status: "failed", error: errorMessage(err), retryable: false };
  }
  patchAttempt(ctx, deps, { transcriptPath: paths.transcriptPath, ...(run.usage === undefined ? {} : { usage: run.usage }) });
  if (!run.ok) return { status: "failed", error: run.error ?? "brain run failed", retryable: run.error === INTERRUPTED_ERROR };

  const validated = validateImplementResult(run.output, settings.branchTypes);
  if (!validated.ok) return finish(ctx, deps, { result: null, handback: handback("readyForHuman", "the agent's result was invalid", validated.error) }, null);
  const result = validated.result;
  if (result.outcome === "needs_info") return finish(ctx, deps, { result, handback: handback("needsInfo", "the ticket needs more information") }, null);
  if (result.outcome === "failed") return finish(ctx, deps, { result, handback: handback("readyForHuman", "the agent could not finish") }, null);

  const { files: overlayFiles, secrets } = await guardSecrets(deps.config.workspace.overlayDir, deps.secrets);
  const stewardFiles = await stewardCopies(deps.config.workspace.skillsDir, overlayFiles);
  const guard = await stageAndGuard({ worktreePath: worktree.path, stewardFiles, secretValues: secrets });
  if (!guard.ok) return finish(ctx, deps, { result, handback: handback("readyForHuman", guard.reason, guard.detail) }, null);

  const workspaceEnv = buildWorkspaceEnv(deps.config.workspace.port);
  const checks = stewardChecks(settings.checks, baseSha);
  const checked = await runSetup(checks, worktree.path, workspaceEnv, {
    timeoutMs: settings.checksTimeoutMinutes * MINUTE_MS,
    tailBytes: CHECK_TAIL_BYTES,
    ...(deps.signal === undefined ? {} : { signal: deps.signal }),
  });
  // A shutdown kills the checks; that is an interruption to resume, not a failed check to hand back.
  if (deps.signal?.aborted === true) return { status: "failed", error: INTERRUPTED_ERROR, retryable: true };
  if (!checked.ok) return finish(ctx, deps, { result, handback: handback("readyForHuman", "the steward's checks failed", deps.redactor.redact(checked.tail)) }, null);

  const branch = branchName(result.branchType ?? "", ctx.identifier, bundle.title);
  if (ctx.dryRun) {
    const stat = await git(["diff", "--cached", "--stat"], worktree.path);
    return { status: "succeeded", warning: `dry run: would commit on ${branch}\n${commitMessage(ctx.identifier, result.commitMessage)}\n\n${stat.stdout}` };
  }

  // The brain runs for up to an hour; never commit or push for a ticket that was closed meanwhile.
  let latest: TicketBundle;
  try {
    latest = await deps.tracker.fetchTicket(ctx.issueId);
  } catch (err) {
    return { status: "failed", error: errorMessage(err), retryable: true };
  }
  const closedNow = closedReason(ctx.identifier, latest.state);
  if (closedNow !== null) return { status: "failed", error: closedNow, retryable: false };

  const hooksDir = join(paths.jobDir, "hooks");
  await installHookWrappers(worktree.path, hooksDir);
  const committed = await commitWithHooks({
    worktreePath: worktree.path,
    hooksDir,
    messagePath: join(paths.jobDir, "COMMIT_MSG"),
    message: commitMessage(ctx.identifier, result.commitMessage),
    author: settings.commitAuthor,
    env: workspaceEnv,
  });
  if (!committed.ok) return finish(ctx, deps, { result, handback: handback("readyForHuman", "kickoff's commit hooks rejected the change", deps.redactor.redact(committed.output)) }, null);
  // The hooks ran agent-editable code after the staged guard; push only what passes the same guard as committed.
  const verified = await guardCommit({ worktreePath: worktree.path, baseSha, sha: committed.sha, stewardFiles, secretValues: secrets });
  if (!verified.ok) return finish(ctx, deps, { result, handback: handback("readyForHuman", verified.reason, verified.detail) }, null);

  await saveBundle(worktree.path, baseSha, join(paths.jobDir, BUNDLE_FILE));
  deps.stores.jobs.recordCommit(ctx.jobId, branch, committed.sha);
  const stored: StoredImplement = { result, handback: null };
  // Stored before the push, so any failure from here on (even a crash after the push lands) retries via publishImplementOnly.
  deps.stores.jobs.saveImplementResult(ctx.jobId, stored);
  try {
    await pushFromBundle({ paths, deps, remote, sha: committed.sha, baseSha, branch, identifier: ctx.identifier, branchTypes: settings.branchTypes });
  } catch (err) {
    if (err instanceof BranchExistsError) return finish(ctx, deps, { result, handback: handback("readyForHuman", `a branch for ${ctx.identifier} already exists`, shortRef(err.ref)) }, null);
    return { status: "publish_failed", error: `push: ${errorMessage(err)}` };
  }
  deps.stores.jobs.markPushed(ctx.jobId);
  return finish(ctx, deps, stored, branch);
};

export const runImplement = async (ctx: RunContext, deps: PipelineDeps): Promise<JobOutcome> => {
  const workspace: { worktree: Worktree | null } = { worktree: null };
  const outcome = redactOutcome(
    await executeImplement(ctx, deps, (created) => {
      workspace.worktree = created;
    }).catch(crashed),
    deps.redactor,
  );
  await cleanupWorkspace(deps, workspace.worktree, outcome);
  return outcome;
};

/** Retry path: push from the bundle if the push never landed, then comment and labels. Never re-runs the brain or pushes twice. */
export const publishImplementOnly = async (ctx: RunContext, deps: PipelineDeps): Promise<JobOutcome> => {
  const configured = settingsOf(deps);
  if (configured === null) return notConfigured;
  const job = deps.stores.jobs.get(ctx.jobId);
  const stored = job?.implementResult ?? null;
  if (job === null || stored === null) return { status: "failed", error: "no stored implement result to publish", retryable: false };
  if (stored.handback === null && job.pushedAt === null) {
    if (job.branch === null || job.commitSha === null) return { status: "failed", error: "no recorded commit to push", retryable: false };
    // Never push for a ticket closed since the failed attempt.
    try {
      const latest = await deps.tracker.fetchTicket(ctx.issueId);
      const closed = closedReason(ctx.identifier, latest.state);
      if (closed !== null) return { status: "failed", error: closed, retryable: false };
    } catch (err) {
      return { status: "publish_failed", error: `push: ${errorMessage(err)}` };
    }
    const paths = jobPaths(ctx, deps);
    try {
      // A push that landed before its record was saved (crash window) is ours: the exact branch at the exact commit.
      const site = await lsRemoteSite(paths, configured.remote);
      const existing = await remoteTicketBranches(site.remote, site.cwd, ctx.identifier);
      const landed = existing.some(({ ref, sha }) => ref === `refs/heads/${job.branch}` && sha === job.commitSha);
      if (!landed) {
        // The base comes from the bundle header (no git in the mirror); pushCommit still verifies the commit's parent is that base.
        const baseSha = await bundleBase(join(paths.jobDir, BUNDLE_FILE));
        await pushFromBundle({ paths, deps, remote: configured.remote, sha: job.commitSha, baseSha, branch: job.branch, identifier: ctx.identifier, branchTypes: configured.settings.branchTypes });
      }
    } catch (err) {
      if (err instanceof BranchExistsError) {
        // Someone else's branch now carries the ticket (ours at our commit counted as landed above): hand back, naming it.
        const handedBack: StoredImplement = { result: stored.result, handback: handback("readyForHuman", `a branch for ${ctx.identifier} already exists`, shortRef(err.ref)) };
        return finish(ctx, deps, handedBack, null);
      }
      return { status: "publish_failed", error: `push: ${errorMessage(err)}` };
    }
    deps.stores.jobs.markPushed(ctx.jobId);
  }
  return publishImplement({
    ctx,
    tracker: deps.tracker,
    redactor: deps.redactor,
    labels: deps.config.tracker.labels,
    stored,
    branch: stored.handback === null ? job.branch : null,
    branchUrl: stored.handback === null && job.branch !== null ? branchUrl(deps.config.codehost, job.branch) : null,
  });
};
