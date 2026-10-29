import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, extname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";
import { StewardConfigSchema } from "./schema.js";
import { overlayTemplateIssues } from "../overlay/template.js";
import { loadSecretsFrom } from "./secretSource.js";
import type { SecretFetcher, SecretName, Secrets } from "./secretSource.js";
import type { StewardConfig } from "./schema.js";

export { SecretsSchema } from "./secretSource.js";
export type { SecretName, Secrets } from "./secretSource.js";

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

/**
 * Refuses a template entry the egress proxy cannot stand in for. A template dir that is not there yet (a container
 * that never renders it) is left to `render-overlay` and doctor.
 */
const checkOverlayTemplate = async (templateDir: string): Promise<void> => {
  if (!(await stat(templateDir).then((s) => s.isDirectory(), () => false))) return;
  const issues = await overlayTemplateIssues(templateDir);
  if (issues.length > 0) throw new Error(issues.map((issue) => `workspace.overlayTemplateDir: ${issue}`).join("\n"));
};

/**
 * `secretFetcher` stands in for Secrets Manager when `secrets.source` is "aws" (tests). `withoutSecrets` reads no secret
 * at all and returns none: a run pod's agent container holds no credential and has no identity to read one with.
 * `secretNames` reads only those (a run pod's sidecars), and the push token rule applies only when it is among them.
 */
export const loadConfig = async (opts: { configPath?: string; cwd?: string; secretFetcher?: SecretFetcher; withoutSecrets?: boolean; secretNames?: readonly SecretName[] }): Promise<LoadedConfig> => {
  const configPath = resolve(opts.configPath ?? join(opts.cwd ?? process.cwd(), CONFIG_FILENAME));
  const configDir = dirname(configPath);
  const jiti = createJiti(import.meta.url, { alias: { [PACKAGE_ALIAS]: packageEntryPath }, moduleCache: false });
  const parsed = StewardConfigSchema.parse(await jiti.import(configPath, { default: true }));
  const config: StewardConfig = {
    ...parsed,
    dataDir: resolveFromConfigDir(configDir, parsed.dataDir),
    workspace: {
      ...parsed.workspace,
      overlayDir: resolveFromConfigDir(configDir, parsed.workspace.overlayDir),
      ...(parsed.workspace.overlayTemplateDir === undefined
        ? {}
        : { overlayTemplateDir: resolveFromConfigDir(configDir, parsed.workspace.overlayTemplateDir) }),
      ...(parsed.workspace.skillsDir === undefined
        ? {}
        : { skillsDir: resolveFromConfigDir(configDir, parsed.workspace.skillsDir) }),
    },
    ...(parsed.implement === undefined ? {} : { implement: { ...parsed.implement, prompt: resolveFromConfigDir(configDir, parsed.implement.prompt) } }),
    ...(parsed.reviewLoop === undefined ? {} : { reviewLoop: { ...parsed.reviewLoop, prompt: resolveFromConfigDir(configDir, parsed.reviewLoop.prompt) } }),
    ...(parsed.greptile?.prompt === undefined ? {} : { greptile: { ...parsed.greptile, prompt: resolveFromConfigDir(configDir, parsed.greptile.prompt) } }),
  };
  if (config.workspace.overlayTemplateDir !== undefined) await checkOverlayTemplate(config.workspace.overlayTemplateDir);
  if (opts.withoutSecrets === true) return { config, secrets: {}, configPath, configDir };
  const secretsConfig = config.secrets ?? { source: "file" };
  const secrets = await loadSecretsFrom(secretsConfig, configDir, opts.secretFetcher, opts.secretNames);
  const needsPushToken = opts.secretNames === undefined || opts.secretNames.includes("GITLAB_PUSH_TOKEN");
  if (config.implement !== undefined && needsPushToken && (secrets.GITLAB_PUSH_TOKEN ?? "") === "") {
    throw new Error(`implement requires GITLAB_PUSH_TOKEN in ${secretsConfig.source === "file" ? ".env" : "secrets.map"}`);
  }
  return { config, secrets, configPath, configDir };
};
