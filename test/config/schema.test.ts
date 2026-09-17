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
