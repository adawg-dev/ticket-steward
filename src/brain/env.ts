import { homedir } from "node:os";
import type { Secrets } from "../config/load.js";
import type { BrainConfig } from "../config/schema.js";

const credentialEnv = (secrets: Secrets, brain: BrainConfig): Record<string, string> => {
  if (brain.kind === "claude-code") {
    const env: Record<string, string> = {};
    if (secrets.ANTHROPIC_BASE_URL !== undefined) env.ANTHROPIC_BASE_URL = secrets.ANTHROPIC_BASE_URL;
    if (secrets.ANTHROPIC_API_KEY !== undefined) return { ...env, ANTHROPIC_API_KEY: secrets.ANTHROPIC_API_KEY };
    if (secrets.ANTHROPIC_AUTH_TOKEN !== undefined) return { ...env, ANTHROPIC_AUTH_TOKEN: secrets.ANTHROPIC_AUTH_TOKEN };
    if (secrets.CLAUDE_CODE_OAUTH_TOKEN !== undefined) return { ...env, CLAUDE_CODE_OAUTH_TOKEN: secrets.CLAUDE_CODE_OAUTH_TOKEN };
    return env;
  }
  const env: Record<string, string> = {};
  if (secrets.OPENAI_API_KEY !== undefined) env.OPENAI_API_KEY = secrets.OPENAI_API_KEY;
  if (secrets.OPENAI_BASE_URL !== undefined) env.OPENAI_BASE_URL = secrets.OPENAI_BASE_URL;
  return env;
};

/**
 * Where Playwright's browsers live, when the steward's env names it. The image installs Chromium outside HOME, which
 * is the bind-mounted data dir, so every process that may start a browser has to be told.
 */
export const playwrightEnv = (): Record<string, string> =>
  process.env.PLAYWRIGHT_BROWSERS_PATH === undefined ? {} : { PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH };

/** The job's process env without any credential: setup, checks and commit hooks run with this. */
export const buildWorkspaceEnv = (port: number): Record<string, string> => ({
  PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
  HOME: process.env.HOME ?? homedir(),
  ...playwrightEnv(),
  LANG: process.env.LANG ?? "C.UTF-8",
  TERM: process.env.TERM ?? "dumb",
  NODE_ENV: "development",
  STEWARD_PORT: String(port),
  PORT: String(port),
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
  CI: "1",
});

/** The identity the agent's own commits carry; git has no global config to take one from. */
const authorEnv = (author: { name: string; email: string }): Record<string, string> => ({
  GIT_AUTHOR_NAME: author.name,
  GIT_AUTHOR_EMAIL: author.email,
  GIT_COMMITTER_NAME: author.name,
  GIT_COMMITTER_EMAIL: author.email,
});

/**
 * The brain's env: the workspace env plus the brain's own credentials, for claude-code its session store, and with
 * `author` (`implement.commitAuthor`) the identity its commits carry.
 */
export const buildBrainEnv = (
  secrets: Secrets,
  brain: BrainConfig,
  port: number,
  sessionsDir: string,
  author?: { name: string; email: string },
): Record<string, string> => ({
  ...buildWorkspaceEnv(port),
  ...credentialEnv(secrets, brain),
  ...(brain.kind === "claude-code" ? { CLAUDE_CONFIG_DIR: sessionsDir } : {}),
  ...(author === undefined ? {} : authorEnv(author)),
});
