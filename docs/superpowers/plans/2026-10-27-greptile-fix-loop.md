# Greptile Fix Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After a label-triggered implement job pushes a branch, the steward follows the branch's GitLab MR through
Greptile reviews and CI. Each round it resumes the implementing Claude session to fix findings and failures, until the
head commit has Greptile 5/5, no open Greptile threads and a green pipeline. Otherwise it hands the ticket to a person.
The old steward MR reviewer is removed.

**Architecture:** There are two new job kinds:

- `await_review` polls GitLab with no workspace or brain. It defers itself through a new `deferred` outcome, and decides
  each round with a pure `evaluateRound`.
- `fix` recreates the ticket's stable worktree and resumes the stored Claude session. It reuses the implement guard,
  checks and commit helpers, pushes fast-forward only, then replies to and resolves Greptile's threads.

Loop state lives in a new `loops` table. The GitLab MR client survives from the reviewer, renamed and extended.

**Tech Stack:** TypeScript (ESM, Node 22), zod 4, better-sqlite3, vitest, `@anthropic-ai/claude-agent-sdk` 0.3.268,
GitLab REST v4.

**Spec:** `docs/superpowers/specs/2026-10-27-greptile-fix-loop-design.md`. Read it before any task. This plan argues
from it.

## Global Constraints

- Never cast to `any`, never `as any`, never `: any`. Narrow with zod or type guards (owner rule).
- Every task ends green on `pnpm typecheck`, `pnpm lint` and `pnpm test`. Never run `pnpm build` unless asked.
- The brain never receives GitLab, Linear or Greptile credentials. Its env stays the `buildBrainEnv` allowlist, plus
  `CLAUDE_CONFIG_DIR` (Task 4).
- The loop is GitLab-only and claude-code-only. `greptile` requires `implement`, `codehost.kind: "gitlab"` and
  `brain.kind: "claude-code"`.
- Pass = for the MR's current head SHA, all three of:
  - the Greptile summary says `Confidence Score: 5/5`;
  - zero unresolved Greptile discussions;
  - the head pipeline status is `success`.

  4/5 never passes.
- Defaults:
  - `maxRounds` 5 (the implement push is round 0)
  - `pollSeconds` 60
  - `mrTimeoutMinutes` 60
  - `reviewTimeoutMinutes` 30
  - `pipelineTimeoutMinutes` 60
  - `ciLogLines` 200
  - label `approved` = `"agent-approved"`
- Waits are counted from the first poll of the wait, not from the push.
- Replies the steward posts never contain `@greptile` or `@greptileai`. The steward requests a review only after a
  round with no push.
- The steward never force-pushes. Fix pushes use `--force-with-lease=<ref>:<previousHead>` and must be one commit whose
  parent is the previous head.
- Every steward comment on Linear or the MR carries a hidden marker, used to make retries idempotent and to exclude the
  steward's own comments: `<!-- ticket-steward:loop … -->`.
- Match the surrounding code: short doc comments on exported functions, no comment noise, `errorMessage(err)` for
  unknown errors, and outcomes rather than throws across pipeline boundaries.

## Review Focus

1. **Greptile's summary in the MR description and also as a note.** Pick the summary with the highest `Reviews (N)`
   count, ties going to the newest `updatedAt`. Never pick one whose "Last reviewed commit" is not the head. Test in
   Task 6.
2. **A pipeline status for an older SHA, or a kickoff child pipeline.** Ignore `head_pipeline` when its `sha` is not the
   head. Collect failed jobs from downstream pipelines reached through bridges, because kickoff's `run:child` is a
   `trigger: strategy: depend` bridge. Tests in Tasks 2 and 7.
3. **A crash between push and reply.** A retried fix job must not push twice or double-post replies. The marker plus a
   stored `pushedSha` make the retry publish-only. Test in Task 12.
4. **A `ready-for-agent` re-add while a loop is still running** (not handed back). Intake must skip it with "a fix loop
   is already running" rather than restarting it or starting an implement. Test in Task 14.
5. **A Claude session file that was swept or never written.** Resume fails with an SDK error. The fix job must hand back
   with "the agent's session could not be resumed", not crash or retry forever. Test in Task 12.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `src/codehost/gitlabMr.ts` (renamed from `gitlabReview.ts`) | GitLab MR REST client: MR lookup, discussions, replies, resolves, notes, pipelines, failed jobs, traces |
| `src/store/loops.ts` | `LoopStore`: one row per ticket loop, its rounds history |
| `src/greptile/summary.ts` | Pure parsing: Greptile summary, score, review count, last reviewed SHA; open findings |
| `src/greptile/evaluate.ts` | Pure `evaluateRound`: wait, pass, fix, hand back or stop |
| `src/greptile/ci.ts` | Failed CI jobs of the head pipeline with redacted log tails |
| `src/greptile/result.ts` | `FixResult` schema, JSON schema, validation against the open findings |
| `src/greptile/prompt.ts` + `prompts/fix.md` | Fix prompt rendering |
| `src/greptile/await.ts` | `runAwaitReview`: the `await_review` job |
| `src/greptile/fix.ts` | `runFix`: the `fix` job |
| `src/greptile/publish.ts` | MR replies and resolves, review trigger, success, hand-back and stop publishing |
| `src/greptile/start.ts` | `startLoop` (after an implement push) and `runRestart` (`ready-for-agent` re-add, `steward fix`) |
| `src/greptile/mcp.ts` | Optional steward-side Greptile MCP client (Task 17) |
| `src/cli/fix.ts` | `steward fix <KEY>` |

---

### Task 1: Remove the steward's MR reviewer

**Files:**
- Delete:
  - `src/review/` (all)
  - `prompts/review.md`
  - `src/codehost/gitlabWebhook.ts`
  - `src/store/repros.ts`
  - `test/review/`
  - `test/codehost/gitlabWebhook.test.ts`
  - `test/fakes/gitlabPayload.ts`
  - `test/store/repros.test.ts`
- Modify: every file that imports them. Find them with:
  ```
  grep -rln "review\|mr\.review\|reviewSubject\|review_result\|registerGitlabWebhook\|repros\|ReproStore\|restoreReproFiles" src test
  ```
  Expected sites include:
  - `src/server/app.ts` (`/webhooks/gitlab`, `reviewIntake`, the `mr.review` ignore)
  - `src/tracker/types.ts`: drop the `mr.review` variant, `ReviewTrigger`, `IssueTrigger`. `TriggerEvent` keeps the
    issue and cli variants; Task 5 adds `loop`.
  - `src/store/jobs.ts`: the `review` kind, `reviewSubject`, `reviewResult`, `selectQueuedBySubject`, `swapTrigger`,
    `replaceTrigger`, `saveReviewResult`, the claim's review clauses
  - `src/store/db.ts`: keep the `review_result` column in DDL for old DBs, but stop reading it
  - `src/store/index.ts`
  - `src/worker/loop.ts`, `src/cli/inline.ts`, `src/cli/jobs.ts`
  - `src/cli/runtime.ts`, `src/cli/context.ts`, `src/cli/init.ts`, `src/cli/paths.ts`, `src/cli/doctor.ts`
    (`reviewChecks`)
  - `src/core/deps.ts` (`review?`)
  - `src/core/pipeline.ts` (the `mr.review` guard; repro persistence: stop writing `repros` and `dataDir/repros`)
  - `src/core/repro.ts`: keep only what renders the recipe into the Enrichment section
  - `src/config/schema.ts` (`review` block and refine)
  - `src/config/load.ts` (review prompt path; `GITLAB_WEBHOOK_SECRET` and `GITLAB_WEBHOOK_SIGNING_TOKEN`)
  - `src/brain/types.ts`, `src/brain/claudeCode.ts`, `src/brain/openaiAgents.ts` (`review` output)
  - `prompts/enrich.md`: the line about replaying the recipe "later on the merge request"
  - README, `docs/ops.md` §1.10 and review mentions, `.env.example`, `examples/kickoff/.env.example`,
    `examples/kickoff/steward.config.ts`
- Keep `src/codehost/gitlabReview.ts` and its test for now. Task 2 renames it.

**Interfaces:**
- Produces:
  - `JobKind = "enrich" | "implement"`.
  - The claim rule: the oldest due queued job with no running job on the same `issue_id`, or on the same non-null
    `subject`.
  - `PipelineDeps` without `review`.

- [ ] **Step 1: Write the failing migration test** in `test/store/jobs.test.ts`.

```ts
it("fails review jobs left from before the reviewer was removed", () => {
  // insert a raw row: kind 'review', status 'queued', trigger {"kind":"mr.review",...}
  const stores = openStores(dir);
  expect(stores.jobs.get(id)).toMatchObject({ status: "failed", error: "MR review was removed" });
});
```

- [ ] **Step 2: Run it.** `pnpm vitest run test/store/jobs.test.ts`. Expected: FAIL (the job is still queued).
- [ ] **Step 3: Delete and edit the files listed above.**
  - Add to `openDatabase`, after `addMissingColumns`, a one-statement migration:
    `UPDATE jobs SET status='failed', error='MR review was removed', finished_at=? WHERE kind='review' AND status IN ('queued','running')`.
  - Drop the `repros` table via `DROPPED_TABLES`.
- [ ] **Step 4: Run `pnpm typecheck && pnpm lint && pnpm test`.** Expected: all pass, with the deleted tests gone.
- [ ] **Step 5: Commit.** `git commit -m "refactor: remove the steward MR reviewer and its repro replay"`

---

### Task 2: GitLab MR client for the loop

**Files:**
- Rename: `src/codehost/gitlabReview.ts` → `src/codehost/gitlabMr.ts`.
- Rename: `test/codehost/gitlabReview.test.ts` → `test/codehost/gitlabMr.test.ts`.
- Rename: `test/fakes/fakeGitLabReview.ts` → `test/fakes/fakeGitLabMr.ts`.
- Modify: `src/core/deps.ts`, `src/cli/runtime.ts`, `src/cli/context.ts`.

**Interfaces:**
- Produces (rename `GitLabReviewApi`, `GitLabReviewClient` and `createGitLabReview`):

```ts
export type ProjectRef = number | string; // numeric id or "group/project" path (URL-encoded by the client)
export interface PipelineRef { id: number; sha: string; status: string }
export interface MergeRequestInfo {
  projectId: number; iid: number; state: string; sha: string; title: string; description: string;
  webUrl: string; sourceBranch: string; targetBranch: string; updatedAt: string; headPipeline: PipelineRef | null;
}
export interface NotePosition { newPath: string | null; oldPath: string | null; newLine: number | null; oldLine: number | null }
export interface MrNote {
  id: number; body: string; author: string; system: boolean; resolvable: boolean; resolved: boolean;
  type: string | null; createdAt: string; updatedAt: string; position: NotePosition | null;
}
export interface MrDiscussion { id: string; notes: MrNote[] }
export interface FailedJob { id: number; name: string; stage: string; webUrl: string }
export interface GitLabMrApi {
  currentUser(): Promise<{ username: string }>;
  tokenScopes(): Promise<string[]>;
  userExists(username: string): Promise<boolean>;
  getMergeRequest(project: ProjectRef, iid: number): Promise<MergeRequestInfo>;
  findOpenMergeRequest(project: ProjectRef, sourceBranch: string): Promise<MergeRequestInfo | null>;
  listDiscussions(project: ProjectRef, iid: number): Promise<MrDiscussion[]>;
  createNote(project: ProjectRef, iid: number, body: string): Promise<void>;
  replyToDiscussion(project: ProjectRef, iid: number, discussionId: string, body: string): Promise<void>;
  resolveDiscussion(project: ProjectRef, iid: number, discussionId: string): Promise<void>;
  /** Failed jobs of the pipeline and of every downstream pipeline reached through its bridges (depth ≤ 3). */
  failedJobs(project: ProjectRef, pipelineId: number): Promise<FailedJob[]>;
  /** The last `lines` lines of the job's trace. */
  jobTraceTail(project: ProjectRef, jobId: number, lines: number): Promise<string>;
}
export const createGitLabMr: (config: StewardConfig, secrets: Secrets) => GitLabMrApi | undefined; // when greptile is configured, codehost is gitlab and GITLAB_TOKEN is set
```

- `PipelineDeps.gitlab?: GitLabMrApi` replaces `review`.
- `createDiffDiscussion` and `reviewers` are removed.
- The `greptile` config gate cannot compile before Task 3. Until then, gate on `codehost.kind === "gitlab"` plus the
  token, and Task 3 tightens it.

- [ ] **Step 1: Write the failing tests** in `test/codehost/gitlabMr.test.ts`, with a stub `fetchImpl`:
  - `findOpenMergeRequest("concentrateai/kickoff", "fix/API-1-x")` requests
    `/projects/concentrateai%2Fkickoff/merge_requests?state=opened&source_branch=fix%2FAPI-1-x`. It returns `null` for
    `[]`, and the first MR otherwise.
  - `getMergeRequest` maps `head_pipeline: {id: 9, sha: "c…", status: "failed"}` to
    `headPipeline: { id: 9, sha: "c…", status: "failed" }`, and a null `head_pipeline` to `null`.
  - `listDiscussions` maps the note fields `type`, `created_at`, `updated_at` and
    `position.{new_path,old_path,new_line,old_line}`.
  - `failedJobs(42, 1)`:
    - calls `/pipelines/1/jobs?scope[]=failed` and `/pipelines/1/bridges`;
    - for a bridge with `downstream_pipeline: {id: 2}`, calls `/pipelines/2/jobs?scope[]=failed`;
    - returns the jobs of both pipelines, parent first.
  - `jobTraceTail(42, 5, 2)` on the trace `"a\nb\nc\n"` returns `"b\nc"`.
  - `userExists("greptile-bot")` calls `/users?username=greptile-bot`. It returns true for a one-element array and false
    for `[]`.
- [ ] **Step 2: Run them.** `pnpm vitest run test/codehost/gitlabMr.test.ts`. Expected: FAIL on the missing methods and
  fields.
- [ ] **Step 3: Implement** in `src/codehost/gitlabMr.ts`. Reuse the existing paginated `request` helper and 429
  handling. The trace endpoint returns text, not JSON. Update `FakeGitLabMr` to the new interface with these settable
  fields: `mr`, `openMr`, `discussions`, `failed`, `traces`, `users`. It records `notes`, `replies` and `resolved`.
- [ ] **Step 4: Run `pnpm typecheck && pnpm lint && pnpm test`.** Expected: pass.
- [ ] **Step 5: Commit.** `git commit -m "feat(gitlab): MR client for the fix loop: lookup by branch, pipelines, failed jobs, traces"`

---

### Task 3: `greptile` config and the `agent-approved` label

**Files:**
- Modify: `src/config/schema.ts`, `src/config/load.ts` (resolve `greptile.prompt` like `implement.prompt`),
  `src/codehost/gitlabMr.ts` (gate on `config.greptile`).
- Test: `test/config/schema.test.ts`.

**Interfaces:**
- Produces:
  - `LabelsSchema.approved` (default `"agent-approved"`).
  - `GreptileConfig = NonNullable<StewardConfig["greptile"]>`, with these fields:
    - `botUsername: string`
    - `maxRounds = 5`
    - `prompt: string`
    - `pollSeconds = 60`
    - `mrTimeoutMinutes = 60`
    - `reviewTimeoutMinutes = 30`
    - `pipelineTimeoutMinutes = 60`
    - `ciLogLines = 200`
    - `mcp?: { url: string = "https://api.greptile.com/mcp" }`

- [ ] **Step 1: Write the failing tests:**
  - A config with `greptile: { botUsername: "g", prompt: "./prompts/fix.md" }` parses with every default above.
  - Each refine fails with its own message:
    - `greptile requires implement`
    - `greptile requires codehost.kind "gitlab"`
    - `greptile requires brain.kind "claude-code"`
  - `tracker.labels: {}` gets `approved: "agent-approved"`.
- [ ] **Step 2: Run them.** `pnpm vitest run test/config/schema.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the schema, the refines and the prompt-path resolution.
- [ ] **Step 4: Run `pnpm typecheck && pnpm lint && pnpm test`.** Expected: pass.
- [ ] **Step 5: Commit.** `git commit -m "feat(config): greptile block and the agent-approved label"`

---

### Task 4: Brain sessions: return, resume, store, protect

**Files:**
- Modify:
  - `src/brain/types.ts`, `src/brain/claudeCode.ts`, `src/brain/openaiAgents.ts`, `src/brain/env.ts`
  - `src/core/workspace.ts` (`brainInput`, `denyPaths`)
  - every `buildBrainEnv` caller
- Test: `test/brain/claudeCode.test.ts`, `test/brain/env.test.ts`, `test/brain/openaiAgents.test.ts`.

**Interfaces:**
- Produces:
  - `BrainOutput = "enrich" | "implement" | "fix"`. `fix` maps to `fixResultJsonSchema` from Task 9. Until then,
    register it with a placeholder `z.object({})` schema, which Task 9 replaces.
  - `BrainInput.resumeSessionId?: string`.
  - `BrainRun.sessionId?: string`: the SDK result's `session_id`. After the `error_max_turns` follow-up, it is the
    follow-up's session id.
  - `buildBrainEnv(secrets, brain, port, sessionsDir: string)`. For `claude-code` it adds
    `CLAUDE_CONFIG_DIR=<sessionsDir>`.
  - `sessionsDir(config): string = join(config.dataDir, "sessions")`, exported from `src/core/workspace.ts`.
  - `brainInput(..., opts?: { limits?: …; resumeSessionId?: string })`. Fold the existing `limits` parameter into
    `opts`.
  - `denyPaths` gains `sessionsDir(config)`.
  - The Claude options always include `settings: { cleanupPeriodDays: 3650 }`. The steward's retention owns session
    deletion (Task 15).
  - openai-agents: a `resumeSessionId` returns `{ ok: false, error: "openai-agents cannot resume a session" }`.

- [ ] **Step 1: Write the failing tests:**
  - With a mock `queryImpl`:
    - The success result `{session_id: "s1", usage: {input_tokens: 10, output_tokens: 2}, total_cost_usd: 0.5}` gives
      `run.sessionId === "s1"`.
    - `resumeSessionId: "s0"` reaches the SDK as `options.resume === "s0"`.
    - The options include `settings: { cleanupPeriodDays: 3650 }`.
  - Usage after a max-turns follow-up: the main run (10/2/$0.5) plus the follow-up (3/1/$0.1) gives
    `{inputTokens: 13, outputTokens: 3, costUsd: 0.6}`. This fixes the dropped-usage bug.
  - `buildBrainEnv(...)` for claude-code contains `CLAUDE_CONFIG_DIR: "/d/sessions"`. For openai-agents it does not.
  - openai-agents with `resumeSessionId` returns ok false.
- [ ] **Step 2: Run them.** `pnpm vitest run test/brain`. Expected: FAIL.
- [ ] **Step 3: Implement.** `mkdir -p` the sessions dir with mode 0700 where the env is built (`prepareWorkspace`).
- [ ] **Step 4: Run `pnpm typecheck && pnpm lint && pnpm test`.** Expected: pass.
- [ ] **Step 5: Commit.** `git commit -m "feat(brain): return and resume the Claude session; sessions dir denied to the agent; usage summed over follow-ups"`

---

### Task 5: Loop store, loop jobs, and the `deferred` outcome

**Files:**
- Create: `src/store/loops.ts`.
- Modify:
  - `src/store/db.ts` (the `loops` table)
  - `src/store/index.ts`
  - `src/store/jobs.ts`: the `loop` trigger kind, `JobKind`, `sessionId` read from the existing `session_id` column,
    `recordSession`, `defer`
  - `src/tracker/types.ts`
  - `src/core/types.ts` (the `deferred` outcome)
  - `src/core/workspace.ts` (`redactOutcome`)
  - `src/worker/loop.ts` and `src/cli/inline.ts` (record the `deferred` outcome; dispatch placeholders)
  - `src/cli/jobs.ts` (`jobLine` prints `job.kind`; `retryMode` for the new kinds)
- Test: `test/store/loops.test.ts`, `test/store/jobs.test.ts`, `test/worker/loop.test.ts`.

**Interfaces:**
- Produces:

```ts
// src/tracker/types.ts
export type LoopStep = "await" | "fix" | "restart";
// TriggerEvent gains:
| { kind: "loop"; issueId: string; identifier: string; teamKey: string; loopId: number; step: LoopStep; labelDriven?: boolean } // labelDriven: restart only
export type IssueTrigger = Exclude<TriggerEvent, { kind: "loop" }>;

// src/store/jobs.ts
export type JobKind = "enrich" | "implement" | "await_review" | "fix" | "restart";
// jobColumns(loop trigger): kind = step "await" → "await_review", otherwise the step name; subject = `loop:${loopId}`
// Job gains sessionId: string | null
recordSession(id: number, sessionId: string): void
defer(id: number, until: Date): void   // queued, not_before = until, attempts - 1, error NULL, finished_at NULL

// src/core/types.ts: JobOutcome gains
| { status: "deferred"; until: Date }

// src/store/loops.ts
export type LoopState = "awaiting_mr" | "awaiting_review" | "fixing" | "passed" | "handed_back" | "stopped";
export const ACTIVE_LOOP_STATES: readonly LoopState[] = ["awaiting_mr", "awaiting_review", "fixing"];
export interface LoopRound {
  round: number; headSha: string; score: number | null; pipeline: string | null;
  fixed: number; declined: number; outcome: "changed" | "no_changes" | "passed" | "handed_back";
}
export interface Loop {
  id: number; issueId: string; identifier: string; teamKey: string; implementJobId: number;
  branch: string; baseSha: string; headSha: string; worktreeName: string; labelDriven: boolean;
  projectId: number | null; mrIid: number | null; mrUrl: string | null; sessionId: string | null;
  round: number; state: LoopState; history: LoopRound[];
  waitStartedAt: string | null; reviewCountAtTrigger: number | null; adoptedFrom: string | null;
  pendingPush: { sha: string; pushed: boolean } | null;   // Task 12's publish-only retry
  endedAt: string | null; createdAt: string;
}
export type NewLoop = Pick<Loop, "issueId" | "identifier" | "teamKey" | "implementJobId" | "branch" | "baseSha" | "headSha" | "worktreeName" | "labelDriven" | "sessionId">;
export type LoopPatch = Partial<Omit<Loop, "id" | "issueId" | "identifier" | "teamKey" | "implementJobId" | "createdAt">>;
export class LoopStore {
  create(input: NewLoop): number;                      // state "awaiting_mr", round 0, history []
  get(id: number): Loop | null;
  forImplementJob(jobId: number): Loop | null;
  latestForIssue(issueId: string): Loop | null;
  active(): Loop[];                                    // state in ACTIVE_LOOP_STATES
  update(id: number, patch: LoopPatch): void;          // ended states also set endedAt
  appendRound(id: number, round: LoopRound): void;
}
// Stores gains loops: LoopStore
```

- Worker `record()`: a `deferred` outcome calls `attempts.finish(attempt.id, {})` and then `jobs.defer(job.id, until)`,
  with no retry accounting. `runInline` does the same and prints `job <id> waiting until <iso>`.
- Dispatch in the worker and `runInline`: until Tasks 10, 12 and 14 land, the new kinds return
  `{ status: "failed", error: "<kind> is not implemented yet", retryable: false }`. The fallthrough to enrich must
  never catch them. Make the dispatch an explicit switch on `job.kind`.

- [ ] **Step 1: Write the failing tests:**
  - `LoopStore`:
    - `create` then `get` round-trips every field.
    - `update(id, { state: "passed" })` sets `endedAt`.
    - `appendRound` appends to `history`.
    - `latestForIssue` returns the highest id.
    - `active()` excludes `passed`, `handed_back` and `stopped`.
  - `jobs.enqueue({ kind: "loop", …, loopId: 3, step: "await" })` stores `kind: "await_review"` and
    `subject: "loop:3"`.
  - The claim does not take a queued `fix` while an `implement` for the same `issue_id` is running.
  - `jobs.defer(id, until)` after a claim leaves `attempts` unchanged from before the claim, and `not_before = until`.
  - Worker: a stubbed run returning `{ status: "deferred", until }` leaves the job `queued` with `not_before = until`.
  - `jobLine` prints `job.kind`.
- [ ] **Step 2: Run them.** `pnpm vitest run test/store test/worker`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - `history` and `pendingPush` are JSON columns, read through zod with the `readStored` pattern.
  - Booleans are stored as INTEGER.
- [ ] **Step 4: Run `pnpm typecheck && pnpm lint && pnpm test`.** Expected: pass.
- [ ] **Step 5: Commit.** `git commit -m "feat(store): loops table, loop jobs and the deferred outcome"`

---

### Task 6: Parse Greptile's summary and open findings

**Files:**
- Create: `src/greptile/summary.ts`.
- Test: `test/greptile/summary.test.ts`. Use fixture text copied from the public examples the spec cites: a
  `### Confidence Score: 4/5` block with a `Reviews (3): Last reviewed commit: [msg](https://gitlab.com/…/-/commit/<sha>)`
  footer.

**Interfaces:**
- Consumes: `MergeRequestInfo` and `MrDiscussion` (Task 2).
- Produces:

```ts
export interface GreptileSummary { body: string; score: number; reviewCount: number | null; lastReviewedSha: string | null; updatedAt: string; source: "description" | "note" }
export interface Finding { discussionId: string; body: string; filePath: string | null; lineStart: number | null; lineEnd: number | null; suggestedCode: string | null }
export const parseSummary: (body: string, updatedAt: string, source: GreptileSummary["source"]) => GreptileSummary | null;
export const findSummary: (mr: MergeRequestInfo, discussions: MrDiscussion[], botUsername: string) => GreptileSummary | null;
export const shaMatches: (short: string | null, full: string) => boolean; // prefix match, ≥ 7 hex chars
export const openFindings: (discussions: MrDiscussion[], botUsername: string) => Finding[];
```

- The score regex is `/Confidence Score:\s*(\d)\s*\/\s*5/i`. A score outside 0–5 means `null`.
- `reviewCount` comes from `/Reviews \((\d+)\)/`.
- `lastReviewedSha` is the first `[0-9a-f]{7,40}` after `Last reviewed commit`, inside a `/commit/` URL or bare.
- `findSummary` collects candidates from the MR description (using `mr.updatedAt`) and from notes by `botUsername`.
  It returns the candidate with the highest `reviewCount`, with ties broken by the newest `updatedAt`.
- A finding is a discussion whose first note is by `botUsername`, `resolvable` and not `resolved`.
- `suggestedCode` is the content of the first ` ```suggestion ` fence, or `null`.

- [ ] **Step 1: Write the failing tests:**
  - `parseSummary` of the fixture gives `{score: 4, reviewCount: 3, lastReviewedSha: "<sha>"}`.
  - A body without a score heading gives `null`.
  - `findSummary` with a description summary (`Reviews (2)`) and a note summary (`Reviews (3)`) returns the note's.
  - `shaMatches("abc1234", "abc1234ef…")` is true. `shaMatches(null, x)` is false.
  - `openFindings` keeps an unresolved bot DiffNote, with its `filePath` and `lineStart` from `position.newPath` and
    `newLine`. It drops resolved threads, human threads and non-resolvable notes.
- [ ] **Step 2: Run them.** `pnpm vitest run test/greptile/summary.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them again.** Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "feat(greptile): parse the summary, score, review count and open findings"`

---

### Task 7: `evaluateRound` and CI failure collection

**Files:**
- Create: `src/greptile/evaluate.ts`, `src/greptile/ci.ts`.
- Test: `test/greptile/evaluate.test.ts`, `test/greptile/ci.test.ts`.

**Interfaces:**
- Consumes: `Loop` (Task 5), `GreptileSummary` and `Finding` (Task 6), `MergeRequestInfo` (Task 2), `GreptileConfig`
  (Task 3).
- Produces:

```ts
export type GreptileStatus = "pending" | "completed" | "failed" | "skipped";
export type RoundDecision =
  | { kind: "wait"; waitingFor: "mr" | "review" | "pipeline" }
  | { kind: "passed"; summary: GreptileSummary }
  | { kind: "fix"; summary: GreptileSummary; findings: Finding[]; pipelineFailed: boolean }
  | { kind: "handback"; reason: string }
  | { kind: "stop"; reason: string; comment: boolean };
export interface RoundInput {
  loop: Loop; settings: GreptileConfig; now: Date; ticketClosed: boolean;
  mr: MergeRequestInfo | null; summary: GreptileSummary | null; findings: Finding[];
  greptileStatus: GreptileStatus | null; // only with the MCP (Task 17)
}
export const evaluateRound: (input: RoundInput) => RoundDecision;

// src/greptile/ci.ts
export interface CiFailure { name: string; stage: string; webUrl: string; logTail: string }
export const collectCiFailures: (gitlab: GitLabMrApi, project: number, pipelineId: number, lines: number, redactor: Redactor) => Promise<CiFailure[]>;
```

- `evaluateRound` checks in this exact order. Every timeout is measured from `loop.waitStartedAt`; the caller sets it to
  `now` on the first poll of a wait.
  1. `ticketClosed` → stop (no comment).
  2. `mr === null`:
     - past `mrTimeoutMinutes` → handback `no merge request was opened for <branch>`;
     - otherwise wait `mr`.
  3. `mr.state` is `merged` or `closed` → stop (comment).
  4. `!shaMatches` between `mr.sha` and `loop.headSha` (full compare) → handback
     `a person pushed to the branch; the loop stopped`.
  5. `greptileStatus` is `failed` or `skipped` → handback `Greptile review <status> for <short sha>`.
  6. The review is unfinished unless all of these hold:
     - `summary` is non-null;
     - `shaMatches(summary.lastReviewedSha, mr.sha)`;
     - `loop.reviewCountAtTrigger` is null, or `summary.reviewCount > loop.reviewCountAtTrigger`.

     If unfinished: past `reviewTimeoutMinutes` → handback `Greptile did not review <short sha>`; otherwise wait
     `review`.
  7. The pipeline is `mr.headPipeline` only when its `sha === mr.sha`, otherwise null.
     - Null, `created`, `pending`, `running`, `waiting_for_resource` or `preparing`: past `pipelineTimeoutMinutes` →
       handback `no finished pipeline for <short sha>`; otherwise wait `pipeline`.
     - `canceled`, `skipped` or `manual` → handback `the pipeline for <short sha> is <status>`.
  8. Score 5, no findings and pipeline `success` → passed.
  9. `loop.round >= settings.maxRounds` → handback
     `Greptile scored <n>/5 after <round> fix rounds (pipeline <status>)`.
  10. Otherwise → fix, with `pipelineFailed: status === "failed"`.
- `collectCiFailures` takes `failedJobs`, then `jobTraceTail` for each job. Each tail goes through `redactor.redact`.

- [ ] **Step 1: Write the failing tests.** Write one `evaluateRound` test per numbered branch above. Build each from a
  `baseInput()` helper with a 5/5, green, found-MR input, and assert that `baseInput()` itself gives `passed`. Also:
  - a 4/5 with a green pipeline and zero findings gives `fix`, not `passed`;
  - a 5/5 with a failed pipeline gives `fix` with `pipelineFailed: true`;
  - a `headPipeline` for an older SHA counts as no pipeline;
  - a summary with `reviewCount` equal to `reviewCountAtTrigger` counts as not finished.

  For `collectCiFailures` (with `FakeGitLabMr`):
  - two failed jobs give two `CiFailure`s with their tails;
  - a secret in a trace comes back masked.
- [ ] **Step 2: Run them.** `pnpm vitest run test/greptile`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them again.** Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "feat(greptile): round evaluation and CI failure collection"`

---

### Task 8: Fast-forward push mode

**Files:**
- Modify: `src/implement/git.ts` (`pushCommit`), `src/implement/pipeline.ts` (`pushFromBundle` passes the mode).
- Test: `test/implement/git.test.ts`.

**Interfaces:**
- Produces: `pushCommit(input: … & { mode: PushMode })`, with:

  ```ts
  export type PushMode = { kind: "create" } | { kind: "fastForward"; previousHead: string };
  ```

  - `create` is today's behaviour, unchanged.
  - `fastForward` keeps the `branchRefPattern` check and the "single commit on top of `baseSha`" check. The caller
    passes `baseSha = previousHead`. It skips the `remoteTicketBranches` refusal and pushes with
    `--force-with-lease=<ref>:<previousHead>`.
- `guardCommit`, `saveBundle` and `bundleBase` already work with `baseSha = previousHead`. They don't change.

- [ ] **Step 1: Write the failing tests**, against a local bare remote (the `tmpRepo` helpers):
  - `fastForward` from `previousHead` to a child commit updates the remote branch.
  - `fastForward` when the remote branch has moved past `previousHead` throws, and the remote is unchanged.
  - `fastForward` of a commit whose parent is not `previousHead` throws `not a single commit on top of`.
- [ ] **Step 2: Run them.** `pnpm vitest run test/implement/git.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run `pnpm typecheck && pnpm lint && pnpm test`.** Expected: pass.
- [ ] **Step 5: Commit.** `git commit -m "feat(implement): fast-forward push with a lease on the previous head"`

---

### Task 9: Fix result schema and prompt

**Files:**
- Create: `src/greptile/result.ts`, `src/greptile/prompt.ts`, `prompts/fix.md`.
- Modify: `src/brain/claudeCode.ts` and `src/brain/openaiAgents.ts` (replace the placeholder `fix` schema).
- Test: `test/greptile/result.test.ts`, `test/greptile/prompt.test.ts`.

**Interfaces:**
- Produces:

```ts
export const FixResultSchema = z.object({
  outcome: z.enum(["changed", "no_changes", "failed"]),
  threads: z.array(z.object({ discussionId: z.string(), action: z.enum(["fixed", "declined"]), reply: z.string() })),
  commitMessage: z.string(),
  summary: z.string(),
  checksRun: z.array(z.string()),
  failureDetail: z.string().nullable(),
});
export type FixResult = z.infer<typeof FixResultSchema>;
export const fixResultJsonSchema: Record<string, unknown>;
export const validateFixResult: (output: unknown, findings: Finding[]) => { ok: true; result: FixResult } | { ok: false; error: string };

export interface FixPromptInput {
  identifier: string; round: number; maxRounds: number; score: number; summary: string;
  findings: Finding[]; ciFailures: CiFailure[]; personCommits: string[]; newComments: Array<{ author: string; body: string }>;
  workspacePath: string; headSha: string; stewardPort: number; artifactsDir: string; checks: string; hasChecks: boolean;
}
export const renderFixPrompt: (template: string, input: FixPromptInput) => string; // mustache, like renderImplementPrompt
```

- Validation rules (spec "The fix job" §4):
  - The thread ids must equal the finding ids exactly: none missing, none extra, none duplicated.
  - Every reply must be non-empty and must not match `/@greptile(ai)?\b/i`.
  - `changed` needs a non-empty `commitMessage`. It does not need a `fixed` thread.
  - `no_changes` needs every thread `declined`.
  - `failed` needs a non-empty `failureDetail`.
  - `summary` must be non-empty.
- `prompts/fix.md`, written in the voice of `prompts/implement.md`, says:
  - "You implemented this ticket earlier in this conversation."
  - The round number out of the maximum, the score, and the Greptile summary verbatim.
  - The findings, each with its id, file:line and suggestion.
  - The CI failures, with their log tails.
  - The person's commits since the last round, if any.
  - New Linear comments, if any.
  - That the slot's services were recreated empty and the port is now `{{stewardPort}}`.
  - Treat findings that appear only in the summary as work too.
  - For each thread, fix it or decline it with a specific reason. The choice is the agent's.
  - Never mention `@greptile`.
  - The implement rules, carried over (edit only in the worktree, never commit or push, verify what the change affects),
    and the checks block.
  - The result fields.

- [ ] **Step 1: Write the failing tests:**
  - `validateFixResult` rejects each of the following:
    - a missing thread id;
    - an extra id;
    - a duplicate id;
    - an empty reply;
    - a reply containing `@greptileai`;
    - `no_changes` with a `fixed` thread;
    - `changed` with an empty commit message.
  - It accepts `changed` with zero threads when there are zero findings.
  - `renderFixPrompt` output contains each finding's id and path, each CI failure's name and tail, and `round 2 of 5`.
- [ ] **Step 2: Run them.** `pnpm vitest run test/greptile/result.test.ts test/greptile/prompt.test.ts`. Expected:
  FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run `pnpm typecheck && pnpm lint && pnpm test`.** Expected: pass.
- [ ] **Step 5: Commit.** `git commit -m "feat(greptile): fix result schema, validation and prompt"`

---

### Task 10: The `await_review` job

**Files:**
- Create: `src/greptile/await.ts`, and the first half of `src/greptile/publish.ts` (the success, hand-back and stop
  publishers).
- Modify: worker and inline dispatch (`await_review` → `runAwaitReview`).
- Test: `test/greptile/await.test.ts`.

**Interfaces:**
- Consumes: `evaluateRound`, `findSummary`, `openFindings`, `LoopStore`, `GitLabMrApi`, `Tracker`.
- Produces:

```ts
export const runAwaitReview: (ctx: RunContext, deps: PipelineDeps) => Promise<JobOutcome>; // ctx.trigger.kind === "loop", step "await"
export const LOOP_MARKER: (loopId: number, what: string) => string; // `<!-- ticket-steward:loop id=<id> <what> -->`
export const publishPassed: (deps: PipelineDeps, loop: Loop, summary: GreptileSummary) => Promise<JobOutcome>;
export const publishHandback: (deps: PipelineDeps, loop: Loop, reason: string) => Promise<JobOutcome>;
export const publishStop: (deps: PipelineDeps, loop: Loop, reason: string, comment: boolean) => Promise<JobOutcome>;
```

- `runAwaitReview` does the following:
  1. Loads the loop.
  2. Fetches the ticket, giving `ticketClosed`.
  3. If `mrIid` is null, calls `findOpenMergeRequest(config.codehost.project, loop.branch)`, then stores
     `projectId`, `mrIid` and `mrUrl`, with state `awaiting_review`.
  4. Fetches the MR and its discussions, then calls `findSummary` and `openFindings`.
  5. Sets `waitStartedAt = now` when it is null.
  6. Calls `evaluateRound`. Then, by decision:
     - **wait:** return `{ status: "deferred", until: now + pollSeconds }`.
     - **passed:** append a round (`outcome: "passed"`), call `publishPassed`, and set state `passed`.
     - **fix:** set state `fixing` and `waitStartedAt: null`, enqueue a `loop` trigger with step `fix`, and return
       succeeded.
     - **handback** and **stop:** call the publisher, then set state `handed_back` or `stopped`.

  A GitLab or Linear error is `{ status: "failed", retryable: true }`.
- Publishers:
  - **`publishPassed`:**
    - Posts a Linear comment: `Greptile 5/5 after <n> fix rounds: <mrUrl>`, then one line per round from `history`
      (`round <r>: <score>/5, pipeline <p>, <fixed> fixed, <declined> declined`), then the marker.
    - If `loop.labelDriven`, swaps `labels.implemented` to `labels.approved`.
  - **`publishHandback`:**
    - Posts a Linear comment with the reason, the MR link, the last score and the marker.
    - If label-driven, swaps `labels.implemented` to `labels.readyForHuman`.
    - Posts an MR note `Ticket Steward stopped: <reason>`, with the marker, when `mrIid` is known.
  - **`publishStop`:** posts a Linear comment only when `comment` is true, and changes no labels.

  Every post first checks for its marker: a Linear comment with `alreadyCommented`, an MR note by listing
  discussions. A failure is `publish_failed`, and the loop state is written only after the publish succeeds.

- [ ] **Step 1: Write the failing tests** (with `FakeGitLabMr`, `FakeTracker`, a temp `openStores`, and a fixed `now`):
  - No MR yet gives `deferred` 60 s later, and `waitStartedAt` is set.
  - The MR is found: `mrIid` is stored and the state becomes `awaiting_review`.
  - A 5/5, green MR with no findings:
    - Linear gets a comment containing `Greptile 5/5`;
    - the label swaps `agent-implemented` to `agent-approved`;
    - the loop is `passed`.
  - A 3/5 with one finding: a `fix` job is queued for the loop and the state is `fixing`.
  - The MR head differs from `loop.headSha`:
    - the Linear comment contains `a person pushed`;
    - the label swaps to `ready-for-human`;
    - an MR note is posted;
    - the state is `handed_back`.
  - A merged MR: no label change, and the state is `stopped`.
  - Running `publishHandback` twice posts each comment once.
  - With `labelDriven: false`, no labels change.
- [ ] **Step 2: Run them.** `pnpm vitest run test/greptile/await.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run `pnpm typecheck && pnpm lint && pnpm test`.** Expected: pass.
- [ ] **Step 5: Commit.** `git commit -m "feat(greptile): await-review job: find the MR, wait for review and pipeline, decide the round"`

---

### Task 11: Start a loop from a label-triggered implement push

**Files:**
- Create: `src/greptile/start.ts` (`startLoop`).
- Modify:
  - `src/core/workspace.ts`: `jobPaths(ctx, deps, opts?: { worktreeName?: string })`; export
    `stableWorktreeName(identifier) = "ticket-" + identifier`
  - `src/implement/pipeline.ts`
- Test: `test/implement/pipeline.test.ts`, `test/greptile/start.test.ts`.

**Interfaces:**
- Produces:
  - `startLoop(deps: PipelineDeps, job: Job): number | null`. It creates a loop and enqueues its first `await` job. It
    is idempotent: it returns the existing loop id when `loops.forImplementJob(job.id)` is set. It returns null unless
    all of these hold:
    - `config.greptile` is set;
    - the job's trigger is label-driven (`issue.created` or `issue.labeled` with action `implement`);
    - `job.pushedAt` is set.
- Implement changes:
  - When `config.greptile` is set and the trigger is label-driven (not a dry run), the worktree name is
    `stableWorktreeName(ctx.identifier)`.
  - After the brain runs, `run.sessionId` is stored with `jobs.recordSession`.
  - After `markPushed`, in both `executeImplement` and `publishImplementOnly`, call `startLoop` with the re-read job.
    Pass `baseSha`, `headSha = commitSha`, the branch, `job.sessionId` and the worktree name.

- [ ] **Step 1: Write the failing tests:**
  - With greptile configured, a label-triggered implement that pushes:
    - creates a loop with `headSha` equal to the pushed SHA, `sessionId` equal to the fake brain's returned id, and
      `worktreeName: "ticket-API-1"`;
    - enqueues an `await_review` job;
    - uses the worktree path `<dataDir>/work/ticket-API-1` (check `brain.lastInput().workspacePath`).
  - A `cli` trigger creates no loop.
  - `publishImplementOnly` after a crash creates the loop exactly once.

  Extend `FakeBrain` with an optional `sessionId` it returns.
- [ ] **Step 2: Run them.** `pnpm vitest run test/implement/pipeline.test.ts test/greptile/start.test.ts`. Expected:
  FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run `pnpm typecheck && pnpm lint && pnpm test`.** Expected: pass.
- [ ] **Step 5: Commit.** `git commit -m "feat(implement): start a fix loop after a label-triggered push, on a stable worktree"`

---

### Task 12: The `fix` job

**Files:**
- Create: `src/greptile/fix.ts`, and the second half of `src/greptile/publish.ts` (`publishThreads`,
  `requestReview`).
- Modify: worker and inline dispatch (`fix` → `runFix`).
- Test: `test/greptile/fix.test.ts`.

**Interfaces:**
- Consumes:
  - `prepareWorkspace`, `brainInput`, `cleanupWorkspace` (`src/core/workspace.ts`)
  - `stageAndGuard`, `guardCommit`, `installHookWrappers`, `commitWithHooks`, `saveBundle` (`src/implement/git.ts`)
  - `pushCommit` with mode `fastForward` (Task 8)
  - `validateFixResult`, `renderFixPrompt` (Task 9)
  - `collectCiFailures` (Task 7)
- Produces:

```ts
export const runFix: (ctx: RunContext, deps: PipelineDeps) => Promise<JobOutcome>;
export const publishThreads: (deps: PipelineDeps, loop: Loop, result: FixResult, pushedSha: string | null) => Promise<JobOutcome>;
export const requestReview: (deps: PipelineDeps, loop: Loop) => Promise<JobOutcome>; // MR note "@greptileai review" + marker
```

- `runFix` follows spec "The fix job":
  1. **Gate:**
     - the MR is open, otherwise `publishStop`;
     - the head matches the loop's, otherwise `publishHandback` with "a person pushed";
     - the ticket is not closed.
  2. **Workspace:** `mirror.fetch()`, then `prepareWorkspace` at `loop.headSha`, with
     `jobPaths(ctx, deps, { worktreeName: loop.worktreeName })`.
  3. **Inputs:**
     - Gather `findings`, the summary, and `ciFailures` (when the head pipeline failed).
     - Gather `personCommits` (`git log --format=%s <adoptedFrom>..<headSha>` when `adoptedFrom` is set).
     - Gather `newComments`: Linear comments with `createdAt` after the loop's last hand-back (`history`), excluding
       bodies with `ticket-steward:loop`.
  4. **Brain:** run with `resumeSessionId: loop.sessionId` and the implement timeouts. Store `run.sessionId` on the
     loop. A failed run whose error mentions the session (no conversation found, or resume) hands back with
     `the agent's session could not be resumed`. Any other failure hands back with the error.
  5. **Validate.**
     - **`failed`:** hand back with `failureDetail`.
     - **`no_changes`:**
       - If `findings` is empty and the pipeline is not failed, hand back with
         `Greptile scored <n>/5 with nothing open and the agent changed nothing`.
       - If the last round in `history` is also `no_changes`, hand back with
         `the agent and Greptile disagree two rounds running`.
       - Otherwise call `publishThreads(…, null)`, then `requestReview`. Set `reviewCountAtTrigger = summary.reviewCount`
         and append a round with `no_changes`.
  6. **`changed`:**
     1. `stageAndGuard`, then the checks (`implement.checks` with the original `loop.baseSha`).
     2. `installHookWrappers` and `commitWithHooks`.
     3. `guardCommit` with `baseSha: loop.headSha`.
     4. `saveBundle(worktree, loop.headSha, …)`.
     5. Store `pendingPush: { sha, pushed: false }`.
     6. Push with `fastForward` and `previousHead: loop.headSha`. A push rejection hands back with
        `the push was rejected`.
     7. `pendingPush.pushed = true`, then `publishThreads(…, sha)`.
     8. Update the loop: `headSha = sha`, `round + 1`, `waitStartedAt: null`, `reviewCountAtTrigger: null`,
        `adoptedFrom: null`, `pendingPush: null`. Append a round with `changed`.

     A guard, check or hook failure hands back with the existing reasons.
  7. **Next:** set state `awaiting_review` and enqueue an `await` job. Then `cleanupWorkspace`.
- **Retry:** when `loop.pendingPush` is non-null on entry:
  - not `pushed`: push from the job's bundle;
  - then republish the threads;
  - then step 6.8.

  Never re-run the brain. The publish-only path mirrors `publishImplementOnly`.
- `publishThreads` handles every thread. For each one:
  - It replies with `<reply>` plus, for `fixed` with a SHA, `\n\nFixed in <short sha>.`, plus the marker
    `LOOP_MARKER(loop.id, "reply " + discussionId + " " + (pushedSha ?? "nopush"))`.
  - It skips the reply when a note with that marker already exists in the discussion.
  - It then resolves the discussion.

- [ ] **Step 1: Write the failing tests.** Use the `test/implement/pipeline.test.ts` scaffolding: a tmp repo as the
  remote, `FakeBrain` editing a file, `FakeGitLabMr` with one open finding, and a 3/5 summary for the loop's head.
  - **`changed`:**
    - the remote branch advances by one commit whose parent is the old head;
    - the reply ends `Fixed in <short>.` and the thread is resolved;
    - `brain.lastInput().resumeSessionId` equals the loop's session id;
    - the loop is at round 1 with the new `headSha`, state `awaiting_review`, and a queued `await_review` job.
  - **`no_changes`** (all declined): no push, the threads are replied to and resolved, an MR note contains
    `@greptileai review`, and `reviewCountAtTrigger` is 3.
  - **Two `no_changes` rounds** → `handed_back` with `disagree`.
  - **Nothing open, green pipeline, no change** → `handed_back` without a review request.
  - **A failed head pipeline:** the prompt contains the failed job's name and log tail.
  - **Retry with `pendingPush.pushed = true`:** the brain does not run again and replies are not duplicated.
  - **Resume error** (`FakeBrain` fails with `No conversation found with session ID`) → handed back with
    `could not be resumed`.
  - **MR head moved:** handed back with `a person pushed`, with no brain run.
- [ ] **Step 2: Run them.** `pnpm vitest run test/greptile/fix.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run `pnpm typecheck && pnpm lint && pnpm test`.** Expected: pass.
- [ ] **Step 5: Commit.** `git commit -m "feat(greptile): fix job resumes the session, pushes fast-forward, replies and resolves"`

---

### Task 13: Server intake for loop restarts

**Files:**
- Modify: `src/server/app.ts` (`intake`), `src/core/intake.ts`.
- Test: `test/server/app.test.ts`, `test/core/intake.test.ts`.

**Interfaces:**
- Produces: in `shouldEnqueue`, an extra input `loop: Pick<Loop, "state"> | null`, from `loops.latestForIssue`. For an
  implement event:
  - `loop.state` in `ACTIVE_LOOP_STATES` → skip with `<KEY> already has a fix loop running`.
  - `loop.state === "handed_back"` → the new decision `{ action: "restart" }`. Intake enqueues a `loop` trigger with
    step `restart`, `loopId = loop.id`.
  - Otherwise, today's rules apply.

- [ ] **Step 1: Write the failing tests.**
  - A `ready-for-agent` webhook for a ticket whose latest loop is `handed_back` queues a `restart` job whose trigger has `labelDriven: true`.
  - The same webhook for an `awaiting_review` loop is skipped with `already has a fix loop running`.
  - With no loop, an implement job is enqueued as before.
- [ ] **Step 2: Run them.** `pnpm vitest run test/server/app.test.ts test/core/intake.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run `pnpm typecheck && pnpm lint && pnpm test`.** Expected: pass.
- [ ] **Step 5: Commit.** `git commit -m "feat(intake): ready-for-agent on a handed-back loop restarts it"`

---

### Task 14: The `restart` job and `steward fix KEY`

**Files:**
- Modify: `src/greptile/start.ts` (`runRestart`), worker and inline dispatch (`restart` → `runRestart`),
  `src/cli/program.ts`.
- Create: `src/cli/fix.ts`.
- Test: `test/greptile/start.test.ts`, `test/cli/fix.test.ts`.

**Interfaces:**
- Produces:
  - `runRestart(ctx, deps): Promise<JobOutcome>`:
    1. Load the loop and call `findOpenMergeRequest(project, loop.branch)`.
    2. **If an MR is open:**
       - Update the loop:
         - `state: "awaiting_review"`, `round: 0`
         - `adoptedFrom: mr.sha === loop.headSha ? null : loop.headSha`, then `headSha: mr.sha`
         - `projectId`, `mrIid`, `mrUrl`
         - `waitStartedAt: null`, `reviewCountAtTrigger: null`, `endedAt: null`
         - `labelDriven: ctx.trigger.labelDriven === true`, set true by server intake (Task 13) and false by `steward fix`
       - Keep `history`.
       - If label-driven, swap `labels.implement` to `labels.implemented`.
       - Enqueue an `await` job.
    3. **No open MR:** post a Linear comment `no open merge request for <branch>; starting a fresh implement`, and
       enqueue an implement job with an `issue.labeled` trigger copied from the restart. The implement pipeline still
       hands back with "a branch already exists" when the branch is present.
  - `steward fix <key>`: resolve the issue, then require `latestForIssue` to be `handed_back`. Otherwise fail with
    `<KEY> has no handed-back fix loop`. Enqueue a `restart` (`labelDriven` false). Then run it inline or tail it, the
    way `steward implement` does.

- [ ] **Step 1: Write the failing tests:**
  - Restart with the MR open at a person's commit:
    - `round` is 0, `adoptedFrom` is the old head, `headSha` is the person's SHA;
    - an `await_review` job is queued;
    - the label swaps `ready-for-agent` to `agent-implemented`.
  - The fix job after a restart: the prompt lists the person's commit subject and a Linear comment posted after the
    hand-back. Extend `test/greptile/fix.test.ts`.
  - Restart with no open MR: an implement job is queued.
  - `steward fix API-1` with no loop exits 1 with `has no handed-back fix loop`.
- [ ] **Step 2: Run them.** `pnpm vitest run test/greptile test/cli/fix.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run `pnpm typecheck && pnpm lint && pnpm test`.** Expected: pass.
- [ ] **Step 5: Commit.** `git commit -m "feat(greptile): restart a handed-back loop by label or steward fix"`

---

### Task 15: Retention for sessions, and `jobs gc` under the run lock

**Files:**
- Modify: `src/workspace/retention.ts` (`sweep`), `src/worker/loop.ts` (pass `sessionsDir` and `protect`),
  `src/cli/jobs.ts` (`jobs gc` uses `withRunLock`).
- Test: `test/workspace/retention.test.ts`, `test/cli/jobs.test.ts`.

**Interfaces:**
- Produces:
  - `sweep` input gains `sessionsDir: string` and `protectSessionPaths: string[]`. It deletes
    `<sessionsDir>/projects/<dir>` when the dir's mtime is older than `days` and its name is not in
    `protectSessionPaths`.
  - The worker passes the SDK project-dir names of every non-ended loop's worktree path (`work/<worktreeName>`). Add an
    exported helper `sessionProjectDir(cwd: string): string` that encodes the cwd the way the SDK does (every
    non-alphanumeric character becomes `-`). Verify it against a real session dir before relying on it: run one
    `steward implement --dry-run` with `CLAUDE_CONFIG_DIR` set and compare.
  - `protect` is the same list of worktree paths, so active loops' worktrees are never removed.
  - Loops ended more than `days` ago lose their protection.

- [ ] **Step 1: Write the failing tests:**
  - An old session dir is removed.
  - An old session dir of an active loop is kept.
  - `steward jobs gc` while `run.lock` is held exits 1 with the lock-held message.
- [ ] **Step 2: Run them.** `pnpm vitest run test/workspace/retention.test.ts test/cli/jobs.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run `pnpm typecheck && pnpm lint && pnpm test`.** Expected: pass.
- [ ] **Step 5: Commit.** `git commit -m "feat(retention): sweep Claude sessions, protect active loops; jobs gc takes run.lock"`

---

### Task 16: Doctor, `jobs show`, docs and examples

**Files:**
- Modify:
  - `src/cli/doctor.ts`
  - `src/cli/jobs.ts` (`jobs show` prints the loop and its rounds for loop kinds and for implement jobs with a loop)
  - `README.md`, `docs/ops.md`
  - `examples/kickoff/steward.config.ts`, `.env.example`, `examples/kickoff/.env.example`
  - `src/cli/init.ts` (writes `prompts/fix.md` when absent)
- Test: `test/cli/doctor.test.ts`, `test/cli/jobs.test.ts`, `test/cli/init.test.ts`.

**Interfaces:**
- Doctor `greptileChecks` runs only when `greptile` is configured:
  - `GITLAB_TOKEN` has the `api` scope (`tokenScopes`).
  - `userExists(botUsername)`.
  - The `labels.approved` label exists in Linear (reuse the existing label check).
  - The `greptile.prompt` file exists.
- `docs/ops.md` gains a "Greptile fix loop" section with:
  - config fields and defaults;
  - the `GITLAB_TOKEN` scope;
  - in kickoff's `.greptile/config.json`, `autoReview: ["open","push"]`;
  - that `excludeAuthors` must not match the steward;
  - that CI's `open:dev-mr` opens non-draft MRs;
  - states and hand-back reasons;
  - restart with `ready-for-agent` or `steward fix`;
  - the sessions dir and its retention.

  It also removes the remaining review text.

- [ ] **Step 1: Write the failing tests:**
  - Doctor reports `gitlab token lacks api scope` when the scopes are `["read_api"]`, and
    `greptile bot user greptile-bot not found` when the user doesn't exist.
  - `jobs show` of a fix job prints `round 1: 3/5`.
  - `init` writes `prompts/fix.md`.
- [ ] **Step 2: Run them.** `pnpm vitest run test/cli`. Expected: FAIL.
- [ ] **Step 3: Implement**, then edit the docs and examples.
- [ ] **Step 4: Run `pnpm typecheck && pnpm lint && pnpm test`.** Expected: pass.
- [ ] **Step 5: Commit.** `git commit -m "feat(doctor): greptile checks; docs and examples for the fix loop"`

---

### Task 17: Greptile MCP spike and optional client, plus live verification

The live parts need the owner's Greptile and GitLab access. Run them with the owner, and record what you find in
`docs/ops.md`.

**Files:**
- Create: `src/greptile/mcp.ts`, only if the spike succeeds.
- Modify: `src/greptile/await.ts` (pass `greptileStatus`), `src/greptile/fix.ts` (fill `suggestedCode` when a finding
  has none), `src/config/load.ts` (`GREPTILE_API_KEY` secret, only if the spike shows key auth works).
- Test: `test/greptile/mcp.test.ts`.

**Interfaces:**
- Produces, if the spike succeeds:

```ts
export interface GreptileReviews {
  reviewStatus(input: { repo: string; mrIid: number; sha: string }): Promise<GreptileStatus | null>;
  suggestions(input: { repo: string; mrIid: number }): Promise<Map<string, string>>; // key `${filePath}:${lineStart}`
}
export const createGreptileReviews: (config: StewardConfig, secrets: Secrets) => GreptileReviews | undefined;
```

  The client is built on `@modelcontextprotocol/sdk`'s `Client` with `StreamableHTTPClientTransport`. It calls the tools
  `list_code_reviews` (`remote: "gitlab"`, `name`, `defaultBranch`, `prNumber`) and `list_merge_request_comments`
  (`greptileGenerated: true`). `PipelineDeps.greptile?: GreptileReviews`. Every call failure is logged, and the loop
  falls back to GitLab only (`greptileStatus: null`).

- [ ] **Step 1: Spike headless auth.** From a scratch script, connect to `https://api.greptile.com/mcp` with an
  `Authorization: Bearer <Greptile API key>` header, then call `list_repositories`. Record whether it works. If only
  OAuth works, stop here: skip Steps 2–5, leave `greptile.mcp` documented as unsupported, and commit only the docs note.
- [ ] **Step 2: Write the failing tests** against an in-process MCP server stub, using the SDK's `McpServer` with the two
  tools:
  - `reviewStatus` maps `COMPLETED` to `completed` and `REVIEWING_FILES` to `pending`, only for a matching
    `commitSha`;
  - a thrown tool error gives `null`.
- [ ] **Step 3: Run them**, then implement, then run them again. Run `pnpm typecheck && pnpm lint && pnpm test`.
- [ ] **Step 4: Live verification on a throwaway kickoff MR**, with the owner. Record each answer in `docs/ops.md`:
  - (a) The summary's exact heading and footer, and whether it lands in the description or a note.
    `parseSummary` must parse it. If it doesn't, fix the parser and add the real text as a fixture.
  - (b) Whether `@greptileai review` on an unchanged SHA produces a new review, with `Reviews (N)` incrementing. If it
    doesn't, change the `no_changes` branch of `runFix` to hand back immediately with
    `Greptile does not re-review an unchanged commit`, and update its test.
  - (c) Whether a thread reply without `@greptile` triggers a billed review.
- [ ] **Step 5: Commit.** `git commit -m "feat(greptile): optional MCP review status; live-verified summary format and re-review"`

---

## Self-review notes

- **Spec coverage:**

  | Spec section | Task(s) |
  | --- | --- |
  | Goals: resume | 4, 11, 12 |
  | Goals: per-thread fix or decline | 9, 12 |
  | Goals: strict pass | 7 |
  | Goals: remove reviewer | 1 |
  | Which implements start a loop | 11 |
  | Discovering the MR | 10 |
  | Detecting review and score | 6, 7 |
  | MCP | 17 |
  | Triggering re-reviews | 12, 17 |
  | The MR pipeline | 2, 7, 12 |
  | The fix job | 8, 9, 12 |
  | Stop conditions | 7, 10, 12 |
  | Success | 10 |
  | Restarting | 13, 14 |
  | Session continuity | 4, 11, 15 |
  | Loop state | 5 |
  | Removing the reviewer | 1 |
  | Configuration | 3, 16 |
  | Container-ready seams | 4 (`CLAUDE_CONFIG_DIR`), 11 (stable cwd) |
  | Left-to-builder items | decided in Tasks 4, 5, 10, 15 |
  | `jobs gc` lock | 15 |
  | `jobs` kind | 5 |

- **Builder decisions recorded here:**
  - Loop state is a table.
  - `await_review` never touches a slot, because it never calls `prepareWorkspace`.
  - `cleanupPeriodDays` is 3650, and the steward sweeps sessions itself.
  - An interrupted fix resumes the last stored session id.
  - A restart with no open MR queues a fresh implement.
