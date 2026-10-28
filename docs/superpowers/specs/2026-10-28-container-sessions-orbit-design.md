# Containerized steward, resumable agent sessions, and Orbit for agents

Date: 2026-10-28. Status: design, awaiting approval.

## Why

The steward runs today as a systemd service on one host, with a root-owned slot helper that starts each job's
Postgres, Redis and RabbitMQ through the host's Docker. The owner wants:

1. **A containerized agent workflow in the dev environment** that is *durable* (work and conversations survive
   restarts and can be returned to) and *event-driven* (Linear and GitLab events drive it). It is explicitly **not**
   elastic: a fixed pool of slots on one machine, trimmed by the resource guard, is the intended scale. Peak load is
   10–15 concurrent tickets "and that's a stretch". Kubernetes may come later; the image must not preclude it.
2. **Coming back to an agent's session afterwards and continuing the conversation with it**, from both a comment
   (Linear ticket or the steward's MR) and a terminal command.
3. **Codebase knowledge graphs for the agents** via GitLab Orbit, which the owner has enabled (remote, on the
   `concentrateai` group) and which works for the owner's own Claude Code on the dev host.

Decided in conversation (the owner's calls):

- Temporal, Kubernetes-first, and pi-durable were considered and set aside for now. The existing SQLite job queue
  with deferral, webhook wake-ups and Claude Agent SDK session resume is the durability model. pi-durable was rejected
  because it replaces the agent runtime (losing Claude Code's tools, skills, MCP and session resume) and is
  explicitly experimental.
- Slot services run inside a **Docker-in-Docker sidecar** in the Compose stack (option 1 of 3), so the stack is
  self-contained on any Docker host, the agent never reaches the host's Docker, and the cost is one privileged
  container (the same trade the GitLab runners already make).
- **Linear is labels only; GitLab is where conversation happens** (the owner's rule, 2026-10-28). Work starts in
  Linear when a person adds a label; from then on the steward never posts comments to Linear. Once the MR is open, all
  communication is MR comments on GitLab, or the terminal. Talk-back therefore works from **MR comments and a
  terminal command**, not Linear comments.
- Who may start a chat: anyone with **Developer access or higher on the GitLab project**.
- Orbit: remote is enabled and preferred; local is also wanted ("pretty cool").

Already shipped (not part of this work): resource guard, slot cap 20, slot RabbitMQ ports at `17072 + 100n`
(commits `ae22075`, `eea07f9`, `8e6fc96` on `feat/label-workflows`).

## Goals

- `docker compose up -d` on a Linux host with Docker runs the whole steward: server, worker, slots.
- Every agent session the steward starts can be resumed later and talked to.
- Steward agents can use Orbit (remote when available, local always).
- The live host migrates to the stack without losing jobs, loops, sessions, or the mirror.

## Non-goals

- Kubernetes manifests or Helm charts (later; the image and the slot sidecar should map onto a pod with a DinD
  sidecar, nothing more).
- Elastic or multi-host scaling, a Postgres job store, Temporal.
- A web UI for chat.
- Changing the brain for implement, or the Greptile pass criteria.

## Anti-goals (would make this a failure even if it works)

- The agent can reach the **host's** Docker daemon, or any Docker daemon's API directly.
- A comment from anyone on any MR wakes an agent: chat must be addressed to the steward explicitly and come from a
  Developer-or-higher member of the project.
- The steward posts a comment on Linear.
- A chat turn races a running job or loop step on the same ticket (two agents in one worktree).
- A resumable session silently disappears because retention swept it.
- Secrets end up in the image or in logs.

## Part 1: the container stack

### Images

- **`ticket-steward`**: the steward plus everything an agent run needs today on the host: Node 22 (the steward's
  runtime) and whatever Node/pnpm version kickoff's `workspace.setup` requires (builder: check kickoff's
  `.nvmrc`/`engines`/`packageManager` and match it), git, the Claude Code CLI the Agent SDK uses, Playwright Chromium
  plus its system libraries, `docker` CLI is **not** included. Runs as a non-root user (uid 1001, the cluster
  convention) by default; on the live host Compose sets `user: "998:998"` (the existing `steward` user that owns
  `/etc/ticket-steward` and `/var/lib/ticket-steward`, both 0700) so no chown is needed and the systemd units stay a
  working rollback. *(My call.)* Built from this repo with a multi-stage Dockerfile (`pnpm install --frozen-lockfile`, `pnpm build`,
  prune dev deps).
- **`steward-slot`**: a small image with bash, the `docker` CLI with the compose plugin, `ops/steward-slot` and
  `ops/slots-compose.yml` + `ops/slots-init/`. It serves the existing line protocol on a unix socket (today systemd
  does this with `Accept=yes`; in the container use `socat UNIX-LISTEN:...,fork EXEC:"steward-slot --socket"` or an
  equivalent, keeping one helper process per connection so the protocol and its tests are unchanged).
- **`docker:dind`** (pinned version), privileged.

### Topology (Compose)

```text
            ┌──────────────── netns shared (network_mode: service:dind) ────────────────┐
            │  dind (privileged)            steward (uid 1001)        slot-helper        │
            │  dockerd on unix socket  ◄──  no docker creds    ──►   docker CLI ──► dind  │
            │  only (volume: dind-sock)     /run/slot/steward-slot.sock (volume: slot-sock)│
            │  slot containers publish      reaches slots on 127.0.0.1:<ports>            │
            │  on 127.0.0.1 here            app ports 4101+ here                          │
            └───────────────────────────────────────────────────────────────────────────┘
```

- `steward` and `slot-helper` use `network_mode: service:dind`, so slot ports published by containers inside dind
  are on `127.0.0.1` for the steward exactly as on the host today. `slots.env` values (`DB_HOST: "127.0.0.1"`,
  `{{postgres}}` …) and `appPortOf` stay unchanged.
- dockerd listens **only on a unix socket** in the `dind-sock` volume, mounted into `slot-helper` only. No TCP
  listener (port 2375/2376 must not be open in the shared netns, or the agent could reach it).
- `slot-helper` exposes `steward-slot.sock` in the `slot-sock` volume, mounted into `steward`; `slots.socket` in the
  config points there. The helper validates every request exactly as today (`up|down|status|ports <1-20>`, `check`).
- Port 3020 (webhooks, `/health`) is published from the `dind` service to the host. On the dev host the existing
  `cloudflared` tunnel keeps pointing at `localhost:3020`; no ingress changes.

### Volumes and config

- `/etc/ticket-steward` → bind-mounted **read-only** into `steward` (config, `.env`, overlay, prompts, skills). The
  config's own paths stay valid.
- `/var/lib/ticket-steward` → bind-mounted read-write into `steward` (SQLite DB, mirror, worktrees, sessions, job
  dirs). On the live host this is the existing directory, so migration is a chown at most.
- `dind-data` named volume for `/var/lib/docker` (keeps the pulled Timescale/Redis/RabbitMQ images across restarts).
- Secrets come only from `.env` via the steward's existing loading; nothing is baked into images.

### Doctor and ops

- `steward doctor` must pass inside the container. Checks that assume the host install (helper ownership at
  `/usr/local/sbin/steward-slot`, systemd socket unit) need a container-aware form: when `slots.socket` is not the
  systemd path, check the socket answers `check` and skip the host-file ownership check, saying so.
- `docs/ops.md` gains a "Running with Docker Compose" section; the systemd install stays documented as the
  alternative.
- Migration on the live host (as uid 998, see Images): stop `ticket-steward.service` and `steward-slot.socket`, bring the stack up on the same
  data dir and config dir, run doctor, verify `/health` and one webhook delivery, then disable the systemd units. The
  old units and host helper remain installed until the owner removes them. Back up the DB, config and `.env` first.

## Part 2: coming back to an agent session

### What exists

- claude-code brain sessions live under `CLAUDE_CONFIG_DIR = <dataDir>/sessions`, keyed by the worktree path
  (`sessionProjectDir(cwd)`); jobs store `session_id`, loops store `sessionId` and `worktreeName`. Implement runs that
  start a loop use a stable worktree name per ticket, and the fix loop already resumes the same session there.
- A handed-back loop restarts when the implement label is re-applied; Linear comments since the hand-back are passed
  into the restart.
- Retention keeps the newest `keptWorktrees` (3) worktrees and anything within `days` (30); loop worktrees and their
  session dirs are protected while their loop is within the retention window.

### Design

**Keep sessions, rebuild worktrees.** Session transcripts are small; worktrees are 0.2–1.6 GB each. Retention stops
deleting session directories for any job or loop that has a `session_id` until `sessionRetentionDays` (new,
default 180) after its last activity. Worktrees keep today's count/age eviction. When a chat turn needs a session
whose
worktree is gone, the steward recreates the worktree **at the same path** (sessions are keyed by path) at the right
commit: the loop's/job's pushed branch head if it has one, else the job's recorded base SHA. The overlay is copied and
`workspace.setup` runs again as for any job.

**Chat is a job.** A new job kind `chat` carries the message text, the target session (job id or loop id), and where
to reply. It is a heavy job (resource guard applies), takes a slot like any other, and is serialized with everything
else on the same ticket by the existing claim rule (no running job with the same `issue_id`/subject). A chat turn:
recreate/reuse the worktree → bring the slot up → resume the session with the message as the prompt → post the
agent's reply where the message came from. The agent commits and pushes itself, through the push tool below; the
steward posts the reply and records any new head.

- A ticket with **no steward branch** (an implement that never pushed) gets answer-only chat: the push tool refuses,
  and the reply says code changes need the implement label. *(My call: creating branches and MRs from chat is a
  separate decision.)*

**Agents commit and push; the steward enforces the rules** (the owner's call: the steward is the orchestrator).

- The tool rules in `src/brain/policy.ts` stop blocking `git commit` (and `git add`, `git commit --amend` of the
  agent's own unpushed commits). `git push`, `git remote`, `git config` and credential access stay blocked.
- The agent pushes by calling a **`push` tool** served by a steward-launched stdio MCP server (alongside the existing
  steward MCP servers in `BrainInput.mcpServers`). The tool takes no arguments beyond an optional note: it pushes the
  worktree's `HEAD` to the ticket's steward branch, and only there. The steward side applies today's push rules
  unchanged: fast-forward only, the secret guard over the outgoing commits, protected-branch refusal, and the push token
  stays in the steward's process. A refused push returns the reason to the agent as the tool's error, so the agent can
  fix it (for example, remove a secret) and try again.
- The tool records each successful push (new head SHA, job/loop) in the store, so the Greptile loop treats it as the
  loop's own push, never as "a person pushed".
- **Applies to every brain run, not only chat** *(my call, from "the steward is just the orchestrator")*: implement
  and fix move to the same model. Implement's first push creates the ticket's branch with the steward's existing branch
  naming; opening the MR stays a steward step after the run, as today. Fix pushes to the loop's branch. The structured
  results of implement and fix keep their summary/hand-back fields but lose whatever only existed to let the steward
  commit (builder: identify these from `src/implement/result.ts` and `src/greptile/result.ts`). A run that ends with
  uncommitted changes or unpushed commits is reported in the job outcome; the steward does not commit or push for it.

**Addressing.** A comment wakes chat only when it starts with `/agent` (case-insensitive, first line). Anything else
is ignored by chat (the Greptile loop's existing wake-on-note behaviour is unchanged). *(My call: a prefix rather than
an @mention, because the steward posts as the owner's Linear user and as a project bot on GitLab, so mentions are
ambiguous.)*

- **GitLab only**: a `/agent` note on an MR whose source branch is a steward branch with a known loop/job enqueues `chat`;
  the reply is posted in the same discussion. Use the existing webhook route and signature verification.
- Only notes from a user with **Developer (30) or higher** access to the project start a chat, checked against the
  GitLab members API (inherited membership counts) at intake; others are ignored silently. The steward's own notes
  (its push token's bot user), the Greptile bot and every bot user are ignored; replies also carry a hidden marker as
  a second check.

An MR with no known steward session (a person's MR) gets a short reply saying so, with no agent run.

**Which session.** A ticket can have several sessions (implement, fix rounds). Chat resumes the **latest**
session for the ticket: the loop's session if a loop exists, else the newest job with a `session_id`.

**Interaction with the Greptile loop.** *(My call.)* Chat does not run while the loop is mid-step (the claim rule
already guarantees this). If a chat turn pushes while the loop is `awaiting_review`, the loop's existing "head moved"
handling applies with the push treated as the loop's own (record the new head so it is not mistaken for a person's
push), and the loop keeps waiting on the new head. If the loop is `passed` or `handed_back`, a chat push does not
restart the loop automatically; re-applying the label restarts it as today.

**Terminal: `steward chat <TICKET>`.** Run inside the container (`docker compose exec steward steward chat API-123`).
It finds the latest session as above, recreates the worktree if needed, and launches the Claude Code CLI interactively
with `--resume <sessionId>` in that worktree, with the same `CLAUDE_CONFIG_DIR`, brain credentials and MCP config the
brain uses, so the owner gets the full Claude Code terminal UI on the agent's own context. Constraints:

- It must not run in a worktree while a job for that ticket is running; it refuses and says which job.
- The same tool rules the brain runs under (no writes outside the worktree, no access to the mirror, DB, config or
  sessions, no `docker`/`sudo`, no `git push`; commits allowed) apply: they are written into a settings hook the CLI
  loads for this session, and the same `push` tool is configured for it. *(My call: the session is still the agent's, with the overlay's credentials.)*
- While it is open it holds a slot so that the agent can run the app and tests: it leases one from the running
  worker (mechanism is the builder's choice, e.g. a lease row in SQLite that lanes respect, or a local-only server
  endpoint), and releases it on exit or after a stale-lease timeout. If no slot is free it can start without slot
  services after asking (`--no-slot`).
- Jobs for the ticket wait while the chat holds the ticket (treat the lease like a running job in the claim rule).
- On exit, if there are uncommitted changes or unpushed commits, `steward chat` says so; pushing happens through the
  `push` tool inside the session, like any agent run.

**Brain constraint.** Chat requires `brain.kind: "claude-code"` (openai-agents cannot resume). Config load rejects
chat settings otherwise, like `greptile`.

### Config

```ts
chat: {
  prefix: "/agent",              // default
  sessionRetentionDays: 180,     // default
}
```

(`sources` is dropped: GitLab is the only comment source.) Optional block; absent means no comment-driven chat (the terminal command still works for resumable sessions).

## Part 2b: Linear becomes labels-only

Every steward write to Linear other than labels moves to GitLab or goes away *(my calls, following the owner's rule)*:

- **Implement and fix loop**: results, hand-backs, loop status and restart notices are posted on the **MR**, not the
  ticket. The steward still swaps labels on the ticket (`agent-implemented`, `ready-for-human`, …) so the board shows
  state; label changes are the steward's only Linear writes.
- **Restarting a handed-back loop**: today the restart reads Linear comments since the hand-back. Instead it reads MR
  notes since the hand-back (from Developer+ humans, excluding bots and the steward), and a `/agent` note on a
  handed-back loop's MR is itself the way to restart it, so re-applying the label is no longer needed (it still works).
- **Enrich is removed** (the owner's call: `ready-for-agent` covers it; implement already works without an enrich
  brief). Remove the `enrich` job kind, its pipeline, prompt, triage/repro output handling, the description rewrite,
  and the `needs-triage` trigger; Linear issue-created webhooks no longer enqueue anything unless the ticket carries
  the implement label. Queued or failed `enrich` jobs in the live DB are marked failed with a clear error at
  migration, never run. `extractAgentBrief` stays so tickets enriched in the past still pass their brief to implement.
  Config keys that only served enrich (`prompt`, `tracker.gatewayIssues`, `tracker.bugLabels`, enrich-only labels) are
  rejected with a "removed" message like other retired keys, and docs/ops.md and the example config drop them.
  *(Exact list is the builder's to confirm from the schema.)*
- `TrackerClient.postComment`, `writeDescription` and `uploadFile` lose their callers; remove them with their tests.

## Part 3: Orbit for the steward's agents

**What's verified on the dev host:** native `glab` 1.125.0 with the Orbit CLI 0.161.0; the remote service is healthy
and `concentrateai` / `concentrateai/kickoff` are fully indexed; `glab orbit context mr:<iid>` returns MR data; the
local graph indexes kickoff in about 2 s. Orbit's local graph (DuckDB) crashes under the snap-packaged `glab`, so the
image must use the native binary.

**Design.**

- The image includes native `glab` and the Orbit CLI at a pinned version (installed at build time, checksum-verified,
  not auto-updated at runtime).
- The brain loads only project settings (`settingSources: ["project"]`) and may not touch `CLAUDE_CONFIG_DIR`, so
  `orbit setup`'s user-level files would be ignored. Instead *(my call)*: the Orbit skill goes into the steward's
  skills dir (copied into each worktree's `.claude/skills` like other skills), and the Orbit usage instructions go into
  the implement and fix prompts. No PreToolUse hook that forbids grep.
- **Local** queries (`orbit grep`, `orbit context` on code) run in the agent's shell; they need no credentials.
- **Remote** queries never put a GitLab token in the agent's environment, keeping the ops.md promise that the brain
  receives no GitLab, Linear or Greptile credentials. They go through a steward-launched stdio MCP server (the brain
  already receives steward MCP servers through `BrainInput.mcpServers`) exposing read-only tools (graph query, schema,
  MR/issue/job context), which holds the existing **`GITLAB_TOKEN`** (project access token, `api` scope, which includes
  `read_api`; the owner's call) in its own environment only. First build step: verify the Orbit API accepts a project
  access token and record what it can see (expected: `concentrateai/kickoff`, possibly not the rest of the group). Remote failures (paused trial, credits exhausted, network) return a tool error and never fail the
  job.
- **Local**: each worktree is indexed before the brain starts (`orbit workspace index .`, bounded by a timeout; a
  failed index logs a warning and does not fail the job). The index location goes under `dataDir` so it persists and
  is swept with its worktree.
- Doctor gains an Orbit check: binary present and version, remote reachable with the configured token (warn, not
  fail).

## Order of work

1. Linear becomes labels-only and enrich is removed (Part 2b). Independent of the container; first, since it shrinks
   the code the later parts touch.
2. Container stack (Part 1) including migration of the live host. Shippable alone.
3. The `push` tool and agent commits, moving implement and fix onto them; then session retention and worktree
   re-creation, the `chat` job kind on MR notes, and `steward chat` (Part 2).
4. Orbit in the image and agent config (Part 3). Can run in parallel with 3 after 2.

## Left to the builder

- Exact base images and versions (pin everything; no `latest`).
- The slot-lease mechanism for terminal chat.
- How the socket server is run inside `slot-helper`, as long as the protocol and one-process-per-connection hold.
- Healthchecks and restart policies in Compose.
- Whether Orbit agent config is generated at build or at start.
