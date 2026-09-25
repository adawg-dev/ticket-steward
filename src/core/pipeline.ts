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
import { renderPrompt } from "./prompt.js";
import type { Redactor } from "./redact.js";
import { buildComment, buildEnrichmentSection, replaceSection } from "./render.js";
import { validateResult, type BrainResult } from "./result.js";
import type { JobOutcome, RunContext } from "./types.js";
import { brainInput, cleanupWorkspace, crashed, errorMessage, jobPaths, patchAttempt, prepareWorkspace, redactOutcome, type JobPaths } from "./workspace.js";

export type { PipelineDeps } from "./deps.js";
export { redactOutcome } from "./workspace.js";

interface Prepared {
  bundle: TicketBundle;
  worktree: Worktree;
  prompt: string;
}

const redactResult = (result: BrainResult, redactor: Redactor): BrainResult => ({
  ...result,
  summary: redactor.redact(result.summary),
  enrichment: redactor.redact(result.enrichment),
  attachments: result.attachments.map((item) => ({ ...item, caption: redactor.redact(item.caption) })),
});

const prepare = async (ctx: RunContext, deps: PipelineDeps, paths: JobPaths, env: Record<string, string>, onWorktree: (worktree: Worktree) => void): Promise<Prepared> => {
  const { config, tracker, mirror } = deps;
  const bundle = await tracker.fetchTicket(ctx.issueId);
  await mirror.fetch();
  const sha = await mirror.resolveSha(config.workspace.baseBranch);
  const worktree = await prepareWorkspace(ctx, deps, paths, env, sha, onWorktree);
  const prompt = renderPrompt(await readFile(config.prompt, "utf8"), {
    ticket: renderTicketMarkdown(bundle),
    templates: renderTemplatesMarkdown(bundle),
    workspacePath: worktree.path,
    baseBranch: config.workspace.baseBranch,
    sha,
    artifactsDir: paths.artifactsDir,
    teamKey: ctx.teamKey,
    teamName: bundle.team.name,
    stewardPort: config.workspace.port,
    gateway: isGatewayIssue(bundle.description) ? (gatewayRoute(bundle.description) ?? { className: "unknown", teamKey: "unknown" }) : null,
  });
  return { bundle, worktree, prompt };
};

const uploadAttachments = async (deps: PipelineDeps, artifactsDir: string, result: BrainResult): Promise<{ uploaded: Array<{ url: string; caption: string }>; notes: string[] }> => {
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

const publish = async (ctx: RunContext, deps: PipelineDeps, stored: BrainResult, sha: string, artifactsDir: string): Promise<JobOutcome> => {
  const { tracker, config, codehost } = deps;
  const result = redactResult(stored, deps.redactor);
  try {
    const { uploaded, notes } = await uploadAttachments(deps, artifactsDir, result);
    const section = buildEnrichmentSection(result, uploaded, notes, {
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
  const comment = buildComment(result, ctx.jobId);
  try {
    await tracker.postComment(ctx.issueId, comment);
  } catch (err) {
    return { status: "succeeded", warning: errorMessage(err) };
  }
  return { status: "succeeded" };
};

const execute = async (ctx: RunContext, deps: PipelineDeps, onWorktree: (worktree: Worktree) => void): Promise<JobOutcome> => {
  const { config, secrets } = deps;
  const paths = jobPaths(ctx, deps);
  const env = buildBrainEnv(secrets, config.brain, config.workspace.port);
  let prepared: Prepared;
  try {
    prepared = await prepare(ctx, deps, paths, env, onWorktree);
  } catch (err) {
    return { status: "failed", error: deps.signal?.aborted === true ? INTERRUPTED_ERROR : errorMessage(err), retryable: true };
  }
  const { worktree, prompt } = prepared;
  let run: BrainRun;
  try {
    run = await (deps.runBrain ?? runBrainDetached)(config.brain, brainInput(deps, paths, worktree, prompt, env), deps.redactor, {
      ...(deps.signal === undefined ? {} : { signal: deps.signal }),
    });
  } catch (err) {
    return { status: "failed", error: errorMessage(err), retryable: false };
  }
  patchAttempt(ctx, deps, { transcriptPath: paths.transcriptPath, ...(run.usage === undefined ? {} : { usage: run.usage }) });
  if (!run.ok) return { status: "failed", error: run.error ?? "brain run failed", retryable: run.error === INTERRUPTED_ERROR };
  const validated = validateResult(run.output);
  if (!validated.ok) return { status: "failed", error: validated.error, retryable: false };
  if (!ctx.dryRun) deps.stores.jobs.saveResult(ctx.jobId, validated.result, worktree.sha);
  return publish(ctx, deps, validated.result, worktree.sha, paths.artifactsDir);
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