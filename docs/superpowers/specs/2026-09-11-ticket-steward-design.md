# Ticket Steward — Design Spec

**Date:** 2026-09-11
**Status:** Approved for planning. Design decisions were delegated by the owner during
brainstorming; this revision incorporates a three-lens adversarial review (feasibility,
design, operations/security).

## 1. What it is

Ticket Steward is a standalone bot that watches an issue tracker for new tickets, runs a
coding agent against a fresh checkout of a monorepo, and writes the agent's findings back
into the ticket so whoever picks it up knows where to look, what is missing from the
ticket, and what the fix likely involves.

It is a single Node/TypeScript project with a CLI and a long-running server mode. It is
not part of any application monorepo; the monorepo it enriches is just configuration.

### Non-goals (v1)

- It does not gate, triage, relabel, or move tickets between states. Triage flow is owned
  by the tracker and its Pylon/Slack integrations.
- It does not write code, open branches, or open merge requests. The code-host adapter is
  read-only. Its interface leaves room for that later.
- It does not provision a dev environment. It assumes it runs on a machine that is already
  a working dev box for the target repo.
- It does not support multiple repos or repo routing. One steward instance, one monorepo.
- It is not containerized and it is not a kernel-level sandbox. The brain's tool policy is
  a guardrail against agent mistakes; the real limits are a dedicated OS user, a read-only
  git mirror, an allowlisted environment, and sandbox credentials in the overlay (§12).

## 2. Decisions

| Topic | Decision |
| --- | --- |
| Relationship to existing code | Standalone repo `ticket-steward`. Kickoff's `IssueResolverAgent` is prior art only. |
| What the bot changes on a ticket | Writes an **Enrichment** section into the ticket description (replacing any previous one). For `issue.created` and `cli` triggers it also posts a short comment. For agent-session triggers it emits a `response` activity instead of a comment. Prompt is configurable. No state or label changes. |
| Repo mapping | Always exactly one monorepo. |
| Trigger and identity | Registered as a **Linear Agent** (OAuth app, `actor=app`, scopes `read,write,comments:create,app:assignable,app:mentionable`). Triggers: issue created; agent @mentioned, delegated, or prompted in an existing session. Webhooks come with the app. |
| Who writes to Linear | The **steward** does all writes. The brain returns a structured result. The brain gets no tracker credentials. |
| Attachments | The brain saves files (e.g. Playwright screenshots) into a per-job artifacts dir and lists them in its result. The steward validates, uploads, and embeds them. |
| Runtime | Plain Node process on a provisioned dev VM, under systemd, as a **dedicated `steward` OS user** with its own HOME. Shared services (Postgres, Redis, RabbitMQ, docker) already run on the host. |
| Repo access | The steward owns a **bare mirror** under its data dir, fetched with a read-only token. Worktrees are cut from the mirror. The developer's checkout is never touched. |
| Env files for the checkout | A **workspace overlay** directory mirrors the repo's gitignored env files at their relative paths and is copied into each worktree. It must hold sandbox credentials created for the steward, not a copy of a developer's. |
| Code host integration | Permalinks, plus resolving commits that touched relevant paths (found with `git log` in the worktree) to their merge requests / pull requests. Write operations out of scope. |
| Persistence | SQLite (WAL, busy timeout), single file, in-process worker loop. No Redis. |
| Re-run semantics | Enrich once on creation. Ignore later edits. Re-run only on agent session or CLI. Each run replaces the Enrichment section wholesale. |
| Concurrency | One brain run at a time, enforced by a lock file shared by `serve` and inline `enrich`. Each job runs the brain in its own detached process group with a fixed `STEWARD_PORT`. |
| Brains | Pluggable. `claude-code` (Claude Agent SDK) first. `openai-agents` (OpenAI Agents SDK) second. Same interface, same result contract. |
| Code hosts | `gitlab` first, `github` second. |
| CLI | `init`, `doctor`, `auth`, `serve`, `enrich`, `jobs`, `templates`, `prompt`, `overlay`, `mirror`, `mcp`. See §9. |

## 3. Architecture

```
                 ┌──────────────┐   tx: delivery+job   ┌────────────────────────────────────────┐
  Linear  ──────▶│ Fastify      │────────────────────▶ │ Store (SQLite, WAL)                     │
  (agent app)    │ /webhooks    │◀── 200 ──            │  jobs · attempts · deliveries · tokens  │
                 └──────┬───────┘                      │  oauth_state · flags                    │
                        │ after reply: thought activity└──────────────────┬─────────────────────┘
                        ▼                                                 │ claim (lock held)
                    Linear API                                            ▼
                                   ┌──────────────────────────────────────────────────────┐
                                   │ Pipeline runJob(ctx, deps)                            │
                                   │  1. tracker.fetchTicket → TicketBundle                │
                                   │  2. workspace.create → worktree(mirror) + overlay     │
                                   │     + skills + setup                                  │
                                   │  3. prompt.render(bundle, ctx)                        │
                                   │  4. brain.run (detached process group) → output       │
                                   │  5. result.validate → BrainResult (persisted)         │
                                   │  6. attachments: contain, type, size → upload         │
                                   │  7. render section; tracker.readDescription (fresh)   │
                                   │     → replaceSection → tracker.writeDescription       │
                                   │  8. comment (created/cli) or session response         │
                                   │  9. workspace.destroy; kill process group; port check │
                                   └──────┬───────────────┬───────────────┬────────────────┘
                                          │               │               │
                                   ┌──────▼─────┐  ┌──────▼──────┐  ┌─────▼──────┐
                                   │ Tracker    │  │ Brain       │  │ CodeHost   │
                                   │ linear     │  │ claude-code │  │ gitlab     │
                                   │            │  │ openai-ag.  │  │ github     │
                                   └────────────┘  └─────────────┘  └────────────┘
```

Every arrow between the pipeline and an adapter goes through an interface in
`src/<adapter>/types.ts`. The pipeline is tested with in-memory fakes of all three plus a
real temporary git mirror.

### 3.1 Directory layout

```
ticket-steward/
  package.json  tsconfig.json  eslint.config.js  vitest.config.ts  README.md  LICENSE
  bin/steward.js                      # #!/usr/bin/env node → dist/cli/main.js
  prompts/enrich.md                   # default enrichment prompt (copied by `steward init`)
  examples/kickoff/                   # steward.config.ts, .env.example, skills/ for the kickoff monorepo
  ops/ticket-steward.service          # hardened systemd unit template
  docs/ops.md                         # dedicated user, mirror token, overlay credentials, tunnel
  src/
    index.ts                          # public exports: defineConfig, types
    cli/
      main.ts init.ts doctor.ts auth.ts serve.ts enrich.ts jobs.ts templates.ts prompt.ts overlay.ts mirror.ts mcp.ts
    config/
      schema.ts                       # zod schema + StewardConfig + defineConfig()
      load.ts                         # locate config (cwd or --config), jiti with alias, parse .env into Secrets (never into process.env)
    core/
      types.ts                        # RunContext, JobOutcome
      intake.ts                       # shouldEnqueue(): pure decision for webhook + cli triggers
      pipeline.ts                     # runJob(ctx, deps)
      context.ts                      # TicketBundle → ticket.md / templates.md text
      prompt.ts                       # renderPrompt(template, vars)
      result.ts                       # BrainResult zod (lenient for brains), brainResultJsonSchema, validateResult()
      render.ts                       # buildEnrichmentSection(result, meta), replaceSection(), linkify(), truncate()
      attachments.ts                  # resolveAttachments(): containment, extension/MIME, size
      redact.ts                       # Redactor built from known secret values + patterns
      lock.ts                         # acquireRunLock(dataDir): exclusive lock file
    tracker/
      types.ts                        # Tracker, TicketBundle, TriggerEvent, AgentSessionPort
      readOnly.ts                     # ReadOnlyTracker decorator (dry-run)
      linear/
        client.ts                     # LinearTracker: @linear/sdk wrapper
        auth.ts                       # authorize URL (state), code exchange, single-flight store-authoritative refresh
        webhook.ts                    # verifySignature(), parseEvent()
        templates.ts                  # Template → { name, description, body, requiredFields }
    codehost/
      types.ts                        # CodeHost, ChangeRef
      gitlab.ts github.ts
      server.ts                       # stdio MCP server: recent_changes, permalink
    brain/
      types.ts                        # Brain, BrainInput, BrainRun
      env.ts                          # buildBrainEnv(): explicit allowlist
      runner.ts                       # child-process entry: runs a brain in a detached process group, IPC back
      spawn.ts                        # spawnBrain(): fork runner, timeout, kill group
      policy.ts                       # tool policy shared by both brains (deny list for Bash/Edit/Write)
      claudeCode.ts                   # Claude Agent SDK runner (hooks: PreToolUse → policy)
      openaiAgents.ts                 # OpenAI Agents SDK runner
      tools/                          # function tools for openai-agents: read_file, grep_repo, list_dir, run_shell, write_file
    workspace/
      mirror.ts                       # ensureMirror(), fetch(), resolveSha()
      worktree.ts                     # create(jobId, attempt): prune, remove-if-exists, add; destroy(); gitEnv()
      overlay.ts                      # copyOverlay() (0600, refuses tracked paths, optional port rewrite), syncFromCheckout()
      skills.ts                       # copySkills(): steward-owned skills into <worktree>/.claude/skills
      setup.ts                        # runSetup(): commands with own timeout, capped output tail
      retention.ts                    # sweep(): worktrees, artifacts, transcripts, deliveries
    store/
      db.ts                           # open (0600), WAL, busy_timeout, migrate
      jobs.ts                         # JobStore
      attempts.ts                     # AttemptStore
      deliveries.ts                   # DeliveryStore
      tokens.ts                       # TokenStore (+ oauth_state, auth_broken flag)
    server/
      app.ts                          # buildServer(deps): /health, /webhooks/linear, /oauth/linear/callback
    worker/
      loop.ts                         # startWorker(deps): claim, run, finish, sweep, SIGTERM handling
    log.ts                            # pino with redact
  test/
    fakes/                            # FakeTracker, FakeBrain, FakeCodeHost, tmpMirror()
    <mirrors src>/*.test.ts
```

## 4. Core contracts

### 4.1 TriggerEvent and intake

```ts
type TriggerEvent =
  | { kind: "issue.created"; issueId: string; identifier: string; teamKey: string; deliveryId: string; description: string }
  | { kind: "agent.session"; action: "created" | "prompted"; issueId: string; identifier: string; teamKey: string; sessionId: string; deliveryId: string; promptBody?: string }
  | { kind: "cli"; issueId: string; identifier: string; teamKey: string };
```

`core/intake.ts` exports a pure function:

```ts
shouldEnqueue(input: {
  event: TriggerEvent;
  allowlist: string[];          // team keys; empty means all
  priorSuccess: boolean;        // store.hasSucceeded(issueId)
  hasQueuedJob: boolean;        // store.findQueued(issueId) !== null
}): { action: "enqueue" } | { action: "attach" } | { action: "skip"; reason: string }
```

Rules:

- Team not in allowlist → `skip` for every kind. For `agent.session` the webhook handler
  additionally emits a `response` activity "Ticket Steward is not configured for team X".
  For `cli` the command exits non-zero with the reason.
- `issue.created` → `skip` when `priorSuccess`, or when `event.description` (from the
  webhook payload, no API call) already contains the steward marker.
- Any kind → `attach` when a `queued` job already exists for the issue: the store updates
  that row with the session id and prompt body instead of inserting a second job.
- Otherwise → `enqueue`.

Webhook retries are handled before intake: `DeliveryStore.markSeen(deliveryId)` returns
false for a repeat, and the handler answers 200 without further work. The delivery row and
the job row are inserted in one transaction, so a crash cannot acknowledge a delivery
without recording its job.

### 4.2 TicketBundle

```ts
interface TicketBundle {
  id: string; identifier: string; url: string; title: string; description: string;
  team: { id: string; key: string; name: string };
  state: { name: string; type: string };
  labels: string[];
  priority: number;
  creator: { name: string; isBot: boolean } | null;
  createdAt: string;
  comments: Array<{ author: string; body: string; createdAt: string }>;
  attachments: Array<{ title: string; url: string }>;
  appliedTemplate: string | null;   // name resolved from Issue.lastAppliedTemplateId
  templates: Array<{ name: string; description: string; body: string; requiredFields: string[] }>;
}
```

`templates` are the workspace-level plus team-level issue templates fetched at job time.
`body` is `Template.content`. `requiredFields` comes from `templateData` form fields
flagged required when present, otherwise from bold `**Heading**` lines in `body`. The brain
decides which template the content matches; `appliedTemplate` is only a hint.

### 4.3 Tracker

```ts
interface Tracker {
  kind: "linear";
  resolveIssueId(idOrKey: string): Promise<{ id: string; identifier: string; teamKey: string }>;
  fetchTicket(issueId: string): Promise<TicketBundle>;
  readDescription(issueId: string): Promise<string>;
  writeDescription(issueId: string, description: string): Promise<void>;
  postComment(issueId: string, body: string): Promise<void>;
  uploadFile(localPath: string, contentType: string): Promise<{ url: string }>;
  agentSession: {
    thought(sessionId: string, body: string): Promise<void>;
    response(sessionId: string, body: string): Promise<void>;
    error(sessionId: string, body: string): Promise<void>;
  };
}
```

`ReadOnlyTracker` wraps any Tracker: reads pass through; writes are recorded and return
placeholders (`uploadFile` returns `file://<local path>`). Used by `enrich --dry-run`.

The Linear tracker retries each write locally (3 attempts, 500 ms → 2 s backoff) before
surfacing an error. `updateIssue`, `createComment`, `createAgentActivity`, and `fileUpload`
map one-to-one to `@linear/sdk` calls.

### 4.4 BrainInput / BrainRun

```ts
interface BrainInput {
  workspacePath: string;                 // the worktree
  artifactsDir: string;                  // outside the worktree, under <dataDir>/jobs/<jobId>/artifacts
  transcriptPath: string;                // <dataDir>/jobs/<jobId>/attempt-<n>.jsonl
  prompt: string;                        // fully rendered
  env: Record<string, string>;           // from buildBrainEnv(); the child's ENTIRE environment
  timeoutMs: number;
  maxTurns: number;
  model: string;
  mcpServers: Record<string, McpServerSpec>;   // codehost and playwright; both stdio with explicit command/args/env
  denyPaths: string[];                   // absolute paths the policy denies for Bash/Edit/Write: the mirror, the SQLite file, overlayDir (NOT dataDir itself, which contains the worktree and artifacts)
}
interface BrainRun {
  ok: boolean;
  output: unknown;                       // structured output, validated by the pipeline
  usage?: { inputTokens: number; outputTokens: number; costUsd?: number };
  error?: string;
}
```

`brain/spawn.ts` forks `brain/runner.ts` with `detached: true` and `env: input.env`
exactly (no inheritance), sends `BrainInput` over IPC, receives `BrainRun`, and on
completion, timeout, or SIGTERM kills the whole process group (`process.kill(-pid)`), so a
`next dev` or Chromium started by the brain cannot outlive the job.

`buildBrainEnv(secrets, config, port)` returns exactly: `PATH`, `HOME`, `LANG`, `TERM`,
`NODE_ENV=development`, `STEWARD_PORT`, `PORT` (same value), `GIT_CONFIG_GLOBAL=/dev/null`,
`GIT_TERMINAL_PROMPT=0`, `CI=1`, and the one brain credential set: `ANTHROPIC_API_KEY` or
`CLAUDE_CODE_OAUTH_TOKEN` for claude-code; `OPENAI_API_KEY` and optional `OPENAI_BASE_URL`
for openai-agents. Nothing else. A test asserts the exact key set.

### 4.5 BrainResult

```ts
export const BrainResult = z.object({
  template: z.object({
    matched: z.string().nullable(),
    conforms: z.boolean(),
    missing: z.array(z.string()),
  }),
  summary: z.string(),           // 1–3 sentences; render truncates to 600 chars
  enrichment: z.string(),        // markdown body of the Enrichment section
  attachments: z.array(z.object({ file: z.string(), caption: z.string() })),  // [] if none
  confidence: z.enum(["low", "medium", "high"]),
});
export const brainResultJsonSchema = z.toJSONSchema(BrainResult, { target: "draft-7" });
```

No `min`/`max`/`default` in the schema: Anthropic structured outputs strip length
constraints and OpenAI strict mode rejects optional properties. `validateResult(output)`
additionally requires non-empty `summary` and `enrichment` and fails the job otherwise.

### 4.6 Rendered Enrichment section

```
<!-- ticket-steward:begin -->
## Enrichment
_Ticket Steward · 2026-09-11 14:02 UTC · dev@1a2b3c4 · confidence: high · job 42_

**Template:** Bugs — missing: Repro Steps, Evidence

<enrichment markdown; `path/to/file.ts:123` → [path/to/file.ts:123](permalink)>

![caption](https://uploads.linear.app/...)
<!-- ticket-steward:end -->
```

`buildEnrichmentSection(result, meta: { now: Date; sha: string; branch: string; jobId: number; permalink: (path, line?) => string })`
is deterministic given its arguments. `replaceSection(description, section)` replaces
everything between the markers if present, otherwise appends after two newlines.

Write protocol (step 7): read the description fresh, `replaceSection`, write. The
pre-write description is stored on the attempt for diagnosis. The window between read and
write is milliseconds instead of the brain's run time.

Comment (only for `issue.created` and `cli`):

```
Enrichment added (job 42, confidence high). <summary>
@mention or assign me to re-run.
```

Agent sessions: the webhook handler emits `thought` "Queued. I will check out `dev`, read
the ticket, and enrich it." immediately after replying 200 (2 s timeout, logged on
failure, and the worker re-emits a `thought` when the brain starts, so the 10-second
responsiveness rule is met even if the first emit fails). On success the worker emits
`response` with the comment text. On failure it emits `error` with a one-line reason.

### 4.7 CodeHost

```ts
interface CodeHost {
  kind: "gitlab" | "github";
  permalink(path: string, sha: string, line?: number): string;
  changesForCommits(shas: string[]): Promise<ChangeRef[]>;   // resolves commits → MR/PR
}
interface ChangeRef {
  kind: "merge_request" | "commit";
  id: string; title: string; url: string; author: string; at: string; shas: string[];
}
```

`codehost/server.ts` is a stdio MCP server exposing:

- `recent_changes({ paths: string[], since_days?: number })` → runs
  `git log --since --format=%H%x1f%an%x1f%aI%x1f%s -- <paths>` in the worktree, then
  `changesForCommits` to attach MR/PR title and URL; returns a deduplicated list.
- `permalink({ path, line? })`.

The pipeline spawns it with `command: process.execPath`,
`args: [<abs bin/steward.js>, "mcp", "codehost", "--config", <abs config path>, "--workspace", <worktree>, "--sha", <sha>]`
and `env: { PATH, HOME, GITLAB_TOKEN | GITHUB_TOKEN }`. Nothing about it depends on cwd.

## 5. Store

SQLite via `better-sqlite3`, `journal_mode=WAL`, `busy_timeout=5000`, file mode 0600 in a
0700 `dataDir`. Tables: `jobs`, `attempts`, `deliveries`, `tokens`, `oauth_state`, `flags`.

```ts
interface JobStore {
  enqueue(event: TriggerEvent): number;                       // returns job id
  attachSession(issueId: string, sessionId: string, promptBody?: string): void;
  findQueued(issueId: string): Job | null;
  hasSucceeded(issueId: string): boolean;
  claimNext(): Job | null;                                    // atomic UPDATE … WHERE status='queued'
  claimById(id: number): Job | null;
  saveResult(id: number, result: BrainResult, sha: string): void;   // enables publish-only retry
  finish(id: number, outcome: JobOutcome): void;                  // terminal outcomes
  scheduleRetry(id: number, notBefore: Date, error: string): void; // back to queued, hidden from claimNext until notBefore
  requeue(id: number): boolean;                                   // steward jobs retry while serve is running
  get(id: number): Job | null;
  list(filter: { status?: JobStatus; limit: number }): Job[];
  requeueInterrupted(maxAttempts: number): { requeued: number; failed: number };
}
type JobStatus = "queued" | "running" | "succeeded" | "failed" | "publish_failed" | "skipped";
```

Attempts record `startedAt`, `finishedAt`, `error`, `setupTail`, `preWriteDescription`,
`transcriptPath`, `usage`. An attempt row is inserted at claim time, so a crash mid-run is
visible as an attempt without `finishedAt`.

Retry policy in the worker:

- Steps 1–2 failures (ticket fetch, mirror fetch, worktree, overlay, setup) are
  infrastructure errors: retry up to 3 attempts total with 1 min / 5 min backoff. Between
  attempts the job is `queued` with `not_before` set to the end of the backoff: `claimNext`
  skips it until then, `findQueued` still sees it (so a new trigger attaches instead of
  duplicating), `/health` counts it as queued, and a restart during the backoff loses
  nothing.
- Step 4–5 failures (brain timeout, max turns exhausted after the follow-up query, invalid
  output) are terminal: `failed`, no retry.
- Step 6–8 failures after `saveResult` → `publish_failed`. `steward jobs retry <id>`, or
  the automatic retry, resumes at step 6 using the stored result and artifacts, skipping
  the brain.
- On startup `requeueInterrupted` requeues `running` jobs with attempts < 3 and fails the
  rest with error `interrupted`.

## 6. Workspace

`dataDir` layout: `steward.db`, `repo.git/` (mirror), `work/<jobId>-<attempt>/` (worktrees),
`jobs/<jobId>/artifacts/`, `jobs/<jobId>/attempt-<n>.jsonl`, `run.lock`.

Per job:

1. `mirror.fetch()`: `git -C <dataDir>/repo.git fetch --prune origin` using the mirror's
   stored fetch URL (a read-only deploy token). `resolveSha("<baseBranch>")` (a mirror
   stores remote branches under `refs/heads`, so there is no `origin/` prefix; `resolveSha`
   accepts and strips one for convenience).
2. `worktree.create(jobId, attempt)`: `git worktree prune`; if the target path exists,
   `git worktree remove --force` it (fallback `rm -rf`); `git worktree add --detach <path> <sha>`;
   then `git -C <path> config --worktree remote.origin.pushurl /dev/null`
   (`extensions.worktreeConfig` enabled on the mirror).
3. `overlay.copy()`: each file under `overlayDir` is copied to the same relative path in
   the worktree with mode 0600. Refuses paths that are tracked in git. If
   `workspace.portRewrite` is set (default `{ from: 3000 }` in the kickoff example),
   occurrences of `localhost:<from>` and `127.0.0.1:<from>` in copied files are rewritten to
   the job's port.
4. `skills.copy()`: files under `workspace.skillsDir` are copied into
   `<worktree>/.claude/skills/`. This is how steward-specific skills (such as a
   browser-verify variant that reads `STEWARD_PORT`) reach the brain without editing the
   target repo.
5. `setup.run()`: each `workspace.setup` command runs in the worktree with the brain env,
   under `workspace.setupTimeoutMinutes` (default 15), output tail capped at 16 KB and
   stored on the attempt.
6. After the job: kill the brain process group, verify `STEWARD_PORT` is free (kill
   holders by pid via `lsof -t -i :PORT` if not), `git worktree remove --force`. If the job
   failed and `keepOnFailure` is true, keep the worktree; `retention.sweep()` keeps at most
   `retention.keptWorktrees` of them.

`steward mirror init` creates the mirror (`git clone --mirror <fetchUrl>`) and enables
`extensions.worktreeConfig`. `steward overlay sync --from <checkout>` copies gitignored
`.env*` files (excluding `node_modules`, `.next`, `dist`) into `overlayDir` with 0600/0700
modes and refuses when any value matches `/prod/i` unless `--allow-pattern` is given.

`retention.sweep()` runs on worker start and every hour: worktrees beyond the kept count,
artifacts and transcripts older than `retention.days` (default 30), deliveries older than
7 days.

## 7. Prompt

`prompts/enrich.md` is a Mustache template with variables: `{{ticket}}`, `{{templates}}`,
`{{workspacePath}}`, `{{baseBranch}}`, `{{sha}}`, `{{artifactsDir}}`, `{{teamKey}}`,
`{{teamName}}`, `{{stewardPort}}`, `{{operatorInstructions}}` (the `prompted` body, or
empty). The mirror path, data dir, and overlay dir are never rendered into the prompt.

The default prompt instructs the brain to:

1. Read the ticket. Decide which template it matches and which required fields are
   missing or still placeholder text.
2. Locate the relevant code: entry points, likely files, related tests, config, and recent
   changes to those paths (`recent_changes` tool).
3. State a probable cause or implementation approach and concrete next steps.
4. For UI tickets, if a screenshot would clarify the issue, start the app on
   `{{stewardPort}}` using the steward-provided skill, save screenshots under
   `{{artifactsDir}}`, and list them in `attachments`.
5. Reference files as `relative/path.ts:line`. Experimental edits in the worktree are
   fine; never commit, push, or touch anything outside the worktree and artifacts dir.
6. Finish with the structured result.

## 8. Brains

### 8.1 Shared policy (`brain/policy.ts`)

`evaluateTool({ name, input, workspacePath, artifactsDir, denyPaths })` returns
`allow | deny(reason)`:

- `Edit`/`Write`/`write_file`: deny unless the resolved path is under `workspacePath` or
  `artifactsDir`, and never under a `denyPaths` entry.
- `Bash`/`run_shell`: deny when the command text matches `git push`, `git commit`,
  `git remote`, `git worktree`, `git gc`, `git update-ref`, `curl … api.linear.app`, or
  references any `denyPaths` entry.
- Everything else: allow, plus `mcp__codehost__*` and `mcp__playwright__*` only.

This is a guardrail. The enforced limits are the OS user, the env allowlist, the mirror's
disabled push URL, and the overlay's sandbox credentials.

### 8.2 claude-code

`@anthropic-ai/claude-agent-sdk` `query()` with: `cwd: workspacePath`, `maxTurns`,
`model`, `permissionMode: "acceptEdits"`, `allowedTools: ["Read","Grep","Glob","Bash","Edit","Write","MultiEdit","WebFetch","mcp__codehost__*","mcp__playwright__*"]`,
`settingSources: ["project"]` (the worktree's `.claude/` and `CLAUDE.md`; never the user's
`~/.claude`), `mcpServers` from input, `outputFormat: { type: "json_schema", schema: brainResultJsonSchema }`,
and `hooks: { PreToolUse: [{ matcher: "Bash|Edit|Write|MultiEdit", hooks: [policyHook] }] }`
where `policyHook` returns `permissionDecision: "deny"` with the reason. Hooks run before
the permission flow, so `acceptEdits` and project allow rules cannot bypass the policy.

Every SDK message is appended to the transcript as a JSON line after redaction. If the
result is `error_max_turns`, one follow-up
`query({ prompt: "Stop investigating and emit the final structured result now.", options: { resume: sessionId, maxTurns: 2, outputFormat } })`
is issued. A `success` result without `structured_output` is treated as invalid output.
Wall-clock timeout aborts via `AbortController`; the runner's process group is killed
regardless.

Credentials: `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` (minted with
`claude setup-token`) must be present in `.env`. `doctor` fails otherwise. The steward
never relies on an interactive login.

### 8.3 openai-agents

`@openai/agents` `Agent` with `outputType: BrainResult` (zod), `MCPServerStdio` for the
same servers, and function tools `read_file`, `grep_repo`, `list_dir`, `run_shell`
(`shell: false`, args array, cwd pinned to the worktree), `write_file`, each calling
`evaluateTool` first. `OPENAI_BASE_URL` honored. Steward skills are appended to the prompt
as text because this SDK has no skill loader. Transcript from run items, redacted.

Both brains share one env-gated contract test (`STEWARD_LIVE_BRAIN=1`): fixture worktree +
ticket → output validates as `BrainResult`.

## 9. CLI

```
steward init                         # writes steward.config.ts, .env.example, prompts/enrich.md, skills/ into cwd
steward doctor                       # every check below, all reported, non-zero if any fails
steward auth linear                  # actor=app OAuth with state; temporary listener if serve is not running
steward mirror init | fetch          # create / refresh the bare mirror
steward overlay sync --from <path> [--allow-pattern <re>]
steward serve                        # server + worker; takes run.lock
steward enrich <KEY|UUID> [--dry-run]
steward jobs [--status s] [--limit n]
steward jobs show <id>               # row, attempts, transcript path, artifacts listing, stored result
steward jobs retry <id>              # requeue; publish-only if a result is stored
steward jobs gc                      # retention.sweep() now
steward templates                    # templates for workspace + allowlisted teams
steward prompt show | render <KEY>
steward mcp codehost --config <abs> --workspace <abs> --sha <sha>   # internal
```

`enrich`: resolves the key to a UUID via `tracker.resolveIssueId`, runs intake. If
`GET /health` on `server.port` answers, it enqueues and tails `jobs show` until terminal.
Otherwise it acquires `run.lock` and runs inline. `--dry-run` never touches the store: it
builds a `RunContext { dryRun: true }`, wraps the tracker in `ReadOnlyTracker`, runs the
pipeline, and prints the rendered section plus the recorded write calls.

`doctor` checks: config parses; `.env` has the brain credential and tracker/codehost
secrets; running user is not the owner of `~/.ssh` or `~/.kube` (warn) and dataDir/overlay
modes are 0700; mirror exists, has `extensions.worktreeConfig`, and `fetch` succeeds;
overlay has at least one file; skills dir exists; Linear token valid (`viewer` query) and
`auth_broken` flag clear; `publicUrl/health` answers; codehost MCP server starts and
answers `tools/list`; Playwright MCP binary present and Chromium installed; `STEWARD_PORT`
free.

## 10. Configuration

```ts
// steward.config.ts
import { defineConfig } from "ticket-steward";
export default defineConfig({
  dataDir: "/var/lib/ticket-steward",
  brain: { kind: "claude-code", model: "claude-opus-5", maxTurns: 80, timeoutMinutes: 30 },
  // brain: { kind: "openai-agents", model: "gpt-5.5", maxTurns: 80, timeoutMinutes: 30 },
  tracker: { kind: "linear", teams: ["API", "RSPNS", "MSGS", "CC", "USRAPP", "STFAPP", "APP", "OPS", "PLAT"] },
  codehost: { kind: "gitlab", baseUrl: "https://gitlab.com", project: "concentrateai/kickoff" },
  // codehost: { kind: "github", owner: "concentrateai", repo: "kickoff" },
  workspace: {
    fetchUrl: "https://gitlab.com/concentrateai/kickoff.git",   // token injected from MIRROR_TOKEN
    baseBranch: "dev",
    overlayDir: "/var/lib/ticket-steward/overlay",
    skillsDir: "./skills",
    setup: ["pnpm install --frozen-lockfile --ignore-scripts", "pnpm turbo build --filter='./packages/*'"],
    setupTimeoutMinutes: 15,
    portRewrite: { from: 3000 },
    port: 4100,
    keepOnFailure: true,
  },
  retention: { keptWorktrees: 3, days: 30 },
  prompt: "./prompts/enrich.md",
  server: { port: 3020, publicUrl: "https://steward.example.com" },
});
```

`.env` next to the config (parsed into a `Secrets` object, never loaded into
`process.env`): `LINEAR_CLIENT_ID`, `LINEAR_CLIENT_SECRET`, `LINEAR_WEBHOOK_SECRET`,
`MIRROR_TOKEN`, `GITLAB_TOKEN` or `GITHUB_TOKEN`, `ANTHROPIC_API_KEY` or
`CLAUDE_CODE_OAUTH_TOKEN`, `OPENAI_API_KEY`, `OPENAI_BASE_URL`.

`config/load.ts` uses jiti with `alias: { "ticket-steward": <package dist/index.js> }` so an
operator directory without `node_modules` can import `defineConfig`.

## 11. Server and worker

`POST /webhooks/linear` (raw body preserved):

1. Verify `Linear-Signature`: hex HMAC-SHA256 of the raw body with `LINEAR_WEBHOOK_SECRET`,
   timing-safe compare. Fail → 401. Signature is the authenticity check; delivery-id
   dedupe is the replay defence. No timestamp window (Linear's 1 h / 6 h retries would be
   rejected by one).
2. Parse: `Linear-Event: Issue` + `action: create` → `issue.created` (fields from `data`:
   `id`, `identifier`, `team.key`, `description`). `Linear-Event: AgentSessionEvent` +
   `action: created|prompted` → `agent.session` (`agentSession.id`, `agentSession.issueId`,
   `agentSession.issue.identifier`, `agentSession.issue.team.key`,
   `agentActivity.body ?? agentActivity.content.body`). Anything else → 200, ignored.
3. In one transaction: `markSeen(deliveryId)` (repeat → commit, 200) and intake →
   `enqueue` / `attachSession` / skip.
4. Reply 200.
5. After the reply (`onResponse` hook): for `agent.session`, emit the `thought` or the
   "not configured" `response` with a 2 s timeout, errors logged.

`GET /health` → `{ ok, authBroken, worker: { running: jobId | null }, counts: { queued, failedLast24h }, lastSuccessAt }`;
503 when `authBroken`.

`GET /oauth/linear/callback?code&state`: `state` must match a pending, unexpired row in
`oauth_state` (10 min TTL, deleted after use); otherwise 400. Exchange the code, store the
token pair, fetch `viewer.id` and store it as `appUserId`.

Linear auth (`tracker/linear/auth.ts`): tokens are read from the store before each
request. Refresh happens when the access token is within 5 minutes of expiry or on 401,
inside a single-flight promise per process and a `BEGIN IMMEDIATE` transaction that
re-reads the row and skips the network call if another process already rotated it. A
refresh failure sets `auth_broken`; the worker stops claiming, `/health` returns 503,
`doctor` reports it, and `steward auth linear` clears it.

Worker loop: acquire `run.lock`; `requeueInterrupted`; `retention.sweep()`; then loop:
claim → attempt row → `runJob` → `finish`; sleep 2 s when idle; sweep hourly. SIGTERM:
stop claiming, abort the brain, kill its process group, mark the attempt `interrupted` and
leave the job `queued` (or `failed` with error `interrupted` when that was its last
attempt), release the lock, exit 0.

## 12. Security posture

- **Dedicated user.** `steward` system user, own HOME, no ssh keys, no cloud or kube
  config, not in the `docker` group. Unit: `User=steward`, `ProtectSystem=strict`,
  `ProtectHome=yes`, `ReadWritePaths=<dataDir>`, `PrivateTmp=yes`, `NoNewPrivileges=yes`,
  `KillMode=control-group`, `TimeoutStopSec=120`, `Restart=on-failure`, `RestartSec=5`.
- **Environment allowlist.** The brain child receives exactly the keys in §4.4. Tracker,
  webhook, mirror, and codehost secrets never reach it.
- **Read-only repo.** Mirror fetch URL uses a read-only token; worktrees get
  `pushurl=/dev/null`; `GIT_CONFIG_GLOBAL=/dev/null` and `GIT_TERMINAL_PROMPT=0`.
- **Sandbox credentials.** The overlay must contain credentials created for the steward
  (own DB role, test-mode Stripe keys, provider keys with spend caps). `overlay sync`
  enforces file modes and refuses prod-looking values by default. `docs/ops.md` says why.
- **Redaction.** One `Redactor` built from every `.env` value, every credential-looking
  overlay value, and the Linear token pair, plus patterns (`sk-`, `glpat-`, `ghp_`,
  `lin_oauth_`, `postgres://…:…@`). Applied to transcript lines, setup tails, and to
  `summary`, `enrichment`, and captions before any tracker write. pino `redact` for
  headers. Transcripts and artifacts are 0600.
- **Attachments.** `realpath` must stay under `artifactsDir`; extension allowlist
  `png jpg jpeg gif webp txt log json`; 10 MB cap; violations dropped with a note in the
  section.
- **Webhook.** HMAC verification, delivery dedupe, OAuth `state`.

## 13. Error handling

| Failure | Behavior |
| --- | --- |
| Webhook signature invalid | 401, logged, nothing stored |
| Ticket fetch / mirror fetch / worktree / overlay / setup fails | Retryable (3 attempts) |
| Brain timeout, max turns after follow-up, invalid output | `failed`, no retry, session `error` if any |
| Attachment invalid or upload fails | Dropped with a note; job continues |
| Description write fails after adapter retries | `publish_failed`; retry resumes at publish |
| Comment or session response fails after description write | Job `succeeded` with a warning on the attempt |
| Linear refresh fails | `auth_broken`; worker pauses; health 503 |

## 14. Testing

- vitest, `globals: true`, ESM. `test/` mirrors `src/`.
- `runJob` is tested end to end with `FakeTracker`, `FakeBrain`, `FakeCodeHost`, and a
  real temporary bare mirror + worktree. Assertions go through the fakes' public methods
  (`tracker.getDescription(id)`, `tracker.comments(id)`, `tracker.sessionActivities(id)`),
  never through internals. Includes: fresh-description merge (description changed after
  the brain resolves must survive), publish-only retry, dry-run records writes, attachment
  containment, env allowlist exact key set.
- `intake` and `render` are pure and tested without fakes.
- Store tests use a tmp SQLite file and the store API only.
- Webhook tests use `app.inject()` with signed/unsigned/duplicate bodies and assert on
  status codes and on store state through the store API.
- Policy tests: `git push`, encoded variants that the regex does catch, writes outside the
  worktree, `denyPaths` references.
- Adapters and brains: unit tests mock the HTTP boundary; env-gated live contract tests.

## 15. Operations checklist for the owner

1. Create the `steward` system user, `dataDir` (0700), install Node 22+, pnpm, Playwright
   Chromium for that user (`npx playwright install chromium`). Set `ANTHROPIC_API_KEY` or
   run `claude setup-token` as that user and put the token in `.env`.
2. Create a **read-only** GitLab deploy token (or GitHub fine-grained read token) for the
   mirror → `MIRROR_TOKEN`. Create a read API token for MR lookups → `GITLAB_TOKEN`.
3. `steward init`, edit `steward.config.ts` (start from `examples/kickoff/`), `steward mirror init`.
4. Build a sandbox credential set for the overlay and run `steward overlay sync --from <checkout>`
   from a checkout whose env files hold those credentials.
5. Expose `server.port` at `publicUrl` (reverse proxy or tunnel).
6. In Linear Settings → Administration → API (admin), create OAuth app "Ticket Steward",
   redirect URL `<publicUrl>/oauth/linear/callback`; copy client id and secret.
7. In the app, enable webhooks at `<publicUrl>/webhooks/linear` with **Issues** and
   **Agent session events**; copy the signing secret.
8. `steward auth linear` as a workspace admin.
9. `steward doctor`, then install and start `ops/ticket-steward.service`.
10. Create a test ticket from the Bugs template; confirm the Enrichment section and comment.
    @mention the agent; confirm the session shows a thought and a response.

## 16. Verified platform facts

- Claude Agent SDK `@anthropic-ai/claude-agent-sdk`: `query({ prompt, options })`; options
  `cwd`, `allowedTools`, `permissionMode`, `canUseTool`, `hooks` (programmatic
  `PreToolUse`), `maxTurns`, `model`, `mcpServers` (`{ command, args, env }` or
  `{ type: "http", url, headers }`), `settingSources`, `resume`,
  `outputFormat: { type: "json_schema", schema }`; result `subtype` `success` |
  `error_max_turns` | …, `structured_output` on success. `canUseTool` only fires when the
  permission flow would prompt, so it is not a policy point; hooks are. Credential
  precedence: `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, stored login.
- Linear OAuth: `https://linear.app/oauth/authorize` with `actor=app`, `state`, scopes
  comma-separated; `https://api.linear.app/oauth/token` form-encoded; access token 24 h;
  refresh token rotates with a 30-minute replay grace. Delegation sets `delegate`.
- Linear webhooks: headers `Linear-Delivery`, `Linear-Event`, `Linear-Signature` (hex
  HMAC-SHA256 of raw body), `Linear-Timestamp`; retries at 1 min, 1 h, 6 h on non-200 or
  > 5 s. Issue `data` includes `id`, `identifier`, `description`, `team { key }`,
  `lastAppliedTemplateId`, `labelIds`, `state`, `creator`, `integrationSourceType`.
- `AgentSessionEvent`: `action created|prompted`; `agentSession { id, issueId, issue { id, identifier, title, description, team { key } } }`;
  `agentActivity` on `prompted`; `previousComments`; `guidance`; `promptContext`. First
  activity due within 10 s of `created`.
- `@linear/sdk`: `new LinearClient({ accessToken })`; `updateIssue(id, { description })`;
  `createComment({ issueId, body })`; `createAgentActivity({ agentSessionId, content: { type, body } })`
  with types `thought | action | response | error | elicitation`;
  `fileUpload(contentType, filename, size)` → PUT `uploadUrl` with returned headers plus
  `Cache-Control: public, max-age=31536000`, embed `assetUrl`; `issue(idOrIdentifier)`;
  `templates()`, `team.templates()`, `Template.content`, `Template.templateData`.
- GitLab: `GET /projects/:id/repository/commits/:sha/merge_requests`. GitHub:
  `GET /repos/{o}/{r}/commits/{sha}/pulls`. Neither MR/PR list API filters by path, hence
  `git log` for discovery.
- Linear's hosted MCP accepts a bearer token headlessly, but it is not used: the brain
  must not hold the app token.
