import { buildBrainEnv } from "../../src/brain/env.js";
import type { BrainConfig } from "../../src/config/schema.js";

const BASE_KEYS = ["CI", "GIT_CONFIG_GLOBAL", "GIT_TERMINAL_PROMPT", "HOME", "LANG", "NODE_ENV", "PATH", "PORT", "STEWARD_PORT", "TERM"];
const claudeCode: BrainConfig = { kind: "claude-code", model: "claude-opus-5", maxTurns: 80, timeoutMinutes: 30 };
const openaiAgents: BrainConfig = { kind: "openai-agents", model: "gpt-5.5", maxTurns: 80, timeoutMinutes: 30 };
const allSecrets = {
  LINEAR_CLIENT_ID: "linear-client-id",
  LINEAR_CLIENT_SECRET: "linear-client-secret",
  LINEAR_WEBHOOK_SECRET: "linear-webhook-secret",
  MIRROR_TOKEN: "mirror-token",
  GITLAB_TOKEN: "glpat-gitlab-token",
  GITHUB_TOKEN: "ghp_github_token",
  ANTHROPIC_API_KEY: "sk-ant-anthropic-key",
  CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat-oauth-token",
  OPENAI_API_KEY: "sk-openai-key",
  OPENAI_BASE_URL: "https://proxy.example.com/v1",
};

describe("buildBrainEnv", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("claude-code with an API key gets exactly the base keys plus ANTHROPIC_API_KEY", () => {
    const env = buildBrainEnv(allSecrets, claudeCode, 4100);
    expect(Object.keys(env).sort()).toEqual(["ANTHROPIC_API_KEY", ...BASE_KEYS]);
    expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-anthropic-key");
    expect(env.STEWARD_PORT).toBe("4100");
    expect(env.PORT).toBe("4100");
    expect(env.NODE_ENV).toBe("development");
    expect(env.GIT_CONFIG_GLOBAL).toBe("/dev/null");
    expect(env.GIT_TERMINAL_PROMPT).toBe("0");
    expect(env.CI).toBe("1");
  });

  it("claude-code without an API key falls back to CLAUDE_CODE_OAUTH_TOKEN", () => {
    const env = buildBrainEnv({ CLAUDE_CODE_OAUTH_TOKEN: allSecrets.CLAUDE_CODE_OAUTH_TOKEN, OPENAI_API_KEY: allSecrets.OPENAI_API_KEY }, claudeCode, 4100);
    expect(Object.keys(env).sort()).toEqual(["CI", "CLAUDE_CODE_OAUTH_TOKEN", ...BASE_KEYS.slice(1)]);
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("sk-ant-oat-oauth-token");
  });

  it("openai-agents gets exactly the base keys plus OPENAI_API_KEY and OPENAI_BASE_URL", () => {
    const env = buildBrainEnv(allSecrets, openaiAgents, 4100);
    expect(Object.keys(env).sort()).toEqual([...BASE_KEYS.slice(0, 6), "OPENAI_API_KEY", "OPENAI_BASE_URL", ...BASE_KEYS.slice(6)]);
    expect(env.OPENAI_API_KEY).toBe("sk-openai-key");
    expect(env.OPENAI_BASE_URL).toBe("https://proxy.example.com/v1");
  });

  it("openai-agents omits OPENAI_BASE_URL when it is not configured", () => {
    const env = buildBrainEnv({ OPENAI_API_KEY: allSecrets.OPENAI_API_KEY, ANTHROPIC_API_KEY: allSecrets.ANTHROPIC_API_KEY }, openaiAgents, 4100);
    expect(Object.keys(env).sort()).toEqual([...BASE_KEYS.slice(0, 6), "OPENAI_API_KEY", ...BASE_KEYS.slice(6)]);
  });
});
