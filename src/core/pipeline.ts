import { mkdir, readFile } from "node:fs/promises";
import { basename } from "node:path";
import { buildBrainEnv, INTERRUPTED_ERROR, runBrainDetached } from "../brain/index.js";
import type { BrainRun } from "../brain/types.js";
import { logger } from "../log.js";
import type { TicketBundle } from "../tracker/types.js";
import type { Worktree } from "../workspace/worktree.js";
import { resolveAttachments } from "./attachments.js";
import { renderTemplatesMarkdown, renderTicketMarkdown } from "./context.js";
import type { PipelineDeps } from "./deps.js";
import { gatewayRoute, isGatewayIssue } from "./gateway.js";
import { CLOSED_STATE_TYPES } from "./intake.js";
import { renderPrompt } from "./prompt.js";
import type { Redactor } from "./redact.js";
import { alreadyCommented, buildTriageComment, buildEnrichmentSection, replaceSection } from "./render.js";
import { captureReproFiles, isBugTicket, normalizeRepro, reproFilesDir } from "./repro.js";
import { validateResult, type Repro, type StoredBrainResult } from "./result.js";
import type { JobOutcome, RunContext } from "./types.js";
import { brainInput, cleanupWorkspace, crashed, errorMessage, jobPaths, patchAttempt, prepareWorkspace, redactOutcome, type JobPaths } from "./workspace.js";
import { appPortOf } from "../config/schema.js";

export type { PipelineDeps } from "./deps.js";
export { redactOutcome } from "./workspace.js";

interface Prepared {
  bundle: TicketBundle;
  worktree: Worktree;
  prompt: string;
  isBug: boolean;
}

/** Thrown before any work when the ticket is Done or Canceled; retrying cannot help. */
class ClosedTicketError extends Error {}

const closedError = (identifier: string, state: TicketBundle["state"]): ClosedTicketError | null =>
  CLOSED_STATE_TYPES.includes(state.type) ? new ClosedTicketError(`${identifier} is ${state.name}; Ticket Steward does not enrich Done or Canceled tickets`) : null;

const redactRepro = (repro: Repro | null, redactor: Redactor): Repro | null =>
  repro === null
    ? null
    : {
        ...repro,
        command: repro.command === null ? null : redactor.redact(repro.command),
        steps: repro.steps.map((step) => redactor.redact(step)),
        expected: redactor.redact(repro.expected),
        observed: redactor.redact(repro.observed),
      };

const redactResult = (result: StoredBrainResult, redactor: Redactor): StoredBrainResult => ({
  ...result,
  summary: redactor.redact(result.summary),
  enrichment: redactor.redact(result.enrichment),
  attachments: result.attachments.map((item) => ({ ...item, caption: redactor.redact(item.caption) })),
  repro: redactRepro(result.repro, redactor),
  triage:
    result.triage === null
      ? null
      : {
          ...result.triage,
          questions: result.triage.questions.map((question) => redactor.redact(question)),
          agentBrief: result.triage.agentBrief === null ? null : redactor.redact(result.triage.agentBrief),
        },
});

const prepare = async (ctx: RunContext, deps: PipelineDeps, paths: JobPaths, env: Record<string, string>, onWorktree: (worktree: Worktree) => void): Promise<Prepared> => {
  const { config, tracker, mirror } = deps;
  const bundle = await tracker.fetchTicket(ctx.issueId);
  const closed = closedError(ctx.identifier, bundle.state);
  if (closed !== null) throw closed;
  await mirror.fetch();
  const sha = await mirror.resolveSha(config.workspace.baseBranch);
  const worktree = await prepareWorkspace(ctx, deps, paths, env, sha, onWorktree);
  const isBug = isBugTicket(bundle.labels, config.tracker.bugLabels);
  const prompt = renderPrompt(await readFile(config.prompt, "utf8"), {
    ticket: renderTicketMarkdown(bundle),
    templates: renderTemplatesMarkdown(bundle),
    workspacePath: worktree.path,
    baseBranch: config.workspace.baseBranch,
    sha,
    artifactsDir: paths.artifactsDir,
    teamKey: ctx.teamKey,
    teamName: bundle.team.name,
    stewardPort: appPortOf(config, 1),
    gateway: isGatewayIssue(bundle.description) ? (gatewayRoute(bundle.description) ?? { className: "unknown", teamKey: "unknown" }) : null,
    isBug,
  });
  return { bundle, worktree, prompt, isBug };
};

const uploadAttachments = async (deps: PipelineDeps, artifactsDir: string, result: StoredBrainResult): Promise<{ uploaded: Array<{ url: string; caption: string }>; notes: string[] }> => {
  const { accepted, notes } = await resolveAttachments(artifactsDir, result.attachments);
  const uploaded: Array<{ url: string; caption: string }> = [];
  for (const item of accepted) {
    try {
      const { url } = await deps.tracker.uploadFile(item.path, item.contentType);
      uploaded.push({ url, caption: item.caption });
    } catch (err) {
      logger.warn({ file: item.path, err: errorMessage(err) }, "attachment upload failed");
      notes.push(`Attachment \`${basename(item.path)}\` dropped: upload failed.`);
    }
  }
  return { uploaded, notes: notes.map((note) => deps.redactor.redact(note)) };
};

const publish = async (ctx: RunContext, deps: PipelineDeps, stored: StoredBrainResult, sha: string, artifactsDir: string, extraNotes: string[] = []): Promise<JobOutcome> => {
  const { tracker, config, codehost } = deps;
  const result = redactResult(stored, deps.redactor);
  let comments: ReadonlyArray<{ body: string }> = [];
  try {
    // The brain runs for minutes; a ticket closed meanwhile must not be written to.
    const latest = await tracker.fetchTicket(ctx.issueId);
    const closed = closedError(ctx.identifier, latest.state);
    if (closed !== null) return { status: "failed", error: closed.message, retryable: false };
    comments = latest.comments;
    const { uploaded, notes } = await uploadAttachments(deps, artifactsDir, result);
    const section = buildEnrichmentSection(result, uploaded, [...notes, ...extraNotes.map((note) => deps.redactor.redact(note))], {
      now: deps.now(),
      sha,
      branch: config.workspace.baseBranch,
      jobId: ctx.jobId,
      permalink: (path, line) => codehost.permalink(path, sha, line),
    });
    const current = await tracker.readDescription(ctx.issueId);
    patchAttempt(ctx, deps, { preWriteDescription: current });
    await tracker.writeDescription(ctx.issueId, replaceSection(current, section));
  } catch (err) {
    return { status: "publish_failed", error: errorMessage(err) };
  }
  const labels = config.tracker.labels;
  // A legacy stored result (no triage) has no verdict to swap to.
  const swap = ctx.trigger.kind !== "mr.review" && ctx.trigger.action === "triage" && labels !== undefined && result.triage !== null ? { labels, triage: result.triage } : null;
  let warning: string | undefined;
  try {
    const body = buildTriageComment(result, ctx.jobId);
    if (!alreadyCommented(comments, body)) await tracker.postComment(ctx.issueId, body);
  } catch (err) {
    // The verdict (and a needs-info ticket's questions) lives only in this comment: never move the label without it.
    if (swap !== null) return { status: "publish_failed", error: `comment: ${errorMessage(err)}` };
    warning = errorMessage(err);
  }
  if (swap !== null) {
    const target = swap.triage.state === "needs-info" ? swap.labels.needsInfo : swap.labels.readyForHuman;
    try {
      await tracker.swapLabel(ctx.issueId, swap.labels.triage, target);
    } catch (err) {
      return { status: "publish_failed", error: `labels: ${errorMessage(err)}` };
    }
  }
  return warning === undefined ? { status: "succeeded" } : { status: "succeeded", warning };
};

const execute = async (ctx: RunContext, deps: PipelineDeps, onWorktree: (worktree: Worktree) => void): Promise<JobOutcome> => {
  const { config, secrets } = deps;
  const paths = jobPaths(ctx, deps);
  const env = buildBrainEnv(secrets, config.brain, appPortOf(config, 1));
  let prepared: Prepared;
  try {
    prepared = await prepare(ctx, deps, paths, env, onWorktree);
  } catch (err) {
    if (err instanceof ClosedTicketError) return { status: "failed", error: err.message, retryable: false };
    return { status: "failed", error: deps.signal?.aborted === true ? INTERRUPTED_ERROR : errorMessage(err), retryable: true };
  }
  const { worktree, prompt } = prepared;
  let run: BrainRun;
  try {
    run = await (deps.runBrain ?? runBrainDetached)(config.brain, brainInput(deps, paths, worktree, prompt, env, "enrich"), deps.redactor, {
      ...(deps.signal === undefined ? {} : { signal: deps.signal }),
    });
  } catch (err) {
    return { status: "failed", error: errorMessage(err), retryable: false };
  }
  patchAttempt(ctx, deps, { transcriptPath: paths.transcriptPath, ...(run.usage === undefined ? {} : { usage: run.usage }) });
  if (!run.ok) return { status: "failed", error: run.error ?? "brain run failed", retryable: run.error === INTERRUPTED_ERROR };
  const validated = validateResult(run.output);
  if (!validated.ok) return { status: "failed", error: validated.error, retryable: false };
  let result = normalizeRepro(validated.result, prepared.isBug);
  const recipeNotes: string[] = [];
  if (!ctx.dryRun && result.repro !== null) {
    const filesDir = reproFilesDir(config.dataDir, ctx.jobId);
    const { saved, notes } = await captureReproFiles(worktree.path, result.repro.files, filesDir);
    recipeNotes.push(...notes);
    const recipe: Repro = { ...result.repro, files: saved };
    result = { ...result, repro: recipe };
    deps.stores.repros.upsert({ issueId: ctx.issueId, identifier: ctx.identifier, jobId: ctx.jobId, sha: worktree.sha, recipe, filesDir });
  }
  if (!ctx.dryRun) deps.stores.jobs.saveResult(ctx.jobId, result, worktree.sha);
  return publish(ctx, deps, result, worktree.sha, paths.artifactsDir, recipeNotes);
};

export const runJob = async (ctx: RunContext, deps: PipelineDeps): Promise<JobOutcome> => {
  const workspace: { worktree: Worktree | null } = { worktree: null };
  const outcome = redactOutcome(
    await execute(ctx, deps, (created) => {
      workspace.worktree = created;
    }).catch(crashed),
    deps.redactor,
  );
  await cleanupWorkspace(deps, workspace.worktree, outcome);
  return outcome;
};

export const publishOnly = async (ctx: RunContext, deps: PipelineDeps): Promise<JobOutcome> => {
  const job = deps.stores.jobs.get(ctx.jobId);
  if (job === null || job.result === null || job.resultSha === null) {
    return { status: "failed", error: "no stored result to publish", retryable: false };
  }
  const { artifactsDir } = jobPaths(ctx, deps);
  await mkdir(artifactsDir, { recursive: true, mode: 0o700 });
  return publish(ctx, deps, job.result, job.resultSha, artifactsDir);
};