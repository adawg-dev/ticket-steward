import { renderMedia, type MediaUploads } from "../codehost/media.js";
import type { LabelsConfig } from "../config/schema.js";
import { closedReason } from "../core/intake.js";
import type { JobOutcome, RunContext } from "../core/types.js";
import { errorMessage } from "../core/workspace.js";
import type { Tracker } from "../tracker/types.js";
import type { ImplementResult, StoredImplement } from "./result.js";

const list = (items: string[]): string[] => items.filter((item) => item.trim() !== "").map((item) => `- ${item.trim()}`);

/**
 * The implement summary the Greptile loop posts on the MR once it finds it: what changed, review notes, checks run, and
 * the screenshots and recordings the job attached.
 */
export const buildImplementSummary = (input: { jobId: number; identifier: string; result: ImplementResult; media?: MediaUploads }): string => {
  const { result } = input;
  const media = renderMedia(input.media);
  return [
    `Ticket Steward implemented ${input.identifier} (job ${input.jobId}).`,
    "",
    result.summary.trim(),
    ...(result.reviewNotes.length > 0 ? ["", "**For the reviewer**", ...list(result.reviewNotes)] : []),
    ...(result.checksRun.length > 0 ? ["", "**Checks the agent ran**", ...list(result.checksRun)] : []),
    ...(media.length > 0 ? ["", ...media] : []),
  ].join("\n");
};

/**
 * Labels only: Linear gets no comments. A push moves the label to `implemented`, a hand-back to its own label; the
 * hand-back's reason stays in the job record. A failed swap is publish_failed so a retry re-runs only this. Never
 * writes to a Done/Canceled ticket.
 */
export const publishImplement = async (input: {
  ctx: RunContext;
  tracker: Tracker;
  labels: LabelsConfig | undefined;
  stored: StoredImplement;
}): Promise<JobOutcome> => {
  const { ctx, tracker, labels, stored } = input;
  try {
    const latest = await tracker.fetchTicket(ctx.issueId);
    const closed = closedReason(ctx.identifier, latest.state);
    if (closed !== null) return { status: "failed", error: closed, retryable: false };
  } catch (err) {
    return { status: "publish_failed", error: `labels: ${errorMessage(err)}` };
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
