# Ticket Steward: bug reproduction and merge-request review

**Status:** approved in conversation on 2026-09-25 (owner: adam@concentrate.ai). Implementation plan: `docs/superpowers/plans/2026-09-25-steward-repro-mr-review.md`.

This work comes after the gateway-compatibility work in `docs/superpowers/plans/2026-09-25-steward-gateway-compat.md`, which has two parts:
- API key auth (done).
- Tasks 2–6 (gateway detection, the skip switch, footer placement, the gateway-aware prompt).

Both plans run on the branch `feat/linear-api-key`.

## 1. What the owner asked for

Quoted from the 2026-09-25 session:

- "it should enrich the ticket but also try and repro the issue because that's important"
- "when adding the steward as a reviewer, it should not run the tests, the pipeline does that anyways"
- "it should try and repro the bug with the exact method it repro'd it to begin with, given that the ticket is actually a BUG. if it's not a bug then there's nothing to repro"
- "inline comments on specific diff lines"
- "on each new push while it's still a reviewer"
- "skip mrs without a linear key"
- "there are no tickets enriched before this feature exists, so assume that"

Earlier asks:
- "add comments onto the PR if the issue wasn't resolved, or if it found other issues"
- The MR feature needs GitLab tokens that can write comments.

## 2. Decisions

1. **Every new ticket is still enriched.** A **bug** ticket also gets a reproduction attempt in the same brain run.
   - "Bug" means the Linear issue has a label named in `tracker.bugLabels`. The default is `["Bug"]` and matching ignores case.
   - ticket-gateway already applies its configured Bug label to Slack bug reports.
2. **Reproduction only runs against the app started from the steward's own checkout.**
   - It uses the sandbox credentials in the overlay and the steward's port (`STEWARD_PORT`).
   - Never staging, never production.
   - The prompt says so, and the existing policy guard is unchanged.
3. **The recipe is the "exact method".** It is stored so it can be replayed later:
   - `status`: `reproduced` or `not_reproduced`
   - `method`: `test`, `script`, `http` or `browser`
   - the one `command` to run from the workspace root (null only for pure browser steps)
   - the numbered `steps`
   - every `file` the brain created for it
   - `expected` and `observed`

   The steward copies those files out of the worktree when the run ends, into `<dataDir>/repros/<jobId>/`. It writes the recipe to a new `repros` table, keyed by Linear issue id; the latest recipe wins. A readable copy goes in the Enrichment section under **Reproduction**.
4. **Non-bug tickets get no reproduction.** The steward forces `repro` to null for them, whatever the brain returns.
5. **No backfill.** Tickets enriched before this feature have no recipe. The owner said none exist, and the code treats a missing recipe as "not reproduced".
6. **MR review trigger: the GitLab "Merge request events" webhook** at `POST /webhooks/gitlab`. A review is queued when any of these happens:
   - the steward's GitLab user is newly added as a reviewer (`action: update`, bot in `changes.reviewers.current` but not in `previous`);
   - an MR is opened or reopened with the bot already a reviewer;
   - a new push arrives (`action: update` with `object_attributes.oldrev`) while the bot is still a reviewer.

   Everything else is acknowledged and ignored with a logged reason:
   - approvals and system events;
   - closed or merged MRs;
   - MRs where the bot is not a reviewer;
   - MRs from forks, unless `review.allowForks` is set (a fork's code would run with the overlay's sandbox credentials).
7. **The Linear key** is the first `<TEAM>-<number>` found in the source branch, then the title, then the description.
   - Matching ignores case, so `api-123-fix-stream` gives `API-123`.
   - `TEAM` must be in `tracker.teams` when that list is non-empty.
   - **An MR with no key is ignored silently**, with no comment.
8. **What a review does:**
   - It checks out the MR head, fetched explicitly from `refs/merge-requests/<iid>/head`.
   - It applies the overlay and skills and runs `workspace.setup` (the install, not tests).
   - It gives the brain the ticket, the MR diff (written by the steward to `mr.diff`) and, for a bug, the recipe, with the recipe files restored to their original paths.
   - **The brain does not run the test suite, lint or typecheck.** The CI pipeline does.
   - For a bug, it replays the recipe exactly and reports whether the bug still reproduces.
   - For every ticket, it reviews the diff for other problems and returns comments on specific lines.
9. **What happens for each kind of ticket:**

   | Ticket | Recorded recipe | Review |
   |---|---|---|
   | Bug | `reproduced` | Replay the recipe and review the diff; the verdict is `fixed`, `not_fixed` or `could_not_run`. |
   | Bug | missing or `not_reproduced` | No brain run. One MR note per MR: "the steward could not reproduce API-123 originally, so it cannot verify this fix." |
   | Not a bug | n/a | Diff review only; the verdict is `not_applicable`. |

   *Assumption:* non-bug MRs still get the diff review, for "other issues". Turning that off is a one-line gate in `runReview`.
10. **Output on GitLab:**
    - One inline diff discussion per finding, on the exact line: an added line uses `new_line`, a removed line `old_line`, and an unchanged line both.
    - At most `review.maxComments` findings (default 15), most severe first. Findings that don't map to a diff line, that GitLab rejects with a 400, or that go over the cap are listed in the summary note.
    - One **summary note** per review. It holds the verdict, the replay result, the reviewed head SHA and the confidence.
    - **On each new push:** before posting, the steward resolves its own still-open threads from earlier head SHAs. It replies "Superseded by the steward's review of `<sha>`" and marks them resolved. Human threads are never touched.
11. **Output on Linear:** when the verdict is `fixed`, the steward also posts a Linear comment: "Verified fixed by !<iid> at `<sha>` …". Other verdicts post only on GitLab.
12. **Publishing is idempotent.** Every steward note carries a hidden marker, `<!-- ticket-steward:review job=<id> sha=<sha> key=<k> -->`. A retried publish lists the discussions and skips keys that already exist, so nothing is posted twice.
13. **Staleness is checked at run time.** Before doing any work, the job re-fetches the MR and skips (success with a warning) when:
    - the MR is no longer open;
    - the bot is no longer a reviewer;
    - the head SHA has moved on, in which case the newer push has its own event.

    A newer push replaces the trigger of a review still waiting in the queue for the same MR, so a burst of pushes becomes one review.
14. **One worker, one port, one run lock.** Reviews share the FIFO queue with enrichments. They are not prioritised; that is deferred.
15. **Auth and secrets:**
    - **`GITLAB_TOKEN`** needs the `api` scope (`read_api` cannot post notes). Its user needs **Reporter** or higher on the project, which is enough to comment, be a reviewer and resolve its own threads. That user is the steward's reviewer identity, and `review.botUsername` names it.
      - The owner is on **GitLab Ultimate** (confirmed 2026-09-25), so a project access token works and MRs can have several reviewers. On Free, you would use a dedicated user's personal access token instead, and adding the steward would replace the human reviewer.
      - `doctor` checks that the token has the `api` scope and that its user matches `review.botUsername`.
    - **Webhook verification.**
      - With a signing token, set `GITLAB_WEBHOOK_SIGNING_TOKEN`. This is the Standard Webhooks `whsec_…` value, and verification uses the `webhook-id`, `webhook-timestamp` and `webhook-signature` headers (GitLab 19.1+).
      - Without one, set `GITLAB_WEBHOOK_SECRET`, which is checked against the `X-Gitlab-Token` header.
      - At least one must be set, or the route answers 401.
      - The route answers 404 when `review` is not configured.
    - **Dedupe key:** the `webhook-id` header, else `Idempotency-Key`, else `gitlab:<project>:<iid>:<sha>:<reason>`.
    - **Rate limits:** GitLab.com allows about 60 note creations per minute per user, so discussions are posted one at a time. A 429 is retried after `Retry-After`.
16. **No new dependencies.** The GitLab review client uses `fetch` and zod; gitbeaker stays for the existing commit lookups. The diff parser is local code.

## 3. Architecture

```
Linear Issue-create webhook ──► enrich job ──► brain (output "enrich")
                                               │  result.repro (bugs only)
                                               ▼
                              repros table + <dataDir>/repros/<jobId>/files
                                               ▲
GitLab MR webhook ──► review job ──► runReview ┤ recipe lookup by Linear issue id
                                               ▼
                                    brain (output "review") ──► publishReview
                                                                 ├─ resolve own stale threads
                                                                 ├─ inline diff discussions
                                                                 ├─ summary note
                                                                 └─ Linear comment (verdict fixed)
```

### Units

| Unit | Responsibility |
|---|---|
| `src/core/repro.ts` | `isBugTicket`, `normalizeRepro`, `captureReproFiles`, `restoreReproFiles`, `renderReproMarkdown` |
| `src/store/repros.ts` | `ReproStore`: `upsert` and `get` a recipe by issue id |
| `src/codehost/gitlabWebhook.ts` | `verifyGitlabWebhook`, `parseMergeRequestEvent`, `extractLinearKey`; pure functions |
| `src/codehost/gitlabReview.ts` | `GitLabReviewApi` interface, and `GitLabReviewClient` built on fetch + zod: get MR, list discussions, create diff discussion, create note, reply, resolve, current user |
| `src/review/diff.ts` | Parses a unified diff into line anchors and maps `{path, line, side}` to a GitLab position |
| `src/review/result.ts` | `ReviewResultSchema`, `validateReviewResult` |
| `src/review/pipeline.ts` | `runReview`, `publishReviewOnly`: gates, workspace, brain |
| `src/review/publish.ts` | `publishReview`: markers, supersede, inline comments, summary, Linear |
| `src/core/workspace.ts` | Workspace steps shared by both pipelines, extracted from `pipeline.ts`: paths, prepare, brain input, cleanup |
| `prompts/review.md` | The review prompt |

### Contracts

- **`BrainInput.output: "enrich" | "review"`.** Each brain picks the matching zod and JSON schema, so the Claude and OpenAI structured outputs stay strict. Every new field is required, and absent values are `null`, not optional, because OpenAI's strict mode needs that.
- **`BrainResult.repro`** is `ReproSchema | null`.
- **`ReviewResult`:**
  ```ts
  {
    verdict: "fixed" | "not_fixed" | "could_not_run" | "not_applicable";
    rerun: { observed: string; deviations: string | null } | null;
    summary: string;
    comments: Array<{ path: string; line: number; side: "new" | "old"; severity: "blocker" | "major" | "minor"; body: string }>;
    confidence: "low" | "medium" | "high";
  }
  ```
  The steward enforces three rules:
  - with no recipe, the verdict must be `not_applicable` and `rerun` null;
  - with a recipe, the verdict is not `not_applicable` and `rerun` is non-null;
  - every `line` is at least 1.
- **Jobs.**
  - New columns: `kind` (`enrich` | `review`, default `enrich`), `subject` (`mr:<projectId>!<iid>` for reviews), `review_result` (a JSON `StoredReview`, which is `{ result, diffRefs }`).
  - `TriggerEvent` gains `{ kind: "mr.review"; deliveryId; projectId; projectPath; mrIid; mrUrl; headSha; linearKey; teamKey; reason: "opened" | "reviewer_added" | "push" }`.
  - For a review job, `issue_id` and `identifier` hold the Linear key. It is resolved to the issue id when the job runs.
  - The enrichment queries (`hasSucceeded`, `findQueued`) are limited to `kind = 'enrich'`.
- **Worker dispatch:**
  - `kind === "review"` goes to `reviewResult === null ? runReview : publishReviewOnly`.
  - Other jobs keep today's `result === null ? runJob : publishOnly`.
- **Config:**
  - `tracker.bugLabels` (default `["Bug"]`).
  - An optional `review: { botUsername, prompt, allowForks = false, maxComments = 15 }`, which requires `codehost.kind === "gitlab"`.
  - Secrets: `GITLAB_WEBHOOK_SECRET`, `GITLAB_WEBHOOK_SIGNING_TOKEN`.

## 4. Error handling

| Situation | Outcome |
|---|---|
| Webhook fails verification | 401. Nothing is stored, so GitLab's auto-disable after 4 failures points at misconfiguration. |
| Webhook for an unsupported event, or an ignored MR | 200 `{action: "ignored", reason}` |
| MR `diff_refs` not populated yet (just opened) | `failed`, retryable (backs off 1 min, then 5 min) |
| Stale job (closed, bot removed, head moved) | `succeeded` with a warning `skipped: …` |
| Linear key does not resolve | `failed`, retryable; after `maxAttempts` it becomes terminal |
| Bug with no reproduced recipe | One marked note per MR (keyed `unverifiable`); `succeeded` |
| Setup or brain failure | Same as enrichment: setup is retryable, brain and validation are not |
| GitLab 400 on a diff position | That finding goes to the summary note |
| GitLab 429 | Wait for `Retry-After` (capped at 60 s), up to 3 retries, then `publish_failed` (retryable). Markers stop duplicates on retry. |
| Other GitLab errors while publishing | `publish_failed`, retryable; the stored review result is republished without a new brain run |
| Linear comment fails after a `fixed` verdict | `succeeded` with a warning |

All text sent to GitLab or Linear, including recipe commands and observed output, goes through the `Redactor` first.

## 5. Testing

Unit tests use fakes only: `FakeTracker`, a new `FakeGitLabReview`, `FakeBrain`, and a real temporary git repo from `tmpRepo`. They cover:
- the webhook parse rules, including both `changes.reviewers` shapes;
- key extraction;
- verification of both secret styles, including a stale timestamp;
- diff anchors (added, removed, context, renamed, deleted and new files, multiple hunks);
- idempotent publish (retry after a partial post);
- supersede;
- the case table in §2.9;
- repro capture (path traversal, symlink escape, size cap);
- worker dispatch by kind.

A live check against a real MR is owner-run (plan Task 17).

## 6. Deferred

- Uploading screenshots to GitLab.
- Prioritising reviews over enrichments.
- A `steward review <mr>` CLI trigger.
- Reviewing MRs whose ticket was never enriched by this version (no backfill).
- GitHub pull requests.
