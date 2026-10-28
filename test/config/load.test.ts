import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, resolveFromConfigDir, SecretsSchema } from "../../src/config/load.js";

const configSource = (overrides = "") => `
import { defineConfig } from "ticket-steward";
export default defineConfig({
  dataDir: "./data",
  brain: { kind: "claude-code", model: "claude-opus-5", maxTurns: 80, timeoutMinutes: 30 },
  tracker: { kind: "linear", teams: ["API"], labels: {} },
  codehost: { kind: "gitlab", baseUrl: "https://gitlab.com", project: "concentrateai/kickoff" },
  workspace: {
    fetchUrl: "https://gitlab.com/concentrateai/kickoff.git",
    baseBranch: "dev",
    overlayDir: "~/overlay",
    skillsDir: "./skills",
    setup: ["pnpm install --frozen-lockfile --ignore-scripts"],
    port: 4100,
  },
  server: { port: 3020, publicUrl: "https://steward.example.com" },
  implement: { prompt: "./prompts/implement.md", commitAuthor: { name: "Ticket Steward", email: "steward@example.com" } },
  ${overrides}
});
`;

/** implement is required, and implement requires the push token. */
const PUSH = "GITLAB_PUSH_TOKEN=glpat-push-token-value\n";
const pushSecret = { GITLAB_PUSH_TOKEN: "glpat-push-token-value" };

/** Writes the config and a .env holding the push token plus `env`. */
const writeSource = async (target: string, source = configSource(), env = ""): Promise<void> => {
  await writeFile(target, source);
  await writeFile(join(target, "..", ".env"), `${PUSH}${env}`);
};

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
    await writeSource(join(dir, "steward.config.ts"));
    const loaded = await loadConfig({ cwd: dir });
    expect(loaded.configPath).toBe(join(dir, "steward.config.ts"));
    expect(loaded.configDir).toBe(dir);
    expect(loaded.config.brain).toEqual({ kind: "claude-code", model: "claude-opus-5", maxTurns: 80, timeoutMinutes: 30 });
    expect(loaded.config.tracker.teams).toEqual(["API"]);
    expect(loaded.config.workspace.setupTimeoutMinutes).toBe(15);
    expect(loaded.config.workspace.keepOnFailure).toBe(true);
    expect(loaded.config.retention).toEqual({ keptWorktrees: 3, days: 30 });
    expect(loaded.secrets).toEqual(pushSecret);
  });

  it("loads from an explicit configPath in a nested directory", async () => {
    const nested = join(dir, "etc", "steward");
    await mkdir(nested, { recursive: true });
    const configPath = join(nested, "steward.config.ts");
    await writeSource(configPath);
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
    await writeSource(join(dir, "steward.config.ts"));
    const { config } = await loadConfig({ cwd: dir });
    expect(config.dataDir).toBe(join(dir, "data"));
    expect(config.workspace.skillsDir).toBe(join(dir, "skills"));
    expect(config.implement?.prompt).toBe(join(dir, "prompts", "implement.md"));
    expect(config.workspace.overlayDir).toBe("/home/steward/overlay");
  });

  it("leaves an absent skillsDir undefined", async () => {
    await writeSource(join(dir, "steward.config.ts"), configSource().replace(`skillsDir: "./skills",`, ""));
    const { config } = await loadConfig({ cwd: dir });
    expect(config.workspace.skillsDir).toBeUndefined();
  });

  it("parses .env into secrets without touching process.env", async () => {
    await writeSource(join(dir, "steward.config.ts"), configSource(), "LINEAR_API_KEY=lin_api_test\nLINEAR_WEBHOOK_SECRET=whsec\nANTHROPIC_API_KEY=sk-ant-test\n");
    const { secrets } = await loadConfig({ cwd: dir });
    expect(secrets).toEqual({
      ...pushSecret,
      LINEAR_API_KEY: "lin_api_test",
      LINEAR_WEBHOOK_SECRET: "whsec",
      ANTHROPIC_API_KEY: "sk-ant-test",
    });
    expect(process.env.LINEAR_API_KEY).toBeUndefined();
    expect(process.env.LINEAR_WEBHOOK_SECRET).toBeUndefined();
    expect(process.env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it("drops .env keys that are not known secrets", async () => {
    await writeSource(join(dir, "steward.config.ts"), configSource(), "OPENAI_API_KEY=sk-openai\nSOMETHING_ELSE=nope\n");
    const { secrets } = await loadConfig({ cwd: dir });
    expect(secrets).toEqual({ ...pushSecret, OPENAI_API_KEY: "sk-openai" });
  });

  it("drops the removed Linear OAuth client credentials", async () => {
    await writeSource(join(dir, "steward.config.ts"), configSource(), "LINEAR_CLIENT_ID=lin-client\nLINEAR_CLIENT_SECRET=lin-secret\nLINEAR_API_KEY=lin_api_test\n");
    const { secrets } = await loadConfig({ cwd: dir });
    expect(secrets).toEqual({ ...pushSecret, LINEAR_API_KEY: "lin_api_test" });
  });
});

describe("loadConfig after the MR reviewer was removed", () => {
  it("drops a leftover review block", async () => {
    await writeSource(join(dir, "steward.config.ts"), configSource(`review: { botUsername: "steward-bot", prompt: "./prompts/review.md" },`));
    const { config } = await loadConfig({ cwd: dir });
    expect("review" in config).toBe(false);
  });

  it("reads the GitLab webhook secrets the fix loop's wake-ups are verified with", async () => {
    await writeSource(join(dir, "steward.config.ts"), configSource(), "GITLAB_WEBHOOK_SECRET=gl-secret\nGITLAB_WEBHOOK_SIGNING_TOKEN=gl-signing\n");
    const { secrets } = await loadConfig({ cwd: dir });
    expect(secrets).toEqual({ ...pushSecret, GITLAB_WEBHOOK_SECRET: "gl-secret", GITLAB_WEBHOOK_SIGNING_TOKEN: "gl-signing" });
  });
});

describe("SecretsSchema", () => {
  it("accepts LINEAR_API_KEY and LINEAR_WEBHOOK_SECRET", () => {
    expect(SecretsSchema.parse({ LINEAR_API_KEY: "lin_api_test", LINEAR_WEBHOOK_SECRET: "whsec" })).toEqual({
      LINEAR_API_KEY: "lin_api_test",
      LINEAR_WEBHOOK_SECRET: "whsec",
    });
  });

  it("strips LINEAR_CLIENT_ID and LINEAR_CLIENT_SECRET", () => {
    expect(SecretsSchema.parse({ LINEAR_CLIENT_ID: "id", LINEAR_CLIENT_SECRET: "secret" })).toEqual({});
  });

  it("rejects a non-string LINEAR_API_KEY", () => {
    expect(SecretsSchema.safeParse({ LINEAR_API_KEY: 42 }).success).toBe(false);
  });
});

describe("resolveFromConfigDir", () => {
  it("resolves a relative path against the config dir", () => {
    expect(resolveFromConfigDir("/etc/steward", "./prompts/implement.md")).toBe("/etc/steward/prompts/implement.md");
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

describe("implement secrets", () => {
  const writeFiles = (dir: string, env: string) => {
    const config = {
      dataDir: "./data",
      brain: { kind: "claude-code", model: "m", maxTurns: 1, timeoutMinutes: 1 },
      tracker: { kind: "linear", labels: {} },
      codehost: { kind: "gitlab", baseUrl: "https://gitlab.example", project: "acme/repo" },
      workspace: { fetchUrl: "https://gitlab.example/acme/repo.git", baseBranch: "dev", overlayDir: "./overlay", setup: [], port: 4100 },
      server: { port: 3020, publicUrl: "https://steward.example" },
      implement: { prompt: "./prompts/implement.md", commitAuthor: { name: "Ticket Steward", email: "steward@example.com" } },
    };
    writeFileSync(join(dir, "steward.config.ts"), `export default ${JSON.stringify(config)};\n`);
    writeFileSync(join(dir, ".env"), env);
  };

  it("fails when implement is configured without GITLAB_PUSH_TOKEN", async () => {
    const dir = mkdtempSync(join(tmpdir(), "steward-load-"));
    writeFiles(dir, "LINEAR_API_KEY=x\n");
    await expect(loadConfig({ configPath: join(dir, "steward.config.ts") })).rejects.toThrow("implement requires GITLAB_PUSH_TOKEN in .env");
  });

  it("resolves implement.prompt against the config dir and reads the push token", async () => {
    const dir = mkdtempSync(join(tmpdir(), "steward-load-"));
    writeFiles(dir, "GITLAB_PUSH_TOKEN=glpat-push-token-value\n");
    const loaded = await loadConfig({ configPath: join(dir, "steward.config.ts") });
    expect(loaded.config.implement?.prompt).toBe(join(dir, "prompts/implement.md"));
    expect(loaded.secrets.GITLAB_PUSH_TOKEN).toBe("glpat-push-token-value");
  });
});

describe("loadConfig with secrets from AWS Secrets Manager", () => {
  const awsBlock = (map: Record<string, string>) => `secrets: { source: "aws", region: "us-west-2", map: ${JSON.stringify(map)} },`;
  /** Serves `values` by id; anything else is not found. */
  const fetcher = (values: Record<string, string>) => ({ get: async (id: string) => values[id] ?? null });

  it("reads the mapped secrets through the fetcher and ignores .env", async () => {
    await writeSource(join(dir, "steward.config.ts"), configSource(awsBlock({ GITLAB_PUSH_TOKEN: "DEV_PUSH", LINEAR_API_KEY: "DEV_LINEAR" })), "LINEAR_API_KEY=from-env-file\n");
    const { config, secrets } = await loadConfig({ cwd: dir, secretFetcher: fetcher({ DEV_PUSH: '{"GITLAB_PUSH_TOKEN":"glpat-aws"}', DEV_LINEAR: "lin_api_aws" }) });
    expect(config.secrets).toEqual({ source: "aws", region: "us-west-2", map: { GITLAB_PUSH_TOKEN: "DEV_PUSH", LINEAR_API_KEY: "DEV_LINEAR" } });
    expect(secrets).toEqual({ GITLAB_PUSH_TOKEN: "glpat-aws", LINEAR_API_KEY: "lin_api_aws" });
  });

  it("keeps the push token rule, naming the secrets map", async () => {
    await writeSource(join(dir, "steward.config.ts"), configSource(awsBlock({ LINEAR_API_KEY: "DEV_LINEAR" })));
    await expect(loadConfig({ cwd: dir, secretFetcher: fetcher({ DEV_LINEAR: "lin_api_aws" }) })).rejects.toThrow("implement requires GITLAB_PUSH_TOKEN in secrets.map");
  });

  it("fails naming a missing secret id", async () => {
    await writeSource(join(dir, "steward.config.ts"), configSource(awsBlock({ GITLAB_PUSH_TOKEN: "DEV_PUSH" })));
    await expect(loadConfig({ cwd: dir, secretFetcher: fetcher({}) })).rejects.toThrow("Secrets Manager: DEV_PUSH not found");
  });
});

describe("loadConfig with an overlay template", () => {
  const withTemplate = configSource().replace("port: 4100,", 'port: 4100, overlayTemplateDir: "./overlay-template",');

  it("resolves overlayTemplateDir against the config dir", async () => {
    await writeSource(join(dir, "steward.config.ts"), withTemplate);
    await mkdir(join(dir, "overlay-template"));
    await writeFile(join(dir, "overlay-template", ".env"), "STRIPE_SECRET_KEY={{secret:DEV_S@api.stripe.com}}\n");
    const { config } = await loadConfig({ cwd: dir });
    expect(config.workspace.overlayTemplateDir).toBe(join(dir, "overlay-template"));
  });

  it("refuses a template entry the egress proxy cannot stand in for", async () => {
    await writeSource(join(dir, "steward.config.ts"), withTemplate);
    await mkdir(join(dir, "overlay-template"));
    await writeFile(join(dir, "overlay-template", ".env"), "AWS_SECRET_ACCESS_KEY={{signed:DEV_X}}\n");
    await expect(loadConfig({ cwd: dir })).rejects.toThrow("workspace.overlayTemplateDir: .env:1: DEV_X is used to sign requests; the egress proxy cannot stand in for it");
  });
});
