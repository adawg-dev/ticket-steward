# Handoff: build the steward's gateway compatibility, bug reproduction and MR review

This file tells a fresh Claude Code session how to carry out two plans end to end with a sequential workflow. Paste **the prompt** below into a new session opened in `~/ticket-steward`.

## Why a workflow

The 16 tasks form a strict chain, because later tasks use the names and types earlier ones produce. Each task needs an independent review before the next one starts. A workflow makes that loop deterministic:

1. One implementer agent writes and commits the task.
2. A fresh read-only reviewer checks it.
3. A fixer runs if needed, for at most two rounds.
4. The workflow moves to the next task, or stops and reports.

A whole-branch review runs at the end. Agents run one at a time, so only one ever touches git.

Subagent-driven execution by hand would do the same thing. The workflow just removes the bookkeeping.

---

## The prompt (paste this)

> Run a workflow to implement the ticket-steward plans. Follow `docs/superpowers/plans/2026-09-25-steward-handoff.md` exactly:
> 1. Do the preflight.
> 2. Launch the workflow script in that file, passing `args` as described.
> 3. When it finishes, do the post-run steps and report back.
>
> Do not run Task 19 (live verification). It is mine.

---

## Preflight (main session, before launching)

Run these in `~/ticket-steward` and stop if any of them fails:

```bash
git branch --show-current            # must print feat/linear-api-key
git status --short                   # must be empty
git log --oneline -1                 # note this sha as BASE_SHA
pnpm install --frozen-lockfile
pnpm typecheck && pnpm lint && pnpm test   # the baseline must be green
```

Then read these, so you can judge what the workflow returns:
- `docs/superpowers/specs/2026-09-25-steward-repro-mr-review-design.md`
- The headers, Global Constraints and Review Focus of both plans:
  - `docs/superpowers/plans/2026-09-25-steward-gateway-compat.md` (Tasks 2–6)
  - `docs/superpowers/plans/2026-09-25-steward-repro-mr-review.md` (Tasks 8–18)

Launch the workflow with the script below passed inline, and `args: { "baseSha": "<BASE_SHA>", "startAt": 2 }`. To resume after a stop, fix the cause, then relaunch with `startAt` set to the task that stopped, or use `resumeFromRunId`.

## Workflow script

```js
export const meta = {
  name: 'steward-repro-review-build',
  description: 'Implement steward compat Tasks 2-6 and repro/MR-review Tasks 8-18 sequentially, each gated by an independent review',
  phases: [
    { title: 'Implement', detail: 'one implementer per task; commits on feat/linear-api-key' },
    { title: 'Review', detail: 'fresh read-only reviewer per task' },
    { title: 'Fix', detail: 'addresses critical/important review findings (max 2 rounds)' },
    { title: 'Final review', detail: 'whole-branch review against both specs' },
  ],
}

const ROOT = '/home/admin/ticket-steward'
const COMPAT = 'docs/superpowers/plans/2026-09-25-steward-gateway-compat.md'
const REVIEW = 'docs/superpowers/plans/2026-09-25-steward-repro-mr-review.md'
const SPEC = 'docs/superpowers/specs/2026-09-25-steward-repro-mr-review-design.md'
const TASKS = [2, 3, 4, 5, 6].map((n) => ({ n, plan: COMPAT })).concat([8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18].map((n) => ({ n, plan: REVIEW })))
const startAt = (args && args.startAt) || 2
const baseSha = (args && args.baseSha) || 'HEAD~20'

const RULES = `Hard rules (from the owner; they override anything else):
- Work in ${ROOT} on branch feat/linear-api-key. Never switch branches, push, amend, rebase, force or rewrite history.
- Never use or cast to \`any\` (no "as any", no ": any", no "as unknown as X" in src/). exactOptionalPropertyTypes and noUncheckedIndexedAccess are on.
- Verify with: pnpm typecheck && pnpm lint && pnpm test. Never run pnpm build.
- Tests never reach real Linear, GitLab, Slack or a brain; use test/fakes. Never weaken, skip or delete a test to get green.
- Stage explicit paths only (never git add -A or git add .). Never commit .env files or data directories.
- Every commit message ends with a blank line and then: Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
- Do not edit the plan or spec documents.
- Do not run sudo, touch /etc or /opt, restart services, or call any live API.`

const IMPL_SCHEMA = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['done', 'blocked'] },
    commits: { type: 'array', items: { type: 'string' } },
    summary: { type: 'string' },
    deviations: { type: 'string' },
  },
  required: ['status', 'commits', 'summary', 'deviations'],
}

const REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['approve', 'changes'] },
    testsPassed: { type: 'boolean' },
    issues: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          severity: { type: 'string', enum: ['critical', 'important', 'minor'] },
          file: { type: 'string' },
          problem: { type: 'string' },
          fix: { type: 'string' },
        },
        required: ['severity', 'file', 'problem', 'fix'],
      },
    },
  },
  required: ['verdict', 'testsPassed', 'issues'],
}

const implPrompt = (t) => `You are implementing Task ${t.n} of ${ROOT}/${t.plan}.

Read, in this order: that plan's header (Goal, Architecture, Execution order, Global Constraints, Review Focus, File map), then the whole "### Task ${t.n}:" section. For the repro/review plan, also read ${ROOT}/${SPEC}. Tasks before ${t.n} are already committed on the branch; inspect the code they produced (git log --oneline -30) rather than assuming.

Follow the task's steps in order, TDD style: write the failing tests, run them and see them fail, implement, run the full verification, then commit exactly as Step 5 says. The plan's code is the intended design. When it does not fit the real code (a helper named differently, a fixture shape, an import path, a zod or SDK typing detail), make the smallest change that keeps the task's Interfaces block exact, because later tasks depend on those names and signatures, and record every such change in "deviations". Keep every test the plan lists, including the named Review Focus tests. If a test sketch in the plan is abbreviated ("follow the file's pattern"), write it out fully with the exact assertions shown.

Return status "blocked" only if the task cannot be completed without a design decision the plan and spec do not settle; explain it in summary. Otherwise return "done" with the commit sha(s) you created.

${RULES}`

const reviewPrompt = (t, impl, round) => `You are an independent reviewer for Task ${t.n} of ${ROOT}/${t.plan}${round > 0 ? ` (re-review round ${round}, after fixes)` : ''}. You must not modify any file and must not run any git command that writes (no add, commit, checkout, reset, stash). You may run git log, git show, git diff and the test commands.

The implementer reported: ${JSON.stringify(impl)}

Do this:
1. Read the plan header (Global Constraints, Review Focus) and the "### Task ${t.n}:" section. For the repro/review plan, read ${ROOT}/${SPEC}.
2. Inspect the task's changes: git log --oneline -8 and git show for the task's commits (including any "fix" commits after them).
3. Run: cd ${ROOT} && pnpm typecheck && pnpm lint && pnpm test. Set testsPassed accordingly.
4. Check against the task: every file and step done; the Interfaces block's names, parameter and return types exact (later tasks import them); every listed test present with the plan's assertions (not weakened); Review Focus tests owned by this task present; deviations justified and harmless.
5. Check quality: no any/unsafe casts, errors handled as the spec's error table says, redaction applied to anything sent to Linear/GitLab, no dead code, style consistent with the surrounding code, no secrets committed, commit message trailer present.

severity: critical = wrong behaviour, broken interface, failing/missing tests, rule violation; important = likely bug, missing edge case the spec names, maintainability problem a later task will trip on; minor = polish. verdict "approve" only if tests pass and there are no critical or important issues. Be concrete in "fix".`

const fixPrompt = (t, review) => `You are fixing review findings for Task ${t.n} of ${ROOT}/${t.plan}. Read that task section and the plan's Global Constraints first.

Findings to address (ignore the minor ones unless trivial): ${JSON.stringify(review.issues.filter((i) => i.severity !== 'minor'))}
${review.testsPassed ? '' : 'The verification (pnpm typecheck && pnpm lint && pnpm test) is failing; make it pass without weakening tests.'}

Fix each finding, run the full verification, and commit with message "fix: address review of Task ${t.n}" (explicit paths, trailer required). If you disagree with a finding because it contradicts the plan or spec, do not change it; say why in deviations. Return status "done" with the fix commit sha(s), or "blocked" with the reason.

${RULES}`

const blocking = (review) => !review || !review.testsPassed || review.issues.some((i) => i.severity !== 'minor')

const completed = []
for (const task of TASKS.filter((t) => t.n >= startAt)) {
  const impl = await agent(implPrompt(task), { label: `implement:task-${task.n}`, phase: 'Implement', schema: IMPL_SCHEMA })
  if (!impl || impl.status !== 'done') return { completed, stoppedAt: task.n, reason: 'implementer did not finish', impl }

  let review = null
  for (let round = 0; round <= 2; round += 1) {
    review = await agent(reviewPrompt(task, impl, round), { label: `review:task-${task.n}#${round}`, phase: 'Review', schema: REVIEW_SCHEMA })
    if (!blocking(review) || round === 2) break
    const fix = await agent(fixPrompt(task, review), { label: `fix:task-${task.n}#${round}`, phase: 'Fix', schema: IMPL_SCHEMA })
    if (!fix || fix.status !== 'done') return { completed, stoppedAt: task.n, reason: 'fixer did not finish', review, fix }
  }
  if (blocking(review)) return { completed, stoppedAt: task.n, reason: 'review still blocking after 2 fix rounds', review }
  completed.push({ task: task.n, commits: impl.commits, summary: impl.summary, deviations: impl.deviations, minorIssues: review.issues })
  log(`Task ${task.n} approved (${completed.length} done)`)
}

const finalPrompt = (round) => `You are the final reviewer for the whole branch in ${ROOT}${round > 0 ? ' (re-review after fixes)' : ''}. Do not modify files or run writing git commands.

Read ${ROOT}/${SPEC}, the compat plan's Decisions and Global Constraints (${ROOT}/${COMPAT}), and the repro/review plan's header and Review Focus (${ROOT}/${REVIEW}). Then review git diff ${baseSha}..HEAD as a whole and run pnpm typecheck && pnpm lint && pnpm test.

Look for what per-task reviews miss: cross-task inconsistencies (a name or type that drifted between tasks), spec requirements with no implementation (walk spec §2 decisions 1-16 and §4's error table one by one), review-focus scenarios without a test, dead code left by the refactor, docs that contradict the code (docs/ops.md, README, .env.example, examples/kickoff), and any any-casts. Same severity scale and verdict rule as a task review.`

let final = await agent(finalPrompt(0), { label: 'final-review', phase: 'Final review', schema: REVIEW_SCHEMA })
if (blocking(final)) {
  const fix = await agent(
    `You are fixing whole-branch review findings in ${ROOT}. Read ${ROOT}/${SPEC} and both plans' Global Constraints. Findings: ${JSON.stringify(final ? final.issues.filter((i) => i.severity !== 'minor') : [])}. Fix them, verify, and commit with message "fix: address final branch review". Return done with commit shas, or blocked with the reason.\n\n${RULES}`,
    { label: 'fix:final', phase: 'Fix', schema: IMPL_SCHEMA },
  )
  if (fix && fix.status === 'done') final = await agent(finalPrompt(1), { label: 'final-review#1', phase: 'Final review', schema: REVIEW_SCHEMA })
}
return { completed, final }
```

## Post-run (main session)

1. If the workflow stopped (`stoppedAt` is set):
   - Read the returned review or blocker.
   - If the fix is small and certain, apply it yourself on the branch, then commit following the same rules.
   - Otherwise ask the owner.
   - Resume with `startAt`.
2. When all tasks are complete, run `pnpm typecheck && pnpm lint && pnpm test` once more yourself, and `git log --oneline <BASE_SHA>..HEAD`.
3. Write `docs/superpowers/plans/2026-09-25-steward-build-report.md` covering:
   - the commits per task;
   - every implementer `deviations` entry;
   - the minor review issues left open;
   - the final review verdict.

   Commit it.
4. Report to the owner. Include the Task 19 prerequisites from the repro/review plan (the owner-only steps) as a checklist:
   - rebuild and reinstall;
   - update `/etc/ticket-steward/.env`, which means removing `LINEAR_CLIENT_*` and adding `LINEAR_API_KEY`, `MIRROR_USERNAME=ticket-steward-mirror`, a `GITLAB_TOKEN` with `api` scope, and a GitLab webhook secret;
   - update `/etc/ticket-steward/steward.config.ts`, which means adding `bugLabels` and `review` and copying `prompts/review.md`;
   - add a Cloudflare Access Bypass for `adam.concentrate.ai/webhooks/*` and route the tunnel to `localhost:3020`;
   - create the GitLab "Merge request events" webhook at `https://adam.concentrate.ai/webhooks/gitlab`;
   - confirm the Linear webhook URL is `https://adam.concentrate.ai/webhooks/linear`.

## Facts the next session should not re-derive

- **Branch and commits:**
  - Steward branch: `feat/linear-api-key`.
  - Compat plan commit: `ae65e63`.
  - Head at handoff time: the commit that adds this file.
- **Gateway footer marker:** `Routed by ticket-gateway`. It is the last line of the description, and Linear normalizes it (`---` becomes `* * *`, `_` becomes `*`).
- **Gateway config:** the gateway runs with `enrichment.mode: off` (compat Task 6), so it never enriches on its own.
- **GitLab webhooks:**
  - A reviewer being added arrives as `action: "update"` with `changes.reviewers`.
  - A push is `action: "update"` with `object_attributes.oldrev`.
  - Dedupe on `webhook-id`, or `Idempotency-Key` if that is missing, never on `X-Gitlab-Webhook-UUID`.
- **GitLab Free:** one reviewer per MR, and project access tokens need Premium on gitlab.com.
- **GitLab tokens:**
  - `GITLAB_TOKEN` needs the `api` scope and at least Reporter to post discussions.
  - `MIRROR_TOKEN` is the deploy token `ticket-steward-mirror` (`read_repository`), and needs `MIRROR_USERNAME=ticket-steward-mirror`.
- **Production host:** the config is in `/etc/ticket-steward/` (owned by `steward`), `publicUrl` is `https://adam.concentrate.ai`, and the installed build predates this branch.
- **Secrets:** never print a secret value. Don't `systemctl cat` the cloudflared unit, because it contains the tunnel token.
