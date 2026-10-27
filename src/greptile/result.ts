import { z } from "zod";
import type { Finding } from "./summary.js";

export const FixResultSchema = z.object({
  outcome: z.enum(["changed", "no_changes", "failed"]),
  /** One entry per Greptile finding: fixed it, or declined it with a reason. */
  threads: z.array(z.object({ discussionId: z.string(), action: z.enum(["fixed", "declined"]), reply: z.string() })),
  commitMessage: z.string(),
  summary: z.string(),
  checksRun: z.array(z.string()),
  failureDetail: z.string().nullable(),
});
export type FixResult = z.infer<typeof FixResultSchema>;

export const fixResultJsonSchema: Record<string, unknown> = z.toJSONSchema(FixResultSchema, { target: "draft-07" });

const GREPTILE_MENTION = /@greptile(ai)?\b/i;

/** Parse the brain's fix output and check it against the findings it was asked about. */
export const validateFixResult = (output: unknown, findings: Finding[]): { ok: true; result: FixResult } | { ok: false; error: string } => {
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

  if (result.outcome === "changed" && result.commitMessage.trim() === "") return { ok: false, error: "commitMessage is empty" };
  if (result.outcome === "no_changes" && result.threads.some((t) => t.action !== "declined")) {
    return { ok: false, error: "no_changes requires every thread to be declined" };
  }
  if (result.outcome === "failed" && (result.failureDetail === null || result.failureDetail.trim() === "")) {
    return { ok: false, error: "failed without failureDetail" };
  }
  return { ok: true, result };
};
