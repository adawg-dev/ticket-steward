import { renderMedia, type MediaUploads } from "../codehost/media.js";
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
 * Settles the job against the ticket: a Done/Canceled ticket fails it. Outcome labels were removed with the label
 * trigger; the hand-back's reason stays in the job record. A failed read is publish_failed so a retry re-runs only this.
 */
export const publishImplement = async (input: { ctx: RunContext; tracker: Tracker; stored: StoredImplement }): Promise<JobOutcome> => {
  const { ctx, tracker, stored } = input;
  try {
    const latest = await tracker.fetchTicket(ctx.issueId);
    const closed = closedReason(ctx.identifier, latest.state);
    if (closed !== null) return { status: "failed", error: closed, retryable: false };
  } catch (err) {
    return { status: "publish_failed", error: `ticket: ${errorMessage(err)}` };
  }
  return stored.handback === null ? { status: "succeeded" } : { status: "succeeded", warning: `handed back: ${stored.handback.reason}` };
};
