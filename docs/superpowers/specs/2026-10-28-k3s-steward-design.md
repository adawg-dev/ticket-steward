# Ticket Steward on k3s, with agents that hold no credentials

Date: 2026-10-28. Status: draft for review. Supersedes `2026-10-28-credential-isolation-design.md` (the Compose
version of the same goals).

## Intent

The owner is moving the steward onto a k3s cluster in their own infrastructure (several nodes, alongside the Proxmox
VMs; not EC2, not EKS). Two goals drive the shape:

1. **The agent never holds a credential.** Credentials live in AWS Secrets Manager, are pulled with short-lived,
   assumed credentials ("we pull it then just leave it. persistence here is bad, no long lived tokens"), and are
   put on requests by sidecars the agent cannot read.
2. **Event-driven, durable, not elastic.** A ticket event starts a run; a run is a pod that does its work and exits.
   The agent's session survives so a person can come back to it (MR `/agent` notes, `steward chat`).

## Decisions (owner's)

- k3s, several nodes.
- The cluster's service-account issuer is the identity: it is registered in AWS IAM as an OIDC provider, and pods
  assume a role with their projected service-account token (the IRSA pattern, self-hosted). No stored AWS key, no
  person at start-up.
- That role reads **the dev credentials already in Secrets Manager** (`DEV_<NAME>`, the ones kickoff's preview deploys
  read). There is no steward-specific secret; the steward's own tokens are added as `DEV_` entries. Values are read
  like `kickoff/infra/script/preview.py` `fetch_secrets`: JSON `{"NAME":"value"}` (first value), else the raw string.
- The steward is a **dispatcher** that reacts to events. It does not drive agents remotely; each run is a
  self-contained Kubernetes Job.
- One pod per run (replaces "one runner container per slot"): runs never share processes, env or tokens.
- Session transcripts persist in **MinIO in the cluster, on a PVC**, not AWS S3 (no AWS storage bill).
- Claude Code brain only (the openai-agents brain runs tools in its own process and is refused).

## Goals

1. **Dispatcher** (`steward`, one replica, `Recreate` strategy): receives Linear and GitLab webhooks (ingress), keeps
   the SQLite job/loop state on a PVC, enforces one run per ticket and a cap on concurrent runs, creates a Job per
   run, watches it to completion, records the result, and does the label swaps and MR notes. `await_review` polling
   stays in the dispatcher (no pod). It reads the `DEV_` credentials it needs (Linear key, `GITLAB_TOKEN`, webhook
   secrets) at start-up into memory; nothing is written to disk.
2. **Run pod** (one Job, one pod; implement, fix, chat):
   - **agent container**: builds the worktree, runs workspace setup, Claude Code (via the Agent SDK, in-process as
     today), Playwright, the app, and the checks. It has **no credential of any kind**: no `DEV_` value, no
     service-account token (`automountServiceAccountToken: false`, no projected token mounted into it), no model key.
   - **keyproxy sidecar**: holds the model credential (today the gateway's `ANTHROPIC_BASE_URL` +
     `ANTHROPIC_AUTH_TOKEN`); the agent gets `ANTHROPIC_BASE_URL=http://127.0.0.1:<port>` and a dummy token. It swaps
     the auth header, forwards only to that upstream, and streams SSE unbuffered.
   - **tools sidecar**: holds `GITLAB_TOKEN` / `GITLAB_PUSH_TOKEN` and serves the codehost, push and orbit MCP servers
     over HTTP on localhost. The push tool keeps every current rule (clean tree, ticket-prefixed linear commits,
     secret guard, checks, closed-ticket check, bundle-and-push from a scratch repo).
   - **Postgres (TimescaleDB), Redis, RabbitMQ sidecars**: the run's throwaway services on localhost, replacing slots,
     the slot helper and dind. `slots.env` templating becomes fixed localhost ports.
   - **session init + sync**: before the run, download the ticket's session folder from MinIO; during and after it,
     upload it back (periodically, and at the end). These hold the MinIO credential; the agent container does not.
   - Containers share the pod network and the volumes they explicitly mount, nothing else (no
     `shareProcessNamespace`). Only sidecars that need AWS or MinIO get the projected service-account token.
3. **Secrets flow:** projected service-account token (audience `sts.amazonaws.com`, short expiry) →
   `AssumeRoleWithWebIdentity` (the AWS SDK's default chain does this from `AWS_ROLE_ARN` +
   `AWS_WEB_IDENTITY_TOKEN_FILE`) → `GetSecretValue` on the needed `DEV_` entries → values in memory. Credentials expire
   on their own.
4. **Sessions:** Claude Code transcripts (`<CLAUDE_CONFIG_DIR>/projects/<worktree-path-key>/<id>.jsonl`) are the
   durable state. The worktree path per ticket stays fixed (`…/work/ticket-<KEY>`) so the key matches and `--resume`
   works from any node. MinIO authenticates the sync containers through its STS `AssumeRoleWithWebIdentity` with the
   same k3s issuer, so MinIO has no static access keys in use either. A crashed pod loses at most the last sync
   interval of transcript.
5. **Worktrees are rebuilt each run** from the remote: the ticket branch if pushed, else the base. The agent pushes
   everything it keeps; unpushed work at the end is already a hand-back reason. Overlay files (sandbox app env) are
   copied in as today.
6. **`steward chat <KEY>`** starts the same run pod for that ticket with an interactive Claude Code session and attaches
   a TTY (`kubectl exec -it`-style), with the same sidecars, policy hook and session sync. It holds the ticket like a
   job does.
7. **Isolation enforced by the cluster:** NetworkPolicy (k3s ships a policy controller) so run pods reach the internet
   and their own localhost, the dispatcher only on its callback endpoint, and never the Kubernetes API, MinIO's admin
   API or other run pods. The dispatcher's service account may create and watch Jobs/pods in its namespace only.

## Non-goals

- **Overlay app credentials** (Stripe test, provider keys, Descope test project…, from `DEV_`) still reach the agent as
  files in the worktree. Swapping them for placeholders through an intercepting proxy is the next design. Until then
  they stay test-only with spend caps.
- Provisioning the k3s cluster itself (nodes, CNI, ingress controller). This design lists what the cluster must provide.
- Elastic scaling; HA for the dispatcher (SQLite, one replica).
- Migrating the current Compose host is in scope only as a cut-over step at the end (sessions and DB copied over).

## Anti-goals

- A credential, AWS token or MinIO credential reaching the agent container by any path: env, file, volume, process
  listing, a sidecar's error message relayed through a tool result, or the session transcript (which the agent reads).
- A sidecar running code the agent controls with a credential in reach. Sidecars that run git on the agent's worktree
  (the push tool) must neutralise repo/worktree config that executes programs or redirects remotes
  (`core.fsmonitor`, `core.hooksPath`, `core.sshCommand`, filters, textconv, `url.*.insteadOf`, `http.proxy`, …).
- keyproxy as an open relay.
- Long-lived tokens anywhere new: no AWS keys, no MinIO root keys in pods, no per-run token that outlives its run.
- Breaking resume of existing sessions after the cut-over.

## Cluster prerequisites (owner's infra)

- k3s started with a public `service-account-issuer` URL whose OIDC discovery document and JWKS AWS can fetch over
  HTTPS (and MinIO can reach), and that issuer registered in IAM as an OIDC provider.
- An IAM role trusting `system:serviceaccount:<namespace>:<sa>` for the dispatcher and run-pod sidecar service
  accounts, allowing `secretsmanager:GetSecretValue` on the dev secrets (owner: all `DEV_` entries).
- Ceph-backed storage (owner: the cluster uses Ceph) for the two PVCs, dispatcher SQLite and MinIO: replicated
  block volumes (RBD, ReadWriteOnce), so losing a node loses neither and the pods can be rescheduled elsewhere.
- Ingress for the webhook URL (today `adam.concentrate.ai` through cloudflared).
- Node capacity for run pods: each carries TimescaleDB, Redis, RabbitMQ, Chromium and a pnpm/turbo build.

## Calls made after the builder check (owner to confirm)

- **Overlay files are built from `DEV_` entries at run start, never stored.** An init container with the
  service-account token renders kickoff's env files from a template in the config (key → `DEV_` secret, like
  `preview.py`'s `app_env`) into a volume the agent container mounts. No Kubernetes Secret holds them. The tools
  sidecar reads the same values for the push tool's secret guard. Slot values (localhost ports, throwaway passwords)
  are literals in the template.
- **The steward's checks guard quality, not a hostile agent.** They run in the agent container, and the push tool
  takes their result from there. What must be trustworthy is computed by the tools sidecar from git objects alone:
  the secret guard, ticket prefixes, linear history, and unpushed work. The MR's own CI pipeline stays the real gate.
- **`steward chat`** runs inside the dispatcher pod (`kubectl exec -it deploy/steward -- steward chat KEY`). Anyone with
  exec rights in the namespace may chat. It starts the run pod and attaches to it, so the dispatcher's service
  account also gets `pods/attach`/`pods/exec` on run pods in its namespace.

- **Durability comes from Ceph replication** (owner). There is no separate off-cluster backup. Replication does not
  undo a deletion or corruption; a Ceph snapshot schedule covers that if wanted.
- **Images carry the tools and a warm package store; runs share nothing writable** (owner: "whatever tools are safe
  bundled into the image"):
  - The agent image bakes Chromium, glab, Orbit, pnpm, psql and the rest of the toolchain.
  - The agent image also bakes a pnpm store prefetched from the base branch's lockfile. It is built by a trusted
    image build, never by a run, and rebuilt on a schedule or when the lockfile changes. A run's `pnpm install` then
    fetches only what changed.
  - The clone, build and Orbit index still happen per run. Nothing a run writes is seen by another run.

## Left to the builder

- Packaging (Helm chart or plain manifests in this repo), image split (dispatcher, agent, keyproxy, tools, sync).
- How a run reports its result to the dispatcher (callback with a per-run token, or the dispatcher reads the pod's
  output), as long as the token dies with the run.
- MCP transport details, keyproxy implementation, MinIO bucket layout and policies.
- How the concurrency cap and the resource guard map onto Job scheduling and pod requests/limits.
- Doctor checks for the cluster setup (issuer reachable, role assumable, MinIO STS, NetworkPolicy effective, the agent
  container holds no token).
