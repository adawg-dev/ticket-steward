# Ticket Steward

A Linear app that implements the tickets people delegate to it: it runs a coding agent against
a fresh checkout of your monorepo, shows its work live in Linear's agent panel (where people can
steer or stop it), pushes a branch (the pipeline opens the merge request), then optionally
answers every comment on the merge request, from people and review bots alike, round by round.

Enrich (the old triage and Enrichment section) was removed on 2026-10-28. The brain never
holds tracker credentials; the steward validates a structured result and does every write
itself.

- Design: `docs/superpowers/specs/2026-09-11-ticket-steward-design.md`
- Implementation plan: `docs/superpowers/plans/2026-09-11-ticket-steward-v1.md`
- Operations runbook: `docs/ops.md`

## How it works

```
Linear agent session (delegated) ─▶ Fastify /webhooks/linear ─▶ SQLite jobs ─▶ worker lanes
                                                              │
   fetch ticket ─▶ worktree from bare mirror + env overlay + skills + setup
                ─▶ brain (Claude Agent SDK or OpenAI Agents SDK, detached process group)
                ─▶ validate result ─▶ secret guard, checks, commit ─▶ push a new branch
                ─▶ agent panel in Linear ─▶ review loop on the merge request (optional)
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
cp .env.example .env && chmod 0600 .env # fill in the secrets, including the Linear app's LINEAR_CLIENT_ID and LINEAR_CLIENT_SECRET (docs/ops.md §1.7)

# start from the kickoff example instead of the generated config if you work on that repo
cp <ticket-steward>/examples/kickoff/steward.config.ts .
cp -r <ticket-steward>/examples/kickoff/skills/. skills/

steward mirror init                     # bare mirror fetched with the read-only MIRROR_TOKEN
steward overlay sync --from <checkout>  # gitignored .env* files with SANDBOX credentials
steward doctor                          # every check reported; exits 1 if any fails
steward serve                           # webhook server + worker (in production: systemd)
```

Preview the prompt a run on one ticket would get (read through `steward serve`; nothing runs):

```bash
steward implement KEY-123 --dry-run
```

## CLI

| Command | What it does |
| --- | --- |
| `steward init [dir]` | Writes `steward.config.ts`, `.env.example`, `prompts/implement.md`, `prompts/fix.md` (when absent), `skills/` into `dir` (default: current directory). Refuses to overwrite. |
| `steward doctor` | Runs every health check (config, secrets, user, modes, mirror, overlay, skills, Linear app token, Greptile loop (when configured), public URL, codehost MCP, Playwright, port), reports all, exits non-zero if any fails. |
| `steward mirror init` \| `fetch` | Create or refresh the bare mirror. |
| `steward overlay sync --from <path> [--allow-pattern <re>]` | Copy gitignored `.env*` files from a checkout into the overlay; refuses prod-looking values unless allowed. |
| `steward serve` | Webhook server and worker; takes `run.lock`. |
| `steward implement <KEY\|UUID> --dry-run` | Print the implement prompt for one ticket, read through `serve`'s admin API (the CLI holds no Linear token; only the kubernetes runtime serves the admin API). Work starts only by assigning the steward in Linear. |
| `steward jobs [--status s] [--limit n]` | List jobs. |
| `steward jobs show <id>` | Job row with its stored result, attempts, transcript path, artifacts listing. |
| `steward jobs retry <id>` | Runs the job again: requeues it for `serve`, which must be running (jobs run only in the dispatcher, which alone holds the Linear token); without serve it refuses and leaves the job as it was. Publish-only when an implement result is stored; a leftover enrich job fails. |
| `steward jobs gc` | Run retention now. |
| `steward templates` | Issue templates for the workspace and allowlisted teams, read by `steward serve` (admin API; kubernetes runtime only). |
| `steward mcp codehost --config <abs> --workspace <abs> --sha <sha>` | Internal: the stdio MCP server the brain uses for `recent_changes` and `permalink`. |

## Configuration

`steward.config.ts` next to a `.env`; see `examples/kickoff/` for a complete pair. The
`.env` is parsed into memory and never loaded into `process.env`.

Linear access is an OAuth app installed for the workspace with `actor=app`: the dispatcher mints
client-credentials tokens from `LINEAR_CLIENT_ID` and `LINEAR_CLIENT_SECRET` (Secrets Manager
`DEV_STEWARD_LINEAR_CLIENT_ID` and `DEV_STEWARD_LINEAR_CLIENT_SECRET`) and holds them in memory only.
The app's webhook (Agent session events, Permission changes, Issues) is signed with
`LINEAR_WEBHOOK_SECRET`. Setup is in `docs/ops.md` §1.7.

```ts
import { defineConfig } from "ticket-steward";

export default defineConfig({
  dataDir: "/var/lib/ticket-steward",
  brain: { kind: "claude-code", model: "claude-opus-5", maxTurns: 80, timeoutMinutes: 30 },
  tracker: { kind: "linear", teams: ["API", "APP"] },
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

`implement` (and with it `GITLAB_PUSH_TOKEN`) is required, and the Linear app needs the
`claude-code` brain. `tracker.labels` is rejected ("assign the steward in Linear instead"), and the
enrich keys `prompt`, `tracker.gatewayIssues` and `tracker.bugLabels` with a "was removed with enrich"
error; delete them from an older config.

## Workflow

Delegating a ticket to the steward in Linear starts it; removing it stops the run and parks the work:

- The agent works in a fresh checkout and pushes a new `<type>/<KEY>-<slug>` branch through the steward's push tool, which verifies every push (secret guard, checks); the pipeline opens the merge request. The ticket moves to its started state, then to the review state once the MR opens. Questions come back as an elicitation in the agent panel; a person's answer continues the same session.
- An @mention or a prompt in the panel steers the running agent, or resumes its session when nothing runs; stop ends the run.

Setup (the Linear app, `GITLAB_PUSH_TOKEN`, branch protection, the `implement` block) is in `docs/ops.md` §1.7 and §1.7a.

With a `greptile` block the steward then runs a review loop on the merge request: every unresolved comment, a person's or a bot's, is answered by a change and a reply or a reply alone; lasting instructions people give become decisions no later round undoes; flaky and infrastructure CI failures are retried first; rounds only bots start are capped. See `docs/ops.md` §1.7b.

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
- **Redaction.** Every `.env` value (the Linear client secret included) and every
  credential-looking overlay value are redacted from transcripts, setup output and
  anything posted on the merge request, along with `sk-`, `glpat-`, `ghp_`, `lin_api_`,
  `lin_oauth_` and `postgres://user:pass@` patterns.
- **Linear app.** Client-credentials tokens (`read,write,app:assignable,app:mentionable`) minted
  by the dispatcher, held in memory only, re-minted daily and on a 401, revoked on shutdown; no CLI
  command, brain or run pod holds one. Rejected client credentials are not retried: the worker stops
  claiming jobs and `/health` answers 503 until the steward restarts with working ones. Nothing
  posted to the agent panel carries raw command output, file contents or secrets.
- **Webhook.** HMAC-SHA256 signature and delivery-id dedupe.

## Development

```bash
pnpm install
pnpm typecheck && pnpm lint && pnpm test
pnpm dev -- doctor          # run the CLI from source
pnpm build                  # dist/, used by bin/steward.js
```

MIT, Concentrate AI.
