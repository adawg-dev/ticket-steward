# Ticket Steward operations guide

This is the owner's runbook: how to stand up a steward on a dev VM, what the security
boundaries are and why, how to rotate every credential it holds, and how to read its
state when something goes wrong. Section numbers refer to the design spec in
`docs/superpowers/specs/2026-09-11-ticket-steward-design.md`.

Throughout, `/etc/ticket-steward` is the operator directory (holds `steward.config.ts`,
`.env`, `prompts/`, `skills/`) and `/var/lib/ticket-steward` is `dataDir`. Change both
consistently if you pick other paths; the systemd unit's `WorkingDirectory` and
`ReadWritePaths` must match.

## 1. Setup checklist

### 1.1 Host prerequisites

The steward does not provision a dev environment. The host must already be a working dev
box for the target repo: Node 22+, pnpm, and the shared services the repo needs
(Postgres, TimescaleDB, Redis, RabbitMQ, docker) already running and reachable on
localhost.

### 1.2 Dedicated OS user and directories

The steward runs as its own system user with a HOME outside `/home`, because the unit
sets `ProtectHome=yes` (which hides `/home`, `/root` and `/run/user` from the service).
Putting HOME under `dataDir` keeps Chromium, the Claude Code cache and pnpm's store
inside the one writable path the unit allows.

```bash
sudo useradd --system --create-home --home-dir /var/lib/ticket-steward --shell /bin/bash steward
sudo chmod 0700 /var/lib/ticket-steward
sudo mkdir -p /etc/ticket-steward
sudo chown steward:steward /etc/ticket-steward
sudo chmod 0700 /etc/ticket-steward

# The steward user must NOT be in docker, must have no ssh keys, no ~/.kube, no ~/.aws.
id steward
sudo -u steward ls -la /var/lib/ticket-steward
```

Install pnpm system-wide (the steward user has no writable global npm prefix, and
`~/.local/bin` is not on PATH under systemd), then Chromium for the steward user:

```bash
sudo npm i -g pnpm            # or: sudo corepack enable
sudo -u steward -H bash -lc 'npx --yes playwright@latest install chromium'
```

Install the steward CLI so `steward` is on PATH for every user (pick one):

```bash
# a) from the npm registry
sudo npm i -g ticket-steward

# b) from a checkout
sudo git clone <ticket-steward repo> /opt/ticket-steward
cd /opt/ticket-steward && sudo pnpm install --frozen-lockfile && sudo pnpm build
sudo ln -s /opt/ticket-steward/bin/steward.js /usr/local/bin/steward
```

Brain credential: either put an `ANTHROPIC_API_KEY` in `.env`, or mint a Claude Code
token as the steward user and put that in `.env` instead:

```bash
sudo -u steward -H bash -lc 'claude setup-token'   # prints CLAUDE_CODE_OAUTH_TOKEN
```

`ANTHROPIC_API_KEY` wins if both are present. The steward never relies on an interactive
login in `~/.claude`.

### 1.3 Repo tokens

Two separate tokens, deliberately:

- **`MIRROR_TOKEN`** — a **read-only** GitLab deploy token (scope `read_repository`) or a
  GitHub fine-grained token with `contents: read`. It is injected into
  `workspace.fetchUrl` when the mirror is created or fetched. It is the only credential
  that can touch the repository, and it cannot push.
- **`GITLAB_TOKEN`** / **`GITHUB_TOKEN`** — `read_api` (GitLab) or `pull_requests: read`
  (GitHub). Used by the codehost MCP server to map commits to MRs/PRs. It reaches that
  server's environment only, never the brain process.

### 1.4 Operator directory

```bash
sudo -u steward -H bash -lc 'cd /etc/ticket-steward && steward init'
```

`init` writes `steward.config.ts`, `.env.example`, `prompts/enrich.md` and `skills/` and
refuses to overwrite existing files. Replace the generated config with the kickoff
example and fill in the secrets:

```bash
sudo -u steward cp examples/kickoff/steward.config.ts /etc/ticket-steward/steward.config.ts
sudo -u steward cp -r examples/kickoff/skills/. /etc/ticket-steward/skills/
sudo -u steward cp examples/kickoff/.env.example /etc/ticket-steward/.env
sudo -u steward chmod 0600 /etc/ticket-steward/.env
sudoedit -u steward /etc/ticket-steward/.env
```

Every `steward` command below is run as the steward user from `/etc/ticket-steward`; the
CLI finds `steward.config.ts` in the current directory.

```bash
sudo -u steward -H bash -lc 'cd /etc/ticket-steward && steward mirror init'
```

This runs `git clone --mirror` with `MIRROR_TOKEN` injected and enables
`extensions.worktreeConfig` so each worktree can carry its own `pushurl=/dev/null`.

### 1.5 Sandbox credentials and the overlay

Build a credential set that belongs to the steward (see §2 for why), put those values in
the env files of a scratch checkout, then sync them:

```bash
sudo -u steward -H bash -lc 'cd /etc/ticket-steward && steward overlay sync --from /path/to/sandbox-checkout'
```

`overlay sync` copies gitignored `.env*` files (skipping `node_modules`, `.next`, `dist`)
into `overlayDir` with 0600 files in 0700 directories and refuses any file whose values
look like production (by default: hostnames containing `prod`). To accept a specific
value knowingly:

```bash
steward overlay sync --from /path/to/sandbox-checkout --allow-pattern 'prod-readonly-replica'
```

Per job, every overlay file is copied into the worktree at the same relative path, mode
0600, with `localhost:3000` / `127.0.0.1:3000` rewritten to the job's port when
`workspace.portRewrite` is set.

### 1.6 Public URL

Linear must reach `server.port` at `server.publicUrl` for webhooks and the OAuth
callback. Two working options:

**Caddy reverse proxy** (`/etc/caddy/Caddyfile`), with automatic TLS:

```
steward.example.com {
    reverse_proxy 127.0.0.1:3020
}
```

```bash
sudo systemctl reload caddy
```

**cloudflared tunnel**, when the VM has no inbound port:

```bash
cloudflared tunnel login
cloudflared tunnel create ticket-steward
cloudflared tunnel route dns ticket-steward steward.example.com
cat > ~/.cloudflared/config.yml <<'YAML'
tunnel: ticket-steward
credentials-file: /home/<you>/.cloudflared/<tunnel-id>.json
ingress:
  - hostname: steward.example.com
    service: http://127.0.0.1:3020
  - service: http_status:404
YAML
sudo cloudflared service install
```

Either way, `server.publicUrl` in the config is `https://steward.example.com` and the
steward itself listens on plain HTTP on `127.0.0.1:3020`. Only `/health`,
`/webhooks/linear` and `/oauth/linear/callback` exist; the webhook is HMAC-verified and
the callback requires a pending `state`, so exposing the port is acceptable.

### 1.7 Linear OAuth app and webhooks

1. Linear → Settings → Administration → API (workspace admin). Create an OAuth
   application named "Ticket Steward".
2. Redirect URL: `https://steward.example.com/oauth/linear/callback`.
3. Copy the client id and secret into `.env` as `LINEAR_CLIENT_ID` /
   `LINEAR_CLIENT_SECRET`.
4. In the same application, enable webhooks at
   `https://steward.example.com/webhooks/linear` with the **Issues** and **Agent session
   events** categories. Copy the signing secret into `.env` as `LINEAR_WEBHOOK_SECRET`.

Then authorize the app as a workspace admin (the token is an `actor=app` token, so the
steward writes as itself, not as you):

```bash
sudo -u steward -H bash -lc 'cd /etc/ticket-steward && steward auth linear'
```

The command prints an authorize URL, starts a temporary listener on `server.port` (unless
`serve` is already running and answering `/health`), waits for the callback, stores the
token pair in `dataDir/steward.db`, and clears `auth_broken`.

### 1.8 Doctor, then start the service

```bash
sudo -u steward -H bash -lc 'cd /etc/ticket-steward && steward doctor'
```

Every line is `[ok]`, `[warn]` or `[fail]`; the exit code is 1 if anything failed. Fix
every `[fail]` before installing the unit. Checks: config parses; `.env` holds the brain,
tracker and codehost secrets; the running user does not own `~/.ssh` or `~/.kube`;
`dataDir` and `overlayDir` are 0700; the mirror exists, has `extensions.worktreeConfig`
and fetches; the overlay has at least one file; the skills dir exists; the Linear token
answers a `viewer` query and `auth_broken` is clear; `publicUrl/health` answers; the
codehost MCP server starts and answers `tools/list`; Playwright's Chromium is installed;
`workspace.port` is free.

```bash
sudo cp ops/ticket-steward.service /etc/systemd/system/ticket-steward.service
# edit ReadWritePaths if dataDir is not /var/lib/ticket-steward
sudo systemctl daemon-reload
sudo systemctl enable --now ticket-steward
systemctl status ticket-steward
journalctl -u ticket-steward -f
curl -s https://steward.example.com/health
```

### 1.9 Smoke test

1. Create a ticket in an allowlisted team from the Bugs template. Within a few minutes
   the description gains an `## Enrichment` section between the steward markers and a
   comment "Enrichment added (job N, confidence …)".
2. @mention the agent on an existing ticket. The session shows a `thought` within
   seconds and a `response` when the run finishes.
3. `steward jobs` lists both jobs as `succeeded`.

For a ticket outside Linear's webhook path:

```bash
steward enrich KEY-123 --dry-run    # prints the rendered section and recorded writes; writes nothing, but takes run.lock (refused while serve runs)
steward enrich KEY-123              # enqueues if serve is running, otherwise runs inline under run.lock
```

## 2. Why the overlay holds sandbox credentials

The brain is a coding agent with shell access inside a real checkout, with real env files,
running commands that the repo's own tooling runs. The tool policy (deny `git push`,
deny writes outside the worktree, deny anything referencing the mirror or the database)
is a guardrail against mistakes, not a sandbox. Anything the checkout's env files can
reach, the agent can reach.

So the overlay must not be a copy of a developer's `.env` files. Build a set of
credentials that exist only for the steward:

- a dedicated database role on the local Postgres/Timescale with access to a seeded dev
  database, never a replica of production;
- Stripe **test-mode** keys;
- provider (Anthropic/OpenAI/…) keys with hard spend caps, distinct from the brain's own
  key so usage is attributable;
- Descope, HubSpot, Slack and similar integrations pointed at test projects or left empty;
- `ENABLE_DEV_AUTH_BYPASS=true` plus the matching Descope management key **for the test
  project only**, since the browser-verify skill depends on it.

`overlay sync` refusing values that contain `prod` is the last line, not the first. If a
credential in the overlay leaks through a transcript, an attachment or a screenshot, the
blast radius should be "someone can read seeded test data", nothing more.

The other half of the boundary is what the brain does **not** get: the brain child's
environment is exactly `PATH`, `HOME`, `LANG`, `TERM`, `NODE_ENV=development`,
`STEWARD_PORT`, `PORT`, `GIT_CONFIG_GLOBAL=/dev/null`, `GIT_TERMINAL_PROMPT=0`, `CI=1`
and its one brain credential. The Linear token, webhook secret, mirror token and codehost
token never enter that environment.

## 3. Rotating credentials

All secrets live in `/etc/ticket-steward/.env` and are read at process start. After
editing `.env`, restart:

```bash
sudo systemctl restart ticket-steward
```

| Credential | How to rotate |
| --- | --- |
| Linear access/refresh token | Rotates itself: the steward refreshes within 5 minutes of expiry (24 h access tokens) and on any 401, storing the new pair in `steward.db`. Nothing to do unless `auth_broken` is set (§5). |
| `LINEAR_CLIENT_SECRET` | Regenerate in the Linear OAuth app, update `.env`, restart. Existing tokens keep working until their next refresh, which then uses the new secret. If Linear invalidates the tokens on secret rotation, run `steward auth linear` again. |
| `LINEAR_WEBHOOK_SECRET` | Regenerate in the Linear OAuth app's webhook settings, update `.env`, restart. Deliveries signed with the old secret are rejected with 401 and Linear retries them (1 min, 1 h, 6 h), so do both steps within a minute. |
| `MIRROR_TOKEN` | Create the new read-only deploy token, update `.env`, restart. `Mirror.fetch()` re-sets the remote URL from the token on every fetch, so the next job picks it up; no `mirror init` needed. Confirm with `steward mirror fetch`, then revoke the old token. |
| `GITLAB_TOKEN` / `GITHUB_TOKEN` | Create the new token, update `.env`, restart. Confirm with `steward doctor` (the codehost MCP check). Revoke the old one. |
| `ANTHROPIC_API_KEY` / `CLAUDE_CODE_OAUTH_TOKEN` / `OPENAI_API_KEY` | Update `.env`, restart. A job that is mid-run keeps the old value in its child environment until it finishes. |
| Overlay credentials | Change them in the sandbox checkout and rerun `steward overlay sync --from <checkout>`. The next job copies the new files; running jobs keep the old ones. |

Revoke the old value only after the new one has been seen working (`doctor` for repo and
codehost tokens, a completed job for brain keys).

## 4. Reading `steward jobs show <id>`

```bash
steward jobs                       # newest jobs, one line each
steward jobs --status failed --limit 20
steward jobs show 42
```

`show` prints, in order:

1. **The job row.** `status` is one of `queued`, `running`, `succeeded`, `failed`,
   `publish_failed`, `skipped`. `attempts` counts claims. `trigger` says whether the job
   came from `issue.created`, `agent.session` (with `sessionId` and any `promptBody`) or
   `cli`. `error` is the last failure reason; `interrupted` means the process died mid-run
   and the job was requeued or failed on restart. `resultSha` is the commit the enrichment
   was computed against.
2. **Attempts.** One row per claim: `startedAt`/`finishedAt` (a missing `finishedAt` on
   a non-running job means a crash), `error`, `setupTail` (the last 16 KB of the
   `workspace.setup` commands' output; the first thing to read when a job failed before the
   brain ran), `preWriteDescription` (the ticket description as read just before the
   steward wrote the section; compare with the ticket if the merge looks wrong),
   `transcriptPath` and `usage` (tokens and cost). A `succeeded` job whose attempt has an
   `error` succeeded with a warning: the description was written but the comment or
   session response failed.
3. **Transcript path.** `dataDir/jobs/<id>/attempt-<n>.jsonl`, one redacted JSON line per
   brain message. `tail -f` it while a job is running.
4. **Artifacts listing.** Everything the brain wrote under `dataDir/jobs/<id>/artifacts`,
   whether or not it was accepted for upload.
5. **Stored result.** The validated `BrainResult` (`template`, `summary`, `enrichment`,
   `attachments`, `confidence`). Present when the brain finished; its presence is what
   makes `steward jobs retry <id>` publish-only.

Which failures retry on their own (§5 of the spec): ticket fetch, mirror fetch, worktree,
overlay and setup errors are retried up to 3 attempts. Brain timeout, exhausted turns and
invalid output are terminal (`failed`). Tracker write failures after a result was saved
give `publish_failed`, and `steward jobs retry <id>` resumes at the publish step without
running the brain again. Between automatic attempts the job shows as `queued` with
`notBefore` set to the end of the backoff; a restart during the backoff does not lose the
retry.

```bash
steward jobs retry 42     # requeues for serve when it is running, otherwise runs inline; publish-only when a result is stored
steward jobs gc           # run retention now: worktrees, artifacts, transcripts, deliveries
```

Failed jobs keep their worktree under `dataDir/work/<id>-<attempt>` when
`workspace.keepOnFailure` is true; retention keeps the newest `retention.keptWorktrees`.

## 5. `auth_broken`

`auth_broken` is a flag in `steward.db` that the Linear auth layer sets when a token
refresh fails: the refresh token was revoked, the OAuth app was removed, or the client
secret changed under it. While it is set:

- the worker stops claiming jobs (they queue up);
- `GET /health` returns 503 with `authBroken: true`;
- `steward doctor` reports `[fail]` on the Linear token check;
- the systemd unit stays up, since the process is healthy, so the signal is `/health` and
  `doctor`, not a restart loop.

Clear it by re-authorizing, which stores a fresh token pair and resets the flag:

```bash
sudo -u steward -H bash -lc 'cd /etc/ticket-steward && steward auth linear'
curl -s https://steward.example.com/health     # authBroken: false
```

`serve` does not need a restart; the worker reads the token and the flag from the store
before each request and resumes claiming on its next poll.

## 6. Day-to-day

```bash
journalctl -u ticket-steward --since -1h
curl -s https://steward.example.com/health | jq
steward doctor
steward jobs --status publish_failed
steward templates                 # the templates the brain sees, for allowlisted teams
steward prompt show               # current prompt template
steward prompt render KEY-123     # the exact prompt a job for KEY-123 would get
```

Stopping: `systemctl stop ticket-steward` sends SIGTERM. The worker stops claiming,
aborts the running brain, kills its process group, marks the attempt `interrupted`,
leaves the job `queued` (or `failed` with error `interrupted` when that was its last
attempt), releases `run.lock` and exits 0 within `TimeoutStopSec=120`. A job left `running`
by a crash is requeued the same way on the next start.
