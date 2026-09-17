import { defineConfig } from "ticket-steward";

export default defineConfig({
  dataDir: "/var/lib/ticket-steward",
  brain: { kind: "claude-code", model: "claude-opus-5", maxTurns: 80, timeoutMinutes: 30 },
  // brain: { kind: "openai-agents", model: "gpt-5.5", maxTurns: 80, timeoutMinutes: 30 },
  tracker: { kind: "linear", teams: ["API", "RSPNS", "MSGS", "CC", "USRAPP", "STFAPP", "APP", "OPS", "PLAT"] },
  codehost: { kind: "gitlab", baseUrl: "https://gitlab.com", project: "concentrateai/kickoff" },
  // codehost: { kind: "github", owner: "concentrateai", repo: "kickoff" },
  workspace: {
    fetchUrl: "https://gitlab.com/concentrateai/kickoff.git", // token injected from MIRROR_TOKEN
    baseBranch: "dev",
    overlayDir: "/var/lib/ticket-steward/overlay",
    skillsDir: "./skills",
    setup: ["pnpm install --frozen-lockfile --ignore-scripts", "pnpm turbo build --filter='./packages/*'"],
    setupTimeoutMinutes: 15,
    portRewrite: { from: 3000 },
    port: 4100,
    keepOnFailure: true,
  },
  retention: { keptWorktrees: 3, days: 30 },
  prompt: "./prompts/enrich.md",
  server: { port: 3020, publicUrl: "https://steward.example.com" },
});
