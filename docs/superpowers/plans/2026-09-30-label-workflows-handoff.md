# Handoff: build label workflows (triage + agent implementation) with subagents

A fresh Claude Code session opened in `~/ticket-steward` carries out
`docs/superpowers/plans/2026-09-30-label-workflows.md` using **superpowers:subagent-driven-development**. That means one fresh implementer per task, then a fresh reviewer before the next task, then a whole-branch review at the end. The design is in `docs/superpowers/specs/2026-09-30-label-workflows-design.md`.

This file holds what the plan and spec don't: repo and branch state, the box, the credentials, facts about kickoff, the user's preferences, and the places where the plan guessed.

---

## The prompt (paste into the new session)

> Implement `docs/superpowers/plans/2026-09-30-label-workflows.md` with superpowers:subagent-driven-development. First read `docs/superpowers/plans/2026-09-30-label-workflows-handoff.md` and do its preflight. Run Tasks 1–12 on branch `feat/label-workflows`: one implementer subagent per task, a fresh reviewer after each, and a whole-branch review at the end. Give each implementer the plan's Global Constraints, its own task, and the handoff's "Plan soft spots" notes for that task. Stop before Task 13 (deploy and live verification) and report. I'll decide on deploying, and some of its steps push to GitLab and write to Linear.

---

## Preflight (the orchestrating session does this before launching any subagent)

1. `git -C ~/ticket-steward status` should be clean, on branch `feat/label-workflows`, with HEAD at `2b2a2ee` ("docs: implementation plan for label workflows") or later.
2. `pnpm typecheck && pnpm lint && pnpm test` should all pass: 506 passed and 3 skipped as of 2026-09-30. The full suite takes a few minutes, and `test/core/pipeline.test.ts` alone is about 10 s. Record the baseline counts.
3. **Never run `git checkout main`.** `main` is far behind: it's at the v1 design-spec commit and has no `src/pipeline` or `test/`. The real history is the feature-branch chain below.

## Repo and branch state

```
main (stale) … feat/linear-api-key @ 8283424   ← deployed at /opt/ticket-steward
                 └─ feat/trigger-label: 4aac2aa (triggerLabel opt-in + never enrich closed tickets)
                                        b00a680 (examples/kickoff/reset-dbs.sh)
                    └─ feat/label-workflows: fec9067, 6bfb6e9, 84ae760 (spec), 2b2a2ee (plan)
```

- Nothing is pushed. `origin` is `github.com/adawg-dev/ticket-steward`, and none of these branches exist there. Don't push unless the user asks.
- `/opt/ticket-steward` (the deployed checkout) is on `feat/linear-api-key`, fast-forwarded to `4aac2aa`. Deploys work by fetching from the local checkout, not from origin. See Task 13 in the plan.
- Commit trailer (required): `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Codebase conventions implementers should know

- ESM TypeScript. Tests are vitest with globals (`describe`/`it`/`vi` need no import). `pnpm typecheck` runs `tsc -p tsconfig.test.json`, so the tests are typechecked too, and a fixture missing a new required field is a type error.
- **Never cast to `any`.** It's a user rule. The codebase does use `as never` in Linear SDK mocks and `as unknown as X` in a couple of fakes. Follow that sparingly and don't introduce `any`.
- Existing patterns to copy: the `src/review/` module layout (prompt / result / pipeline / publish) for `src/implement/`; `test/fakes/` (FakeTracker, FakeBrain, FakeCodeHost, `tmpRepo`); `test/workspace/helpers.ts` (`makeSourceRepo`, `commitFile`, `git`); `test/cli/helpers.ts` (`makeContext`, `writeConfig`, `ExitSignal`).
- `git()` / `gitOrThrow()` in `src/workspace/git.ts` run git with `GIT_CONFIG_GLOBAL=/dev/null`, and `extraEnv` is spread over the base env. That's how the plan overrides `PATH` for the hooks and passes the push credentials (`splitCredentials` → an `http.<origin>.extraHeader` in the env, never in git config).
- Worktrees are `git worktree add --detach` on the steward's bare mirror at `/var/lib/ticket-steward/repo.git`, which has `extensions.worktreeConfig=true`. Worktrees share refs and objects with the mirror, and the mirror's fetch runs `--prune` with a `+refs/*:refs/*` mirror refspec. That's why the plan keeps retry copies of commits in a **bundle file**, not a local ref: a ref under `refs/steward/*` would be pruned on the next fetch.
- `copyOverlay` refuses to overwrite tracked files. Overlay `.env` files are gitignored in kickoff, and the plan's guard relies on that.

## Plan soft spots (check while implementing; adjust the code, not the requirement)

- **Task 5:** the exact ordering in `expectedSection`. The plan puts the brief right after the enrichment text and before repro, attachments and notes. The `extra` argument is appended to the brief-end line, so check it against how existing tests pass notes. Also run `grep -rln 'confidence: "high"' test` and add the `triage` object to every `BrainResult` fixture, including the untyped JSON ones in CLI and worker tests.
- **Task 6:** the `claudeCode.test.ts` snippet refers to "the helpers the file already uses" (`successStream`, `input`). Adapt to the real names there.
- **Task 9, worker test:** `test/worker/loop.test.ts` has its own `start`/`waitForStatus` helpers. Extend `start` to accept `WorkerOptions` overrides if it doesn't already.
- **Task 9, pipeline tests:** they use the real `prepareWorkspace`, which resolves `@playwright/mcp` for `brainInput`. That works in this repo. The source repo in `tmpRepo` is non-bare on `main`. Pushing a *new* branch into it is fine; don't push to `main`.
- **Task 10:** `writeConfig` builds TypeScript source by string templating. Keep the JSON quoting exact, because a stray comma breaks the config load.
- **Task 11:** the Linear `issueLabels` filter (`name: { in: [...] }`) and `eqIgnoreCase` are typed in `@linear/sdk` but haven't been exercised against the live API. Unit tests stub them. The first live `steward doctor` in Task 13 is the real check.
- **Hooks (Task 8):** kickoff's `.husky/pre-commit` calls `pnpm`, so `PATH` must contain pnpm. The service's PATH comes from the systemd drop-in `/etc/systemd/system/ticket-steward.service.d/pnpm.conf`: `/usr/local/lib/ticket-steward/bin` first. `buildWorkspaceEnv` copies `process.env.PATH`, so hooks get pnpm under systemd. In tests the repo's own `.husky/pre-commit` is a stub.

## The box (for Task 13 only, when the user approves it)

- The service is `ticket-steward` (systemd, runs as user `steward`). The user usually starts and stops it themselves. Restarting is fine **only when idle**: check `curl -s http://127.0.0.1:3020/health | jq -c` shows `worker.running: null` and `counts.queued: 0`.
- Config: `/etc/ticket-steward/steward.config.ts`. Secrets: `/etc/ticket-steward/.env` (steward:steward 600). `/etc/ticket-steward` can only be read with sudo. Keep backups next to every file you change (`*.bak-YYYYMMDDHHMM`). There are several already.
- Run the CLI as steward: `sudo -u steward bash -c 'cd /etc/ticket-steward && PATH=/usr/local/lib/ticket-steward/bin:/usr/local/bin:/usr/bin:/bin steward doctor'`.
- Build in `/opt`: `sudo env PATH=/usr/local/lib/ticket-steward/bin:$PATH pnpm build`. Git in `/opt` needs `-c safe.directory='*'` under sudo.
- Current live config: `tracker.triggerLabel: "steward"` (the plan replaces it with `labels: {}`); `workspace.setup` = `["bash /etc/ticket-steward/reset-dbs.sh", "pnpm install --frozen-lockfile --ignore-scripts", "pnpm turbo build --filter='./packages/*'"]`; brain `openai-agents`, model `gpt-6-luna`, `reasoningEffort: "high"`, through Concentrate's OpenAI-compatible endpoint. Live prompts are in `/etc/ticket-steward/prompts/` (`enrich.md` is byte-identical to the repo's, plus `review.md`). There's no `implement.md` there yet.
- **`reset-dbs.sh` wipes both local dev databases at the start of every job**: Postgres `concentrate-2025_09_18` and TimescaleDB `cn_wil_dev_adam_tg_2026_05_05`, both on localhost:5432. The user approved this. The dev seed afterwards warns about three missing caggs (`model_metrics_daily`, `billing_hourly`, `billing_daily`); that's harmless, because only alert tests reference them.
- Reading the job database: there's no `sqlite3` CLI. Use node with `/opt/ticket-steward/node_modules/.pnpm/better-sqlite3@13.0.3/node_modules/better-sqlite3`. Write a small `.cjs` script in the scratchpad, `sudo install -m 644` it to `/tmp`, run it with `sudo -u steward node …` against `/var/lib/ticket-steward/steward.db` with `{ readonly: true }`, then delete it. Back up before any write (`db.backup(...)`), as was done when job 41 was cancelled.
- The openai-agents brain writes its transcript (`jobs/<id>/attempt-N.jsonl`) only at the end, so it's 0 bytes while a job runs. Use `artifacts/` or `ps -u steward` to see progress.

## Credentials and what's verified

| Secret | What it is | Status |
|---|---|---|
| `GITLAB_PUSH_TOKEN` | New project access token for the push. It should be Developer role with `write_repository` only; the user created it. | Present in `/etc/ticket-steward/.env` (copied 2026-09-30) and in the gitignored `~/ticket-steward/.env`. `git ls-remote` of `dev` works. **Push isn't verified yet**; that's Task 13 Step 5. |
| `GITLAB_TOKEN` | Reviewer bot `project_74525306_bot_ae9c84b266af52f4720a58c3a38389da`, Reporter role, `api` scope | Can read `protected_branches` (used on 2026-09-30). Must not be raised to Developer. |
| `MIRROR_TOKEN` | Read-only deploy token (`read_repository`) for mirror fetches | Unchanged |
| `LINEAR_API_KEY` | Adam Xu's personal key; every Linear write shows up as him | Not admin scope, so it can't list webhooks |

- Never print a secret value. To use one, load it into a shell variable with `grep '^NAME=' … | cut -d= -f2-` and pipe any URL output through `sed -E 's#//[^@]*@#//***@#'`.
- **Don't read values from the overlay's `.env` files** (`/var/lib/ticket-steward/overlay/**`). The auto-mode classifier blocked that as credential exploration. Listing key *names* (`grep -oE '^[A-Z_]+='`) is fine.

## kickoff facts the plan depends on (checked 2026-09-30 on `dev`)

- `.husky/pre-commit`: `pnpm audit --audit-level=high`; then `pnpm run types` **only** on `main`/`dev`/`staging`; then `pnpm exec lint-staged`; then `./dev-services/verify-license.sh`. Husky is installed by `"prepare": "husky"`, which the steward's `--ignore-scripts` install skips. So the steward must run the hooks itself (the plan's wrapper approach) and run typecheck itself.
- Root scripts: `types` = `turbo check-types`, `lint:turbo` = `turbo lint`. The plan's default check is `pnpm turbo check-types lint --filter='...[{{baseSha}}]'`.
- Protected branches: `main` (push: 3 named people + `DEPLOY_TOKEN_OCT`; merge: No one), `staging` (push: No one/1 person; merge: Maintainers), `dev` (push and merge: named people + `OPS_APP_OCT`/`OPS_APP_SEPT`). No bot is on any of these lists and no role-based Developer grant exists, so doctor's protection check should pass as things are.
- GitLab's pipeline opens the merge request automatically when a pushed branch passes, and the Linear–GitLab integration links it by the ticket ID in the branch name. That's why the steward never creates merge requests. For the smoke test, `-o ci.skip` stops the pipeline, so no merge request is created.

## Linear state

- The workflow labels (`needs-triage`, `ready-for-agent`, `needs-info`, `ready-for-human`, `agent-implemented`) probably don't exist yet. `steward doctor` will say. Ask the user before creating them. If they agree, create them as workspace-level labels through the API.
- The `steward` label exists and works (USRAPP-45 was enriched through it on 2026-09-30). It stops being a trigger once the live config switches to `labels`.

## User preferences (also in memory)

- Run sudo and ops commands yourself rather than handing the user command lists (memory: `run-host-commands-myself.md`). But **confirm first** before anything outward-facing: pushes to GitLab, creating Linear labels, or restarting the service while it's busy.
- The user wants plain, direct explanations, and wants to hear what's verified versus assumed.

## After this plan: the next spec (don't start it)

Managed Agents brain. The user has Anthropic credits that apply **only** to Managed Agents (not the Messages API) and expire 2026-12-31. The agreed direction is a new `managed-agents` brain kind using a **self-hosted environment**: the agent loop runs at Anthropic, while the tools run on this box in the job worktree, so the local databases, overlay, dev server and Chromium keep working. `@anthropic-ai/sdk` 0.129.0 (not yet a dependency) ships `EnvironmentWorker` with a `tools` option, where `policy.ts` would be wrapped in. The structured result would come back through a custom `submit_result` tool, and the brain would be selectable per job kind (e.g. implement on managed-agents). It gets its own brainstorm → spec → plan once this plan ships.
