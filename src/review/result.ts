import { z } from "zod";

export const ReviewCommentSchema = z.object({
  path: z.string(),
  line: z.number().int(),
  side: z.enum(["new", "old"]),
  severity: z.enum(["blocker", "major", "minor"]),
  body: z.string(),
});
export type ReviewComment = z.infer<typeof ReviewCommentSchema>;

export const ReviewResultSchema = z.object({
  verdict: z.enum(["fixed", "not_fixed", "could_not_run", "not_applicable"]),
  rerun: z.object({ observed: z.string(), deviations: z.string().nullable() }).nullable(),
  summary: z.string(),
  comments: z.array(ReviewCommentSchema),
  confidence: z.enum(["low", "medium", "high"]),
});
export type ReviewResult = z.infer<typeof ReviewResultSchema>;

// `line` is a plain int with the >= 1 check in code: `.positive()` emits `exclusiveMinimum`, which OpenAI strict output rejects.
export const reviewResultJsonSchema: Record<string, unknown> = z.toJSONSchema(ReviewResultSchema, { target: "draft-07" });

export const validateReviewResult = (output: unknown): { ok: true; result: ReviewResult } | { ok: false; error: string } => {
  const parsed = ReviewResultSchema.safeParse(output);
  if (!parsed.success) return { ok: false, error: z.prettifyError(parsed.error) };
  if (parsed.data.summary.trim() === "") return { ok: false, error: "summary is empty" };
  for (const [index, comment] of parsed.data.comments.entries()) {
    if (comment.line < 1) return { ok: false, error: `comment ${index} has an invalid line` };
    if (comment.path.trim() === "" || comment.body.trim() === "") return { ok: false, error: `comment ${index} is empty` };
  }
  return { ok: true, result: parsed.data };
};

/** Spec §3: without a recipe there is nothing to verify; with one, "not applicable" means the replay did not happen. */
export const normalizeReviewResult = (result: ReviewResult, hasRecipe: boolean): ReviewResult => {
  if (!hasRecipe) return { ...result, verdict: "not_applicable", rerun: null };
  return result.verdict === "not_applicable" ? { ...result, verdict: "could_not_run" } : result;
};

export const StoredReviewSchema = z.object({
  result: ReviewResultSchema,
  diffRefs: z.object({ baseSha: z.string(), startSha: z.string(), headSha: z.string() }),
});
export type StoredReview = z.infer<typeof StoredReviewSchema>;
