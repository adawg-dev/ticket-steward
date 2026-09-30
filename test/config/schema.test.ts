import { StewardConfigSchema, defineConfig } from "../../src/config/schema.js";
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

describe("review config", () => {
  it("defaults allowForks and maxComments", () => {
    const parsed = StewardConfigSchema.parse({ ...minimalInput, review: { botUsername: "steward-bot", prompt: "./prompts/review.md" } });
    expect(parsed.review).toEqual({ botUsername: "steward-bot", prompt: "./prompts/review.md", allowForks: false, maxComments: 15 });
  });

  it("is optional", () => {
    expect(StewardConfigSchema.parse(minimalInput).review).toBeUndefined();
  });

  it("requires a gitlab codehost", () => {
    const result = StewardConfigSchema.safeParse({ ...minimalInput, codehost: { kind: "github", owner: "o", repo: "r" }, review: { botUsername: "b", prompt: "p" } });
    expect(result.success).toBe(false);
  });

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
