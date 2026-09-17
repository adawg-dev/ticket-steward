---
name: steward-user-app-verify
description: Start apps/user-app on $STEWARD_PORT from the steward worktree, authenticate as a deterministic seed persona via the dev-auth bypass route, verify the authenticated UI with Playwright MCP, save screenshots into the job's artifacts dir, and stop the server. Use this when a ticket is about user-app UI and a screenshot would clarify it.
user-invocable: true
argument-hint: "<persona> [path]"
---

You are verifying authenticated user-app behavior as a specific seeded persona, from inside a steward worktree. The port is never fixed: the steward hands you `$STEWARD_PORT` in the environment and rewrote the overlay env files to point at it. Every URL, probe and cleanup step below uses `$STEWARD_PORT`. Screenshots go into the artifacts directory the prompt gave you (referred to as `$ARTIFACTS_DIR` below); list them in the `attachments` field of your result.

## Inputs

- **`persona`** (required) — a seeded persona handle. The authoritative accepted set is `PERSONA_EMAILS` in the dev-auth route (`apps/user-app/src/app/(app)/api/dev/auth/login/route.ts`), kept in lockstep with `e2e/user/personas.ts` (+ `mega-personas.ts`, `alert-tester-persona.ts`). If a handle is not in that map, the route 400s with the available list — stop and pick one from the list.

  The four canonical personas cover most verification needs:
  - `zero-orgs-user` (Zara Zero) — no org membership; for empty-state verification
  - `single-org-owner` (Sam Single) — owner of `acme`
  - `org-member-not-owner` (Mel Member) — non-owner member of `acme`; for permission-gating checks
  - `org-with-teams-and-keys` (Tina Teams) — owner of `bigco`; full data view (charts, logs, audit)

  Additional cohorts exist for specific scenarios: the **acme mutation cohort** (`acme-admin-1`, `acme-member-2`, `acme-member-3`) for journeys that role-change/create in acme; **MegaCorp** (`mega-owner`, `mega-admin-1..3`, `mega-billing`, `mega-member-1..4`) for the full role-mix matrix; `alert-tester` for the notification pipeline; `lazy-org-owner`/`lazy-org-member` for the no-Descope-tenant lazy-provisioning path.

  Multi-org personas DO exist: org membership is relational via `cn_user_organization`, so a user can belong to N orgs. `mega-member-1` (Maya Member) is the canonical multi-org persona — a member of `megacorp` with an `extraOrgs` membership in `acme` — used to exercise multi-org cookie/scope resolution.

- **`path`** (optional) — the in-app path to land on. Default: `/personal/dashboard` (exists for every persona). Authenticated app routes are scope-prefixed: always navigate to a `/personal/*` or `/organization/*` route (e.g. `/organization/teams`, `/personal/api-keys`, `/organization/billing`) — bare paths like `/teams` do not exist. Most routes exist under both scopes; `/organization/members` and `/organization/teams` are org-only with no `/personal/*` equivalent.

## Background (so you know what you're doing)

The `apps/user-app/src/app/(app)/api/dev/auth/login/route.ts` endpoint is a dev-only route, gated solely on `ENABLE_DEV_AUTH_BYPASS === "true"` (anything else 404s, so it's invisible in production). When the gate passes it:
1. Looks up a deterministic Descope test user for the persona (via `DESCOPE_MANAGEMENT_KEY` against the project in `NEXT_PUBLIC_DESCOPE_PROJECT_ID`),
2. Generates and verifies a magic link server-side to obtain real DS/DSR session JWTs,
3. Sets those as host-only cookies on `localhost` (no `Domain=`, `SameSite=Lax`),
4. 307-redirects to `?to=<path>` (default `/dashboard`).

The user-app's middleware (`apps/user-app/src/proxy.ts`) validates DS/DSR like any real session, so after the redirect the browser is fully authenticated — every server component, server action, and protected route works identically to production.

The env files in this worktree come from the steward's overlay. They hold sandbox credentials, and every `localhost:<port>` / `127.0.0.1:<port>` in them was already rewritten to `$STEWARD_PORT`, so the app's own callbacks and public URLs line up with the port you start it on.

The seeded data backing each persona lives in the shared local Postgres (`cn_user`, `cn_user_organization`, `cn_user_team`, `cn_organization`, `cn_team`, `cn_key`) and the local TimescaleDB (`cn_chat_log`, `cn_metrics_log`, `cn_billing_log`, `cn_request_log`, `cn_crud_log` + caggs) that the overlay's `TG_READ_CONN_STR`/`TG_WRITE_CONN_STR` point at.

## Procedure

Run these in order from the worktree root. Stop and report at the first failure — do **not** attempt to recover by restarting things.

### 1. Check the port and start the dev server

```bash
echo "$STEWARD_PORT"
curl -sS -o /dev/null -w "%{http_code}\n" -m 3 "http://localhost:$STEWARD_PORT/"
```

- If `$STEWARD_PORT` is empty: stop and report it. Do not pick a port yourself.
- If the probe returns `000` / `ECONNREFUSED` (expected: nothing is running yet), start the server in the background from the worktree root:

  ```bash
  pnpm --filter user-app exec next dev --port "$STEWARD_PORT" > "$ARTIFACTS_DIR/next-dev.log" 2>&1 &
  ```

  Then poll until it answers (give it up to ~90 s for the first compile):

  ```bash
  for i in $(seq 1 45); do
    code=$(curl -sS -o /dev/null -w "%{http_code}" -m 3 "http://localhost:$STEWARD_PORT/" || true)
    case "$code" in 200|307|308|404) echo "up ($code)"; break;; esac
    sleep 2
  done
  ```

- If the probe already returned `200` / `307` / `308` / `404` before you started anything: something else owns the port. Stop and report it rather than reusing it.

### 2. Seed the personas if needed

The seed is idempotent but takes ~10s on warm DBs (Stripe API + Descope API round-trips). If you've already run it during this job and aren't suspicious of stale state, skip this step. Otherwise:

```bash
pnpm --filter @concentrate/user-portal-e2e dev:seed
```

If the seed fails: stop and report the error; do not attempt the browser flow on a half-seeded DB.

### 3. Drive the dev-auth flow with Playwright MCP

Use the Playwright MCP tools (`browser_navigate`, `browser_wait_for`, `browser_take_screenshot`, `browser_console_messages`, `browser_snapshot`, `browser_close`).

1. Navigate to the dev-auth URL with the persona + path encoded:

   ```
   http://localhost:$STEWARD_PORT/api/dev/auth/login?persona=<persona>&to=<path>
   ```

   Always target a scope-prefixed path (`/organization/*` or `/personal/*`), e.g. `&to=/organization/teams`. A bare unscoped path like `/teams` or `/members` renders the framework not-found boundary unless org scope happens to be active (`requireOrgScope` in `apps/user-app/src/lib/route-gates.ts`).

2. After navigation settles, check the resulting URL:
   - If it's `/auth/login` (or any path containing `/auth/login`): the auth bypass failed. Capture a screenshot, capture console errors, and report. Likely root causes: dev-auth env vars missing from the overlay, persona not seeded, or the dev-auth route 4xx'd (browser would land on the login page after a failed redirect).
   - If it's the requested path (or a redirect target like `/dashboard`): proceed.

3. Capture an accessibility snapshot (`browser_snapshot`) so you can describe what's actually rendered, not just what URL you're on. Pages can render an error boundary like "Something went wrong" with a 200 status.

4. Capture a screenshot (`browser_take_screenshot`) of the viewport and save it under `$ARTIFACTS_DIR` with a descriptive filename, e.g. `$ARTIFACTS_DIR/verify-<persona>-<path-slug>.png`. Only files under `$ARTIFACTS_DIR` are published; anything saved elsewhere is dropped.

5. Pull console errors (`browser_console_messages` with `level: "error"`) and note anything non-trivial. Routine dev noise that is **not** concerning: a `favicon.ico` 404 and the matching "Error while trying to use the following icon from the Manifest" warning, the `[Intercom] The App ID ... has not been set` warning, and a redis-fail-open warning when local redis is down. Genuinely concerning: any RSC/server-component error, a "relation … does not exist" / missing-relation error, an error boundary ("Something went wrong"), or a stack trace.

### 4. Record what you saw

Carry into your enrichment and attachments:
- The persona and the final URL the browser landed at.
- A one-sentence summary of what's on the page (avatar initial, page title, any error boundary).
- Any meaningful console errors with file/line if present.
- Each screenshot as an `attachments` entry: `{ "file": "verify-<persona>-<path-slug>.png", "caption": "<what it shows>" }` (path relative to `$ARTIFACTS_DIR`).

Do **not** paste the full accessibility snapshot into the enrichment — it's large and noisy. Describe what you see.

### 5. Cleanup

Close the browser (`browser_close`), then stop the dev server and confirm the port is free:

```bash
kill %1 2>/dev/null || true
lsof -t -i ":$STEWARD_PORT" | xargs -r kill
sleep 1
lsof -i ":$STEWARD_PORT" || echo "port $STEWARD_PORT is free"
```

The steward kills anything left in the job's process group afterwards, but leaving the server up burns the job's remaining time budget, so always stop it yourself.

## When to NOT use this skill

- You're verifying a public marketing page (`/`, `/pricing`, `/calculator`, `/faq`, etc.) — those don't need auth; start the server as in step 1 and `browser_navigate` directly.
- You're verifying API behavior end-to-end — use `curl` against the route on `$STEWARD_PORT` directly; no browser needed.
- You're debugging a Descope/auth bug itself — the dev-auth route bypasses normal auth, so it won't reproduce real auth flows.

## Failure surface

The most common breakages, ranked by frequency:

1. **Dev server did not come up within the poll window** → check `$ARTIFACTS_DIR/next-dev.log` (a compile error, a missing overlay env file, or `pnpm install` having been skipped in setup). Report it; do not retry in a loop.
2. **Overlay `.env` for user-app missing `ENABLE_DEV_AUTH_BYPASS=true`** → dev-auth route 404s (this is the gate). If it's set but login still fails, check `NEXT_PUBLIC_DESCOPE_PROJECT_ID` and `DESCOPE_MANAGEMENT_KEY` — the route uses the Descope Management SDK to mint cookies and 500s without them. These live in the steward's overlay, which you cannot edit; say so in the enrichment.
3. **Persona not seeded** → dev-auth route returns 400 with a hint and the list of available personas. Run the seed.
4. **`TG_READ_CONN_STR` / `TG_WRITE_CONN_STR` not pointing at the local timescale** → dashboard SSR throws "relation X does not exist" inside an error boundary; the page renders 200 but shows "Something went wrong". Overlay issue again; report it.
5. **Unrelated downstream bug** → page renders an error boundary. Note it in the enrichment with the console error; don't try to fix it.
