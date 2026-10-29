import { z } from "zod";

const BrainBaseSchema = z.object({
  model: z.string(),
  maxTurns: z.number().int().positive(),
  timeoutMinutes: z.number().positive(),
});

/** A key that only served enrich (removed 2026-10-28): rejected rather than stripped, so a stale config fails loudly. */
const removedWithEnrich = (key: string) => z.never({ error: `${key} was removed with enrich (see docs/ops.md)` }).optional();

const LabelsSchema = z.object({
  triage: removedWithEnrich("tracker.labels.triage"),
  implement: z.string().min(1).default("ready-for-agent"),
  needsInfo: z.string().min(1).default("needs-info"),
  readyForHuman: z.string().min(1).default("ready-for-human"),
  implemented: z.string().min(1).default("agent-implemented"),
  /** Set when the fix loop ends with Greptile at 5/5 and a green pipeline. */
  approved: z.string().min(1).default("agent-approved"),
});

const BRANCH_TYPE = /^[a-z][a-z0-9-]*$/;

const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Placeholders a `slots.env` value may use; each is rendered per job from the slot's ports. */
export const SLOT_TEMPLATES = ["app", "postgres", "redis", "rabbitmq"] as const;
export type SlotTemplate = (typeof SLOT_TEMPLATES)[number];
/** `{{name}}`, optionally with spaces inside the braces. Global: use with matchAll or replace only. */
export const SLOT_TEMPLATE_PATTERN = /\{\{\s*([^{}]*?)\s*\}\}/g;
export const isSlotTemplate = (name: string): name is SlotTemplate => SLOT_TEMPLATES.some((template) => template === name);

/** The slot helper (ops/steward-slot) serves slots 1 to MAX_SLOTS. */
export const MAX_SLOTS = 20;

const SlotsSchema = z
  .object({
    count: z.number().int().min(1).max(MAX_SLOTS),
    /** The slot helper's socket: ops/steward-slot.socket, where systemd runs the root helper per connection, or the Compose stack's /run/slot/steward-slot.sock. */
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

const GreptileSchema = z.object({
  /** The username Greptile comments as on the MR. */
  botUsername: z.string().min(1),
  /** Fix rounds after the implement push (round 0). */
  maxRounds: z.number().int().positive().default(5),
  /** The fix prompt, resolved against the config directory. */
  prompt: z.string(),
  /** The fallback poll between GitLab webhooks, which wake a waiting loop at once. */
  pollSeconds: z.number().positive().default(300),
  /** Each wait (MR, review, pipeline) hands back after this long. */
  mrTimeoutMinutes: z.number().positive().default(30),
  reviewTimeoutMinutes: z.number().positive().default(30),
  pipelineTimeoutMinutes: z.number().positive().default(30),
  ciLogLines: z.number().int().positive().default(200),
  mcp: z.object({ url: z.string().min(1).default("https://api.greptile.com/mcp") }).optional(),
});

/** Holds heavy jobs (everything but await_review) while the host is short on memory or CPU, and spaces their starts. */
const ResourceGuardSchema = z.object({
  enabled: z.boolean().default(true),
  /** Available memory (MemAvailable) below this holds heavy starts. */
  minAvailableMemoryMb: z.number().nonnegative().default(4096),
  /** The 1-minute load average divided by the CPU count; above this holds heavy starts. */
  maxLoadPerCpu: z.number().positive().default(1.5),
  /** The load average lags about a minute, so heavy starts this close together would all pass the check at once. */
  startSpacingSeconds: z.number().nonnegative().default(30),
});

/** Retention keeps a session this long after its ticket's last activity, with or without a `chat` block. */
export const DEFAULT_SESSION_RETENTION_DAYS = 180;

/** Resuming an agent's session from an MR note that starts with `prefix`. */
const ChatSchema = z.object({
  prefix: z.string().min(1).default("/agent"),
  sessionRetentionDays: z.number().int().positive().default(DEFAULT_SESSION_RETENTION_DAYS),
});

/** Where the steward's own secrets come from: the config dir's `.env`, or AWS Secrets Manager by the default credential chain. */
const SecretsConfigSchema = z.discriminatedUnion("source", [
  z.object({ source: z.literal("file") }),
  z.object({
    source: z.literal("aws"),
    region: z.string().min(1),
    /** Env name to Secrets Manager id, e.g. `{ GITLAB_TOKEN: "DEV_STEWARD_GITLAB_TOKEN" }`; names that are not steward secrets are dropped. */
    map: z.record(z.string().regex(ENV_KEY), z.string().min(1)),
  }),
]);

/** The run pod's app port: every run has the pod to itself, so the port is fixed. */
export const RUN_POD_APP_PORT = 3000;

/** A Kubernetes quantity, e.g. `2`, `500m`, `8Gi`. */
const Quantity = z.string().regex(/^[0-9]+(\.[0-9]+)?(m|k|Ki|M|Mi|G|Gi|T|Ti)?$/);

/**
 * Where runs execute: in the steward's own process on this host (`local`), or each run as a Kubernetes Job whose agent
 * container holds no credential (`kubernetes`; the claude-code brain and `secrets.source` "aws" only, `slots` and `resourceGuard` do not apply).
 */
const RuntimeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("local") }),
  z.object({
    kind: z.literal("kubernetes"),
    namespace: z.string().min(1),
    images: z.object({
      steward: z.string().min(1),
      agent: z.string().min(1),
      egress: z.string().min(1),
      postgres: z.string().min(1),
      redis: z.string().min(1),
      rabbitmq: z.string().min(1),
    }),
    /** Run pods at once; the worker runs this many lanes. */
    maxConcurrent: z.number().int().positive(),
    /** The dispatcher's internal run API as run pods reach it, e.g. `http://steward-internal.ticket-steward.svc:3021`. */
    callbackUrl: z.url(),
    minio: z.object({ endpoint: z.url(), bucket: z.string().min(1).default("steward-sessions") }),
    aws: z.object({ roleArn: z.string().min(1), region: z.string().min(1) }),
    resources: z.object({ agent: z.object({ cpu: Quantity, memory: Quantity }) }),
    /** Private ranges run pods may still reach (the NetworkPolicy's exceptions). */
    egressAllowCidrs: z.array(z.string().min(1)).default([]),
    /** The run pods' service account; it has no token mounted and no role in the cluster. */
    serviceAccount: z.string().min(1).default("steward-run"),
    /** The ConfigMap holding the steward's config dir as a gzipped tar (key `config.tgz`), and the config file's path where pods unpack it. */
    config: z
      .object({ configMap: z.string().min(1).default("steward-config"), path: z.string().startsWith("/").default("/etc/ticket-steward/steward.config.ts") })
      .prefault({}),
    /** The dispatcher's in-memory runtime dir (an emptyDir `Memory`): `serve` writes the admin API's token there. */
    runtimeDir: z.string().startsWith("/").default("/run/steward"),
  }),
]);

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
    gatewayIssues: removedWithEnrich("tracker.gatewayIssues"),
    bugLabels: removedWithEnrich("tracker.bugLabels"),
    /** The labels the steward reads and sets; required by implement. */
    labels: LabelsSchema.optional(),
    /** Removed; rejected rather than stripped, so a config still carrying it fails loudly. */
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
    /** The Kubernetes runtime's overlay: env files whose `{{secret:…}}`, `{{local}}` entries `render-overlay` fills per run. */
    overlayTemplateDir: z.string().optional(),
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
  prompt: removedWithEnrich("prompt"),
  server: z.object({
    port: z.number().int().positive(),
    publicUrl: z.string(),
  }),
  /** Optional in the type so a missing block gets the "implement is required" message below, not zod's generic one. */
  implement: ImplementSchema.optional(),
  /** Parallel jobs on fresh per-job containers; unset keeps one job at a time on workspace.port. */
  slots: SlotsSchema.optional(),
  /** The Greptile fix loop after the implement push; GitLab and the claude-code brain only. */
  greptile: GreptileSchema.optional(),
  /** Unset applies RESOURCE_GUARD_DEFAULTS. */
  resourceGuard: ResourceGuardSchema.optional(),
  /** Talking to a ticket's agent session again; unset means no comment-driven chat (sessions are still kept for 180 days). */
  chat: ChatSchema.optional(),
  /** Unset reads `.env` from the config dir, as `{ source: "file" }` does. */
  secrets: SecretsConfigSchema.optional(),
  /** Unset is `{ kind: "local" }`. */
  runtime: RuntimeSchema.optional(),
}).superRefine((config, ctx) => {
  if (config.greptile !== undefined) {
    if (config.implement === undefined) ctx.addIssue({ code: "custom", path: ["greptile"], message: "greptile requires implement" });
    if (config.codehost.kind !== "gitlab") ctx.addIssue({ code: "custom", path: ["greptile"], message: 'greptile requires codehost.kind "gitlab"' });
    if (config.brain.kind !== "claude-code") ctx.addIssue({ code: "custom", path: ["greptile"], message: 'greptile requires brain.kind "claude-code"' });
  }
  if (config.chat !== undefined && config.brain.kind !== "claude-code") {
    ctx.addIssue({ code: "custom", path: ["chat"], message: 'chat requires brain.kind "claude-code"' });
  }
  if (config.implement === undefined) ctx.addIssue({ code: "custom", path: ["implement"], message: "implement is required" });
  if (config.implement !== undefined && config.tracker.labels === undefined) {
    ctx.addIssue({ code: "custom", path: ["implement"], message: "implement requires tracker.labels" });
  }
  if (config.slots !== undefined && config.workspace.port !== undefined) {
    ctx.addIssue({ code: "custom", path: ["workspace", "port"], message: "workspace.port was replaced by slots.appPortBase (see docs/ops.md)" });
  }
  if (config.runtime?.kind === "kubernetes") {
    if (config.brain.kind !== "claude-code") ctx.addIssue({ code: "custom", path: ["runtime"], message: 'the kubernetes runtime requires brain.kind "claude-code"' });
    if (config.workspace.overlayTemplateDir === undefined) {
      ctx.addIssue({ code: "custom", path: ["workspace", "overlayTemplateDir"], message: "the kubernetes runtime requires workspace.overlayTemplateDir" });
    }
    // Run pods mount the config dir, so a `.env` there would reach the agent container.
    if (config.secrets?.source !== "aws") {
      ctx.addIssue({ code: "custom", path: ["secrets"], message: 'the kubernetes runtime requires secrets.source "aws"; a .env in the config dir would be mounted into run pods' });
    }
  }
  if (config.slots === undefined && config.workspace.port === undefined && config.runtime?.kind !== "kubernetes") {
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
export type GreptileConfig = NonNullable<StewardConfig["greptile"]>;
export type ChatConfig = NonNullable<StewardConfig["chat"]>;
export type SecretsConfig = NonNullable<StewardConfig["secrets"]>;
export type ResourceGuardConfig = z.infer<typeof ResourceGuardSchema>;
export const RESOURCE_GUARD_DEFAULTS: ResourceGuardConfig = ResourceGuardSchema.parse({});
export type SlotsConfig = NonNullable<StewardConfig["slots"]>;
export type RuntimeConfig = NonNullable<StewardConfig["runtime"]>;
export type KubernetesRuntime = Extract<RuntimeConfig, { kind: "kubernetes" }>;

/** The configured runtime; unset is local. */
export const runtimeOf = (config: Pick<StewardConfig, "runtime">): RuntimeConfig => config.runtime ?? { kind: "local" };

/** The Kubernetes runtime block, or null on the local runtime. */
export const kubernetesRuntime = (config: Pick<StewardConfig, "runtime">): KubernetesRuntime | null => {
  const runtime = runtimeOf(config);
  return runtime.kind === "kubernetes" ? runtime : null;
};

/** The run pod's app port on Kubernetes, else slot n's with `slots`, otherwise `workspace.port`; config load guarantees one of them. */
export const appPortOf = (config: Pick<StewardConfig, "slots" | "workspace"> & Partial<Pick<StewardConfig, "runtime">>, n: number): number => {
  if (config.runtime?.kind === "kubernetes") return RUN_POD_APP_PORT;
  if (config.slots !== undefined) return config.slots.appPortBase + n;
  if (config.workspace.port === undefined) throw new Error("workspace.port is required unless slots is set");
  return config.workspace.port;
};
