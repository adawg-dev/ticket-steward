# Linear Agent Seat and Reviewer-Agnostic Review Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The steward becomes a Linear app that is started by assignment, shows its work live in Linear's agent panel,
can be steered from it, and treats every MR comment (not just Greptile's) as work, with CI triage for flaky failures.

**Architecture:** A dispatcher-only Linear client (client-credentials token in memory) handles agent-session webhooks
and posts activities. Brain messages flow from the runner (local IPC, or run pod → internal API) to an activity mapper;
steering flows back through the same channel into the Claude Code SDK's streaming input. The Greptile loop is reshaped
into a review loop whose work list is the MR's unanswered discussions; Greptile becomes an optional reviewer.

**Tech Stack:** TypeScript (ESM), zod, fastify, better-sqlite3, `@anthropic-ai/claude-agent-sdk`, `@linear/sdk`,
vitest.

**Spec:** `docs/superpowers/specs/2026-10-29-linear-agent-and-review-loop-design.md` .

**Prerequisites:** `feat/k3s` with the k3s work committed. Follow-ups A–C (below, first) come before Task 1; Task 15 extends B.

## Global Constraints

- Never typecast to `any`. TDD: failing test first. `npm run typecheck && npm run lint && npm test` green per commit.
- One commit per task; messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Never push.
- No Linear or GitLab credential reaches the agent container or the CLI. The Linear token lives only in dispatcher memory.
- Linear secrets: `DEV_STEWARD_LINEAR_CLIENT_ID`, `DEV_STEWARD_LINEAR_CLIENT_SECRET` (Secrets Manager, read like other
  `DEV_*` values). `LINEAR_API_KEY` and `tracker.labels` are removed.
- OAuth scopes requested: `read,write,app:assignable,app:mentionable`.
- Linear deadlines: webhook answered < 5 s; first activity < 10 s after `created`.
- Nothing posted to Linear contains raw command output, file contents, `STEWARD_PH_` values or guard values.
- Settings defaults: `review.quietMinutes` 2, bot-round cap = `greptile.maxRounds` (5), `greptile.passScore` 5,
  `linear.reviewStateName` "In Review", `linear.moveToStarted` true, `linear.reviveByMention` true,
  `linear.activityIntervalMs` 2000, `ci.triage` true, `ci.retryLimit` 1, `ci.lookbackDays` 14.
- The Linear app requires `brain.kind: "claude-code"`.

## Review Focus

1. A Linear webhook redelivery (same `Linear-Delivery`) → acted on once. Test in Task 5.
2. A `prompted` stop arriving after the run already finished → no error, one final `response`, no second job. Task 9.
3. A burst of 200 tool calls in 10 s → Linear sees ≤ 6 activities, final `response` never dropped. Task 6.
4. A bot that comments on every push → rounds stop at the cap with one hand-back note, not one per push. Task 13.
5. Steward's own MR replies and Linear-echoed comments never wake the loop (no self-triggering). Tasks 12, 5.

---

## Follow-ups A–C (do these first)

These come from the 2026-10-28 prompt review (inspired by another managed-agent product's system prompt). Each is one
task with TDD, gates and one commit. Task B's `decisions` and Task C's media are used by later tasks.

### Task A text: `prompts/repo.md` (also `examples/kickoff/prompts/repo.md`), verbatim

````markdown
## Working in kickoff

- The repo's rules are in `CLAUDE.md` files, at the root and in directories. They apply to you: read the root one and the one nearest every file you change before editing.
- pnpm workspaces and Turborepo. Workspaces import each other from `dist/`: after changing a package under `packages/`, `service/` or `api/`, run `pnpm build` in that package (and in any workspace between it and the one you are testing) before testing a consumer. Type-check can stay green while the runtime breaks.
- Never hand-edit `pnpm-lock.yaml`; use `pnpm add <pkg>@<version> --filter <name>` and commit what pnpm writes.
- The local services (Postgres with TimescaleDB, Redis, RabbitMQ) are this run's own and were reset for you. Their hosts and ports are in the workspace's `.env` files; never assume the defaults.
- To check a user-app change in the browser, follow the `steward-user-app-verify` skill: it starts the app on your port and logs in as a seeded persona through the dev-auth route.
````

### Task A text: shared rules, verbatim

Additions to the Rules list in implement.md, fix.md and chat.md (numbering continues each prompt's list):

N. Credentials are not yours to find. Never look for tokens, keys or passwords in environment variables, repository files, `.env` files or secret stores, and never try to reach GitLab, Linear or a model API with one: use your tools, which already carry the access they need. A value in a `.env` file that starts with `STEWARD_PH_` is a placeholder the steward's proxy swaps for the real value on its way to the service it belongs to. Use it as it is; never print, replace or try to reveal what it stands for.
N+1. Start long-running processes (the app, a dev server, a watcher) only when a check needs them, run every other command in the foreground, and stop what you started before you finish. A background command must have an end: something that tells you it finished or failed.

Additions to each prompt's Result section (after the checksRun line):

- Report what happened, not what you hoped: a check that failed, timed out or that you skipped goes in `checksRun` with that result and why. Never describe a check you did not run as passing. When something is done and verified, say so plainly.

Include `{{> repo}}` after the "Codebase graph" section in all three prompts; the steward renders `prompts/repo.md` from the config's prompts directory as that partial (empty when the file is missing).


### Task A: Prompt improvements
- Add `prompts/repo.md` (draft: repo.md here) and `examples/kickoff/prompts/repo.md`; render it as Mustache partial `repo` in
  implement, fix and chat prompts (`render(template, vars, { repo }, { escape: verbatim })`; empty string when missing).
- Apply shared-rules.md to the three prompts.
- Test: each prompt renders the partial; a missing repo.md renders nothing and no `{{> repo}}` text.

### Task B: Decisions log
- Chat result gains `decisions: string[]`: lasting instructions a person gave about this MR ("keep X", "don't Y"),
  one line each, restated from what they said, never inferred. Empty when none.
- `loops.decisions` (JSON array, migration). finishChat appends new ones (deduped) to the ticket's loop.
- fix.md: section "Decisions a person made on this merge request: never undo these" listing them; chat.md shows the
  current list so the agent doesn't re-add or contradict them.
- Tests: a chat result with decisions → stored on the loop; the next fix prompt contains them; duplicates not added.

### Task C: Media on the MR
- Playwright MCP gets `--caps=devtools --output-dir <artifactsDir>` (video: browser_start_video/browser_stop_video).
- implement/fix/chat results gain `media: Array<{ path: string; caption: string }>` (max 10).
- Prompts: UI change → screenshots; an interaction or flow → a short video (start before, stop after, one chapter
  per step with browser_video_chapter); list each in `media` with a one-line caption.
- Uploader `uploadMedia(gitlab, projectId, artifactsDir, media)`: realpath must stay inside artifactsDir (no symlinks
  out), extensions png/jpg/jpeg/gif/webp/mp4/webm only, ≤25 MB each, ≤10 files; GitLab `POST /projects/:id/uploads`
  → markdown embed. Rejected items are listed by reason, never fail the job.
- Where: LocalExecutor path uploads in finish; Kubernetes path uploads from the tools sidecar (`POST /media` on
  127.0.0.1:4181, called by run-pod with the result's media list; returns the embeds, which go into RunReport).
- Embeds go into the implement-summary note (stored with the implement result, posted when the MR appears), the fix
  round note and the chat reply.
- Tests: symlink escaping artifacts rejected; .exe rejected; 26 MB rejected; embeds appear in the summary note.

---

### Task 1: Runtime settings

**Files:** Create `src/settings/schema.ts`, `src/settings/store.ts`, `src/cli/settings.ts`; modify `src/store/db.ts`
(table `settings(key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_by TEXT NOT NULL, updated_at TEXT NOT NULL)`,
table `settings_audit(id INTEGER PRIMARY KEY AUTOINCREMENT, key, old_value, new_value, updated_by, updated_at)`),
`src/store/index.ts`, `src/server/admin.ts`, `src/cli/client.ts`, `src/cli/program.ts`.
Tests: `test/settings/store.test.ts`, `test/server/admin.test.ts`, `test/cli/settings.test.ts`.

**Interfaces — Produces:**
- `SettingsSchema` (zod object, every key from Global Constraints with its default) and `type Settings`.
- `seedSettings(config: StewardConfig): Settings` — config values (e.g. `greptile.maxRounds`) override defaults.
- `class SettingsStore { constructor(db, seed: Settings); get(): Settings; set(patch: Partial<Settings>, by: string): Settings; audit(limit: number): SettingsChange[] }`
  — `get` reads DB rows over the seed on every call; `set` validates the merged result, writes rows and audit rows in one
  transaction, throws `SettingsError` on invalid values.
- Admin routes `GET /api/settings` → `Settings`; `PATCH /api/settings` body `Partial<Settings>` → `Settings` (400 on
  invalid); `updated_by` = `"admin-cli"` unless the body carries `by`.
- `AdminClient.settings(): Promise<Settings>`, `AdminClient.setSettings(patch): Promise<Settings>`.
- CLI `steward settings get [key]` and `steward settings set <key> <value>` (value parsed as JSON, else string).

- [ ] Tests: `get` returns seed when DB empty; `set({ "review.quietMinutes": 5 }, "x")` then `get()` → 5 and one audit
  row with old 2/new 5; `set({ "review.quietMinutes": -1 })` throws and changes nothing; an unknown key is rejected;
  PATCH with invalid body → 400; CLI `set review.quietMinutes 5` calls PATCH with `{ "review.quietMinutes": 5 }`.
- [ ] Run `npx vitest run test/settings test/server/admin.test.ts test/cli/settings.test.ts` → FAIL.
- [ ] Implement. Security-relevant keys are not in the schema at all (no allowlists, guards, credentials).
- [ ] Run → PASS; full gates; commit `feat(settings): runtime settings in the DB, admin API and CLI`.

### Task 2: Linear OAuth token and tracker

**Files:** Create `src/tracker/linear/auth.ts`; modify `src/tracker/linear/client.ts`, `src/tracker/linear/index.ts`,
`src/config/schema.ts`, `src/config/secretSource.ts` (required names), `src/tracker/types.ts`, `src/tracker/readOnly.ts`,
`src/cli/doctor.ts`. Tests: `test/tracker/linear/auth.test.ts`, `test/tracker/linear/client.test.ts`, `test/config/*.test.ts`.

**Interfaces — Produces:**
- `interface LinearToken { get(): Promise<string>; invalidate(rejected: string): void; revoke(): Promise<void> }`
- `createClientCredentialsToken(p: { clientId: string; clientSecret: string; scopes: string[]; fetchImpl: typeof fetch; now: () => number; maxAgeMs?: number }): LinearToken`
  — `POST https://api.linear.app/oauth/token` form `grant_type=client_credentials&scope=read,write,app:assignable,app:mentionable`,
  HTTP Basic client auth; caches in memory; re-mints when older than `maxAgeMs` (default 24 h) or after `invalidate`
  with the current token; concurrent `get` calls share one mint; `revoke` posts to `https://api.linear.app/oauth/revoke`.
- `LinearTracker` constructor takes `LinearToken` (uses `accessToken`, re-creates `LinearClient` when the token changes);
  on a 401 calls `invalidate` and retries once, then `apiKeyRejected()` (rename to `credentialsRejected()`) is true.
- `Tracker` loses `swapLabel`; gains `appUserId(): Promise<string>` (`viewer { id }`, cached).
- Config: `tracker.labels` becomes `removed("tracker.labels: assign the steward in Linear instead (docs/ops.md)")`;
  superRefine: `tracker.kind === "linear"` requires `brain.kind === "claude-code"`; `implement requires tracker.labels`
  check removed.
- `createLinearTracker(secrets, deps)` requires `DEV_STEWARD_LINEAR_CLIENT_ID`/`_SECRET`; message names them.

- [ ] Tests: first `get` mints once with the exact form body and Basic header; two concurrent `get` → one fetch;
  `invalidate(current)` → next `get` mints; `invalidate(stale)` does not; token older than 24 h re-minted; tracker 401 →
  one re-mint and retry; second 401 → `credentialsRejected()` true; config with `labels` fails with the message above;
  openai-agents brain with linear tracker fails.
- [ ] FAIL → implement → PASS; gates; commit `feat(linear): client-credentials token held in memory; labels removed`.

### Task 3: CLI reaches Linear only through the dispatcher

**Files:** Modify `src/cli/runtime.ts` (`openTracker` → admin-backed read-only tracker), `src/cli/implement.ts`
(only `--dry-run`), `src/cli/fix.ts` (remove; `restart` replaced by Task 11), `src/cli/sessions.ts`, `src/cli/program.ts`,
`src/server/admin.ts` (`GET /api/tickets/:key/bundle` → `TicketBundle`), `src/cli/client.ts`.
Tests: `test/cli/implement.test.ts`, `test/cli/runtime.test.ts`, `test/server/admin.test.ts`.

**Interfaces — Produces:** `adminTracker(client: AdminClient): Pick<Tracker, "resolveIssueId" | "fetchTicket" | "readDescription">`;
`AdminClient.ticketBundle(key): Promise<TicketBundle>`.

- [ ] Tests: `steward implement ENG-1` without `--dry-run` exits non-zero with "assign the steward in Linear to start
  work"; `--dry-run` renders the prompt from the admin bundle; no CLI code path reads `DEV_STEWARD_LINEAR_*`
  (test asserts `buildRuntime` for a CLI command never calls the secret source for those names); `steward fix` is gone.
- [ ] FAIL → implement → PASS; gates; commit `feat(cli): Linear reads go through the dispatcher; implement is dry-run only`.

### Task 4: Linear agent API client

**Files:** Create `src/tracker/linear/agent.ts`. Test: `test/tracker/linear/agent.test.ts` (fake GraphQL fetch).

**Interfaces — Produces:**
```ts
type ActivityContent =
  | { type: "thought"; body: string }
  | { type: "action"; action: string; parameter: string; result?: string }
  | { type: "elicitation"; body: string }
  | { type: "response"; body: string }
  | { type: "error"; body: string };
interface PlanStep { content: string; status: "pending" | "inProgress" | "completed" | "canceled" }
interface LinearAgentApi {
  createActivity(sessionId: string, content: ActivityContent, opts?: { ephemeral?: boolean }): Promise<void>;
  setExternalUrls(sessionId: string, urls: Array<{ label: string; url: string }>): Promise<void>;
  setPlan(sessionId: string, plan: PlanStep[]): Promise<void>;
  setDelegate(issueId: string, appUserId: string | null): Promise<void>;
  moveToState(issueId: string, which: { type: "started" } | { name: string }): Promise<"moved" | "already" | "missing">;
  issueState(issueId: string): Promise<{ type: string; name: string }>;
}
createLinearAgentApi(token: LinearToken, fetchImpl: typeof fetch): LinearAgentApi
```
Mutations: `agentActivityCreate(input: { agentSessionId, content, ephemeral })`, `agentSessionUpdate(id, input: { externalUrls | plan })`,
`issueUpdate(id, input: { delegateId })`, `issueUpdate(id, input: { stateId })` with the team's states from
`team.states` (started = lowest `position` of type `started`). `ephemeral` only allowed on thought/action — throw otherwise.

- [ ] Tests: exact GraphQL variables for each call; `ephemeral` on response throws; `moveToState({type:"started"})` on
  an issue already `started`/`completed` → "already" with no mutation; missing named state → "missing".
- [ ] FAIL → implement → PASS; gates; commit `feat(linear): agent session activities, plan, delegate and state API`.

### Task 5: Agent-session webhooks and intake

**Files:** Rewrite `src/tracker/linear/webhook.ts`; modify `src/tracker/types.ts` (`TriggerEvent`), `src/server/app.ts`,
`src/store/db.ts` (table `agent_sessions(linear_session_id TEXT PRIMARY KEY, issue_id TEXT NOT NULL, identifier TEXT NOT NULL, created_at TEXT NOT NULL)`,
index on `issue_id`), create `src/store/agentSessions.ts`, `src/linear/intake.ts`.
Tests: `test/tracker/linear/webhook.test.ts`, `test/linear/intake.test.ts`, `test/server/app.test.ts`.

**Interfaces — Produces:**
```ts
type LinearEvent =
  | { kind: "session.created"; deliveryId: string; sessionId: string; issueId: string; identifier: string; teamKey: string; delegated: boolean; commentBody: string | null; promptContext: string }
  | { kind: "session.prompted"; deliveryId: string; sessionId: string; issueId: string; identifier: string; teamKey: string; body: string; stop: boolean; authorName: string }
  | { kind: "issue.undelegated"; deliveryId: string; issueId: string; identifier: string; teamKey: string };
parseLinearEvent(headers: { event?: string; delivery?: string }, body: unknown, appUserId: string): LinearEvent | null
class AgentSessionStore { record(sessionId, issueId, identifier): void; current(issueId): string | null; issueOf(sessionId): string | null }
type LinearIntakeAction = "implement" | "resume_implement" | "chat" | "steer" | "stop" | "assign_me" | "unassign" | "revive" | "ignored" | "duplicate" | "wait_for_lease";
linearIntake(deps, event: LinearEvent): Promise<{ action: LinearIntakeAction; jobId?: number }>
```
`TriggerEvent` gains `{ kind: "linear"; issueId; identifier; teamKey; sessionId: string; message: string | null }`;
`issue.created`/`issue.labeled` and `LabelAction` are removed. `issue.undelegated` = Issue webhook whose `updatedFrom`
has `delegateId === appUserId` and the new `delegateId` differs.
Decision table (`linearIntake`), using `deliveries` for dedupe and `agentSessions.record` on every session event:
- created + delegated + no loop/implement job for the issue → `implement` (enqueue implement job, subject `issue:<id>`).
- created + delegated + loop exists → `revive` path of Task 11 (resume from MR head).
- created by mention: loop `unassigned` and `linear.reviveByMention` → `revive`; any loop/session → `chat`
  (message = `commentBody`); none → `assign_me`.
- prompted + `stop` → `stop` (Task 9 cancels the run). prompted + a run active for the issue → `steer`. prompted + the
  latest implement job ended `needs_info` → `resume_implement`. prompted + chat lease held → `wait_for_lease` (job
  enqueued with `not_before` re-checked by the worker). Otherwise → `chat`. Loop `unassigned` → `ignored`.
- undelegated → `unassign` (Task 11).
`/webhooks/linear` replies 200 before any Linear API call; intake work that calls Linear runs after the reply.

- [ ] Tests: each decision row above; same delivery twice → second `duplicate`; an Issue webhook for an unrelated
  delegate change → null; a `created` from a comment the steward itself wrote (author = app user) → `ignored`;
  route returns 200 within the handler without awaiting Linear (fake LinearAgentApi never resolves; request still completes).
- [ ] FAIL → implement → PASS; gates; commit `feat(linear): assignment and agent-session webhooks replace the label trigger`.

### Task 6: Activity mapper and poster

**Files:** Create `src/linear/activities.ts`, `src/linear/poster.ts`. Tests: `test/linear/activities.test.ts`, `test/linear/poster.test.ts`.

**Interfaces — Produces:**
```ts
type PanelEvent = { activity: ActivityContent; ephemeral: boolean } | { plan: PlanStep[] };
mapBrainLine(line: string, scrub: (text: string) => string): PanelEvent[]   // one SDKMessage JSON line
class ActivityPoster { constructor(p: { api: LinearAgentApi; sessionId: () => string | null; intervalMs: () => number; now: () => number; setTimer: typeof setTimeout }); push(e: PanelEvent): void; flush(): Promise<void> }
```
Mapping: assistant `text` blocks → `thought` (adjacent texts joined); `tool_use` → ephemeral `action`
(`Edit|Write|MultiEdit` → "Editing"/path relative to worktree; `Bash` → "Running"/first line ≤ 80 chars;
`Read|Grep|Glob` → "Reading"/"Searching"; `mcp__push__*` → "Pushing"; `mcp__playwright__*` → "Browsing";
others → tool name); its `tool_result` → non-ephemeral `action` with `result` "ok" or "failed" (`is_error`) for
Edit/Write/Bash/push only, nothing for reads; `TodoWrite` input → `{ plan }`. Never include tool input beyond the
parameter above or any tool output. `scrub` = run redactor + `/STEWARD_PH_[A-Z0-9_]+/g` → "[placeholder]" + guard values.
Poster: at most one Linear call per `intervalMs()`; when behind, drop queued ephemeral events first, then merge queued
thoughts; plan updates collapse to the latest; `flush` sends everything left except ephemerals.

- [ ] Tests (fixtures of real SDK message shapes): Bash tool_use → `{type:"action",action:"Running",parameter:"pnpm test"}`
  ephemeral; a Bash command containing `STEWARD_PH_DB_0123456789abcdef` → "[placeholder]"; tool_result content never
  appears in any output; TodoWrite → plan with statuses mapped (`in_progress` → `inProgress`); 200 pushes in 10 s with
  intervalMs 2000 → ≤ 6 calls and every non-ephemeral thought text present in the sent bodies.
- [ ] FAIL → implement → PASS; gates; commit `feat(linear): map brain messages to panel activities with rate limiting`.

### Task 7: Steering and stop in the brain

**Files:** Modify `src/brain/types.ts`, `src/brain/claudeCode.ts`, `src/brain/runner.ts`, `src/brain/spawn.ts`,
`src/brain/openaiAgents.ts` (rejects steering: control calls are no-ops that log), `src/run/protocol.ts`, `src/run/execute.ts`.
Tests: `test/brain/claudeCode.test.ts`, `test/brain/spawn.test.ts`, `test/run/execute.test.ts`.

**Interfaces — Produces:**
- `interface BrainControl { steer(message: string): void; stop(): void }`; `Brain.run(input, onMessage, control?: BrainControlSink)`
  where `type BrainControlSink = (handlers: BrainControl) => void` lets the caller receive the handlers once the run starts.
- claude-code: prompt passed to `query()` as an `AsyncIterable<SDKUserMessage>` that yields the initial prompt, then
  each steered message (prefixed "Message from <who> while you were working:" by the caller, not the brain), and ends
  when the result arrives; `stop()` calls the query's `interrupt()` and the run returns `{ ok: false, error: STOPPED_ERROR }`.
- `STOPPED_ERROR = "stopped"` in `src/brain/types.ts`.
- Runner IPC: parent → child `{ type: "steer"; message: string }` and `{ type: "stop" }`; `runBrainDetached` gains
  `opts.control?: BrainControlSink`.
- `RunReportSchema` gains `stopped: z.boolean()` (default false when parsing older reports); `executeRun` sets it when
  the brain returned `STOPPED_ERROR`; a stopped report is never retried (`interrupted` stays false).
- `ExecuteEnv` gains `control?: BrainControlSink`.

- [ ] Tests: fake `queryImpl` that records yielded user messages — `steer("use v2")` mid-stream → second user message
  "use v2" delivered; `stop()` → `interrupt` called, result `stopped`; spawn test: steer over IPC reaches the child;
  report with `stopped: true` → job outcome failed-not-retryable with error "stopped by a person in Linear".
- [ ] FAIL → implement → PASS; gates; commit `feat(brain): steer and stop a running Claude Code session`.

### Task 8: Run channel (events out, steering in) for both executors

**Files:** Create `src/run/channel.ts`; modify `src/run/local.ts`, `src/server/internal.ts`, `src/run/pod.ts`,
`src/cli/runPod.ts`, `src/k8s/executor.ts`. Tests: `test/run/channel.test.ts`, `test/server/internal.test.ts`, `test/run/pod.test.ts`.

**Interfaces — Produces:**
```ts
class RunChannels {
  open(runId: string, onLine: (line: string) => void): void;
  close(runId: string): void;
  steer(runId: string, message: string): boolean;   // false when no such run
  stop(runId: string): boolean;
  next(runId: string, waitMs: number): Promise<Array<{ type: "steer"; message: string } | { type: "stop" }>>;
  line(runId: string, line: string): void;
  active(issueId: string): string | null;            // runId of the issue's open run
}
```
- Local: `LocalExecutor` opens the channel, passes `onLine` to the spawn's message handler (after redaction) and a
  `BrainControlSink` that drains `next` into `steer`/`stop`.
- Internal API (runner token): `POST /internal/runs/:runId/events` body `{ lines: string[] }` (≤ 200 lines, ≤ 1 MB);
  `GET /internal/runs/:runId/steer?waitMs=25000` long-poll returning `{ commands: [...] }` (empty after the wait).
- run-pod: batches brain lines (redacted in-pod as today) every 500 ms to `/events`; loops on `/steer` while the brain
  runs and applies commands via the control sink; tolerates 503/connection errors with backoff like `postReport`.

- [ ] Tests: steer before `next` is called is queued and returned; `next` resolves early when a command arrives; stop
  after close → false; events with the tools token → 401; > 200 lines → 400; pod test with fake fetch: a steer command
  from the poll reaches the fake brain control.
- [ ] FAIL → implement → PASS; gates; commit `feat(run): event and steering channel between runs and the dispatcher`.

### Task 9: Linear sessions follow the runs

**Files:** Create `src/linear/session.ts`; modify `src/implement/*` (start/finish), `src/greptile/fix.ts`,
`src/chat/run.ts`, `src/worker/loop.ts`, `src/server/app.ts` (wiring `linearIntake` steer/stop to `RunChannels`).
Tests: `test/linear/session.test.ts`, `test/implement/*.test.ts`, `test/chat/run.test.ts`.

**Interfaces — Produces:** `linearSessionFor(deps, issueId): { thought(text): void; poster: ActivityPoster | null; finish(content: ActivityContent): Promise<void>; setMrUrl(url): Promise<void> }`
— a no-op object when the issue has no agent session (CLI/old loops).
- Implement job start: `thought("Picked this up; reading the ticket")` posted from intake within 10 s (before the job
  is claimed, so a full queue still answers in time).
- During every run kind: channel `onLine` → `mapBrainLine` → poster.
- Finish: implement `done` → `response` (summary, checks, media embeds); `needs_info` → `elicitation` with the
  questions; failure → `error`; stopped → `response` "Stopped. Where I got to: …" (from the last thought + pushed sha).
  Fix round → `response` with the round summary; chat → `response` with the reply. MR opened → `setExternalUrls([{label:"Merge request",url}])`.
- `wait_for_lease` → `thought("Someone is in a terminal session on this ticket; I'll pick your message up when they leave")`.
- `PermissionChange` webhooks are logged (team access lost → `error` activity on that team's open sessions).
- Steer text sent to the brain: `Message from ${authorName} in Linear while you were working:\n${body}`.
- `resume_implement` (Task 5) enqueues an implement job with `resumeSessionId` of the needs_info job and the reply as
  the message (implement prompt gets a `{{#reply}}` section).

- [ ] Tests: created → thought before job claimed; brain lines reach poster; stop after the run finished → one
  `response`, no error, no job; needs_info → elicitation, then prompted → implement resumed with the same session id
  and the reply in the prompt; issue without agent session → no Linear calls.
- [ ] FAIL → implement → PASS; gates; commit `feat(linear): live agent panel, steering and stop for every run`.

### Task 10: Workflow-state moves

**Files:** Modify `src/linear/session.ts`, `src/greptile/publish.ts` (remove `swapFromImplemented`; label swaps of
existing `labelDriven` loops become no-ops). Test: `test/linear/session.test.ts`, `test/greptile/publish.test.ts`.

- [ ] Tests: delegation with `linear.moveToStarted` → `moveToState({type:"started"})`; setting off → no call; MR opened →
  `moveToState({ name: settings["linear.reviewStateName"] })`; "missing" state → logged once, panel `thought` says the
  state was not found; hand-back → no state call.
- [ ] FAIL → implement → PASS; gates; commit `feat(linear): move tickets to started and review states`.

### Task 11: Unassign, revive, reassign

**Files:** Modify `src/store/loops.ts` (`LoopState` += `"unassigned"`, not active, not ended), `src/linear/intake.ts`,
`src/chat/intake.ts` (an `/agent` note on an unassigned loop → revive), `src/greptile/start.ts` (`runRestart` becomes
`resumeLoop` from MR head for revive/reassign; `restart` keyword path removed), `src/worker/loop.ts`.
Tests: `test/linear/intake.test.ts`, `test/chat/intake.test.ts`, `test/greptile/start.test.ts`, `test/store/loops.test.ts`.

**Interfaces — Produces:** `unassignTicket(deps, issueId): Promise<void>` (stop active run via `RunChannels.stop`,
cancel queued jobs for the loop, loop → `unassigned`); `reviveTicket(deps, issueId, message: string, from: "linear" | "gitlab"): Promise<number>`
(`setDelegate(issueId, appUserId)`, loop → awaiting state via `resumeLoop` on MR head, enqueue chat with `message`).

- [ ] Tests: undelegate mid-fix → run stopped, loop `unassigned`, branch untouched; MR note from a person on an
  unassigned loop without `/agent` → ignored; `/agent please continue` → delegate set, loop resumed, chat enqueued;
  re-delegation of a ticket with branch+MR → no implement job, loop resumed at MR head; mention on a ticket never
  handled → `assign_me` response; DB row with state `unassigned` reads back as `unassigned` (not `stopped`).
- [ ] FAIL → implement → PASS; gates; commit `feat(loop): unassigning pauses the steward; a mention revives it`.

### Task 12: Every MR note wakes the loop

**Files:** Modify `src/chat/intake.ts`, `src/codehost/gitlabWebhook.ts`, `src/store/loops.ts` (column `pending_notes_since TEXT`
via `ADDED_COLUMNS`), `src/worker/loop.ts`. Tests: `test/chat/intake.test.ts`, `test/server/app.test.ts`.

**Interfaces — Produces:** `noteIntake(deps, event, note): Promise<"queued_round" | "steered" | "chat" | "ignored" | "denied" | "revive">`
- Steward's own notes (marker) → ignored. People below Developer → denied. `/agent`-prefixed notes keep the chat path.
- Any other note (person or bot) on an active or passed loop: a run active for the ticket → `steered` with text
  `New comment from ${author} on the MR (answer it in the next round, not now):\n${body}`; otherwise set
  `pending_notes_since` (if null) and enqueue an `await_review` job with `not_before = now + quietMinutes` (one queued
  job per loop; later notes don't extend past `pending_notes_since + 2 × quietMinutes`).
- Unassigned/stopped/ended loops → ignored (revive only via `/agent`).

- [ ] Tests: 10 notes in 30 s → one queued job; steward note → ignored; Greptile note → queued; note during a running fix →
  steered, no new job; note from Reporter role → denied; note on unassigned loop → ignored.
- [ ] FAIL → implement → PASS; gates; commit `feat(review): every MR comment wakes the loop after a quiet window`.

### Task 13: Reviewer-agnostic round evaluation

**Files:** Modify `src/greptile/evaluate.ts`, `src/greptile/await.ts`, `src/greptile/fix.ts`, `src/greptile/summary.ts`,
`src/store/loops.ts` (column `bot_rounds INTEGER NOT NULL DEFAULT 0`), `src/config/schema.ts` (`greptile` optional,
`passScore` added), `prompts/fix.md`, `examples/kickoff/prompts/fix.md`.
Tests: `test/greptile/evaluate.test.ts`, `test/greptile/fix.test.ts`.

**Interfaces — Produces:**
- `workList(discussions: MrDiscussion[], stewardUsername: string): WorkItem[]` with
  `interface WorkItem { discussionId: string; author: string; isBot: boolean; body: string; position: NotePosition | null }`
  — unresolved discussions whose latest note is not the steward's.
- `RoundInput` gains `workList: WorkItem[]`, `startedBy: "person" | "bot"`, `greptile: GreptileSummary | null` (null
  when unconfigured), `settings: Settings`; `findings` input removed (Greptile findings are discussions).
- Decision order after existing MR/sha/closed checks: Greptile configured and not reviewed head → existing wait/timeout;
  pipeline unfinished → existing wait; Greptile `confidence ≥ passScore` on head and `startedBy === "bot"` → `passed`;
  work list empty and pipeline green → `passed`; `startedBy === "bot"` and `bot_rounds ≥ cap` → `handback`
  ("stopped after N rounds started by bots; a person's comment starts another"); else `fix` with the work list.
- `bot_rounds` += 1 on a bot-started round (no person note in the batch, or only a red pipeline); reset to 0 by a
  person-started round.
- fix.md: findings section becomes "Comments to answer" (each item: author, location, body); instructions: for each,
  change code and reply with what changed, or reply only; never resolve threads; the existing fix result's per-thread
  replies field is reused.

- [ ] Tests: work list skips resolved and steward-last discussions; Greptile 5/5 on head with only bot notes → passed;
  Greptile 5/5 with an unanswered person note → fix; no Greptile configured, empty list, green → passed; 5 bot rounds →
  handback with the exact reason; person note after that → fix and `bot_rounds` 0; red pipeline only → bot round.
- [ ] FAIL → implement → PASS; gates; commit `feat(review): every comment is work; Greptile is one reviewer`.

### Task 14: CI triage

**Files:** Create `src/greptile/triage.ts`; modify `src/codehost/gitlabMr.ts` (`FailedJob` += `failureReason: string | null`;
new `retryJob(project, jobId): Promise<void>`, `testReport(project, pipelineId): Promise<Array<{ name: string; status: string }>>`,
`recentPipelines(project, ref: string, sinceIso: string): Promise<PipelineRef[]>`), `src/orbit/*` (query helper),
`src/greptile/evaluate.ts`, `src/store/loops.ts` (column `ci_retries TEXT NOT NULL DEFAULT '{}'`: job name → sha retried on).
Tests: `test/greptile/triage.test.ts`, `test/codehost/gitlabMr.test.ts`.

**Interfaces — Produces:**
`triageFailures(deps: { gitlab: GitLabMrApi; orbit: OrbitQuery | null; settings: Settings; now: Date }, loop: Loop, failed: FailedJob[]): Promise<{ retry: FailedJob[]; real: FailedJob[]; notes: string[] }>`
- `INFRA_FAILURE_REASONS` = `runner_system_failure, stuck_or_timeout_failure, api_failure, job_execution_timeout,
  scheduler_failure, no_matching_runner, stuck_pending_no_matching_runners, stuck_pending_with_matching_runners,
  runner_unsupported, data_integrity_failure, job_execution_server_timeout, server_timeout_running, job_router_failure,
  job_token_expired` → retry (not limited by `retryLimit`, but at most 2 per job per sha).
- Flaky (only when `retryLimit` not used up for this job+sha): a failing test name from `testReport` also failed in a
  default-branch pipeline in `lookbackDays`; or, with Orbit, `MATCH (j:Job) WHERE j.project_id = $p AND j.name = $n AND j.status = 'failed' AND j.ref = $default RETURN count(j) AS n` > 0,
  or the same with `j.retried = true` on other refs > 0. (Single-property filters only; one query per signal.)
- `OrbitQuery` = `(cypher: string) => Promise<unknown>`; null when remote Orbit is unavailable (startup probe; a 403
  logs once and leaves it null).
- A round whose only failures were all retried does not count and does not run the agent; panel thought + MR note:
  "Retried <job> (looked flaky: <signal>)". Notes from triage go into the fix prompt as "CI triage" when a round runs.

- [ ] Tests: `runner_system_failure` → retried, no round; flaky signal from test report → retried once, second failure on
  the same sha → real; Orbit null → test-report only; Orbit 403 → null without throwing; `ci.triage` false → all real.
- [ ] FAIL → implement → PASS; gates; commit `feat(ci): retry infrastructure and flaky failures before a fix round`.

### Task 15: Decisions from MR comments

**Files:** Modify `src/greptile/result.ts` (fix result gains `decisions: string[]` like chat's), `src/greptile/fix.ts`
(append via follow-up B's dedupe helper), `prompts/fix.md`. Test: `test/greptile/fix.test.ts`.

- [ ] Tests: fix result with `decisions: ["keep the v1 endpoint"]` → stored on the loop; next fix prompt lists it under
  "Decisions a person made on this merge request: never undo these"; a decision from a bot-authored comment is
  dropped (the prompt asks only for people's instructions; the finish step keeps decisions whose quoted author is a person).
- [ ] FAIL → implement → PASS; gates; commit `feat(review): record people's lasting instructions from any MR comment`.

### Task 16: Docs, doctor and manifests

**Files:** `docs/ops.md` (Linear app setup: create OAuth app, actor=app install by admin for the whole workspace,
scopes, webhooks Agent session events + Permission changes + Issues, enable client-credentials tokens, verify step from
the spec, fallback note), `docs/k8s.md` (two new SM secrets), `src/cli/doctor.ts` (mint a token, `viewer { id }`,
check webhook secret set, warn when labels config remains), `deploy/k8s/*` (secret names), example config.
Test: `test/cli/doctor.test.ts`.

- [ ] Tests: doctor reports "Linear app: ok (user <id>)" with a fake mint; mint 401 → failing check naming the two secrets.
- [ ] FAIL → implement → PASS; gates; commit `docs(linear): app install, secrets and doctor checks`.

## Out of scope / later
- Cut-over on the live Compose stack: after the Linear app exists, set the two secrets, remove `tracker.labels` from
  `/etc/ticket-steward/steward.config.ts`, deploy, assign a test ticket. Done by hand with the user, not in this plan.
