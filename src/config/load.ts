import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, extname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "dotenv";
import { createJiti } from "jiti";
import { z } from "zod";
import { StewardConfigSchema } from "./schema.js";
import type { StewardConfig } from "./schema.js";

export const SecretsSchema = z.object({
  LINEAR_CLIENT_ID: z.string().optional(),
  LINEAR_CLIENT_SECRET: z.string().optional(),
  LINEAR_WEBHOOK_SECRET: z.string().optional(),
  MIRROR_TOKEN: z.string().optional(),
  GITLAB_TOKEN: z.string().optional(),
  GITHUB_TOKEN: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  CLAUDE_CODE_OAUTH_TOKEN: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_BASE_URL: z.string().optional(),
});
export type Secrets = z.infer<typeof SecretsSchema>;

export interface LoadedConfig {
  config: StewardConfig;
  secrets: Secrets;
  configPath: string;
  configDir: string;
}

const CONFIG_FILENAME = "steward.config.ts";
const PACKAGE_ALIAS = "ticket-steward";

// This module lives at <pkg>/src/config/load.ts in source and <pkg>/dist/config/load.js
// when built, so the package entry is always one directory up with the same extension.
const packageEntryPath = fileURLToPath(new URL(`../index${extname(import.meta.url)}`, import.meta.url));

export const resolveFromConfigDir = (configDir: string, p: string): string => {
  if (p === "~" || p.startsWith("~/")) return join(homedir(), p.slice(1));
  return isAbsolute(p) ? p : resolve(configDir, p);
};

const readSecrets = async (configDir: string): Promise<Secrets> => {
  const raw = await readFile(join(configDir, ".env"), "utf8").catch(() => "");
  return SecretsSchema.parse(parse(raw));
};

export const loadConfig = async (opts: { configPath?: string; cwd?: string }): Promise<LoadedConfig> => {
  const configPath = resolve(opts.configPath ?? join(opts.cwd ?? process.cwd(), CONFIG_FILENAME));
  const configDir = dirname(configPath);
  const jiti = createJiti(import.meta.url, { alias: { [PACKAGE_ALIAS]: packageEntryPath }, moduleCache: false });
  const parsed = StewardConfigSchema.parse(await jiti.import(configPath, { default: true }));
  const config: StewardConfig = {
    ...parsed,
    dataDir: resolveFromConfigDir(configDir, parsed.dataDir),
    prompt: resolveFromConfigDir(configDir, parsed.prompt),
    workspace: {
      ...parsed.workspace,
      overlayDir: resolveFromConfigDir(configDir, parsed.workspace.overlayDir),
      ...(parsed.workspace.skillsDir === undefined
        ? {}
        : { skillsDir: resolveFromConfigDir(configDir, parsed.workspace.skillsDir) }),
    },
  };
  return { config, secrets: await readSecrets(configDir), configPath, configDir };
};
