import { StewardConfigSchema, appPortOf, defineConfig } from "../../src/config/schema.js";
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
  prompt: "./prompts/enrich.md",
  server: { port: 3020, publicUrl: "https://steward.example.com" },
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
    expect(parsed.tracker.gatewayIssues).toBe("enrich");
    expect(parsed.tracker.bugLabels).toEqual(["Bug"]);
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

  it("rejects an unknown tracker.gatewayIssues value", () => {
    const result = StewardConfigSchema.safeParse({ ...minimalInput, tracker: { kind: "linear", gatewayIssues: "sometimes" } });
    expect(result.success).toBe(false);
  });

  it("rejects an unknown brain kind", () => {
    const result = StewardConfigSchema.safeParse({
      ...minimalInput,
      brain: { kind: "gemini", model: "x", maxTurns: 1, timeoutMinutes: 1 },
    });
    expect(result.success).toBe(false);
  });

  it("accepts a github codehost and an openai-agents brain", () => {
    const parsed = StewardConfigSchema.parse({
      ...minimalInput,
      brain: { kind: "openai-agents", model: "gpt-5.5", maxTurns: 80, timeoutMinutes: 30 },
      codehost: { kind: "github", owner: "concentrateai", repo: "kickoff" },
    });
    expect(parsed.brain).toEqual({ kind: "openai-agents", model: "gpt-5.5", maxTurns: 80, timeoutMinutes: 30 });
    expect(parsed.codehost).toEqual({ kind: "github", owner: "concentrateai", repo: "kickoff" });
  });

  it("defineConfig round-trips its input", () => {
    expect(defineConfig(minimalInput)).toBe(minimalInput);
  });
});

describe("tracker config", () => {
  it("defaults bugLabels to Bug", () => {
    expect(StewardConfigSchema.parse(minimalInput).tracker.bugLabels).toEqual(["Bug"]);
  });
});

describe("brain.reasoningEffort", () => {
  const openai = { kind: "openai-agents", model: "gpt-6-luna", maxTurns: 80, timeoutMinutes: 30 } as const;

  it("accepts a reasoning effort for openai-agents and leaves it unset by default", () => {
    const set = StewardConfigSchema.parse({ ...minimalInput, brain: { ...openai, reasoningEffort: "high" } });
    const unset = StewardConfigSchema.parse({ ...minimalInput, brain: openai });

    expect(set.brain).toMatchObject({ reasoningEffort: "high" });
    expect(unset.brain).not.toHaveProperty("reasoningEffort");
  });

  it("rejects an unknown reasoning effort", () => {
    expect(StewardConfigSchema.safeParse({ ...minimalInput, brain: { ...openai, reasoningEffort: "extreme" } }).success).toBe(false);
  });
});

describe("tracker.labels and implement", () => {
  const labels = {};
  const implement = { prompt: "./prompts/implement.md", commitAuthor: { name: "Ticket Steward", email: "steward@example.com" } };

  it("fills every label name with its default", () => {
    const parsed = StewardConfigSchema.parse({ ...minimalInput, tracker: { ...minimalInput.tracker, labels } });
    expect(parsed.tracker.labels).toEqual({
      triage: "needs-triage",
      implement: "ready-for-agent",
      needsInfo: "needs-info",
      readyForHuman: "ready-for-human",
      implemented: "agent-implemented",
      approved: "agent-approved",
    });
  });

  it("leaves labels and implement unset by default", () => {
    const parsed = StewardConfigSchema.parse(minimalInput);
    expect(parsed.tracker.labels).toBeUndefined();
    expect(parsed.implement).toBeUndefined();
  });

  it("fills implement defaults", () => {
    const parsed = StewardConfigSchema.parse({ ...minimalInput, tracker: { ...minimalInput.tracker, labels }, implement });
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

  it("rejects implement without tracker.labels", () => {
    const result = StewardConfigSchema.safeParse({ ...minimalInput, implement });
    expect(result.success).toBe(false);
  });

  it("rejects a branch type that is not lowercase kebab", () => {
    const result = StewardConfigSchema.safeParse({ ...minimalInput, tracker: { ...minimalInput.tracker, labels }, implement: { ...implement, branchTypes: ["Fix"] } });
    expect(result.success).toBe(false);
  });
});

describe("greptile config", () => {
  const labels = {};
  const implement = { prompt: "./prompts/implement.md", commitAuthor: { name: "Ticket Steward", email: "steward@example.com" } };
  const greptile = { botUsername: "g", prompt: "./prompts/fix.md" };
  const valid = { ...minimalInput, tracker: { ...minimalInput.tracker, labels }, implement, brain: { kind: "claude-code", model: "m", maxTurns: 1, timeoutMinutes: 1 }, codehost: { kind: "gitlab", baseUrl: "https://gitlab.example.com", project: "g/p" }, greptile };
  const messages = (input: unknown): string[] => {
    const result = StewardConfigSchema.safeParse(input);
    return result.success ? [] : result.error.issues.map((issue) => issue.message);
  };

  it("parses with every default", () => {
    const parsed = StewardConfigSchema.parse(valid);
    expect(parsed.greptile).toEqual({
      botUsername: "g",
      maxRounds: 5,
      prompt: "./prompts/fix.md",
      pollSeconds: 60,
      mrTimeoutMinutes: 60,
      reviewTimeoutMinutes: 30,
      pipelineTimeoutMinutes: 60,
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

  it("rejects a slot count outside 1-9", () => {
    expect(StewardConfigSchema.safeParse(withSlots({ ...slotsInput, count: 0 })).success).toBe(false);
    expect(StewardConfigSchema.safeParse(withSlots({ ...slotsInput, count: 10 })).success).toBe(false);
  });

  it("keeps portRewrite next to slots", () => {
    expect(StewardConfigSchema.parse(withSlots(slotsInput, { portRewrite: { from: 3000 } })).workspace.portRewrite).toEqual({ from: 3000 });
  });

  it("appPortOf is appPortBase + n with slots and workspace.port without", () => {
    expect(appPortOf(StewardConfigSchema.parse(withSlots(slotsInput)), 2)).toBe(4102);
    expect(appPortOf(StewardConfigSchema.parse(minimalInput), 2)).toBe(4100);
  });
});
