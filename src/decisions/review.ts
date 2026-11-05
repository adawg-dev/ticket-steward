import type { PipelineDeps } from "../core/deps.js";
import type { WorkItem } from "../greptile/evaluate.js";
import type { GreptileSummary } from "../greptile/summary.js";
import { logger } from "../log.js";
import { mapLimit, type Question } from "./client.js";
import { askAndRecord } from "./intake.js";

/** Asked about each work item of a fix round (spec: decisions-shadow-mode, "Fix round"). */
export const REVIEW_QUESTIONS: Question[] = [
  {
    type: "choice",
    name: "action",
    instructions: "What the merge request's author should do about this review comment.",
    choices: [
      { value: "fix", description: "A real defect or a reasonable requested change: change the code." },
      { value: "decline", description: "Wrong, already handled, or against the ticket: reply with the reason, change nothing." },
      { value: "nit", description: "Style or preference with no effect on behaviour: optional." },
      { value: "escalate", description: "Needs a person: a product decision, a disagreement between reviewers, or a risky area." },
    ],
  },
];

/** Work items asked about per round; the rest are not asked. */
export const MAX_ITEMS = 20;
/** Requests in flight at once. */
const CONCURRENCY = 8;

const where = (item: WorkItem): string | null => {
  const path = item.position?.newPath ?? item.position?.oldPath ?? null;
  if (path === null) return null;
  const line = item.position?.newLine ?? item.position?.oldLine ?? null;
  return line === null ? path : `${path}:${line}`;
};

/** What one item is judged on: who wrote it, where, what it says, and for a bot's comment Greptile's summary. */
export const itemInput = (item: WorkItem, summary: GreptileSummary | null): string => {
  const at = where(item);
  return [
    `Review comment by a ${item.isBot ? "bot" : "person"} (${item.author})${at === null ? " on the merge request" : ` on ${at}`}:`,
    "",
    item.body,
    ...(item.isBot && summary !== null ? ["", "The reviewer's summary of the merge request:", "", summary.body] : []),
  ].join("\n");
};

/** Asks about the round's first `MAX_ITEMS` work items, one request each; shadow only, never throws. */
export const askReview = async (
  deps: Pick<PipelineDeps, "decisions" | "stores" | "settings" | "redactor">,
  at: { jobId: number; issueId: string; loopId: number; round: number },
  work: WorkItem[],
  summary: GreptileSummary | null,
): Promise<void> => {
  if (deps.decisions === undefined) return;
  await mapLimit(work.slice(0, MAX_ITEMS), CONCURRENCY, (item) =>
    askAndRecord(deps, { ...at, point: "fix_item", subject: item.discussionId }, itemInput(item, summary), REVIEW_QUESTIONS),
  );
};

/** The agent's action on each thread as its item's outcome, the ground truth `action` is measured against; failures are logged. */
export const recordReviewOutcomes = (deps: Pick<PipelineDeps, "stores">, jobId: number, threads: ReadonlyArray<{ discussionId: string; action: string }>): void => {
  try {
    for (const thread of threads) deps.stores.decisions.setOutcome(jobId, "fix_item", thread.action, thread.discussionId);
  } catch (err) {
    logger.warn({ jobId, err: err instanceof Error ? err.message : String(err) }, "decisions: review outcomes not recorded");
  }
};
