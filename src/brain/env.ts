import { homedir } from "node:os";
import type { Secrets } from "../config/load.js";
import type { BrainConfig } from "../config/schema.js";

const credentialEnv = (secrets: Secrets, brain: BrainConfig): Record<string, string> => {
  if (brain.kind === "claude-code") {
    if (secrets.ANTHROPIC_API_KEY !== undefined) return { ANTHROPIC_API_KEY: secrets.ANTHROPIC_API_KEY };
    if (secrets.CLAUDE_CODE_OAUTH_TOKEN !== undefined) return { CLAUDE_CODE_OAUTH_TOKEN: secrets.CLAUDE_CODE_OAUTH_TOKEN };
    return {};
  }
  const env: Record<string, string> = {};
  if (secrets.OPENAI_API_KEY !== undefined) env.OPENAI_API_KEY = secrets.OPENAI_API_KEY;
  if (secrets.OPENAI_BASE_URL !== undefined) env.OPENAI_BASE_URL = secrets.OPENAI_BASE_URL;
  return env;
};

export const buildBrainEnv = (secrets: Secrets, brain: BrainConfig, port: number): Record<string, string> => ({
  PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
  HOME: process.env.HOME ?? homedir(),
  LANG: process.env.LANG ?? "C.UTF-8",
  TERM: process.env.TERM ?? "dumb",
  NODE_ENV: "development",
  STEWARD_PORT: String(port),
  PORT: String(port),
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
  CI: "1",
  ...credentialEnv(secrets, brain),
});
