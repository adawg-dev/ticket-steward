import { defineConfig } from "ticket-steward";

export default defineConfig({
  dataDir: "/var/lib/ticket-steward",
  brain: { kind: "claude-code", model: "claude-opus-5", maxTurns: 80, timeoutMinutes: 30 },
  // brain: { kind: "openai-agents", model: "gpt-6-luna", reasoningEffort: "high", maxTurns: 80, timeoutMinutes: 30 },
  tracker: { kind: "linear", teams: ["API", "RSPNS", "MSGS", "CC", "USRAPP", "STFAPP", "APP", "OPS", "PLAT"], gatewayIssues: "enrich", bugLabels: ["Bug"], labels: {} }, // gatewayIssues "skip" only if ticket-gateway enriches through the steward itself; labels: {} turns on label workflows with the default names (needs-triage, ready-for-agent, ...), so tickets are enriched only when labeled
  codehost: { kind: "gitlab", baseUrl: "https://gitlab.com", project: "concentrateai/kickoff" },
  // codehost: { kind: "github", owner: "concentrateai", repo: "kickoff" },
  workspace: {
    fetchUrl: "https://gitlab.com/concentrateai/kickoff.git", // token injected from MIRROR_TOKEN
    baseBranch: "dev",
    overlayDir: "/var/lib/ticket-steward/overlay",
    skillsDir: "./skills",
    // reset-dbs.sh (next to this file) rebuilds the local Postgres + TimescaleDB from the checkout's schema every job; install it as /etc/ticket-steward/reset-dbs.sh
    setup: ["bash /etc/ticket-steward/reset-dbs.sh", "pnpm install --frozen-lockfile --ignore-scripts", "pnpm turbo build --filter='./packages/*'"],
    setupTimeoutMinutes: 15,
    portRewrite: { from: 3000 },
    port: 4100,
    keepOnFailure: true,
  },
  retention: { keptWorktrees: 3, days: 30 },
  prompt: "./prompts/enrich.md",
  server: { port: 3020, publicUrl: "https://steward.example.com" },
  // Review merge requests that add the steward's GitLab user as a reviewer (docs/ops.md §1.10).
  // review: { botUsername: "ticket-steward", prompt: "./prompts/review.md" },
  // Label-driven implementation (ready-for-agent). Requires GITLAB_PUSH_TOKEN in .env: a project access token, Developer role, write_repository only.
  // Copy <ticket-steward>/prompts/implement.md to /etc/ticket-steward/prompts/implement.md (steward init does not write it).
  implement: {
    prompt: "./prompts/implement.md",
    checks: ["pnpm turbo check-types lint --filter='...[{{baseSha}}]'"],
    commitAuthor: { name: "Ticket Steward", email: "steward@concentrate.ai" },
  },
});
