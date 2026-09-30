import { z } from "zod";

const BrainBaseSchema = z.object({
  model: z.string(),
  maxTurns: z.number().int().positive(),
  timeoutMinutes: z.number().positive(),
});

const LabelsSchema = z.object({
  triage: z.string().min(1).default("needs-triage"),
  implement: z.string().min(1).default("ready-for-agent"),
  needsInfo: z.string().min(1).default("needs-info"),
  readyForHuman: z.string().min(1).default("ready-for-human"),
  implemented: z.string().min(1).default("agent-implemented"),
});

const BRANCH_TYPE = /^[a-z][a-z0-9-]*$/;

const ImplementSchema = z.object({
  prompt: z.string(),
  branchTypes: z.array(z.string().regex(BRANCH_TYPE)).min(1).default(["feature", "fix", "chore", "refactor"]),
  /** Run by the steward in the worktree after the brain; `{{baseSha}}` is replaced with the job's base commit. */
  checks: z.array(z.string()).default([]),
  checksTimeoutMinutes: z.number().positive().default(20),
  commitAuthor: z.object({ name: z.string().min(1), email: z.string().min(1) }),
  timeoutMinutes: z.number().positive().default(60),
  maxTurns: z.number().int().positive().default(150),
  /** Branches doctor expects GitLab to protect from the push token. */
  protectedBranches: z.array(z.string().min(1)).default(["main", "staging", "dev"]),
});

export const StewardConfigSchema = z.object({
  dataDir: z.string(),
  brain: z.discriminatedUnion("kind", [
    BrainBaseSchema.extend({ kind: z.literal("claude-code") }),
    BrainBaseSchema.extend({
      kind: z.literal("openai-agents"),
      /** Unset leaves the Agents SDK's per-model default, which is "none" for gpt-5.5 and unset for newer models. */
      reasoningEffort: z.enum(["none", "minimal", "low", "medium", "high", "xhigh", "max"]).optional(),
    }),
  ]),
  tracker: z.object({
    kind: z.literal("linear"),
    teams: z.array(z.string()).default([]),
    /** "skip" only when ticket-gateway enriches its own tickets through the steward (sidecar mode); otherwise both would enrich them. */
    gatewayIssues: z.enum(["enrich", "skip"]).default("enrich"),
    bugLabels: z.array(z.string()).default(["Bug"]),
    /** When set, only a ticket carrying this label (on create, or when it is first added) is enriched; unset enriches every new ticket. */
    triggerLabel: z.string().min(1).optional(),
    /** Label-driven workflows; unset keeps the old behaviour of enriching every new ticket. */
    labels: LabelsSchema.optional(),
  }),
  codehost: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("gitlab"), baseUrl: z.string(), project: z.string() }),
    z.object({ kind: z.literal("github"), owner: z.string(), repo: z.string() }),
  ]),
  workspace: z.object({
    fetchUrl: z.string(),
    baseBranch: z.string(),
    overlayDir: z.string(),
    skillsDir: z.string().optional(),
    setup: z.array(z.string()),
    setupTimeoutMinutes: z.number().positive().default(15),
    portRewrite: z.object({ from: z.number().int().positive() }).optional(),
    port: z.number().int().positive(),
    keepOnFailure: z.boolean().default(true),
  }),
  retention: z
    .object({
      keptWorktrees: z.number().int().nonnegative().default(3),
      days: z.number().int().positive().default(30),
    })
    .prefault({}),
  prompt: z.string(),
  server: z.object({
    port: z.number().int().positive(),
    publicUrl: z.string(),
  }),
  review: z
    .object({
      botUsername: z.string().min(1),
      prompt: z.string(),
      allowForks: z.boolean().default(false),
      maxComments: z.number().int().positive().default(15),
    })
    .optional(),
  implement: ImplementSchema.optional(),
}).superRefine((config, ctx) => {
  if (config.review !== undefined && config.codehost.kind !== "gitlab") {
    ctx.addIssue({ code: "custom", path: ["review"], message: 'review requires codehost.kind "gitlab"' });
  }
  if (config.implement !== undefined && config.tracker.labels === undefined) {
    ctx.addIssue({ code: "custom", path: ["implement"], message: "implement requires tracker.labels" });
  }
});

export type StewardConfig = z.infer<typeof StewardConfigSchema>;
export type StewardConfigInput = z.input<typeof StewardConfigSchema>;
export const defineConfig = (config: StewardConfigInput): StewardConfigInput => config;
export type BrainConfig = StewardConfig["brain"];
export type CodeHostConfig = StewardConfig["codehost"];
export type LabelsConfig = NonNullable<StewardConfig["tracker"]["labels"]>;
export type ImplementConfig = NonNullable<StewardConfig["implement"]>;
