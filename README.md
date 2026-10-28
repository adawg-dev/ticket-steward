# Ticket Steward

A standalone bot that implements Linear tickets a person labels `ready-for-agent`: it runs a
coding agent against a fresh checkout of your monorepo, verifies the change and pushes a
branch (the pipeline opens the merge request), then optionally follows the merge request's
Greptile review until it passes or hands the ticket back. On Linear it only changes labels.

Enrich (the old triage and Enrichment section) was removed on 2026-10-28. The brain never
holds tracker credentials; the steward validates a structured result and does every write
itself.

- Design: `docs/superpowers/specs/2026-09-11-ticket-steward-design.md`
- Implementation plan: `docs/superpowers/plans/2026-09-11-ticket-steward-v1.md`
- Operations runbook: `docs/ops.md`

## How it works

```
Linear webhook (ready-for-agent) ─▶ Fastify /webhooks/linear ─▶ SQLite jobs ─▶ worker lanes
                                                              │
   fetch ticket ─▶ worktree from bare mirror + env overlay + skills + setup
                ─▶ brain (Claude Agent SDK or OpenAI Agents SDK, detached process group)
                ─▶ validate result ─▶ secret guard, checks, commit ─▶ push a new branch
                ─▶ swap labels ─▶ Greptile fix loop on the merge request (optional)
```

Brains: `claude-code`, `openai-agents`. Code hosts: `gitlab`, `github`. Tracker: `linear`.

## Quick start

Requires Node 22+, pnpm, and a host that is already a working dev box for the target
repo. Full details, including the dedicated OS user and the systemd unit, are in
`docs/ops.md`.

```bash
npm i -g ticket-steward                 # or: pnpm install && pnpm build, then link bin/steward.js

mkdir -p /etc/ticket-steward && cd /etc/ticket-steward
steward init                            # steward.config.ts, .env.example, prompts/implement.md, prompts/fix.md, skills/
cp .env.example .env && chmod 0600 .env # fill in the secrets, including LINEAR_API_KEY (docs/ops.md §1.7)

# start from the kickoff example instead of the generated config if you work on that repo
cp <ticket-steward>/examples/kickoff/steward.config.ts .
cp -r <ticket-steward>/examples/kickoff/skills/. skills/

steward mirror init                     # bare mirror fetched with the read-only MIRROR_TOKEN
steward overlay sync --from <checkout>  # gitignored .env* files with SANDBOX credentials
steward doctor                          # every check reported; exits 1 if any fails
steward serve                           # webhook server + worker (in production: systemd)
```

Try it on one ticket without touching anything:

```bash
steward implement KEY-123 --dry-run
```

## CLI

| Command | What it does |
| --- | --- |
| `steward init [dir]` | Writes `steward.config.ts`, `.env.example`, `prompts/implement.md`, `prompts/fix.md` (when absent), `skills/` into `dir` (default: current directory). Refuses to overwrite. |
| `steward doctor` | Runs every health check (config, secrets, user, modes, mirror, overlay, skills, Linear API key, Greptile loop (when configured), public URL, codehost MCP, Playwright, port), reports all, exits non-zero if any fails. |
| `steward mirror init` \| `fetch` | Create or refresh the bare mirror. |
| `steward overlay sync --from <path> [--allow-pattern <re>]` | Copy gitignored `.env*` files from a checkout into the overlay; refuses prod-looking values unless allowed. |
| `steward serve` | Webhook server and worker; takes `run.lock`. |
| `steward implement <KEY\|UUID> [--dry-run]` | Implement one ticket on a new branch: enqueue if `serve` is up, else run inline; never swaps labels. `--dry-run` runs up to the checks and prints the would-be commit. |
| `steward jobs [--status s] [--limit n]` | List jobs. |
| `steward jobs show <id>` | Job row with its stored result, attempts, transcript path, artifacts listing. |
| `steward jobs retry <id>` | Runs the job again: requeues it for `serve` when that is running, otherwise runs it inline under the run lock (publish-only when an implement result is stored; a leftover enrich job fails). |
| `steward jobs gc` | Run retention now. |
| `steward templates` | Issue templates for the workspace and allowlisted teams. |
| `steward mcp codehost --config <abs> --workspace <abs> --sha <sha>` | Internal: the stdio MCP server the brain uses for `recent_changes` and `permalink`. |

## Configuration

`steward.config.ts` next to a `.env`; see `examples/kickoff/` for a complete pair. The
`.env` is parsed into memory and never loaded into `process.env`.

Linear access is a personal API key (`LINEAR_API_KEY`) of a dedicated Linear user, so
every label change appears as that user, plus a hand-made workspace webhook on the **Issues**
event whose signing secret is `LINEAR_WEBHOOK_SECRET`. Setup is in `docs/ops.md` §1.7.

```ts
import { defineConfig } from "ticket-steward";

export default defineConfig({
  dataDir: "/var/lib/ticket-steward",
  brain: { kind: "claude-code", model: "claude-opus-5", maxTurns: 80, timeoutMinutes: 30 },
  tracker: { kind: "linear", teams: ["API", "APP"], labels: {} },
  codehost: { kind: "gitlab", baseUrl: "https://gitlab.com", project: "org/repo" },
  workspace: {
    fetchUrl: "https://gitlab.com/org/repo.git",
    baseBranch: "dev",
    overlayDir: "/var/lib/ticket-steward/overlay",
    skillsDir: "./skills",
    setup: ["pnpm install --frozen-lockfile --ignore-scripts"],
    portRewrite: { from: 3000 },
    port: 4100,
  },
  server: { port: 3020, publicUrl: "https://steward.example.com" },
  implement: {
    prompt: "./prompts/implement.md",
    commitAuthor: { name: "Ticket Steward", email: "steward@example.com" },
  },
});
```

`implement` (and with it `tracker.labels` and `GITLAB_PUSH_TOKEN`) is required. The enrich
keys `prompt`, `tracker.gatewayIssues`, `tracker.bugLabels` and `tracker.labels.triage` are
rejected with a "was removed with enrich" error; delete them from an older config.

## Label workflows

One Linear label, added by a person, drives the steward; a ticket created or labelled without it is skipped:

- `ready-for-agent` runs an agent against a fresh checkout. The steward verifies the change (secret guard, checks, hooks), commits it and pushes a new `<type>/<KEY>-<slug>` branch; the pipeline opens the merge request. The ticket ends as `agent-implemented`, or is handed back as `ready-for-human` or `needs-info`.

Setup (labels, `GITLAB_PUSH_TOKEN`, branch protection, the `implement` block) and the flows are in `docs/ops.md` §1.7a.

With a `greptile` block the steward then runs a fix loop on the merge request: it fixes or declines Greptile's findings round by round until the review is 5/5 on a green pipeline (`agent-approved`) or hands the ticket back; restart with `ready-for-agent` or `steward fix <KEY>`. See `docs/ops.md` §1.7b.

## Security posture

- **Dedicated user.** Runs as the `steward` system user with its own HOME, no ssh keys,
  no cloud or kube config, not in `docker`. The systemd unit uses `ProtectSystem=strict`,
  `ProtectHome=yes`, `ReadWritePaths=<dataDir>`, `PrivateTmp`, `NoNewPrivileges`,
  `KillMode=control-group`.
- **Environment allowlist.** The brain child gets exactly `PATH`, `HOME`, `LANG`, `TERM`,
  `NODE_ENV`, `STEWARD_PORT`, `PORT`, `GIT_CONFIG_GLOBAL=/dev/null`,
  `GIT_TERMINAL_PROMPT=0`, `CI=1` and its one brain credential. Tracker, webhook, mirror
  and codehost secrets never reach it.
- **Read-only repo.** The mirror is fetched with a read-only token; every worktree gets
  `pushurl=/dev/null`; the tool policy denies `git push`, `git commit`, `git remote`,
  writes outside the worktree and artifacts dir, and any reference to the mirror,
  database or overlay.
- **Sandbox credentials.** The overlay must hold credentials created for the steward
  (own DB role, test-mode Stripe keys, capped provider keys). `overlay sync` enforces
  0600/0700 modes and refuses prod-looking values by default. `docs/ops.md` §2 says why.
- **Push token.** Only with `implement` configured: `GITLAB_PUSH_TOKEN` (project access
  token, Developer, `write_repository`) is used for `ls-remote` and a create-only push from
  a scratch repo with hooks disabled, never forces or touches an existing branch, and
  `main`/`staging`/`dev` stay protected server-side. `steward doctor` checks the protection.
- **Redaction.** Every `.env` value (the Linear API key included) and every
  credential-looking overlay value are redacted from transcripts, setup output and
  anything written to the ticket, along with `sk-`, `glpat-`, `ghp_`, `lin_api_`,
  `lin_oauth_` and `postgres://user:pass@` patterns.
- **Linear key.** A personal API key restricted to the allowlisted teams, with read,
  write, comment and upload permissions only. A 401 is not retried: the worker stops
  claiming jobs and `/health` answers 503 until the steward restarts with a working key.
- **Webhook.** HMAC-SHA256 signature and delivery-id dedupe.

## Development

```bash
pnpm install
pnpm typecheck && pnpm lint && pnpm test
pnpm dev -- doctor          # run the CLI from source
pnpm build                  # dist/, used by bin/steward.js
```

MIT, Concentrate AI.
