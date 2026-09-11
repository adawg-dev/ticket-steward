# Ticket Steward v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Spec:** `docs/superpowers/specs/2026-09-11-ticket-steward-design.md` (read it in full; section numbers below refer to it).

**Goal:** Ship a standalone Linear ticket-enrichment bot with a CLI, server mode, pluggable brains (Claude Agent SDK, OpenAI Agents SDK) and code hosts (GitLab, GitHub).

**Architecture:** Fastify webhook receiver → SQLite job store → single worker → `runJob` pipeline that cuts a worktree from a steward-owned bare mirror, runs a brain in a detached process group, validates a structured result, and publishes an Enrichment section back to Linear. Adapters (Tracker, Brain, CodeHost) sit behind interfaces and are faked in tests.

**Tech Stack:** Node 22 (ESM), TypeScript 5.9, zod 4, vitest 4, commander 15, fastify 5, better-sqlite3 13, @linear/sdk 95, @anthropic-ai/claude-agent-sdk 0.3.x, @openai/agents 0.18, @gitbeaker/rest 43, @octokit/rest 22, @modelcontextprotocol/sdk 1.30, @playwright/mcp 0.0.80, jiti 2, mustache 4, pino 10, execa 10.

## Global Constraints

- ESM only. Relative imports end in `.js`. Destructure imports.
- Never cast to `any`. No `ReturnType<typeof x>` in place of a real type. Types live next to their zod schemas and are exported from there.
- Tests: vitest with `globals: true`. Test the system's behavior through its public surface. No conditionals or array searches inside tests; assert exact positions and values. No reading SQLite or the filesystem to assert state that has a public accessor. Every test independent: fresh tmp dirs, fresh stores, `vi.restoreAllMocks()` in `beforeEach`. Mocks named `<fn>Mock`. Never assert on error message text, only on outcome/status.
- Secrets never enter `process.env`. `.env` is parsed into a `Secrets` object (§10).
- Brain child environment is exactly the allowlist in §4.4.
- Every task ends with `pnpm typecheck && pnpm lint && pnpm test -- <its own test files>` green and one commit using the message given in the task. Commit only the task's own files (`git add <paths>`; never `-A`).
- Plan and spec documents are the only place plan references appear. No task/sprint references in code, tests, or comments.
- Package manager: pnpm. Scripts: `build` (tsc), `typecheck` (tsc --noEmit), `lint` (eslint .), `test` (vitest run), `dev` (tsx src/cli/main.ts).

## Dependency graph

```
T1 scaffold
 ├── T2 config        ─┐
 ├── T3 core (pure)   ─┤
 ├── T4 store         ─┤
 ├── T5 tracker/linear─┼──▶ T9 pipeline + fakes ──▶ T10 server + worker ──▶ T11 CLI ──▶ T12 ops/docs/examples
 ├── T6 workspace     ─┤
 ├── T7 codehost      ─┤
 └── T8 brain         ─┘
```

Level 1 (T2–T8) tasks are independent: disjoint directories, all dependencies declared in T1's `package.json`. Cross-task types are fixed by the **Interfaces** blocks below; a task defines the interface it *produces* and imports the ones it *consumes* by the exact path given. If a consumed module does not exist yet in your worktree, create a minimal `types.ts` with exactly the declared shape so your task compiles; the owning task's version wins at merge (identical shape by construction).

## File map (who owns what)

| Task | Owns |
| --- | --- |
| T1 | `package.json`, `pnpm-lock.yaml`, `tsconfig.json`, `eslint.config.js`, `vitest.config.ts`, `bin/steward.js`, `LICENSE`, `src/index.ts`, `src/log.ts`, `.env.example` |
| T2 | `src/config/**`, `test/config/**` |
| T3 | `src/core/{types,intake,result,render,prompt,context,attachments,redact,lock}.ts`, `prompts/enrich.md`, `test/core/**` (except pipeline) |
| T4 | `src/store/**`, `test/store/**` |
| T5 | `src/tracker/**`, `test/tracker/**` |
| T6 | `src/workspace/**`, `test/workspace/**` |
| T7 | `src/codehost/**`, `test/codehost/**` |
| T8 | `src/brain/**`, `test/brain/**` |
| T9 | `src/core/pipeline.ts`, `test/fakes/**`, `test/core/pipeline.test.ts` |
| T10 | `src/server/**`, `src/worker/**`, `test/server/**`, `test/worker/**` |
| T11 | `src/cli/**`, `test/cli/**` |
| T12 | `ops/**`, `docs/ops.md`, `examples/**`, `README.md` |

---

### Task 1: Scaffold

**Files:** all in the T1 row above.

**Steps:**

- [ ] `package.json`: name `ticket-steward`, `"type": "module"`, `bin: { steward: "bin/steward.js" }`, `exports: { ".": "./dist/index.js" }`, `engines.node ">=22"`, scripts from Global Constraints, dependencies pinned with `^` at the versions in Tech Stack, devDependencies: typescript ^5.9, vitest ^4, tsx ^4, eslint ^9, typescript-eslint ^8, @types/node ^22, @types/better-sqlite3, @types/mustache.
- [ ] `tsconfig.json`: `module: NodeNext`, `moduleResolution: NodeNext`, `target: ES2022`, `strict: true`, `noUncheckedIndexedAccess: true`, `exactOptionalPropertyTypes: true`, `outDir: dist`, `rootDir: src`, `include: ["src"]`. A second `tsconfig.test.json` extends it with `include: ["src","test"]`, `noEmit: true`; `typecheck` script uses `-p tsconfig.test.json`.
- [ ] `eslint.config.js`: flat config, typescript-eslint recommended, rule `@typescript-eslint/no-explicit-any: error`.
- [ ] `vitest.config.ts`: `globals: true`, `include: ["test/**/*.test.ts"]`, `testTimeout: 20000`.
- [ ] `bin/steward.js`: `#!/usr/bin/env node` + `import "../dist/cli/main.js";`.
- [ ] `src/index.ts`: `export { defineConfig } from "./config/schema.js"; export type { StewardConfig } from "./config/schema.js";` (T2 supplies the module; create a placeholder `src/config/schema.ts` exporting `defineConfig = <T>(c: T) => c` and `type StewardConfig = unknown` so the scaffold builds; T2 replaces it).
- [ ] `src/log.ts`: `export const logger = pino({ level: process.env.LOG_LEVEL ?? "info", redact: ["req.headers.authorization", "headers.authorization"] })` and `export const childLogger = (bindings: Record<string, string | number>) => logger.child(bindings)`.
- [ ] `LICENSE`: MIT, "Concentrate AI".
- [ ] `.env.example`: every key in §10 with empty values and one-line comments.
- [ ] Run `pnpm install`, `pnpm typecheck`, `pnpm lint`, `pnpm test` (0 tests is fine; ensure vitest exits 0 with `--passWithNoTests`).
- [ ] Commit: `chore: scaffold TypeScript project with toolchain and dependencies`

---

### Task 2: Config schema and loader

**Files:** `src/config/schema.ts`, `src/config/load.ts`, `test/config/schema.test.ts`, `test/config/load.test.ts`.

**Interfaces produced:**

```ts
// src/config/schema.ts
export const StewardConfigSchema = z.object({ /* exactly §10, with defaults: setupTimeoutMinutes 15, keepOnFailure true, retention {keptWorktrees 3, days 30}, tracker.teams [] , portRewrite optional */ });
export type StewardConfig = z.infer<typeof StewardConfigSchema>;   // AFTER defaults are applied (z.output)
export type StewardConfigInput = z.input<typeof StewardConfigSchema>;
export const defineConfig = (config: StewardConfigInput): StewardConfigInput => config;
export type BrainConfig = StewardConfig["brain"];   // discriminated union on kind
export type CodeHostConfig = StewardConfig["codehost"];

// src/config/load.ts
export const SecretsSchema = z.object({
  LINEAR_CLIENT_ID: z.string().optional(), LINEAR_CLIENT_SECRET: z.string().optional(), LINEAR_WEBHOOK_SECRET: z.string().optional(),
  MIRROR_TOKEN: z.string().optional(), GITLAB_TOKEN: z.string().optional(), GITHUB_TOKEN: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(), CLAUDE_CODE_OAUTH_TOKEN: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(), OPENAI_BASE_URL: z.string().optional(),
});
export type Secrets = z.infer<typeof SecretsSchema>;
export interface LoadedConfig { config: StewardConfig; secrets: Secrets; configPath: string; configDir: string; }
export const loadConfig = async (opts: { configPath?: string; cwd?: string }): Promise<LoadedConfig>;
export const resolveFromConfigDir = (configDir: string, p: string): string;   // expands ~ and relative paths
```

**Behavior:**

- `loadConfig` finds `steward.config.ts` in `opts.configPath` or `opts.cwd`, imports it with jiti (`alias: { "ticket-steward": <abs path of this package's src/index.ts when running from source, dist/index.js when built> }`), parses default export with `StewardConfigSchema`, parses `<configDir>/.env` (if present) with `dotenv.parse` into `SecretsSchema`. Never assigns to `process.env`.
- All path fields (`dataDir`, `overlayDir`, `skillsDir`, `prompt`) are resolved against `configDir` and `~` is expanded in the returned config.

**Tests (behavior, via `loadConfig` on tmp dirs):** valid config loads with defaults applied; missing required field rejects; paths resolve relative to config dir; `.env` values land in `secrets` and `process.env` is unchanged; `defineConfig` round-trips.

- [ ] Commit: `feat(config): typed steward.config.ts loader with secrets kept out of process.env`

---

### Task 3: Core pure modules and default prompt

**Files:** `src/core/types.ts`, `src/core/intake.ts`, `src/core/result.ts`, `src/core/render.ts`, `src/core/prompt.ts`, `src/core/context.ts`, `src/core/attachments.ts`, `src/core/redact.ts`, `src/core/lock.ts`, `prompts/enrich.md`, tests under `test/core/` for each.

**Interfaces consumed:** `TriggerEvent`, `TicketBundle` from `src/tracker/types.ts` (§4.1, §4.2 — create the minimal file if absent).

**Interfaces produced:**

```ts
// src/core/types.ts
export type TriggerKind = TriggerEvent["kind"];
export interface RunContext { jobId: number; attempt: number; issueId: string; identifier: string; teamKey: string; trigger: TriggerEvent; dryRun: boolean; }
export type JobOutcome =
  | { status: "succeeded"; warning?: string }
  | { status: "failed"; error: string; retryable: boolean }
  | { status: "publish_failed"; error: string };

// src/core/intake.ts  — exactly §4.1
export const STEWARD_BEGIN = "<!-- ticket-steward:begin -->"; export const STEWARD_END = "<!-- ticket-steward:end -->";
export const shouldEnqueue = (input: { event: TriggerEvent; allowlist: string[]; priorSuccess: boolean; hasQueuedJob: boolean }): IntakeDecision;
export type IntakeDecision = { action: "enqueue" } | { action: "attach" } | { action: "skip"; reason: string };

// src/core/result.ts — exactly §4.5
export const BrainResultSchema; export type BrainResult; export const brainResultJsonSchema: Record<string, unknown>;
export const validateResult = (output: unknown): { ok: true; result: BrainResult } | { ok: false; error: string };

// src/core/render.ts
export interface SectionMeta { now: Date; sha: string; branch: string; jobId: number; permalink: (path: string, line?: number) => string; }
export const buildEnrichmentSection = (result: BrainResult, uploaded: Array<{ url: string; caption: string }>, notes: string[], meta: SectionMeta): string;
export const replaceSection = (description: string, section: string): string;
export const linkify = (markdown: string, permalink: SectionMeta["permalink"]): string;   // `path/to/x.ts:12` and `path/to/x.ts` inside backticks → links; skips URLs and code fences
export const buildComment = (result: BrainResult, jobId: number): string;   // §4.6, summary truncated to 600 chars
export const truncate = (s: string, max: number): string;

// src/core/prompt.ts
export interface PromptVars { ticket: string; templates: string; workspacePath: string; baseBranch: string; sha: string; artifactsDir: string; teamKey: string; teamName: string; stewardPort: number; operatorInstructions: string; }
export const renderPrompt = (template: string, vars: PromptVars): string;   // mustache, HTML-escaping disabled

// src/core/context.ts
export const renderTicketMarkdown = (bundle: TicketBundle): string;
export const renderTemplatesMarkdown = (bundle: TicketBundle): string;

// src/core/attachments.ts
export interface ResolvedAttachment { path: string; caption: string; contentType: string; }
export const resolveAttachments = async (artifactsDir: string, requested: BrainResult["attachments"]): Promise<{ accepted: ResolvedAttachment[]; notes: string[] }>;  // §12 rules: realpath containment, ext allowlist, 10 MB

// src/core/redact.ts
export class Redactor { constructor(knownSecrets: string[]); redact(text: string): string; }   // known values (length ≥ 8) → "***", plus patterns in §12
export const collectSecretValues = (secrets: Record<string, string | undefined>, overlayFiles: string[]): string[];  // values from Secrets + KEY=VALUE lines in overlay files whose key matches /(KEY|TOKEN|SECRET|PASSWORD|PASS|CONN_STR|URL)$/i

// src/core/lock.ts
export const acquireRunLock = (dataDir: string): { release: () => void } | null;   // O_EXCL lock file containing pid; stale (pid dead) locks are reclaimed
```

**`prompts/enrich.md`:** the §7 instructions, written for the brain, with all `{{vars}}`; includes the literal marker rule "Reference files as `relative/path.ts:line`" and the attachments contract.

**Tests:** intake covers every rule in §4.1 (each as its own test with fixed values). render: replace-existing, append-when-absent, deterministic header, linkify skips fenced code and URLs, comment truncation. result: valid passes, empty summary fails, missing attachments field fails, JSON schema has `required` listing all five keys and no `minLength`. attachments: `..` escape dropped with note, absolute path dropped, symlink out dropped, disallowed extension dropped, >10 MB dropped, png accepted with `image/png`. redact: known value replaced, `glpat-` pattern replaced, short values untouched. lock: second acquire returns null, release then acquire succeeds, stale pid reclaimed.

- [ ] Commit: `feat(core): intake rules, result contract, section rendering, attachments, redaction, run lock`

---

### Task 4: SQLite store

**Files:** `src/store/db.ts`, `src/store/jobs.ts`, `src/store/attempts.ts`, `src/store/deliveries.ts`, `src/store/tokens.ts`, `src/store/index.ts`, tests under `test/store/`.

**Interfaces consumed:** `TriggerEvent` (`src/tracker/types.ts`), `BrainResult` (`src/core/result.ts`), `JobOutcome` (`src/core/types.ts`).

**Interfaces produced:**

```ts
// src/store/db.ts
export const openDatabase = (dataDir: string): Database;   // mkdir 0700, file 0600, WAL, busy_timeout 5000, runs migrations (CREATE TABLE IF NOT EXISTS …)
// src/store/jobs.ts — exactly §5 JobStore, plus:
export interface Job { id: number; issueId: string; identifier: string; teamKey: string; trigger: TriggerEvent; status: JobStatus; attempts: number; sessionId: string | null; promptBody: string | null; result: BrainResult | null; resultSha: string | null; error: string | null; createdAt: string; startedAt: string | null; finishedAt: string | null; }
export type JobStatus = "queued" | "running" | "succeeded" | "failed" | "publish_failed" | "skipped";
export class JobStore implements §5 { constructor(db: Database) }
// src/store/attempts.ts
export interface Attempt { id: number; jobId: number; number: number; startedAt: string; finishedAt: string | null; error: string | null; setupTail: string | null; preWriteDescription: string | null; transcriptPath: string | null; usage: { inputTokens: number; outputTokens: number; costUsd?: number } | null; }
export class AttemptStore { constructor(db: Database); start(jobId: number): Attempt; finish(id: number, patch: Partial<Pick<Attempt,"error"|"setupTail"|"preWriteDescription"|"transcriptPath"|"usage">>): void; forJob(jobId: number): Attempt[]; }
// src/store/deliveries.ts
export class DeliveryStore { constructor(db: Database); markSeen(deliveryId: string): boolean; prune(olderThanDays: number): number; }
// src/store/tokens.ts
export interface TokenPair { accessToken: string; refreshToken: string; expiresAt: string; appUserId: string | null; }
export class TokenStore { constructor(db: Database); get(): TokenPair | null; set(pair: TokenPair): void; clear(): void;
  createOauthState(ttlMs: number): string; consumeOauthState(state: string): boolean;
  setAuthBroken(v: boolean): void; isAuthBroken(): boolean;
  withImmediateTransaction<T>(fn: () => T): T; }
// src/store/index.ts
export interface Stores { db: Database; jobs: JobStore; attempts: AttemptStore; deliveries: DeliveryStore; tokens: TokenStore; }
export const openStores = (dataDir: string): Stores;
export const transaction = <T>(db: Database, fn: () => T): T;
```

`claimNext`/`claimById` set `status='running'`, increment `attempts`, set `startedAt`, and return the row in one statement (`UPDATE … RETURNING`). `hasSucceeded` is true for `succeeded` only. `requeueInterrupted(max)` acts on `running` rows.

**Tests (through the store API only):** enqueue then get; claimNext returns oldest and marks running; claimNext on empty returns null; attachSession updates queued job; hasSucceeded after finish succeeded; publish_failed then claimById; saveResult then get shows result; requeueInterrupted splits by attempts; markSeen false on repeat; oauth state consumed once; auth broken flag round-trip; two `openStores` on the same dir see each other's writes.

- [ ] Commit: `feat(store): SQLite job, attempt, delivery and token stores`

---

### Task 5: Tracker interface and Linear adapter

**Files:** `src/tracker/types.ts`, `src/tracker/readOnly.ts`, `src/tracker/linear/client.ts`, `src/tracker/linear/auth.ts`, `src/tracker/linear/webhook.ts`, `src/tracker/linear/templates.ts`, `src/tracker/linear/index.ts`, tests under `test/tracker/`.

**Interfaces produced:** `TriggerEvent`, `TicketBundle`, `Tracker` exactly as §4.1–§4.3, plus:

```ts
// src/tracker/readOnly.ts
export interface RecordedWrite { method: "writeDescription" | "postComment" | "uploadFile" | "agentSession.thought" | "agentSession.response" | "agentSession.error"; args: string[]; }
export class ReadOnlyTracker implements Tracker { constructor(inner: Tracker); readonly writes: RecordedWrite[]; }

// src/tracker/linear/webhook.ts
export const verifySignature = (rawBody: string | Buffer, signatureHex: string | undefined, secret: string): boolean;
export const parseEvent = (headers: { event: string | undefined; delivery: string | undefined }, body: unknown): TriggerEvent | null;  // §11 step 2

// src/tracker/linear/auth.ts
export interface TokenRepository { get(): TokenPair | null; set(p: TokenPair): void; setAuthBroken(v: boolean): void; withImmediateTransaction<T>(fn: () => T): T; }   // structurally satisfied by store/tokens.ts
export const LINEAR_SCOPES = "read,write,comments:create,app:assignable,app:mentionable";
export const buildAuthorizeUrl = (p: { clientId: string; redirectUri: string; state: string }): string;   // actor=app, response_type=code, prompt=consent
export const exchangeCode = (p: { clientId: string; clientSecret: string; redirectUri: string; code: string; fetchImpl?: typeof fetch }): Promise<TokenPair>;
export class LinearAuth { constructor(repo: TokenRepository, creds: { clientId: string; clientSecret: string }, fetchImpl?: typeof fetch);
  accessToken(): Promise<string>;         // refreshes if within 5 min of expiry; single-flight; store-authoritative per §11
  handleUnauthorized(): Promise<string>;  // force refresh once
}

// src/tracker/linear/templates.ts
export const toTemplateSummary = (t: { name: string; description?: string | null; content?: string | null; templateData: unknown }): TicketBundle["templates"][number];

// src/tracker/linear/client.ts
export class LinearTracker implements Tracker { constructor(auth: LinearAuth, opts?: { fetchImpl?: typeof fetch; clientFactory?: (token: string) => LinearClient }); }
export const createLinearTracker = (stores: Pick<Stores,"tokens">, secrets: Secrets): LinearTracker;   // in index.ts
```

**Behavior:** `fetchTicket` gathers issue, team, state, labels, creator, comments (with author display name), attachments, `lastAppliedTemplate` name, workspace + team templates. `uploadFile` does `fileUpload` → PUT with returned headers + `Cache-Control: public, max-age=31536000`. Writes retry 3× (500 ms, 1 s, 2 s). A 401 from the SDK triggers `handleUnauthorized()` once, then retries.

**Tests:** webhook: valid signature true, tampered false, missing false; parseEvent: Issue create → `issue.created` with description/teamKey; Issue update → null; AgentSessionEvent created/prompted → `agent.session` with promptBody from `agentActivity.body` and from `agentActivity.content.body`; unknown → null. auth: `buildAuthorizeUrl` contains `actor=app` and scopes; `exchangeCode` posts form-encoded and maps `expires_in` → `expiresAt`; `accessToken` returns stored token when fresh (fetch not called), refreshes when near expiry and persists the rotated pair, two concurrent calls make one refresh, refresh failure sets auth broken. templates: required fields from `templateData` form fields; fallback from `**Heading**` lines. ReadOnlyTracker records writes in order and returns `file://` for uploads. LinearTracker: unit tests with a fake `clientFactory` asserting `updateIssue`/`createComment`/`createAgentActivity` arguments and the PUT for uploads via a `fetchImpl` mock; live test gated by `STEWARD_LIVE_LINEAR=1`.

- [ ] Commit: `feat(tracker): Linear agent-app adapter with webhook parsing, OAuth refresh, and read-only decorator`

---

### Task 6: Workspace (mirror, worktree, overlay, skills, setup, retention)

**Files:** `src/workspace/mirror.ts`, `worktree.ts`, `overlay.ts`, `skills.ts`, `setup.ts`, `retention.ts`, `index.ts`, tests under `test/workspace/` using real tmp git repos (create with `git init`, commit, `git clone --mirror`).

**Interfaces produced:**

```ts
export interface GitEnv { GIT_CONFIG_GLOBAL: "/dev/null"; GIT_TERMINAL_PROMPT: "0"; PATH: string; HOME: string; }
export const gitEnv = (): GitEnv;
// mirror.ts
export class Mirror { constructor(path: string, fetchUrlWithToken: string);
  static init(path: string, fetchUrlWithToken: string): Promise<Mirror>;     // clone --mirror; config extensions.worktreeConfig true
  fetch(): Promise<void>; resolveSha(ref: string): Promise<string>; exists(): boolean; hasWorktreeConfigExtension(): Promise<boolean>; }
export const injectToken = (url: string, token: string | undefined): string;   // https://oauth2:<token>@host/path for gitlab, https://x-access-token:<token>@ for github.com, unchanged if no token
// worktree.ts
export interface Worktree { path: string; sha: string; destroy(): Promise<void>; }
export const createWorktree = (mirror: Mirror, workRoot: string, name: string, sha: string): Promise<Worktree>;   // prune, remove-if-exists, add --detach, pushurl /dev/null
// overlay.ts
export const copyOverlay = (overlayDir: string, worktreePath: string, opts: { portRewrite?: { from: number; to: number } }): Promise<{ copied: string[] }>;   // refuses tracked paths (git ls-files --error-unmatch), 0600
export const syncOverlayFromCheckout = (checkoutPath: string, overlayDir: string, opts: { denyPatterns: RegExp[]; allowPatterns: RegExp[] }): Promise<{ copied: string[]; refused: Array<{ file: string; reason: string }> }>;
// skills.ts
export const copySkills = (skillsDir: string | undefined, worktreePath: string): Promise<string[]>;   // → <worktree>/.claude/skills/<name>/…
// setup.ts
export const runSetup = (commands: string[], cwd: string, env: Record<string, string>, opts: { timeoutMs: number; tailBytes: number }): Promise<{ ok: boolean; tail: string }>;
// retention.ts
export const sweep = (p: { workRoot: string; jobsDir: string; keptWorktrees: number; days: number; protect: string[] }): Promise<{ removedWorktrees: string[]; removedJobDirs: string[] }>;
export const freePort = (port: number): Promise<{ killed: number[] }>;   // lsof -t -i :port → SIGKILL each
export const isPortFree = (port: number): Promise<boolean>;
```

**Tests:** mirror init creates bare repo with extension; fetch picks up a new commit; createWorktree yields the sha's tree and `git push` inside it fails; creating the same name twice succeeds (remove-first); overlay copies nested file with 0600 and rewrites `localhost:3000`; overlay refuses a tracked path; syncOverlayFromCheckout copies gitignored `.env` and refuses a value matching a deny pattern; copySkills lands under `.claude/skills`; runSetup returns tail and `ok:false` on non-zero and on timeout; sweep keeps newest N worktrees and protects listed paths; isPortFree true on a random free port.

- [ ] Commit: `feat(workspace): mirror-backed worktrees with env overlay, skills, setup and retention`

---

### Task 7: CodeHost adapters and MCP server

**Files:** `src/codehost/types.ts`, `gitlab.ts`, `github.ts`, `gitlog.ts`, `server.ts`, `index.ts`, tests under `test/codehost/`.

**Interfaces produced:** `CodeHost`, `ChangeRef` exactly §4.7, plus:

```ts
export const createCodeHost = (config: CodeHostConfig, secrets: Secrets): CodeHost;
// gitlog.ts
export interface Commit { sha: string; author: string; at: string; subject: string; }
export const recentCommits = (worktreePath: string, paths: string[], sinceDays: number): Promise<Commit[]>;   // git log --since … -- paths
// server.ts
export const startCodeHostMcpServer = (p: { codehost: CodeHost; worktreePath: string; sha: string }): Promise<void>;   // stdio transport; tools recent_changes, permalink
export const codehostMcpSpec = (p: { binPath: string; configPath: string; worktreePath: string; sha: string; secrets: Secrets }): McpServerSpec;  // §4.7 spawn spec; McpServerSpec = { command: string; args: string[]; env: Record<string,string> }
```

GitLab: permalink `${baseUrl}/${project}/-/blob/${sha}/${path}#L${line}`; `changesForCommits` → `GET /projects/:id/repository/commits/:sha/merge_requests` via `@gitbeaker/rest` (`Commits.allMergeRequests`), dedupe by MR iid, commits with no MR become `kind: "commit"`. GitHub: permalink `https://github.com/${owner}/${repo}/blob/${sha}/${path}#L${line}`; `GET /repos/{o}/{r}/commits/{sha}/pulls` via octokit.

**Tests:** permalinks exact strings with and without line; `changesForCommits` maps API payloads (mocked client) and dedupes; `recentCommits` on a tmp repo returns the commit that touched the path and not one that did not; MCP server: spawn via `@modelcontextprotocol/sdk` client over stdio against a tmp repo with a FakeCodeHost → `tools/list` returns both tools and `recent_changes` returns the commit; `codehostMcpSpec` env contains only PATH, HOME and the one codehost token.

- [ ] Commit: `feat(codehost): GitLab and GitHub permalinks, commit-to-MR resolution, stdio MCP server`

---

### Task 8: Brains

**Files:** `src/brain/types.ts`, `env.ts`, `policy.ts`, `runner.ts`, `spawn.ts`, `claudeCode.ts`, `openaiAgents.ts`, `tools/index.ts`, `index.ts`, tests under `test/brain/`.

**Interfaces consumed:** `BrainResultSchema`, `brainResultJsonSchema` (`src/core/result.ts`), `Redactor` (`src/core/redact.ts`), `Secrets`, `BrainConfig` (`src/config/…`).

**Interfaces produced:** `BrainInput`, `BrainRun`, `McpServerSpec` exactly §4.4, plus:

```ts
export interface Brain { kind: BrainConfig["kind"]; run(input: BrainInput, onMessage: (line: string) => void): Promise<BrainRun>; }
export const createBrain = (config: BrainConfig): Brain;
// env.ts
export const buildBrainEnv = (secrets: Secrets, brain: BrainConfig, port: number): Record<string, string>;   // exactly §4.4
// policy.ts
export type PolicyDecision = { allow: true } | { allow: false; reason: string };
export const evaluateTool = (p: { name: string; input: unknown; workspacePath: string; artifactsDir: string; denyPaths: string[] }): PolicyDecision;   // §8.1
// spawn.ts
export const runBrainDetached = (brain: BrainConfig, input: BrainInput, redactor: Redactor): Promise<BrainRun>;   // fork runner.ts with env=input.env, detached; transcript lines written by parent after redaction; kill -pgid on finish/timeout
// runner.ts: child entry; reads BrainInput over IPC, runs createBrain(kind).run, streams {type:"line",line} messages, ends with {type:"done",run}
```

`claudeCode.ts` implements §8.2 exactly (hooks `PreToolUse` → `evaluateTool`; `error_max_turns` follow-up with `resume`; `success` without `structured_output` → `ok:false`). `openaiAgents.ts` implements §8.3 with the tools in `tools/index.ts` each guarded by `evaluateTool`.

**Tests:** `buildBrainEnv` exact key set for each brain kind (assert `Object.keys(env).sort()` equals the literal list); policy: `git push` denied, `git  push` (double space) denied, `git pull` allowed, Write outside worktree denied, Write to artifacts allowed, Bash referencing a denyPath denied, `mcp__slack__send` denied, `mcp__codehost__recent_changes` allowed; spawn: with a test brain kind `"fake"` (registered only under `NODE_ENV=test` via `createBrain`) that spawns `sleep 100` then returns, assert the run completes and the sleep pid is dead; timeout produces `ok:false` and kills the group; transcript file contains redacted lines. Live contract test for both brains gated by `STEWARD_LIVE_BRAIN=1`.

- [ ] Commit: `feat(brain): Claude Agent SDK and OpenAI Agents brains with shared tool policy and detached runner`

---

### Task 9: Pipeline and fakes

**Files:** `src/core/pipeline.ts`, `test/fakes/fakeTracker.ts`, `test/fakes/fakeBrain.ts`, `test/fakes/fakeCodeHost.ts`, `test/fakes/tmpRepo.ts`, `test/core/pipeline.test.ts`.

**Interfaces produced:**

```ts
export interface PipelineDeps { config: StewardConfig; secrets: Secrets; configPath: string; binPath: string; tracker: Tracker; brain: Brain; codehost: CodeHost; mirror: Mirror; stores: Stores; redactor: Redactor; now: () => Date; runBrain?: typeof runBrainDetached; }
export const runJob = (ctx: RunContext, deps: PipelineDeps): Promise<JobOutcome>;   // §3 steps 1–9, §5 retry classification, §13 table
export const publishOnly = (ctx: RunContext, deps: PipelineDeps): Promise<JobOutcome>;  // steps 6–9 from stored result
```

`deps.runBrain` defaults to `runBrainDetached`; tests inject a direct call to `FakeBrain.run` so no child process is forked.

**Fakes:** `FakeTracker` (in-memory issues; `getDescription(id)`, `comments(id)`, `sessionActivities(sessionId)`, `setDescription(id, s)` for the race test, `failNextWrite()`); `FakeBrain` (returns a canned result; optional `writeFiles: Record<string,string>` into artifactsDir; can be told to return `ok:false`); `FakeCodeHost`; `tmpRepo()` builds a repo + mirror in a tmp dir.

**Tests (all through fakes' public methods):** happy path writes section between markers, posts comment for `issue.created`, no comment but `response` activity for `agent.session`; description changed after brain resolves survives; invalid brain output → `failed` non-retryable and session `error`; attachment written by brain is uploaded and embedded; `..` attachment dropped with note; tracker write failure after result → `publish_failed` then `publishOnly` succeeds without calling the brain; dry-run records writes and leaves description unchanged; worktree removed after success; kept after failure when `keepOnFailure`; prompt rendered contains ticket title and `operatorInstructions`.

- [ ] Commit: `feat(core): enrichment pipeline with publish-only retry and fakes`

---

### Task 10: Server and worker

**Files:** `src/server/app.ts`, `src/worker/loop.ts`, `src/worker/index.ts`, tests under `test/server/`, `test/worker/`.

**Interfaces produced:**

```ts
export interface ServerDeps { config: StewardConfig; secrets: Secrets; stores: Stores; tracker: Tracker; workerState: () => { running: number | null }; }
export const buildServer = (deps: ServerDeps): FastifyInstance;    // §11 routes; raw body via addContentTypeParser('application/json', { parseAs: 'string' })
export const startWorker = (deps: PipelineDeps & { pollMs?: number; maxAttempts?: number }): { state: () => { running: number | null }; stop: () => Promise<void> };
```

**Tests:** webhook: unsigned → 401 and no job; signed Issue create → 200 and a queued job (via `stores.jobs.list`); same delivery twice → one job; signed Issue create for non-allowlisted team → 200, no job; AgentSessionEvent created → job with sessionId and a `thought` recorded on FakeTracker after the response; second AgentSessionEvent while first queued → attached, still one job; health 200 shape and 503 when auth broken; oauth callback with bad state → 400, with valid state (created via TokenStore) → token stored (fetch mocked). worker: claims queued job, calls `runJob` (injected), finishes succeeded; infra-failure classification → requeued with attempts 2; `publish_failed` → `publishOnly` path on retry; `stop()` waits for the in-flight job; on start, running job with attempts<3 requeued.

- [ ] Commit: `feat(server,worker): Linear webhook receiver, OAuth callback, health, and job worker`

---

### Task 11: CLI

**Files:** `src/cli/*.ts` per §9, `test/cli/*.test.ts`.

**Interfaces produced:** `buildProgram(): Command` (commander) exported from `src/cli/program.ts`; `src/cli/main.ts` calls `buildProgram().parseAsync(process.argv)`. Each command file exports `register<Name>(program: Command, ctx: CliContext)` where `CliContext = { loadConfig: typeof loadConfig; stdout: Writable; stderr: Writable; fetchImpl: typeof fetch }` so tests inject.

Commands and behaviors exactly §9. `doctor` prints one line per check `[ok]`/`[fail]`/`[warn]` and exits 1 if any fail. `init` refuses to overwrite existing files. `mcp codehost` calls `startCodeHostMcpServer`. `enrich` implements the health-probe branch. `auth linear` creates state via `TokenStore`, prints the URL, starts a temporary Fastify listener on `server.port` unless `/health` already answers, waits for the callback, stores the pair.

**Tests (via `buildProgram().parseAsync([...])` with injected `CliContext` and tmp config dirs):** `init` writes the four files and refuses on rerun; `doctor` reports config failure with exit 1; `jobs` lists rows from a seeded store via the store API; `enrich --dry-run` prints a section containing the markers using fakes; `prompt show` prints the template; `templates` prints names from FakeTracker; `overlay sync` copies from a tmp checkout.

- [ ] Commit: `feat(cli): steward command line with init, doctor, auth, serve, enrich, jobs, templates, prompt, overlay, mirror, mcp`

---

### Task 12: Ops, docs, examples

**Files:** `ops/ticket-steward.service`, `docs/ops.md`, `examples/kickoff/steward.config.ts`, `examples/kickoff/.env.example`, `examples/kickoff/skills/steward-user-app-verify/SKILL.md`, `README.md`.

- Unit file exactly §12 with `ExecStart=/usr/bin/env steward serve`, `WorkingDirectory=/etc/ticket-steward`, `EnvironmentFile=` **not** used (secrets stay in `.env` next to the config).
- `docs/ops.md`: §15 checklist expanded with commands; why sandbox credentials; how to rotate tokens; how to read `jobs show`; what `auth_broken` means.
- `examples/kickoff/steward.config.ts`: the §10 example. `.env.example`: keys with comments.
- `steward-user-app-verify/SKILL.md`: a port-parameterized variant of kickoff's `user-app-browser-verify`: start `pnpm --filter user-app exec next dev --port $STEWARD_PORT`, probe `http://localhost:$STEWARD_PORT`, log in via the dev-auth bypass route with a persona, screenshot with Playwright MCP into `$ARTIFACTS_DIR` (the prompt passes `{{artifactsDir}}`), stop the server. Must not reference port 3000.
- README: what it is, quick start (init → mirror → overlay → auth → doctor → serve), CLI table, link to spec and ops.

- [ ] Commit: `docs: operations guide, systemd unit, kickoff example config and skill`

---

## Progress log

(Orchestrator writes here after each level.)

### Level 0–1 complete (T1–T8)

- All seven level-1 tasks merged by cherry-pick; 35 test files, 212 tests green; typecheck and lint clean.
- Seam fix: `createLinearTracker` takes `{ tokens: TokenRepository }` (structural) rather than the `TokenStore` class.
- Spec corrected: `denyPaths` = mirror path, SQLite file, overlayDir (not dataDir); `resolveSha` takes the bare branch name (mirror has no `origin/` refs; an `origin/` prefix is accepted and stripped).
- Notes for T9–T12:
  - `Mirror` exposes `path`; `Mirror.fetch()` re-sets the remote URL from the token each time.
  - `JobStore.enqueue` of an `agent.session` event seeds `sessionId`/`promptBody`; `claimById` claims any non-running job. Succeeded-with-warning goes on the attempt row (`AttemptStore.finish({ error })`), Job has no warning column.
  - `@linear/sdk` v95: workspace templates via `(await client.organization).templates()`; `createLinearTracker` throws without `LINEAR_CLIENT_ID`/`LINEAR_CLIENT_SECRET` (doctor must surface).
  - `codehostMcpSpec({ binPath, configPath, worktreePath, sha, secrets })` includes only PATH, HOME and defined codehost tokens. `recent_changes` defaults to 30 days.
  - `runBrainDetached` forks `src/brain/runner.ts` via tsx when running from source, `dist/brain/runner.js` when built; the child env must include `NODE_ENV=test` for the `fake` brain kind in tests. `buildBrainEnv` prefers `ANTHROPIC_API_KEY` over `CLAUDE_CODE_OAUTH_TOKEN`.
  - `workspace.setup` is required in config (no default); `init`/examples must include it and `prompt`.
  - `sweep` does not call `stores.deliveries.prune`; the worker's hourly sweep must.
  - Mustache must be imported as default (`import Mustache from "mustache"`).

### Level 2a complete (T9, T12)

- Pipeline: 16 end-to-end tests; suite 228 green. `PipelineDeps` matches the plan. The pipeline finds the current attempt row via `stores.attempts.forJob(jobId)` matched on `number === ctx.attempt`, so the worker MUST call `stores.attempts.start(jobId)` after every claim. Session id / operator instructions come from `ctx.trigger` for `agent.session`, else from the job row (`sessionId`/`promptBody`). Session `error` is emitted only for terminal non-retryable failures. `publishOnly` returns non-retryable failure if no stored result. Worktree kept for any non-succeeded outcome when `keepOnFailure`.
- Fakes: `FakeTracker(issues[])` with `addIssue`, `getDescription`, `setDescription`, `comments`, `sessionActivities`, `uploads()`, `failNextWrite()`; `FakeBrain({ result, writeFiles, fail, usage })` with `runs`, `lastInput()`; `tmpRepo(promptTemplate)` → `{ root, dataDir, overlayDir, promptPath, repo, sha, mirror, cleanup }` (base branch `main`); `freeTcpPort()`.
- Run a single test file with `npx vitest run <file>` (`pnpm test -- <file>` runs everything).
- Ops docs written against spec §9 CLI; re-check README CLI table and docs/ops.md §4 after T11. Unit hard-codes `ReadWritePaths=/var/lib/ticket-steward`; steward user HOME is documented to live under dataDir because of `ProtectHome=yes`.

### Level 2b complete (T10)

- `buildServer(deps: ServerDeps)` where `ServerDeps = { config, secrets, stores, tracker, workerState, fetchImpl? }`; caller calls `app.listen({ port })`. Webhook replies `{ ok, action: enqueue|attach|skip|duplicate|ignored }`.
- `startWorker(deps: PipelineDeps & WorkerOptions): WorkerHandle { state(), stop() }` — acquires `run.lock` synchronously and THROWS when held; registers its own SIGTERM → stop(); waits for the in-flight job (does not abort the brain; the pipeline kills the process group and systemd `TimeoutStopSec=120` bounds it). Defaults: poll 2 s, maxAttempts 3, backoff `[60_000, 300_000]`, hourly sweep incl. `deliveries.prune(7)`.
- Retries: retryable/publish_failed outcomes are recorded via `jobs.finish`, then an in-process backoff timer re-claims with `claimById`; a restart during backoff leaves the job `failed`/`publish_failed` for `jobs retry`.
- OAuth callback stores the pair with `appUserId` and clears `auth_broken`.
- Suite: 38 files, 255 tests.

### Level 3 complete (T11) and final review

- CLI landed (28 files, 23 tests); `init [dir]`, `jobs retry` requeues under `serve` else runs inline, doctor has 18 checks.
- Final four-lens review (runtime, security, spec conformance, test quality) produced 35 findings; 32 confirmed by adversarial verification and fixed in eight commits. Highlights: mirror token no longer persisted in git config (sent as a per-process `extraHeader`), codehost token no longer on the claude argv, policy resolves relative paths and guards read tools, `.env` dir added to denyPaths, retries persisted as `queued` + `not_before`, SIGTERM aborts the brain and requeues, `runJob` cleans up on every path, dry-run takes the run lock and enforces the allowlist, redactor seeded with the Linear token pair, attempts stay open until the run ends.
- Final state: 49 test files, 336 tests passing, 3 env-gated live tests skipped; `pnpm typecheck`, `pnpm lint`, `pnpm build` clean; CLI smoke test (init → mirror init → doctor) verified against a temporary repo.
- Known gaps: `acquireRunLock` stale takeover narrowed but not fully atomic; live tests for Linear and both brains still need credentials (`STEWARD_LIVE_LINEAR=1`, `STEWARD_LIVE_BRAIN=1`).
