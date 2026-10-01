import type { CodeHostConfig, LabelsConfig } from "../config/schema.js";
import { closedReason } from "../core/intake.js";
import type { Redactor } from "../core/redact.js";
import { alreadyCommented, truncate } from "../core/render.js";
import type { JobOutcome, RunContext } from "../core/types.js";
import { errorMessage } from "../core/workspace.js";
import type { Tracker } from "../tracker/types.js";
import type { StoredImplement } from "./result.js";

const DETAIL_MAX = 4_000;

export const branchUrl = (codehost: CodeHostConfig, branch: string): string =>
  codehost.kind === "gitlab"
    ? `${codehost.baseUrl.replace(/\/$/, "")}/${codehost.project}/-/tree/${encodeURI(branch)}`
    : `https://github.com/${codehost.owner}/${codehost.repo}/tree/${encodeURI(branch)}`;

const list = (items: string[]): string[] => items.filter((item) => item.trim() !== "").map((item) => `- ${item.trim()}`);

export const buildImplementComment = (input: { jobId: number; stored: StoredImplement; branch: string | null; branchUrl: string | null }): string => {
  const { stored, jobId } = input;
  const result = stored.result;
  if (stored.handback === null && result !== null && input.branch !== null) {
    return [
      `Implementation pushed (job ${jobId}): [\`${input.branch}\`](${input.branchUrl ?? ""}). The pipeline opens the merge request when it passes.`,
      "",
      result.summary.trim(),
      ...(result.reviewNotes.length > 0 ? ["", "**For the reviewer**", ...list(result.reviewNotes)] : []),
      ...(result.checksRun.length > 0 ? ["", "**Checks the agent ran**", ...list(result.checksRun)] : []),
    ].join("\n");
  }
  const handback = stored.handback;
  if (handback?.label === "needsInfo") {
    const questions = (result?.questions ?? []).filter((q) => q.trim() !== "").map((q, index) => `${index + 1}. ${q.trim()}`);
    return [`Not implemented (job ${jobId}): this ticket needs more information first.`, "", ...questions].join("\n");
  }
  return [
    `Not implemented (job ${jobId}): ${handback?.reason ?? "the agent could not finish"}. Nothing was pushed.`,
    ...(result?.failureDetail ? ["", result.failureDetail.trim()] : []),
    ...(handback !== null && handback.detail !== "" ? ["", "```", truncate(handback.detail, DETAIL_MAX), "```"] : []),
  ].join("\n");
};

/** Comment first, labels last; a failure in either is publish_failed so a retry re-runs only this. Never writes to a Done/Canceled ticket. */
export const publishImplement = async (input: {
  ctx: RunContext;
  tracker: Tracker;
  redactor: Redactor;
  labels: LabelsConfig | undefined;
  stored: StoredImplement;
  branch: string | null;
  branchUrl: string | null;
}): Promise<JobOutcome> => {
  const { ctx, tracker, labels, stored } = input;
  let comments: ReadonlyArray<{ body: string }>;
  try {
    const latest = await tracker.fetchTicket(ctx.issueId);
    const closed = closedReason(ctx.identifier, latest.state);
    if (closed !== null) return { status: "failed", error: closed, retryable: false };
    comments = latest.comments;
  } catch (err) {
    return { status: "publish_failed", error: `comment: ${errorMessage(err)}` };
  }
  try {
    const body = input.redactor.redact(buildImplementComment({ jobId: ctx.jobId, stored, branch: input.branch, branchUrl: input.branchUrl }));
    if (!alreadyCommented(comments, body)) await tracker.postComment(ctx.issueId, body);
  } catch (err) {
    return { status: "publish_failed", error: `comment: ${errorMessage(err)}` };
  }
  // Only label-triggered jobs move labels; `steward implement KEY` (a cli trigger) leaves them alone.
  if ((ctx.trigger.kind === "issue.created" || ctx.trigger.kind === "issue.labeled") && ctx.trigger.action === "implement" && labels !== undefined) {
    const target = stored.handback === null ? labels.implemented : labels[stored.handback.label];
    try {
      await tracker.swapLabel(ctx.issueId, labels.implement, target);
    } catch (err) {
      return { status: "publish_failed", error: `labels: ${errorMessage(err)}` };
    }
  }
  return stored.handback === null ? { status: "succeeded" } : { status: "succeeded", warning: `handed back: ${stored.handback.reason}` };
};
