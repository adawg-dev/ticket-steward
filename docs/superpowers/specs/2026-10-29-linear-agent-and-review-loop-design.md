# Linear agent seat, live sessions and a reviewer-agnostic MR loop

Status: draft for review. Builds on `feat/k3s` (run protocol, dispatcher internal API, durable sessions in MinIO)
and on follow-ups A–C (prompt rules, decisions log, media). Two parts, built in order; both use one steering channel.

## Why

Replicas takes a Linear ticket the way a colleague does: you assign it, and the ticket shows a live panel of what the
agent is thinking and doing that anyone can type into. The steward today is triggered by a label, talks to Linear with
a personal API key, shows nothing until it finishes, and only acts on Greptile's review. We want the same experience
in our own infra, without long-lived tokens and without credentials on the agent.

## Goals

- The steward is a Linear app with its own seat. Assigning a ticket to it is the only way to start a job.
- While it works, the ticket's agent panel shows its narration, one line per tool call, a plan, and the MR link.
- Anyone who can see the ticket can steer it from the panel; the message is picked up when the current tool call
  finishes. Linear's "Send stop request" halts it.
- An @mention on a ticket it has worked on resumes that ticket's durable session.
- On the MR, every comment from a person or a bot is work: the agent changes code or replies. Greptile is one reviewer
  among others, not the loop's driver.

## Non-goals

- A force-send / mid-step interrupt for ordinary messages (Linear has none; stop is the only interrupt).
- Our own web UI for sessions (the later CLI/MCP/UI project may add one).
- Starting jobs from mentions, labels or comments on tickets the steward never had.

## Anti-goals

- Any Linear or GitLab credential reaching the agent container.
- Raw command output, file contents, `STEWARD_PH_` placeholders or guard values in the Linear panel (it is visible to
  the whole workspace).
- The steward and a review bot arguing indefinitely.
- A stored refresh token or other long-lived Linear secret written by the steward.

## Part 1: Linear agent

### App and auth (decided)
- One OAuth app, installed by a Linear admin for the whole workspace with `actor=app` and scopes
  `read,write,app:assignable,app:mentionable`. Webhooks: Agent session events, Permission changes, Issues.
- Tokens: client-credentials grant (`POST https://api.linear.app/oauth/token`, `grant_type=client_credentials`).
  Client id and secret live in Secrets Manager as `DEV_STEWARD_LINEAR_CLIENT_ID` / `DEV_STEWARD_LINEAR_CLIENT_SECRET`
  and are read the way other `DEV_*` secrets are. The access token is held in dispatcher memory only, re-minted daily
  and on a 401, and revoked on shutdown. `viewer { id }` gives the app's user id, used to recognise delegation.
- `LINEAR_API_KEY` and the label trigger (`tracker.labels`) are removed. Webhook signature verification is unchanged.
- To verify during install: a client-credentials token can create activities in sessions for the app's seat. If it
  cannot, fall back to the authorization-code flow with `actor=app`, its rotating refresh token kept in Secrets
  Manager (the dispatcher's role gains `PutSecretValue` on that one secret). This is the only acceptable fallback.

### Triggers (decided)
- `AgentSessionEvent created` with the issue delegated to the steward and no loop for it → implement job.
  The webhook is acknowledged at once (Linear allows 5 s); a `thought` ("Picked this up") is posted within 10 s.
- `created` from a mention: ticket has a session → chat run resuming it, with the comment as the message; ticket never
  had one → a single `response`: "Assign me to the ticket to start work."
- `prompted`: a run for the ticket is active → steering message; none is → chat run resuming the session.
- `prompted` with signal `stop` → interrupt the run; post a final `response` saying where it got to.
- Delegate removed from the issue (Issue webhook) → stop the run; the loop goes to `unassigned`; branch and MR are
  left as they are. While unassigned the steward ignores Linear prompts and MR comments, except a mention. Linear's own
  "archive the agent session?" prompt handles the panel; an archived session can be restored in Linear.
- Revive: an @mention of the steward on an unassigned ticket it has worked on (in a Linear comment, or an MR note
  addressed to it with the existing chat prefix) sets the steward back as the issue's delegate and resumes the session
  with that comment as the message. A ticket it never had gets "Assign me to the ticket to start work."
- Reassigning a ticket that already has a branch resumes from the MR head; it never starts a second implement.
- Stop (`prompted` with `stop`) ends the run with a new outcome `stopped` that is not retried (unlike shutdown's
  `interrupted`); the steward stays delegated and the next prompt, mention or person's MR comment resumes it.
- Replying to an `elicitation` from an implement run continues that implement job (same session; push, MR, loop as
  usual). A prompt asking for new work after the MR exists runs as a chat that may push; the loop picks up the push.
- A prompt that arrives while a person holds a terminal `steward chat` lease waits for the lease; the panel says so.

### Workflow state (decided)
- On delegation, move the issue to the team's first `started` state if it is not already started or later.
- When the MR opens, move it to the configured review state (default name "In Review"). Hand-back leaves it there;
  the panel says why. These replace the outcome labels (`agent-implemented` etc.), which are removed with the trigger.
  Existing label-driven loops keep running; their label swaps become no-ops.
- Linear opens a new session per mention; all of a ticket's Linear sessions map to its one Claude session. A new table
  records `linearSessionId → issueId` and which session is current (the latest); activities go to the current one.

### What the panel shows (decided)
| Brain event | Activity |
|---|---|
| Assistant text | `thought` (consecutive text coalesced) |
| Tool call starts | `action`, ephemeral, e.g. `Editing` / `src/x.ts`, `Running` / first line of the command ≤ 80 chars |
| Edit, write, command finishes | `action` with result `ok` / `failed (exit 1)`; reads and searches stay ephemeral |
| TodoWrite | session `plan` |
| Result `questions` | `elicitation` |
| Result done | `response`: summary, checks, media embeds |
| Failure | `error` |
| MR opened | `externalUrls` gains the MR |
| Fix rounds, MR replies | same mapping, into the ticket's current session |

Everything posted passes the run redactor plus placeholder and guard-value stripping. Posting is rate limited per
session (target ≤ 1 activity / 2 s; ephemeral activities are dropped first when behind).

### Steering channel (decided)
- The Claude Code brain feeds `query()` an input stream instead of a single prompt. A steering message is pushed as a
  user message and the SDK delivers it between turns; stop calls `interrupt()` and the run ends with outcome `stopped`.
- Local executor: messages reach the detached runner over its existing IPC.
- Kubernetes: run-pod posts brain events to `POST /internal/runs/:id/events` and long-polls
  `GET /internal/runs/:id/steer`, both with the per-run token. The dispatcher alone talks to Linear.
- The same channel carries MR comments that arrive mid-run (Part 2).

## Part 2: every MR comment is work

### Rules (decided)
- Any new note on the steward's MR from a person or bot wakes the loop; the steward's own notes never do. The
  `@steward` prefix is no longer needed. GitLab's Developer-role minimum for people stays.
- Notes are batched over a quiet window (default 2 min, `review.quietMinutes`) into one round.
- A round's work list is every discussion whose latest note is not the steward's and which is unresolved. For each, the
  agent changes code and replies with what it did, or replies only (question, disagreement). It never resolves threads.
- Lasting instructions in any comment ("keep X", "don't touch Y") are recorded as decisions (follow-up B) and shown in
  every later round.
- Done = nothing on the work list and the head pipeline green; then the loop waits, and a new comment starts a round.
- Rounds started only by bot notes or a red pipeline are capped (existing max-rounds setting); at the cap the loop
  hands back with a note. A round started by a person resets the count and people always get a round.
- CI triage before a red pipeline counts as a round:
  - A failed job whose `failure_reason` is infrastructure (runner_system_failure, stuck_or_timeout_failure,
    api_failure, job_execution_timeout, scheduler_failure, no_matching_runner and similar; list kept in code) is
    retried; no round is counted.
  - A job that looks flaky is retried once per job per commit; no round is counted, and the panel says so. Flaky
    means: GitLab's MR test report shows the failing tests failing recently on the default branch, or (when remote
    Orbit works for the bot) an Orbit graph query finds the same job name failing on the default branch, or failing
    then passing on retry (`Job.retried`) on other refs, within the lookback window.
  - Still red after the retry, or no flaky signal: a normal round; the run is told the triage result.
  - Without remote Orbit, triage uses the test report and failure reason only. Retry limit, lookback window and
    triage on/off are settings.
- A note that arrives mid-run is passed into the run as context only; the next round answers it in its thread, and no
  discussion is answered twice.
- With Greptile configured the loop still requests a review after each push and waits for it, with today's review,
  pipeline and MR timeouts and hand-backs.
- Greptile, when configured: its findings are work like any other comment. When its confidence on the head commit
  reaches `greptile.passScore` (default 5), bot-started rounds end even if bot notes remain. (Greptile edits one summary
  note instead of posting at 5/5, so silence alone cannot mean "approved".)
- A person pushing to the branch still stops the loop; a person's next comment restarts it on the new head (replaces
  the `restart` keyword).

## Settings and the CLI (decided)
- Behaviour introduced here is a runtime setting, stored in the dispatcher DB, seeded from the config file, read on
  each use, and changed through the admin API (`GET/PATCH /admin/settings`, schema-validated, audit-logged with who
  and when). The CLI gets `steward settings get|set`; the later MCP and UI use the same API. Settings at least:
  quiet window, bot-round cap, Greptile pass score and on/off, review state name, start-state move on/off, revive by
  mention on/off, panel activity rate. Credentials and anything security-relevant (allowlists, guards) are not settings.
- CLI commands that touch Linear go through the dispatcher's admin API; the CLI never holds a Linear token.
  `steward implement` keeps only `--dry-run` (prompt preview); assigning is the only way to start a job.
- The Linear app requires the `claude-code` brain; config validation refuses another brain with it.

## Left to the builder
- Exact table/column names, the coalescing algorithm, retry/backoff for Linear calls, and how the existing Greptile
  loop code is reshaped (rename vs. new module), as long as existing loops in the DB keep working after migration.

## Constraints
- No `any`. TDD; typecheck, lint and tests green per commit.
- Credentials stay in the dispatcher; the agent container gets none.
