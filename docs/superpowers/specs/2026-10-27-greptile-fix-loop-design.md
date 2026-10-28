# Greptile fix loop

**Status:** design, awaiting review · **Date:** 2026-10-27 · **Branch:** off `feat/label-workflows`

## Why

Merge requests are now reviewed by Greptile, so the steward's own MR reviewer is redundant. Today the steward's work on
a ticket ends when it pushes the branch for a `ready-for-agent` ticket. Kickoff's pipeline opens the merge request, Greptile reviews it,
and a person has to read the review and do the fixes.

The owner wants the agent that implemented the ticket to keep going: read Greptile's review, fix what needs fixing,
push, wait for Greptile to review again, and repeat. **Greptile's confidence score is the classifier for "good enough
to go out".** A strict 5/5 ends the loop as a success. Anything else, once the loop runs out, goes to a person.

The agent must keep its implementation context across rounds: it is "the same agent", not a fresh one reading the MR
cold.

## Goals

- After an implement job pushes a branch, the steward follows that branch's merge request through Greptile reviews
  until it passes or is handed to a person.
- Every fix round **resumes the Claude Agent SDK session of the implement job** (and of the previous rounds), so
  the agent keeps everything it learned while implementing.
- The agent decides, thread by thread, whether to fix a Greptile finding or decline it with a reply. Disagreement is
  the agent's call.
- Pass = **for the MR's current head commit, the Greptile summary says `Confidence Score: 5/5`, no Greptile
  discussion on the MR is unresolved, and the MR's head pipeline succeeded.** There is no partial pass. 4/5 counts as
  not passed, whatever the severities. A failed pipeline is work for the next round, like a Greptile finding.
- A person can restart a loop that was handed back.
- Remove the steward's own MR reviewer completely.

## Non-goals

- Merging. A person still merges. The steward never approves or merges.
- Containerization. That is a separate design that comes after this one. This design only has to stay compatible with it
  (see "Container-ready seams").
- Looping on comments from people. Only Greptile's findings drive rounds. A person's comment on the MR does not start
  a round (see "Stop conditions" for what a person's push does).
- GitHub. The loop is GitLab-only (`codehost.kind: "gitlab"`).
- The `openai-agents` brain. It cannot resume a session. The loop requires `brain.kind: "claude-code"`.
- Self-managed GitLab. The instance is gitlab.com.

## Anti-goals

These would make the feature a failure even if it "works":

- **The agent gains credentials.** As today, the brain never holds GitLab, Linear or Greptile credentials. The steward
  reads the review, posts replies, resolves threads, commits and pushes.
- **Runaway spend.** Every push costs a Greptile review ($1–$10 in credits) plus an agent run. The loop must be
  bounded (round cap, wait timeouts), and it must never trigger two Greptile reviews for one push.
- **Overwriting a person's work.** If anyone other than the steward pushes to the branch, the loop stops. The steward
  never force-pushes.
- **Claiming a pass on a stale score.** The 5/5 must belong to the current head commit.

## Flow

```
implement job pushes branch ──▶ await-review job (no agent, polls GitLab)
                                    │
     ┌──────────────────────────────┤
     │  MR not open yet / review or pipeline not finished for head ──▶ reschedule (until the timeout)
     │  passed (5/5, nothing unresolved, pipeline green) ──▶ DONE: success
     │  not passed, round < maxRounds ──▶ fix job
     │  not passed, round = maxRounds ──▶ HANDED BACK
     │  stop condition (see below) ──▶ HANDED BACK
     ▼
fix job: resume session ▶ agent fixes / declines each thread, fixes CI failures ▶ steward guards, checks, commits, pushes
         ▶ replies to and resolves every thread ▶ round += 1 ▶ await-review job
```

### Which implements start a loop

Only label-triggered implement jobs that pushed a branch start a loop. `steward implement KEY` (the CLI trigger) leaves
labels alone today and does not start a loop *(builder's call, recorded here)*. `steward fix KEY` can start one on its
branch afterwards (see "Restarting a handed-back loop"). Tickets already in `agent-implemented`
when this ships are not backfilled: their sessions ran in per-attempt directories and cannot be resumed.

### Discovering the merge request

The steward does not open the MR; kickoff's CI does once the branch passes. The await-review job looks it up with
`GET /projects/:id/merge_requests?source_branch=<branch>&state=opened`. Until it exists, the job reschedules.
`greptile.mrTimeoutMinutes` (default 30) bounds the wait, counted from the first poll, not from the push, so a job that sat in the queue
while `serve` was down is not timed out on arrival. When it runs out, the ticket is handed back with "no merge
request was opened for the branch". That usually means CI failed. The MR iid is stored as soon as it is found.

Kickoff's `open:dev-mr` job (`infra/script/ci/generate-pipeline.mjs`) opens a non-draft MR targeting `dev` once the
branch's images build. It reuses any open MR from the branch, and CI never pushes to feature branches (checked
2026-10-27). So a foreign push really means a person.

### Detecting a finished review and its score

GitLab is the source of truth. Polling uses the steward's `GITLAB_TOKEN`:

- **Greptile's identity.** It is the GitLab user named by `greptile.botUsername`. Greptile posts as whatever account
  owns the token it was given, so this is configuration, not a constant.
- **The summary.** It is the newest-`updated_at` text carrying a `Confidence Score: N/5` heading. It may be in the MR description or in
  a note by the Greptile user, depending on Greptile's `shouldUpdateDescription` setting, so the steward checks both.
  Greptile edits the summary in place between reviews.
- **The review is finished for the head** when that summary's "Last reviewed commit" refers to the MR's current head
  SHA. Before that, the job reschedules. The one exception is a round with no push (see "Triggering re-reviews").
- **The score** is the integer parsed from `Confidence Score: (\d)/5`. If no summary parses, the review is "not
  finished".
- **The open findings** are the unresolved, resolvable discussions whose first note is by the Greptile user. Inline
  findings are `DiffNote` discussions.

### The MR pipeline

The steward reads the MR's `head_pipeline` from `GET /merge_requests/:iid` and only uses it when its `sha` is the
head SHA. Kickoff's MR pipeline (`merge_request_event`) runs the affected lint, test, audit and license jobs.

- `created`, `pending`, `running`, `waiting_for_resource`, `preparing`: not finished. Keep waiting.
- `success`: green.
- `failed`: the round's work includes the failure. The steward lists the failed jobs
  (`GET /pipelines/:id/jobs?scope[]=failed`) and gives the agent each job's name, stage and the last
  `greptile.ciLogLines` (default 200) lines of its trace. The traces are redacted with the existing redactor before
  they reach the prompt.
- `canceled`, `skipped`, `manual`, or no pipeline for the head: stop condition. Something outside the loop interfered.

A round is evaluated only when both the Greptile review and the pipeline for the head have finished. Each has its own
timeout.

Each round's wait is bounded by `greptile.reviewTimeoutMinutes` (default 30). When it runs out, the ticket is handed
back with "Greptile did not review <sha>".

**Greptile MCP (optional, steward-side only).** Greptile's MCP server (`https://api.greptile.com/mcp`) exposes the
following:

- `list_code_reviews`, with a status of `PENDING`, `REVIEWING_FILES`, `GENERATING_SUMMARY`, `COMPLETED`, `FAILED` or
  `SKIPPED`, plus a `commitSha`.
- `list_merge_request_comments`, with `suggestedCode`, `filePath` and line range.
- `trigger_code_review`, which accepts `remote: "gitlab"`.

When `greptile.mcp` is configured, the await-review job uses `list_code_reviews` to tell the difference between "still
reviewing" and `FAILED`/`SKIPPED`. Those two hand the ticket back right away instead of waiting out the timeout. The fix
prompt also gets the suggested code for each finding.

The MCP client is the steward's, using `@modelcontextprotocol/sdk`, which is already a dependency. The agent never gets
the Greptile MCP.

Whether the MCP can be used headless is unconfirmed. Its documented auth is OAuth via `claude mcp login`, and an API-key
header is not confirmed. **The builder spikes this first.** If it cannot be used headless, ship without it: everything
above works from GitLab alone.

### Triggering re-reviews

Kickoff's Greptile config must set `autoReview: ["open", "push"]`, so every fix push gets a review with no action from
the steward. The steward triggers a review itself (a `@greptileai review` note, or MCP `trigger_code_review`) **only**
when a round ends without a push. That happens when the agent declined every finding. It is the one case where no new
commit exists to review. This rule is what keeps reviews to one per push.

After a no-push round, the head SHA has not changed, so "Last reviewed commit = head" is already true of the *old*
summary. To tell the new review apart, the steward records the summary's `Reviews (N)` footer counter (or, with the
MCP, the latest review id) when it posts the trigger. It waits for a summary with a higher counter (or a new
`COMPLETED` review for the SHA). If none arrives within `reviewTimeoutMinutes`, it hands back. Whether Greptile
re-reviews an unchanged SHA on `@greptileai review` is not confirmed. **The builder verifies this on a real MR before
building the no-push path.** If Greptile does not, a no-push round hands back immediately instead *(builder's call)*.

### The fix job

1. **Gate.** Every condition must hold; any failure is a stop condition:
   - The MR is open.
   - The MR head SHA equals the SHA the steward last pushed.
   - The ticket is not Done or Canceled.
2. **Workspace.** The worktree is recreated at the ticket's **stable path** `dataDir/work/ticket-<IDENTIFIER>`,
   detached at the head SHA. The implement job uses the same path (see "Session continuity").
   - It gets a fresh slot, the overlay, skills and `workspace.setup`, exactly as for implement.
   - The slot's services start empty and its ports may differ from the implement job's. The prompt says so.
3. **Brain.** It runs with `resume: <sessionId>`. The prompt (`prompts/fix.md`, new) holds:
   - the round number and the score;
   - the Greptile summary;
   - each open finding: discussion id, file, line range, body, and suggested code when available;
   - the failed CI jobs and their log tails, if the pipeline failed;
   - findings that live only in the summary (for example "comments outside the diff", or a score explained only in
     prose). The agent gets the whole summary and is told to treat its findings as work too;
   - a reminder of the rules. The implement rules carry over: edit only in the worktree, never commit or push, and
     verify what the change affects.
4. **Result** (`fix` output schema, validated like the implement result):
   ```
   outcome: "changed" | "no_changes" | "failed"
   threads: [{ discussionId, action: "fixed" | "declined", reply }]   // exactly one entry per open finding
   commitMessage: string        // changed only
   summary: string
   checksRun: string[]
   failureDetail: string | null // failed only
   ```
   - Validation rejects a result whose thread ids do not match the open findings one-to-one.
   - `changed` means the agent edited files. It does not require a `fixed` thread, because the fix may answer a
     summary-only finding.
   - `no_changes` requires every thread to be `declined`.
   - A CI failure does not get a thread entry. The agent fixes it, or explains in `summary` why it cannot, and then
     the outcome is `failed`.
   - If the score is below 5, no finding is open, the pipeline is green, and the agent makes no change, there is
     nothing to argue with.
     The ticket is handed back at once, without spending a review *(builder's call)*.
5. **Commit and push** (`changed` only). These reuse `stageAndGuard`, the secret scan, `implement.checks` and
   `commitWithHooks` unchanged.
   - Checks keep the **original base SHA**, so the turbo filter covers the whole MR.
   - New guard rule: exactly one new commit whose parent is the previous head.
   - New push mode: fast-forward only, `--force-with-lease=<ref>:<previousHead>`, the same `branchRefPattern` check, and a
     bundle of `previousHead..HEAD`.
   - The create-only push stays as it is for implement.
   - A guard or check failure is a stop condition. Nothing is pushed.
6. **Reply and resolve, after the push.**
   - For every thread, post the agent's reply. A `fixed` reply gets a "Fixed in `<short sha>`" suffix.
   - Then resolve the discussion. Greptile keeps unresolved findings in its summary until their threads are resolved, so
     declined threads are resolved too. The reply records the reason.
   - Replies must not contain `@greptile`/`@greptileai`, so that they do not trigger a review.
   - Replies carry a hidden marker so a retried publish does not double-post. The pattern is reused from the old
     reviewer's `<!-- ticket-steward:… -->` markers.
7. Increment the round, store the new head SHA, and enqueue the next await-review job.
   - For `no_changes`, the steward first posts the review trigger (see "Triggering re-reviews").
   - A `no_changes` round counts toward the round cap. Two `no_changes` rounds in a row are a stop condition: the agent
     and Greptile disagree, and only a person can settle it.

### Stop conditions (hand back to a person)

| Condition | Comment says |
| --- | --- |
| `round = maxRounds` and not passed (default `maxRounds` 5; the implement push is round 0) | last score, open findings count, MR link |
| MR closed or merged | stop quietly: no label change, a short Linear comment |
| head SHA ≠ last steward push (someone else pushed) | "a person pushed to the branch; the loop stopped" |
| no MR within `mrTimeoutMinutes` / no review within `reviewTimeoutMinutes` / no finished pipeline within `pipelineTimeoutMinutes` | which wait ran out |
| pipeline `canceled`, `skipped`, `manual`, or missing for the head | the status |
| Greptile review `FAILED` or `SKIPPED` (MCP only) | the status |
| fix brain failed, invalid result, guard or check failure, push rejected | the reason, as implement hand-backs do today |
| two `no_changes` rounds in a row | the agent's reasons, briefly |
| ticket moved to Done or Canceled | stop quietly |

A hand-back is the existing implement hand-back:
- swap `agent-implemented` for `ready-for-human`;
- post a Linear comment (the reason, then the MR link and the last score);
- post a short note on the MR saying the steward stopped and why.

### Success

When the head SHA reaches 5/5 with nothing unresolved and a green pipeline, the steward does three things:
- swaps `agent-implemented` for `agent-approved` (new label; the name is configurable through `tracker.labels` like the
  others);
- comments on the ticket ("Greptile 5/5 after N fix rounds", MR link, one line per round: score, threads fixed and
  declined);
- leaves the MR alone.

### Restarting a handed-back loop

A person restarts a loop by **adding `ready-for-agent` again** to a ticket whose loop is `handed_back` *(builder's
call: it reuses the label people already know, so there is no new label)*. Today that hands back with "a branch for X
already exists". With a handed-back loop whose MR is still open, intake starts a restart instead of an implement:

- The loop goes back to `awaiting_review` with a fresh round budget: `round` resets to 0, and the history is kept.
- The steward adopts the branch's current head as its own last push, so a person's commits are accepted, not treated
  as a foreign push. Those commits are listed in the next fix prompt ("a person pushed: <subjects>").
- The next round resumes the same session id.
- The ticket's label swaps from `ready-for-agent` to `agent-implemented`, as after an implement.
- Anything a person wants the agent to know goes in a Linear comment. Comments posted after the hand-back are included
  in the next fix prompt.

If the MR was closed or merged, or the branch is gone, `ready-for-agent` keeps today's behaviour: a fresh implement
when no ticket branch exists, otherwise the existing "branch already exists" hand-back.

A `steward fix KEY` CLI command does the same restart without the label (it leaves labels alone, like
`steward implement`).

## Session continuity

This is the core requirement. It works by resume, not by keeping a process alive.

The brain's process group is killed after every run (`src/brain/spawn.ts`), and a Greptile review takes minutes.
Keeping a process alive would hold a worker slot for the whole loop and would not survive a restart. Claude Agent SDK
resume reloads the full session history, so the resumed agent has the same context. The SDK auto-compacts long
sessions.

What has to change:

- **Session id.**
  - `BrainRun` returns the SDK `session_id`.
  - Implement and fix jobs store it on the loop (below).
  - `BrainInput` gains an optional `resumeSessionId`.
  - The existing `error_max_turns` follow-up keeps working. While here, fix the bug where it drops the main run's usage
    from the reported cost.
- **Stable cwd.** The SDK finds a session by the project key derived from the cwd. Implement jobs with `greptile`
  configured therefore use `dataDir/work/ticket-<IDENTIFIER>`, not `work/<jobId>-<attempt>`. Only one job per ticket
  runs at a time (the existing claim rule on `issue_id`), so the path is never shared. Every fix job recreates the
  worktree at that path.
- **Session storage.**
  - The brain env allowlist gains `CLAUDE_CONFIG_DIR=<dataDir>/sessions`.
  - That directory joins `denyPaths`: session files are unredacted and must not be readable by other jobs' agents.
  - Retention deletes a ticket's sessions `retention.days` after its loop ends, never while it is active.
  - Claude Code's own transcript cleanup (`cleanupPeriodDays`, default 30) must not delete an active loop's session.
    The builder confirms the default is safe for the loop's maximum lifetime, or raises it.
- **Retries.** An interrupted fix job resumes from the stored session id as it was before the interrupted run. The
  partial turn is lost, but the earlier context is not. The builder decides between that and resuming the interrupted
  run's own session, if the SDK persisted it.

## Loop state

The steward keeps one record per ticket loop. Table versus columns is the builder's call. The fields:

| Field | Notes |
| --- | --- |
| issue id, identifier | the Linear ticket |
| implement job id | origin |
| branch, base SHA, head SHA | head = last SHA the steward pushed |
| MR project, iid | null until discovered |
| session id | latest resumable session |
| round | 0 after implement |
| state | `awaiting_mr` · `awaiting_review` · `fixing` · `passed` · `handed_back` · `stopped` |
| last score, rounds history | score, threads fixed/declined, head SHA per round; feeds the comments |
| deadline | when the current wait times out |

Jobs:
- **`await_review`** is new. It has no workspace, slot or brain, and it reschedules itself via `not_before`, at
  `greptile.pollSeconds`, default 300 (a fallback; GitLab webhooks wake it sooner, see Webhooks).
- **`fix`** is new and uses the brain.

Both use `issue_id` = the Linear UUID and `subject = mr:<project>!<iid>`, so the existing claim rules keep them from
running alongside each other, or alongside an enrich or implement for the same ticket.

An await-review job takes a lane only for the seconds a poll takes. It must not bring a slot up or down. The worker
currently ties a lane to a slot, so the builder decides how `await_review` skips the slot. `steward jobs` shows both
kinds, and `steward jobs show` shows the loop's round history.

## Removing the steward's MR reviewer

Remove the following. The builder finds the exact sites by searching for `review`, `mr.review`, `reviewSubject`,
`review_result`, `GitLabReview` and `registerGitlabWebhook`:
- `src/review/`, `prompts/review.md`;
- the `review` config block and its refine;
- the `review` brain output;
- the `/webhooks/gitlab` route and `reviewIntake`;
- the `mr.review` trigger and `review` job kind with their store functions and claim clauses;
- doctor's review checks;
- the review sections of README, `docs/ops.md`, `.env.example` and the kickoff example;
- the tests under `test/review/`, the GitLab review and webhook tests, and their fakes.

Keep, for the loop:
- `GitLabReviewClient`'s `getMergeRequest`, `listDiscussions`, `replyToDiscussion`, `resolveDiscussion`, `createNote`,
  and its 429 handling. Rename and re-gate it on `greptile`.
- The marker pattern for idempotent posts.

The reviewer's GitLab webhook route and delivery code go too. (`verifyGitlabWebhook` and the GitLab webhook secrets came
back for the loop's wake-ups; see Webhooks.)

### Webhooks

GitLab webhooks are the loop's primary wake signal and polling is the fallback, every `pollSeconds` (default 300), with
each wait bounded at 30 minutes (on kickoff MR pipelines take 7.3 min at the median, 14.4 at most; Greptile's first
review 3.2, 12.3 at most). `POST /webhooks/gitlab` verifies the delivery (signing token in `GITLAB_WEBHOOK_SIGNING_TOKEN`,
or the legacy secret in `GITLAB_WEBHOOK_SECRET`; 401 otherwise) and reads Merge Request, Note (on an MR, created or
edited: Greptile edits its summary in place) and Pipeline events. One that names the branch or MR of a loop in
`awaiting_mr` or `awaiting_review` on the configured project makes that loop's queued await job due now
(`JobStore.wake`); it never creates a job or touches a running one. Every validly signed event gets a 200 with
`ignored`, `woken` or `no_loop`, so GitLab never disables the hook.

Also remove the repro *replay* plumbing whose only consumer was the reviewer: the `repros` table, `dataDir/repros/`,
and `restoreReproFiles`. The reproduction recipe stays in the Enrichment section. Fix `prompts/enrich.md`'s line about
replaying it "later on the merge request".

The migration fails any queued or running `review` job with "MR review was removed".

## Configuration

```ts
greptile: {
  botUsername: "greptile-bot",      // GitLab username Greptile posts as
  maxRounds: 5,                     // fix rounds before hand-back
  prompt: "./prompts/fix.md",
  pollSeconds: 300,
  mrTimeoutMinutes: 30,
  reviewTimeoutMinutes: 30,
  pipelineTimeoutMinutes: 30,
  ciLogLines: 200,
  mcp: { url: "https://api.greptile.com/mcp" },  // optional; auth decided by the spike
},
```

Config rules (each a schema refine):
- `greptile` requires `implement`;
- `codehost.kind` must be `"gitlab"`;
- `brain.kind` must be `"claude-code"`.

`GITLAB_TOKEN` needs the `api` scope (replies, resolves) and Developer on the project. Steward doctor gains these checks:
- the token's scope and role;
- that `botUsername` exists;
- that the `agent-approved` label exists;
- if `mcp` is set, a `list_repositories` call succeeds.

**Outside the steward**, in `docs/ops.md`:
- Kickoff's `.greptile/config.json` sets `autoReview: ["open", "push"]`.
- The steward's commit author or push user must not match Greptile's `excludeAuthors`.
- CI must open the MR as non-draft, because Greptile skips drafts by default.

## Container-ready seams

Containerization is next, so this design avoids anything that ties the loop to the host:
- The stable cwd becomes a fixed path inside the job container.
- `CLAUDE_CONFIG_DIR` becomes a per-ticket volume.
- The await-review job needs nothing but the controller.
- Push, replies and resolves stay in the controller, which is where they will live in the container design.

## Left to the builder

- Loop state as a table or as columns.
- How `await_review` avoids the slot.
- Prompt wording in `prompts/fix.md`.
- The `cleanupPeriodDays` question.
- The interrupted-retry session choice.
- The Greptile MCP spike and auth.
- Test layout.

Two other fixes from the research belong here because they touch the same code:
- `steward jobs gc` must take `run.lock` (it can delete a running job's worktree);
- `steward jobs` should print `job.kind`.

## Open risks

- **The 5/5 may never come.** Fixes can attract new minor findings, and risky areas tend to stall below 5. The round
  cap turns that into a hand-back, which is the intended "not good enough to go out" answer. Lowering Greptile's
  `strictness` in kickoff is an owner decision, outside this design.
- **Greptile's output format is not a published contract.** The score heading and the "Last reviewed commit" footer
  are observed, not documented. Parse defensively. When the summary is not recognisable, keep waiting until the
  timeout and then hand back, never pass.
- **Cost.** At most `maxRounds + 1` reviews per ticket, plus the agent runs.
