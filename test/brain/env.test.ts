import { buildBrainEnv, buildWorkspaceEnv } from "../../src/brain/env.js";
import type { BrainConfig } from "../../src/config/schema.js";

const BASE_KEYS = ["CI", "GIT_CONFIG_GLOBAL", "GIT_TERMINAL_PROMPT", "HOME", "LANG", "NODE_ENV", "PATH", "PORT", "STEWARD_PORT", "TERM"];
const claudeCode: BrainConfig = { kind: "claude-code", model: "claude-opus-5", maxTurns: 80, timeoutMinutes: 30 };
const openaiAgents: BrainConfig = { kind: "openai-agents", model: "gpt-5.5", maxTurns: 80, timeoutMinutes: 30 };
const allSecrets = {
  LINEAR_API_KEY: "lin_api_linear-key",
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
    const env = buildBrainEnv(allSecrets, claudeCode, 4100, "/d/sessions");
    expect(Object.keys(env).sort()).toEqual(["ANTHROPIC_API_KEY", ...BASE_KEYS.slice(0, 1), "CLAUDE_CONFIG_DIR", ...BASE_KEYS.slice(1)]);
    expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-anthropic-key");
    expect(env.STEWARD_PORT).toBe("4100");
    expect(env.PORT).toBe("4100");
    expect(env.NODE_ENV).toBe("development");
    expect(env.GIT_CONFIG_GLOBAL).toBe("/dev/null");
    expect(env.GIT_TERMINAL_PROMPT).toBe("0");
    expect(env.CI).toBe("1");
  });

  it("claude-code through a gateway gets ANTHROPIC_BASE_URL and ANTHROPIC_AUTH_TOKEN", () => {
    const env = buildBrainEnv({ ANTHROPIC_AUTH_TOKEN: "sk-cn-v1-gateway-key", ANTHROPIC_BASE_URL: "https://api.concentrate.ai", OPENAI_API_KEY: allSecrets.OPENAI_API_KEY }, claudeCode, 4100, "/d/sessions");
    expect(Object.keys(env).sort()).toEqual(["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", ...BASE_KEYS.slice(0, 1), "CLAUDE_CONFIG_DIR", ...BASE_KEYS.slice(1)]);
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("sk-cn-v1-gateway-key");
    expect(env.ANTHROPIC_BASE_URL).toBe("https://api.concentrate.ai");
  });

  it("claude-code without an API key falls back to CLAUDE_CODE_OAUTH_TOKEN", () => {
    const env = buildBrainEnv({ CLAUDE_CODE_OAUTH_TOKEN: allSecrets.CLAUDE_CODE_OAUTH_TOKEN, OPENAI_API_KEY: allSecrets.OPENAI_API_KEY }, claudeCode, 4100, "/d/sessions");
    expect(Object.keys(env).sort()).toEqual(["CI", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CONFIG_DIR", ...BASE_KEYS.slice(1)]);
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("sk-ant-oat-oauth-token");
  });

  it("openai-agents gets exactly the base keys plus OPENAI_API_KEY and OPENAI_BASE_URL", () => {
    const env = buildBrainEnv(allSecrets, openaiAgents, 4100, "/d/sessions");
    expect(Object.keys(env).sort()).toEqual([...BASE_KEYS.slice(0, 6), "OPENAI_API_KEY", "OPENAI_BASE_URL", ...BASE_KEYS.slice(6)]);
    expect(env.OPENAI_API_KEY).toBe("sk-openai-key");
    expect(env.OPENAI_BASE_URL).toBe("https://proxy.example.com/v1");
  });

  it("claude-code keeps its sessions in the given directory", () => {
    expect(buildBrainEnv(allSecrets, claudeCode, 4100, "/d/sessions").CLAUDE_CONFIG_DIR).toBe("/d/sessions");
  });

  it("openai-agents gets no CLAUDE_CONFIG_DIR", () => {
    expect(buildBrainEnv(allSecrets, openaiAgents, 4100, "/d/sessions")).not.toHaveProperty("CLAUDE_CONFIG_DIR");
  });

  it("openai-agents omits OPENAI_BASE_URL when it is not configured", () => {
    const env = buildBrainEnv({ OPENAI_API_KEY: allSecrets.OPENAI_API_KEY, ANTHROPIC_API_KEY: allSecrets.ANTHROPIC_API_KEY }, openaiAgents, 4100, "/d/sessions");
    expect(Object.keys(env).sort()).toEqual([...BASE_KEYS.slice(0, 6), "OPENAI_API_KEY", ...BASE_KEYS.slice(6)]);
  });

  it("gives the agent's commits the configured author only when one is given", () => {
    const env = buildBrainEnv(allSecrets, claudeCode, 4100, "/d/sessions", { name: "Ticket Steward", email: "steward@example.com" });
    expect(env).toMatchObject({
      GIT_AUTHOR_NAME: "Ticket Steward",
      GIT_AUTHOR_EMAIL: "steward@example.com",
      GIT_COMMITTER_NAME: "Ticket Steward",
      GIT_COMMITTER_EMAIL: "steward@example.com",
    });
    expect(Object.keys(buildBrainEnv(allSecrets, claudeCode, 4100, "/d/sessions")).filter((key) => key.startsWith("GIT_AUTHOR"))).toEqual([]);
  });

  it("builds a workspace env without any credentials", () => {
    const env = buildWorkspaceEnv(4100);
    expect(env.STEWARD_PORT).toBe("4100");
    expect(Object.keys(env).filter((key) => /KEY|TOKEN|SECRET/.test(key))).toEqual([]);
  });
});
