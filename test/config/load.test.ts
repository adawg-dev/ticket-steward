import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, resolveFromConfigDir } from "../../src/config/load.js";

const configSource = (overrides = "") => `
import { defineConfig } from "ticket-steward";
export default defineConfig({
  dataDir: "./data",
  brain: { kind: "claude-code", model: "claude-opus-5", maxTurns: 80, timeoutMinutes: 30 },
  tracker: { kind: "linear", teams: ["API"] },
  codehost: { kind: "gitlab", baseUrl: "https://gitlab.com", project: "concentrateai/kickoff" },
  workspace: {
    fetchUrl: "https://gitlab.com/concentrateai/kickoff.git",
    baseBranch: "dev",
    overlayDir: "~/overlay",
    skillsDir: "./skills",
    setup: ["pnpm install --frozen-lockfile --ignore-scripts"],
    port: 4100,
  },
  prompt: "./prompts/enrich.md",
  server: { port: 3020, publicUrl: "https://steward.example.com" },
  ${overrides}
});
`;

let dir: string;

beforeEach(async () => {
  vi.restoreAllMocks();
  dir = await mkdtemp(join(tmpdir(), "steward-config-"));
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});

describe("loadConfig", () => {
  it("loads a valid config from cwd with defaults applied", async () => {
    await writeFile(join(dir, "steward.config.ts"), configSource());
    const loaded = await loadConfig({ cwd: dir });
    expect(loaded.configPath).toBe(join(dir, "steward.config.ts"));
    expect(loaded.configDir).toBe(dir);
    expect(loaded.config.brain).toEqual({ kind: "claude-code", model: "claude-opus-5", maxTurns: 80, timeoutMinutes: 30 });
    expect(loaded.config.tracker.teams).toEqual(["API"]);
    expect(loaded.config.workspace.setupTimeoutMinutes).toBe(15);
    expect(loaded.config.workspace.keepOnFailure).toBe(true);
    expect(loaded.config.retention).toEqual({ keptWorktrees: 3, days: 30 });
    expect(loaded.secrets).toEqual({});
  });

  it("loads from an explicit configPath in a nested directory", async () => {
    const nested = join(dir, "etc", "steward");
    await mkdir(nested, { recursive: true });
    const configPath = join(nested, "steward.config.ts");
    await writeFile(configPath, configSource());
    const loaded = await loadConfig({ configPath });
    expect(loaded.configPath).toBe(configPath);
    expect(loaded.configDir).toBe(nested);
    expect(loaded.config.dataDir).toBe(join(nested, "data"));
  });

  it("rejects a config missing a required field", async () => {
    await writeFile(
      join(dir, "steward.config.ts"),
      `export default { dataDir: "./data", brain: { kind: "claude-code", model: "m", maxTurns: 1, timeoutMinutes: 1 } };`,
    );
    await expect(loadConfig({ cwd: dir })).rejects.toThrow();
  });

  it("rejects when no config file exists", async () => {
    await expect(loadConfig({ cwd: dir })).rejects.toThrow();
  });

  it("resolves path fields against the config dir and expands ~", async () => {
    vi.stubEnv("HOME", "/home/steward");
    await writeFile(join(dir, "steward.config.ts"), configSource());
    const { config } = await loadConfig({ cwd: dir });
    expect(config.dataDir).toBe(join(dir, "data"));
    expect(config.workspace.skillsDir).toBe(join(dir, "skills"));
    expect(config.prompt).toBe(join(dir, "prompts", "enrich.md"));
    expect(config.workspace.overlayDir).toBe("/home/steward/overlay");
  });

  it("leaves an absent skillsDir undefined", async () => {
    await writeFile(join(dir, "steward.config.ts"), configSource().replace(`skillsDir: "./skills",`, ""));
    const { config } = await loadConfig({ cwd: dir });
    expect(config.workspace.skillsDir).toBeUndefined();
  });

  it("parses .env into secrets without touching process.env", async () => {
    await writeFile(join(dir, "steward.config.ts"), configSource());
    await writeFile(
      join(dir, ".env"),
      "LINEAR_CLIENT_ID=lin-client\nLINEAR_WEBHOOK_SECRET=whsec\nANTHROPIC_API_KEY=sk-ant-test\n",
    );
    const { secrets } = await loadConfig({ cwd: dir });
    expect(secrets).toEqual({
      LINEAR_CLIENT_ID: "lin-client",
      LINEAR_WEBHOOK_SECRET: "whsec",
      ANTHROPIC_API_KEY: "sk-ant-test",
    });
    expect(process.env.LINEAR_CLIENT_ID).toBeUndefined();
    expect(process.env.LINEAR_WEBHOOK_SECRET).toBeUndefined();
    expect(process.env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it("drops .env keys that are not known secrets", async () => {
    await writeFile(join(dir, "steward.config.ts"), configSource());
    await writeFile(join(dir, ".env"), "OPENAI_API_KEY=sk-openai\nSOMETHING_ELSE=nope\n");
    const { secrets } = await loadConfig({ cwd: dir });
    expect(secrets).toEqual({ OPENAI_API_KEY: "sk-openai" });
  });
});

describe("resolveFromConfigDir", () => {
  it("resolves a relative path against the config dir", () => {
    expect(resolveFromConfigDir("/etc/steward", "./prompts/enrich.md")).toBe("/etc/steward/prompts/enrich.md");
  });

  it("keeps an absolute path", () => {
    expect(resolveFromConfigDir("/etc/steward", "/var/lib/steward")).toBe("/var/lib/steward");
  });

  it("expands a leading ~ to HOME", () => {
    vi.stubEnv("HOME", "/home/steward");
    expect(resolveFromConfigDir("/etc/steward", "~/overlay")).toBe("/home/steward/overlay");
    expect(resolveFromConfigDir("/etc/steward", "~")).toBe("/home/steward");
  });
});
