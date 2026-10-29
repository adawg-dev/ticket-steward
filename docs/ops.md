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
`/webhooks/linear` exist, and the webhook is verified, so exposing the port is acceptable. A Linear
delivery whose signed `webhookTimestamp` is more than a minute off is rejected (keep the host's clock
synced), and each one is acted on once by ids in its signed body, so a replayed body does nothing.

### 1.7 Linear app and webhooks

The steward is a Linear **app**: a workspace admin installs it once, it gets its own seat (it shows up as an agent people
can assign and @mention), and it never acts as a person. It authenticates with the OAuth client-credentials grant: the
dispatcher mints an access token from the app's client id and secret, holds it in memory only, re-mints it daily and
after a 401, and revokes it on shutdown. No refresh token or other long-lived Linear secret is stored anywhere, and no
CLI command, brain or run pod ever holds the token. `LINEAR_API_KEY` and the label trigger (`tracker.labels`) are gone.

1. **Create the OAuth app.** As a workspace admin, Settings → API → OAuth applications → New. Name it (for example
   "Ticket Steward"; this is the name people assign), give it an icon, and set any callback URL (the
   client-credentials grant never redirects; `<server.publicUrl>/health` will do).
2. **Webhooks.** In the app, enable webhooks with the URL `<server.publicUrl>/webhooks/linear` and select **Agent
   session events**, **Permission changes** and **Issues** (the steward uses Issues to see itself removed as a
   ticket's delegate). Copy the signing secret: it is `LINEAR_WEBHOOK_SECRET`.
3. **Client credentials.** In the app, enable **Client credentials** tokens. Copy the client id and secret: they are
   `LINEAR_CLIENT_ID` and `LINEAR_CLIENT_SECRET` in `.env`, or, on AWS, the Secrets Manager entries
   `DEV_STEWARD_LINEAR_CLIENT_ID` and `DEV_STEWARD_LINEAR_CLIENT_SECRET` (§1.13), read like every other `DEV_*` value.
4. **Install it for the workspace.** Still as an admin, open the app's authorization URL with `actor=app` and the
   steward's scopes, and approve it for the whole workspace:

   ```
   https://linear.app/oauth/authorize?client_id=<client id>&redirect_uri=<callback URL>&response_type=code&scope=read,write,app:assignable,app:mentionable&actor=app
   ```

   The steward mints its tokens with the same scopes (`read,write,app:assignable,app:mentionable`): `app:assignable`
   lets people delegate tickets to it and `app:mentionable` lets them @mention it.
5. **Allowlisted teams.** The app sees the whole workspace, but the steward acts only on tickets of `tracker.teams`
   (an empty list means every team); anything else is ignored.
6. **Brain.** The Linear app needs `brain.kind: "claude-code"` (steering and stop need its streaming input); config
   load fails otherwise.

**Verify the install** before relying on it. Run `steward doctor`: the `linear app` line mints a token, reads
`viewer { id name }` with it and revokes it again (`[ok] linear app: authenticated as Ticket Steward (app user <id>)`).
Then delegate a throwaway ticket of an allowlisted team to the steward: within 10 seconds its agent panel shows "Picked
this up; reading the ticket", and the run's progress follows. That proves a client-credentials token can post activities in the app's
sessions. If doctor passes but the panel stays empty and the log shows Linear refusing `agentActivityCreate`, the
client-credentials token cannot act for the app's seat. The only acceptable fallback is then the authorization-code
flow with `actor=app`, its rotating refresh token kept in Secrets Manager (the dispatcher's AWS role gains
`secretsmanager:PutSecretValue` on that one secret; see `deploy/aws/steward-role.tf.example`). It is not built yet:
stop there and raise it.

**What starts work.**

- Delegating a ticket to the steward (assigning it in Linear's agent field) starts an implement run, unless the
  ticket already has a loop, which is resumed instead (§1.7b). With `linear.moveToStarted` on (the default) the ticket
  moves to its team's first started state if it is not there or later; when the MR opens it moves to
  `linear.reviewStateName` ("In Review").
- An @mention on a ticket the steward has worked on answers in a chat run that resumes its session; on a ticket it
  never had, the answer is "Assign me to the ticket to start work."
- A prompt in the agent panel steers the active run (the run gets it between turns), or resumes the session in a chat
  when nothing runs. Stop ends the run with outcome `stopped`, which is not retried; the next prompt resumes it.
- Removing the steward as delegate stops the run and parks its loop (§1.7b, "Unassign, revive, reassign").

**What the panel shows.** The run's thinking as thoughts, its tool calls as actions (edits and commands with their
result), its plan, its questions (as an elicitation you answer in the panel), and a final response with the summary,
checks and media; fix rounds and MR replies go into the ticket's current session. Everything posted passes the run
redactor and placeholder and guard-value stripping; no raw command output or file contents reach Linear, which the
whole workspace can read. Posting is rate limited per session (`linear.activityIntervalMs`, 2 s): when it falls
behind, transient actions are dropped first and the final response never is.

**Settings.** Behaviour that may change while the steward runs lives in the dispatcher's DB, seeded from the config:
`steward settings get [key]`, `steward settings set <key> <value>` (through serve's admin API; every change is
audited). The Linear ones are `linear.reviewStateName`, `linear.moveToStarted`, `linear.reviveByMention` and
`linear.activityIntervalMs`.

**Moving from the label trigger.** A config that still has `tracker.labels` fails to load with "tracker.labels:
assign the steward in Linear instead (docs/ops.md)" (doctor's `config` line says the same): delete the key, set the
two client secrets, install the app and replace the old Issues-only workspace webhook with the app's (delete the old
one; its secret is no longer used). Loops started by labels keep running; their label changes are no-ops. The old
labels (`ready-for-agent`, `needs-info`, `ready-for-human`, `agent-implemented`, `agent-approved`) are no longer read or
written and can be deleted. Revoke the old personal API key once the app works.

**Enrich was removed on 2026-10-28.** The steward no longer triages tickets or writes an Enrichment section; implement
still reads the agent brief of tickets enriched before then. A config still carrying the enrich keys fails to load
with "`<key>` was removed with enrich": delete top-level `prompt`, `tracker.gatewayIssues`, `tracker.bugLabels` and the
`prompts/enrich.md` file. Enrich jobs left in the database are failed with "enrich was removed; this job will not run".

**Linear stays quiet outside the panel.** The steward never comments on, rewrites or uploads to a Linear ticket; it
talks in the agent panel, moves the workflow state, and sets itself back as delegate on a revive. Everything for the
code goes on the merge request: the implement summary (once the loop finds the MR), every round's replies and note,
hand-back and stop notes.

### 1.7a Implement

The decision **whether an agent implements a ticket** stays with people: only delegating the ticket to the steward
starts it. The steward never opens a merge request, and its git work is pushing one new branch and fast-forwarding it;
the kickoff pipeline opens the MR.

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

**`implement` config.** Required, with `GITLAB_PUSH_TOKEN`; config load fails otherwise.

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

**The repo's own prompt section.** `prompts/repo.md` in the config directory, when present, is
rendered into the implement, fix and chat prompts (as the Mustache partial `{{> repo}}`, after
the "Codebase graph" section): the target repo's conventions the agent needs on every run.
Without the file the section is left out. Kickoff's is `examples/kickoff/prompts/repo.md`.

**What an implement job does.** Fresh worktree at the latest `dev`, as for every job. The
agent edits, commits (as `commitAuthor`, with subjects prefixed `<IDENTIFIER>: `) and pushes
through the steward's `push` tool; it never runs `git push` and never sees the token. The tool
pushes `HEAD` to the ticket's own branch only, stopping at the first refusal and returning the
reason to the agent so it can fix it and call again: the worktree must be clean; `HEAD` must
be a non-empty, merge-free series on the base (the job's base `dev` commit for the first push,
the last pushed head after that); every commit subject must carry the identifier; every
commit's diff (read as text, binary and `-diff` files included) must leave out the files the
steward copied in (overlay files and its own `.claude/skills/` copies; the repo's own tracked
skills can still be edited) and must not add a line containing the value of a secret-looking
overlay variable or one of the steward's own secrets, and no commit message may carry one
(the refusal names paths or commits, never values); `implement.checks` must pass
(`{{baseSha}}` is the job's base commit); and the ticket must still be open. The first push
creates branch `<type>/<IDENTIFIER>-<slug>` (the agent passes the type, one of
`branchTypes`) and is refused if any remote branch already carries the ticket; later pushes
fast-forward it. Before pushing, the tool records the commit and keeps a copy as a bundle
file in the job dir (not a ref, which the mirror's `--prune` fetch would delete). Every push
runs from a fresh scratch bare repo in the job dir with hooks disabled, with
`--force-with-lease`, so it can never force a branch or create one that exists. Each
token-carrying `ls-remote` runs from a steward-made directory or scratch repo, never the
mirror or worktree. The steward never opens the MR; the kickoff pipeline does once the
branch lands. After the run the steward only reads what the agent did: it hands back "the
agent did not push its change" when nothing was pushed, and "the agent left unpushed work"
(listing it) when uncommitted changes or unpushed commits remain. It never commits or pushes
for the agent.

**The secret scan is best-effort.** It catches accidental leaks: a plain-text overlay or
steward secret in an added line or the commit message. A diff it cannot read or that is too
large (64 MB per file) is refused rather than passed. It does not stop an agent that sets
out to leak: an encoded value (UTF-16, base64, split strings) gets past it. The real controls
are the overlay-file guard, a `write_repository`-only push token and human review of the MR.

**Hand-backs are successes.** An existing ticket branch, no push, unpushed work, an invalid
result, or the agent reporting `failed` or `needs_info` end the job `succeeded` with
the warning `handed back: <reason>` (see it, with the detail and the agent's questions, in
`steward jobs show`). The agent panel says so: the agent's questions as an elicitation (answer them in the panel and
the same session carries on), any other hand-back as an error with its reason. They are the answer, not an error. Only
a push failure is `publish_failed`.

**`steward implement KEY --dry-run`.** Prints the implement prompt a run on the ticket would
get, from the ticket as `serve`'s admin API reads it (the CLI never holds a Linear token, so this
needs the Kubernetes runtime's admin API) and the mirror's current base. Nothing runs and nothing
is written. Without `--dry-run` it refuses: assigning the steward in Linear is the only way to
start work.

One implement job can hold the worker for about 90 minutes (setup, up to 60 of brain,
checks); other heavy jobs queue behind it unless `slots` gives the worker more lanes.

To smoke-test, delegate a throwaway ticket to the steward and watch its agent panel, the pushed branch and the move
to the review state once the MR opens (and, with a `reviewLoop` block, the implement summary note on the MR). The first real push is also what proves the
token's Developer access: doctor's `push token` line only runs `ls-remote`.

Whatever the trigger, the steward never works on a Done or Canceled ticket. The state is
checked at intake, when a job starts, and by the push tool before every push (which it refuses); a closed ticket fails the job without retry. This applies to `steward implement` too.

### 1.7b Review loop on the merge request (optional)

With a `reviewLoop` block the steward does not stop at the push. It waits for the pipeline to open the merge request,
then treats every comment on it, from people and bots alike, as work: it resumes the implementing brain session to
answer each one (a change pushed through the push tool and a reply, or a reply alone) and repeats while comments keep
coming. Greptile is one reviewer among them, and optional: with a `greptile` block and the setting on, the loop asks
for and waits for its review of every push. It needs `implement`, `codehost.kind: "gitlab"` and `brain.kind: "claude-code"`.

```ts
reviewLoop: {
  prompt: "./prompts/fix.md",             // required; `steward init` writes prompts/fix.md
  maxRounds: 5,                           // rounds in a row started only by bots or a red pipeline (setting greptile.maxRounds)
  pollSeconds: 300,                       // fallback poll; GitLab webhooks wake the loop at once
  mrTimeoutMinutes: 30,                   // wait for the pipeline to open the MR
  reviewTimeoutMinutes: 30,               // wait for Greptile to review the head
  pipelineTimeoutMinutes: 30,             // wait for the head pipeline to finish
  ciLogLines: 200,                        // failed-job log lines given to the brain
},
greptile: {                               // optional: Greptile as one of the reviewers
  botUsername: "greptile-apple",          // the username Greptile comments as on the MR (required)
  passScore: 5,                           // Greptile confidence that ends bots' rounds (setting greptile.passScore)
  mcp: { url: "https://api.greptile.com/mcp" },
},
```

An older config that keeps the loop's keys (`prompt`, `maxRounds`, the timeouts, `pollSeconds`, `ciLogLines`) in
`greptile` and has no `reviewLoop` still runs the loop with them. Without a `greptile` block, Greptile is off whatever
the `greptile.enabled` setting says.

`steward settings set greptile.enabled false` stops asking Greptile for reviews and waiting for them, without a
restart; its comments are still work like any bot's.

**Every comment is work.** Any new note on the MR from a person or a bot wakes the loop; the steward's own notes
(written by its GitLab account; a `ticket-steward:` marker on anyone else's note counts for nothing) never do. People
and bots alike need Developer access; only the configured Greptile user needs none. A Reporter's, a non-member's or
an unlisted bot's notes are not work at all: they wake nothing, are left out of a round's threads and never become
decisions. A note on a fork's MR, or on another MR from a branch of the same name, never reaches the loop. Notes are batched over a quiet
window (`review.quietMinutes`, 2 minutes) into one round, so a burst of comments is one round. A round's work list is
every unresolved discussion whose latest note is not the steward's; for each, the agent changes code and replies with
what changed, or replies only (an answer, a question back, why it disagrees). It never resolves a thread: whoever
opened it decides. A note that arrives while a run is going is passed into the run as context, and the next round
answers it in its thread.

**Decisions.** A lasting instruction a person gives in any comment ("keep the v1 endpoint", "don't rename the
queue"), on the MR or in an `/agent` chat, is recorded on the loop as a decision and shown to every later round and
chat as something never to undo; the agent declines a comment that asks for what a decision rules out and says why. A
round keeps only decisions whose author is a person who wrote in that round's discussions, never a bot's advice.

**Rounds and the cap.** A round started only by bot notes or a red pipeline counts against `greptile.maxRounds`; at the
cap the loop hands back with one note ("stopped after N rounds started by bots; a person's comment starts another").
A round with a person's comment resets the count: people always get a round.

**CI triage.** A red head pipeline is triaged before it counts as a round (`ci.triage`, on by default). A job that
failed for an infrastructure reason (runner system failure, stuck or timed out, API or scheduler failure, no matching
runner and similar) is retried, up to twice per job per commit. A job that looks flaky is retried once per job per
commit (`ci.retryLimit`): its failing tests also failed on the default branch within `ci.lookbackDays` (14) by the
MR's test report, or, when the bot's remote Orbit works, the Orbit graph finds the same job failing on the default
branch or passing on retry on other refs. A retry costs no round and runs no agent; the MR and the agent panel say
"Retried <job> (looked flaky: <signal>)". Still red after the retry, or no flaky signal: a normal round, and the agent
is told what triage found.

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

**Passing.** For the MR's current head SHA, with a green pipeline: nothing is left on the work list, or (for a round
only bots started) Greptile's confidence is at least `greptile.passScore`. A pass posts the round history as a note on
the MR; the loop then waits, and a new comment starts another round. People still merge.

**Token.** `GITLAB_TOKEN` needs the `api` scope (not just `read_api`): the loop reads the MR, pipelines and test reports, replies to
threads, posts notes and retries jobs. `steward doctor` checks the scope, that `botUsername` exists and that the prompt
file exists.

**Kickoff side.**

- `.greptile/config.json` must have `"autoReview": ["open", "push"]` so every push is reviewed.
- `excludeAuthors` must not match the steward's GitLab user, or Greptile never reviews its pushes.
- CI's `open:dev-mr` must open non-draft MRs; Greptile skips drafts.

**States.** `awaiting_mr` (waiting for the pipeline to open the MR), `awaiting_review` (waiting for Greptile and the
pipeline), `fixing` (a fix job is running), then an end state: `passed`, `handed_back` or `stopped` (the ticket was closed
or the MR was merged or closed; for a merged or closed MR the steward says so in a note on it), or `unassigned` (see
below).

**Hand-back reasons.** The ticket stays in its review state, the agent panel says why, and the MR gets a note with the
reason, the last Greptile score and any detail (an output tail, paths); a loop whose MR never appeared says so in the
panel only. Reasons:
no MR was opened; a person pushed to the branch; Greptile failed or never reviewed the head; no finished pipeline, or it
failed or was canceled; the agent did not push its change, left unpushed work, pushed a change but reported no changes,
or its push could not be confirmed; or bots started `greptile.maxRounds` rounds in a row. The push tool's own
refusals (checks, secret guard, commit subjects) go back to the agent to fix, not to a person. The brain can also hand back itself when it cannot fix a finding. A round with no
push hands back when Greptile's summary has no `Reviews (N)` counter, since its next review could not be told apart. A
loop whose await, fix or hand-back job fails for good (out of attempts, or a crash) is handed back with that job's error
within a few minutes, so it never sits in a running state with nothing to move it. Retryable errors only add up while
they come in a row: each poll that finds the loop still waiting starts the count over.

**Unassign, revive, reassign.** Removing the steward as the ticket's delegate stops its run, cancels its queued jobs
and parks the loop (`unassigned`); the branch and MR stay as they are. While unassigned it ignores Linear prompts and MR
notes, except a mention: an @mention in Linear (with `linear.reviveByMention` on) or an `/agent` note on the MR sets it
back as the delegate, resumes the loop on the MR head and answers the message in a chat. Delegating a ticket it already
has a loop for (unassigned or handed back) resumes the loop on the MR head the same way; it never starts a second
implement. Notes people posted on the MR after the last hand-back are given to the resumed loop's next fix round; system
notes and notes from Greptile, GitLab bot users (project and group access tokens) and the steward's own `GITLAB_TOKEN`
user are left out. With no open MR to resume on, the loop stops and the agent panel says why. `steward jobs show <id>` prints the loop and one line per round
(`round 1: 3/5 ...`) for the loop's jobs and for the implement job.

**Sessions.** The brain's sessions live in `dataDir/sessions` (`CLAUDE_CONFIG_DIR`), one per ticket, and the loop's worktree
is the stable `ticket-<KEY>`. Loop worktrees are kept for active loops and for `retention.days` after a loop ends;
`steward jobs gc` and the hourly sweep then remove them. Session directories are small and are kept much longer: for
`chat.sessionRetentionDays` (default 180, with or without a `chat` block) after the ticket's last job, so an agent's
session can be resumed after its worktree is gone. Resuming recreates the worktree at the same path (sessions are keyed
by path) at the branch head, or at the implement job's base when nothing was pushed, then copies the overlay and runs
`workspace.setup` again. The brain never receives GitLab, Linear or Greptile credentials.

### 1.7c Chat on the merge request (optional)

With a `chat` block (claude-code brain, GitLab code host, `GITLAB_TOKEN`), a merge request note whose first line starts
with `/agent` resumes the ticket's agent session with the rest of the note as the message, and the agent's answer is
posted in the same discussion:

```ts
chat: {
  prefix: "/agent",              // default; matched case-insensitively at the start of the note's first line
  sessionRetentionDays: 180,     // default; session transcripts are kept this long after the ticket's last activity
},
```

- It uses the same `/webhooks/gitlab` hook as the fix loop, with **Comments** enabled.
- Only a member with Developer (30) or higher access on the project (inherited membership counts) starts a chat; anyone
  else is ignored without a reply. System notes, bot users, Greptile and every note carrying a steward marker are ignored,
  so the steward never answers itself. Each note id is acted on once, even when GitLab redelivers it or it is edited.
- The ticket is found by the MR's source branch (its loop, else its implement job). An MR with no agent session gets
  one reply saying so and no agent run.
- The chat is a `chat` job: it waits for any running job on the ticket (and any step of its loop), recreates the session's
  worktree at the same path when retention removed it, takes a slot, and resumes the latest session (the loop's, else
  the newest implement job's). With a pushed steward branch the agent has the `push` tool and may commit and push
  (fast-forward only, every push rule applies); without one it answers only. Work it leaves unpushed is listed in the reply;
  the steward never pushes it.
- On an unassigned loop, an `/agent` note revives it (see above) before its chat runs; any other note is ignored.
  `/agent restart` is no longer a keyword: it is a chat like any other.
- The webhook answers `chat`, `chat_revive`, `chat_denied`, `chat_ignored`, `chat_duplicate`, `chat_no_session` or
  `chat_failed` (the access check could not reach GitLab) for an `/agent` note. A bare `/agent` with no message is
  `chat_ignored`.
- An `/agent` note does not wake a loop waiting for review; the loop's next poll (or any other note) does.

**In the terminal.** `steward chat <KEY>` (in the stack: `docker compose exec steward steward chat API-123`) opens the
ticket's latest agent session in the Claude Code terminal UI, in its worktree (recreated if retention removed it), with
the brain's credentials, `CLAUDE_CONFIG_DIR`, MCP servers (`push` only when the ticket has a pushed steward branch) and
tool rules (a `PreToolUse` hook, `steward chat-hook`: no writes outside the worktree, no mirror, DB, config or sessions,
no `docker`/`sudo`/`git push`; commits are allowed). It needs no `chat` block, only the claude-code brain.
It reads no Linear: the ticket (key in any case, or UUID) is the one the steward's own jobs recorded, so it works
without serve and holds no Linear token. A ticket whose key changed in Linear is found by its UUID or its old key.

- It refuses while a job for the ticket runs, naming the job, and while another `steward chat` holds the ticket.
- While open it holds a lease (`chat_leases` in the DB, heartbeated every 30 s, ignored after 120 s without one): jobs
  for the ticket wait, and it takes a slot no job is using, whose worker lane claims nothing until the chat ends.
  Without `slots` the one lane is the slot, so the queue waits while the chat is open. With no slot free it exits 1;
  `--no-slot` chats without slot services instead (the app's containers are not started).
- Retention keeps the worktree and session while the chat is open.
- On exit it releases the lease and the slot and lists uncommitted files and unpushed commits; pushing happens only
  through the `push` tool inside the session.
- The hook denies (exit 2) whenever it cannot decide, including when the config or `.env` cannot be loaded.
- It runs outside `serve`'s process, so recreating a worktree can collide with a fetch `serve` is running on the mirror
  (a git lock error). Run it again.

### 1.8 Doctor, then start the service

```bash
sudo -u steward -H bash -lc 'cd /etc/ticket-steward && steward doctor'
```

Every line is `[ok]`, `[warn]` or `[fail]`; the exit code is 1 if anything failed. Fix
every `[fail]` before installing the unit. Checks: config parses; `.env` holds the brain,
webhook and codehost secrets; the running user does not own `~/.ssh` or `~/.kube`;
`dataDir` and `overlayDir` are 0700; the mirror exists, has `extensions.worktreeConfig`
and fetches; the overlay has at least one file; the skills dir exists; `LINEAR_WEBHOOK_SECRET` is set;
the Linear app's client credentials (`LINEAR_CLIENT_ID`, `LINEAR_CLIENT_SECRET`) mint a token that answers a
`viewer { id name }` query (the line names the app and its user id; doctor revokes the token at once), and a refused
mint fails naming both secrets and their Secrets Manager names; `publicUrl/health` answers; the
codehost MCP server starts and answers `tools/list`; with `implement` configured, `GITLAB_PUSH_TOKEN` can `ls-remote` the repo (a read, so it
cannot prove Developer access; the first real push does) and, for GitLab, `implement.protectedBranches` are protected with
no Developer-role or project-bot push or merge grant (read with `GITLAB_TOKEN`); Playwright's Chromium is installed;
`workspace.port` is free, or, with `slots` (§1.10): `/usr/local/sbin/steward-slot` is root-owned and not
group- or world-writable, `slots.socket` exists, is a socket and answers `check`, every slot's app and
service ports are free (a slot left up is named), and every `slots.env` key is defined in the overlay. Under Docker
Compose (§1.11) the ownership check is skipped, and doctor says so. A config that does not load is one `[fail] config`
line naming each bad key, such as a leftover `tracker.labels` (§1.7).

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

1. Create a throwaway ticket in an allowlisted team. `steward jobs` shows no job for it: nothing starts until the
   steward is its delegate.
2. Delegate it to the steward. Within 10 seconds its agent panel says "Picked this up; reading the ticket" and the
   ticket moves to its team's started state; within the job's run time a branch is pushed (or the panel says why it
   handed back), as in §1.7a.
3. `steward jobs` lists the implement job as `succeeded`.

To see what a run on a ticket would be told:

```bash
steward implement KEY-123 --dry-run    # prints the implement prompt, read through serve's admin API; runs nothing
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
<n>`, or `check`; `n` 1–20, at most 64 bytes), runs it, and replies with the command's output followed by a last line `exit <code>`,
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
retention sweeps only while no job runs, so under sustained load on every slot the hourly sweep waits for a moment when all slots are idle. `steward chat` leases a slot of its own; jobs run only under serve (`steward jobs retry ID` refuses without it).

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

### 1.11 Running with Docker Compose

The alternative to the systemd install (§1.2–§1.10): the steward, its slot helper and a Docker daemon for the slots
run as one Compose stack from a checkout of this repo (`compose.yaml`). The config and data directories are the
same, bind-mounted from the host, so the steward behaves as it does under systemd.

| Service | Image | Role |
| --- | --- | --- |
| `dind` | `docker:29.2.1-dind`, privileged | dockerd for the slot containers, on a unix socket only (no 2375/2376 listener); publishes port 3020 to `127.0.0.1:${STEWARD_PORT}` |
| `slot-helper` | `ops/slot-helper/Dockerfile` | the same `ops/steward-slot`, served by socat on `/run/slot/steward-slot.sock` (one helper per connection, owner `STEWARD_UID:STEWARD_GID`, mode 0660); the only service with the docker socket |
| `steward` | `Dockerfile` | `steward serve` as `STEWARD_UID:STEWARD_GID`; Node 24, pnpm 11.13.0, git, psql, Playwright Chromium, native `glab` 1.125.0 and the Orbit CLI 0.161.0 (§1.12); no Docker CLI or socket |

`slot-helper` and `steward` share `dind`'s network namespace, so slot ports that dind publishes on `127.0.0.1` are on
`127.0.0.1` for the steward and the agent exactly as on the host: `slots.env` and `appPortBase` stay unchanged. The
image sets `STEWARD_LISTEN_HOST=0.0.0.0` so the published port reaches the server (the host install keeps binding
localhost). The accepted risk is the host install's: the agent can connect to the helper socket and `down` another slot.

**Setup** (from the checkout, as a user in the `docker` group):

```bash
cp ops/compose.env.example ops/compose.env   # STEWARD_PORT, STEWARD_UID/GID, STEWARD_CONFIG_DIR, STEWARD_DATA_DIR
docker compose --env-file ops/compose.env build
docker compose --env-file ops/compose.env up -d dind slot-helper
# the slot images live in dind's own image store (the dind-data volume), so pull them there once
for image in timescale/timescaledb-ha:pg17-ts2.27-all redis:7-alpine rabbitmq:4.2.0-management; do
  docker compose --env-file ops/compose.env exec slot-helper docker pull "$image"
done
docker compose --env-file ops/compose.env up -d
docker compose --env-file ops/compose.env exec steward steward doctor
curl -s 127.0.0.1:3020/health
```

Config changes: `slots.socket: "/run/slot/steward-slot.sock"`; `server.port` stays `3020` (the port dind
publishes and the healthcheck uses). Doctor treats any `slots.socket` other than `/run/steward-slot.sock` as the
helper in a container: it skips the host ownership check of `/usr/local/sbin/steward-slot` and says so, and still
requires the socket to answer `check`. Every other check is the same as §1.8.

**Day to day.** `docker compose --env-file ops/compose.env logs -f steward` replaces `journalctl`; `exec steward steward jobs`
replaces running `steward` on the host; `exec slot-helper steward-slot status <n>` and `down <n>` replace the root
helper commands of §1.10; `up -d --build` after a `git pull` updates the stack. Stopping waits up to 120 s for
in-flight jobs, like the unit's `TimeoutStopSec`. One request over the socket from the steward container:

```bash
docker compose --env-file ops/compose.env exec steward node -e 'const s=require("net").connect("/run/slot/steward-slot.sock",()=>s.write(process.argv[1]+"\n"));s.pipe(process.stdout)' check
```

**Migrating the live host from systemd.** On the live host the stack runs as the existing `steward` user
(`STEWARD_UID=998`, `STEWARD_GID=998` in `ops/compose.env`), which owns `/etc/ticket-steward` and
`/var/lib/ticket-steward`, so nothing is chowned and the systemd units stay a working rollback.

1. Back up `/var/lib/ticket-steward/steward.db`, `/etc/ticket-steward/steward.config.ts` and `/etc/ticket-steward/.env`.
2. `systemctl stop ticket-steward steward-slot.socket` (serve waits for in-flight jobs and brings every slot down).
3. Set `slots.socket: "/run/slot/steward-slot.sock"` in the config.
4. Build, start `dind` and `slot-helper`, pull the slot images and start the stack as in Setup.
5. Doctor passes inside the container, `/health` answers on `127.0.0.1:3020` (the `cloudflared` tunnel keeps
   pointing there), and one webhook delivery shows in `logs steward`.
6. `systemctl disable ticket-steward steward-slot.socket`. The units and `/usr/local/sbin/steward-slot` stay
   installed until the owner removes them.

Rollback: `docker compose --env-file ops/compose.env down` (without `-v`, which would also drop the pulled slot
images), set `slots.socket` back to `/run/steward-slot.sock`, `systemctl enable --now steward-slot.socket ticket-steward`.

**Troubleshooting.**

- `another steward process holds /var/lib/ticket-steward/run.lock` in a crash loop: the lock names a pid that is
  alive and whose start time matches, so another steward really runs on this data dir (a systemd unit, or a
  `steward` started by hand). A lock left by an older steward holds only a pid; if nothing else runs, delete it.
- `cannot reach the slot helper at /run/slot/steward-slot.sock`: `ENOENT`, `slot-helper` is not running
  (`ps`, `logs slot-helper`); `EACCES`, the steward runs as another uid/gid than the socket's owner (set both through `STEWARD_UID`/`STEWARD_GID`, never `user:` alone).
- Doctor's `check` fails with `image … is not pulled`: pull it through `slot-helper` as in Setup.

### 1.12 Orbit for the agents

[Orbit](https://docs.gitlab.com/orbit/) gives the agents a code graph of their checkout and, when GitLab allows it,
the GitLab Knowledge Graph. The image installs native `glab` 1.125.0 and the Orbit CLI 0.161.0 (its static musl
build) from their release downloads, each checked against a sha256 pinned in the `Dockerfile`, and never updates them
at runtime. A host install puts `orbit` on the steward user's `PATH` itself; without it agents work as before.

- **Local graph.** Before every implement, fix and chat run (and `steward chat`), the steward runs
  `orbit workspace index .` in the worktree (120 s limit) with `ORBIT_DATA_DIR=<dataDir>/orbit`, where the DuckDB
  files and Orbit's settings live. A failed index logs `orbit index failed` and the run goes on. The agent's shell
  gets the same `ORBIT_DATA_DIR`, so its `orbit grep` and `orbit context` read that graph; they need no credentials.
- **Remote.** The brain gets the `orbit` MCP server (`steward mcp orbit`), with the read-only tools `orbit_query`,
  `orbit_schema` and `orbit_context`. Like the codehost and push servers it loads `GITLAB_TOKEN` from the config's
  `.env` itself and hands it only to the Orbit processes it runs (60 s limit, output cut at 64 KiB), so the brain
  still receives no GitLab credential. Any failure is a tool error starting `Orbit remote is unavailable:`; it never
  fails the job.
- `orbit_context` refuses a URL ref whose origin is not `codehost.baseUrl`, so the token only goes to the configured host.
- The graph under `<dataDir>/orbit` is shared by every worktree and is not swept with them; delete the directory (with
  no job running) if it grows large, and the next run re-indexes.
- **Doctor** prints `[ok] orbit: 0.161.0` when the binary runs and `orbit remote` for
  `orbit status --full-path <codehost.project>` with `GITLAB_TOKEN`. Both only warn.

As of 2026-10-28 the Orbit API refuses the project access token (`Orbit is not available for your user`, HTTP 403 on
queries): Orbit is enabled per user, and the token's bot user is not one. Until GitLab allows it, doctor warns
`orbit remote` and the `orbit_*` tools return that error; the local graph works regardless. `glab orbit` with a
person's own login is unaffected.

### 1.13 Running on k3s

The Kubernetes runtime (`runtime.kind: "kubernetes"`): the steward is a dispatcher Deployment, and each run (implement,
fix, chat) is a Job whose pod has an agent container with no credential, plus keyproxy, tools, egress, Postgres,
Redis, RabbitMQ and session-sync sidecars. Secrets come from AWS Secrets Manager through the pods' projected
service-account tokens, and Claude Code sessions live in MinIO in the cluster. The design is
`docs/superpowers/specs/2026-10-28-k3s-steward-design.md`; the manifests are `deploy/k8s/base` (kustomize).

| Object | Image | Role |
| --- | --- | --- |
| Deployment `steward` (1 replica, `Recreate`) | `deploy/images/steward.Dockerfile` | `steward serve`: webhooks on 3020, run callbacks on 3021, the admin API on `127.0.0.1:3022`; SQLite and the mirror on the PVC `steward-data` (Ceph RBD, 20 Gi) |
| StatefulSet `minio` | `deploy/images/minio.Dockerfile` | the `steward-sessions` bucket on a Ceph RBD volume (50 Gi); STS sign-in with the k3s issuer |
| Job `run-<runId>` per run | agent: `deploy/images/agent.Dockerfile`; sidecars: the steward image, `ops/egress/Dockerfile`, `runtime.images.postgres/redis/rabbitmq` | one run; the agent container gets only the runner token, which can post this run's report and nothing else |

**k3s.** The service-account issuer must be a public HTTPS URL that AWS (and MinIO) can fetch, so start every k3s
server with:

```bash
--kube-apiserver-arg=service-account-issuer=https://k3s-oidc.example.com
--kube-apiserver-arg=service-account-jwks-uri=https://k3s-oidc.example.com/openid/v1/jwks
```

Changing the issuer invalidates the tokens already issued; pods get new ones as the kubelet rotates them (within an
hour). k3s enforces NetworkPolicy with its embedded kube-router unless it was started with
`--disable-network-policy`. The manifests use a StorageClass named `ceph-rbd` (ReadWriteOnce, replicated); rename
it in `dispatcher.yaml` and `minio.yaml` if yours differs.

**Publishing discovery.** The API server serves the discovery document and the JWKS only to authenticated clients,
so copy both to the issuer URL's static host (any HTTPS server; content type `application/json`):

```bash
kubectl get --raw /.well-known/openid-configuration > openid-configuration
kubectl get --raw /openid/v1/jwks > jwks
# upload as https://k3s-oidc.example.com/.well-known/openid-configuration and …/openid/v1/jwks
curl -fsS https://k3s-oidc.example.com/.well-known/openid-configuration   # its "issuer" must equal the URL above
```

Republish the JWKS whenever the service-account signing key changes (a k3s key rotation); until then every
sign-in fails with an invalid token.

**IAM.** `deploy/aws/steward-role.tf.example` registers the issuer as an OIDC provider (client id
`sts.amazonaws.com`) and creates two roles. `ticket-steward`, trusted by `system:serviceaccount:ticket-steward:steward-dispatcher`
only, may `secretsmanager:GetSecretValue` on `DEV_*` in the region (and simulate the run role's policy, for doctor).
`ticket-steward-run`, trusted by `…:steward-run` only, is the run pods' sidecars' role: the same `DEV_*` read with an
explicit deny on `DEV_STEWARD_LINEAR_*`, since a sidecar handles what the agent wrote and no Linear credential may be
within its reach. Copy it into your Terraform, set `k3s_issuer_url` and `region`, and `terraform apply`; its output
`steward_role_arn` is `runtime.aws.roleArn` and `awsRoleArn` below, and `steward_run_role_arn` is
`runtime.aws.runRoleArn` (config load refuses the two being equal). The steward's own tokens are `DEV_` entries like any other (e.g.
`DEV_STEWARD_LINEAR_CLIENT_ID`, `DEV_STEWARD_LINEAR_CLIENT_SECRET`, `DEV_STEWARD_GITLAB_TOKEN`), each a string or a one-key JSON object, as kickoff's
`preview.py` reads them. No access key is created anywhere.

**Images.** Build from the repo root and push to a registry the nodes pull from:

```bash
docker build -f deploy/images/steward.Dockerfile -t "$REGISTRY/ticket-steward/steward:$TAG" .
IMAGE="$REGISTRY/ticket-steward/agent:$TAG" deploy/images/build-agent.sh ~/kickoff dev   # git -C ~/kickoff fetch first
docker build -t "$REGISTRY/ticket-steward/egress:$TAG" ops/egress
docker build -f deploy/images/minio.Dockerfile -t "$REGISTRY/ticket-steward/minio:RELEASE.2025-10-15T17-29-55Z" .
```

- The steward image is the Compose image without Chromium, pnpm or psql; it keeps git, `glab` and Orbit for the
  tools sidecar and doctor.
- Before pushing new steward or egress images, run the smoke test that has them work together as the run pod does
  (render-overlay writes the egress rules, egress reads them as the Job's user and opens its port):
  `STEWARD_SMOKE_STEWARD_IMAGE=<steward image> STEWARD_SMOKE_EGRESS_IMAGE=<egress image> npx vitest run test/deploy/imageSmoke.test.ts`.
- The agent image carries the steward (for `steward run-pod`), Claude Code from the Agent SDK, Node 24, pnpm
  11.13.0, git, psql, Playwright's Chromium, `glab` 1.125.0 and Orbit 0.161.0 with the checksums of `Dockerfile`, and
  a pnpm store prefetched (`pnpm fetch`) from the lockfile and workspace file of kickoff's base branch, taken from
  the git ref, not the working tree. Rebuild it when kickoff's lockfile changes, or on a schedule; a run's
  `pnpm install` then fetches only the difference. Nothing a run writes reaches another run.
- MinIO's open-source server is archived and no longer published as an image or binary, so its image is built from
  the last release tags of `minio` and `mc`, pinned by commit. It makes a new root password on each start, uses it to
  create the bucket and the `steward-sessions` policy (`deploy/k8s/base/minio-policy.json`), and keeps it in memory
  only; no MinIO key exists outside that container. MinIO signs STS credentials with that root key, so a MinIO
  restart (eviction, drain, OOM) voids every credential handed out: requests with one get `InvalidAccessKeyId`. The
  sessions containers then sign in again and retry the request once, so a restart costs each a sign-in, not its
  uploads. A sync that falls while MinIO is down fails and is retried at the next interval; a pod that ends then
  loses what it wrote since its last successful sync.

**Config.** In `steward.config.ts`:

```ts
secrets: { source: "aws", region: "eu-west-2", map: { LINEAR_CLIENT_ID: "DEV_STEWARD_LINEAR_CLIENT_ID", LINEAR_CLIENT_SECRET: "DEV_STEWARD_LINEAR_CLIENT_SECRET", GITLAB_TOKEN: "DEV_STEWARD_GITLAB_TOKEN", /* … */ } },
workspace: { /* … */ overlayTemplateDir: "/etc/ticket-steward/overlay-template" },
runtime: {
  kind: "kubernetes",
  namespace: "ticket-steward",
  images: { steward: "…/steward:TAG", agent: "…/agent:TAG", egress: "…/egress:TAG",
            postgres: "timescale/timescaledb-ha:pg17-ts2.27-all", redis: "redis:7-alpine", rabbitmq: "rabbitmq:4.2.0-management" },
  maxConcurrent: 2,
  callbackUrl: "http://steward-internal.ticket-steward.svc:3021",
  minio: { endpoint: "http://minio.ticket-steward.svc:9000" },
  aws: { roleArn: "arn:aws:iam::<account>:role/ticket-steward", runRoleArn: "arn:aws:iam::<account>:role/ticket-steward-run", region: "eu-west-2" },
  resources: { agent: { cpu: "4", memory: "8Gi" } },
  egressAllowCidrs: [],
},
```

The overlay template's env files take `{{secret:<id>@<host>,<host>}}` for an outbound API key: the agent's file gets a
placeholder, and the egress sidecar swaps the real value into credential headers (`Authorization`, `x-api-key` and
the like) on requests to those hosts only. A host is an exact name or `*.<domain>` with at least two labels, matching
one label more (`*.stripe.com` matches `files.stripe.com`, not `a.b.stripe.com`); prefer exact names, and doctor warns
about a wildcard on a domain anyone can have a subdomain of (`*.s3.amazonaws.com`, `*.vercel.app`). Append `;query`
or `;body` (`{{secret:DEV_X@api.x.example;query}}`) only for an API that takes its key there: an API may store or
echo what a request carries in a form the response scrubbing misses. `{{local}}` is a throwaway value per run.

The config dir goes into the ConfigMap `steward-config` as one gzipped tar under the key `config.tgz`: ConfigMap keys
are flat and the dir is not (the overlay template's `apps/<app>/.env`, prompts), and `--from-file=<dir>` would skip
every subdirectory. The dispatcher and every run pod start with a `config-unpack` init container that unpacks it into
an emptyDir, which the other containers mount read-only at `/etc/ticket-steward`. A missing `config.tgz` key keeps the
pod from starting (`CreateContainerConfigError`). Create or update it with:

```bash
tar -czf steward-config.tgz -C <config dir> .
kubectl -n ticket-steward create configmap steward-config --from-file=config.tgz=steward-config.tgz --dry-run=client -o yaml | kubectl apply -f -
kubectl -n ticket-steward rollout restart deployment/steward
```

Make the tar exactly so, rooted at `.`: the unpack strips that leading `./`. A run pod unpacks the bundle once, when it starts, so a change reaches the runs started after it and never a running
one. The compressed dir must stay under 1 MiB, the ConfigMap limit. Secrets come only from Secrets Manager (config
load requires `secrets.source: "aws"` here); keep no `.env` in the config dir, since run pods unpack it.

**Apply.** Set the `steward-cluster` literals in `deploy/k8s/base/kustomization.yaml` (or an overlay): `issuer` (the
URL above, no trailing slash), `awsRoleArn`, `awsRegion`, and `serviceCidr`/`podCidr` if k3s does not use its
defaults (`10.43.0.0/16`, `10.42.0.0/16`), which kustomize writes into the NetworkPolicies' except lists. Set the
`images` to what you pushed. Then:

```bash
kubectl apply -k deploy/k8s/base
tar -czf steward-config.tgz -C <config dir> .
kubectl -n ticket-steward create configmap steward-config --from-file=config.tgz=steward-config.tgz
kubectl -n ticket-steward exec deploy/steward -- steward mirror init
kubectl -n ticket-steward exec deploy/steward -- steward doctor --probe-pod
```

Route the public webhook URL to the Service `steward` port 3020 with your ingress. The NetworkPolicies
(`networkpolicy.yaml`) deny everything in the namespace that they do not allow:

- run pods reach DNS, MinIO's 9000, the dispatcher's 3021 and the internet, never the RFC1918 ranges or the
  cluster's service and pod CIDRs, so not the API server, other run pods or the LAN;
- a private range a run must reach goes in `run-pods-allow-cidrs` and in `runtime.egressAllowCidrs`, kept equal;
- only run pods reach the dispatcher's 3021; anyone reaches its 3020;
- MinIO answers run pods and the dispatcher, and reaches out only to the public issuer;
- only the dispatcher, whose egress is open, reaches the API server. Its role (`rbac.yaml`) covers Jobs,
  ConfigMaps, pods, attach, exec and logs in this namespace, and reading NetworkPolicies, nothing cluster-scoped.

**Doctor** on this runtime skips the host-only checks (`overlayDir`, the overlay, Chromium, the app port) and adds:

- `k3s issuer`: the issuer claim of the dispatcher's AWS token is a public HTTPS URL whose discovery document names
  it and whose JWKS has keys;
- `aws role`: `runtime.aws.roleArn` can be assumed with that token;
- `run role`: IAM's policy simulator says `runtime.aws.runRoleArn` cannot read any `LINEAR_*` id of `secrets.map`
  (a warning when the simulator cannot answer);
- `dev secrets`: every id in `secrets.map` and the overlay template is present and not empty (ids only are printed);
- `overlay template`: no `{{signed:…}}` entry or other issue; warns about a wildcard host on a multi-tenant domain;
- `minio sts`: the dispatcher signs in to MinIO with its `minio`-audience token and lists `sessions/`;
- `network policies`: the five policies of `networkpolicy.yaml` exist;
- `probe pod` (with `--probe-pod`): a throwaway pod like a run pod's agent container (the `steward-run` account, the
  run-id label, the agent image) reports no token under `/var/run/secrets` and no answer from the API server; it is
  deleted afterwards.

**Troubleshooting.**

- `aws role` fails with `Not authorized to perform sts:AssumeRoleWithWebIdentity`: the trust policy's `sub` or `aud`
  does not match, or the provider URL differs from the token's `iss` (a trailing slash counts).
- `minio sts` fails with `InvalidIdentityToken`: MinIO could not fetch the issuer's discovery or JWKS (its egress is
  public only), or the token's audience is not `minio`.
- `probe pod` reaches the API server: NetworkPolicy is not enforced (k3s with `--disable-network-policy`, or another
  CNI without policy support), or a node's public IP serves 6443; restrict that at the node firewall.

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
and its one brain credential. The Linear app's credentials and token, the webhook secret, mirror token and
codehost token never enter that environment.

## 3. Rotating credentials

All secrets live in `/etc/ticket-steward/.env` and are read at process start. After
editing `.env`, restart:

```bash
sudo systemctl restart ticket-steward
```

| Credential | How to rotate |
| --- | --- |
| `LINEAR_CLIENT_SECRET` | In the steward's OAuth app (Settings → API → OAuth applications), rotate the client secret, update `.env` (or `DEV_STEWARD_LINEAR_CLIENT_SECRET` in Secrets Manager), restart. Confirm with `steward doctor` (the `linear app` line). Tokens minted with the old secret stop working; a dispatcher still running on it re-mints, is refused and pauses the worker (§5) until it restarts. The client id does not change. |
| `LINEAR_WEBHOOK_SECRET` | Regenerate in the OAuth app's webhook settings, update `.env`, restart. Deliveries signed with the old secret are rejected with 401 and Linear retries them (1 min, 1 h, 6 h), so do both steps within a minute. |
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
   came from Linear (`linear`: a delegation, mention or prompt), an MR note (`chat`), `cli` or a fix loop (`loop`). `error` is the last failure reason; `interrupted` means the process died mid-run
   and the job was requeued or failed on restart. `implementResult` (implement jobs) and
   `fixResult` (fix jobs) hold the validated result or hand-back; a stored implement result
   makes `steward jobs retry <id>` publish-only. Jobs of kind `enrich` are history from
   before 2026-10-28 and never run again.
2. **Attempts.** One row per claim: `startedAt`/`finishedAt` (a missing `finishedAt` on
   a non-running job means a crash), `error`, `setupTail` (the last 16 KB of the
   `workspace.setup` commands' output; the first thing to read when a job failed before the
   brain ran), `preWriteDescription` (only on old enrich attempts),
   `transcriptPath` and `usage` (tokens and cost). A `succeeded` job whose attempt has an
   `error` succeeded with a warning, for example a hand-back.
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
steward jobs retry 42     # requeues for serve, which must be running (the CLI runs no job); publish-only when an implement result is stored
steward jobs gc           # run retention now: worktrees, artifacts, transcripts, deliveries
```

Failed jobs keep their worktree under `dataDir/work/<id>-<attempt>` when
`workspace.keepOnFailure` is true; retention keeps the newest `retention.keptWorktrees`.

## 5. Linear credentials rejected

Every Linear call uses the app's in-memory token. On a 401 (or an authentication error) the steward mints a new token
and retries once. When Linear refuses the mint itself (the client id or secret is wrong, rotated or the app was
uninstalled), or refuses the fresh token too, retrying cannot help: the error reads "Linear rejected the steward's app
credentials: check LINEAR_CLIENT_ID and LINEAR_CLIENT_SECRET (Secrets Manager DEV_STEWARD_LINEAR_CLIENT_ID and
DEV_STEWARD_LINEAR_CLIENT_SECRET) and restart the steward.", and the first occurrence is logged at `error` level
("Linear rejected the app's credentials; the worker stops claiming jobs until the steward restarts"). From then on,
until the process restarts:

- the worker stops claiming jobs; the job that hit it goes back to the queue with the attempt refunded (so it is
  never failed for the credentials), and new webhook deliveries keep queueing;
- `GET /health` returns 503 with `credentialsRejected: true`;
- `steward doctor` reports `[fail]` on the `linear app` line;
- the service stays up, since the process is healthy, so the signal is `/health`, the log and `doctor`, not a
  restart loop.

To recover, fix the client credentials (§1.7, §3) and restart:

```bash
sudo -u steward -H bash -lc 'cd /etc/ticket-steward && steward doctor'
sudo systemctl restart ticket-steward
curl -s https://steward.example.com/health     # credentialsRejected: false
```

The queued jobs are picked up after the restart.

## 6. Day-to-day

```bash
journalctl -u ticket-steward --since -1h
curl -s https://steward.example.com/health | jq
steward doctor
steward jobs --status publish_failed
steward templates                 # the Linear issue templates, for allowlisted teams (through serve's admin API)
```

Stopping: `systemctl stop ticket-steward` sends SIGTERM. The worker stops claiming,
aborts the running brain, kills its process group, marks the attempt `interrupted`,
leaves the job `queued` (or `failed` with error `interrupted` when that was its last
attempt), releases `run.lock` and exits 0 within `TimeoutStopSec=120`. A job left `running`
by a crash is requeued the same way on the next start.
