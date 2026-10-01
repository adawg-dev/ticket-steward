import { z } from "zod";

export const ReproSchema = z.object({
  status: z.enum(["reproduced", "not_reproduced"]),
  method: z.enum(["test", "script", "http", "browser"]),
  command: z.string().nullable(),
  steps: z.array(z.string()),
  files: z.array(z.string()),
  expected: z.string(),
  observed: z.string(),
});

export type Repro = z.infer<typeof ReproSchema>;

export const TriageSchema = z.object({
  state: z.enum(["needs-info", "ready-for-human"]),
  questions: z.array(z.string()),
  agentBrief: z.string().nullable(),
});
export type Triage = z.infer<typeof TriageSchema>;

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
  repro: ReproSchema.nullable(),
  triage: TriageSchema,
});

export type BrainResult = z.infer<typeof BrainResultSchema>;

export const brainResultJsonSchema: Record<string, unknown> = z.toJSONSchema(BrainResultSchema, {
  target: "draft-07",
});

const reproError = (repro: Repro | null): string | null => {
  if (repro === null) return null;
  if (repro.method !== "browser" && (repro.command === null || repro.command.trim() === "")) return "repro.command is required unless repro.method is browser";
  if (repro.method === "browser" && repro.steps.length === 0) return "repro.steps is empty";
  return null;
};

export const validateResult = (output: unknown): { ok: true; result: BrainResult } | { ok: false; error: string } => {
  const parsed = BrainResultSchema.safeParse(output);
  if (!parsed.success) return { ok: false, error: z.prettifyError(parsed.error) };
  if (parsed.data.summary.trim() === "") return { ok: false, error: "summary is empty" };
  if (parsed.data.enrichment.trim() === "") return { ok: false, error: "enrichment is empty" };
  const repro = reproError(parsed.data.repro);
  if (repro !== null) return { ok: false, error: repro };
  const { triage } = parsed.data;
  if (triage.state === "needs-info" && triage.questions.every((q) => q.trim() === "")) return { ok: false, error: "triage needs-info without questions" };
  if (triage.state === "ready-for-human" && (triage.agentBrief === null || triage.agentBrief.trim() === "")) return { ok: false, error: "triage ready-for-human without an agentBrief" };
  return { ok: true, result: parsed.data };
};
