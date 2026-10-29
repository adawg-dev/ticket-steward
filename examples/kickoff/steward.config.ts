import { defineConfig } from "ticket-steward";

export default defineConfig({
  dataDir: "/var/lib/ticket-steward",
  brain: { kind: "claude-code", model: "claude-opus-5", maxTurns: 80, timeoutMinutes: 30 },
  tracker: { kind: "linear", teams: ["API", "RSPNS", "MSGS", "CC", "USRAPP", "STFAPP", "APP", "OPS", "PLAT"] }, // work starts when someone assigns the steward's Linear app
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
    keepOnFailure: true,
  },
  retention: { keptWorktrees: 3, days: 30 },
  server: { port: 3020, publicUrl: "https://steward.example.com" },
  // Required: implementation, started by delegating a ticket to the steward's Linear app (docs/ops.md §1.7, LINEAR_CLIENT_ID and
  // LINEAR_CLIENT_SECRET, on AWS DEV_STEWARD_LINEAR_CLIENT_ID and DEV_STEWARD_LINEAR_CLIENT_SECRET). Requires GITLAB_PUSH_TOKEN in .env: a project access token, Developer role, write_repository only.
  // steward init writes prompts/implement.md; otherwise copy <ticket-steward>/prompts/implement.md to /etc/ticket-steward/prompts/implement.md.
  // prompts/repo.md beside this file (examples/kickoff/prompts/repo.md) is kickoff's own section of the implement, fix and chat prompts.
  implement: {
    prompt: "./prompts/implement.md",
    checks: ["pnpm turbo check-types lint --filter='...[{{baseSha}}]'"],
    commitAuthor: { name: "Ticket Steward", email: "steward@concentrate.ai" },
  },
  // Review loop after the implement push: every MR comment is answered, Greptile's among them (docs/ops.md §1.7b). Needs GITLAB_TOKEN with the api scope and
  // /etc/ticket-steward/prompts/fix.md (copy <ticket-steward>/prompts/fix.md). Kickoff's .greptile/config.json needs autoReview: ["open", "push"].
  // A kickoff webhook to <publicUrl>/webhooks/gitlab (GITLAB_WEBHOOK_SIGNING_TOKEN) with Comments, MR and Pipeline events wakes the loop;
  // it polls every 5 minutes otherwise. Rounds, Greptile and CI triage are runtime settings (`steward settings get`).
  // greptile: { botUsername: "greptile-apple", prompt: "./prompts/fix.md" },
  // Parallel jobs, each on fresh local Postgres+TimescaleDB, Redis and RabbitMQ containers (docs/ops.md §1.10).
  // Without this block, put `port: 4100` back in workspace and jobs run one at a time against the overlay's services.
  slots: {
    count: 2,
    appPortBase: 4100,
    env: {
      DB_HOST: "127.0.0.1",
      DB_PORT: "{{postgres}}",
      DB_NAME: "concentrate",
      DB_USER: "postgres",
      DB_PASSWORD: "steward-slot",
      PGPASSWORD: "steward-slot",
      DB_SSL: "false",
      TG_READ_CONN_STR: "postgres://postgres:steward-slot@127.0.0.1:{{postgres}}/concentrate_tg",
      TG_WRITE_CONN_STR: "postgres://postgres:steward-slot@127.0.0.1:{{postgres}}/concentrate_tg",
      TG_CONN_STR: "postgres://postgres:steward-slot@127.0.0.1:{{postgres}}/concentrate_tg",
      REDIS_URL: "redis://127.0.0.1:{{redis}}",
      REDIS_CLUSTER_NODES: null, // deleted: kickoff's client then uses REDIS_URL
      REDIS_PASSWORD: null,
      RABBITMQ_URL: "amqp://steward:steward-slot@127.0.0.1:{{rabbitmq}}",
    },
  },
  // Holds heavy job starts while the host is short on memory or CPU (docs/ops.md §1.10); these are the defaults.
  // resourceGuard: { minAvailableMemoryMb: 4096, maxLoadPerCpu: 1.5, startSpacingSeconds: 30 },
});
