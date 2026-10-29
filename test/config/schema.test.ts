import { BrainSchema, RESOURCE_GUARD_DEFAULTS, StewardConfigSchema, appPortOf, defineConfig } from "../../src/config/schema.js";
import type { StewardConfigInput } from "../../src/config/schema.js";

const minimalInput: StewardConfigInput = {
  dataDir: "/var/lib/ticket-steward",
  brain: { kind: "claude-code", model: "claude-opus-5", maxTurns: 80, timeoutMinutes: 30 },
  tracker: { kind: "linear" },
  codehost: { kind: "gitlab", baseUrl: "https://gitlab.com", project: "concentrateai/kickoff" },
  workspace: {
    fetchUrl: "https://gitlab.com/concentrateai/kickoff.git",
    baseBranch: "dev",
    overlayDir: "/var/lib/ticket-steward/overlay",
    setup: [],
    port: 4100,
  },
  server: { port: 3020, publicUrl: "https://steward.example.com" },
  implement: { prompt: "./prompts/implement.md", commitAuthor: { name: "Ticket Steward", email: "steward@example.com" } },
};

const messages = (input: unknown): string[] => {
  const parsed = StewardConfigSchema.safeParse(input);
  return parsed.success ? [] : parsed.error.issues.map((issue) => issue.message);
};

describe("StewardConfigSchema", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("applies defaults to a minimal config", () => {
    const parsed = StewardConfigSchema.parse(minimalInput);
    expect(parsed.workspace.setupTimeoutMinutes).toBe(15);
    expect(parsed.workspace.keepOnFailure).toBe(true);
    expect(parsed.workspace.portRewrite).toBeUndefined();
    expect(parsed.retention).toEqual({ keptWorktrees: 3, days: 30 });
    expect(parsed.tracker.teams).toEqual([]);
  });

  it("rejects the removed enrich keys", () => {
    const { tracker } = minimalInput;
    const removed: Array<[string, unknown]> = [
      ["prompt", { ...minimalInput, prompt: "./prompts/enrich.md" }],
      ["tracker.gatewayIssues", { ...minimalInput, tracker: { ...tracker, gatewayIssues: "enrich" } }],
      ["tracker.bugLabels", { ...minimalInput, tracker: { ...tracker, bugLabels: ["Bug"] } }],
    ];
    for (const [key, input] of removed) {
      expect(messages(input)).toEqual([`${key} was removed with enrich (see docs/ops.md)`]);
    }
  });

  it("requires implement", () => {
    expect(messages({ ...minimalInput, implement: undefined })).toEqual(["implement is required"]);
  });

  it("rejects the removed tracker.triggerLabel with a pointer to tracker.labels", () => {
    const parsed = StewardConfigSchema.safeParse({ ...minimalInput, tracker: { kind: "linear", triggerLabel: "steward" } });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues).toEqual([
      expect.objectContaining({ path: ["tracker", "triggerLabel"], message: "tracker.triggerLabel was replaced by tracker.labels (see docs/ops.md)" }),
    ]);
  });

  it("rejects a config missing a required field", () => {
    expect(StewardConfigSchema.safeParse({ ...minimalInput, dataDir: undefined }).success).toBe(false);
  });

  it("rejects an unknown brain kind", () => {
    const result = StewardConfigSchema.safeParse({
      ...minimalInput,
      brain: { kind: "gemini", model: "x", maxTurns: 1, timeoutMinutes: 1 },
    });
    expect(result.success).toBe(false);
  });

  it("accepts a github codehost", () => {
    const parsed = StewardConfigSchema.parse({ ...minimalInput, codehost: { kind: "github", owner: "concentrateai", repo: "kickoff" } });
    expect(parsed.codehost).toEqual({ kind: "github", owner: "concentrateai", repo: "kickoff" });
  });

  it("refuses the openai-agents brain: the Linear app needs claude-code", () => {
    expect(messages({ ...minimalInput, brain: { kind: "openai-agents", model: "gpt-5.5", maxTurns: 80, timeoutMinutes: 30 } })).toEqual([
      'the Linear app requires brain.kind "claude-code"',
    ]);
  });

  it("rejects the removed tracker.labels with a pointer to assigning the steward", () => {
    const parsed = StewardConfigSchema.safeParse({ ...minimalInput, tracker: { kind: "linear", labels: {} } });
    expect(parsed.error?.issues).toEqual([
      expect.objectContaining({ path: ["tracker", "labels"], message: "tracker.labels: assign the steward in Linear instead (docs/ops.md)" }),
    ]);
  });

  it("defineConfig round-trips its input", () => {
    expect(defineConfig(minimalInput)).toBe(minimalInput);
  });
});


describe("brain.reasoningEffort", () => {
  const openai = { kind: "openai-agents", model: "gpt-6-luna", maxTurns: 80, timeoutMinutes: 30 } as const;

  it("accepts a reasoning effort for openai-agents and leaves it unset by default", () => {
    expect(BrainSchema.parse({ ...openai, reasoningEffort: "high" })).toMatchObject({ reasoningEffort: "high" });
    expect(BrainSchema.parse(openai)).not.toHaveProperty("reasoningEffort");
  });

  it("rejects an unknown reasoning effort", () => {
    expect(BrainSchema.safeParse({ ...openai, reasoningEffort: "extreme" }).success).toBe(false);
  });
});

describe("implement", () => {
  const implement = { prompt: "./prompts/implement.md", commitAuthor: { name: "Ticket Steward", email: "steward@example.com" } };

  it("fills implement defaults", () => {
    const parsed = StewardConfigSchema.parse({ ...minimalInput, implement });
    expect(parsed.implement).toEqual({
      ...implement,
      branchTypes: ["feature", "fix", "chore", "refactor"],
      checks: [],
      checksTimeoutMinutes: 20,
      timeoutMinutes: 60,
      maxTurns: 150,
      protectedBranches: ["main", "staging", "dev"],
    });
  });

  it("needs no tracker labels", () => {
    expect(StewardConfigSchema.safeParse({ ...minimalInput, tracker: { kind: "linear" }, implement }).success).toBe(true);
  });

  it("rejects a branch type that is not lowercase kebab", () => {
    const result = StewardConfigSchema.safeParse({ ...minimalInput, implement: { ...implement, branchTypes: ["Fix"] } });
    expect(result.success).toBe(false);
  });
});

describe("greptile config", () => {
  const implement = { prompt: "./prompts/implement.md", commitAuthor: { name: "Ticket Steward", email: "steward@example.com" } };
  const greptile = { botUsername: "g", prompt: "./prompts/fix.md" };
  const valid = { ...minimalInput, implement, brain: { kind: "claude-code", model: "m", maxTurns: 1, timeoutMinutes: 1 }, codehost: { kind: "gitlab", baseUrl: "https://gitlab.example.com", project: "g/p" }, greptile };
  it("parses with every default", () => {
    const parsed = StewardConfigSchema.parse(valid);
    expect(parsed.greptile).toEqual({
      botUsername: "g",
      maxRounds: 5,
      prompt: "./prompts/fix.md",
      pollSeconds: 300,
      mrTimeoutMinutes: 30,
      reviewTimeoutMinutes: 30,
      pipelineTimeoutMinutes: 30,
      ciLogLines: 200,
    });
  });

  it("defaults the mcp url", () => {
    const parsed = StewardConfigSchema.parse({ ...valid, greptile: { ...greptile, mcp: {} } });
    expect(parsed.greptile?.mcp).toEqual({ url: "https://api.greptile.com/mcp" });
  });

  it("requires implement", () => {
    expect(messages({ ...valid, implement: undefined })).toContain("greptile requires implement");
  });

  it("requires a gitlab code host", () => {
    expect(messages({ ...valid, codehost: { kind: "github", owner: "o", repo: "r" } })).toContain('greptile requires codehost.kind "gitlab"');
  });

  it("requires the claude-code brain", () => {
    expect(messages({ ...valid, brain: { kind: "openai-agents", model: "m", maxTurns: 1, timeoutMinutes: 1 } })).toContain('greptile requires brain.kind "claude-code"');
  });
});

describe("chat config", () => {
  it("is absent by default", () => {
    expect(StewardConfigSchema.parse(minimalInput).chat).toBeUndefined();
  });

  it("defaults the prefix and session retention", () => {
    expect(StewardConfigSchema.parse({ ...minimalInput, chat: {} }).chat).toEqual({ prefix: "/agent", sessionRetentionDays: 180 });
  });

  it("rejects a non-positive retention", () => {
    expect(messages({ ...minimalInput, chat: { sessionRetentionDays: 0 } })).toHaveLength(1);
  });

  it("requires the claude-code brain", () => {
    expect(messages({ ...minimalInput, brain: { kind: "openai-agents", model: "m", maxTurns: 1, timeoutMinutes: 1 }, chat: {} })).toContain(
      'chat requires brain.kind "claude-code"',
    );
  });
});

describe("slots config", () => {
  const slotsInput = { count: 2, appPortBase: 4100 };
  const withSlots = (slots: Record<string, unknown>, workspace: Record<string, unknown> = {}): unknown => ({
    ...minimalInput,
    workspace: { ...minimalInput.workspace, port: undefined, ...workspace },
    slots,
  });

  it("parses slots with defaults", () => {
    const parsed = StewardConfigSchema.parse(withSlots(slotsInput));
    expect(parsed.slots).toEqual({ count: 2, socket: "/run/steward-slot.sock", appPortBase: 4100, upTimeoutSeconds: 180, env: {} });
    expect(parsed.workspace.port).toBeUndefined();
  });

  it("accepts every template, spaces inside the braces, and null values", () => {
    const env = {
      DB_PORT: "{{postgres}}",
      REDIS_URL: "redis://localhost:{{ redis }}",
      RABBITMQ_URL: "amqp://steward:steward-slot@localhost:{{rabbitmq}}",
      BASE_URL: "http://localhost:{{app}}",
      REDIS_CLUSTER_NODES: null,
    };
    expect(StewardConfigSchema.parse(withSlots({ ...slotsInput, env })).slots?.env).toEqual(env);
  });

  it("rejects an unknown template, naming the key", () => {
    const parsed = StewardConfigSchema.safeParse(withSlots({ ...slotsInput, env: { DB_PORT: "{{pg}}" } }));
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues).toEqual([
      expect.objectContaining({ path: ["slots", "env", "DB_PORT"], message: "unknown template {{pg}}; use {{app}}, {{postgres}}, {{redis}} or {{rabbitmq}}" }),
    ]);
  });

  it("rejects workspace.port next to slots with a pointer to slots.appPortBase", () => {
    const parsed = StewardConfigSchema.safeParse(withSlots(slotsInput, { port: 4100 }));
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues).toEqual([
      expect.objectContaining({ path: ["workspace", "port"], message: "workspace.port was replaced by slots.appPortBase (see docs/ops.md)" }),
    ]);
  });

  it("still requires workspace.port without slots", () => {
    const parsed = StewardConfigSchema.safeParse({ ...minimalInput, workspace: { ...minimalInput.workspace, port: undefined } });
    expect(parsed.error?.issues).toEqual([expect.objectContaining({ path: ["workspace", "port"], message: "workspace.port is required unless slots is set" })]);
  });

  it("caps upTimeoutSeconds at 290, under the helper unit's RuntimeMaxSec", () => {
    expect(StewardConfigSchema.parse(withSlots({ ...slotsInput, upTimeoutSeconds: 290 })).slots?.upTimeoutSeconds).toBe(290);
    expect(StewardConfigSchema.safeParse(withSlots({ ...slotsInput, upTimeoutSeconds: 291 })).success).toBe(false);
  });

  it("accepts slot counts 1-20 and rejects any outside", () => {
    expect(StewardConfigSchema.parse(withSlots({ ...slotsInput, count: 20 })).slots?.count).toBe(20);
    expect(StewardConfigSchema.safeParse(withSlots({ ...slotsInput, count: 0 })).success).toBe(false);
    expect(StewardConfigSchema.safeParse(withSlots({ ...slotsInput, count: 21 })).success).toBe(false);
  });

  it("keeps portRewrite next to slots", () => {
    expect(StewardConfigSchema.parse(withSlots(slotsInput, { portRewrite: { from: 3000 } })).workspace.portRewrite).toEqual({ from: 3000 });
  });

  it("appPortOf is appPortBase + n with slots and workspace.port without", () => {
    expect(appPortOf(StewardConfigSchema.parse(withSlots(slotsInput)), 2)).toBe(4102);
    expect(appPortOf(StewardConfigSchema.parse(minimalInput), 2)).toBe(4100);
  });
});

describe("resourceGuard config", () => {
  it("is unset in a minimal config; the worker then uses the defaults", () => {
    expect(StewardConfigSchema.parse(minimalInput).resourceGuard).toBeUndefined();
    expect(RESOURCE_GUARD_DEFAULTS).toEqual({ enabled: true, minAvailableMemoryMb: 4096, maxLoadPerCpu: 1.5, startSpacingSeconds: 30 });
  });

  it("fills the defaults around the fields given", () => {
    const parsed = StewardConfigSchema.parse({ ...minimalInput, resourceGuard: { minAvailableMemoryMb: 8192 } });
    expect(parsed.resourceGuard).toEqual({ ...RESOURCE_GUARD_DEFAULTS, minAvailableMemoryMb: 8192 });
  });

  it("rejects a non-positive load ceiling and negative spacing", () => {
    expect(StewardConfigSchema.safeParse({ ...minimalInput, resourceGuard: { maxLoadPerCpu: 0 } }).success).toBe(false);
    expect(StewardConfigSchema.safeParse({ ...minimalInput, resourceGuard: { startSpacingSeconds: -1 } }).success).toBe(false);
  });
});

describe("secrets config", () => {
  it("is absent by default, which reads .env", () => {
    expect(StewardConfigSchema.parse(minimalInput).secrets).toBeUndefined();
    expect(StewardConfigSchema.parse({ ...minimalInput, secrets: { source: "file" } }).secrets).toEqual({ source: "file" });
  });

  it("accepts an AWS region and a map of env names to secret ids", () => {
    const secrets = { source: "aws", region: "us-west-2", map: { GITLAB_TOKEN: "DEV_STEWARD_GITLAB_TOKEN" } };
    expect(StewardConfigSchema.parse({ ...minimalInput, secrets }).secrets).toEqual(secrets);
  });

  it("rejects a missing region, a bad env name and an empty secret id", () => {
    expect(StewardConfigSchema.safeParse({ ...minimalInput, secrets: { source: "aws", map: {} } }).success).toBe(false);
    expect(StewardConfigSchema.safeParse({ ...minimalInput, secrets: { source: "aws", region: "us-west-2", map: { "NOT-AN-ENV": "DEV_A" } } }).success).toBe(false);
    expect(StewardConfigSchema.safeParse({ ...minimalInput, secrets: { source: "aws", region: "us-west-2", map: { GITLAB_TOKEN: "" } } }).success).toBe(false);
  });

  it("rejects an unknown source", () => {
    expect(StewardConfigSchema.safeParse({ ...minimalInput, secrets: { source: "vault" } }).success).toBe(false);
  });
});
