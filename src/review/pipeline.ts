import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buildBrainEnv, INTERRUPTED_ERROR, runBrainDetached } from "../brain/index.js";
import type { BrainRun } from "../brain/types.js";
import type { DiffRefs, MergeRequestInfo } from "../codehost/gitlabReview.js";
import { renderTicketMarkdown } from "../core/context.js";
import type { PipelineDeps } from "../core/deps.js";
import { isBugTicket, renderReproMarkdown, restoreReproFiles } from "../core/repro.js";
import type { JobOutcome, RunContext } from "../core/types.js";
import { brainInput, cleanupWorkspace, crashed, errorMessage, jobPaths, patchAttempt, prepareWorkspace, redactOutcome } from "../core/workspace.js";
import type { ReproRecord } from "../store/index.js";
import type { ReviewTrigger } from "../tracker/types.js";
import { gitOrThrow } from "../workspace/git.js";
import type { Worktree } from "../workspace/worktree.js";
import { renderReviewPrompt } from "./prompt.js";
import { postUnverifiable, publishReview } from "./publish.js";
import { normalizeReviewResult, validateReviewResult, type StoredReview } from "./result.js";

const DIFF_FILE = "mr.diff";

const skipped = (reason: string): JobOutcome => ({ status: "succeeded", warning: `skipped: ${reason}` });
const notConfigured: JobOutcome = { status: "failed", error: "merge-request review is not configured", retryable: false };

const reviewTrigger = (ctx: RunContext): ReviewTrigger | null => (ctx.trigger.kind === "mr.review" ? ctx.trigger : null);

type Gate = { ok: true; diffRefs: DiffRefs } | { ok: false; outcome: JobOutcome };

/** Spec §2.13: act only on the MR as it is now. */
const gate = (mr: MergeRequestInfo, trigger: ReviewTrigger, botUsername: string): Gate => {
  if (mr.state !== "opened") return { ok: false, outcome: skipped(`!${trigger.mrIid} is ${mr.state}`) };
  if (!mr.reviewers.includes(botUsername)) return { ok: false, outcome: skipped(`the steward is no longer a reviewer of !${trigger.mrIid}`) };
  if (mr.sha !== trigger.headSha) return { ok: false, outcome: skipped(`!${trigger.mrIid} moved on to ${mr.sha.slice(0, 7)}`) };
  if (mr.diffRefs === null || mr.diffRefs.headSha !== mr.sha) return { ok: false, outcome: { status: "failed", error: `!${trigger.mrIid} diff is not ready yet`, retryable: true } };
  return { ok: true, diffRefs: mr.diffRefs };
};

const executeReview = async (ctx: RunContext, deps: PipelineDeps, onWorktree: (worktree: Worktree) => void): Promise<JobOutcome> => {
  const trigger = reviewTrigger(ctx);
  const api = deps.review;
  const settings = deps.config.review;
  if (trigger === null || api === undefined || settings === undefined) return notConfigured;

  let mr: MergeRequestInfo;
  try {
    mr = await api.getMergeRequest(trigger.projectId, trigger.mrIid);
  } catch (err) {
    return { status: "failed", error: errorMessage(err), retryable: true };
  }
  const gated = gate(mr, trigger, settings.botUsername);
  if (!gated.ok) return gated.outcome;
  const { diffRefs } = gated;

  let issue: { id: string; identifier: string };
  let ticket: string;
  let isBug: boolean;
  try {
    issue = await deps.tracker.resolveIssueId(trigger.linearKey);
    const bundle = await deps.tracker.fetchTicket(issue.id);
    ticket = renderTicketMarkdown(bundle);
    isBug = isBugTicket(bundle.labels, deps.config.tracker.bugLabels);
  } catch (err) {
    return { status: "failed", error: errorMessage(err), retryable: true };
  }

  const repro: ReproRecord | null = isBug ? deps.stores.repros.get(issue.id) : null;
  if (isBug && (repro === null || repro.recipe.status !== "reproduced")) {
    try {
      const reason = repro === null ? "No reproduction was recorded." : "The recorded attempt did not reproduce the bug.";
      await postUnverifiable(api, { jobId: ctx.jobId, trigger, identifier: issue.identifier, botUsername: settings.botUsername, reason }, deps.redactor);
    } catch (err) {
      return { status: "publish_failed", error: errorMessage(err) };
    }
    return skipped(`${issue.identifier} has no reproduced recipe`);
  }

  const paths = jobPaths(ctx, deps);
  const env = buildBrainEnv(deps.secrets, deps.config.brain, deps.config.workspace.port);
  let worktree: Worktree;
  let diff: string;
  let prompt: string;
  try {
    await deps.mirror.fetch();
    await deps.mirror.fetchRef(`refs/merge-requests/${trigger.mrIid}/head`);
    const sha = await deps.mirror.resolveSha(trigger.headSha);
    worktree = await prepareWorkspace(ctx, deps, paths, env, sha, onWorktree);
    diff = await gitOrThrow(["diff", "--no-color", "--no-ext-diff", "--unified=3", "-M", diffRefs.baseSha, diffRefs.headSha], deps.mirror.path);
    const diffPath = join(paths.artifactsDir, DIFF_FILE);
    await writeFile(diffPath, `${diff}\n`, { mode: 0o600 });
    if (repro !== null) await restoreReproFiles(repro.filesDir, repro.recipe.files, worktree.path);
    prompt = renderReviewPrompt(await readFile(settings.prompt, "utf8"), {
      identifier: issue.identifier,
      mrIid: trigger.mrIid,
      mrTitle: mr.title,
      mrUrl: mr.webUrl,
      mrDescription: mr.description,
      sourceBranch: mr.sourceBranch,
      targetBranch: mr.targetBranch,
      baseSha: diffRefs.baseSha,
      headSha: diffRefs.headSha,
      diffPath,
      workspacePath: worktree.path,
      artifactsDir: paths.artifactsDir,
      stewardPort: deps.config.workspace.port,
      ticket,
      hasRecipe: repro !== null,
      recipe: repro === null ? "" : renderReproMarkdown(repro.recipe),
      recipeSha: repro === null ? "" : repro.sha,
      maxComments: settings.maxComments,
    });
  } catch (err) {
    return { status: "failed", error: deps.signal?.aborted === true ? INTERRUPTED_ERROR : errorMessage(err), retryable: true };
  }

  let run: BrainRun;
  try {
    run = await (deps.runBrain ?? runBrainDetached)(deps.config.brain, brainInput(deps, paths, worktree, prompt, env, "review"), deps.redactor, {
      ...(deps.signal === undefined ? {} : { signal: deps.signal }),
    });
  } catch (err) {
    return { status: "failed", error: errorMessage(err), retryable: false };
  }
  patchAttempt(ctx, deps, { transcriptPath: paths.transcriptPath, ...(run.usage === undefined ? {} : { usage: run.usage }) });
  if (!run.ok) return { status: "failed", error: run.error ?? "brain run failed", retryable: run.error === INTERRUPTED_ERROR };
  const validated = validateReviewResult(run.output);
  if (!validated.ok) return { status: "failed", error: validated.error, retryable: false };
  const stored: StoredReview = { result: normalizeReviewResult(validated.result, repro !== null), diffRefs };
  deps.stores.jobs.saveReviewResult(ctx.jobId, stored);
  return publishReview(
    { jobId: ctx.jobId, trigger, issueId: issue.id, identifier: issue.identifier, stored, diff, botUsername: settings.botUsername, maxComments: settings.maxComments },
    { api, tracker: deps.tracker, redactor: deps.redactor, permalink: (path, sha, line) => deps.codehost.permalink(path, sha, line) },
  );
};

export const runReview = async (ctx: RunContext, deps: PipelineDeps): Promise<JobOutcome> => {
  const workspace: { worktree: Worktree | null } = { worktree: null };
  const outcome = redactOutcome(
    await executeReview(ctx, deps, (created) => {
      workspace.worktree = created;
    }).catch(crashed),
    deps.redactor,
  );
  await cleanupWorkspace(deps, workspace.worktree, outcome);
  return outcome;
};

export const publishReviewOnly = async (ctx: RunContext, deps: PipelineDeps): Promise<JobOutcome> => {
  const trigger = reviewTrigger(ctx);
  const job = deps.stores.jobs.get(ctx.jobId);
  const api = deps.review;
  const settings = deps.config.review;
  if (trigger === null || api === undefined || settings === undefined) return notConfigured;
  const stored = job?.reviewResult ?? null;
  if (stored === null) return { status: "failed", error: "no stored review to publish", retryable: false };
  const diff = await readFile(join(jobPaths(ctx, deps).artifactsDir, DIFF_FILE), "utf8").catch(() => "");
  let issue: { id: string; identifier: string };
  try {
    issue = await deps.tracker.resolveIssueId(trigger.linearKey);
  } catch (err) {
    return { status: "publish_failed", error: errorMessage(err) };
  }
  return publishReview(
    { jobId: ctx.jobId, trigger, issueId: issue.id, identifier: issue.identifier, stored, diff, botUsername: settings.botUsername, maxComments: settings.maxComments },
    { api, tracker: deps.tracker, redactor: deps.redactor, permalink: (path, sha, line) => deps.codehost.permalink(path, sha, line) },
  );
};
