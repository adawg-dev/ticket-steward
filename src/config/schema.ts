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

const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Placeholders a `slots.env` value may use; each is rendered per job from the slot's ports. */
export const SLOT_TEMPLATES = ["app", "postgres", "redis", "rabbitmq"] as const;
export type SlotTemplate = (typeof SLOT_TEMPLATES)[number];
/** `{{name}}`, optionally with spaces inside the braces. Global: use with matchAll or replace only. */
export const SLOT_TEMPLATE_PATTERN = /\{\{\s*([^{}]*?)\s*\}\}/g;
export const isSlotTemplate = (name: string): name is SlotTemplate => SLOT_TEMPLATES.some((template) => template === name);

const SlotsSchema = z
  .object({
    count: z.number().int().min(1).max(9),
    /** The slot helper's socket (ops/steward-slot.socket); systemd runs the root helper per connection. */
    socket: z.string().min(1).default("/run/steward-slot.sock"),
    /** Slot n's app port is appPortBase + n. */
    appPortBase: z.number().int().positive().max(65_526),
    /** Kills a hung `up`; capped below the helper unit's RuntimeMaxSec=300, which would kill it anyway. */
    upTimeoutSeconds: z.number().positive().max(290).default(180),
    /** Applied to every copied overlay file that defines the key; null deletes the line. */
    env: z.record(z.string().regex(ENV_KEY), z.string().nullable()).default({}),
  })
  .superRefine((slots, ctx) => {
    for (const [key, value] of Object.entries(slots.env)) {
      if (value === null) continue;
      for (const [, name = ""] of value.matchAll(SLOT_TEMPLATE_PATTERN)) {
        if (!isSlotTemplate(name)) {
          ctx.addIssue({ code: "custom", path: ["env", key], message: `unknown template {{${name}}}; use {{app}}, {{postgres}}, {{redis}} or {{rabbitmq}}` });
        }
      }
    }
  });

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
    /** Label-driven workflows; unset keeps the old behaviour of enriching every new ticket. */
    labels: LabelsSchema.optional(),
    /** Removed; rejected rather than stripped, since a config still carrying it would otherwise enrich every new ticket. */
    triggerLabel: z.never({ error: "tracker.triggerLabel was replaced by tracker.labels (see docs/ops.md)" }).optional(),
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
    /** The app port without `slots`; with `slots` each slot has its own (slots.appPortBase + n). */
    port: z.number().int().positive().optional(),
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
  /** Parallel jobs on fresh per-job containers; unset keeps one job at a time on workspace.port. */
  slots: SlotsSchema.optional(),
}).superRefine((config, ctx) => {
  if (config.review !== undefined && config.codehost.kind !== "gitlab") {
    ctx.addIssue({ code: "custom", path: ["review"], message: 'review requires codehost.kind "gitlab"' });
  }
  if (config.implement !== undefined && config.tracker.labels === undefined) {
    ctx.addIssue({ code: "custom", path: ["implement"], message: "implement requires tracker.labels" });
  }
  if (config.slots !== undefined && config.workspace.port !== undefined) {
    ctx.addIssue({ code: "custom", path: ["workspace", "port"], message: "workspace.port was replaced by slots.appPortBase (see docs/ops.md)" });
  }
  if (config.slots === undefined && config.workspace.port === undefined) {
    ctx.addIssue({ code: "custom", path: ["workspace", "port"], message: "workspace.port is required unless slots is set" });
  }
});

export type StewardConfig = z.infer<typeof StewardConfigSchema>;
export type StewardConfigInput = z.input<typeof StewardConfigSchema>;
export const defineConfig = (config: StewardConfigInput): StewardConfigInput => config;
export type BrainConfig = StewardConfig["brain"];
export type CodeHostConfig = StewardConfig["codehost"];
export type LabelsConfig = NonNullable<StewardConfig["tracker"]["labels"]>;
export type ImplementConfig = NonNullable<StewardConfig["implement"]>;
export type SlotsConfig = NonNullable<StewardConfig["slots"]>;

/** Slot n's app port with `slots`, otherwise `workspace.port`; config load guarantees one of them. */
export const appPortOf = (config: Pick<StewardConfig, "slots" | "workspace">, n: number): number => {
  if (config.slots !== undefined) return config.slots.appPortBase + n;
  if (config.workspace.port === undefined) throw new Error("workspace.port is required unless slots is set");
  return config.workspace.port;
};
