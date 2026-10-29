import { existsSync } from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { INTERRUPTED_ERROR } from "../brain/types.js";
import { attachedMedia } from "../codehost/media.js";
import type { ImplementConfig } from "../config/schema.js";
import { renderTicketMarkdown } from "../core/context.js";
import type { PipelineDeps } from "../core/deps.js";
import { closedReason } from "../core/intake.js";
import { readRepoPartial } from "../core/prompt.js";
import { collectSecretValues } from "../core/redact.js";
import type { JobOutcome, RunContext } from "../core/types.js";
import { crashed, errorMessage, jobPaths, jobPort, patchAttempt, prepareFailed, redactOutcome, SetupError, stableWorktreeName, type JobPaths } from "../core/workspace.js";
import { isLabelImplement, startLoop } from "../greptile/start.js";
import type { PushTarget } from "../push/target.js";
import { setupTailOf } from "../run/execute.js";
import { localExecutor } from "../run/local.js";
import type { RunReport, RunSpec, WorkReport } from "../run/protocol.js";
import { transaction, type Job } from "../store/index.js";
import type { TicketBundle } from "../tracker/types.js";
import { listFiles } from "../workspace/files.js";
import { injectToken, splitCredentials, type RemoteCredentials } from "../workspace/mirror.js";
import { extractAgentBrief } from "./brief.js";
import { bundleBase, remoteTicketBranches } from "./git.js";
import { renderImplementPrompt } from "./prompt.js";
import { publishImplement } from "./publish.js";
import { validateImplementResult, type Handback, type StoredImplement } from "./result.js";

/** How much of a failed check's output a hand-back keeps. */
export const CHECK_TAIL_BYTES = 8 * 1024;
/** Where the steward bundled its own commit before the push tool; read only to start the loop for such a job on retry. */
const LEGACY_BUNDLE_FILE = "implement.bundle";
const LS_REMOTE_DIR = "ls-remote";
const SKILLS_PREFIX = ".claude/skills/";

/** `implement.checks` with `{{baseSha}}` filled in. */
export const stewardChecks = (checks: string[], baseSha: string): string[] => checks.map((command) => command.replaceAll("{{baseSha}}", baseSha));

/** The worktree paths the steward copied in: overlay files at their own paths, its skills under `.claude/skills/`. */
export const stewardCopies = async (skillsDir: string | undefined, overlayFiles: string[]): Promise<string[]> => {
  const skills = skillsDir !== undefined && existsSync(skillsDir) ? await listFiles(skillsDir) : [];
  return [...overlayFiles, ...skills.map((file) => `${SKILLS_PREFIX}${file}`)];
};

const notConfigured: JobOutcome = { status: "failed", error: "implement is not configured (implement block and GITLAB_PUSH_TOKEN)", retryable: false };

type Settings = { settings: ImplementConfig; remote: RemoteCredentials };

/** The implement settings and the push remote (with GITLAB_PUSH_TOKEN), or null when implement is not configured. */
export const settingsOf = (deps: Pick<PipelineDeps, "config" | "secrets">): Settings | null => {
  const settings = deps.config.implement;
  const token = deps.secrets.GITLAB_PUSH_TOKEN;
  if (settings === undefined || token === undefined || token === "") return null;
  return { settings, remote: splitCredentials(injectToken(deps.config.workspace.fetchUrl, token)) };
};

/**
 * A fresh, empty, steward-made directory for token-carrying `ls-remote`. The ceiling stops git's repository discovery
 * from reaching the job dir (where an earlier attempt's agent could have planted repo files), so no repo config applies.
 */
export const lsRemoteSite = async (paths: Pick<JobPaths, "jobDir">, remote: RemoteCredentials): Promise<{ cwd: string; remote: RemoteCredentials }> => {
  await mkdir(paths.jobDir, { recursive: true, mode: 0o700 });
  const cwd = join(paths.jobDir, LS_REMOTE_DIR);
  await rm(cwd, { recursive: true, force: true });
  await mkdir(cwd, { mode: 0o700 });
  return { cwd, remote: { url: remote.url, env: { ...remote.env, GIT_CEILING_DIRECTORIES: paths.jobDir } } };
};

/** With `greptile`, a label-triggered implement starts a fix loop once it pushes. */
const startsLoop = (ctx: RunContext, deps: PipelineDeps): boolean => deps.config.greptile !== undefined && isLabelImplement(ctx.trigger);

/** A loop-starting implement runs on the ticket's stable worktree, where its fix rounds resume the brain session. */
const implementPaths = (ctx: RunContext, deps: PipelineDeps): JobPaths =>
  jobPaths(ctx, deps, startsLoop(ctx, deps) ? { worktreeName: stableWorktreeName(ctx.identifier) } : {});

/** Starts the fix loop for the pushed job, re-read so the loop sees its push, commit and session. */
const startLoopFor = (ctx: RunContext, deps: PipelineDeps, paths: JobPaths, baseSha: string): void => {
  const job = deps.stores.jobs.get(ctx.jobId);
  if (job !== null) startLoop(deps, job, { baseSha, worktreeName: paths.worktreeName });
};

const shortRef = (ref: string): string => ref.replace(/^refs\/heads\//, "");

const handback = (label: Handback["label"], reason: string, detail = ""): Handback => ({ label, reason, detail });

const dryRunHandback = ({ reason, detail }: Handback): string => (detail === "" ? `dry run: would hand back: ${reason}` : `dry run: would hand back: ${reason}\n${detail}`);

/** Stored, then published; dry runs stop before storing. */
const finish = async (ctx: RunContext, deps: PipelineDeps, stored: StoredImplement): Promise<JobOutcome> => {
  if (ctx.dryRun) return { status: "succeeded", warning: stored.handback === null ? "dry run: would publish" : dryRunHandback(stored.handback) };
  deps.stores.jobs.saveImplementResult(ctx.jobId, stored);
  return publishImplement({ ctx, tracker: deps.tracker, stored });
};

/** Overlay files (never to be committed) and every secret the change must not carry: the overlay's and the steward's own. */
export const guardSecrets = async (overlayDir: string, stewardSecrets: Record<string, string | undefined>): Promise<{ files: string[]; secrets: string[] }> => {
  const files = existsSync(overlayDir) ? await listFiles(overlayDir) : [];
  return { files, secrets: collectSecretValues(stewardSecrets, files.map((file) => join(overlayDir, file))) };
};

/** The job's pushed branch when it is on the remote: an earlier attempt's agent pushed before the attempt stopped. */
const ownBranch = (job: Job | null, existing: Array<{ ref: string }>): string | null => {
  const branch = job?.branch ?? null;
  return branch !== null && existing.some(({ ref }) => ref === `refs/heads/${branch}`) ? branch : null;
};

/**
 * Whether the job's push landed. The push tool marks it; a push recorded but never marked (the tool stopped between the
 * push and its record) landed when the remote branch is at the recorded commit, and is marked here. Never pushes.
 */
const pushLanded = async (ctx: RunContext, deps: PipelineDeps, paths: JobPaths, remote: RemoteCredentials): Promise<boolean> => {
  const { stores } = deps;
  const job = stores.jobs.get(ctx.jobId);
  if (job === null || job.branch === null || job.commitSha === null) return false;
  if (job.pushedAt !== null) return true;
  const site = await lsRemoteSite(paths, remote);
  const existing = await remoteTicketBranches(site.remote, site.cwd, ctx.identifier);
  if (!existing.some(({ ref, sha }) => ref === `refs/heads/${job.branch}` && sha === job.commitSha)) return false;
  const push = stores.pushes.latest(ctx.jobId);
  transaction(stores.db, () => {
    if (push !== null && push.pushedAt === null && push.sha === job.commitSha) stores.pushes.markPushed(push.id);
    stores.jobs.markPushed(ctx.jobId);
  });
  return true;
};

/** The spec's run id: the job's attempt, or the dry run's process. */
export const runIdOf = (ctx: RunContext): string => (ctx.dryRun ? `dry-${process.pid}` : `${ctx.jobId}-${ctx.attempt}`);

/** The implement prompt for the ticket, cut from `baseSha` into the run's worktree. */
const implementPrompt = async (
  ctx: RunContext,
  deps: PipelineDeps,
  p: { settings: ImplementConfig; bundle: TicketBundle; baseSha: string; paths: JobPaths },
): Promise<string> => {
  const { settings, bundle, baseSha, paths } = p;
  const brief = extractAgentBrief(bundle.description);
  return renderImplementPrompt(await readFile(settings.prompt, "utf8"), {
    identifier: ctx.identifier,
    teamKey: ctx.teamKey,
    teamName: bundle.team.name,
    ticket: renderTicketMarkdown(bundle),
    workspacePath: join(paths.workRoot, paths.worktreeName),
    baseBranch: deps.config.workspace.baseBranch,
    sha: baseSha,
    artifactsDir: paths.artifactsDir,
    stewardPort: jobPort(deps),
    hasBrief: brief !== null,
    brief: brief ?? "",
    branchTypes: settings.branchTypes.join(", "),
    hasChecks: settings.checks.length > 0,
    checks: stewardChecks(settings.checks, baseSha).map((command) => `- \`${command}\``).join("\n"),
  }, await readRepoPartial(deps.configPath));
};

/**
 * `steward implement --dry-run`: the prompt a run on the ticket would get, from the bundle the dispatcher read, cut from
 * the mirror's current base (never fetched here). Runs nothing and writes nothing.
 */
export const previewImplementPrompt = async (ctx: RunContext, deps: PipelineDeps, bundle: TicketBundle): Promise<string> => {
  const settings = deps.config.implement;
  if (settings === undefined) throw new Error("implement is not configured (add an implement block)");
  const { baseBranch } = deps.config.workspace;
  const baseSha = deps.mirror.exists() ? await deps.mirror.resolveSha(baseBranch) : `<${baseBranch}>`;
  return implementPrompt(ctx, deps, { settings, bundle, baseSha, paths: implementPaths(ctx, deps) });
};

/**
 * The prepare half: the closed check, the base, the ticket-branch checks and the prompt. Either a spec to execute, or the
 * job's outcome without running the brain.
 */
export const prepareImplement = async (ctx: RunContext, deps: PipelineDeps): Promise<{ spec: RunSpec } | { outcome: JobOutcome }> => {
  const configured = settingsOf(deps);
  if (configured === null) return { outcome: notConfigured };
  if (ctx.resume !== undefined) return { spec: ctx.resume };
  const { settings, remote } = configured;
  const paths = implementPaths(ctx, deps);

  let bundle: TicketBundle;
  let baseSha: string;
  let existing: Array<{ ref: string; sha: string }>;
  try {
    bundle = await deps.tracker.fetchTicket(ctx.issueId);
    const closed = closedReason(ctx.identifier, bundle.state);
    if (closed !== null) return { outcome: { status: "failed", error: closed, retryable: false } };
    await deps.mirror.fetch();
    baseSha = await deps.mirror.resolveSha(deps.config.workspace.baseBranch);
    const site = await lsRemoteSite(paths, remote);
    existing = await remoteTicketBranches(site.remote, site.cwd, ctx.identifier);
  } catch (err) {
    return { outcome: { status: "failed", error: errorMessage(err), retryable: true } };
  }
  // A rerun after the agent pushed (the attempt was interrupted later) never runs the brain again over its own branch.
  const own = ctx.dryRun ? null : ownBranch(deps.stores.jobs.get(ctx.jobId), existing);
  if (own !== null) return { outcome: await finish(ctx, deps, { result: null, handback: handback("readyForHuman", "an earlier attempt stopped after the agent pushed", own) }) };
  if (existing[0] !== undefined) {
    return { outcome: await finish(ctx, deps, { result: null, handback: handback("readyForHuman", `a branch for ${ctx.identifier} already exists`, shortRef(existing[0].ref)) }) };
  }

  const worktreePath = join(paths.workRoot, paths.worktreeName);
  let prompt: string;
  try {
    prompt = await implementPrompt(ctx, deps, { settings, bundle, baseSha, paths });
  } catch (err) {
    return { outcome: prepareFailed(deps, err) };
  }

  // The first push creates the ticket's branch on the base; a dry run (no job row) gets no push tool.
  const push: PushTarget | null = ctx.dryRun
    ? null
    : { jobId: ctx.jobId, worktreePath, identifier: ctx.identifier, issueId: ctx.issueId, title: bundle.title, mode: "create", branch: null, baseSha, loopId: null, port: jobPort(deps) };
  const spec: RunSpec = {
    version: 1,
    runId: runIdOf(ctx),
    jobId: ctx.jobId,
    kind: "implement",
    identifier: ctx.identifier,
    issueId: ctx.issueId,
    checkout: { ref: null, sha: baseSha },
    baseSha,
    worktreePath,
    artifactsDir: paths.artifactsDir,
    transcriptPath: paths.transcriptPath,
    prompt,
    personCommits: null,
    output: "implement",
    resumeSessionId: null,
    limits: { timeoutMinutes: settings.timeoutMinutes, maxTurns: settings.maxTurns, setupTimeoutMinutes: deps.config.workspace.setupTimeoutMinutes },
    push,
    setup: deps.config.workspace.setup,
    checks: stewardChecks(settings.checks, baseSha),
    interactive: false,
  };
  return { spec };
};

/** The finish half, from the executor's report and the work it found: the result, the push, the hand-back or the publish. */
export const finishImplement = async (ctx: RunContext, deps: PipelineDeps, spec: RunSpec, executed: { report: RunReport; work: WorkReport }): Promise<JobOutcome> => {
  const configured = settingsOf(deps);
  if (configured === null) return notConfigured;
  const paths = implementPaths(ctx, deps);
  const { report, work } = executed;
  const { baseSha } = spec;

  if (report.setupFailed) {
    patchAttempt(ctx, deps, { setupTail: setupTailOf(report) });
    return report.interrupted ? { status: "failed", error: INTERRUPTED_ERROR, retryable: true } : { status: "failed", error: report.error ?? "setup failed", retryable: true };
  }
  // Where the session is keyed: a later chat recreates this worktree at this path when it is gone.
  if (!ctx.dryRun) deps.stores.jobs.recordWorkspace(ctx.jobId, paths.worktreeName, baseSha);
  patchAttempt(ctx, deps, { transcriptPath: paths.transcriptPath, ...(report.usage === null ? {} : { usage: report.usage }) });
  if (report.sessionId !== null && !ctx.dryRun) deps.stores.jobs.recordSession(ctx.jobId, report.sessionId);
  if (!report.ok) return { status: "failed", error: report.error ?? "brain run failed", retryable: report.interrupted };

  const validated = validateImplementResult(report.output);
  if (!validated.ok) return finish(ctx, deps, { result: null, handback: handback("readyForHuman", "the agent's result was invalid", validated.error) });
  const result = validated.result;
  if (result.outcome === "needs_info") return finish(ctx, deps, { result, handback: handback("needsInfo", "the ticket needs more information") });
  if (result.outcome === "failed") return finish(ctx, deps, { result, handback: handback("readyForHuman", "the agent could not finish") });

  if (ctx.dryRun) {
    return { status: "succeeded", warning: `dry run: no push tool; the agent's work on ${baseSha.slice(0, 7)}:\n${work.unpushed === "" ? "nothing" : work.unpushed}` };
  }

  // Attached once, before anything is stored: a retry publishes the stored embeds and never uploads again.
  const media = await attachedMedia({
    attached: report.media,
    items: result.media,
    artifactsDir: spec.artifactsDir,
    gitlab: deps.gitlab,
    project: deps.config.codehost.kind === "gitlab" ? deps.config.codehost.project : null,
  });
  const withMedia = media === undefined ? {} : { media };

  // The agent pushed through the push tool; the steward only reads the outcome, and never commits or pushes for it.
  let landed: boolean;
  try {
    landed = await pushLanded(ctx, deps, paths, configured.remote);
  } catch (err) {
    // Stored first, so the retry settles the push (publishImplementOnly) instead of running the brain again.
    deps.stores.jobs.saveImplementResult(ctx.jobId, { result, handback: null, baseSha, ...withMedia });
    return { status: "publish_failed", error: `push: ${errorMessage(err)}` };
  }
  const detail = deps.redactor.redact(work.unpushed);
  if (!landed) return finish(ctx, deps, { result, handback: handback("readyForHuman", "the agent did not push its change", detail), baseSha });
  if (work.unpushed !== "") return finish(ctx, deps, { result, handback: handback("readyForHuman", "the agent left unpushed work", detail), baseSha });

  const stored: StoredImplement = { result, handback: null, baseSha, ...withMedia };
  // Stored before the loop starts, so a crash from here on retries via publishImplementOnly, which starts it once.
  deps.stores.jobs.saveImplementResult(ctx.jobId, stored);
  startLoopFor(ctx, deps, paths, baseSha);
  return publishImplement({ ctx, tracker: deps.tracker, stored });
};

const executeImplement = async (ctx: RunContext, deps: PipelineDeps): Promise<JobOutcome> => {
  const prepared = await prepareImplement(ctx, deps);
  if ("outcome" in prepared) return prepared.outcome;
  let executed: { report: RunReport; work: WorkReport };
  try {
    executed = await (deps.executor ?? localExecutor(deps)).execute(prepared.spec, deps.signal);
  } catch (err) {
    if (err instanceof SetupError) patchAttempt(ctx, deps, { setupTail: err.tail });
    return prepareFailed(deps, err);
  }
  return finishImplement(ctx, deps, prepared.spec, executed);
};

/** Prepare, execute (in-process or in a run pod), finish. */
export const runImplement = async (ctx: RunContext, deps: PipelineDeps): Promise<JobOutcome> => redactOutcome(await executeImplement(ctx, deps).catch(crashed), deps.redactor);

/**
 * Retry path: settles a push recorded but not marked (landed on the remote → pushed; otherwise hand back), starts the
 * loop if a crash stopped it, then labels. Never runs the brain and never pushes: only the agent's push tool pushes.
 */
export const publishImplementOnly = async (ctx: RunContext, deps: PipelineDeps): Promise<JobOutcome> => {
  const configured = settingsOf(deps);
  if (configured === null) return notConfigured;
  const job = deps.stores.jobs.get(ctx.jobId);
  const stored = job?.implementResult ?? null;
  if (job === null || stored === null) return { status: "failed", error: "no stored implement result to publish", retryable: false };
  const paths = implementPaths(ctx, deps);
  if (stored.handback === null && job.pushedAt === null) {
    let landed: boolean;
    try {
      landed = await pushLanded(ctx, deps, paths, configured.remote);
    } catch (err) {
      return { status: "publish_failed", error: `push: ${errorMessage(err)}` };
    }
    if (!landed) {
      const detail = job.branch ?? "";
      return finish(ctx, deps, { result: stored.result, handback: handback("readyForHuman", "the push did not complete", detail), ...(stored.baseSha === undefined ? {} : { baseSha: stored.baseSha }) });
    }
  }
  // Also after a crash between the push record and the loop's start; startLoop returns an existing loop untouched.
  if (stored.handback === null && startsLoop(ctx, deps) && deps.stores.loops.forImplementJob(ctx.jobId) === null) {
    try {
      startLoopFor(ctx, deps, paths, stored.baseSha ?? (await bundleBase(join(paths.jobDir, LEGACY_BUNDLE_FILE))));
    } catch (err) {
      return { status: "publish_failed", error: `loop: ${errorMessage(err)}` };
    }
  }
  return publishImplement({ ctx, tracker: deps.tracker, stored });
};
