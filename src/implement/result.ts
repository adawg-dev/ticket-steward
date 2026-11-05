import { z } from "zod";
import { MediaListSchema, MediaUploadsSchema } from "../codehost/media.js";
import { higher, LevelSchema, type Level } from "./level.js";

export const ImplementResultSchema = z.object({
  outcome: z.enum(["implemented", "failed", "needs_info"]),
  summary: z.string(),
  reviewNotes: z.array(z.string()),
  checksRun: z.array(z.string()),
  questions: z.array(z.string()),
  failureDetail: z.string().nullable(),
  /** Screenshots and recordings of the change, for the merge request. */
  media: MediaListSchema,
  /** The process level the run started and finished at; null on results stored before levels. The steward sets `started` (see `atRunLevel`). */
  level: z.object({ started: LevelSchema, finished: LevelSchema, reason: z.string().nullable() }).nullable().default(null),
  /** The design written for the ticket, shown in the agent session; null when none. */
  design: z.string().nullable().default(null),
  /** The merge request title the agent writes: a conventional commit with the ticket key. Absent on results stored before; the agent's schema requires it. */
  mrTitle: z.string().optional(),
  /** The merge request description (Markdown) the agent writes, without screenshots, `Closes` or a footer; the steward appends those. */
  mrDescription: z.string().optional(),
});
export type ImplementResult = z.infer<typeof ImplementResultSchema>;

export const implementResultJsonSchema: Record<string, unknown> = z.toJSONSchema(ImplementResultSchema.required({ mrTitle: true, mrDescription: true }), { target: "draft-07" });

/** The agent names the branch type and writes the commit messages when it commits and pushes; the result only reports. */
export const validateImplementResult = (output: unknown): { ok: true; result: ImplementResult } | { ok: false; error: string } => {
  const parsed = ImplementResultSchema.safeParse(output);
  if (!parsed.success) return { ok: false, error: z.prettifyError(parsed.error) };
  const result = parsed.data;
  if (result.summary.trim() === "") return { ok: false, error: "summary is empty" };
  if (result.outcome === "needs_info" && result.questions.every((q) => q.trim() === "")) return { ok: false, error: "needs_info without questions" };
  if (result.outcome === "failed" && (result.failureDetail === null || result.failureDetail.trim() === "")) return { ok: false, error: "failed without failureDetail" };
  return { ok: true, result };
};

/** The result with its level started where the steward started the run, and never finished lower; no level from the agent means it stayed there. */
export const atRunLevel = (result: ImplementResult, started: Level): ImplementResult => {
  const finished = higher(started, result.level?.finished ?? started);
  return { ...result, level: { started, finished, reason: finished === started ? null : (result.level?.reason ?? null) } };
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
  /** The base the job's branch was cut from, so a retry can start the fix loop; absent on results stored before the push tool. */
  baseSha: z.string().optional(),
  /** The result's media as attached to the project, embedded in the MR summary; absent when the result listed none. */
  media: MediaUploadsSchema.optional(),
});
export type StoredImplement = z.infer<typeof StoredImplementSchema>;
