import { z } from "zod";
import { MediaUploadsSchema } from "../codehost/media.js";
import { PushTargetSchema } from "../push/target.js";

/**
 * What crosses the seam between the steward, which prepares and finishes a run (it holds the tracker, the code host and
 * the DB), and whatever executes it: in-process on the local runtime, or a run pod on Kubernetes, where these travel as
 * JSON. A spec carries no secret.
 */

const Sha = z.string().regex(/^[0-9a-f]{40}$/);

export const RUN_KINDS = ["implement", "fix", "chat"] as const;

export const RunSpecSchema = z.object({
  version: z.literal(1),
  runId: z.string().min(1),
  /** 0 for a dry run, which has no job row. */
  jobId: z.number().int().nonnegative(),
  kind: z.enum(RUN_KINDS),
  identifier: z.string().min(1),
  issueId: z.string().min(1),
  /** What the worktree starts at: `sha`, on the ticket branch `ref` when it is pushed, else on the base (`ref` null). */
  checkout: z.object({ ref: z.string().min(1).nullable(), sha: Sha }),
  baseSha: Sha,
  worktreePath: z.string().min(1),
  artifactsDir: z.string().min(1),
  /** Where the run's redacted brain messages go. */
  transcriptPath: z.string().min(1),
  /** May carry `PERSON_COMMITS_MARKER`, replaced by the executor from the worktree's history. */
  prompt: z.string(),
  personCommits: z.object({ from: Sha, to: Sha }).nullable(),
  output: z.enum(RUN_KINDS),
  resumeSessionId: z.string().min(1).nullable(),
  limits: z.object({
    timeoutMinutes: z.number().positive(),
    maxTurns: z.number().int().positive(),
    setupTimeoutMinutes: z.number().positive(),
  }),
  /** The run's push tool target; null gives the run no push tool (a dry run, or nothing pushed yet for a chat). */
  push: PushTargetSchema.nullable(),
  /** `workspace.setup`, run in the worktree before the brain. */
  setup: z.array(z.string()),
  /** The push tool's checks, `{{baseSha}}` filled in. */
  checks: z.array(z.string()),
  /** A person attaches to the session (`steward chat`) instead of the brain running to a structured result. */
  interactive: z.boolean(),
});

export type RunSpec = z.infer<typeof RunSpecSchema>;

const UsageSchema = z.object({
  inputTokens: z.number().nonnegative(),
  outputTokens: z.number().nonnegative(),
  costUsd: z.number().nonnegative().exactOptional(),
});

/** How the run went, from whoever ran the brain. */
export const RunReportSchema = z.object({
  runId: z.string().min(1),
  ok: z.boolean(),
  error: z.string().nullable(),
  /** Stopped by the executor's signal (shutdown) or by the pod going away: the job is retried. */
  interrupted: z.boolean(),
  /** `workspace.setup` failed; the brain did not run and `error` carries the redacted tail. */
  setupFailed: z.boolean(),
  sessionId: z.string().min(1).nullable(),
  output: z.unknown(),
  usage: UsageSchema.nullable(),
  /**
   * The result's media as the run pod's tools sidecar attached them; absent when the run attached none (the local
   * runtime, whose finish attaches them from the artifacts dir itself).
   */
  media: MediaUploadsSchema.exactOptional(),
});

export type RunReport = z.infer<typeof RunReportSchema>;

/** What the run left that the agent did not push, from whoever holds the worktree and saw the pushes. */
export const WorkReportSchema = z.object({
  runId: z.string().min(1),
  /** A `git status`-like summary of uncommitted paths and commits after `pushedSha`; empty when everything was pushed. */
  unpushed: z.string(),
  /** The last commit the push tool pushed in this run, null when it pushed nothing. */
  pushedSha: Sha.nullable(),
});

export type WorkReport = z.infer<typeof WorkReportSchema>;
