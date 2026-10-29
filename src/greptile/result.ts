import { z } from "zod";
import { MediaListSchema, MediaUploadsSchema } from "../codehost/media.js";
import type { WorkItem } from "./evaluate.js";

export const FixResultSchema = z.object({
  outcome: z.enum(["changed", "no_changes", "failed"]),
  /** One entry per discussion on the work list: `fixed` (code changed for it) or `declined` (a reply alone), with the reply. */
  threads: z.array(z.object({ discussionId: z.string(), action: z.enum(["fixed", "declined"]), reply: z.string() })),
  summary: z.string(),
  checksRun: z.array(z.string()),
  failureDetail: z.string().nullable(),
  /** Screenshots and recordings of the round's change, for the merge request. */
  media: MediaListSchema,
});
export type FixResult = z.infer<typeof FixResultSchema>;

export const fixResultJsonSchema: Record<string, unknown> = z.toJSONSchema(FixResultSchema, { target: "draft-07" });

const GREPTILE_MENTION = /@greptile(ai)?\b/i;

/** Parse the brain's fix output and check it against the discussions it was asked to answer. */
export const validateFixResult = (output: unknown, findings: ReadonlyArray<Pick<WorkItem, "discussionId">>): { ok: true; result: FixResult } | { ok: false; error: string } => {
  const parsed = FixResultSchema.safeParse(output);
  if (!parsed.success) return { ok: false, error: z.prettifyError(parsed.error) };
  const result = parsed.data;
  if (result.summary.trim() === "") return { ok: false, error: "summary is empty" };

  const expected = new Set(findings.map((f) => f.discussionId));
  const seen = new Set<string>();
  for (const thread of result.threads) {
    if (seen.has(thread.discussionId)) return { ok: false, error: `duplicate thread ${thread.discussionId}` };
    seen.add(thread.discussionId);
    if (!expected.has(thread.discussionId)) return { ok: false, error: `unknown thread ${thread.discussionId}` };
    if (thread.reply.trim() === "") return { ok: false, error: `empty reply for thread ${thread.discussionId}` };
    if (GREPTILE_MENTION.test(thread.reply)) return { ok: false, error: `reply for thread ${thread.discussionId} mentions @greptile` };
  }
  const missing = [...expected].filter((id) => !seen.has(id));
  if (missing.length > 0) return { ok: false, error: `missing threads: ${missing.join(", ")}` };

  if (result.outcome === "no_changes" && result.threads.some((t) => t.action !== "declined")) {
    return { ok: false, error: "no_changes requires every thread to be declined" };
  }
  if (result.outcome === "failed" && (result.failureDetail === null || result.failureDetail.trim() === "")) {
    return { ok: false, error: "failed without failureDetail" };
  }
  return { ok: true, result };
};

/** What a fix job decided once its brain ran: stored before anything is published, so a retry never runs the brain again. */
export const StoredFixSchema = z.object({
  /** null when the job handed back before a valid result (the brain failed, or its result was invalid). */
  result: FixResultSchema.nullable(),
  handback: z.object({ reason: z.string(), detail: z.string() }).nullable(),
  /** The round the fix answered: Greptile's score and review counter (null when it is off), and the head pipeline's status. */
  score: z.number().int().nullable(),
  reviewCount: z.number().int().nullable(),
  pipeline: z.string().nullable(),
  /** The result's media as attached to the project, posted in the round's note; absent when the result listed none. */
  media: MediaUploadsSchema.optional(),
});
export type StoredFix = z.infer<typeof StoredFixSchema>;
