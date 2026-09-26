# Build report: gateway compat and repro/MR review

Run: workflow `wf_41e9a4dd-f77`, 2026-09-25/26. Base `e1e6fe1`. 39 agents, about 68 minutes.

**Result:** all 16 tasks (compat 2–6, repro/review 8–18) were implemented and approved by their reviewers. Task 19 (live verification) was not run; it is the owner's.

**Verification at head:** `pnpm typecheck` and `pnpm lint` are clean, and `pnpm test` shows 57 files and 458 tests passed, 3 skipped (the gated live tests).

## Commits per task

| Task | Commits |
|---|---|
| 2 | `eb9053c` |
| 3 | `31f67fb` |
| 4 | `bbe4626` |
| 5 | `d05b903` |
| 6 | `60406b2` (steward) and `cd5d56d` in `~/ticket-gateway` on `feat/ticket-gateway-mvp` |
| 8 | `d7150ec` |
| 9 | `bc44d5a` |
| 10 | `ad6df9f` |
| 11 | `bc66d8a` |
| 12 | `6e52b21` |
| 13 | `4015c5b` |
| 14 | `482555f` |
| 15 | `f2c262d` + review fix `3acb927` |
| 16 | `473340d` |
| 17 | `78b3302` + review fix `0364289` |
| 18 | `905f722` |
| Final review | `d9f263d` (workflow's fix), `85b4720` (main session, see below) |

Full log (`git log --oneline e1e6fe1..HEAD`, before this report):

```
85b4720 fix(review): key publish idempotency and supersede on job id and head sha
d9f263d fix: address final branch review
905f722 docs(review): doctor checks and setup guide for GitLab merge-request review
0364289 fix: address review of Task 17
78b3302 feat(review): review jobs replay the bug recipe on the MR head and publish findings
473340d feat(review): publish inline diff discussions, a summary and the Linear note
3acb927 fix: address review of Task 15
f2c262d feat(review): review result contract, review prompt, per-run brain output schema
482555f feat(review): map review comments onto GitLab diff positions
4015c5b feat(codehost): GitLab review API client and merge-request ref fetch
6e52b21 feat(server): GitLab merge-request webhook queues review jobs
bc66d8a feat(store): review jobs keyed by merge request, and review config
ad6df9f feat(core): save bug reproduction recipes and show them in the Enrichment section
bc44d5a feat(core): bug tickets get a reproduction recipe in the brain result
d7150ec refactor(core): share workspace preparation between pipelines
60406b2 docs: running alongside ticket-gateway
d05b903 feat(prompt): tell the brain about ticket-gateway tickets and their routing
bbe4626 feat(render): place the Enrichment section above the ticket-gateway footer
31f67fb feat(intake): tracker.gatewayIssues switch to skip ticket-gateway issues
eb9053c feat(core): recognise ticket-gateway issues by their footer
```

## Implementer deviations

### Task 2

None. The test and implementation are the plan's code blocks copied exactly, and they fit the existing code without changes.

### Task 3

1. /home/admin/ticket-steward/src/cli/enrich.ts also calls shouldEnqueue, but the plan's file list leaves it out. The new required gatewayIssues field would have broken the typecheck there, so it now passes config.tracker.gatewayIssues. This does not change behaviour: a cli event is never skipped for being a gateway issue.
2. In the app.test.ts skip test, the plan's sketch `app = buildServer({ ...deps, config: makeConfig("skip") })` doesn't match this file, which has no `deps` object. Following the plan's note to reuse the beforeEach setup, the test closes the server that beforeEach created and rebuilds it with the same config, secrets, stores, tracker and workerState, using makeConfig("skip"). The assertions are exactly as the plan wrote them.
3. The plan's Step 5 uses `git add ... test`, which stages a whole directory. The hard rules require explicit paths, so I staged each changed test file by name. The set of committed files is the same.
4. The test/config/load.test.ts and test/cli/helpers.ts fixtures are config source strings that go through the schema, where the default already applies. I still added gatewayIssues: "enrich" to both because the plan's grep lists them.
5. The schema rejection case is a new it() named "rejects an unknown tracker.gatewayIssues value".

### Task 4

None. The plan's code and tests fit the real code as written.

### Task 5

1) src/cli/prompt.ts (`steward prompt render`) also builds a PromptVars object, and the plan's file list doesn't include it. Without the new required `gateway` field, typecheck fails. I set the field with the same expression prepare() uses, so the command still prints the prompt a job would get. The file is staged by its explicit path next to the plan's paths. 2) The pipeline tests' shared config points at a stub prompt that has no gateway block. The two new pipeline cases override `prompt` with the real prompts/enrich.md. The path is resolved as DEFAULT_PROMPT_PATH, using fileURLToPath(new URL("../../prompts/enrich.md", import.meta.url)), which adds a node:url import to that test file. 3) The new prompt test reads the template with readFile("prompts/enrich.md", "utf8") as the plan wrote it, which only works when the working directory is the repo root. That is how vitest runs here.

### Task 6

docs/ops.md has no config-reference section, so there was nowhere to add the tracker.gatewayIssues entry. I put it inside a new "**ticket-gateway.**" paragraph at the end of §1.7 "Linear API key and webhook", right after the webhook setup steps and next to the webhook sentence. This avoids adding a new top-level section. Everything else follows the plan as written. The gateway commit went into /home/admin/ticket-gateway on feat/ticket-gateway-mvp, as the plan's Step 6 says.

### Task 8

None. The plan's code fit the real code as written. The test sketch was used verbatim, and lint accepted the `{ config: { dataDir } } as PipelineDeps` cast, so the makeDeps fallback was not needed.

### Task 9

1) src/cli/prompt.ts (`steward prompt render`) also calls renderPrompt with a PromptVars literal, and the plan's file list leaves it out. I added `isBug: isBugTicket(bundle.labels, config.tracker.bugLabels)` there and staged the file, because typecheck fails without it. 2) test/core/result.test.ts: I dropped the plan's extra `import { validateResult }` because the file already imports it. The plan's `base` literal is kept as written, with no repro, so "requires the repro key" still tests what it should. The file's existing `valid` fixture got `repro: null` from the sweep. The existing brainResultJsonSchema test was renamed "requires all six top-level keys" and now expects "repro" in `required`. The schema really has a sixth required key, so this does not weaken the test. 3) test/core/prompt.test.ts already declared a `vars` const, so the plan's `vars(isBug)` helper is named `reproVars` there. I added a `readFileSync` import from node:fs next to the existing fs/promises import, and the existing `vars` literal got `isBug: false`. 4) Additions the plan did not ask for: an assertion in test/config/schema.test.ts that `tracker.bugLabels` defaults to ["Bug"], and a short doc comment on `PromptVars.isBug`. 5) Staging: instead of the plan's `git add test src/cli/init.ts examples`, I staged each changed file by path, following the explicit-paths rule.

### Task 10

One small typing change in src/core/pipeline.ts execute(). Written exactly as in the plan, `recipe: result.repro` in the upsert call failed typecheck (TS2322: Repro | null is not assignable to Repro). Reassigning `result` just before it made TypeScript lose the narrowing to non-null. I bind the recipe to a local first: `const recipe: Repro = { ...result.repro, files: saved }; result = { ...result, repro: recipe };`, then pass `recipe` to upsert. The behaviour is the same and no Interfaces signature changed. In the test files I put the plan's new imports into the existing import block at the top of test/core/repro.test.ts, not at the point where the new tests are appended. The plan's test bodies are otherwise used exactly as written.

### Task 11

1. `src/cli/enrich.ts` (the plan said to stage any `src/cli` file that needed narrowing): `cliContext`, `dryRun` and the local `event` annotation now use `IssueTrigger` instead of `TriggerEvent`. That code only ever builds `cli` triggers, so typing the parameter was the smallest fix and needs no cast. `src/cli/inline.ts` needed no change.
2. `src/server/app.ts`: besides the `WebhookEvent` type change, the webhook guard `event.kind === "cli"` became `event.kind !== "issue.created"`, so the parsed event narrows to `WebhookEvent`. Behaviour is the same, because the Linear webhook parser only produces `issue.created` events.
3. `test/core/pipeline.test.ts` (not in the plan's file list): `createdTrigger` and the `claimJob` parameter are now typed `IssueTrigger`, because they read `issueId` and `identifier`. It is staged in the commit.
4. The schema tests use the file's existing `minimalInput` fixture where the plan's sketch says `validConfig`, as the plan's own note says to do.
5. The `load.test.ts` sketch was abbreviated, so I wrote it out as three tests. The first expects `config.review` to equal `{ botUsername: "steward-bot", prompt: <dir>/prompts/review.md, allowForks: false, maxComments: 15 }`. The second checks that `review` stays undefined when it is not configured, and the third checks that both GitLab secrets are read from `.env`.
6. `enqueue`'s insert call is spread over several lines to satisfy the formatter; the logic is the plan's.

### Task 12

1) `reviewSubject` is imported from "../store/jobs.js" because store/index.ts does not re-export it. 2) The plan combined enqueue, dedupe and supersede in one server test. I split it into "enqueues a review and dedupes a redelivery" and "supersedes a queued review of the same MR", so the Review Focus 1 test name exists exactly, as the plan's note allows. Every assertion is kept: the supersede test repeats the enqueue and duplicate steps, then checks that one job is queued with headSha c*40. 3) In "is not found when review is not configured", `const { review: _unused, ...rest } = makeConfig()` failed lint (@typescript-eslint/no-unused-vars on `_unused`). I replaced it with `const config = makeConfig(); delete config.review;` and pass `config` to `buildServer`. The behavior is the same and the assertion is unchanged. Nothing else differs from the plan's code.

### Task 13

1) In the new mirror test I dropped the plan's local `const root = await tmpDir()` and `await removeDir(root)`. The test sits inside the existing `describe("Mirror")` block, whose beforeEach and afterEach already create and remove `root`, so a local copy would shadow it. The test body and its assertions are unchanged. 2) The Interfaces block's `class GitLabApiError`, `class GitLabReviewClient` and `createGitLabReview` lines are signatures only, so I left them out of the verbatim interface section. The full definitions from Step 3 stand in for them, with the same names and signatures. No other changes: the plan's code typechecked and linted as written.

### Task 14

None. The plan's test and implementation code went in as written.

### Task 15

- The config template in src/cli/init.ts already had `bugLabels: ["Bug"]` alongside compat's `gatewayIssues` from an earlier task, so I left the tracker line alone and only added the commented review block.
- I added one test the plan does not list, "asks for the enrichment schema when the input is an enrichment", next to the review-schema test in test/brain/claudeCode.test.ts.
- The init test's first case is renamed from "prompt" to "prompts", and it now also checks that the copied review.md matches the shipped file.
- In src/review/result.ts, the plan's note about `.positive()` producing `exclusiveMinimum` is kept as a code comment above reviewResultJsonSchema.
- The spec says that with a recipe `rerun` must be non-null, but the plan's normalizeReviewResult (which I followed exactly) does not enforce that. Its test requires `normalizeReviewResult(result, true)` to equal `result` unchanged. Task 16 or 17 may need to handle a null `rerun` when there is a recipe.

### Task 16

None. The plan's code matched the existing modules without changes (GitLabReviewApi, GitLabApiError, ReviewDiscussion, FakeGitLabReview with BOT, diff.ts, the review result types, truncate, errorMessage, JobOutcome, FakeTracker.comments, Redactor). The only edit was putting the two interfaces from the Interfaces block where the plan's placeholder comment was, and turning the two inline field comments into JSDoc.

### Task 17

None in src/: all five source files match the plan. The only choices I made were in the two worker-loop tests the plan left as sketches. I added a `reviewTrigger: ReviewTrigger` object and a `storedReview: StoredReview` object (verdict not_applicable, no comments) to test/worker/loop.test.ts, and imported the `ReviewTrigger` and `StoredReview` types. The stubs are small named async functions that record their name and return { status: "succeeded" }, passed in through `start({ runJob, publishOnly, runReview, publishReviewOnly })`. The assertions are exactly the plan's.

### Task 18

No changes to the Interfaces block or to any test's expected strings. Small additions beyond the plan's wording: (1) examples/kickoff/steward.config.ts already had `bugLabels: ["Bug"]` in `tracker`, so I only added the `review` line. (2) In examples/kickoff/.env.example the plan's new GITLAB_TOKEN comment replaced the old one, and I kept the file's second line in reworded form: the token reaches only the codehost MCP server and the steward's own GitLab calls, never the brain. (3) docs/ops.md §1.6 had no Cloudflare Access Bypass policy to point to, so §1.10 point 4 says "when the tunnel's hostname sits behind Cloudflare Access". (4) To keep the docs consistent I also updated three existing lines: §1.6's list of exposed routes now includes `/webhooks/gitlab`, §1.8's list of doctor checks includes the GitLab review checks, and the README's `steward doctor` row mentions the GitLab review setup. (5) The "skips the review checks" test also asserts that "gitlab webhook secret" does not appear, which is stricter than the plan's single assertion. (6) The project has no prettier setup, so I formatted `configChecks` by hand, one entry per line.

## Minor review issues left open

These are the task reviewers' minor findings, which the workflow does not fix.

- **Task 2**, `test/core/gateway.test.ts`: Review Focus 1 says a Linear-normalized footer is still detected and that its route is still parsed. The plan's test "detects a Linear-normalized footer" only asserts isGatewayIssue. Nothing asserts gatewayRoute or gatewayFooterStart on the '* * *' / '*...*' form. The implementation does handle it: ROUTE matches the starred line and RULE accepts '* * *'. The implementer copied the plan's test exactly, so this is not a deviation. *Suggested fix:* Optionally add these two lines to the 'detects a Linear-normalized footer' test: expect(gatewayRoute(normalized)).toEqual({ className: "gateway", teamKey: "RSPNS" }); and expect(normalized.slice(gatewayFooterStart(normalized) ?? 0).startsWith("* * *")).toBe(true);
- **Task 3**, `test/server/app.test.ts`: The skip test copies the beforeEach buildServer arguments (secrets, stores, tracker, workerState) inline. If the beforeEach setup changes later, the two copies can drift apart. *Suggested fix:* Optional: pull the setup into a small helper, e.g. `const makeServer = (config = makeConfig()) => buildServer({ config, secrets: {...}, stores, tracker, workerState: () => WORKER_IDLE })`, and call it from both beforeEach and the skip test.
- **Task 4**, `src/core/render.ts`: When the gateway footer (or its rule) begins at offset 0, for example a gateway issue whose description is only `---\n\n_Routed by ticket-gateway ..._`, `description.slice(0, footer).trimEnd()` is "", so the result starts with a stray "\n\n" before the section. It does no harm in Linear markdown, and the code is exactly what the plan specifies. *Suggested fix:* Optional: set `const head = description.slice(0, footer).trimEnd();` and return `${head === "" ? "" : `${head}\n\n`}${section}\n\n${description.slice(footer)}`, then add a test for a description that is only the footer.
- **Task 5**, `src/cli/prompt.ts`: The gateway-vars expression `isGatewayIssue(d) ? (gatewayRoute(d) ?? { className: "unknown", teamKey: "unknown" }) : null` is copied word for word in src/cli/prompt.ts and src/core/pipeline.ts prepare(). If one copy changes later (for example the fallback), `steward prompt render` will stop matching what a job actually sends. The deviation itself is justified: without it typecheck fails, and it keeps the preview accurate. *Suggested fix:* Export a small helper from src/core/gateway.ts, e.g. `export const gatewayPromptVars = (description: string): GatewayRoute | null => isGatewayIssue(description) ? (gatewayRoute(description) ?? { className: "unknown", teamKey: "unknown" }) : null;`, and call it from both sites.
- **Task 5**, `test/core/pipeline.test.ts`: Nothing tests the fallback the Interfaces block specifies: footer present but route unparseable gives { className: "unknown", teamKey: "unknown" }. The plan doesn't require that test, so this is only a coverage gap. *Suggested fix:* Add a pipeline case whose description ends in `_Routed by ticket-gateway · reported via Slack_` (no class/arrow), and assert the brain prompt contains "routed it as class `unknown` to team unknown".
- **Task 6**, `/home/admin/ticket-steward/docs/ops.md`: docs/ops.md has no config-reference section, so the tracker.gatewayIssues entry sits as a 'Config reference:' paragraph inside §1.7. The deviation is reasonable and does no harm, but someone scanning ops.md for config keys may not find it. *Suggested fix:* Optional: when ops.md gets a config-reference section, move this paragraph into it, or add a pointer to it in the §6 day-to-day notes.
- **Task 8**, `/home/admin/ticket-steward/src/core/pipeline.ts`: Commit d7150ec removed the trailing newline at the end of pipeline.ts, so the diff shows '\ No newline at end of file' after `publishOnly`. The rest of the code base ends files with a newline. *Suggested fix:* Put the final newline back after the closing `};` of `publishOnly`. It can go in with the next commit that touches pipeline.ts.
- **Task 9**, `prompts/enrich.md`: Step 6 in 'What to do' ('Reproduce (bug tickets only), as described below.') is shown to non-bug tickets as well, and for them there is no section below. The plan asked for this wording, and the {{^isBug}} line covers the case, so the behaviour is correct. The prompt is just slightly confusing for non-bug tickets. *Suggested fix:* Optional: wrap step 6 in {{#isBug}}...{{/isBug}} and let 'Finish' stay step 6 for non-bugs. The plan does not require it, and the existing tests do not depend on it.
- **Task 10**, `src/core/repro.ts`: The refusal notes and the rendered `**Recipe files:**` line put brain-supplied file names inside single backticks. A file name that itself contains a backtick would break the inline code span in the Linear description. The text is still redacted and nothing is at risk, so this is cosmetic only. *Suggested fix:* Optional. Escape or strip backticks in file names before interpolating them in `refused()` and in `renderReproMarkdown`, or use a double-backtick span when the name contains one.
- **Task 10**, `src/core/pipeline.ts`: The deviation (binding `const recipe: Repro` before reassigning `result`) is justified. Without it, TS2322 fires because the non-null narrowing on `result.repro` is lost. Behaviour is the same as the plan and no Interfaces signature changed. Noted for the record; nothing to change. *Suggested fix:* None needed.
- **Task 11**, `src/store/jobs.ts`: Nothing filters by kind in claimOldest, so a review job would currently be run by the enrich pipeline (runJob) with an mr.review trigger. No code enqueues review jobs yet: the webhook comes in Task 12 and worker dispatch in Task 17, so this does not break anything today. It does mean Tasks 12 through 16 must not be deployed on their own. *Suggested fix:* No change needed in Task 11. Task 17 must add the kind === "review" dispatch before anything produces review jobs in a running service. It is worth confirming this during the Task 12 review. *(Resolved by Task 17: the worker now dispatches review jobs to `runReview`/`publishReviewOnly`.)*
- **Task 11**, `test/config/load.test.ts`: The secrets test compares the whole secrets object with toEqual. It will fail if readSecrets ever starts merging extra keys, such as defaults or process env. *Suggested fix:* Optionally switch to toMatchObject({ GITLAB_WEBHOOK_SECRET: "gl-secret", GITLAB_WEBHOOK_SIGNING_TOKEN: "gl-signing" }). It is correct as written for the current readSecrets.
- **Task 12**, `src/server/app.ts`: `reviewSubject` is imported from "../store/jobs.js", while every other store symbol in this file comes through the "../store/index.js" barrel. It works, but it is inconsistent, and later tasks (the review pipeline and worker) will probably need the same import. *Suggested fix:* Add `reviewSubject` to the re-exports in src/store/index.ts and import it from "../store/index.js" in app.ts. This can wait for a later task that already touches store/index.ts.
- **Task 12**, `test/server/app.test.ts`: The "supersedes a queued review of the same MR" test repeats the enqueue and duplicate steps of the preceding test word for word. The plan allowed the split and all assertions are kept, so this is only a little redundant. *Suggested fix:* Optional: in the supersede test, drop the duplicate-redelivery assertion and keep only the enqueue, supersede and final queue-state checks. The dedupe coverage already sits in the "enqueues a review and dedupes a redelivery" test.
- **Task 13**, `test/workspace/mirror.test.ts`: The new test does not show that fetchRef is needed. `git clone --mirror` already copies refs/merge-requests/*, so resolveSha(head) would pass even if fetchRef did nothing. The implementer flagged this too. The test matches the plan word for word. *Suggested fix:* Optional: after Mirror.init, make the ref appear only after init. Run `git update-ref refs/merge-requests/8/head <newHead>` on the source repo after init (or delete the ref from the mirror first), assert that resolveSha fails, then call fetchRef and assert that it resolves. Only do this if the plan owner agrees, because the plan's test was kept verbatim.
- **Task 13**, `src/codehost/gitlabReview.ts`: listDiscussions stops without any signal after MAX_PAGES (50 pages of 100, so 5000 discussions). An MR with more discussions than that would have its later marker notes missed during the idempotency check. This is very unlikely in practice. *Suggested fix:* Optional: throw or log when the loop leaves on the MAX_PAGES bound while x-next-page is still set, rather than returning a partial list without saying so.
- **Task 13**, `src/codehost/gitlabReview.ts`: discussionId goes into the URL path of replyToDiscussion and resolveDiscussion without URL-encoding. GitLab discussion ids are hex, so this is harmless today. *Suggested fix:* Optional: wrap it in encodeURIComponent(discussionId) as a defensive measure.
- **Task 15**, `src/review/result.ts`: The fix commit 3acb927 now downgrades a recipe-backed result with `rerun: null` to `could_not_run`. It leaves `rerun` null, which still does not literally meet the spec's rule that `rerun` is non-null when there is a recipe. The steward cannot invent a replay, so downgrading is the sensible way to enforce the rule, and Task 16's summary renderer already skips the Replay line when `rerun` is null. The downside is that `normalizeReviewResult` now does more than the plan's version does. *Suggested fix:* No code change needed. Record this in the build report as a deliberate deviation: with a recipe, a null rerun becomes could_not_run. Then Task 16 and 17 reviewers will not flag it as drift from the plan.
- **Task 15**, `src/store/jobs.ts`: `toJob` runs `StoredReviewSchema.parse(JSON.parse(row.review_result))`. It throws on a corrupt or schema-drifted row, and that breaks every get or list that touches the row. This matches the plan's instruction and the zod-at-the-boundary rule, but it is a stricter failure mode than the `result` column, which uses an unchecked `as BrainResult`. *Suggested fix:* Optional: leave it as the plan says. Task 17 should know that a bad stored review surfaces as a thrown ZodError when the job is read, not as a job-level error.
- **Task 16**, `src/review/publish.ts`: The maxComments cap is applied to the overall severity rank (`rank >= input.maxComments`), and that rank includes comments that cannot be anchored. With maxComments=1, an unanchorable blocker takes the only slot, so an anchorable major that ranks second goes to the summary instead of being posted inline, even though nothing was posted inline. This matches the plan's code exactly, so it is not a deviation, and no finding is lost because it still appears in the summary. *Suggested fix:* Optional follow-up: keep a counter of inline discussions that were actually attempted and stop at `inlineCount >= input.maxComments`, rather than using the rank index. The order must stay deterministic so retries do not post twice.
- ~~**Task 16**, `src/review/publish.ts`: `supersede` resolves every open steward thread whose marker jobId differs from the current job. It does not check whether the head SHA differs, while the spec says 'from earlier head SHAs'. A second job on the same head (for example after the bot is re-added as a reviewer) therefore resolves the first job's threads for that same SHA. The plan's code does this, and the Task 16 test does not cover it. *Suggested fix:* This is acceptable as written. If the spec wording matters, also skip threads where `marker.sha === input.stored.diffRefs.headSha`, or change the spec to say 'from earlier jobs'.~~ *(Fixed in `85b4720`.)*
- **Task 16**, `src/review/publish.ts`: The Linear 'Verified fixed' comment has no idempotency marker. If the process dies after `tracker.postComment` returns but before the outcome is saved, the retried job skips the GitLab keys correctly but posts the Linear comment a second time. This is an unlikely crash window and is outside the spec's error table. *Suggested fix:* Optional: add a marker to the Linear comment and check the existing issue comments before posting, or accept the risk and note it in Task 17's pipeline.
- **Task 18**, `examples/kickoff/steward.config.ts`: The commented-out example uses botUsername "ticket-steward", as the plan says. But docs/ops.md §1.10 tells readers to use a project access token, whose bot user is named project_<id>_bot_<suffix>. A user who uncomments the line as it stands will fail the new doctor check with "acts as project_..., but review.botUsername is ticket-steward". *Suggested fix:* Optionally add "(replace with your token's bot username, e.g. project_123_bot_abc123)" to the explanatory comment line. This does not block the task.

## Final review

1. The first whole-branch review asked for changes. The workflow's fixer committed `d9f263d`: a newer push that replaces a queued review's trigger now clears that job's saved review result, attempts, backoff and error.
2. The re-review returned **changes**. Tests passed, with one important and two minor issues:

   - **important**, `src/review/publish.ts`: Idempotency and supersede are keyed on the job id only, but Task 12's JobStore.replaceTrigger reuses the same job id when a newer push arrives. Scenario: job 5 reviews head A and posts c0 and c1, then GitLab answers 500 on c2. The job goes to publish_failed and waits, still queued, in the retry backoff. Push B then calls replaceTrigger(5, B), which clears review_result, and job 5 runs a full review of B. postedKeys(own, 5) returns {c0, c1, maybe summary}, so B's c0 and c1 (and its summary) are silently skipped. supersede() then skips every thread whose marker.jobId === 5, so A's stale threads are never resolved. Spec §2.10 says to supersede threads 'from earlier head SHAs', and §2.12 keys dedupe on markers that include sha=. The worker test 'runs a full review for a newer push that supersedes a review waiting to republish' pins this exact path, but only with stub pipelines, so publishing is never exercised.
   - **minor**, `src/server/app.ts`: reviewIntake always swaps a queued review's trigger for the incoming one, even when the incoming delivery is older. GitLab does not guarantee delivery order, and a manual 'Resend' of an old push also counts. If push A arrives after push B, it overwrites B's trigger. At run time the gate sees mr.sha === B !== A and ends the job as 'skipped: moved on', while B's own event has already been consumed. The newest head is never reviewed.
   - **minor**, `README.md`: The command table row for `steward init` still says it writes `steward.config.ts`, `.env.example`, `prompts/enrich.md` and `skills/`. Since Task 18, init also writes `prompts/review.md` (src/cli/init.ts targets, and the command description was updated). The docs contradict the code.

3. The main session fixed two of them in `85b4720`:
   - **Important, fixed:** in `src/review/publish.ts`, `postedKeys` and `supersede` now count a marker as belonging to this review only when both the job id and the sha match. A replaced job reposts its comments for the new head and resolves the old head's threads. The new test `reposts and supersedes when a job is replaced by a newer push` failed before the change and passes after it.
   - **Minor, fixed:** the README's `steward init` rows now list `prompts/review.md`.
   - **Minor, still open:** out-of-order GitLab delivery. An older push arriving after a newer one replaces the queued trigger, and the job then ends as `skipped: moved on`, so the newest head is never reviewed. This is rare. A resend of the latest push event, or re-adding the reviewer, recovers it. Possible fixes: review `mr.sha` when the head has moved and no other review is queued for the MR, or don't replace a trigger whose head is the MR's current head.

After `85b4720`, no whole-branch re-review has been run.

