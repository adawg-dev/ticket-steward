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
`~/.local/bin` is not on PATH under systemd), then Chromium for the steward user.
Every `sudo -u steward` command below starts with `cd` because the steward user cannot
read your own home directory:

```bash
sudo npm i -g pnpm            # or: sudo corepack enable
sudo -u steward -H bash -lc 'cd ~ && npx --yes playwright@latest install chromium'
```

Install the steward CLI so `steward` is on PATH for every user (pick one):

```bash
# a) from the npm registry (only once the package is published)
sudo npm i -g ticket-steward

# b) from a checkout (works today; use -b <branch> to pin a branch)
sudo git clone <ticket-steward repo> /opt/ticket-steward
cd /opt/ticket-steward && sudo pnpm install --frozen-lockfile && sudo pnpm build
sudo ln -s /opt/ticket-steward/bin/steward.js /usr/local/bin/steward

# later updates
cd /opt/ticket-steward && sudo git pull && sudo pnpm install --frozen-lockfile && sudo pnpm build
```

Brain credential: either put an `ANTHROPIC_API_KEY` in `.env`, or mint a Claude Code
token as the steward user and put that in `.env` instead:

```bash
sudo -u steward -H bash -lc 'cd ~ && claude setup-token'   # prints CLAUDE_CODE_OAUTH_TOKEN
```

Or route the claude-code brain through an Anthropic-compatible gateway such as your own
Concentrate AI deployment: set `ANTHROPIC_BASE_URL=https://api.concentrate.ai` and
`ANTHROPIC_AUTH_TOKEN=<sk-cn key>`. For the openai-agents brain the equivalent is
`OPENAI_BASE_URL=https://api.concentrate.ai/v1` and `OPENAI_API_KEY=<sk-cn key>`.

Set `brain.reasoningEffort` (`none` … `max`) for openai-agents. Without it the Agents SDK
picks a per-model default, which is `none` for `gpt-5.5` and unset for newer models such as
`gpt-6-luna`, so the brain runs with no reasoning and tends to skip the reproduction.

Precedence for claude-code: `ANTHROPIC_API_KEY`, then `ANTHROPIC_AUTH_TOKEN`, then
`CLAUDE_CODE_OAUTH_TOKEN`. The steward never relies on an interactive login in `~/.claude`.

### 1.3 Repo tokens

Two separate tokens, deliberately:

- **`MIRROR_TOKEN`** — a **read-only** GitLab deploy token (scope `read_repository`) or a
  GitHub fine-grained token with `contents: read`. It is injected into
  `workspace.fetchUrl` when the mirror is created or fetched. A GitLab deploy token only
  authenticates with its own username, so set `MIRROR_USERNAME` to the username shown when
  the token was created (access tokens need no username). It is the only credential
  that can touch the repository, and it cannot push.
- **`GITLAB_TOKEN`** / **`GITHUB_TOKEN`** — `read_api` (GitLab) or `pull_requests: read`
  (GitHub). Used by the codehost MCP server to map commits to MRs/PRs. It reaches that
  server's environment only, never the brain process.

### 1.4 Operator directory

```bash
sudo -u steward -H bash -lc 'cd /etc/ticket-steward && steward init'
```

`init` writes `steward.config.ts`, `.env.example`, `prompts/implement.md`, `prompts/fix.md` and `skills/` and
refuses to overwrite existing files. Replace the generated config with the kickoff
example and fill in the secrets:

```bash
# run from your checkout; the steward user cannot read your home directory
sudo cp examples/kickoff/steward.config.ts /etc/ticket-steward/steward.config.ts
sudo cp -r examples/kickoff/skills/. /etc/ticket-steward/skills/
sudo cp examples/kickoff/.env.example /etc/ticket-steward/.env
sudo chown -R steward:steward /etc/ticket-steward
sudo chmod 0600 /etc/ticket-steward/.env
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
0600, with `localhost:3000` / `127.0.0.1:3000` rewritten to the job's port (`workspace.port`, or the
slot's app port with `slots`) when `workspace.portRewrite` is set. With `slots`, `slots.env` then
overrides keys in the job's copy (§1.10).

### 1.6 Public URL

Linear must reach `server.port` at `server.publicUrl` for webhooks. Two working options:

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
steward itself listens on plain HTTP on `127.0.0.1:3020`. Only `/health` and
`/webhooks/linear` exist, and the webhook is verified, so exposing the port is acceptable.

### 1.7 Linear API key and webhook

The steward authenticates to Linear with a personal API key. Every description edit,
comment and upload appears as the user who owns the key, so give it a user of its own.

1. Create a dedicated Linear user for the steward (for example "Ticket Steward",
   `steward@example.com`) and add it to every allowlisted team (`tracker.teams`).
2. Signed in as that user, open Settings → Account → Security & access → Personal API
   keys and create a key named "ticket-steward". Grant **Read**, **Write**, **Create
   comments** and **File uploads** (nothing else), and restrict it to the allowlisted
   teams.
3. Put it in `.env` as `LINEAR_API_KEY`. The steward sends it as a raw
   `Authorization: <key>` header, not as a Bearer token.
4. As a workspace admin, open Settings → API → Webhooks and create a webhook with the URL
   `https://steward.example.com/webhooks/linear` (`<server.publicUrl>/webhooks/linear`).
   Select only the **Issues** data-change event, and scope it to the allowlisted teams or
   to all public teams. The steward acts only on a ticket created with, or first given, the
   `ready-for-agent` label (§1.7a): a ticket created without it is skipped ("no implement
   label") and every other delivery is ignored.
5. Copy the webhook's signing secret into `.env` as `LINEAR_WEBHOOK_SECRET`.

There is no authorization step: the key is read from `.env` when the process starts.
`steward doctor` (next section) confirms it works and names the user it authenticates as.

**ticket-gateway.** ticket-gateway issues arrive through the same Issues webhook and are
treated like any other ticket: nothing happens until a person adds `ready-for-agent`.

**Enrich was removed on 2026-10-28.** The steward no longer triages tickets or writes an
Enrichment section; `ready-for-agent` covers it, and implement still reads the agent brief of
tickets enriched before then. The steward no longer rewrites descriptions or uploads files;
its Linear writes are labels plus the implement and fix-loop comments, which move to the MR
next, leaving Linear labels-only. A config still carrying the enrich keys
fails to load with "`<key>` was removed with enrich": delete top-level `prompt`,
`tracker.gatewayIssues`, `tracker.bugLabels` and `tracker.labels.triage`, and the
`prompts/enrich.md` file. `implement` (with `tracker.labels` and `GITLAB_PUSH_TOKEN`) is
now required. Enrich jobs left queued or running in the database are failed with "enrich was
removed; this job will not run" when the worker starts; finished ones stay in `steward jobs`
as history. The `needs-triage` label is no longer read and can be deleted in Linear.

### 1.7a Label workflows

`tracker.labels` (use `labels: {}` for the default names) is required. The steward acts only on
a ticket created with, or first given, the `ready-for-agent` label; the decision **whether an
agent implements a ticket** stays with people. The steward never applies that label, never
opens a merge request, and its git work stops at pushing one new branch; the kickoff pipeline
opens the MR.

Create four labels in Linear at the workspace level, plus `agent-approved` with a `greptile`
block (names match case-insensitively; override any of them under `tracker.labels`:
`implement`, `needsInfo`, `readyForHuman`, `implemented`, `approved`). Putting them in one
Linear label group is fine and keeps a ticket on one stage at a time: the steward swaps a label
in a single update, and a retried publish does not post its comment twice):

| Label | Applied by | Meaning |
| --- | --- | --- |
| `ready-for-agent` | person | Implement this ticket. |
| `needs-info` | steward | Something only a person can supply is missing; the questions are in a comment. |
| `ready-for-human` | steward | An agent tried and handed back. |
| `agent-implemented` | steward | An agent pushed a branch for this ticket. |

```
ready-for-agent ──implement job──▶ agent-implemented  (branch pushed)
                                   ├──▶ ready-for-human  (tried, failed; nothing pushed)
                                   └──▶ needs-info       (too vague; nothing changed)
```

A label counts only when it is first added (or present when the ticket is created); removing
and re-adding it does not re-run a ticket with an implement job that pushed a branch (a
hand-back does not count, so adding `ready-for-agent` again after fixing the ticket re-runs
it). Labels change last in every publish, so a failure earlier leaves the trigger label on the
ticket and the job `publish_failed` (`steward jobs retry <id>` re-publishes without re-running
the brain or pushing again). `steward implement KEY` never swaps labels.

**Push token.** Implementation needs `GITLAB_PUSH_TOKEN` in `.env`: a GitLab **project access
token** with the **Developer** role and only the **`write_repository`** scope. Never give it
`api`: `api` plus Developer can also merge into unprotected branches, approve and create MRs,
delete branches and run pipelines. The token is used only for `ls-remote` and `push`, passed
to each git process as an HTTP header; it is never written to git config, never in the brain's
environment and redacted from all output. `MIRROR_TOKEN` stays read-only.

**Branch protection.** Keep `main`, `staging` and `dev` protected in GitLab with named-user
push and merge allowlists, and never add the token's bot user (`project_<id>_bot_…`) or the
Developer role to them. GitLab then rejects any push or merge to those branches whatever the
steward does. GitLab cannot enforce "only branches cut from dev"; the steward's own pre-push
checks do. The list doctor expects to be protected is `implement.protectedBranches`
(default `["main", "staging", "dev"]`).

**`implement` config.** Absent means `ready-for-agent` is ignored: the webhook parser does not
treat it as a trigger, so nothing is logged or queued (intake's "implement is not configured"
skip remains only as a backstop). It requires `tracker.labels` and `GITLAB_PUSH_TOKEN`; config
load fails otherwise.

```ts
implement: {
  prompt: "./prompts/implement.md",   // `steward init` writes it; otherwise copy <ticket-steward>/prompts/implement.md
  checks: ["pnpm turbo check-types lint --filter='...[{{baseSha}}]'"], // default []; run by the steward after the brain
  commitAuthor: { name: "Ticket Steward", email: "steward@concentrate.ai" },
  // defaults:
  // branchTypes: ["feature", "fix", "chore", "refactor"],
  // checksTimeoutMinutes: 20,
  // timeoutMinutes: 60,              // brain timeout for implement jobs
  // maxTurns: 150,                   // brain turns for implement jobs
  // protectedBranches: ["main", "staging", "dev"],
}
```

**What an implement job does.** Fresh worktree at the latest `dev`, as for every job; the
agent edits files only. The steward then, stopping at the first failure: requires a non-empty
diff; stages everything except the files the steward copied in (overlay files and its own
`.claude/skills/` copies, left out whether or not the repo gitignores them; the repo's own
tracked skills can still be edited), and refuses if a staged diff (read as text, binary and `-diff` files included) adds a line containing
the value of a secret-looking overlay variable or one of the steward's own secrets (hand-back
"the change contains a secret value"; the comment names paths, never values); runs
`implement.checks` (`{{baseSha}}` is the job's base commit); commits as `commitAuthor` with
kickoff's Husky hooks enabled for that one commit; re-checks what was committed (the hooks can
change it): a single commit on the base, the same path and secret guard over its diff, and no
secret value in the commit message (hand-back "the commit message contains a secret value",
detail "commit message"); keeps a copy of the commit as a bundle file in the job dir (not a
ref, which the mirror's `--prune` fetch would delete); and pushes
branch `<type>/<IDENTIFIER>-<slug>` (type chosen by the agent from `branchTypes`).
Before pushing it refuses unless the target matches the branch pattern, no remote branch
already carries the ticket (any type), and the commit has exactly one parent, the base `dev`
commit. Every push runs from a fresh scratch bare repo in the job dir with hooks disabled, as
a create-only push (`--force-with-lease=<ref>:`), so it can never update or force an existing
branch. Each token-carrying `ls-remote` runs from a steward-made directory or scratch repo
(the pre-push one in that scratch bare repo), never the mirror or worktree.

**The secret scan is best-effort.** It catches accidental leaks: a plain-text overlay or
steward secret in an added line or the commit message. A diff it cannot read or that is too
large (64 MB per file) is handed back rather than passed. It does not stop an agent that sets
out to leak: an encoded value (UTF-16, base64, split strings) gets past it. The real controls
are the overlay-file guard, a `write_repository`-only push token and human review of the MR.

**Hand-backs are successes.** An empty diff, a guard hit, failing checks or hooks, an
existing branch, or the agent reporting `failed` or `needs_info` end the job `succeeded` with
the warning `handed back: <reason>` (see it in `steward jobs show`). The ticket gets a comment
and `ready-for-human` or `needs-info`; they are the answer, not an error. Only a push or
Linear write failure is `publish_failed`.

**`steward implement KEY [--dry-run]`.** Enqueues when `serve` is running, otherwise runs
inline under `run.lock`. It never swaps labels and re-runs even after a prior success; the
existing-branch check still prevents a second push. `--dry-run` runs up to and including the
checks, prints the diff stat and the would-be commit message, and never commits, pushes or
writes to Linear.

One implement job can hold the worker for about 90 minutes (setup, up to 60 of brain,
checks); other heavy jobs queue behind it unless `slots` gives the worker more lanes.

To smoke-test, label a throwaway ticket `ready-for-agent` and watch for the pushed branch,
the comment and the swap to `agent-implemented`. The first real push is also what proves the
token's Developer access: doctor's `push token` line only runs `ls-remote`.

Whatever the trigger, the steward never works on a Done or Canceled ticket. The state is
checked at intake, when a job starts, after the agent finishes and before every Linear write
or push; a closed ticket fails the job without retry. This applies to `steward implement` too.

### 1.7b Greptile fix loop (optional)

With a `greptile` block the steward does not stop at the push. It waits for the pipeline to open the merge request, waits for
Greptile's review, resumes the implementing brain session to fix or decline each finding, pushes one commit per round and
repeats until the review passes or it hands the ticket back. It needs `implement`, `codehost.kind: "gitlab"` and
`brain.kind: "claude-code"`.

```ts
greptile: {
  botUsername: "greptile-apple",          // the username Greptile comments as on the MR (required)
  prompt: "./prompts/fix.md",             // required; `steward init` writes prompts/fix.md
  maxRounds: 5,                           // fix rounds after the implement push (round 0)
  pollSeconds: 300,                       // fallback poll; GitLab webhooks wake the loop at once
  mrTimeoutMinutes: 30,                   // wait for the pipeline to open the MR
  reviewTimeoutMinutes: 30,               // wait for Greptile to review the head
  pipelineTimeoutMinutes: 30,             // wait for the head pipeline to finish
  ciLogLines: 200,                        // failed-job log lines given to the brain
  mcp: { url: "https://api.greptile.com/mcp" },
},
tracker: { labels: { approved: "agent-approved" } },   // applied when the loop passes
```

Waits are counted from the first poll of the wait, not from the push. Per round there are up to 30 minutes for the MR
to open, then 30 minutes for Greptile's review and the pipeline together (they run in parallel and share one clock);
every fix round starts its waits over. The last poll of a wait is moved up to its deadline, so a wait that runs out
hands back right then, not one poll interval later. On kickoff MR pipelines take 7.3 minutes at the median (14.4 at most) and Greptile's
first review 3.2 (12.3 at most).

**Webhooks.** GitLab webhooks are the loop's primary wake signal; polling every `pollSeconds` (5 minutes) is only the
fallback. In kickoff, Settings → Webhooks, add `<server.publicUrl>/webhooks/gitlab` with these triggers:

- Merge request events (the MR opens or changes)
- Comments (Greptile posts, and on a re-review edits, its summary note)
- Pipeline events (the head pipeline finishes)

Put the hook's signing token (`whsec_...`, GitLab 19.1+) in `GITLAB_WEBHOOK_SIGNING_TOKEN` in `.env`; a plain secret token
(`X-Gitlab-Token`) in `GITLAB_WEBHOOK_SECRET` also works. An event for the branch or MR of a loop in `awaiting_mr` or
`awaiting_review` moves that loop's queued poll to now, or, when the poll is running at that moment, makes its next
poll run at once; nothing else is queued, and every validly signed event is answered
200 (`ignored`, `woken` or `no_loop`) so GitLab never disables the hook. A bad signature is a 401 and a
`gitlab webhook rejected` warning in the log. Without either secret `steward doctor` warns that the loop falls back to
5-minute polling.

**Passing.** For the MR's current head SHA: Greptile's summary says `Confidence Score: 5/5`, no Greptile discussion is
unresolved, and the head pipeline is `success`. 4/5 never passes. A pass applies the `approved` label
(`agent-approved`) and comments on the ticket; people still merge.

**Token.** `GITLAB_TOKEN` needs the `api` scope (not just `read_api`): the loop reads the MR and pipelines, replies to
Greptile's threads and resolves them. `steward doctor` checks the scope, that `botUsername` exists, that the `approved`
label exists in Linear and that the prompt file exists.

**Kickoff side.**

- `.greptile/config.json` must have `"autoReview": ["open", "push"]` so every push is reviewed.
- `excludeAuthors` must not match the steward's GitLab user, or Greptile never reviews its pushes.
- CI's `open:dev-mr` must open non-draft MRs; Greptile skips drafts.

**States.** `awaiting_mr` (waiting for the pipeline to open the MR), `awaiting_review` (waiting for Greptile and the
pipeline), `fixing` (a fix job is running), then an end state: `passed`, `handed_back` or `stopped` (the ticket was closed
or the MR was merged or closed; the steward says so and leaves labels alone).

**Hand-back reasons.** The ticket becomes `ready-for-human` with the reason in a comment, and the MR gets a note. Reasons:
no MR was opened; a person pushed to the branch; Greptile failed or never reviewed the head; no finished pipeline, or it
failed or was canceled; the fix could not be verified (checks, secret guard, no single commit); or the score is still
below 5/5 after `maxRounds` fix rounds. The brain can also hand back itself when it cannot fix a finding. A round with no
push hands back when Greptile's summary has no `Reviews (N)` counter, since its next review could not be told apart. A
loop whose await, fix or hand-back job fails for good (out of attempts, or a crash) is handed back with that job's error
within a few minutes, so it never sits in a running state with nothing to move it. Retryable errors only add up while
they come in a row: each poll that finds the loop still waiting starts the count over.

**Restart.** Re-add `ready-for-agent` to the ticket, or run `steward fix <KEY>` (leaves labels alone). Comments newer than
the hand-back are given to the restarted loop. `steward jobs show <id>` prints the loop and one line per round
(`round 1: 3/5 ...`) for the loop's jobs and for the implement job.

**Sessions.** The brain's sessions live in `dataDir/sessions` (`CLAUDE_CONFIG_DIR`), one per ticket, and the loop's worktree
is the stable `ticket-<KEY>`. Both are kept for active loops and for `retention.days` after a loop ends; `steward jobs gc`
and the hourly sweep then remove them. The brain never receives GitLab, Linear or Greptile credentials.

### 1.8 Doctor, then start the service

```bash
sudo -u steward -H bash -lc 'cd /etc/ticket-steward && steward doctor'
```

Every line is `[ok]`, `[warn]` or `[fail]`; the exit code is 1 if anything failed. Fix
every `[fail]` before installing the unit. Checks: config parses; `.env` holds the brain,
webhook and codehost secrets; the running user does not own `~/.ssh` or `~/.kube`;
`dataDir` and `overlayDir` are 0700; the mirror exists, has `extensions.worktreeConfig`
and fetches; the overlay has at least one file; the skills dir exists; `LINEAR_API_KEY` is set
and answers a `viewer { id name }` query (the line names the user every write will appear
as); `publicUrl/health` answers; the
codehost MCP server starts and answers `tools/list`; with `tracker.labels`
set, all five labels exist in Linear; with `implement` configured, `GITLAB_PUSH_TOKEN` can `ls-remote` the repo (a read, so it
cannot prove Developer access; the first real push does) and, for GitLab, `implement.protectedBranches` are protected with
no Developer-role or project-bot push or merge grant (read with `GITLAB_TOKEN`); Playwright's Chromium is installed;
`workspace.port` is free, or, with `slots` (§1.10): `/usr/local/sbin/steward-slot` is root-owned and not
group- or world-writable, `slots.socket` exists, is a socket and answers `check`, every slot's app and
service ports are free (a slot left up is named), and every `slots.env` key is defined in the overlay.

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

1. Create a throwaway ticket in an allowlisted team without any label. `steward jobs`
   shows no job for it, and the journal logs the delivery as `skip` ("no implement label").
2. Add `ready-for-agent`. Within the job's run time a branch is pushed and the label swaps
   to `agent-implemented` (or the ticket is handed back), as in §1.7a.
3. `steward jobs` lists the implement job as `succeeded`.

For a ticket outside Linear's webhook path:

```bash
steward implement KEY-123 --dry-run    # runs up to the checks and prints the would-be commit; takes run.lock (refused while serve runs)
steward implement KEY-123              # enqueues if serve is running, otherwise runs inline under run.lock
```

### 1.10 Worker slots (optional)

Without `slots`, the worker runs one job at a time on `workspace.port`, against whatever the overlay's
env files point at. With `slots`, it runs `slots.count` jobs at once (1–20). Each job gets a **slot**: an
app port (`slots.appPortBase + n`) and three containers created fresh for that job and removed when it
ends: Postgres 17 with TimescaleDB (databases `concentrate` and `concentrate_tg`), Redis and RabbitMQ.
`slots.env` rewrites the job's copy of the overlay so every service the job starts talks to its slot,
never to Timescale Cloud, the dev Redis cluster, the dev RabbitMQ or a remote Postgres. Two jobs for the
same ticket (or the same merge request) never run at once.

**Why a socket-activated root helper.** The agent runs as `steward`, and Docker access is root access, so
`steward` stays out of the `docker` group, and the steward unit keeps `NoNewPrivileges=yes` (no sudo, no
setuid). Instead systemd listens on `/run/steward-slot.sock` (owner root, group `steward`, mode 0660) and,
for each connection, starts one `steward-slot@.service` instance that runs
`/usr/local/sbin/steward-slot --socket` as root. The helper reads one request line, `<command> <n>` (`up|down|status|ports
<n>`, or `check`; `n` 1–9, at most 64 bytes), runs it, and replies with the command's output followed by a last line `exit <code>`,
and refuses anything else with `exit 2`. The brain's policy also denies `sudo` and `docker`. The accepted
risk: the agent runs as `steward`, so it can connect to the socket and `down` another slot; that slot's
job then fails and is retried.

**Install** (as root, from a checkout of this repo):

```bash
install -o root -g root -m 0755 ops/steward-slot /usr/local/sbin/steward-slot
install -d -o root -g root -m 0755 /etc/ticket-steward/slots /etc/ticket-steward/slots/init /etc/ticket-steward/slots/docker
install -o root -g root -m 0644 ops/slots-compose.yml /etc/ticket-steward/slots/compose.yml
install -o root -g root -m 0644 ops/slots-init/01-databases.sql /etc/ticket-steward/slots/init/01-databases.sql
install -o root -g root -m 0644 ops/steward-slot.socket ops/steward-slot@.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now steward-slot.socket
docker pull timescale/timescaledb-ha:pg17-ts2.27-all
docker pull redis:7-alpine
docker pull rabbitmq:4.2.0-management
# one request over the helper socket; prints everything until the helper closes (no extra package needed)
slot-req() { node -e 'const s=require("net").connect("/run/steward-slot.sock",()=>s.write(process.argv[1]+"\n"));s.pipe(process.stdout);s.on("error",e=>{console.error(e.message);process.exit(1)})' "$1"; }
sudo -u steward bash -c "$(declare -f slot-req); slot-req check"   # prints ok, then exit 0
```

**Config.** Add `slots` and remove `workspace.port` (config load rejects it next to `slots`). Keep
`workspace.portRewrite`: it now rewrites `localhost:<from>` to the slot's app port, a substring rewrite
that keeps the other origins of a `CORS_ORIGIN` list.

```ts
slots: {
  count: 2,
  appPortBase: 4100,           // slot n's app port is 4100 + n
  // socket: "/run/steward-slot.sock", upTimeoutSeconds: 180, max 290 (defaults)
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
```

Each `env` key is replaced in every copied overlay file that defines it (a `KEY=value` line, optionally
`export `-prefixed); `null` removes the line; keys are never added, and a key no overlay file defines
fails the job (not retried) and doctor, by name. Templates: `{{app}}`, `{{postgres}}`, `{{redis}}`,
`{{rabbitmq}}`; any other `{{name}}` fails config load. The overlay directory itself never changes, so
the redactor and the implement secret guard still know the remote credentials the overrides replaced.
Host ports come from the helper's `ports <n>`: Postgres `15032 + 100n`, Redis `16079 + 100n`, RabbitMQ
`17072 + 100n` (clear of a local RabbitMQ management UI on 15672), all on 127.0.0.1. The slot credentials are throwaway, not secrets.

Per job: free the app port, `down` then `up` the slot (abandoned after `upTimeoutSeconds`, at most 290; the helper
instance itself is capped at 300 s), create the worktree, copy the overlay with the overrides, run
`workspace.setup` (`reset-dbs.sh` reads `e2e/user/.env`, which now holds the slot's values), run the
brain with `STEWARD_PORT` set to the slot's app port, publish, and `down` the slot. A slot that does not
come up fails the job as retryable with `setup failed: slot <n>: …` and the helper's output tail in the
attempt's `setupTail`. `steward serve` brings every slot down when it starts and when it stops;
retention sweeps only while no job runs, so under sustained load on every slot the hourly sweep waits for a moment when all slots are idle. `steward implement KEY` without serve runs on slot 1.

**Resource guard.** On by default, with or without `slots`. Before a lane claims a heavy job (implement,
fix, restart) the worker checks the host: available memory (`MemAvailable`) must be at least
`minAvailableMemoryMb` and the 1-minute load average per CPU at most `maxLoadPerCpu`, and the last heavy
start must be at least `startSpacingSeconds` ago (the load average lags about a minute, so a burst of
tickets would otherwise all start before it rises). While it holds, the job stays queued and the lane only
claims `await_review` jobs, which poll APIs and use no host resources, so a fix loop's waits keep their
deadlines. The log says `heavy job starts held` with the reason when a shortage starts holding and
`heavy job starts resumed` when it ends; spacing holds are not logged. With the guard, `slots.count` is a
ceiling rather than a promise: set it to what the host could run on a good day and let the guard trim it.

```ts
// defaults; omit the block to keep them, or { enabled: false } to turn the guard off
resourceGuard: { minAvailableMemoryMb: 4096, maxLoadPerCpu: 1.5, startSpacingSeconds: 30 },
```

**Troubleshooting.**

- `steward-slot status <n>` (as root) lists a slot's containers; `steward-slot down <n>` removes them.
- `cannot reach the slot helper at /run/steward-slot.sock: connect ENOENT`: the socket unit is not running;
  `systemctl enable --now steward-slot.socket`. `EACCES`: the steward user is not in group `steward`, or
  `SocketGroup`/`SocketMode` were changed.
- `helper closed without an exit status`: the helper instance died; `journalctl -u 'steward-slot@*'`.
- Doctor reports `slot <n> is up` while serve is stopped: a crashed run left it; `steward-slot down <n>`.
- A port in use that is not a slot: `ss -ltnp 'sport = :<port>'` names the holder; move `appPortBase` or stop it.
- `steward jobs` prints `# running: slot 1 job 12, …` while serve runs; `/health` has the same list under `worker.running`.

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
and its one brain credential. The Linear API key, webhook secret, mirror token and
codehost token never enter that environment.

## 3. Rotating credentials

All secrets live in `/etc/ticket-steward/.env` and are read at process start. After
editing `.env`, restart:

```bash
sudo systemctl restart ticket-steward
```

| Credential | How to rotate |
| --- | --- |
| `LINEAR_API_KEY` | Signed in as the steward's Linear user, create a new personal API key with the same permissions and team restriction (§1.7), update `.env`, restart. Confirm with `steward doctor` (the `linear api key` line), then revoke the old key. A revoked or invalid key pauses the worker (§5). |
| `LINEAR_WEBHOOK_SECRET` | Regenerate in the webhook's settings (Settings → API → Webhooks), update `.env`, restart. Deliveries signed with the old secret are rejected with 401 and Linear retries them (1 min, 1 h, 6 h), so do both steps within a minute. |
| `MIRROR_TOKEN` | Create the new read-only deploy token, update `.env`, restart. `Mirror.fetch()` re-sets the remote URL from the token on every fetch, so the next job picks it up; no `mirror init` needed. Confirm with `steward mirror fetch`, then revoke the old token. |
| `GITLAB_PUSH_TOKEN` | Create a new token, update `.env`, restart; `steward doctor` confirms it reaches the repo; revoke the old one. |
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
   came from `issue.created`, `issue.labeled`, `cli` or a fix loop. `error` is the last failure reason; `interrupted` means the process died mid-run
   and the job was requeued or failed on restart. `implementResult` (implement jobs) and
   `fixResult` (fix jobs) hold the validated result or hand-back; a stored implement result
   makes `steward jobs retry <id>` publish-only. Jobs of kind `enrich` are history from
   before 2026-10-28 and never run again.
2. **Attempts.** One row per claim: `startedAt`/`finishedAt` (a missing `finishedAt` on
   a non-running job means a crash), `error`, `setupTail` (the last 16 KB of the
   `workspace.setup` commands' output; the first thing to read when a job failed before the
   brain ran), `preWriteDescription` (only on old enrich attempts),
   `transcriptPath` and `usage` (tokens and cost). A `succeeded` job whose attempt has an
   `error` succeeded with a warning, for example a hand-back or a failed comment.
3. **Transcript path.** `dataDir/jobs/<id>/attempt-<n>.jsonl`, one redacted JSON line per
   brain message. `tail -f` it while a job is running.
4. **Artifacts listing.** Everything the brain wrote under `dataDir/jobs/<id>/artifacts`.
5. **Loop.** For `await_review`, `fix` and `restart` jobs, and for an implement job that
   started a fix loop (§1.7b): the loop's state and one line per round, such as
   `round 1: 3/5 head abc1234 pipeline success fixed 2 declined 1 changed`.

Which failures retry on their own (§5 of the spec): ticket fetch, mirror fetch, worktree,
overlay and setup errors are retried up to 3 attempts. Brain timeout, exhausted turns and
invalid output are terminal (`failed`). Tracker write failures after a result was saved
give `publish_failed`, and `steward jobs retry <id>` resumes at the publish step without
running the brain again. Between automatic attempts the job shows as `queued` with
`notBefore` set to the end of the backoff; a restart during the backoff does not lose the
retry.

```bash
steward jobs retry 42     # requeues for serve when it is running, otherwise runs inline; publish-only when an implement result is stored
steward jobs gc           # run retention now: worktrees, artifacts, transcripts, deliveries
```

Failed jobs keep their worktree under `dataDir/work/<id>-<attempt>` when
`workspace.keepOnFailure` is true; retention keeps the newest `retention.keptWorktrees`.

## 5. Linear API key rejected

When Linear answers 401 (or an authentication error) to any call, the `LINEAR_API_KEY`
is invalid or was revoked. The steward does not retry the call: the error reads "Linear
rejected LINEAR_API_KEY (401): the key is invalid or revoked", and the first occurrence is
logged at `error` level ("Linear API key rejected; the worker stops claiming jobs until the
steward restarts"). From then on, until the process restarts:

- the worker stops claiming jobs; the job that hit the 401 goes back to the queue with
  the attempt refunded (so it is never failed for the key), and new webhook deliveries
  keep queueing;
- `GET /health` returns 503 with `apiKeyRejected: true`;
- `steward doctor` reports `[fail]` on the `linear api key` line;
- the systemd unit stays up, since the process is healthy, so the signal is `/health`,
  the journal and `doctor`, not a restart loop.

To recover, create a new key (§1.7, §3), put it in `.env` and restart:

```bash
sudo -u steward -H bash -lc 'cd /etc/ticket-steward && steward doctor'
sudo systemctl restart ticket-steward
curl -s https://steward.example.com/health     # apiKeyRejected: false
```

The queued jobs are picked up after the restart.

## 6. Day-to-day

```bash
journalctl -u ticket-steward --since -1h
curl -s https://steward.example.com/health | jq
steward doctor
steward jobs --status publish_failed
steward templates                 # the Linear issue templates, for allowlisted teams
```

Stopping: `systemctl stop ticket-steward` sends SIGTERM. The worker stops claiming,
aborts the running brain, kills its process group, marks the attempt `interrupted`,
leaves the job `queued` (or `failed` with error `interrupted` when that was its last
attempt), releases `run.lock` and exits 0 within `TimeoutStopSec=120`. A job left `running`
by a crash is requeued the same way on the next start.
