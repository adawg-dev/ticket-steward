import { z } from "zod";

export const ImplementResultSchema = z.object({
  outcome: z.enum(["implemented", "failed", "needs_info"]),
  /** implemented only; validated against implement.branchTypes in code (config-driven, so not a schema enum). */
  branchType: z.string().nullable(),
  commitMessage: z.string(),
  summary: z.string(),
  reviewNotes: z.array(z.string()),
  checksRun: z.array(z.string()),
  questions: z.array(z.string()),
  failureDetail: z.string().nullable(),
});
export type ImplementResult = z.infer<typeof ImplementResultSchema>;

export const implementResultJsonSchema: Record<string, unknown> = z.toJSONSchema(ImplementResultSchema, { target: "draft-07" });

export const validateImplementResult = (output: unknown, branchTypes: string[]): { ok: true; result: ImplementResult } | { ok: false; error: string } => {
  const parsed = ImplementResultSchema.safeParse(output);
  if (!parsed.success) return { ok: false, error: z.prettifyError(parsed.error) };
  const result = parsed.data;
  if (result.summary.trim() === "") return { ok: false, error: "summary is empty" };
  if (result.outcome === "implemented") {
    if (result.branchType === null || !branchTypes.includes(result.branchType)) {
      return { ok: false, error: `branchType "${result.branchType ?? "null"}" is not one of ${branchTypes.join(", ")}` };
    }
    if (result.commitMessage.trim() === "") return { ok: false, error: "commitMessage is empty" };
  }
  if (result.outcome === "needs_info" && result.questions.every((q) => q.trim() === "")) return { ok: false, error: "needs_info without questions" };
  if (result.outcome === "failed" && (result.failureDetail === null || result.failureDetail.trim() === "")) return { ok: false, error: "failed without failureDetail" };
  return { ok: true, result };
};

export const HandbackSchema = z.object({
  label: z.enum(["readyForHuman", "needsInfo"]),
  /** One line, shown in the job warning. */
  reason: z.string(),
  /** Longer text kept in the job record (output tails, paths); already redacted. */
  detail: z.string(),
});
export type Handback = z.infer<typeof HandbackSchema>;

export const StoredImplementSchema = z.object({
  /** null when the job handed back before the brain ran (e.g. the branch already exists). */
  result: ImplementResultSchema.nullable(),
  handback: HandbackSchema.nullable(),
});
export type StoredImplement = z.infer<typeof StoredImplementSchema>;
