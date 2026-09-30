# Label workflows: triage and agent implementation

**Status:** design, awaiting review · **Date:** 2026-09-30 · **Branch:** `feat/label-workflows`

## Goal

Linear labels drive what the steward does to a ticket. A person keeps two decisions:

- **A. Whether a ticket is triaged:** they add `needs-triage`.
- **B. Whether an AI implements it:** they add `ready-for-agent`.

The steward never applies `needs-triage` or `ready-for-agent` itself. It never creates a merge request. For implementation, its git operations stop at pushing a new branch. The kickoff GitLab pipeline opens the merge request when the branch passes, and the Linear–GitLab integration links it to the ticket.

The Managed Agents brain is a separate, later spec. This one runs on the configured brain (openai-agents today).

## Labels

| Label | Applied by | Meaning |
|---|---|---|
| `needs-triage` | person | Triage this ticket. Replaces the `steward` label. |
| `needs-info` | steward | Something only a person can supply is missing; the steward commented the questions. |
| `ready-for-human` | steward | Specified enough to build (triage), or an agent tried and handed back (implement). |
| `ready-for-agent` | person | Implement this ticket. |
| `agent-implemented` | steward | An agent pushed a branch for this ticket. |

All five must exist in Linear; `steward doctor` checks them. A label counts only when it is **first added** to a ticket (or is present when the ticket is created), as with today's `triggerLabel`. Done and Canceled tickets are never worked on (existing rule, checked at intake, job start and before every write).

## Flows

```
needs-triage ──triage job──▶ needs-info       (questions commented)
                        └──▶ ready-for-human  (enrichment + agent brief)
                                   │ person adds ready-for-agent
ready-for-agent ──implement job──▶ agent-implemented  (branch pushed)
   ▲ (also directly, skipping triage)  ├──▶ ready-for-human  (tried, failed; nothing pushed)
                                       └──▶ needs-info       (too vague; nothing changed)
```

## Section 1: Triage (`needs-triage`)

Triage is the existing enrich job plus a verdict (approach A: no new job kind).

**Result.** `BrainResult` gains one required field:

```
triage: {
  state: "needs-info" | "ready-for-human",
  questions: string[],       // needs-info: specific things only the reporter can answer; non-empty
  agentBrief: string | null  // ready-for-human: non-null; goal, acceptance criteria, files, approach, out of scope
}
```

Validation rejects `needs-info` with no questions and `ready-for-human` without a brief. `prompts/enrich.md` gains a "Triage verdict" step with this guidance and the agent-brief outline. The brief is written for an agent that has only the ticket and the brief and cannot ask questions.

**Publish, in this order:**

1. Write the Enrichment section (as today). For `ready-for-human` it contains an `### Agent brief` subsection between its own markers (`<!-- ticket-steward:brief:begin -->` … `:end -->`), so the implement job can find it.
2. Post a comment: the numbered questions (`needs-info`) or a one-line verdict pointing at the brief (`ready-for-human`).
3. Swap labels: remove `needs-triage`, add the verdict label.

Labels change last, so a failure earlier leaves `needs-triage` visible and the job `publish_failed` (re-publishable without re-running the brain, as today). Label swaps happen only for jobs triggered by the triage label; `steward enrich KEY` writes the section and comment but leaves labels alone.

**Unchanged:** a ticket that already has an Enrichment section is skipped at intake ("already enriched"). No `wontfix` or other closing verdict.

## Section 2: Implement job (`ready-for-agent`)

A new job kind `implement`, in its own module `src/implement/` (prompt, result, pipeline, publish), laid out like `src/review/`.

**Intake.** Triggered by `ready-for-agent` being first added. Skipped if the ticket already has a succeeded implement job (`steward implement KEY` re-runs one by hand, analogous to `steward enrich`).

**Workspace.** Same as every job: fresh worktree at the latest `dev` (detached), overlay, skills, then `workspace.setup` (`reset-dbs.sh`, install, package build). No branch is created in the worktree; the branch exists only as the push target (Section 3).

**Branch.** `<type>/<IDENTIFIER>-<slug>`, e.g. `fix/USRAPP-101-routing-drops-last-chunk` or `chore/API-101-bump-pg`. The type is one of `implement.branchTypes` (default `feature`, `fix`, `chore`, `refactor`) and is chosen by the agent in its result (`branchType`), since it is the one that knows what kind of change it made; the steward rejects any other value (`failed` hand-back). The identifier keeps Linear's casing. The slug is the ticket title lowercased, reduced to `[a-z0-9-]`, hyphens collapsed, cut to 40 characters. The steward builds the name at push time. If any remote branch already carries the ticket (`git ls-remote` for `refs/heads/*/<IDENTIFIER>-*`, any type, checked before the brain runs and again before pushing), the job ends in the `ready-for-human` hand-back with a comment naming that branch; the steward never touches an existing branch.

**Brief or not.** If the description holds the agent-brief markers, `prompts/implement.md` renders the brief-first variant ("this is your spec; check it against the current code"). Otherwise it renders the investigate-first variant ("find the code, decide an approach; if the ticket is too vague to implement responsibly, stop and return your questions"). Both get the full ticket (description, comments, attachments) and these rules:

- Edit files only inside the checkout. Never commit, push, or change git config or remotes (the existing policy blocks stay in force for this job too).
- Run the typecheck, lint and relevant tests while working and fix what they catch.
- Keep the change scoped to the ticket; no unrelated refactors.
- The UI-verify skill is available for UI work.

**Result** (new schema, `src/implement/result.ts`):

```
outcome: "implemented" | "failed" | "needs_info"
branchType: "feature" | "fix" | "chore" | "refactor"  // implemented only; must be in implement.branchTypes
commitMessage: string         // subject + body; the steward prefixes the subject with "<IDENTIFIER>: "
summary: string               // what changed and why
reviewNotes: string[]         // what a reviewer should check or know
checksRun: string[]           // commands the agent ran and their results
questions: string[]           // needs_info: non-empty
failureDetail: string | null  // failed: non-null
```

## Section 3: After the agent (steward-only steps)

The agent's `outcome` is a claim; the steward verifies before anything leaves the box. For `implemented`, in order, stopping at the first failure:

1. **There is a change.** `git status --porcelain` shows modifications. An empty diff becomes the `failed` hand-back ("agent reported implemented but changed nothing").
2. **Stage and guard.** `git add -A`, then abort (`failed` hand-back, nothing committed) if any staged path:
   - is a file the overlay copied in (the steward knows the list from `copyOverlay`) or under the copied skills directory, or
   - contains, in its staged diff, the value (8 or more characters) of any overlay env variable whose name looks secret (`PASSWORD`, `SECRET`, `TOKEN`, `KEY`, `CONN_STR`, or a URL with embedded credentials). Plain values such as `localhost` or `development` are not checked, so ordinary config does not trigger false hand-backs.
   The hand-back comment names the offending paths only, never the values.
3. **Checks.** The steward runs `implement.checks` itself in the worktree with the job env. The default for kickoff is `pnpm turbo check-types lint --filter='...[<base-sha>]'` (packages changed since the base commit and their dependents), with a timeout (`implement.checksTimeoutMinutes`, default 20). Any non-zero exit is the `failed` hand-back, with the output tail in the comment (redacted).
4. **Commit with hooks.** The steward commits as a configured identity (`implement.commitAuthor`, e.g. `Ticket Steward <steward@concentrate.ai>`) with kickoff's Husky hooks enabled for that one command. The shared mirror's git config is never changed. kickoff's pre-commit runs `pnpm audit --audit-level=high`, `lint-staged` and `verify-license.sh` on feature branches (its `pnpm run types` runs only on main/dev/staging, which is why step 3 exists). A hook failure is the `failed` hand-back with the hook output. A known risk: `pnpm audit` can fail on an unrelated advisory; that surfaces as a hand-back naming the advisory rather than a silent skip.
5. **Keep the commit.** The steward records the commit as a local ref in the mirror (`refs/steward/implement/<jobId>`) and on the job (`branch`, `commit_sha`), so a failed push can be retried after the worktree is gone.
6. **Push.** `git push <url-with-token> <sha>:refs/heads/<branch>`, no force. Before pushing, the steward refuses unless all hold: the target matches `refs/heads/(<branchTypes>)/<IDENTIFIER>-[a-z0-9-]+` exactly; no remote branch carries the ticket; the commit has exactly one parent and it is the `dev` commit the job started from. The URL carries `GITLAB_PUSH_TOKEN`, built per push, never written to git config, never in the brain's environment, and redacted from all output. `MIRROR_TOKEN` stays read-only.

   **Token.** Either a new project access token with the Developer role and only `write_repository` (recommended: it can do nothing but git push), or the existing reviewer token (`GITLAB_TOKEN`) raised from Reporter to Developer and set as `GITLAB_PUSH_TOKEN` too. Reuse works because `api` scope covers git over HTTPS, but `api` + Developer can also merge into unprotected branches, approve and create merge requests, delete branches and run pipelines through the API, so a leak costs more.

   **Branch protection (server-side).** `main`, `staging` and `dev` are protected in GitLab with named-user push and merge allowlists; the token's bot user is on none of them, so GitLab rejects any push or merge to those branches whatever the steward does. The bot must never be added to those allowlists. GitLab cannot enforce "only branches cut from dev" (it sees ref names, not ancestry); the steward's pre-push checks above cover that.

**Publish** (after a push, or directly for `failed` / `needs_info`), comment first, labels last:

| Outcome | Comment | Labels |
|---|---|---|
| implemented + pushed | Branch name and GitLab link, summary, review notes, checks run | `ready-for-agent` → `agent-implemented` |
| failed (agent or steward step) | What was tried, what failed and where, output tails | `ready-for-agent` → `ready-for-human` |
| needs_info | The numbered questions | `ready-for-agent` → `needs-info` |

Every steward comment uses the existing redactor.

## Section 4: Config, retries, and operations

**Config** (`src/config/schema.ts`):

```ts
tracker: {
  // replaces triggerLabel; unset keeps the old "enrich every new ticket" behaviour
  labels?: {
    triage: string;            // "needs-triage"
    implement: string;         // "ready-for-agent"
    needsInfo: string;         // "needs-info"
    readyForHuman: string;     // "ready-for-human"
    implemented: string;       // "agent-implemented"
  },
},
implement?: {                  // absent disables the implement job; ready-for-agent is then ignored
  branchTypes: string[];       // default ["feature", "fix", "chore", "refactor"]
  checks: string[];            // run by the steward after the brain
  checksTimeoutMinutes: number;// default 20
  commitAuthor: { name: string; email: string };
  timeoutMinutes?: number;     // brain timeout override, default 60 (triage keeps brain.timeoutMinutes)
  maxTurns?: number;           // brain turn override, default 150
},
```

`tracker.triggerLabel` is removed; the live config moves to `labels` in the same deploy. `implement` requires `GITLAB_PUSH_TOKEN` in `.env` (config load fails otherwise).

**Webhook and intake.** `parseEvent` reports which configured label was added (create-with-label or update-that-added-it). The trigger records it (`action: "triage" | "implement"`); intake maps `triage` to an `enrich` job and `implement` to an `implement` job. Stored triggers without `action` are read as triage. The existing checks (team allowlist, closed state, gateway rule, already enriched / already implemented, queued duplicate) apply per kind.

**Store.** `JobKind` gains `implement`. New columns: `implement_result`, `branch`, `commit_sha`. "Already succeeded" and "queued duplicate" lookups filter by kind.

**Retries.** Brain and setup failures follow the existing retry rules (setup/fetch retryable, brain errors not). Steward-step failures (empty diff, guard, checks, hooks) are hand-backs: the job **succeeds** with the hand-back published; they are the answer, not an error. A push or Linear write failure is `publish_failed`; `steward jobs retry` re-runs only the publish (push from the stored ref, then comment and labels), never the brain. Once `commit_sha` is pushed, no path pushes again.

**Worker.** Still one job at a time. An implement job can hold the worker for up to about 90 minutes (setup + 60 brain + checks); triage jobs queue behind it. Acceptable for v1; parallel workers are out of scope.

**Doctor.** Checks all five labels exist in Linear; that `GITLAB_PUSH_TOKEN` authenticates with Developer access to the project; and that `main`, `staging` and `dev` are protected with the token's user absent from their push and merge allowlists (fails if protection was removed or the bot was added).

**CLI.** `steward implement KEY [--dry-run]`, mirroring `steward enrich`. A dry run runs everything up to and including the checks, then prints the diff stat and the would-be commit message; it never commits, pushes or writes to Linear.

**Docs.** `docs/ops.md`: labels to create, the push token, the new config, the flows. README: the label flow.

## Testing

Unit and integration tests with the existing fakes (no live Linear, GitLab or brain):

- Webhook: each configured label on create and on add; unrelated label changes ignored; `action` recorded.
- Intake per kind: closed tickets, already enriched, already implemented, queued duplicates.
- Triage result validation (state/questions/brief consistency) and publish order (section, comment, labels last; failure before labels leaves `needs-triage`).
- Implement pipeline against a real temporary git repo with a local bare remote: branch naming and slug rules; brief detection; each outcome; empty diff; overlay-path guard; secret-value guard; failing checks; failing hook; existing remote branch; push; `publish_failed` then retry pushing from the stored ref without re-running the brain.
- Fake tracker gains label add/remove and records them.
- CLI `implement --dry-run` writes nothing.

## Out of scope

- The Managed Agents brain (next spec; `brain` becomes selectable per job kind there).
- Creating or updating merge requests, reacting to pipeline results, or re-running on review feedback.
- Parallel jobs.
- `wontfix` or any closing verdict.
- Re-triage or re-implementation driven by labels (use the CLI).
