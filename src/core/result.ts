import { z } from "zod";

export const BrainResultSchema = z.object({
  template: z.object({
    matched: z.string().nullable(),
    conforms: z.boolean(),
    missing: z.array(z.string()),
  }),
  summary: z.string(),
  enrichment: z.string(),
  attachments: z.array(z.object({ file: z.string(), caption: z.string() })),
  confidence: z.enum(["low", "medium", "high"]),
});

export type BrainResult = z.infer<typeof BrainResultSchema>;

export const brainResultJsonSchema: Record<string, unknown> = z.toJSONSchema(BrainResultSchema, {
  target: "draft-07",
});

export const validateResult = (output: unknown): { ok: true; result: BrainResult } | { ok: false; error: string } => {
  const parsed = BrainResultSchema.safeParse(output);
  if (!parsed.success) return { ok: false, error: z.prettifyError(parsed.error) };
  if (parsed.data.summary.trim() === "") return { ok: false, error: "summary is empty" };
  if (parsed.data.enrichment.trim() === "") return { ok: false, error: "enrichment is empty" };
  return { ok: true, result: parsed.data };
};
