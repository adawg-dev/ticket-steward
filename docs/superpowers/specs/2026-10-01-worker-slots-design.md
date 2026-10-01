# Worker slots: parallel jobs on fresh containers

Date: 2026-10-01. Status: approved in brainstorming; awaiting spec review.

## Why

The worker runs one job at a time. A burst of labelled tickets queues behind each other (job 49 waited 4m19s behind
a triage). Jobs cannot simply run side by side, for two reasons. Every job's setup (`reset-dbs.sh`) drops and recreates
the one local Postgres and its Timescale database, and every job starts the app on the same `workspace.port`.

Each job also has its own worktree, but it reads kickoff's env files from the overlay. Several of those files point
at shared infrastructure: Timescale Cloud (`TG_*` in `service/Cron`, `service/Metrics`, `integration`,
`packages/tigerdb`), the dev Redis cluster (`REDIS_CLUSTER_NODES` → `10.2.0.51:7000-7002`), the dev RabbitMQ
(`RABBITMQ_URL` → `10.2.0.45`) and a remote Postgres (`DB_HOST=10.2.0.11` in `packages/Service/*`). No service
needs the real remote one during a job (confirmed by the owner, 2026-10-01).

## Goal

- `slots.count` jobs (start at 2) run at once. Each runs on its own **slot**: an app port plus three containers created
  fresh for that job (Postgres with TimescaleDB, Redis, RabbitMQ), removed when the job ends.
- Every service a job starts talks only to its slot, never to shared or remote infrastructure.
- The `steward` user cannot run Docker. The agent runs as `steward`, and Docker access would give it root.

Out of scope: the Managed Agents brain (separate brainstorm), priorities between job kinds, and per-slot pnpm stores (the
content-addressed store is safe to share).

## Design

### 1. Slot helper (root)

`/usr/local/sbin/steward-slot` is a bash script owned by root, mode 0755, installed from `ops/steward-slot` in this repo.
A sudoers drop-in, `/etc/sudoers.d/ticket-steward-slots`, allows exactly:

```
steward ALL=(root) NOPASSWD: /usr/local/sbin/steward-slot
```

The script validates its own arguments: anything not on this list exits 2 with a usage line. `n` must be an integer
1–9 with no leading zero.

| Command | Does | Output |
| --- | --- | --- |
| `up <n>` | `docker compose -p steward-slot-<n> -f /etc/ticket-steward/slots/compose.yml up -d --wait --wait-timeout 120` | compose output |
| `down <n>` | `docker compose -p steward-slot-<n> … down --volumes --remove-orphans --timeout 10` (also runs when nothing is up) | compose output |
| `status <n>` | running containers of project `steward-slot-<n>` | one line per container |
| `ports <n>` | the slot's host ports | one JSON line `{"postgres":15132,"redis":16179,"rabbitmq":15172}` |
| `check` | compose file parses, all three images are present locally | `ok` or the missing item, exit 1 |

The port formula lives only in the helper: `postgres = 15032 + 100n`, `redis = 16079 + 100n`,
`rabbitmq = 15072 + 100n`. Every port binds to `127.0.0.1`. The helper exports the ports as environment variables that
the compose file interpolates. The steward learns them from `ports <n>`, never from its own config.

`/etc/ticket-steward/slots/compose.yml` (root-owned, installed from `ops/slots-compose.yml`) defines three services, all
with `pull_policy: missing`, healthchecks, no named volumes, and data on tmpfs:

- `postgres`: `timescale/timescaledb-ha:pg17-ts2.27-all` (the image kickoff's integration compose uses). The user is
  `postgres` with password `steward-slot`. An init script mounted read-only from `/etc/ticket-steward/slots/init/` creates
  the databases `concentrate` and `concentrate_tg` and runs `CREATE EXTENSION IF NOT EXISTS timescaledb` in
  `concentrate_tg`. PGDATA is on tmpfs. The implementer verifies the image's data path; for `-ha` it is under
  `/home/postgres/pgdata`.
- `redis`: `redis:7-alpine`, run with `--save "" --appendonly no`.
- `rabbitmq`: `rabbitmq:4.2.0-management`, with `RABBITMQ_DEFAULT_USER=steward` and `RABBITMQ_DEFAULT_PASS=steward-slot`.
  The built-in `guest` user only accepts loopback connections, and a Docker-mapped port is not loopback.

These credentials are throwaway: the databases live only for one job. They are not secrets, and the redactor does not need them.

The images are pulled once at install (`docker pull …`). `check` and `steward doctor` report one that is missing.

### 2. Config

A new optional top-level block:

```ts
slots: {
  count: 2,                                  // 1–9
  helper: "/usr/local/sbin/steward-slot",    // default
  appPortBase: 4100,                         // slot n's app port = appPortBase + n
  upTimeoutSeconds: 180,                     // default; kills a hung `up`
  env: {                                     // applied to every copied overlay file that defines the key
    DB_HOST: "localhost",
    DB_PORT: "{{postgres}}",
    DB_NAME: "concentrate",
    DB_USER: "postgres",
    DB_PASSWORD: "steward-slot",
    PGPASSWORD: "steward-slot",
    DB_SSL: "false",
    TG_READ_CONN_STR: "postgres://postgres:steward-slot@localhost:{{postgres}}/concentrate_tg",
    TG_WRITE_CONN_STR: "postgres://postgres:steward-slot@localhost:{{postgres}}/concentrate_tg",
    TG_CONN_STR: "postgres://postgres:steward-slot@localhost:{{postgres}}/concentrate_tg",
    REDIS_URL: "redis://localhost:{{redis}}",
    REDIS_CLUSTER_NODES: null,               // null deletes the key: kickoff's client then uses REDIS_URL
    REDIS_PASSWORD: null,
    RABBITMQ_URL: "amqp://steward:steward-slot@localhost:{{rabbitmq}}",
  },
},
```

- Templates are `{{app}}`, `{{postgres}}`, `{{redis}}` and `{{rabbitmq}}`. An unknown `{{name}}` fails config load.
- **With `slots` set,** `workspace.port` is rejected with the message "replaced by slots.appPortBase (see
  docs/ops.md)", the same way `triggerLabel` was. `workspace.portRewrite` stays and rewrites `localhost:<from>` to the
  slot's app port instead of `workspace.port`. It is a substring rewrite, which is what a list value needs: kickoff's
  `localhost:3000` appears in `BASE_URL` (`e2e/user/.env`) and in nine `CORS_ORIGIN` values, which may hold several
  origins. Replacing a whole value would drop the other origins.
- **Without `slots`,** behaviour is unchanged: one worker loop, `workspace.port` and `portRewrite`, no containers. This
  keeps the steward usable on a host without Docker, and keeps the existing tests valid.
- The owner's live `env` map is the block above. kickoff was read on 2026-10-01 for key names only.

### 3. Overlay overrides

`copyOverlay` gains an `overrides: Record<string, string | null>` option, with the templates already rendered for the
slot. For each copied file, the steward edits only lines of the form `KEY=value`, optionally prefixed by `export ` and with
whitespace around `=`. Comments, blank lines and every other line stay as they are.

- A key with a string value: the value is replaced, unquoted. The line keeps `export ` if it had it.
- A key with `null`: the line is removed.
- A key that appears in no overlay file fails setup with `slot override keys not found in the overlay: KEY1, KEY2`.
  It names keys, never values.
- Keys are never added.

Rewrites apply only to the job's copy. The overlay directory itself is never changed. The secret collection
(`collectSecretValues`) and the guards (`guardSecrets`) keep reading the original overlay, so a deleted remote password
is still redacted wherever it appears.

### 4. Job lifecycle on a slot

`prepareWorkspace` (in `src/core/workspace.ts`; used by enrich, review and implement) gains a `slot: Slot` argument,
where `Slot = { n, appPort, ports }`. Per job:

1. `freePort(slot.appPort)`, as today for the single port.
2. `sudo -n <helper> down <n>`, then `sudo -n <helper> up <n>`. Either one failing (or `up` exceeding
   `upTimeoutSeconds`) fails the job as retryable, `setup failed: slot <n>: <last 4 KB of helper output>`. The tail goes
   into the attempt's `setupTail` after redaction.
3. Create the worktree (under the mirror mutex, §6). Copy the overlay with the rendered overrides and with
   `portRewrite` aimed at `appPort`. Copy the skills.
4. Run `workspace.setup`. `reset-dbs.sh` needs no change: it reads `e2e/user/.env`, which now holds the slot's values.
5. The brain gets `STEWARD_PORT=<appPort>`. Prompts get `{{stewardPort}}` = `appPort`.
6. Publish as today.
7. In `finally`: `sudo -n <helper> down <n>`. A failure is logged as a warning; the next `up` starts with `down` anyway.

Brain policy (`src/brain/policy.ts`) adds two `DENIED_COMMANDS` entries:
- `/(^|\s)sudo(\s|$)/`;
- `/(^|\s)docker(\s|$)/`, which also blocks `docker compose`.

This is defence in depth. The accepted risk is that an agent which gets around the policy could `down` another slot. The
damage is limited to that slot's job failing and being retried.

### 5. Worker concurrency

`startWorker` runs `slots.count` loops (one without `slots`). Each loop owns one slot for its whole life.

- **Claim.** `JobStore.claimNext()` takes the oldest queued, due job that has no `running` job for the same ticket. For
  issue jobs (`enrich`, `implement`), "same ticket" means the same `issue_id`. For review jobs, it means the same
  non-null `subject`. All of this is one `UPDATE … WHERE id = (SELECT … AND NOT EXISTS (…)) RETURNING *` statement.
  better-sqlite3 runs synchronously in one process, so two loops can never claim the same job.
- **State.** `WorkerHandle.state()` returns `{ running: Array<{ slot: number; jobId: number }> }`. The `/status`
  endpoint and `steward jobs` show the array. The old `running: number | null` field goes away; the shape changes in
  the same release.
- **Stop.** `stop()` sets the flag, wakes every idle loop, aborts each running job's signal (as today for one), and
  awaits every loop. It then brings every slot `down` before releasing `run.lock`. `TimeoutStopSec=120` stays.
- **Start.** After `requeueInterrupted`, every slot 1..count gets `down`, which clears what a crash left behind.
- **Retention.** `sweep` runs at startup and on its timer. It runs only while no job is running at all: the timer
  skips that run, and the next interval tries again. Today it already runs between jobs, so this keeps one worktree
  from being deleted under a running job without adding a per-job protect list across loops.
- **Inline CLI runs** (`steward enrich|implement KEY` without serve) use slot 1 under `run.lock`, as today.

### 6. Shared mirror

`Mirror` gets an in-process async mutex. `fetch`, `fetchRef`, `createWorktree`'s `git worktree add`, and worktree
removal or prune all run under it. Git's own lock files would otherwise make one of two concurrent fetches fail. Reads
of mirror objects (`rev-parse`, the implement push repo's alternates, bundles) need no lock.

### 7. Doctor

New checks when `slots` is set. Each failure names what to fix.

- The helper path exists, is owned by root, and is not writable by group or others. The sudoers rule works:
  `sudo -n <helper> check` exits 0, which also covers the compose file parsing and the images being present.
- For each slot: `ports <n>` parses. The app port and the three service ports are free, with every slot `down` at that
  moment (doctor runs while serve is stopped or idle; a port held by a running slot reads as in use and is reported as
  "slot n is up").
- Every `slots.env` key appears in at least one overlay file. The check lists the missing keys.
- `workspace.port` is absent (config load already rejects it; doctor reports the config error).

### 8. Errors summary

| Failure | Result |
| --- | --- |
| `up`/`down` before setup fails, or `up` times out | job `failed`, retryable, slot tail in `setupTail` |
| override key missing from the overlay | job `failed`, not retryable (config problem), keys named |
| `down` after the job fails | warning logged; job outcome unchanged |
| `sudo -n` asks for a password (sudoers missing) | same as `up` failing; doctor catches it beforehand |
| two loops reach for the mirror | serialized by the mutex; no error |

### 9. Testing

- **Store:** the claim skips a job whose ticket (issue) or MR (subject) has one running, takes the next job instead, and
  takes the skipped one once the running job finishes.
- **Worker:** with two fake slots and a fake `run`, two jobs for different tickets run at once. Two for the same ticket
  run one after the other. `stop()` aborts both and awaits both. `state()` lists both.
- **Overlay:** replace, `export` lines, deletion with `null`, keys never added, a missing key fails with key names and no
  values, comments and other lines untouched, the original overlay unchanged.
- **Slot client** (`src/workspace/slots.ts`): runs the helper through an injectable runner. It parses `ports`, maps
  failures to the error text above, and runs `down` in `finally`.
- **Mirror mutex:** two concurrent `fetch` calls both succeed on a real bare repo.
- **Policy:** `sudo …` and `docker …` (including `docker compose`) are denied for the Bash and `run_shell` tools.
- **Config:** `slots` parses with defaults. An unknown template fails. `workspace.port` with `slots` fails with the pointer.
  `portRewrite` with `slots` rewrites to the slot's app port. Without `slots`, it behaves as today.
- **Helper:** `test/ops/steward-slot.test.ts` runs the script with a fake `docker` on `PATH` and covers argument
  validation (bad command, `0`, `10`, `01`, `1;rm`), the `ports` output, and the compose project names.
- Typecheck, lint and the full suite stay green. Tests that exercise containers live are not part of the suite.

### 10. Rollout (ops, run by the controller after merge)

1. Install `ops/steward-slot` to `/usr/local/sbin` (root, 0755), and `ops/slots-compose.yml` plus `init/` to
   `/etc/ticket-steward/slots/` (root-owned).
2. Write the sudoers drop-in and validate it with `visudo -cf`.
3. `docker pull` the three images.
4. `sudo -u steward sudo -n steward-slot check`, then `up 1`, `status 1`, `down 1`, timing `up` (target under 30 s).
5. Add `slots` to the live config, keeping the `.bak` copy, and remove `workspace.port` (`portRewrite` stays). Run
   `steward doctor`.
6. Restart while idle. Label two tickets. Confirm that `docker ps` shows `steward-slot-1` and `steward-slot-2` during the
   run and nothing afterwards, and that both jobs finish.
7. Update `docs/ops.md` with a "Worker slots" section: why, install, config, the threat note, and troubleshooting
   (`steward-slot status n`, ports in use).

## Decisions

- Fresh containers per job rather than a fixed pool that gets reset: the owner's choice. The price is container start
  time on every job.
- A root helper behind sudoers rather than giving `steward` Docker access: Docker access would give the agent root.
- One `timescaledb-ha` container holds both databases, matching the current native layout. Timescale locally is a
  database on the same server, not a second server.
- Overrides by key: replace or delete, never add. Unconfigured keys fail loudly.
- `slots` is optional, and the single-port behaviour stays when it is absent.
- Retention runs only while nothing is running. This is simpler than a protect list shared across loops, and the
  only cost is a delayed sweep.
