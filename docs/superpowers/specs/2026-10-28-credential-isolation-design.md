# Credential isolation for the agents

Date: 2026-10-28. Status: draft for review.

## Intent

The agent (Claude Code, driven by the steward) must not be able to read any credential. Today it runs in the steward's
container, as the steward's uid (998), next to `/etc/ticket-steward/.env`; only the tool-policy hook keeps it from
reading that file, and that hook is a guardrail, not a wall. The model credential is in the agent's own environment.

The owner's direction: credentials live in a vault, and a sidecar puts them on requests, so the agent never holds them.
AWS Secrets Manager (already in use) is the vault, at as close to zero extra cost as possible. Alter was considered and
rejected (SDK-based, sees all model traffic, unclear streaming/self-hosting).

## Goals

1. **Nothing that runs code the agent can influence can read a steward credential.** That is the agent, its shell and
   tools, and every command that executes repo code: workspace setup (`pnpm install`, `turbo build`), the steward's
   checks run by the push tool, and the app the agent starts. These all move to a **runner** container that has no
   `.env`, no config dir, no steward DB and no slot-helper socket.
2. **The model credential never enters the runner.** A **keyproxy** sidecar listens on localhost in the shared network
   namespace. The agent gets `ANTHROPIC_BASE_URL=http://127.0.0.1:<port>` and a dummy token; keyproxy replaces the
   `Authorization` (and `x-api-key`) header with the real one and forwards to the configured upstream (today the
   concentrate gateway, `ANTHROPIC_BASE_URL` in `.env`). Streaming (SSE) must pass through unbuffered.
3. **The steward's MCP servers move out of the agent's process tree.** codehost, push and orbit hold `GITLAB_TOKEN` /
   `GITLAB_PUSH_TOKEN`; today they are stdio children of Claude Code and load `.env` themselves. They become HTTP MCP
   servers hosted by the steward process, reached by the agent at `http://127.0.0.1:<port>/mcp/<server>` with a
   **per-job bearer token** the steward mints for that run and revokes when it ends. The token only reaches the tools
   for that job's target (same rules the stdio servers apply today). Playwright MCP has no credential and stays a stdio
   child in the runner.
4. **AWS Secrets Manager is the vault, and no AWS credential ever lives on the host** (owner: "it should just assume
   credentials… we pull it then just leave it. persistence here is bad, no long lived tokens"). This is the pattern
   kickoff's preview deploys already use (`infra/script/preview.py` `fetch_secrets`):
   - A GitLab CI job, `deploy:steward`, runs on the on-prem shell runner (the steward host, 10.2.0.118, is on the
     same subnet as the preview VMs). It gets a GitLab OIDC token (`id_tokens`, aud `https://gitlab.com`), calls
     `aws sts assume-role-with-web-identity` for the shortest session STS allows (900 s), and reads the secret.
   - It SSHes to the steward host (the way `on_vm` reaches preview VMs) and writes `/run/ticket-steward/.env` (tmpfs,
     mode 0600, uid 998) from stdin, then runs `docker compose up -d`. The AWS session credentials exist only inside
     that job and expire on their own; the host has no AWS credential, no instance role, nothing to refresh.
   - The file is mounted read-only into `steward` and `keyproxy` only. The on-disk `.env` is deleted after migration.
   - **A dedicated role, not the existing `GitLabCI` one.** That role reads every secret in the account
     (`Resource = "*"`). The steward's role allows only `secretsmanager:GetSecretValue` on `ticket-steward/*`, and its
     trust policy matches only the deploy job's project on a protected ref. Terraform for it lives next to
     `kickoff/infra/terraform/oid-iam-role`.
   - One secret, `ticket-steward/env`, a JSON object of the `.env` keys (my call: one secret instead of kickoff's
     `DEV_<NAME>` per value, to keep it at ~$0.40/month). Default `aws/secretsmanager` KMS key, no rotation Lambda,
     no replicas.
   - **Reboot or a lost tmpfs:** `steward` and `keyproxy` refuse to start without the file (they exit non-zero), and
     the fix is to run `deploy:steward` again. Nothing on the host can recover the secrets by itself, by design.
     Rotation = update the secret, run the job.
5. `steward chat` keeps working: the interactive Claude Code session also runs in the runner, with the same keyproxy,
   HTTP MCP servers and policy hook.

## Non-goals (for this design)

- **Overlay app credentials** (Stripe test keys, provider keys, Descope test project…) stay as files in the worktree.
  They are test-only with spend caps (docs/ops.md §2). Placeholder substitution through an HTTPS-intercepting proxy is a
  later, separate design.
- Slot Postgres/Redis/RabbitMQ credentials: per-slot, local, thrown away; not secrets.
- Kubernetes. This stays a Compose stack; the design should not make a later move harder.
- Elastic scaling. One steward, N slots.

## Anti-goals

- A credential reaching the runner by any path: env, mounted file, MCP spawn args, logs written into a runner-visible
  directory, the session transcript dir, or an error message the agent sees.
- The keyproxy becoming an open relay: it forwards only to the one configured upstream, only the model API paths.
- A long-lived token in the runner. The per-job MCP token dies with the job.
- Breaking resume: sessions (`CLAUDE_CONFIG_DIR`) and worktree paths must stay identical, so existing sessions resume.

## Constraints and facts

- `@anthropic-ai/claude-agent-sdk` 0.3.268 exposes `spawnClaudeCodeProcess(options: SpawnOptions) => SpawnedProcess`
  (command, args, cwd, env, abort signal; stdin/stdout streams and exit). The steward uses this to start Claude Code in
  the runner instead of locally.
- The runner shares `dind`'s network namespace (like `steward` and `slot-helper`), so slot ports and keyproxy and the
  steward's MCP endpoint are all on 127.0.0.1. Consequence: the agent can reach the steward's webhook port and MCP port;
  both must authenticate every request (webhooks already verify signatures; MCP by per-job token).
- **One runner container per slot** (owner's decision): `runner-1` … `runner-N`, each its own PID namespace, so no
  job can read another job's processes, environment or per-job MCP token. Each mounts only what its current job needs;
  session transcripts are not shared across runners (the builder decides how a runner gets the one ticket's session
  dir, e.g. the runner daemon is handed a per-job directory the steward stages). Agents may still read other tickets'
  worktrees (same repo; accepted). Runners run as a different uid from the steward (my call: 1500), so even a shared
  volume mistake does not hand them the steward's files. Files both must touch (worktrees, job artifacts, sessions, the mirror) need a group both share.
- Runner mounts, from the data dir: `work/`, `jobs/<id>/artifacts` (or all of `jobs/`, builder's call if logs there
  contain nothing secret), `sessions/`, `repo.git/` (agent commits write objects there), `orbit/`. Not mounted:
  `steward.db*`, `run.lock`, `overlay/`, `doctor/`, the config dir.
- Repo-code execution today happens in the steward process in two places: workspace setup (`src/core/workspace.ts`,
  `runSetup`) and the push tool's checks (`src/push/service.ts`). Both must execute in the runner. The steward-side
  push logic (git range checks, secret guard, bundle, push) stays in the steward.
- The steward runs git in agent-writable worktrees. Worktree config is agent-writable (`extensions.worktreeConfig`), so
  steward-side git must neutralise config that executes programs (at least `core.fsmonitor`, `core.hooksPath`,
  `core.sshCommand`, `diff.external`/textconv, filter drivers) — otherwise the agent gets code execution in the steward
  container.
- The current live brain credential is `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN` (a gateway, bearer auth).
  keyproxy must also support `ANTHROPIC_API_KEY` (x-api-key) and `CLAUDE_CODE_OAUTH_TOKEN`; the OpenAI brain the same way
  for `OPENAI_BASE_URL`/`OPENAI_API_KEY`.
- No new paid services. AWS access from the host by instance role if on EC2, else a scoped IAM credential stored only on
  the host (see open question).

## Shape (decided)

```
            AWS Secrets Manager (ticket-steward/env)
                       │ fetch at stack start
                       ▼
           /run/ticket-steward/.env (tmpfs, host)
              │ ro                     │ ro
     ┌────────▼────────┐      ┌────────▼────────┐
     │ steward          │      │ keyproxy        │──► model gateway
     │ webhooks, queue, │      │ 127.0.0.1:P     │
     │ HTTP MCP servers │      └────────▲────────┘
     │ push logic       │               │ dummy token
     └──┬───────────▲──┘               │
        │ spawn/exec│ MCP (job token)   │
        ▼  socket   │                   │
     ┌──────────────┴───────────────────┴──┐
     │ runner-n, one per slot (uid 1500)    │
     │ Claude Code, shell, setup, checks,   │
     │ Playwright, the app                  │
     └──────────────────────────────────────┘
     slot-helper + dind as today (runner gets no slot socket)
```

The steward reaches the runner over a unix socket on a volume shared by those two only: a small **runner daemon** that
starts processes (Claude Code for the SDK, setup and check commands, `steward chat`'s interactive session) with a given
argv, cwd and env, streams stdio, forwards kill, and reports exit. It refuses env keys on a denylist (anything named
like a credential) as a second line of defence.

## Calls made after the builder check (owner to confirm)

- **Brain kinds.** The isolated stack supports `brain.kind: "claude-code"` only. The openai-agents brain runs its tools
  inside the steward-side process, so config load refuses it when the runner is configured. It is not used live.
- **The runner's mounts may be narrowed, and must be wherever a credentialed steward process reads what the agent
  writes:**
  - The mirror's `config`, refs and hooks are not writable from the runner. `Mirror.fetch` sends `GITLAB_TOKEN` as an
    extraHeader, so an agent-set `url.*.insteadOf` or `http.proxy` would send it elsewhere. The builder chooses how the
    agent still commits, for example a runner-writable object store linked to the mirror by alternates, or only
    `objects/` and its own `worktrees/<name>` writable. Existing sessions must still resume, so worktree paths stay
    the same.
  - The agent's Orbit data dir is separate from the one the steward's credentialed Orbit MCP uses.
- **If the stack ever moves to EC2,** dind's network namespace must not reach the instance metadata endpoint
  (169.254.169.254), or a runner could take the instance role.
- **Accepted residual long-lived credentials:** the SSH key the CI job uses to reach the host (a CI variable, as for
  preview VMs; the host only holds the public half), and the steward's own service tokens (GitLab project tokens,
  Linear key), which live in memory and in the vault but are long-lived by nature. Shortening those is out of scope.

## Left to the builder

- Wire protocol of the runner socket (framing, how a TTY is carried for `steward chat`).
- How the HTTP MCP servers are hosted (same Fastify app on another localhost port, or a separate listener) and token
  format, as long as tokens are per-job, unguessable, and revoked at job end.
- Whether keyproxy is a tiny Node service in this repo or an off-the-shelf reverse proxy with header rewrite, as long as
  SSE streams unbuffered and only the upstream is reachable.
- Doctor checks: runner reachable; runner cannot read `/etc/ticket-steward` or `/run/ticket-steward`; keyproxy answers;
  secret came from the vault.
- Migration order and a rollback that keeps today's stack runnable.
