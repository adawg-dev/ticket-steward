import { renderMedia, type MediaUploads } from "../codehost/media.js";
import { closedReason } from "../core/intake.js";
import { LOOP_MARKER } from "../greptile/publish.js";
import type { JobOutcome, RunContext } from "../core/types.js";
import { errorMessage } from "../core/workspace.js";
import type { Tracker } from "../tracker/types.js";
import type { ImplementResult, StoredImplement } from "./result.js";

const list = (items: string[]): string[] => items.filter((item) => item.trim() !== "").map((item) => `- ${item.trim()}`);

/** What changed, review notes and checks run. */
const summaryBody = (result: ImplementResult): string[] => [
  result.summary.trim(),
  ...(result.reviewNotes.length > 0 ? ["", "**For the reviewer**", ...list(result.reviewNotes)] : []),
  ...(result.checksRun.length > 0 ? ["", "**Checks the agent ran**", ...list(result.checksRun)] : []),
];

/**
 * The implement summary the Greptile loop posts on the MR it finds (one it did not open): what changed, review notes,
 * checks run, and the screenshots and recordings the job attached.
 */
export const buildImplementSummary = (input: { jobId: number; identifier: string; result: ImplementResult; media?: MediaUploads }): string => {
  const media = renderMedia(input.media);
  return [
    `Ticket Steward implemented ${input.identifier} (job ${input.jobId}).`,
    "",
    ...summaryBody(input.result),
    ...(media.length > 0 ? ["", ...media] : []),
  ].join("\n");
};

/**
 * The description of the MR the steward opens: the agent's (or the implement summary when it wrote none), the screenshots
 * and recordings the job attached, `Closes <KEY>`, a footer and the implement-summary marker, so the summary is not also
 * posted as a note.
 */
export const buildMrDescription = (input: {
  loopId: number; identifier: string; ticketUrl: string; jobId: number; result: ImplementResult; media?: MediaUploads;
}): string => {
  const { result } = input;
  const media = renderMedia(input.media);
  const written = result.mrDescription?.trim() ?? "";
  return [
    written === "" ? summaryBody(result).join("\n") : written,
    ...(media.length > 0 ? [media.join("\n")] : []),
    `Closes ${input.identifier}`,
    `Opened by Ticket Steward for [${input.identifier}](${input.ticketUrl}), job ${input.jobId}.`,
    LOOP_MARKER(input.loopId, "implement-summary"),
  ].join("\n\n");
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
