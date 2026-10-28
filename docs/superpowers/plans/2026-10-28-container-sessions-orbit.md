# Containerized steward, GitLab-only conversation, agent push tool, resumable chat, Orbit — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove enrich and all Linear writes but labels, let agents commit and push through a steward push tool, run the steward as a Docker Compose stack with a DinD slot sidecar, let people resume an agent's session from `/agent` MR notes or `steward chat`, and give agents Orbit.

**Architecture:** Same single-process steward (Fastify + SQLite queue + worker lanes). New pieces are steward-owned stdio MCP servers (`steward mcp push`, `steward mcp orbit`) that load their own credentials from the config's `.env` like `steward mcp codehost` does today, a `chat` job kind, and a Compose stack (`dind`, `slot-helper`, `steward`) sharing one network namespace.

**Tech Stack:** TypeScript ESM on Node 22, Fastify, better-sqlite3, zod, vitest, `@anthropic-ai/claude-agent-sdk`, `@modelcontextprotocol/sdk`, Docker Compose, `docker:dind`, native `glab` + Orbit CLI.

**Spec:** `docs/superpowers/specs/2026-10-28-container-sessions-orbit-design.md`

## Global Constraints

- Never typecast to `any`. Run `npm run typecheck`, `npm run lint`, `npm test` before every commit; all must pass.
- Match surrounding code: comment density, naming, small exported functions, zod schemas with `z.infer` types, tests in `test/<area>/*.test.ts` with vitest globals.
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Never push to any remote. Never touch `/opt/ticket-steward`, `/etc/ticket-steward`, `/var/lib/ticket-steward` or the running service (the controller does the live migration after the final review).
- Never print secret values; tests use fake values only.
- The steward's only Linear writes after Task 2 are label changes (`swapLabel` and label adds/removes). No `postComment`, `writeDescription`, `uploadFile` callers remain.
- Credentials never enter the brain's environment. Steward MCP servers get no secrets in their spawn env (the SDK puts MCP env on the `claude` command line); they load `.env` themselves through `--config`, exactly like `codehostMcpSpec`.
- Push rules are unchanged in substance: fast-forward only (or create for the first push), only the ticket's steward branch, secret guard over every outgoing commit, steward checks pass, ticket not closed, push from a scratch repo built from a bundle (never from the worktree or mirror config).
- Chat prefix default `/agent`; chat authors need GitLab access level ≥ 30 (Developer) on the project.
- `chat.sessionRetentionDays` default 180.
- Slot helper protocol and its tests stay unchanged; slot numbers 1–20.
- Pin every image and binary version (no `latest`): `docker:dind` and Node base images by exact tag, `glab` 1.125.0, Orbit CLI 0.161.0, each download checksum-verified.

## Review Focus

- A push tool call while the ticket was closed mid-run must refuse, not push.
- An agent that leaves uncommitted changes or unpushed commits at the end of implement/fix: the job must report it (hand back with a clear reason), never silently drop or auto-push.
- A `/agent` note from a Reporter-level member, a bot, Greptile, or the steward's own reply must not start a chat (loops of the steward answering itself are the worst case).
- A chat or `steward chat` on a ticket whose worktree was swept must recreate it at the same path at the recorded head, so `--resume` finds the session.
- Retry/crash windows of the fix loop: a fix job retried after its push landed must not push again or re-run the brain (today's `pendingPush` semantics must survive the move to the tool).

---

### Task 1: Remove enrich

**Files:**
- Delete: `src/core/pipeline.ts`'s enrich path (`runJob`, `publishOnly`, `publish`, `uploadAttachments`, `redactResult`, `redactRepro`), `src/core/repro.ts`, `src/core/attachments.ts`, `src/core/result.ts` (BrainResult) and `src/core/render.ts`'s enrichment rendering except `BRIEF_BEGIN`/`BRIEF_END` (keep those two and whatever `extractAgentBrief` and `renderTicketMarkdown` need), `src/cli/enrich.ts`, `prompts/enrich.md`, the enrich parts of `src/core/prompt.ts`, `src/core/gateway.ts` if only enrich uses it, and their tests. Before deleting each file, check every importer (`glab orbit grep` or `rg`) and keep anything implement/fix still use.
- Modify: `src/tracker/types.ts` (`LabelAction` loses `"triage"`; `jobKindFor` never yields `enrich`), `src/core/intake.ts`, `src/server/app.ts`, `src/worker/loop.ts` (dispatch has no `enrich` case; WorkerOptions loses `runJob`/`publishOnly`), `src/store/jobs.ts` (`JobKind` loses `"enrich"`; `findQueued`/`hasSucceeded` defaults change to `"implement"`), `src/brain/types.ts` (`BrainOutput` loses `"enrich"`), brain output schema selection in `src/brain/claudeCode.ts`/`openaiAgents.ts`, `src/cli/program.ts`, `src/cli/doctor.ts`, `src/config/schema.ts`, `examples/kickoff/steward.config.ts`, `docs/ops.md`, `README.md`.

**Interfaces:**
- Produces: `JobKind = "implement" | "await_review" | "fix" | "restart"` (Task 7 adds `"chat"`). `JobStore.failRetiredKinds(): number` marks every `queued`/`running` job whose stored kind is not a current `JobKind` as `failed` with error `"enrich was removed; this job will not run"`, called once by the worker at startup before `requeueInterrupted`. Rows of kind `enrich` must still load in `list`/`get` (as a read-only historical kind: keep `"enrich"` in the row type the store reads, e.g. `StoredJobKind = JobKind | "enrich"`, so `steward jobs` still shows history).
- Config: top-level `prompt`, `tracker.gatewayIssues`, `tracker.bugLabels`, `tracker.labels.triage` are rejected with `z.never({ error: "<key> was removed with enrich (see docs/ops.md)" })`, the same pattern as `triggerLabel`. `tracker.labels` becomes required whenever `implement` is set (already enforced) — and with enrich gone, a config without `implement` does nothing: config load rejects a config without `implement` with `"implement is required"`.
- Linear webhook: an `issue.created` or `issue.labeled` event enqueues only when it carries `labels.implement`; anything else is `skip` with reason `"no implement label"`.

- [ ] **Step 1: Failing tests**
  - `test/config/schema.test.ts`: `"rejects the removed enrich keys"` — each of `prompt`, `tracker.gatewayIssues`, `tracker.bugLabels`, `tracker.labels.triage` fails with a message containing `"was removed with enrich"`; `"requires implement"`.
  - `test/core/intake.test.ts` (or the existing intake test file): a created ticket without the implement label → `{ action: "skip", reason: "no implement label" }`; with it → `enqueue` of kind `implement`.
  - `test/store/jobs.test.ts`: `"failRetiredKinds fails queued and running enrich jobs and keeps their history readable"` — insert rows with `kind='enrich'` via SQL, call it, expect `2`, both `failed` with the exact error, `list` still returns them with kind `"enrich"`.
  - `test/worker/loop.test.ts`: worker startup fails a queued enrich row before claiming.
- [ ] **Step 2: Run them, expect failures.** `npx vitest run test/config test/core test/store test/worker`
- [ ] **Step 3: Implement** the removals and the interfaces above. Update `docs/ops.md` (remove enrich setup, the triage label, the enrich prompt; say Linear is labels-only and enrich was removed on 2026-10-28) and the example config. Remove tests of deleted code.
- [ ] **Step 4: Full gates.** `npm run typecheck && npm run lint && npm test` all pass.
- [ ] **Step 5: Commit** `refactor: remove enrich; Linear intake is the implement label only`.

### Task 2: Linear is labels-only; loop and implement messages go to the MR

**Files:**
- Modify: `src/implement/publish.ts`, `src/implement/pipeline.ts`, `src/greptile/publish.ts`, `src/greptile/await.ts`, `src/greptile/start.ts`, `src/greptile/fix.ts`, `src/greptile/prompt.ts` + `prompts/fix.md`, `src/tracker/types.ts`, `src/tracker/linear/client.ts`, `src/tracker/readOnly.ts`, test fakes `test/fakes/fakeTracker.ts`, `docs/ops.md`.

**Decisions:**
- `publishImplement` no longer comments. It only swaps labels: pushed → `implemented`; hand-back `needsInfo` → `needsInfo`; hand-back `readyForHuman` → `readyForHuman`. Its summary/review notes/questions are not published at push time (there is no MR yet: kickoff CI opens it).
- The implement summary is posted on the MR by the loop: the first time `await` finds the loop's MR, it posts one note (marker `LOOP_MARKER(loopId, "implement-summary")`, via the existing `noteOnce`) built from the implement job's stored `ImplementResult` (summary, review notes, checks run). Without a loop (greptile not configured), nothing is posted; the label is the signal.
- A hand-back before any MR exists sets the label only; the reason stays in the job record (`steward jobs show`). Document this in `docs/ops.md`.
- Every `commentOnce` (Linear) call in `src/greptile/publish.ts` becomes `noteOnce` on the MR when the loop has `projectId`/`mrIid`; when it has none (MR never appeared), the label swap alone stands.
- Restart: `newComments(loop, ticket)` in `src/greptile/fix.ts` (Linear comments since hand-back) is replaced by MR notes since `handedBackAt` from human authors (not system notes, not the Greptile bot, not bot users, not the push token's user, not notes carrying the steward marker), read with the existing `listDiscussions`. The prompt field keeps its name and shape `{ author, body }[]`.
- Remove `Tracker.postComment`, `Tracker.writeDescription`, `Tracker.uploadFile` and their Linear implementations and fakes. `fetchTicket` stays (implement reads the ticket); `TicketBundle.comments` stays (ticket context for the prompt).

- [ ] **Step 1: Failing tests:** `test/implement/publish.test.ts` — publishes labels only, never calls a comment method (the fake tracker no longer has one; assert label calls exactly). `test/greptile/await.test.ts` — first sight of the MR posts exactly one implement-summary note; a second await poll does not post again. `test/greptile/publish.test.ts` — hand-back/pass/stop post MR notes, not tracker comments. `test/greptile/fix.test.ts` — restart prompt receives MR notes after `handedBackAt`, filtered as above.
- [ ] **Step 2: Run, expect failures.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Full gates pass;** `glab orbit grep 'postComment|writeDescription|uploadFile' src` returns nothing.
- [ ] **Step 5: Commit** `feat: Linear is labels-only; implement and loop messages go to the MR`.

### Task 3: Push service and `steward mcp push`; agents may commit

**Files:**
- Create: `src/push/service.ts`, `src/push/server.ts` (MCP), `src/push/store.ts` if a table is needed, `test/push/service.test.ts`, `test/push/server.test.ts`.
- Modify: `src/brain/policy.ts` (stop denying `git commit`; also allow `git add`; keep `git push|remote|worktree|gc|update-ref|config` denied; add `mcp__push__` and later `mcp__orbit__` to `ALLOWED_MCP_PREFIXES`), `src/brain/env.ts` (`buildBrainEnv` gains `GIT_AUTHOR_NAME/EMAIL`, `GIT_COMMITTER_NAME/EMAIL` from `implement.commitAuthor` when implement is configured), `src/core/workspace.ts` (`brainInput` adds `push: pushMcpSpec(...)` when the run may push), `src/cli/mcp.ts` (`mcp push` subcommand), `src/store/jobs.ts`/`db.ts` (migration for push records), `test/brain/policy.test.ts`.

**Interfaces:**
- `PushTarget` (zod-validated JSON passed on the MCP server's command line, no secrets): `{ jobId: number; worktreePath: string; identifier: string; issueId: string; mode: "create" | "fastForward"; branch: string | null; baseSha: string; loopId: number | null }`. `branch` is null for implement's first push (the tool takes `branchType` then).
- `pushFromWorktree(input: { deps: PushDeps; target: PushTarget; branchType: string | null }): Promise<PushResult>` in `src/push/service.ts`, where `PushDeps` is the subset of `PipelineDeps` it needs (config, secrets, stores, mirror, tracker, redactor) and `PushResult = { ok: true; branch: string; sha: string; commits: number } | { ok: false; reason: string; detail: string }`. Steps, in order, each refusal returning `ok: false` with the reason the agent sees:
  1. Worktree clean (`git status --porcelain` empty) — else "commit or discard your changes first".
  2. `HEAD` descends from the expected base: `target.baseSha` for create, the last pushed head for fastForward (the job's recorded `commitSha` if it pushed already this run, else the loop's `headSha`); history `base..HEAD` is linear (no merges) and non-empty.
  3. Every commit subject in `base..HEAD` starts with `<identifier>: ` — else name the offending commit and ask to amend/reword.
  4. Secret guard over `base..HEAD` with `guardCommit`'s scanning generalized to a range (extend `src/implement/git.ts`: `guardRange({ worktreePath, baseSha, headSha, stewardFiles, secretValues })`; keep `guardCommit` as a one-commit wrapper or replace its callers).
  5. Steward checks (`implement.checks`, `{{baseSha}}` = the job's/loop's original base) via `runSetup`, same timeout and tail as today; failure returns the redacted tail.
  6. Ticket not closed (`tracker.fetchTicket` → `closedReason`).
  7. For create: `branchType` must be in `implement.branchTypes`; branch name from the existing `branchName(branchType, identifier, title)`; refuse if a remote ticket branch exists (`remoteTicketBranches`), naming it.
  8. Record intent before pushing (transaction): implement → `jobs.recordCommit(jobId, branch, sha)`; fix → `loops.update(loopId, { pendingPush: { sha, pushed: false } })`. Save the bundle to the job dir (`saveBundle`), push with the existing `pushCommit` from a scratch repo, then record success (implement → `jobs.markPushed`; fix → `pendingPush.pushed = true` and `loops.update(loopId, { headSha: sha })` so the gate never reads the push as a person's).
- MCP tool `push` (server name `push`): input `{ branchType?: string; note?: string }`; returns the `PushResult` as text. A thrown error becomes `ok: false` with reason `"push failed"` and the message, never crashes the server.
- `pushMcpSpec(p: { binPath: string; configPath: string; target: PushTarget }): McpServerSpec` mirrors `codehostMcpSpec`: `args: [binPath, "mcp", "push", "--config", configPath, "--target", JSON.stringify(target)]`, env only `PATH` and `HOME`.
- The MCP server opens the stores itself (`openStores(config.dataDir)`), loads secrets via the CLI context, and builds `PushDeps`.

- [ ] **Step 1: Failing tests** for each refusal 1–7 with a real temp git repo + bare "remote" (follow `test/implement/*` fixtures for repos, `test/fakes/*` for tracker), a successful create push (branch exists on the bare remote at HEAD, job recorded pushed), a successful fast-forward for a loop (loop `headSha` and `pendingPush` updated), and the policy changes (`git commit -m x` allowed, `git push` denied, `mcp__push__push` allowed).
- [ ] **Step 2: Run, expect failures.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Full gates pass.**
- [ ] **Step 5: Commit** `feat(push): agents commit and push through the steward's push tool`.

### Task 4: Implement uses the push tool

**Files:** Modify `src/implement/pipeline.ts`, `src/implement/result.ts`, `prompts/implement.md`, `src/implement/prompt.ts`, tests in `test/implement/`.

**Decisions:**
- `brainInput` for implement includes the push server with `{ mode: "create", branch: null, baseSha, loopId: null }`.
- `ImplementResultSchema` drops `commitMessage` and `branchType` (the agent chose them when it committed and pushed). `validateImplementResult` loses the `branchTypes` parameter.
- After the run: `implemented` requires the job to be recorded pushed; if not, hand back `readyForHuman` with reason `"the agent did not push its change"`; if the worktree has uncommitted changes or commits after the pushed sha, hand back with `"the agent left unpushed work"` and the `git status`/`git log` summary as detail. `needs_info`/`failed` hand back as today.
- The steward no longer stages, guards, runs checks, commits (`commitWithHooks`, `installHookWrappers`) or pushes in implement; remove that code path and `publishImplementOnly`'s push-from-bundle branch becomes "if `branch`/`commitSha` recorded but not `pushedAt`, re-check the remote (landed → mark pushed) else hand back `readyForHuman` `"the push did not complete"`" — the push tool already did the push, so a retry never pushes on its own.
- Loop start after a pushed implement is unchanged (`startLoopFor`).
- `prompts/implement.md`: tell the agent to commit with subjects prefixed `<IDENTIFIER>: `, then call the `push` tool with `branchType` (one of the configured types) once checks pass, and to fix and retry when the tool refuses.

- [ ] **Step 1: Failing tests:** pushed via a fake runBrain that calls `pushFromWorktree` → job succeeded and loop started; implemented without push → hand-back reason exact; unpushed work → hand-back; retry path never pushes.
- [ ] **Step 2–4:** run (fail), implement, full gates.
- [ ] **Step 5: Commit** `feat(implement): the agent commits and pushes; the steward checks the outcome`.

### Task 5: Fix uses the push tool

**Files:** Modify `src/greptile/fix.ts`, `src/greptile/result.ts`, `prompts/fix.md`, `src/greptile/prompt.ts`, tests in `test/greptile/`.

**Decisions:**
- Fix runs get the push server with `{ mode: "fastForward", branch: loop.branch, baseSha: loop.baseSha, loopId }` (fast-forward base is the loop's `headSha` at call time, per Task 3 step 2).
- `FixResultSchema` drops `commitMessage`. `outcome: "changed"` requires a push recorded during this job (loop `pendingPush.pushed === true` with a sha ≠ the round's starting head); otherwise hand back `"the agent did not push its change"`. Leftover uncommitted/unpushed work hands back like implement.
- `commitChange` and `pushFix` go away; `publishChanged` no longer pushes: with `pendingPush.pushed` it replies/resolves and advances to `headSha = pendingPush.sha` exactly as today. A retried job with a stored result publishes without pushing or re-running the brain (keep the `stored !== null` short-circuit).
- `gate()` keeps accepting `loop.headSha` and `pendingPush.sha`; since the tool updates `headSha`, a webhook-driven await after the push sees the loop's own head.

- [ ] **Step 1: Failing tests:** changed+pushed round advances; changed without push hands back; retry after push publishes once, no second push; gate does not hand back on the tool's push.
- [ ] **Step 2–4:** run, implement, full gates.
- [ ] **Step 5: Commit** `feat(greptile): fix rounds push through the push tool`.

### Task 6: Container stack

**Files:**
- Create: `Dockerfile` (steward image, multi-stage), `ops/slot-helper/Dockerfile`, `ops/slot-helper/serve.sh` (socat loop or equivalent: `socat UNIX-LISTEN:/run/slot/steward-slot.sock,fork,mode=0660,unlink-early EXEC:'/usr/local/sbin/steward-slot --socket'`), `compose.yaml`, `.dockerignore`, `ops/compose.env.example`, `test/ops/compose.test.ts` (static checks: parse `compose.yaml` with the `yaml` package if present or `docker compose config` when docker is available, else skip).
- Modify: `src/cli/doctor.ts` (container-aware slot helper check), `docs/ops.md` ("Running with Docker Compose" + migration from systemd).

**Decisions:**
- Steward image: `node:22.x-bookworm-slim` pinned tag; install git, ca-certificates, tini, Playwright Chromium + deps (`npx playwright install --with-deps chromium` at the version in the lockfile), the Claude Code CLI version the Agent SDK expects, and pnpm/corepack plus Node matching kickoff's needs (read `/home/admin/kickoff/.nvmrc`, `package.json` `engines`/`packageManager`; if kickoff needs a different Node major, install it as the default `node` on PATH for workspace setup while the steward runs from its own path — document the choice in the Dockerfile). Default `USER 1001`. `ENTRYPOINT ["tini","--","steward"]`, `CMD ["serve"]`, `WORKDIR /etc/ticket-steward`. No secrets, no config baked in.
- `compose.yaml` services:
  - `dind`: `docker:<pinned>-dind`, `privileged: true`, command `dockerd --host=unix:///var/run/dind/docker.sock` (no TCP), volumes `dind-sock:/var/run/dind`, `dind-data:/var/lib/docker`, `ports: ["127.0.0.1:${STEWARD_PORT:-3020}:3020"]`.
  - `slot-helper`: built from `ops/slot-helper`, `network_mode: service:dind`, `DOCKER_HOST=unix:///var/run/dind/docker.sock`, volumes `dind-sock` (rw), `slot-sock:/run/slot`, and `ops/slots-compose.yml` + `ops/slots-init` baked in at `/etc/ticket-steward/slots/` (the helper's fixed `COMPOSE_FILE` path). Socket owned by the steward uid/gid (`STEWARD_UID`/`STEWARD_GID`, default 1001) mode 0660.
  - `steward`: built from `Dockerfile`, `network_mode: service:dind`, `user: "${STEWARD_UID:-1001}:${STEWARD_GID:-1001}"`, volumes `${STEWARD_CONFIG_DIR:-/etc/ticket-steward}:/etc/ticket-steward:ro`, `${STEWARD_DATA_DIR:-/var/lib/ticket-steward}:/var/lib/ticket-steward`, `slot-sock:/run/slot`. `depends_on` dind and slot-helper healthy. Healthcheck `GET http://127.0.0.1:3020/health`.
  - `restart: unless-stopped` on all three.
- `slots.socket` for the container is `/run/slot/steward-slot.sock`; doctor treats a socket path other than `/run/steward-slot.sock` as "helper in a container": skip the host-file ownership check with an `[ok]` line saying why, still require `check` to answer `ok`.
- Image build must work offline-ish on this host: `docker compose build` is the verification. Then bring the stack up as a **dry run** with a temporary config/data dir and `STEWARD_PORT=3921` (a copy of `/etc/ticket-steward` is not readable by the implementer; create a minimal test config from `examples/kickoff/steward.config.ts` with fake secrets and `slots.count: 2`), and verify: `docker compose exec steward steward doctor` reaches the slot helper (`check ok`) and slot ports; `steward-slot up 1`/`down 1` through the socket works from the steward container; `curl 127.0.0.1:3921/health` answers. Tear it down (`docker compose down -v` with the test project name) afterwards. Use a distinct project name (`-p steward-dryrun`) so nothing collides with the host's slot projects.

- [ ] **Step 1:** write `compose.yaml`, Dockerfiles, serve script, doctor change with its unit test (`test/cli/doctor*.test.ts`: container socket path skips ownership check).
- [ ] **Step 2:** `docker compose build` succeeds.
- [ ] **Step 3:** dry-run stack verification above; record the commands and output summary in the task report.
- [ ] **Step 4:** full gates pass; docs updated.
- [ ] **Step 5: Commit** `feat(ops): Docker Compose stack with a DinD slot sidecar`.

### Task 7: Sessions kept, worktrees recreated

**Files:** Modify `src/workspace/retention.ts`, `src/worker/loop.ts` (sweep inputs), `src/config/schema.ts` (`chat` block), `src/store/jobs.ts`/`loops.ts` (query: sessions active within N days), create `src/chat/session.ts`, tests.

**Interfaces:**
- Config `chat: { prefix: string default "/agent"; sessionRetentionDays: number int positive default 180 }`, optional; requires `brain.kind === "claude-code"` (config error `chat requires brain.kind "claude-code"`).
- `latestSession(stores, issueId): { sessionId: string; worktreeName: string; headSha: string; branch: string | null; loopId: number | null; jobId: number } | null` — the loop's session if the ticket has a loop with a `sessionId` (head = `loop.headSha`, branch = `loop.branch`), else the newest implement job with `session_id` (worktree name from its recorded paths; head = `commitSha ?? base`), else null. Add whatever column is needed to know an implement job's worktree name and base sha (migration) if not already stored.
- `ensureWorktree(deps, session): Promise<Worktree>` — if `<dataDir>/work/<worktreeName>` exists and is a valid worktree, reuse it (fetch the mirror and `git checkout --detach <headSha>` only if it is clean and behind; never discard changes); else recreate it at that exact path with `createWorktree(mirror, workRoot, worktreeName, headSha)` after `mirror.fetch()`, copy the overlay and run `workspace.setup` like `prepareWorkspace`.
- Retention: session directories (`sessionProjectDir(worktreePath)` under `sessionsDir`) are protected while the session's last activity (max of job `finished_at`/loop `updated_at`) is within `sessionRetentionDays` (default 180 even without a `chat` block); worktree eviction is unchanged.

- [ ] **Step 1: Failing tests:** retention keeps a 60-day-old session dir whose worktree was removed; removes one older than 180 days; `latestSession` prefers the loop; `ensureWorktree` recreates a removed worktree at the same path and SHA.
- [ ] **Step 2–4:** run, implement, full gates.
- [ ] **Step 5: Commit** `feat(chat): keep sessions for 180 days and recreate their worktrees`.

### Task 8: `chat` job from `/agent` MR notes

**Files:** Modify `src/codehost/gitlabWebhook.ts` (note events expose `noteId`, `authorId`, `authorUsername`, `body`, `discussionId`), `src/server/app.ts` (`gitlabIntake`), `src/codehost/gitlabMr.ts` (`memberAccessLevel(projectId, userId): Promise<number | null>` using `GET /projects/:id/members/all/:user_id`; `replyToDiscussion(projectId, mrIid, discussionId, body)`), `src/store/jobs.ts` (`JobKind` adds `"chat"`; chat payload storage), `src/tracker/types.ts` (trigger kind `chat`), `src/worker/loop.ts` (dispatch), create `src/chat/run.ts`, `src/chat/result.ts`, `prompts/chat.md`, tests.

**Decisions / interfaces:**
- Intake: a note event whose body's first line starts with `chat.prefix` (case-insensitive, after trimming), not a system note, author not a bot (`author.bot === true` in the payload, or username matches `project_\d+_bot_`), not the Greptile bot, and body not containing the steward marker `CHAT_MARKER` → resolve the ticket: the loop whose `branch` equals the note's MR source branch, else the implement job whose `branch` equals it. None → reply once in the discussion "No agent session is attached to this merge request." (marker included) and return action `chat_no_session`. Otherwise enqueue `chat` with `{ projectId, mrIid, discussionId, noteId, author, message }` (message = body without the prefix) and subject `loopSubject(loopId)` when there is a loop (serializes with loop steps), else subject `null` (the issue_id rule serializes it with implement). Access check (≥ 30) happens at intake via `memberAccessLevel`; below → action `chat_denied`, no reply. Repeated delivery of the same note id never enqueues twice (store the note id; reuse `deliveries.markSeen` with key `gitlab-note:<id>`).
- `runChat`: `latestSession` → `ensureWorktree` → slot up (as other jobs) → brain resume with `prompts/chat.md` rendered with the message, author, MR link, and push target `{ mode: branch ? "fastForward" : ..., ... }` only when the ticket has a pushed steward branch (no branch → no push server; prompt says answer-only) → result `ChatResultSchema = { reply: string }` → `replyToDiscussion` with `reply` + `CHAT_MARKER` → record session (`loops.update({ sessionId })` / `jobs.recordSession`). Store the result before replying so a retry replies without re-running the brain (pattern of `saveFixResult`).
- Interaction with the loop: if the chat pushed while the loop is `awaiting_review`, the push tool already moved `headSha`; nothing else. If the loop is `handed_back`, a chat does not restart it, but a note `/agent restart` (exact second word `restart`) enqueues the existing `restart` step instead of a chat. *(Ruling on the spec's two statements about restarts: plain `/agent` on a handed-back loop chats without restarting; `/agent restart` restarts. The restart step's prompt includes the MR notes since the hand-back, per Task 2.)*
- Resource guard treats `chat` as heavy.

- [ ] **Step 1: Failing tests:** intake matrix (prefix/no prefix, Developer/Reporter, bot, Greptile, own marker, duplicate note id, no session reply once, `/agent restart` on handed-back loop); `runChat` happy path with fake brain posts reply with marker and records session; retry after stored result replies without brain.
- [ ] **Step 2–4:** run, implement, full gates.
- [ ] **Step 5: Commit** `feat(chat): /agent notes on the MR resume the ticket's agent session`.

### Task 9: `steward chat <TICKET>`

**Files:** Create `src/cli/chat.ts`, `src/chat/lease.ts`, `src/chat/hook.ts`; modify `src/cli/program.ts`, `src/store/db.ts` (lease table), `src/worker/loop.ts` (lanes respect leases), `src/store/jobs.ts` (claim rule treats an active lease on a ticket like a running job), tests.

**Decisions / interfaces:**
- Lease table `chat_leases(id, issue_id, slot, pid, started_at, heartbeat_at)`. `acquireLease(stores, issueId, slotCount): { slot: number } | { busy: string }` — refuses when a job for the ticket is running (names it) or another lease holds the ticket; picks a slot no lane is using (lanes publish their busy slot in a table or the lease logic consults `jobs` running rows' slot column — add `slot` to running jobs if absent) else returns `{ slot: 0 }` meaning none free. Heartbeat every 30 s; a lease without heartbeat for 120 s is stale and ignored. Worker lanes skip claiming while their slot is leased; claim rule skips tickets with an active lease.
- `steward chat <TICKET> [--no-slot]`: resolve ticket → `latestSession` (none → exit 1 "no agent session for <TICKET>") → lease (no free slot: without `--no-slot` exit 1 telling the user to retry or pass `--no-slot`) → `ensureWorktree` → slot up → spawn the Claude Code CLI (`pathToClaudeCodeExecutable` the SDK uses, or `claude` on PATH in the image) with `--resume <sessionId>`, cwd = worktree, env = `buildBrainEnv(...)` plus `CLAUDE_CONFIG_DIR`, `--mcp-config` JSON with codehost, playwright, push (fastForward target when a branch exists) and orbit (after Task 10) servers, and `--settings` JSON whose `hooks.PreToolUse` runs `steward chat-hook --config <path> --workspace <worktree> --artifacts <dir>` which reads the hook JSON on stdin and answers with `evaluateTool` (deny → exit code 2 with the reason on stderr, the Claude Code hook contract). stdio inherited (interactive). On exit: release lease, slot down, print `git status --short` and unpushed commits if any.
- `steward chat-hook` is internal (hidden from help).

- [ ] **Step 1: Failing tests:** lease acquire/refuse/stale; claim rule skips leased ticket; `chat-hook` denies `git push` and a write outside the worktree with exit 2; CLI assembles the right spawn args (spawn function injected).
- [ ] **Step 2–4:** run, implement, full gates.
- [ ] **Step 5: Commit** `feat(chat): steward chat resumes an agent session in the terminal`.

### Task 10: Orbit for agents

**Files:** Modify `Dockerfile` (install native `glab` 1.125.0 and Orbit CLI 0.161.0, checksum-verified, on PATH as `glab` and `orbit`), create `src/orbit/server.ts` (`steward mcp orbit`), `src/orbit/index.ts` (local index helper), modify `src/cli/mcp.ts`, `src/core/workspace.ts` (`brainInput` adds `orbit` server; pre-brain local index), `src/brain/policy.ts` (allow `mcp__orbit__`), `src/cli/doctor.ts` (Orbit check), `prompts/implement.md`, `prompts/fix.md`, `prompts/chat.md`, `docs/ops.md`, tests.

**Decisions / interfaces:**
- First step (spike, record result in the task report): on this host, with the steward's `GITLAB_TOKEN` (read it programmatically from `/home/admin/ticket-steward/.env` if present there, never print it; if unavailable, use the owner's glab login only to confirm the command shape and mark the token check as pending for the controller), run `orbit status` and a `glab orbit context mr:<iid>` equivalent through the Orbit CLI with that token and note what it can see. If a project access token is rejected, the MCP server still ships and reports remote as unavailable.
- `steward mcp orbit --config <path> --workspace <worktree>`: tools `orbit_query(query: string)`, `orbit_schema()`, `orbit_context(refs: string[])` that run the Orbit CLI with `GITLAB_TOKEN` in the child's env only (loaded from `.env` by the server), cwd = worktree, a 60 s timeout, output truncated to 64 KiB. A failure returns an error result `"Orbit remote is unavailable: <reason>"`, never throws.
- Local graph: before each brain run (implement, fix, chat), run `orbit workspace index .` in the worktree with `HOME=<dataDir>/orbit-home` (so the DuckDB files persist under the data dir), 120 s timeout; failure logs a warning and continues. Agents use `orbit grep`/`orbit context` on code from their shell with that same `HOME` (set in `buildBrainEnv`).
- Prompts gain a short "Codebase graph" section: prefer `orbit grep`/`orbit context` for code search, the `orbit_*` MCP tools for MRs/pipelines/graph queries; tools may be unavailable.
- Doctor: `[ok] orbit: <version>` when the binary runs, `[warn]` (non-failing) when remote status fails.

- [ ] **Step 1: Failing tests:** MCP tool runner with an injected exec (success, timeout, non-zero exit → error result, truncation); index helper failure is non-fatal; policy allows `mcp__orbit__orbit_query`.
- [ ] **Step 2–4:** run, implement, full gates; `docker compose build` still succeeds and `docker compose run --rm --entrypoint orbit steward version` prints 0.161.0.
- [ ] **Step 5: Commit** `feat(orbit): agents get Orbit through a steward MCP server and a local graph`.

### Task 11 (controller only, after the final review): live migration

Not dispatched to an implementer. The controller: backs up DB/config/`.env`; deploys the branch to `/opt/ticket-steward` for the CLI; edits `/etc/ticket-steward/steward.config.ts` (remove enrich keys, `slots.socket: "/run/slot/steward-slot.sock"`, add `chat: {}`), copies `prompts/chat.md` and updated prompts into `/etc/ticket-steward/prompts/`; builds the stack; stops `ticket-steward.service` and `steward-slot.socket`; `STEWARD_UID=998 STEWARD_GID=<steward gid> docker compose up -d`; runs doctor in the container; verifies `/health`, a GitLab webhook delivery, and the cloudflared URL; on any failure, `docker compose down`, restores the config backup and restarts the systemd units.
