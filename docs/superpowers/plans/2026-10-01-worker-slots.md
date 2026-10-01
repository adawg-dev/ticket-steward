# Worker Slots Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** With an optional `slots` block, the worker runs `slots.count` jobs at once, each on its own slot (an app port plus fresh Postgres+TimescaleDB, Redis and RabbitMQ containers brought up by a root helper through `sudo -n` and removed when the job ends), and every service a job starts talks only to its slot; without `slots`, behaviour is unchanged.

**Architecture:** A root-owned bash helper (`ops/steward-slot`) is the only thing that touches Docker; the steward talks to it through `SlotClient` (`src/workspace/slots.ts`) with an injectable runner. `PipelineDeps` gains `slot?: SlotRef`; `prepareWorkspace` brings the slot up and copies the overlay with rendered `slots.env` overrides, `cleanupWorkspace` brings it down. The worker runs one loop per slot; `claimNext` skips tickets/MRs that already have a running job, the mirror serializes fetches and worktree add/remove with an in-process mutex, and retention only sweeps while nothing runs.

**Tech Stack:** TypeScript (ESM, Node 22), zod 4, vitest, better-sqlite3, execa 10, bash, Docker Compose v2 (ops only).

**Spec:** `docs/superpowers/specs/2026-10-01-worker-slots-design.md`

## Global Constraints

- Never typecast anything to `any` (no `as any`, no `: any`); `@typescript-eslint/no-explicit-any` is an error.
- Match the surrounding code style and comment density: short `/** … */` doc comments on exported functions and non-obvious privates, one-line `//` comments only where the why is not obvious, no banner comments.
- Every commit message ends with the trailer line exactly: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Conventional-commit subjects in the repo's style (`feat(scope): …`, `fix(scope): …`, `docs(ops): …`), lower-case, no trailing period.
- Each task ends with `npm run -s typecheck`, `npm run -s lint` and the task's vitest files green; Task 10 runs the full suite (`npx vitest run`).
- No live Docker in tests: the slot client is exercised through an injectable `SlotRunner`, the bash helper through a fake `docker` on `PATH`, `sudoRunner` through a fake `sudo` on `PATH`.
- Nothing in Tasks 1–10 runs `sudo` or `docker`, or touches `/etc` or `/usr/local`. Rollout is the final "Ops (controller only, not a subagent task)" section.
- `slots` is optional; absent means today's behaviour (one loop, `workspace.port`, `portRewrite`, no containers).
- With `slots`, `workspace.port` is rejected with the message `workspace.port was replaced by slots.appPortBase (see docs/ops.md)`; `workspace.portRewrite` stays and targets the slot's app port.
- `slots` values: `count` 1–9; `helper` default `/usr/local/sbin/steward-slot`; slot n's app port = `appPortBase + n`; `upTimeoutSeconds` default 180; templates `{{app}}`, `{{postgres}}`, `{{redis}}`, `{{rabbitmq}}`; an unknown `{{name}}` fails config load.
- Overrides replace (unquoted, keeping `export `) or delete (`null`) `KEY=value` lines, never add; a key no overlay file defines fails with `slot override keys not found in the overlay: KEY1, KEY2` (keys only, never values).
- Helper commands exactly `up|down|status|ports <n>` and `check`; `n` is 1–9 with no leading zero; anything else exits 2 with a usage line. The port formula (`postgres = 15032 + 100n`, `redis = 16079 + 100n`, `rabbitmq = 15072 + 100n`) lives only in the helper; the steward learns ports from `ports <n>` JSON.
- Images `timescale/timescaledb-ha:pg17-ts2.27-all`, `redis:7-alpine`, `rabbitmq:4.2.0-management`; Postgres user `postgres` / password `steward-slot`; RabbitMQ `steward` / `steward-slot`; databases `concentrate` and `concentrate_tg` (with `timescaledb`); every port on `127.0.0.1`; data on tmpfs; no named volumes.
- A slot that fails to come up fails the job retryably with `setup failed: slot <n>: <last 4 KB of helper output>`, the redacted tail in the attempt's `setupTail`.

## Review Focus

1. **A hung `up` (wedged Docker daemon).** Expected: the real `sudoRunner` kills it after `upTimeoutSeconds` and the job fails retryably with `[timed out after N s]` in the tail. Pinned by Task 2 (`sudoRunner` "kills a helper that runs past the timeout", `SlotClient` "reports a hung up as timed out").
2. **Shutdown while a slot is still coming up.** Expected: the `up` is canceled through the signal, the outcome is `INTERRUPTED_ERROR` (requeued, not failed), and the slot still goes `down`. Pinned by Task 7 ("reports an interrupted run when shutdown aborts a slot that is still coming up").
3. **One loop's interrupted job requeuing another loop's running job.** Today `record()` calls the global `requeueInterrupted`, which requeues every running job and closes their attempts; with two loops that would let a second loop claim a job that is still running. Expected: only the interrupted job is requeued. Pinned by Task 5 ("requeueInterruptedJob requeues only that job") and Task 8 ("an interrupted job leaves the job on the other slot running").
4. **Overlay lines as kickoff writes them.** `export KEY = "v"`, single quotes, indentation, CRLF endings, the same key in several files, a key in one file but not another. Expected: every defining line is rewritten, nothing is added anywhere, every other byte stays. Pinned by Task 3 ("applies to every file that defines the key, keeps CRLF and never adds a key", "replaces values unquoted…").
5. **`sudo` refusing (missing sudoers rule, or `NoNewPrivileges=yes` in the systemd unit, which doctor run from a shell does not see).** Expected: sudo's own message reaches the job's `setupTail` and doctor's `slot sudo` line, and the docs/unit carry the drop-in. Pinned by Task 2 ("does not run up when the leading down fails"), Task 7 ("fails retryably with the helper's tail…"), Task 9 ("reports a failed sudo check"), Task 10 (unit comment, docs) and the Ops checklist (systemd-run check).

---

## File Structure

| File | Responsibility |
| --- | --- |
| `src/config/schema.ts` (modify) | `slots` block, template constants, `appPortOf`, `workspace.port` optional and rejected next to `slots` |
| `ops/steward-slot` (create, 0755) | Root helper: argument validation, port formula, `docker compose` calls |
| `ops/slots-compose.yml` (create) | The three slot services (images, tmpfs, healthchecks, 127.0.0.1 binds, credentials) |
| `ops/slots-init/01-databases.sql` (create) | Creates `concentrate`, `concentrate_tg` and the `timescaledb` extension |
| `src/workspace/setup.ts` (modify) | Export `keepTail` |
| `src/workspace/slots.ts` (create) | `SlotClient`, `sudoRunner`, `SlotError`, `renderSlotEnv`, slot types |
| `src/workspace/overlay.ts` (modify) | `overrides` option, `OverrideKeysError`, `missingOverrideKeys` |
| `src/workspace/mutex.ts` (create) | Promise-chain mutex |
| `src/workspace/mirror.ts` (modify) | `exclusive()`; `fetch`/`fetchRef` under it |
| `src/workspace/worktree.ts` (modify) | Worktree prune/add/remove under `mirror.exclusive` |
| `src/store/jobs.ts` (modify) | `claimNext` skips busy tickets/MRs; `requeueInterruptedJob` |
| `src/brain/policy.ts` (modify) | Deny `sudo` and `docker` |
| `src/core/deps.ts` (modify) | `slot?: SlotRef` |
| `src/core/workspace.ts` (modify) | `jobPort`, slot start in `prepareWorkspace`, release in `cleanupWorkspace`, `prepareFailed` |
| `src/core/pipeline.ts`, `src/review/pipeline.ts`, `src/implement/pipeline.ts` (modify) | Use `jobPort` and `prepareFailed` |
| `src/worker/loop.ts`, `src/worker/index.ts` (modify) | One loop per slot, `WorkerState`, down at start/stop, idle-only sweep |
| `src/server/app.ts`, `src/cli/serve.ts` (modify) | `/health` `worker.running` array |
| `src/cli/context.ts`, `src/cli/doctor.ts` (modify) | `slotRunner` factory; slot checks |
| `src/cli/runtime.ts`, `src/cli/jobs.ts`, `src/cli/prompt.ts` (modify) | Slot 1 for inline runs; running-slots header; prompt port |
| `docs/ops.md`, `ops/ticket-steward.service`, `examples/kickoff/steward.config.ts` (modify) | Worker slots docs, unit note, example config |
| `test/fakes/fakeSlotRunner.ts`, `test/ops/fakeDocker.sh` (create) | Test doubles |
| `test/ops/steward-slot.test.ts`, `test/workspace/slots.test.ts`, `test/workspace/mutex.test.ts` (create) | New tests |

---

### Task 1: Config: the `slots` block

**Files:**
- Modify: `src/config/schema.ts:1-103`
- Modify (call sites of the now-optional `workspace.port`): `src/core/pipeline.ts:82,154`, `src/review/pipeline.ts:77,103`, `src/implement/pipeline.ts:140,155,191`, `src/core/workspace.ts:85,133`, `src/cli/prompt.ts:49`, `src/cli/doctor.ts:285-288`
- Test: `test/config/schema.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces (all from `src/config/schema.ts`):
  - `export const SLOT_TEMPLATES: readonly ["app", "postgres", "redis", "rabbitmq"]`
  - `export type SlotTemplate = (typeof SLOT_TEMPLATES)[number]`
  - `export const SLOT_TEMPLATE_PATTERN: RegExp` (global; use only with `matchAll`/`replace`)
  - `export const isSlotTemplate: (name: string) => name is SlotTemplate`
  - `StewardConfig["slots"]`: `{ count: number; helper: string; appPortBase: number; upTimeoutSeconds: number; env: Record<string, string | null> } | undefined`
  - `StewardConfig["workspace"]["port"]`: `number | undefined`
  - `export type SlotsConfig = NonNullable<StewardConfig["slots"]>`
  - `export const appPortOf: (config: Pick<StewardConfig, "slots" | "workspace">, n: number) => number`

- [ ] **Step 1: Write the failing tests**

Append to `test/config/schema.test.ts` (and add `appPortOf` to the existing import from `../../src/config/schema.js`):

```ts
describe("slots config", () => {
  const slotsInput = { count: 2, appPortBase: 4100 };
  const withSlots = (slots: Record<string, unknown>, workspace: Record<string, unknown> = {}): unknown => ({
    ...minimalInput,
    workspace: { ...minimalInput.workspace, port: undefined, ...workspace },
    slots,
  });

  it("parses slots with defaults", () => {
    const parsed = StewardConfigSchema.parse(withSlots(slotsInput));
    expect(parsed.slots).toEqual({ count: 2, helper: "/usr/local/sbin/steward-slot", appPortBase: 4100, upTimeoutSeconds: 180, env: {} });
    expect(parsed.workspace.port).toBeUndefined();
  });

  it("accepts every template, spaces inside the braces, and null values", () => {
    const env = {
      DB_PORT: "{{postgres}}",
      REDIS_URL: "redis://localhost:{{ redis }}",
      RABBITMQ_URL: "amqp://steward:steward-slot@localhost:{{rabbitmq}}",
      BASE_URL: "http://localhost:{{app}}",
      REDIS_CLUSTER_NODES: null,
    };
    expect(StewardConfigSchema.parse(withSlots({ ...slotsInput, env })).slots?.env).toEqual(env);
  });

  it("rejects an unknown template, naming the key", () => {
    const parsed = StewardConfigSchema.safeParse(withSlots({ ...slotsInput, env: { DB_PORT: "{{pg}}" } }));
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues).toEqual([
      expect.objectContaining({ path: ["slots", "env", "DB_PORT"], message: "unknown template {{pg}}; use {{app}}, {{postgres}}, {{redis}} or {{rabbitmq}}" }),
    ]);
  });

  it("rejects workspace.port next to slots with a pointer to slots.appPortBase", () => {
    const parsed = StewardConfigSchema.safeParse(withSlots(slotsInput, { port: 4100 }));
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues).toEqual([
      expect.objectContaining({ path: ["workspace", "port"], message: "workspace.port was replaced by slots.appPortBase (see docs/ops.md)" }),
    ]);
  });

  it("still requires workspace.port without slots", () => {
    const parsed = StewardConfigSchema.safeParse({ ...minimalInput, workspace: { ...minimalInput.workspace, port: undefined } });
    expect(parsed.error?.issues).toEqual([expect.objectContaining({ path: ["workspace", "port"], message: "workspace.port is required unless slots is set" })]);
  });

  it("rejects a slot count outside 1-9", () => {
    expect(StewardConfigSchema.safeParse(withSlots({ ...slotsInput, count: 0 })).success).toBe(false);
    expect(StewardConfigSchema.safeParse(withSlots({ ...slotsInput, count: 10 })).success).toBe(false);
  });

  it("keeps portRewrite next to slots", () => {
    expect(StewardConfigSchema.parse(withSlots(slotsInput, { portRewrite: { from: 3000 } })).workspace.portRewrite).toEqual({ from: 3000 });
  });

  it("appPortOf is appPortBase + n with slots and workspace.port without", () => {
    expect(appPortOf(StewardConfigSchema.parse(withSlots(slotsInput)), 2)).toBe(4102);
    expect(appPortOf(StewardConfigSchema.parse(minimalInput), 2)).toBe(4100);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/config/schema.test.ts`
Expected: FAIL. `parsed.slots` is `undefined` (zod strips the unknown `slots` key), the `workspace.port` cases report no issue, and the last test fails with `appPortOf is not a function`.

- [ ] **Step 3: Implement the schema**

In `src/config/schema.ts`, add after `const BRANCH_TYPE = …;`:

```ts
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Placeholders a `slots.env` value may use; each is rendered per job from the slot's ports. */
export const SLOT_TEMPLATES = ["app", "postgres", "redis", "rabbitmq"] as const;
export type SlotTemplate = (typeof SLOT_TEMPLATES)[number];
/** `{{name}}`, optionally with spaces inside the braces. Global: use with matchAll or replace only. */
export const SLOT_TEMPLATE_PATTERN = /\{\{\s*([^{}]*?)\s*\}\}/g;
export const isSlotTemplate = (name: string): name is SlotTemplate => SLOT_TEMPLATES.some((template) => template === name);

const SlotsSchema = z
  .object({
    count: z.number().int().min(1).max(9),
    helper: z.string().min(1).default("/usr/local/sbin/steward-slot"),
    /** Slot n's app port is appPortBase + n. */
    appPortBase: z.number().int().positive().max(65_526),
    /** Kills a hung `up`. */
    upTimeoutSeconds: z.number().positive().default(180),
    /** Applied to every copied overlay file that defines the key; null deletes the line. */
    env: z.record(z.string().regex(ENV_KEY), z.string().nullable()).default({}),
  })
  .superRefine((slots, ctx) => {
    for (const [key, value] of Object.entries(slots.env)) {
      if (value === null) continue;
      for (const [, name = ""] of value.matchAll(SLOT_TEMPLATE_PATTERN)) {
        if (!isSlotTemplate(name)) {
          ctx.addIssue({ code: "custom", path: ["env", key], message: `unknown template {{${name}}}; use {{app}}, {{postgres}}, {{redis}} or {{rabbitmq}}` });
        }
      }
    }
  });
```

In the `workspace` object replace `port: z.number().int().positive(),` with:

```ts
    /** The app port without `slots`; with `slots` each slot has its own (slots.appPortBase + n). */
    port: z.number().int().positive().optional(),
```

After `implement: ImplementSchema.optional(),` add:

```ts
  /** Parallel jobs on fresh per-job containers; unset keeps one job at a time on workspace.port. */
  slots: SlotsSchema.optional(),
```

At the end of the top-level `superRefine` callback add:

```ts
  if (config.slots !== undefined && config.workspace.port !== undefined) {
    ctx.addIssue({ code: "custom", path: ["workspace", "port"], message: "workspace.port was replaced by slots.appPortBase (see docs/ops.md)" });
  }
  if (config.slots === undefined && config.workspace.port === undefined) {
    ctx.addIssue({ code: "custom", path: ["workspace", "port"], message: "workspace.port is required unless slots is set" });
  }
```

At the end of the file add:

```ts
export type SlotsConfig = NonNullable<StewardConfig["slots"]>;

/** Slot n's app port with `slots`, otherwise `workspace.port`; config load guarantees one of them. */
export const appPortOf = (config: Pick<StewardConfig, "slots" | "workspace">, n: number): number => {
  if (config.slots !== undefined) return config.slots.appPortBase + n;
  if (config.workspace.port === undefined) throw new Error("workspace.port is required unless slots is set");
  return config.workspace.port;
};
```

- [ ] **Step 4: Point every `workspace.port` reader at `appPortOf`**

Typecheck now fails wherever `workspace.port` is read as a `number`. Fix each (Task 7 replaces the pipeline ones with the job's slot port; until then slot 1 / `workspace.port` keeps today's behaviour):

- `src/core/pipeline.ts`: add `import { appPortOf } from "../config/schema.js";`; line 82 `stewardPort: config.workspace.port,` → `stewardPort: appPortOf(config, 1),`; line 154 `buildBrainEnv(secrets, config.brain, config.workspace.port)` → `buildBrainEnv(secrets, config.brain, appPortOf(config, 1))`.
- `src/review/pipeline.ts`: add `import { appPortOf } from "../config/schema.js";`; line 77 `deps.config.workspace.port` → `appPortOf(deps.config, 1)`; line 103 `stewardPort: deps.config.workspace.port,` → `stewardPort: appPortOf(deps.config, 1),`.
- `src/implement/pipeline.ts`: change `import type { ImplementConfig } from "../config/schema.js";` to `import { appPortOf, type ImplementConfig } from "../config/schema.js";`; lines 140, 155 and 191 replace `deps.config.workspace.port` with `appPortOf(deps.config, 1)`.
- `src/core/workspace.ts`: add `import { appPortOf } from "../config/schema.js";`; line 85 `to: config.workspace.port` → `to: appPortOf(config, 1)`; lines 133-135 become:

```ts
  const { keepOnFailure } = deps.config.workspace;
  const port = appPortOf(deps.config, 1);
  try {
    if (!(await isPortFree(port))) await freePort(port);
```

- `src/cli/prompt.ts`: add `import { appPortOf } from "../config/schema.js";`; line 49 → `stewardPort: appPortOf(config, 1),`.
- `src/cli/doctor.ts`: add `import { appPortOf } from "../config/schema.js";`; replace the `port` check (lines 285-288) with:

```ts
    {
      name: "port",
      run: async () => {
        const port = appPortOf(config, 1);
        return (await isPortFree(port)) ? ok(`${port} is free`) : flunk(`${port} is in use`);
      },
    },
```

- [ ] **Step 5: Run the tests and checks**

Run: `npx vitest run test/config && npm run -s typecheck && npm run -s lint`
Expected: PASS, no type or lint errors.

- [ ] **Step 6: Commit**

```bash
git add src/config/schema.ts src/core/pipeline.ts src/review/pipeline.ts src/implement/pipeline.ts src/core/workspace.ts src/cli/prompt.ts src/cli/doctor.ts test/config/schema.test.ts
git commit -m "feat(config): optional slots block; workspace.port rejected next to it

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Slot helper, compose file and slot client

**Files:**
- Create: `ops/steward-slot` (mode 0755), `ops/slots-compose.yml`, `ops/slots-init/01-databases.sql`
- Create: `src/workspace/slots.ts`
- Modify: `src/workspace/setup.ts:3` (export `keepTail`)
- Create: `test/ops/fakeDocker.sh` (mode 0755), `test/ops/steward-slot.test.ts`, `test/fakes/fakeSlotRunner.ts`, `test/workspace/slots.test.ts`

**Interfaces:**
- Consumes: `SLOT_TEMPLATE_PATTERN`, `isSlotTemplate`, `SlotTemplate`, `SlotsConfig` from Task 1.
- Produces (from `src/workspace/slots.ts`):
  - `export interface SlotPorts { postgres: number; redis: number; rabbitmq: number }`
  - `export interface Slot { n: number; appPort: number; ports: SlotPorts }`
  - `export interface HelperResult { exitCode: number; stdout: string; output: string; timedOut: boolean; canceled: boolean }`
  - `export type SlotRunner = (args: string[], opts: { timeoutMs: number; signal?: AbortSignal }) => Promise<HelperResult>`
  - `export class SlotError extends Error { readonly n: number; readonly tail: string }` (message `slot <n>: <tail>`)
  - `export const sudoRunner: (helper: string) => SlotRunner`
  - `export class SlotClient { constructor(settings: Pick<SlotsConfig, "helper" | "upTimeoutSeconds">, runner?: SlotRunner); ports(n: number): Promise<SlotPorts>; start(n: number, signal?: AbortSignal): Promise<SlotPorts>; release(n: number): Promise<void>; down(n: number): Promise<boolean>; status(n: number): Promise<string>; check(): Promise<{ ok: boolean; output: string }> }`
  - `export interface SlotRef { n: number; client: SlotClient }`
  - `export const renderSlotEnv: (env: Record<string, string | null>, slot: Slot) => Record<string, string | null>`
  - `src/workspace/setup.ts`: `export const keepTail: (text: string, tailBytes: number) => string`
  - Test fake (`test/fakes/fakeSlotRunner.ts`): `helperPorts(n): SlotPorts`, `fakeSlotRunner(portsFor?): FakeSlotRunner` with `run`, `calls: string[][]`, `timeouts: number[]`, `respond(command, Partial<HelperResult>)`, `hang(command)`.

- [ ] **Step 1: Write the fake docker and the helper tests**

Create `test/ops/fakeDocker.sh` (then `chmod 0755 test/ops/fakeDocker.sh`):

```bash
#!/usr/bin/env bash
# Stands in for docker in the steward-slot tests: logs each call with the slot ports it saw, answers what the helper reads.
printf '%s|%s|%s|%s\n' "$*" "${STEWARD_SLOT_POSTGRES_PORT:-}" "${STEWARD_SLOT_REDIS_PORT:-}" "${STEWARD_SLOT_RABBITMQ_PORT:-}" >> "$FAKE_DOCKER_LOG"
case "$*" in
  *" config --images") printf '%s\n' timescale/timescaledb-ha:pg17-ts2.27-all redis:7-alpine rabbitmq:4.2.0-management ;;
  "image inspect "*) [[ "$3" != "${FAKE_DOCKER_MISSING:-}" ]] ;;
esac
```

Create `test/ops/steward-slot.test.ts`:

```ts
import { chmod, copyFile, mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { execa } from "execa";
import { removeDir, tmpDir } from "../workspace/helpers.js";

const HELPER = resolve("ops/steward-slot");
const COMPOSE = "/etc/ticket-steward/slots/compose.yml";

let root: string;
let log: string;

beforeEach(async () => {
  root = await tmpDir();
  await mkdir(join(root, "bin"));
  await copyFile(resolve("test/ops/fakeDocker.sh"), join(root, "bin", "docker"));
  await chmod(join(root, "bin", "docker"), 0o755);
  log = join(root, "docker.log");
});

afterEach(async () => {
  await removeDir(root);
});

const slot = (args: string[], env: Record<string, string> = {}) =>
  execa("bash", [HELPER, ...args], {
    env: { PATH: `${join(root, "bin")}:${process.env.PATH ?? ""}`, FAKE_DOCKER_LOG: log, ...env },
    extendEnv: false,
    reject: false,
  });

const dockerCalls = async (): Promise<string[]> => (await readFile(log, "utf8").catch(() => "")).split("\n").filter((line) => line !== "");

describe("steward-slot", () => {
  it.each([
    { args: [] },
    { args: ["start", "1"] },
    { args: ["up"] },
    { args: ["up", "0"] },
    { args: ["up", "10"] },
    { args: ["up", "01"] },
    { args: ["up", "1;rm"] },
    { args: ["up", "1", "2"] },
    { args: ["down", "-1"] },
    { args: ["check", "1"] },
  ])("rejects $args with exit 2 and a usage line, without running docker", async ({ args }) => {
    const result = await slot(args);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("usage: steward-slot");
    expect(await dockerCalls()).toEqual([]);
  });

  it("prints the slot's ports as one JSON line, without running docker", async () => {
    expect((await slot(["ports", "1"])).stdout).toBe('{"postgres":15132,"redis":16179,"rabbitmq":15172}');
    expect((await slot(["ports", "9"])).stdout).toBe('{"postgres":15932,"redis":16979,"rabbitmq":15972}');
    expect(await dockerCalls()).toEqual([]);
  });

  it("brings project steward-slot-<n> up and waits, with the slot's ports exported", async () => {
    expect((await slot(["up", "2"])).exitCode).toBe(0);
    expect(await dockerCalls()).toEqual([`compose -p steward-slot-2 -f ${COMPOSE} up -d --wait --wait-timeout 120|15232|16279|15272`]);
  });

  it("brings the project down with its volumes and orphans", async () => {
    expect((await slot(["down", "3"])).exitCode).toBe(0);
    expect(await dockerCalls()).toEqual([`compose -p steward-slot-3 -f ${COMPOSE} down --volumes --remove-orphans --timeout 10|15332|16379|15372`]);
  });

  it("lists the project's running containers", async () => {
    expect((await slot(["status", "1"])).exitCode).toBe(0);
    expect(await dockerCalls()).toEqual(["ps --filter label=com.docker.compose.project=steward-slot-1 --format {{.Names}} {{.Status}}|15132|16179|15172"]);
  });

  it("check prints ok when the compose file parses and every image is present", async () => {
    const result = await slot(["check"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("ok");
    expect(await dockerCalls()).toEqual([
      `compose -f ${COMPOSE} config --quiet|15132|16179|15172`,
      `compose -f ${COMPOSE} config --images|15132|16179|15172`,
      "image inspect timescale/timescaledb-ha:pg17-ts2.27-all|15132|16179|15172",
      "image inspect redis:7-alpine|15132|16179|15172",
      "image inspect rabbitmq:4.2.0-management|15132|16179|15172",
    ]);
  });

  it("check names a missing image and exits 1", async () => {
    const result = await slot(["check"], { FAKE_DOCKER_MISSING: "redis:7-alpine" });
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("image redis:7-alpine is not pulled");
  });
});

describe("slot compose file and init script", () => {
  it("publishes every port on 127.0.0.1 only, keeps data on tmpfs, and pins the images and credentials", async () => {
    const compose = await readFile(resolve("ops/slots-compose.yml"), "utf8");
    expect(compose.split("\n").filter((line) => line.includes("${STEWARD_SLOT_")).map((line) => line.trim())).toEqual([
      '- "127.0.0.1:${STEWARD_SLOT_POSTGRES_PORT:?run through steward-slot}:5432"',
      '- "127.0.0.1:${STEWARD_SLOT_REDIS_PORT:?run through steward-slot}:6379"',
      '- "127.0.0.1:${STEWARD_SLOT_RABBITMQ_PORT:?run through steward-slot}:5672"',
    ]);
    for (const image of ["timescale/timescaledb-ha:pg17-ts2.27-all", "redis:7-alpine", "rabbitmq:4.2.0-management"]) expect(compose).toContain(`image: ${image}`);
    expect(compose.match(/pull_policy: missing/g)).toHaveLength(3);
    expect(compose.match(/tmpfs:/g)).toHaveLength(3);
    expect(compose.match(/healthcheck:/g)).toHaveLength(3);
    expect(compose).not.toMatch(/^volumes:/m);
    expect(compose).toContain("POSTGRES_USER: postgres");
    expect(compose).toContain("POSTGRES_PASSWORD: steward-slot");
    expect(compose).toContain("RABBITMQ_DEFAULT_USER: steward");
    expect(compose).toContain("RABBITMQ_DEFAULT_PASS: steward-slot");
    expect(compose).toContain('command: ["redis-server", "--save", "", "--appendonly", "no"]');
  });

  it("creates both databases and the timescaledb extension", async () => {
    expect(await readFile(resolve("ops/slots-init/01-databases.sql"), "utf8")).toBe(
      [
        "-- Databases for one worker slot; the Postgres entrypoint runs this once, on the slot's fresh data directory.",
        "CREATE DATABASE concentrate;",
        "CREATE DATABASE concentrate_tg;",
        "\\connect concentrate_tg",
        "CREATE EXTENSION IF NOT EXISTS timescaledb;",
        "",
      ].join("\n"),
    );
  });
});
```

- [ ] **Step 2: Run the helper tests to verify they fail**

Run: `npx vitest run test/ops/steward-slot.test.ts`
Expected: FAIL; bash reports `ops/steward-slot: No such file or directory` (exit 127), and the compose/SQL reads throw `ENOENT`.

- [ ] **Step 3: Write the helper, the compose file and the init script**

Create `ops/steward-slot` and run `chmod 0755 ops/steward-slot`:

```bash
#!/usr/bin/env bash
# steward-slot: throwaway Postgres+TimescaleDB, Redis and RabbitMQ containers for one Ticket Steward worker slot.
#
# Installed root-owned, mode 0755, at /usr/local/sbin/steward-slot. The steward user runs it, and nothing else as
# root, through /etc/sudoers.d/ticket-steward-slots:
#   steward ALL=(root) NOPASSWD: /usr/local/sbin/steward-slot
# It accepts only the commands below and a slot number 1-9, so the steward never passes arguments to Docker.
set -euo pipefail

readonly COMPOSE_FILE=/etc/ticket-steward/slots/compose.yml
# An empty root-owned config dir: under the steward unit's ProtectHome=yes, root's ~/.docker is unreadable.
export DOCKER_CONFIG=/etc/ticket-steward/slots/docker

usage() {
  echo "usage: steward-slot up|down|status|ports <1-9> | steward-slot check" >&2
  exit 2
}

# The only copy of the port formula; compose interpolates the exported variables.
export_ports() {
  export STEWARD_SLOT_POSTGRES_PORT=$((15032 + 100 * $1))
  export STEWARD_SLOT_REDIS_PORT=$((16079 + 100 * $1))
  export STEWARD_SLOT_RABBITMQ_PORT=$((15072 + 100 * $1))
}

compose() {
  docker compose -p "steward-slot-$1" -f "$COMPOSE_FILE" "${@:2}"
}

[[ $# -ge 1 ]] || usage
command="$1"

if [[ "$command" == "check" ]]; then
  [[ $# -eq 1 ]] || usage
  export_ports 1
  docker compose -f "$COMPOSE_FILE" config --quiet >/dev/null 2>&1 || { echo "compose file $COMPOSE_FILE does not parse"; exit 1; }
  images="$(docker compose -f "$COMPOSE_FILE" config --images)" || { echo "compose file $COMPOSE_FILE lists no images"; exit 1; }
  for image in $images; do
    docker image inspect "$image" >/dev/null 2>&1 || { echo "image $image is not pulled"; exit 1; }
  done
  echo ok
  exit 0
fi

[[ $# -eq 2 && "$2" =~ ^[1-9]$ ]] || usage
n="$2"
export_ports "$n"
case "$command" in
  up) compose "$n" up -d --wait --wait-timeout 120 ;;
  down) compose "$n" down --volumes --remove-orphans --timeout 10 ;;
  status) docker ps --filter "label=com.docker.compose.project=steward-slot-$n" --format '{{.Names}} {{.Status}}' ;;
  ports) printf '{"postgres":%d,"redis":%d,"rabbitmq":%d}\n' "$STEWARD_SLOT_POSTGRES_PORT" "$STEWARD_SLOT_REDIS_PORT" "$STEWARD_SLOT_RABBITMQ_PORT" ;;
  *) usage ;;
esac
```

Create `ops/slots-compose.yml`:

```yaml
# Throwaway services for one Ticket Steward worker slot (docs/ops.md, "Worker slots").
# Installed root-owned at /etc/ticket-steward/slots/compose.yml; only /usr/local/sbin/steward-slot uses it:
#   steward-slot up <n>  ->  docker compose -p steward-slot-<n> -f compose.yml up -d --wait
# The helper exports STEWARD_SLOT_*_PORT for slot n. Every port binds to 127.0.0.1, all data lives on tmpfs,
# and nothing outlives `down`. The credentials are throwaway, not secrets.
services:
  postgres:
    image: timescale/timescaledb-ha:pg17-ts2.27-all
    pull_policy: missing
    environment:
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: steward-slot
      # The -ha image keeps its data under /home/postgres/pgdata; initdb creates this subdirectory with the mode it needs.
      PGDATA: /home/postgres/pgdata/data
    ports:
      - "127.0.0.1:${STEWARD_SLOT_POSTGRES_PORT:?run through steward-slot}:5432"
    tmpfs:
      - /home/postgres/pgdata:mode=1777
    volumes:
      - /etc/ticket-steward/slots/init:/docker-entrypoint-initdb.d:ro
    healthcheck:
      # Answers on TCP only after the init script ran and the server restarted for real.
      test: ["CMD", "pg_isready", "-h", "127.0.0.1", "-U", "postgres", "-d", "concentrate_tg"]
      interval: 2s
      timeout: 3s
      retries: 60
  redis:
    image: redis:7-alpine
    pull_policy: missing
    command: ["redis-server", "--save", "", "--appendonly", "no"]
    ports:
      - "127.0.0.1:${STEWARD_SLOT_REDIS_PORT:?run through steward-slot}:6379"
    tmpfs:
      - /data
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 2s
      timeout: 3s
      retries: 30
  rabbitmq:
    image: rabbitmq:4.2.0-management
    pull_policy: missing
    environment:
      # guest only accepts loopback connections, and a Docker-mapped port is not loopback.
      RABBITMQ_DEFAULT_USER: steward
      RABBITMQ_DEFAULT_PASS: steward-slot
    ports:
      - "127.0.0.1:${STEWARD_SLOT_RABBITMQ_PORT:?run through steward-slot}:5672"
    tmpfs:
      - /var/lib/rabbitmq
    healthcheck:
      test: ["CMD", "rabbitmq-diagnostics", "-q", "check_port_connectivity"]
      interval: 5s
      timeout: 10s
      retries: 30
```

Create `ops/slots-init/01-databases.sql`:

```sql
-- Databases for one worker slot; the Postgres entrypoint runs this once, on the slot's fresh data directory.
CREATE DATABASE concentrate;
CREATE DATABASE concentrate_tg;
\connect concentrate_tg
CREATE EXTENSION IF NOT EXISTS timescaledb;
```

- [ ] **Step 4: Run the helper tests to verify they pass**

Run: `npx vitest run test/ops/steward-slot.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the slot client tests and the fake runner**

Create `test/fakes/fakeSlotRunner.ts`:

```ts
import type { HelperResult, SlotPorts, SlotRunner } from "../../src/workspace/slots.js";

/** The real helper's port formula, for fakes only; the steward itself never computes it. */
export const helperPorts = (n: number): SlotPorts => ({ postgres: 15032 + 100 * n, redis: 16079 + 100 * n, rabbitmq: 15072 + 100 * n });

export interface FakeSlotRunner {
  run: SlotRunner;
  /** Every helper invocation's arguments, in order. */
  calls: string[][];
  /** The timeout each invocation was given, in order. */
  timeouts: number[];
  /** Every later call of `command` answers `result`; fields left out mean success. */
  respond: (command: string, result: Partial<HelperResult>) => void;
  /** Every later call of `command` waits until its signal aborts, then answers canceled. */
  hang: (command: string) => void;
}

const success = (stdout = ""): HelperResult => ({ exitCode: 0, stdout, output: stdout, timedOut: false, canceled: false });

/** A helper that succeeds at everything: `ports` prints `portsFor(n)` as JSON and `check` prints ok. */
export const fakeSlotRunner = (portsFor: (n: number) => SlotPorts = helperPorts): FakeSlotRunner => {
  const calls: string[][] = [];
  const timeouts: number[] = [];
  const responses = new Map<string, Partial<HelperResult>>();
  const hanging = new Set<string>();
  const run: SlotRunner = async (args, opts) => {
    calls.push(args);
    timeouts.push(opts.timeoutMs);
    const [command = "", n = "0"] = args;
    if (hanging.has(command)) {
      await new Promise<void>((resolve) => {
        if (opts.signal?.aborted === true) resolve();
        opts.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      return { ...success(), exitCode: 1, canceled: true };
    }
    const response = responses.get(command);
    if (response !== undefined) return { ...success(), ...response };
    if (command === "ports") return success(`${JSON.stringify(portsFor(Number(n)))}\n`);
    return success(command === "check" ? "ok\n" : "");
  };
  return {
    run,
    calls,
    timeouts,
    respond: (command, result) => {
      responses.set(command, result);
    },
    hang: (command) => {
      hanging.add(command);
    },
  };
};
```

Create `test/workspace/slots.test.ts`:

```ts
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { renderSlotEnv, SlotClient, SlotError, sudoRunner } from "../../src/workspace/slots.js";
import { fakeSlotRunner } from "../fakes/fakeSlotRunner.js";
import { removeDir, tmpDir } from "./helpers.js";

const SETTINGS = { helper: "/usr/local/sbin/steward-slot", upTimeoutSeconds: 180 };

describe("SlotClient", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("parses the helper's ports JSON", async () => {
    const runner = fakeSlotRunner();
    expect(await new SlotClient(SETTINGS, runner.run).ports(2)).toEqual({ postgres: 15232, redis: 16279, rabbitmq: 15272 });
    expect(runner.calls).toEqual([["ports", "2"]]);
  });

  it("rejects ports output that is not the port JSON", async () => {
    const runner = fakeSlotRunner();
    runner.respond("ports", { stdout: "sudo: unable to resolve host\n", output: "sudo: unable to resolve host\n" });
    await expect(new SlotClient(SETTINGS, runner.run).ports(1)).rejects.toThrow("slot 1: ports printed no port JSON: sudo: unable to resolve host");
  });

  it("starts with down, then up under the configured timeout, then reads the ports", async () => {
    const runner = fakeSlotRunner();
    expect(await new SlotClient(SETTINGS, runner.run).start(1)).toEqual({ postgres: 15132, redis: 16179, rabbitmq: 15172 });
    expect(runner.calls).toEqual([["down", "1"], ["up", "1"], ["ports", "1"]]);
    expect(runner.timeouts).toEqual([60_000, 180_000, 60_000]);
  });

  it("maps a failed up to the slot and the last 4 KB of the helper's output", async () => {
    const runner = fakeSlotRunner();
    runner.respond("up", { exitCode: 1, output: `${"x".repeat(5000)}\nError response from daemon: port is already allocated\n` });
    const failure = new SlotClient(SETTINGS, runner.run).start(2);
    await expect(failure).rejects.toBeInstanceOf(SlotError);
    await expect(failure).rejects.toSatisfy(
      (err: SlotError) => err.n === 2 && Buffer.byteLength(err.tail) === 4096 && err.tail.endsWith("port is already allocated\n[exit 1]") && err.message === `slot 2: ${err.tail}`,
    );
  });

  it("reports a hung up as timed out", async () => {
    const runner = fakeSlotRunner();
    runner.respond("up", { exitCode: 1, timedOut: true, output: "Container steward-slot-1-rabbitmq-1  Waiting\n" });
    await expect(new SlotClient(SETTINGS, runner.run).start(1)).rejects.toThrow("slot 1: Container steward-slot-1-rabbitmq-1  Waiting\n[timed out after 180 s]");
  });

  it("does not run up when the leading down fails, and passes sudo's own words through", async () => {
    const runner = fakeSlotRunner();
    runner.respond("down", { exitCode: 1, output: "sudo: a password is required\n" });
    await expect(new SlotClient(SETTINGS, runner.run).start(1)).rejects.toThrow("slot 1: sudo: a password is required\n[exit 1]");
    expect(runner.calls).toEqual([["down", "1"]]);
  });

  it("passes the signal to up and reports a canceled up as interrupted", async () => {
    const runner = fakeSlotRunner();
    runner.hang("up");
    const controller = new AbortController();
    const starting = new SlotClient(SETTINGS, runner.run).start(1, controller.signal);
    await vi.waitFor(() => expect(runner.calls).toContainEqual(["up", "1"]));
    controller.abort();
    await expect(starting).rejects.toThrow("slot 1: [interrupted]");
  });

  it("release brings down only a slot this client started, and only once", async () => {
    const runner = fakeSlotRunner();
    const client = new SlotClient(SETTINGS, runner.run);
    await client.release(1);
    expect(runner.calls).toEqual([]);
    await client.start(1);
    await client.release(1);
    await client.release(1);
    expect(runner.calls).toEqual([["down", "1"], ["up", "1"], ["ports", "1"], ["down", "1"]]);
  });

  it("logs a failed down instead of throwing", async () => {
    const runner = fakeSlotRunner();
    const client = new SlotClient(SETTINGS, runner.run);
    await client.start(1);
    runner.respond("down", { exitCode: 1, output: "Cannot connect to the Docker daemon\n" });
    await expect(client.release(1)).resolves.toBeUndefined();
    expect(await client.down(2)).toBe(false);
  });

  it("status returns the running containers; check is ok only for exit 0 and the line ok", async () => {
    const runner = fakeSlotRunner();
    const client = new SlotClient(SETTINGS, runner.run);
    runner.respond("status", { stdout: "steward-slot-1-postgres-1 Up 2 minutes\n" });
    expect(await client.status(1)).toBe("steward-slot-1-postgres-1 Up 2 minutes");
    expect(await client.check()).toEqual({ ok: true, output: "ok" });
    runner.respond("check", { exitCode: 1, stdout: "image redis:7-alpine is not pulled\n", output: "image redis:7-alpine is not pulled\n" });
    expect(await client.check()).toEqual({ ok: false, output: "image redis:7-alpine is not pulled" });
  });
});

describe("renderSlotEnv", () => {
  it("renders every template, with or without spaces in the braces, and keeps null", () => {
    const slot = { n: 1, appPort: 4101, ports: { postgres: 15132, redis: 16179, rabbitmq: 15172 } };
    expect(
      renderSlotEnv(
        {
          DB_PORT: "{{postgres}}",
          TG_CONN_STR: "postgres://postgres:steward-slot@localhost:{{ postgres }}/concentrate_tg",
          REDIS_URL: "redis://localhost:{{redis}}",
          RABBITMQ_URL: "amqp://steward:steward-slot@localhost:{{rabbitmq}}",
          BASE_URL: "http://localhost:{{app}}",
          DB_HOST: "localhost",
          REDIS_CLUSTER_NODES: null,
        },
        slot,
      ),
    ).toEqual({
      DB_PORT: "15132",
      TG_CONN_STR: "postgres://postgres:steward-slot@localhost:15132/concentrate_tg",
      REDIS_URL: "redis://localhost:16179",
      RABBITMQ_URL: "amqp://steward:steward-slot@localhost:15172",
      BASE_URL: "http://localhost:4101",
      DB_HOST: "localhost",
      REDIS_CLUSTER_NODES: null,
    });
  });
});

describe("sudoRunner", () => {
  let root: string;

  beforeEach(async () => {
    root = await tmpDir();
    await mkdir(join(root, "bin"));
    // A sudo that insists on -n, then runs the rest as given.
    await writeFile(join(root, "bin", "sudo"), '#!/usr/bin/env bash\n[[ "$1" == "-n" ]] || exit 99\nshift\nexec "$@"\n');
    await chmod(join(root, "bin", "sudo"), 0o755);
    vi.stubEnv("PATH", `${join(root, "bin")}:${process.env.PATH ?? ""}`);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await removeDir(root);
  });

  const helper = async (body: string): Promise<string> => {
    const path = join(root, "helper");
    await writeFile(path, `#!/usr/bin/env bash\n${body}`);
    await chmod(path, 0o755);
    return path;
  };

  it("runs sudo -n <helper> <args> and keeps stdout apart from the interleaved output", async () => {
    const result = await sudoRunner(await helper('echo "out $*"\necho warn >&2\n'))(["ports", "1"], { timeoutMs: 5_000 });
    expect(result).toEqual({ exitCode: 0, stdout: "out ports 1", output: expect.stringContaining("warn"), timedOut: false, canceled: false });
    expect(result.output).toContain("out ports 1");
  });

  it("kills a helper that runs past the timeout and keeps what it printed", async () => {
    const result = await sudoRunner(await helper("echo starting\nexec sleep 5\n"))(["up", "1"], { timeoutMs: 200 });
    expect(result.timedOut).toBe(true);
    expect(result.output).toContain("starting");
  });

  it("stops the helper when the signal aborts", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    const result = await sudoRunner(await helper("exec sleep 5\n"))(["up", "1"], { timeoutMs: 5_000, signal: controller.signal });
    expect(result.canceled).toBe(true);
  });
});
```

- [ ] **Step 6: Run the slot client tests to verify they fail**

Run: `npx vitest run test/workspace/slots.test.ts`
Expected: FAIL with `Failed to load url ../../src/workspace/slots.js` (module does not exist).

- [ ] **Step 7: Implement the slot client**

In `src/workspace/setup.ts`, line 3, change `const keepTail = …` to `export const keepTail = …` (body unchanged).

Create `src/workspace/slots.ts`:

```ts
import { execa } from "execa";
import { z } from "zod";
import { isSlotTemplate, SLOT_TEMPLATE_PATTERN, type SlotsConfig, type SlotTemplate } from "../config/schema.js";
import { logger } from "../log.js";
import { keepTail } from "./setup.js";

export interface SlotPorts {
  postgres: number;
  redis: number;
  rabbitmq: number;
}

/** One job's slot: its number, its app port and the host ports of its fresh containers. */
export interface Slot {
  n: number;
  appPort: number;
  ports: SlotPorts;
}

export interface HelperResult {
  exitCode: number;
  /** stdout alone: `ports` prints JSON there, while sudo or compose may warn on stderr. */
  stdout: string;
  /** stdout and stderr interleaved, for error tails. */
  output: string;
  timedOut: boolean;
  canceled: boolean;
}

/** Runs the helper with `args`; never throws on a non-zero exit. */
export type SlotRunner = (args: string[], opts: { timeoutMs: number; signal?: AbortSignal }) => Promise<HelperResult>;

const HELPER_TAIL_BYTES = 4 * 1024;
const HELPER_TIMEOUT_MS = 60_000;
const SECOND_MS = 1_000;

const PortSchema = z.number().int().min(1).max(65_535);
const PortsSchema = z.object({ postgres: PortSchema, redis: PortSchema, rabbitmq: PortSchema });

/** A slot command failed; `tail` is the end of the helper's output, not yet redacted. */
export class SlotError extends Error {
  constructor(
    readonly n: number,
    readonly tail: string,
  ) {
    super(`slot ${n}: ${tail}`);
  }
}

/** `sudo -n <helper> …`: -n makes a missing sudoers rule fail at once instead of waiting for a password. */
export const sudoRunner =
  (helper: string): SlotRunner =>
  async (args, opts) => {
    const result = await execa("sudo", ["-n", helper, ...args], {
      env: { PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin" },
      extendEnv: false,
      all: true,
      reject: false,
      timeout: opts.timeoutMs,
      ...(opts.signal === undefined ? {} : { cancelSignal: opts.signal }),
    });
    // A spawn failure or a kill leaves no exit code; keep whatever the helper printed, else execa's reason.
    const all = result.all ?? "";
    const output = result.exitCode === undefined && all === "" ? (result.originalMessage ?? "sudo did not start") : all;
    return { exitCode: result.exitCode ?? 1, stdout: result.stdout, output, timedOut: result.timedOut, canceled: result.isCanceled };
  };

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

const failureTail = (result: HelperResult): string => {
  const output = result.output.trimEnd();
  const note = result.canceled ? "[interrupted]" : `[exit ${result.exitCode}]`;
  return keepTail(output === "" ? note : `${output}\n${note}`, HELPER_TAIL_BYTES);
};

/** Talks to the root slot helper; the only path from the steward to Docker. */
export class SlotClient {
  /** Slots this process brought up and has not released: only these need a `down` when their job ends. */
  private readonly started = new Set<number>();
  private readonly run: SlotRunner;

  constructor(
    private readonly settings: Pick<SlotsConfig, "helper" | "upTimeoutSeconds">,
    runner?: SlotRunner,
  ) {
    this.run = runner ?? sudoRunner(settings.helper);
  }

  /** The slot's host ports as the helper reports them; the helper holds the only copy of the formula. */
  async ports(n: number): Promise<SlotPorts> {
    const result = await this.run(["ports", String(n)], { timeoutMs: HELPER_TIMEOUT_MS });
    if (result.exitCode !== 0) throw new SlotError(n, failureTail(result));
    const parsed = PortsSchema.safeParse(parseJson(result.stdout.trim()));
    if (!parsed.success) throw new SlotError(n, `ports printed no port JSON: ${keepTail(result.stdout.trim(), HELPER_TAIL_BYTES)}`);
    return parsed.data;
  }

  /** Clears whatever an earlier run left, starts fresh containers and returns their ports. */
  async start(n: number, signal?: AbortSignal): Promise<SlotPorts> {
    const cancel = signal === undefined ? {} : { signal };
    const down = await this.run(["down", String(n)], { timeoutMs: HELPER_TIMEOUT_MS, ...cancel });
    if (down.exitCode !== 0 || down.canceled) throw new SlotError(n, failureTail(down));
    this.started.add(n);
    const up = await this.run(["up", String(n)], { timeoutMs: this.settings.upTimeoutSeconds * SECOND_MS, ...cancel });
    if (up.timedOut) throw new SlotError(n, keepTail(`${up.output.trimEnd()}\n[timed out after ${this.settings.upTimeoutSeconds} s]`, HELPER_TAIL_BYTES));
    if (up.exitCode !== 0 || up.canceled) throw new SlotError(n, failureTail(up));
    return this.ports(n);
  }

  /** Brings down a slot this process started; the job's outcome stands whatever happens here. */
  async release(n: number): Promise<void> {
    if (!this.started.delete(n)) return;
    await this.down(n);
  }

  /** `down` whoever started the slot (startup and shutdown); a failure is logged, never thrown. */
  async down(n: number): Promise<boolean> {
    const result = await this.run(["down", String(n)], { timeoutMs: HELPER_TIMEOUT_MS });
    if (result.exitCode === 0) return true;
    logger.warn({ slot: n, tail: failureTail(result) }, "slot down failed");
    return false;
  }

  /** The slot's running containers, one line each; empty when the slot is down. */
  async status(n: number): Promise<string> {
    const result = await this.run(["status", String(n)], { timeoutMs: HELPER_TIMEOUT_MS });
    if (result.exitCode !== 0) throw new SlotError(n, failureTail(result));
    return result.stdout.trim();
  }

  /** The helper's own check (compose file parses, images pulled); run through sudo, it also proves the sudoers rule. */
  async check(): Promise<{ ok: boolean; output: string }> {
    const result = await this.run(["check"], { timeoutMs: HELPER_TIMEOUT_MS });
    return { ok: result.exitCode === 0 && result.stdout.trim() === "ok", output: keepTail(result.output.trim(), HELPER_TAIL_BYTES) };
  }
}

/** A job's slot as the pipelines see it: its number and the client that brings it up and down. */
export interface SlotRef {
  n: number;
  client: SlotClient;
}

/** `slots.env` with every `{{template}}` replaced by this slot's value; null (delete the key) stays null. */
export const renderSlotEnv = (env: Record<string, string | null>, slot: Slot): Record<string, string | null> => {
  const values: Record<SlotTemplate, number> = { app: slot.appPort, ...slot.ports };
  return Object.fromEntries(
    Object.entries(env).map(([key, value]): [string, string | null] => [
      key,
      value === null ? null : value.replace(SLOT_TEMPLATE_PATTERN, (match: string, name: string) => (isSlotTemplate(name) ? String(values[name]) : match)),
    ]),
  );
};
```

- [ ] **Step 8: Run the tests and checks**

Run: `npx vitest run test/ops test/workspace/slots.test.ts test/workspace/setup.test.ts && npm run -s typecheck && npm run -s lint`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add ops/steward-slot ops/slots-compose.yml ops/slots-init/01-databases.sql src/workspace/slots.ts src/workspace/setup.ts test/ops test/fakes/fakeSlotRunner.ts test/workspace/slots.test.ts
git commit -m "feat(slots): steward-slot helper, slot compose file and the slot client

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Overlay overrides

**Files:**
- Modify: `src/workspace/overlay.ts:15-40`
- Test: `test/workspace/overlay.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces (from `src/workspace/overlay.ts`):
  - `copyOverlay(overlayDir: string, worktreePath: string, opts: { portRewrite?: { from: number; to: number }; overrides?: Record<string, string | null> }): Promise<{ copied: string[] }>`
  - `export class OverrideKeysError extends Error { readonly keys: string[] }` (message `slot override keys not found in the overlay: K1, K2`)
  - `export const missingOverrideKeys: (overlayDir: string, keys: string[]) => Promise<string[]>`

- [ ] **Step 1: Write the failing tests**

In `test/workspace/overlay.test.ts`, change the import from `../../src/workspace/index.js` to also import from overlay directly:

```ts
import { missingOverrideKeys, OverrideKeysError } from "../../src/workspace/overlay.js";
```

and add `existsSync` via `import { existsSync } from "node:fs";`. Append inside `describe("copyOverlay", …)` (it already has `root`, `worktreePath`, `overlayDir`):

```ts
  it("replaces values unquoted, keeps export and indentation, deletes null keys, leaves every other line", async () => {
    const original = [
      "# local services",
      "DB_HOST=10.2.0.11",
      'export DB_PORT = "5432"',
      "  DB_NAME='concentrate_remote'",
      "REDIS_CLUSTER_NODES=10.2.0.51:7000,10.2.0.51:7001",
      "OTHER=keep me",
      "",
    ].join("\n");
    await writeNested(overlayDir, "e2e/user/.env", original);

    await copyOverlay(overlayDir, worktreePath, { overrides: { DB_HOST: "localhost", DB_PORT: "15132", DB_NAME: "concentrate", REDIS_CLUSTER_NODES: null } });

    expect(await readFile(join(worktreePath, "e2e/user/.env"), "utf8")).toBe(
      ["# local services", "DB_HOST=localhost", "export DB_PORT=15132", "  DB_NAME=concentrate", "OTHER=keep me", ""].join("\n"),
    );
    expect(await readFile(join(overlayDir, "e2e/user/.env"), "utf8")).toBe(original);
  });

  it("applies to every file that defines the key, keeps CRLF and never adds a key", async () => {
    await writeNested(overlayDir, "service/Cron/.env", "TG_CONN_STR=postgres://cloud/tg\r\nX=1\r\n");
    await writeNested(overlayDir, "packages/tigerdb/.env", "TG_CONN_STR=postgres://cloud2/tg\n");
    await writeNested(overlayDir, "apps/web/.env", "Y=2\n");

    await copyOverlay(overlayDir, worktreePath, { overrides: { TG_CONN_STR: "postgres://postgres:steward-slot@localhost:15132/concentrate_tg" } });

    expect(await readFile(join(worktreePath, "service/Cron/.env"), "utf8")).toBe("TG_CONN_STR=postgres://postgres:steward-slot@localhost:15132/concentrate_tg\r\nX=1\r\n");
    expect(await readFile(join(worktreePath, "packages/tigerdb/.env"), "utf8")).toBe("TG_CONN_STR=postgres://postgres:steward-slot@localhost:15132/concentrate_tg\n");
    expect(await readFile(join(worktreePath, "apps/web/.env"), "utf8")).toBe("Y=2\n");
  });

  it("rewrites the port substring, then applies the overrides", async () => {
    await writeNested(overlayDir, "e2e/user/.env", "BASE_URL=http://localhost:3000\nCORS_ORIGIN=http://localhost:3000,https://app.example\nDB_PORT=5432\n");

    await copyOverlay(overlayDir, worktreePath, { portRewrite: { from: 3000, to: 4102 }, overrides: { DB_PORT: "15232" } });

    expect(await readFile(join(worktreePath, "e2e/user/.env"), "utf8")).toBe("BASE_URL=http://localhost:4102\nCORS_ORIGIN=http://localhost:4102,https://app.example\nDB_PORT=15232\n");
  });

  it("fails naming the missing keys, never their values, and writes nothing", async () => {
    await writeNested(overlayDir, "e2e/user/.env", "DB_HOST=10.2.0.11\n");

    const copying = copyOverlay(overlayDir, worktreePath, { overrides: { DB_HOST: "localhost", NOPE: "secret-value-1", ALSO_NOPE: null } });

    await expect(copying).rejects.toBeInstanceOf(OverrideKeysError);
    await expect(copying).rejects.toThrow(/^slot override keys not found in the overlay: NOPE, ALSO_NOPE$/);
    expect(existsSync(join(worktreePath, "e2e/user/.env"))).toBe(false);
  });

  it("missingOverrideKeys lists the keys no overlay file defines", async () => {
    await writeNested(overlayDir, "a/.env", "export DB_HOST=x\n");
    await writeNested(overlayDir, "b/.env", "REDIS_URL = y\n");

    expect(await missingOverrideKeys(overlayDir, ["DB_HOST", "REDIS_URL", "RABBITMQ_URL"])).toEqual(["RABBITMQ_URL"]);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/workspace/overlay.test.ts`
Expected: FAIL; the override tests get verbatim copies (the `overrides` option is ignored), `toBeInstanceOf(OverrideKeysError)` throws because the import is `undefined`, and `missingOverrideKeys is not a function`.

- [ ] **Step 3: Implement the overrides**

In `src/workspace/overlay.ts`, after `rewritePorts`, add:

```ts
/** A `KEY=value` line, optionally `export `-prefixed and indented, with whitespace allowed before `=`. */
const ENV_LINE = /^(\s*)(export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/;

/** Slot overrides named keys no overlay file defines: a config problem, so the job fails without a retry. */
export class OverrideKeysError extends Error {
  constructor(readonly keys: string[]) {
    super(`slot override keys not found in the overlay: ${keys.join(", ")}`);
  }
}

const envKeys = (content: string): string[] =>
  content.split("\n").flatMap((line) => {
    const key = ENV_LINE.exec(line)?.[3];
    return key === undefined ? [] : [key];
  });

/** Rewrites the lines whose key `overrides` names: a string replaces the value (unquoted), null removes the line; every other line stays. */
const applyOverrides = (content: string, overrides: Record<string, string | null>): string =>
  content
    .split("\n")
    .flatMap((line) => {
      const match = ENV_LINE.exec(line);
      const key = match?.[3];
      if (match === null || key === undefined || !Object.hasOwn(overrides, key)) return [line];
      const value = overrides[key];
      if (value === undefined) return [line];
      if (value === null) return [];
      const eol = line.endsWith("\r") ? "\r" : "";
      return [`${match[1] ?? ""}${match[2] === undefined ? "" : "export "}${key}=${value}${eol}`];
    })
    .join("\n");
```

Replace `copyOverlay` with:

```ts
export const copyOverlay = async (
  overlayDir: string,
  worktreePath: string,
  opts: { portRewrite?: { from: number; to: number }; overrides?: Record<string, string | null> },
): Promise<{ copied: string[] }> => {
  const files = await listFiles(overlayDir);
  for (const file of files) {
    if (await isTracked(worktreePath, file)) {
      throw new Error(`overlay refuses to overwrite tracked path ${file}`);
    }
  }
  const overrides = opts.overrides ?? {};
  const defined = new Set<string>();
  const rewritten: Array<{ file: string; content: string }> = [];
  for (const file of files) {
    const content = await readFile(join(overlayDir, file), "utf8");
    for (const key of envKeys(content)) defined.add(key);
    const ported = opts.portRewrite === undefined ? content : rewritePorts(content, opts.portRewrite);
    rewritten.push({ file, content: applyOverrides(ported, overrides) });
  }
  // Checked before anything is written: a bad key must not leave the worktree half-overridden.
  const missing = Object.keys(overrides).filter((key) => !defined.has(key));
  if (missing.length > 0) throw new OverrideKeysError(missing);
  for (const { file, content } of rewritten) await writePrivate(join(worktreePath, file), content);
  return { copied: files };
};

/** The `slots.env` keys no overlay file defines; doctor reports them before a job fails on them. */
export const missingOverrideKeys = async (overlayDir: string, keys: string[]): Promise<string[]> => {
  const defined = new Set<string>();
  for (const file of await listFiles(overlayDir)) {
    for (const key of envKeys(await readFile(join(overlayDir, file), "utf8"))) defined.add(key);
  }
  return keys.filter((key) => !defined.has(key));
};
```

- [ ] **Step 4: Run the tests and checks**

Run: `npx vitest run test/workspace/overlay.test.ts test/cli/overlay.test.ts && npm run -s typecheck && npm run -s lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/workspace/overlay.ts test/workspace/overlay.test.ts
git commit -m "feat(overlay): slot overrides replace or delete keys in the job's copy

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Mirror mutex

**Files:**
- Create: `src/workspace/mutex.ts`
- Modify: `src/workspace/mirror.ts:1-59`, `src/workspace/worktree.ts:14-34`
- Test: `test/workspace/mutex.test.ts` (create), `test/workspace/mirror.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `src/workspace/mutex.ts`: `export class Mutex { run<T>(fn: () => Promise<T>): Promise<T> }`
  - `Mirror.exclusive<T>(fn: () => Promise<T>): Promise<T>` (one lock per resolved mirror path per process)
  - `Mirror.fetch()` / `Mirror.fetchRef(ref)` and `createWorktree` / `Worktree.destroy()` serialize through it (signatures unchanged).

- [ ] **Step 1: Write the failing tests**

Create `test/workspace/mutex.test.ts`:

```ts
import { Mutex } from "../../src/workspace/mutex.js";

describe("Mutex", () => {
  it("runs sections one at a time in call order, and a failure does not block the next", async () => {
    const mutex = new Mutex();
    const events: string[] = [];
    let release: () => void = () => undefined;
    const first = mutex.run(async () => {
      events.push("first start");
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      events.push("first end");
    });
    const second = mutex.run(async () => {
      events.push("second");
      throw new Error("Intended Test Error");
    });
    const third = mutex.run(async () => {
      events.push("third");
      return 3;
    });

    await vi.waitFor(() => expect(events).toEqual(["first start"]));
    release();
    await first;
    await expect(second).rejects.toThrow("Intended Test Error");
    expect(await third).toBe(3);
    expect(events).toEqual(["first start", "first end", "second", "third"]);
  });
});
```

In `test/workspace/mirror.test.ts` add `import { existsSync } from "node:fs";` and append inside `describe("Mirror", …)`:

```ts
  it("runs fetch, fetchRef and worktree add under the mirror's exclusive section", async () => {
    const { repo, sha } = await makeSourceRepo(root);
    const mirror = await Mirror.init(join(root, "repo.git"), repo);
    const exclusive = vi.spyOn(mirror, "exclusive");

    await mirror.fetch();
    await mirror.fetchRef("refs/heads/main");
    const worktree = await createWorktree(mirror, join(root, "work"), "1-1", sha);
    await worktree.destroy();

    expect(exclusive).toHaveBeenCalledTimes(4);
  });

  it("serializes concurrent fetches from two Mirror objects on one path so both succeed", async () => {
    const { repo } = await makeSourceRepo(root);
    const mirror = await Mirror.init(join(root, "repo.git"), repo);
    const other = new Mirror(join(root, "repo.git"), repo);
    const next = await commitFile(repo, "second.txt", "two\n");

    await Promise.all([mirror.fetch(), other.fetch(), mirror.fetchRef("refs/heads/main")]);

    expect(await mirror.resolveSha("main")).toBe(next);
  });

  it("adds and removes worktrees concurrently without git lock errors", async () => {
    const { repo, sha } = await makeSourceRepo(root);
    const mirror = await Mirror.init(join(root, "repo.git"), repo);
    const work = join(root, "work");
    const first = await createWorktree(mirror, work, "1-1", sha);

    const [second, third] = await Promise.all([createWorktree(mirror, work, "2-1", sha), createWorktree(mirror, work, "3-1", sha), first.destroy()]);

    expect(existsSync(first.path)).toBe(false);
    const listed = await git(mirror.path, ["worktree", "list", "--porcelain"]);
    expect(listed).toContain(second.path);
    expect(listed).toContain(third.path);
    expect(listed).not.toContain(first.path);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/workspace/mutex.test.ts test/workspace/mirror.test.ts`
Expected: FAIL; `mutex.js` does not exist, and `vi.spyOn(mirror, "exclusive")` throws `exclusive does not exist`.

- [ ] **Step 3: Implement the mutex and use it**

Create `src/workspace/mutex.ts`:

```ts
/** A promise-chain mutex: `run` sections start one at a time, in call order, within this process. */
export class Mutex {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(() => fn());
    this.tail = result.catch(() => undefined);
    return result;
  }
}
```

In `src/workspace/mirror.ts` change `import { join } from "node:path";` to `import { join, resolve } from "node:path";`, add `import { Mutex } from "./mutex.js";`, and before `export class Mirror` add:

```ts
/** One lock per mirror path for the whole process, shared by every Mirror object on that path. */
const locks = new Map<string, Mutex>();
```

Replace `fetch` and `fetchRef`, and add `exclusive`, inside the class:

```ts
  /** Runs `fn` while no other fetch or worktree add/remove on this mirror runs in this process; git's lock files would fail one of two. */
  exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const key = resolve(this.path);
    const lock = locks.get(key) ?? new Mutex();
    locks.set(key, lock);
    return lock.run(fn);
  }

  async fetch(): Promise<void> {
    if (!this.exists()) throw new Error(`mirror ${this.path} does not exist; run steward mirror init`);
    await this.exclusive(async () => {
      await gitOrThrow(["remote", "set-url", "origin", this.remote.url], this.path);
      await gitOrThrow(["fetch", "--quiet", "--prune", "origin"], this.path, this.remote.env);
    });
  }

  /** Fetches one ref under its own name, e.g. refs/merge-requests/7/head; a fork's MR head exists only there. */
  async fetchRef(ref: string): Promise<void> {
    await this.exclusive(() => gitOrThrow(["fetch", "--quiet", "origin", `+${ref}:${ref}`], this.path, this.remote.env));
  }
```

In `src/workspace/worktree.ts` replace everything from `const removeWorktree` to the end with:

```ts
/** Removes a worktree and prunes its record; the caller holds the mirror's lock. */
const removeWorktree = async (mirror: Mirror, path: string): Promise<void> => {
  const removed = await git(["worktree", "remove", "--force", path], mirror.path);
  if (removed.exitCode !== 0 || existsSync(path)) {
    await rm(path, { recursive: true, force: true });
  }
  await git(["worktree", "prune"], mirror.path);
};

export const createWorktree = async (mirror: Mirror, workRoot: string, name: string, sha: string): Promise<Worktree> => {
  const path = join(workRoot, name);
  await mkdir(workRoot, { recursive: true, mode: 0o700 });
  // prune, remove and add all write the mirror's worktree records: under its lock, so parallel jobs never collide.
  await mirror.exclusive(async () => {
    await gitOrThrow(["worktree", "prune"], mirror.path);
    if (existsSync(path)) await removeWorktree(mirror, path);
    await gitOrThrow(["worktree", "add", "--quiet", "--detach", path, sha], mirror.path);
  });
  // The mirror is bare; without this override git refuses work-tree commands (add, commit) inside the worktree.
  await gitOrThrow(["config", "--worktree", "core.bare", "false"], path);
  await gitOrThrow(["config", "--worktree", "remote.origin.pushurl", "/dev/null"], path);
  return { path, sha, destroy: () => mirror.exclusive(() => removeWorktree(mirror, path)) };
};
```

- [ ] **Step 4: Run the tests and checks**

Run: `npx vitest run test/workspace && npm run -s typecheck && npm run -s lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/workspace/mutex.ts src/workspace/mirror.ts src/workspace/worktree.ts test/workspace/mutex.test.ts test/workspace/mirror.test.ts
git commit -m "fix(mirror): serialize fetches and worktree add/remove in-process

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Store: claim around running tickets, requeue one interrupted job

**Files:**
- Modify: `src/store/jobs.ts:152-345`
- Test: `test/store/jobs.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `JobStore.claimNext(): Job | null` (same signature; now skips a queued job when an issue-kind job for the same `issue_id`, or a job with the same non-null `subject`, is `running`)
  - `JobStore.requeueInterruptedJob(id: number, maxAttempts: number): void` (closes that job's open attempt as interrupted; requeues it under the limit, fails it otherwise; touches no other job)

- [ ] **Step 1: Write the failing tests**

Append to `test/store/jobs.test.ts`:

```ts
describe("claimNext with running jobs", () => {
  const implementIssue1: TriggerEvent = {
    kind: "issue.labeled",
    action: "implement",
    issueId: "issue-1",
    identifier: "API-1",
    teamKey: "API",
    deliveryId: "delivery-3",
    description: "A bug report",
    stateType: null,
  };

  it("skips a job whose ticket has a running job, takes the next one, and takes the skipped one once the ticket is free", () => {
    const enrich = stores.jobs.enqueue(createdEvent);
    expect(stores.jobs.claimNext()?.id).toBe(enrich);
    const implement = stores.jobs.enqueue(implementIssue1);
    const other = stores.jobs.enqueue(secondEvent);

    expect(stores.jobs.claimNext()?.id).toBe(other);
    expect(stores.jobs.claimNext()).toBeNull();

    stores.jobs.finish(enrich, { status: "succeeded" });
    expect(stores.jobs.claimNext()?.id).toBe(implement);
  });

  it("skips a review whose merge request has a running review, but not an issue job of the same key", () => {
    const first = stores.jobs.enqueue(review("a".repeat(40)));
    expect(stores.jobs.claimNext()?.id).toBe(first);
    const second = stores.jobs.enqueue(review("b".repeat(40)));
    const issueJob = stores.jobs.enqueue({ kind: "cli", issueId: "API-1", identifier: "API-1", teamKey: "API" });

    expect(stores.jobs.claimNext()?.id).toBe(issueJob);
    expect(stores.jobs.claimNext()).toBeNull();

    stores.jobs.finish(first, { status: "succeeded" });
    expect(stores.jobs.claimNext()?.id).toBe(second);
  });

  it("requeueInterruptedJob requeues only that job and closes only its attempt", () => {
    const interrupted = stores.jobs.enqueue(createdEvent);
    const running = stores.jobs.enqueue(secondEvent);
    stores.jobs.claimNext();
    stores.attempts.start(interrupted);
    stores.jobs.claimNext();
    stores.attempts.start(running);

    stores.jobs.requeueInterruptedJob(interrupted, 3);

    expect(stores.jobs.get(interrupted)?.status).toBe("queued");
    expect(stores.attempts.forJob(interrupted)[0]?.error).toBe(INTERRUPTED_ERROR);
    expect(stores.attempts.forJob(interrupted)[0]?.finishedAt).toEqual(expect.any(String));
    expect(stores.jobs.get(running)?.status).toBe("running");
    expect(stores.attempts.forJob(running)[0]?.finishedAt).toBeNull();
  });

  it("requeueInterruptedJob fails a job that has used its last attempt", () => {
    const id = stores.jobs.enqueue(createdEvent);
    stores.jobs.claimById(id);
    stores.jobs.finish(id, { status: "publish_failed", error: "e" });
    stores.jobs.claimById(id);
    stores.jobs.finish(id, { status: "publish_failed", error: "e" });
    stores.jobs.claimById(id);

    stores.jobs.requeueInterruptedJob(id, 3);

    expect(stores.jobs.get(id)?.status).toBe("failed");
    expect(stores.jobs.get(id)?.error).toBe(INTERRUPTED_ERROR);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/store/jobs.test.ts`
Expected: FAIL; the first test claims `implement` instead of `other`, and `requeueInterruptedJob is not a function`.

- [ ] **Step 3: Implement**

In `src/store/jobs.ts` add three fields to the class field list (after `closeRunningAttempts`):

```ts
  private readonly requeueOneRunning;
  private readonly failOneRunning;
  private readonly closeJobAttempts;
```

Replace the `this.claimOldest = …` statement with:

```ts
    // The oldest due job whose ticket (enrich, implement: same issue_id) or merge request (review: same subject) has no
    // running job. One statement, and better-sqlite3 is synchronous, so two loops can never claim the same job.
    this.claimOldest = db.prepare<[string, string], JobRow>(
      `${CLAIM} WHERE id = (
         SELECT q.id FROM jobs q
         WHERE q.status = 'queued' AND (q.not_before IS NULL OR q.not_before <= ?)
           AND NOT EXISTS (
             SELECT 1 FROM jobs r WHERE r.status = 'running' AND (
               (q.kind <> 'review' AND r.kind <> 'review' AND r.issue_id = q.issue_id)
               OR (q.subject IS NOT NULL AND r.subject = q.subject)))
         ORDER BY q.id LIMIT 1)
       RETURNING *`,
    );
```

At the end of the constructor add:

```ts
    this.requeueOneRunning = db.prepare<[number, number]>(
      "UPDATE jobs SET status = 'queued' WHERE id = ? AND status = 'running' AND attempts < ?",
    );
    this.failOneRunning = db.prepare<[string, number]>(
      "UPDATE jobs SET status = 'failed', error = 'interrupted', finished_at = ? WHERE id = ? AND status = 'running'",
    );
    this.closeJobAttempts = db.prepare<[string, number]>(
      "UPDATE attempts SET finished_at = ?, error = 'interrupted' WHERE finished_at IS NULL AND job_id = ?",
    );
```

After `requeueInterrupted` add:

```ts
  /** `requeueInterrupted` for one job: other loops' running jobs and their attempts stay as they are. */
  requeueInterruptedJob(id: number, maxAttempts: number): void {
    this.db.transaction(() => {
      const now = nowIso();
      this.closeJobAttempts.run(now, id);
      this.requeueOneRunning.run(id, maxAttempts);
      this.failOneRunning.run(now, id);
    })();
  }
```

- [ ] **Step 4: Run the tests and checks**

Run: `npx vitest run test/store test/worker test/server && npm run -s typecheck && npm run -s lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/store/jobs.ts test/store/jobs.test.ts
git commit -m "feat(store): claim skips a ticket or MR with a running job; requeue one interrupted job

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Brain policy denies sudo and docker

**Files:**
- Modify: `src/brain/policy.ts:10-19`
- Test: `test/brain/policy.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `evaluateTool` denies shell commands invoking `sudo`, `docker` or `docker-compose` (Bash, `run_shell`, `start_process`) with reason `command matches denied pattern …`.

- [ ] **Step 1: Write the failing tests**

Append inside `describe("evaluateTool", …)` in `test/brain/policy.test.ts`:

```ts
  it.each([
    { name: "Bash", input: { command: "sudo -n /usr/local/sbin/steward-slot down 2" } },
    { name: "Bash", input: { command: "pnpm test && sudo true" } },
    { name: "Bash", input: { command: "echo $(sudo id)" } },
    { name: "Bash", input: { command: "/usr/bin/sudo -n /usr/local/sbin/steward-slot up 1" } },
    { name: "Bash", input: { command: "docker ps" } },
    { name: "Bash", input: { command: "docker compose -p steward-slot-2 down" } },
    { name: "Bash", input: { command: "docker-compose up -d" } },
    { name: "run_shell", input: { command: "sudo -n /usr/local/sbin/steward-slot down 1" } },
    { name: "run_shell", input: { command: "docker compose ls" } },
    { name: "start_process", input: { name: "x", command: "docker", args: ["compose", "up"] } },
    { name: "start_process", input: { name: "x", command: "sudo", args: ["-n", "/usr/local/sbin/steward-slot", "down", "2"] } },
  ])("denies $name $input.command", ({ name, input }) => {
    expect(evaluate(name, input)).toEqual({ allow: false, reason: expect.stringMatching(/^command matches denied pattern /) });
  });

  it.each(["pnpm --filter user-app exec next dev", "cat docker/Dockerfile", "grep -rn pseudo src", "ls dockerfiles"])("still allows %s", (command) => {
    expect(evaluate("Bash", { command })).toEqual({ allow: true });
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/brain/policy.test.ts`
Expected: FAIL; the `sudo`/`docker` cases return `{ allow: true }`.

- [ ] **Step 3: Implement**

In `src/brain/policy.ts` append to `DENIED_COMMANDS` (after the Linear curl entry):

```ts
  // Containers are the steward's job, through its root helper; never the agent's. A path prefix (/usr/bin/sudo) counts too.
  /(^|[\s;&|(`/])sudo(\s|$)/,
  /(^|[\s;&|(`/])docker(-compose)?(\s|$)/,
```

- [ ] **Step 4: Run the tests and checks**

Run: `npx vitest run test/brain && npm run -s typecheck && npm run -s lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/brain/policy.ts test/brain/policy.test.ts
git commit -m "feat(policy): deny sudo and docker commands

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Jobs run on a slot

**Files:**
- Modify: `src/core/deps.ts`, `src/core/workspace.ts:1-143`, `src/core/pipeline.ts:19,82,151-161`, `src/review/pipeline.ts:10,77,103,110-112`, `src/implement/pipeline.ts:6,12,140,155,162-164,191`
- Test: `test/core/pipeline.test.ts`, `test/review/pipeline.test.ts`, `test/implement/pipeline.test.ts`

**Interfaces:**
- Consumes: `appPortOf`, `SlotsConfig` (Task 1); `SlotClient`, `SlotError`, `SlotRef`, `Slot`, `renderSlotEnv` (Task 2); `copyOverlay` `overrides`, `OverrideKeysError` (Task 3); `fakeSlotRunner` (Task 2 test fake).
- Produces:
  - `PipelineDeps.slot?: SlotRef`
  - `src/core/workspace.ts`: `export const jobPort: (deps: Pick<PipelineDeps, "config" | "slot">) => number`; `export const prepareFailed: (deps: PipelineDeps, err: unknown) => JobOutcome`; `prepareWorkspace` (same signature) starts the slot when `config.slots` is set; `cleanupWorkspace` (same signature) releases it.

- [ ] **Step 1: Write the failing tests**

In `test/core/pipeline.test.ts` add imports:

```ts
import { SlotClient } from "../../src/workspace/slots.js";
import { fakeSlotRunner, type FakeSlotRunner } from "../fakes/fakeSlotRunner.js";
```

and append at the end of the file:

```ts
describe("runJob on a slot", () => {
  const OVERLAY_ENV = "DB_PORT=5432\nREDIS_CLUSTER_NODES=10.2.0.51:7000\nBASE_URL=http://localhost:3000\n";
  let appPortBase: number;
  let runner: FakeSlotRunner;

  beforeEach(async () => {
    vi.restoreAllMocks();
    repo = await tmpRepo(PROMPT_TEMPLATE);
    stores = openStores(repo.dataDir);
    tracker = new FakeTracker([issue]);
    port = await freeTcpPort();
    // Slot 2's app port is appPortBase + 2: a port nothing listens on, so freePort never kills anything.
    appPortBase = (await freeTcpPort()) - 2;
    runner = fakeSlotRunner();
    await mkdir(join(repo.overlayDir, "e2e", "user"), { recursive: true });
    await writeFile(join(repo.overlayDir, "e2e", "user", ".env"), OVERLAY_ENV);
  });

  afterEach(async () => {
    stores.db.close();
    await repo.cleanup();
  });

  const slotsFor = (env: Record<string, string | null>) => ({ count: 2, helper: "/usr/local/sbin/steward-slot", appPortBase, upTimeoutSeconds: 180, env });

  const slotConfig = (env: Record<string, string | null>): StewardConfig => ({
    ...makeConfig({ port: undefined, portRewrite: { from: 3000 } }),
    slots: slotsFor(env),
  });

  const slotDeps = (brain: FakeBrain, env: Record<string, string | null>, options: { afterBrain?: () => Promise<void>; signal?: AbortSignal } = {}): PipelineDeps => ({
    ...makeDeps(brain, { config: slotConfig(env), ...options }),
    slot: { n: 2, client: new SlotClient(slotsFor(env), runner.run) },
  });

  it("brings the slot up fresh, points the job's overlay copy at it and brings it down afterwards", async () => {
    const ctx = claimJob(createdTrigger);
    const brain = brainWith();
    let copied = "";
    const deps = slotDeps(brain, { DB_PORT: "{{postgres}}", REDIS_CLUSTER_NODES: null }, {
      afterBrain: async () => {
        copied = await readFile(join(repo.dataDir, "work", `${ctx.jobId}-1`, "e2e", "user", ".env"), "utf8");
      },
    });

    expect(await runJob(ctx, deps)).toEqual({ status: "succeeded" });

    expect(runner.calls).toEqual([["down", "2"], ["up", "2"], ["ports", "2"], ["down", "2"]]);
    expect(copied).toBe(`DB_PORT=15232\nBASE_URL=http://localhost:${appPortBase + 2}\n`);
    expect(brain.lastInput().env.STEWARD_PORT).toBe(String(appPortBase + 2));
    expect(await readFile(join(repo.overlayDir, "e2e", "user", ".env"), "utf8")).toBe(OVERLAY_ENV);
  });

  it("fails retryably with the helper's tail when the slot does not come up, and still brings it down", async () => {
    const ctx = claimJob(createdTrigger);
    runner.respond("up", { exitCode: 1, output: "Error response from daemon: port is already allocated\n" });

    const outcome = await runJob(ctx, slotDeps(brainWith(), {}));

    expect(outcome).toEqual({ status: "failed", error: "setup failed: slot 2: Error response from daemon: port is already allocated\n[exit 1]", retryable: true });
    expect(stores.attempts.forJob(ctx.jobId)[0]?.setupTail).toBe("Error response from daemon: port is already allocated\n[exit 1]");
    expect(runner.calls).toEqual([["down", "2"], ["up", "2"], ["down", "2"]]);
  });

  it("fails without a retry when an override key is in no overlay file, naming only the key", async () => {
    const ctx = claimJob(createdTrigger);

    const outcome = await runJob(ctx, slotDeps(brainWith(), { DB_PORT: "{{postgres}}", MISSING_KEY: "hunter2-value" }));

    expect(outcome).toEqual({ status: "failed", error: "slot override keys not found in the overlay: MISSING_KEY", retryable: false });
    expect(runner.calls.at(-1)).toEqual(["down", "2"]);
  });

  it("reports an interrupted run when shutdown aborts a slot that is still coming up", async () => {
    const ctx = claimJob(createdTrigger);
    runner.hang("up");
    const controller = new AbortController();

    const running = runJob(ctx, slotDeps(brainWith(), {}, { signal: controller.signal }));
    await vi.waitFor(() => expect(runner.calls).toContainEqual(["up", "2"]));
    controller.abort();

    expect(await running).toEqual({ status: "failed", error: INTERRUPTED_ERROR, retryable: true });
    expect(runner.calls.at(-1)).toEqual(["down", "2"]);
  });

  it("refuses to run without a slot when slots is configured", async () => {
    const ctx = claimJob(createdTrigger);

    const outcome = await runJob(ctx, makeDeps(brainWith(), { config: slotConfig({}) }));

    expect(outcome).toEqual({ status: "failed", error: "slots is configured but this run has no slot", retryable: true });
    expect(runner.calls).toEqual([]);
  });
});
```

In `test/review/pipeline.test.ts` add the same two imports (`SlotClient`, `fakeSlotRunner`) and append inside `describe("runReview", …)`:

```ts
  it("reviews on the job's slot and brings the slot down afterwards", async () => {
    tracker.addIssue(issue(["Feature"]));
    const appPortBase = (await freeTcpPort()) - 1;
    const runner = fakeSlotRunner();
    const slots = { count: 1, helper: "/usr/local/sbin/steward-slot", appPortBase, upTimeoutSeconds: 180, env: {} };
    const base = makeConfig();
    const brain = new FakeBrain({ result: reviewResult });
    const deps: PipelineDeps = {
      ...makeDeps(brain),
      config: { ...base, workspace: { ...base.workspace, port: undefined }, slots },
      slot: { n: 1, client: new SlotClient(slots, runner.run) },
    };

    expect((await runReview(claim(), deps)).status).toBe("succeeded");
    expect(brain.lastInput().env.STEWARD_PORT).toBe(String(appPortBase + 1));
    expect(runner.calls).toEqual([["down", "1"], ["up", "1"], ["ports", "1"], ["down", "1"]]);
  });
```

In `test/implement/pipeline.test.ts` add the two imports and append inside `describe("runImplement", …)`:

```ts
  it("runs the brain and the steward's checks against the slot's app port", async () => {
    const appPortBase = (await freeTcpPort()) - 1;
    const runner = fakeSlotRunner();
    const slots = { count: 1, helper: "/usr/local/sbin/steward-slot", appPortBase, upTimeoutSeconds: 180, env: {} };
    const base = makeConfig({ checks: [`test "$STEWARD_PORT" = "${appPortBase + 1}"`] });
    const brain = editingBrain(implemented);
    const ctx = claim();

    const outcome = await runImplement(ctx, {
      ...makeDeps(brain.runBrain, { ...base, workspace: { ...base.workspace, port: undefined }, slots }),
      slot: { n: 1, client: new SlotClient(slots, runner.run) },
    });

    expect(outcome).toEqual({ status: "succeeded" });
    expect(stores.jobs.get(ctx.jobId)?.pushedAt).not.toBeNull();
    expect(brain.calls[0]?.env.STEWARD_PORT).toBe(String(appPortBase + 1));
    expect(runner.calls).toEqual([["down", "1"], ["up", "1"], ["ports", "1"], ["down", "1"]]);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/core/pipeline.test.ts test/review/pipeline.test.ts test/implement/pipeline.test.ts`
Expected: FAIL on behaviour (vitest strips types, so the unknown `slot` field is simply ignored): `runner.calls` is `[]` because no slot is started, `STEWARD_PORT` is `String(appPortBase + 1)` instead of `+ 2`, the override test succeeds instead of failing, and the no-slot test succeeds. `npm run -s typecheck` also fails: `slot` does not exist on `PipelineDeps`.

- [ ] **Step 3: Add the slot to the pipeline deps**

In `src/core/deps.ts` add `import type { SlotRef } from "../workspace/slots.js";` and, after `signal?: AbortSignal;`:

```ts
  /** With `slots` configured: the job's slot (each worker loop's own, or slot 1 for inline CLI runs). */
  slot?: SlotRef;
```

- [ ] **Step 4: Start and release the slot in the workspace**

In `src/core/workspace.ts` replace the imports of `../config/schema.js`, `../workspace/overlay.js` and add the slot ones so the import block reads (other imports unchanged):

```ts
import { INTERRUPTED_ERROR, type BrainInput, type BrainOutput, type McpServerSpec } from "../brain/types.js";
import { codehostMcpSpec } from "../codehost/server.js";
import { appPortOf } from "../config/schema.js";
import { logger } from "../log.js";
import { DB_FILENAME } from "../store/db.js";
import type { AttemptPatch } from "../store/index.js";
import { copyOverlay, OverrideKeysError } from "../workspace/overlay.js";
import { freePort, isPortFree } from "../workspace/retention.js";
import { runSetup } from "../workspace/setup.js";
import { copySkills } from "../workspace/skills.js";
import { renderSlotEnv, SlotError, type Slot } from "../workspace/slots.js";
import { createWorktree, type Worktree } from "../workspace/worktree.js";
```

After `redactOutcome` add:

```ts
/** The job's app port: its slot's with `slots` configured, otherwise `workspace.port`. */
export const jobPort = (deps: Pick<PipelineDeps, "config" | "slot">): number => appPortOf(deps.config, deps.slot?.n ?? 1);

/** With `slots`: frees the slot's app port and brings its containers up fresh. Null without `slots`. */
const startSlot = async (ctx: RunContext, deps: PipelineDeps, appPort: number): Promise<Slot | null> => {
  if (deps.config.slots === undefined) return null;
  if (deps.slot === undefined) throw new Error("slots is configured but this run has no slot");
  const { n, client } = deps.slot;
  if (!(await isPortFree(appPort))) await freePort(appPort);
  try {
    return { n, appPort, ports: await client.start(n, deps.signal) };
  } catch (err) {
    if (!(err instanceof SlotError)) throw err;
    const tail = deps.redactor.redact(err.tail);
    patchAttempt(ctx, deps, { setupTail: tail });
    throw new Error(`setup failed: slot ${n}: ${tail}`);
  }
};
```

Replace the doc comment and the first lines of `prepareWorkspace` up to and including the `copyOverlay` call with:

```ts
/** Brings the job's slot up (with `slots`), creates the worktree at `sha`, then lays down the artifacts dir, overlay and skills, and runs setup. */
export const prepareWorkspace = async (
  ctx: RunContext,
  deps: PipelineDeps,
  paths: JobPaths,
  env: Record<string, string>,
  sha: string,
  onWorktree: (worktree: Worktree) => void,
): Promise<Worktree> => {
  const { config, mirror } = deps;
  const port = jobPort(deps);
  const slot = await startSlot(ctx, deps, port);
  const worktree = await createWorktree(mirror, paths.workRoot, paths.worktreeName, sha);
  onWorktree(worktree);
  await mkdir(paths.artifactsDir, { recursive: true, mode: 0o700 });
  const portRewrite = config.workspace.portRewrite === undefined ? {} : { portRewrite: { from: config.workspace.portRewrite.from, to: port } };
  const overrides = slot === null || config.slots === undefined ? {} : { overrides: renderSlotEnv(config.slots.env, slot) };
  await copyOverlay(config.workspace.overlayDir, worktree.path, { ...portRewrite, ...overrides });
```

(the rest of `prepareWorkspace`, from `await copySkills(…)`, stays). Replace `cleanupWorkspace` with:

```ts
/** Frees the app port, removes the worktree unless a failure keeps it, and brings the job's slot down. */
export const cleanupWorkspace = async (deps: PipelineDeps, worktree: Worktree | null, outcome: JobOutcome): Promise<void> => {
  const port = jobPort(deps);
  const keep = outcome.status !== "succeeded" && deps.config.workspace.keepOnFailure;
  try {
    if (!(await isPortFree(port))) await freePort(port);
    if (worktree !== null && !keep) await worktree.destroy();
  } catch (err) {
    logger.warn({ err: errorMessage(err) }, "workspace cleanup failed");
  }
  if (deps.slot !== undefined) await deps.slot.client.release(deps.slot.n);
};

/** A failed workspace preparation: interrupted on shutdown, terminal for a slot override key the overlay lacks, otherwise retryable. */
export const prepareFailed = (deps: PipelineDeps, err: unknown): JobOutcome =>
  deps.signal?.aborted === true
    ? { status: "failed", error: INTERRUPTED_ERROR, retryable: true }
    : { status: "failed", error: errorMessage(err), retryable: !(err instanceof OverrideKeysError) };
```

- [ ] **Step 5: Use the job's port and `prepareFailed` in the three pipelines**

`src/core/pipeline.ts`: remove the `appPortOf` import added in Task 1; add `jobPort, prepareFailed` to the `./workspace.js` import; `stewardPort: appPortOf(config, 1),` → `stewardPort: jobPort(deps),`; in `execute`:

```ts
  const env = buildBrainEnv(secrets, config.brain, jobPort(deps));
  let prepared: Prepared;
  try {
    prepared = await prepare(ctx, deps, paths, env, onWorktree);
  } catch (err) {
    if (err instanceof ClosedTicketError) return { status: "failed", error: err.message, retryable: false };
    return prepareFailed(deps, err);
  }
```

`src/review/pipeline.ts`: remove the `appPortOf` import; add `jobPort, prepareFailed` to the `../core/workspace.js` import; `buildBrainEnv(deps.secrets, deps.config.brain, appPortOf(deps.config, 1))` → `buildBrainEnv(deps.secrets, deps.config.brain, jobPort(deps))`; `stewardPort: appPortOf(deps.config, 1),` → `stewardPort: jobPort(deps),`; the catch after the prompt render becomes:

```ts
  } catch (err) {
    return prepareFailed(deps, err);
  }
```

`src/implement/pipeline.ts`: restore `import type { ImplementConfig } from "../config/schema.js";`; add `jobPort, prepareFailed` to the `../core/workspace.js` import; `buildBrainEnv(deps.secrets, deps.config.brain, appPortOf(deps.config, 1))` → `buildBrainEnv(deps.secrets, deps.config.brain, jobPort(deps))`; `stewardPort: appPortOf(deps.config, 1),` → `stewardPort: jobPort(deps),`; `buildWorkspaceEnv(appPortOf(deps.config, 1))` → `buildWorkspaceEnv(jobPort(deps))`; the catch after `renderImplementPrompt` becomes:

```ts
  } catch (err) {
    return prepareFailed(deps, err);
  }
```

- [ ] **Step 6: Run the tests and checks**

Run: `npx vitest run test/core test/review test/implement test/worker && npm run -s typecheck && npm run -s lint`
Expected: PASS (existing setup-failure, interrupt and cleanup tests unchanged).

- [ ] **Step 7: Commit**

```bash
git add src/core/deps.ts src/core/workspace.ts src/core/pipeline.ts src/review/pipeline.ts src/implement/pipeline.ts test/core/pipeline.test.ts test/review/pipeline.test.ts test/implement/pipeline.test.ts
git commit -m "feat(workspace): run each job on a slot with fresh containers

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Worker: one loop per slot

**Files:**
- Modify: `src/worker/loop.ts` (rewrite), `src/worker/index.ts`, `src/server/app.ts:12-26`, `src/cli/serve.ts:25`
- Test: `test/worker/loop.test.ts`, `test/server/app.test.ts`

**Interfaces:**
- Consumes: `JobStore.claimNext`, `JobStore.requeueInterruptedJob` (Task 5); `PipelineDeps.slot`, `SlotRef`, `SlotClient.down` (Tasks 2, 7); `fakeSlotRunner` (Task 2).
- Produces:
  - `export interface WorkerState { running: Array<{ slot: number; jobId: number }> }` (from `src/worker/loop.ts`, re-exported by `src/worker/index.ts`)
  - `WorkerHandle.state(): WorkerState`
  - `startWorker(deps)` throws `slots is configured but the worker was given no slot client` when `config.slots` is set and `deps.slot` is not.
  - `ServerDeps.workerState: () => WorkerState`; `HealthReport.worker: WorkerState`.

- [ ] **Step 1: Write the failing tests**

In `test/worker/loop.test.ts`:

- add imports `import { existsSync } from "node:fs";`, `import type { PipelineDeps } from "../../src/core/pipeline.js";`, `import { SlotClient } from "../../src/workspace/slots.js";`, `import { fakeSlotRunner, type FakeSlotRunner } from "../fakes/fakeSlotRunner.js";`
- change every `expect(handle.state()).toEqual({ running: null });` to `expect(handle.state()).toEqual({ running: [] });`
- change both `expect(handle.state()).toEqual({ running: jobId });` to `expect(handle.state()).toEqual({ running: [{ slot: 1, jobId }] });`

Add after `const sleep = …`:

```ts
const SLOTS = { count: 2, helper: "/usr/local/sbin/steward-slot", appPortBase: 4100, upTimeoutSeconds: 180, env: {} };

const slotConfig = (count = 2): StewardConfig => {
  const base = makeConfig();
  return { ...base, workspace: { ...base.workspace, port: undefined }, slots: { ...SLOTS, count } };
};

const onSlots = (runner: FakeSlotRunner, config: StewardConfig = slotConfig()): Partial<WorkerDeps> => ({
  config,
  slot: { n: 1, client: new SlotClient(SLOTS, runner.run) },
});

/** A runJob that holds each job until `release(jobId)`, or answers INTERRUPTED when the worker aborts. */
const heldRuns = () => {
  const releases = new Map<number, (outcome: JobOutcome) => void>();
  const slots = new Map<number, number | undefined>();
  const impl = (ctx: RunContext, deps: PipelineDeps): Promise<JobOutcome> =>
    new Promise<JobOutcome>((resolve) => {
      releases.set(ctx.jobId, resolve);
      slots.set(ctx.jobId, deps.slot?.n);
      deps.signal?.addEventListener("abort", () => resolve(INTERRUPTED), { once: true });
    });
  return { impl, slots, release: (jobId: number) => releases.get(jobId)?.(SUCCEEDED) };
};

const issue2 = { ...createdTrigger, issueId: "issue-2", identifier: "API-2", deliveryId: "delivery-9" };
```

Append inside `describe("startWorker", …)`:

```ts
  it("runs jobs for two tickets at once, one per slot", async () => {
    const held = heldRuns();
    runJobMock.mockImplementation(held.impl);
    const first = stores.jobs.enqueue(createdTrigger);
    const second = stores.jobs.enqueue(issue2);
    const handle = start(onSlots(fakeSlotRunner()));

    await vi.waitFor(() => expect(handle.state().running).toHaveLength(2));
    expect(new Set(handle.state().running.map((entry) => entry.slot))).toEqual(new Set([1, 2]));
    expect(new Set(handle.state().running.map((entry) => entry.jobId))).toEqual(new Set([first, second]));
    expect(new Set([held.slots.get(first), held.slots.get(second)])).toEqual(new Set([1, 2]));

    held.release(first);
    held.release(second);
    await waitForStatus(first, "succeeded");
    await waitForStatus(second, "succeeded");
    await vi.waitFor(() => expect(handle.state()).toEqual({ running: [] }));
  });

  it("runs two jobs for the same ticket one after the other", async () => {
    const held = heldRuns();
    runJobMock.mockImplementation(held.impl);
    const runImplement = vi.fn(async () => ({ status: "succeeded" }) as const);
    const first = stores.jobs.enqueue(createdTrigger);
    const second = stores.jobs.enqueue({ ...createdTrigger, action: "implement", deliveryId: "delivery-2" });
    const handle = start({ ...onSlots(fakeSlotRunner()), runImplement });

    await vi.waitFor(() => expect(handle.state().running.map((entry) => entry.jobId)).toEqual([first]));
    await sleep(30);
    expect(runImplement).not.toHaveBeenCalled();
    expect(stores.jobs.get(second)?.status).toBe("queued");

    held.release(first);
    await waitForStatus(second, "succeeded");
    expect(runImplement).toHaveBeenCalledTimes(1);
  });

  it("brings every slot down at startup before claiming", async () => {
    const runner = fakeSlotRunner();
    const jobId = stores.jobs.enqueue(createdTrigger);
    start(onSlots(runner, slotConfig(3)));

    await waitForStatus(jobId, "succeeded");
    expect(runner.calls).toEqual([["down", "1"], ["down", "2"], ["down", "3"]]);
  });

  it("stop aborts every running job, waits for all of them, brings every slot down, then releases the lock", async () => {
    const held = heldRuns();
    runJobMock.mockImplementation(held.impl);
    const runner = fakeSlotRunner();
    const first = stores.jobs.enqueue(createdTrigger);
    const second = stores.jobs.enqueue(issue2);
    const handle = start(onSlots(runner));
    await vi.waitFor(() => expect(handle.state().running).toHaveLength(2));

    await handle.stop();

    expect(stores.jobs.get(first)?.status).toBe("queued");
    expect(stores.jobs.get(second)?.status).toBe("queued");
    expect(handle.state()).toEqual({ running: [] });
    expect(runner.calls).toEqual([["down", "1"], ["down", "2"], ["down", "1"], ["down", "2"]]);
    const lock = acquireRunLock(dataDir);
    expect(lock).not.toBeNull();
    lock?.release();
  });

  it("an interrupted job leaves the job on the other slot running", async () => {
    const held = heldRuns();
    const other = stores.jobs.enqueue(issue2);
    const interrupted = stores.jobs.enqueue(createdTrigger);
    let interruptedRuns = 0;
    runJobMock.mockImplementation((ctx, deps) => {
      if (ctx.jobId !== interrupted) return held.impl(ctx, deps);
      interruptedRuns += 1;
      return Promise.resolve(interruptedRuns === 1 ? INTERRUPTED : SUCCEEDED);
    });
    start(onSlots(fakeSlotRunner()));

    await waitForStatus(interrupted, "succeeded");
    expect(stores.jobs.get(other)?.status).toBe("running");
    expect(stores.attempts.forJob(other)[0]?.finishedAt).toBeNull();

    held.release(other);
    await waitForStatus(other, "succeeded");
  });

  it("skips the timer's sweep while a job runs and sweeps once the worker is idle", async () => {
    const held = heldRuns();
    runJobMock.mockImplementation(held.impl);
    const jobId = stores.jobs.enqueue(createdTrigger);
    const handle = start({ ...onSlots(fakeSlotRunner(), { ...slotConfig(), retention: { keptWorktrees: 0, days: 30 } }), sweepMs: 10 });
    await vi.waitFor(() => expect(handle.state().running).toHaveLength(1));
    const stale = join(dataDir, "work", "old-1");
    await mkdir(stale, { recursive: true });

    await sleep(60);
    expect(existsSync(stale)).toBe(true);

    held.release(jobId);
    await vi.waitFor(() => expect(existsSync(stale)).toBe(false));
  });

  it("refuses to start with slots configured but no slot client", () => {
    expect(() => startWorker(makeDeps({ config: slotConfig() }))).toThrow("slots is configured but the worker was given no slot client");
  });
```

In `test/server/app.test.ts` change `const WORKER_IDLE = { running: null };` to `const WORKER_IDLE = { running: [] };`, the `/health` expectation `worker: { running: null },` to `worker: { running: [] },`, and append inside `describe("GET /health", …)`:

```ts
    it("lists every running slot", async () => {
      await app.close();
      const running = { running: [{ slot: 1, jobId: 12 }, { slot: 2, jobId: 14 }] };
      app = buildServer({ config: makeConfig(), secrets: {}, stores, tracker, workerState: () => running });

      expect((await app.inject({ method: "GET", url: "/health" })).json().worker).toEqual(running);
    });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/worker/loop.test.ts test/server/app.test.ts`
Expected: FAIL; `state()` still returns `{ running: number | null }`, the two-ticket test never sees two running jobs, no `down` calls are made, and `startWorker` does not throw for a missing slot client.

- [ ] **Step 3: Rewrite the worker**

Replace `src/worker/loop.ts` with:

```ts
import { join } from "node:path";
import { INTERRUPTED_ERROR } from "../brain/index.js";
import { acquireRunLock } from "../core/lock.js";
import { publishOnly, redactOutcome, runJob, type PipelineDeps } from "../core/pipeline.js";
import type { JobOutcome, RunContext } from "../core/types.js";
import { publishImplementOnly, runImplement } from "../implement/pipeline.js";
import { logger } from "../log.js";
import { publishReviewOnly, runReview } from "../review/pipeline.js";
import { unreadableOutcome, type Attempt, type AttemptPatch, type Job } from "../store/index.js";
import { sweep } from "../workspace/retention.js";

export interface WorkerOptions {
  pollMs?: number;
  maxAttempts?: number;
  backoffMs?: number[];
  sweepMs?: number;
  runJob?: typeof runJob;
  publishOnly?: typeof publishOnly;
  runReview?: typeof runReview;
  publishReviewOnly?: typeof publishReviewOnly;
  runImplement?: typeof runImplement;
  publishImplementOnly?: typeof publishImplementOnly;
}

export type WorkerDeps = PipelineDeps & WorkerOptions;

/** The jobs running right now, one entry per busy slot (slot 1 when `slots` is not configured). */
export interface WorkerState {
  running: Array<{ slot: number; jobId: number }>;
}

export interface WorkerHandle {
  state: () => WorkerState;
  stop: () => Promise<void>;
}

interface InFlight {
  job: Job;
  attempt: Attempt;
}

/** One worker loop; it owns its slot for its whole life. */
interface Lane {
  slot: number;
  inFlight: InFlight | null;
  wake: (() => void) | null;
}

const DEFAULT_POLL_MS = 2_000;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BACKOFF_MS = [60_000, 300_000];
const DEFAULT_SWEEP_MS = 60 * 60 * 1000;
const DELIVERY_RETENTION_DAYS = 7;

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

const isRetryable = (outcome: JobOutcome): outcome is Exclude<JobOutcome, { status: "succeeded" }> =>
  outcome.status === "publish_failed" || (outcome.status === "failed" && outcome.retryable);

const isInterrupted = (outcome: JobOutcome): boolean => outcome.status === "failed" && outcome.error === INTERRUPTED_ERROR;

const attemptPatch = (outcome: JobOutcome): AttemptPatch => {
  if (outcome.status === "succeeded") return outcome.warning === undefined ? {} : { error: outcome.warning };
  return { error: outcome.error };
};

const runContext = (job: Job, attempt: Attempt): RunContext => ({
  jobId: job.id,
  attempt: attempt.number,
  issueId: job.issueId,
  identifier: job.identifier,
  teamKey: job.teamKey,
  trigger: job.trigger,
  dryRun: false,
});

class Worker {
  private readonly pollMs: number;
  private readonly maxAttempts: number;
  private readonly backoffMs: number[];
  private readonly execute: typeof runJob;
  private readonly republish: typeof publishOnly;
  private readonly review: typeof runReview;
  private readonly republishReview: typeof publishReviewOnly;
  private readonly implement: typeof runImplement;
  private readonly republishImplement: typeof publishImplementOnly;
  private readonly abort = new AbortController();
  private readonly sweepTimer: NodeJS.Timeout;
  private readonly lanes: Lane[];
  private readonly loopsDone: Promise<void>;
  private readonly onSigterm = (): void => void this.stop();
  private stopped = false;
  private stopping: Promise<void> | null = null;
  /** True while retention runs; claims wait, so no job starts while worktree directories are being removed. */
  private sweeping = false;

  constructor(
    private readonly deps: WorkerDeps,
    private readonly lock: { release: () => void },
  ) {
    this.pollMs = deps.pollMs ?? DEFAULT_POLL_MS;
    this.maxAttempts = deps.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.backoffMs = deps.backoffMs ?? DEFAULT_BACKOFF_MS;
    this.execute = deps.runJob ?? runJob;
    this.republish = deps.publishOnly ?? publishOnly;
    this.review = deps.runReview ?? runReview;
    this.republishReview = deps.publishReviewOnly ?? publishReviewOnly;
    this.implement = deps.runImplement ?? runImplement;
    this.republishImplement = deps.publishImplementOnly ?? publishImplementOnly;
    this.lanes = Array.from({ length: deps.config.slots?.count ?? 1 }, (_, index): Lane => ({ slot: index + 1, inFlight: null, wake: null }));
    const { requeued, failed } = deps.stores.jobs.requeueInterrupted(this.maxAttempts);
    logger.info({ requeued, failed, slots: this.lanes.length }, "worker started");
    this.sweepTimer = setInterval(() => void this.sweepWhenIdle(), deps.sweepMs ?? DEFAULT_SWEEP_MS).unref();
    process.once("SIGTERM", this.onSigterm);
    // A crash can leave a slot's containers behind: every slot goes down before any loop claims.
    this.loopsDone = this.downAll()
      .then(() => this.sweep())
      .then(() => Promise.all(this.lanes.map((lane) => this.loop(lane).catch((err: unknown) => logger.error({ slot: lane.slot, err: errorMessage(err) }, "worker loop crashed")))))
      .then(() => undefined)
      .catch((err: unknown) => logger.error({ err: errorMessage(err) }, "worker crashed"));
  }

  state(): WorkerState {
    return { running: this.lanes.flatMap((lane) => (lane.inFlight === null ? [] : [{ slot: lane.slot, jobId: lane.inFlight.job.id }])) };
  }

  stop(): Promise<void> {
    this.stopping ??= this.shutdown();
    return this.stopping;
  }

  private async shutdown(): Promise<void> {
    this.stopped = true;
    process.removeListener("SIGTERM", this.onSigterm);
    clearInterval(this.sweepTimer);
    this.abort.abort();
    for (const lane of this.lanes) lane.wake?.();
    try {
      await this.loopsDone;
      await this.downAll();
    } finally {
      this.lock.release();
    }
    logger.info("worker stopped");
  }

  /** Brings every slot down; without `slots` there are no containers. */
  private async downAll(): Promise<void> {
    const ref = this.deps.slot;
    if (ref === undefined) return;
    await Promise.all(this.lanes.map((lane) => ref.client.down(lane.slot)));
  }

  private async loop(lane: Lane): Promise<void> {
    while (!this.stopped) {
      let job: Job | null;
      try {
        job = this.claim();
      } catch (err) {
        // A store error while claiming must not end the loop; wait out the poll interval and try again.
        logger.error({ slot: lane.slot, err: errorMessage(err) }, "job claim failed");
        job = null;
      }
      if (job === null) {
        await this.idle(lane);
        continue;
      }
      await this.process(lane, job);
    }
  }

  /** A rejected Linear API key pauses the queue: jobs stay queued until the steward restarts with a working key. */
  private claim(): Job | null {
    if (this.sweeping || this.deps.tracker.apiKeyRejected()) return null;
    return this.deps.stores.jobs.claimNext();
  }

  private idle(lane: Lane): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        lane.wake = null;
        resolve();
      }, this.pollMs);
      lane.wake = () => {
        clearTimeout(timer);
        lane.wake = null;
        resolve();
      };
    });
  }

  private async process(lane: Lane, job: Job): Promise<void> {
    const { stores, redactor } = this.deps;
    try {
      const attempt = stores.attempts.start(job.id);
      lane.inFlight = { job, attempt };
      const outcome = redactOutcome(await this.run(lane, job, runContext(job, attempt)), redactor);
      await this.record(job, attempt, outcome);
      const detail = outcome.status === "succeeded" ? (outcome.warning === undefined ? {} : { warning: outcome.warning }) : { error: outcome.error };
      const fields = { jobId: job.id, slot: lane.slot, kind: job.kind, identifier: job.identifier, attempt: attempt.number, status: outcome.status, ...detail };
      if (outcome.status === "succeeded") logger.info(fields, "job finished");
      else logger.warn(fields, "job finished");
    } catch (err) {
      logger.error({ jobId: job.id, err: errorMessage(err) }, "job bookkeeping failed");
      this.failBestEffort(job, errorMessage(err));
    } finally {
      lane.inFlight = null;
    }
  }

  private async run(lane: Lane, job: Job, ctx: RunContext): Promise<JobOutcome> {
    const slot = this.deps.slot === undefined ? {} : { slot: { n: lane.slot, client: this.deps.slot.client } };
    const deps: PipelineDeps = { ...this.deps, signal: this.abort.signal, ...slot };
    // An unreadable stored result fails the job here, before any dispatch could re-run the brain or push again.
    const unreadable = unreadableOutcome(job);
    if (unreadable !== null) return unreadable;
    try {
      if (job.kind === "implement") return job.implementResult === null ? await this.implement(ctx, deps) : await this.republishImplement(ctx, deps);
      if (job.kind === "review") return job.reviewResult === null ? await this.review(ctx, deps) : await this.republishReview(ctx, deps);
      return job.result === null ? await this.execute(ctx, deps) : await this.republish(ctx, deps);
    } catch (err) {
      return { status: "failed", error: errorMessage(err), retryable: false };
    }
  }

  /** Persists the outcome: interrupted runs stay queued, a run that hit a rejected API key goes back to the queue with its attempt refunded, retryable ones wait out the backoff in the queue, the rest are terminal. */
  private async record(job: Job, attempt: Attempt, outcome: JobOutcome): Promise<void> {
    const { jobs, attempts } = this.deps.stores;
    if (isInterrupted(outcome)) {
      // This job only: another slot's job may still be running.
      jobs.requeueInterruptedJob(job.id, this.maxAttempts);
      return;
    }
    attempts.finish(attempt.id, attemptPatch(outcome));
    if (outcome.status !== "succeeded" && this.deps.tracker.apiKeyRejected()) {
      jobs.releaseClaim(job.id, outcome.error);
      logger.warn({ jobId: job.id }, "job returned to the queue: Linear rejected the API key");
      return;
    }
    if (isRetryable(outcome) && job.attempts < this.maxAttempts) {
      const delay = this.backoffMs[job.attempts - 1] ?? this.backoffMs.at(-1) ?? 0;
      jobs.scheduleRetry(job.id, new Date(Date.now() + delay), outcome.error);
      logger.info({ jobId: job.id, identifier: job.identifier, attempt: job.attempts, delayMs: delay, error: outcome.error }, "job retry scheduled");
      return;
    }
    jobs.finish(job.id, outcome);
  }

  private failBestEffort(job: Job, error: string): void {
    try {
      this.deps.stores.jobs.finish(job.id, { status: "failed", error, retryable: false });
    } catch (err) {
      logger.error({ jobId: job.id, err: errorMessage(err) }, "job could not be marked failed");
    }
  }

  /** The timer's sweep: skipped while any job runs (the next interval tries again), so it never removes a worktree in use. */
  private async sweepWhenIdle(): Promise<void> {
    if (this.stopped || this.sweeping || this.lanes.some((lane) => lane.inFlight !== null)) return;
    await this.sweep();
  }

  private async sweep(): Promise<void> {
    const { config, stores } = this.deps;
    this.sweeping = true;
    try {
      const removed = await sweep({
        workRoot: join(config.dataDir, "work"),
        jobsDir: join(config.dataDir, "jobs"),
        keptWorktrees: config.retention.keptWorktrees,
        days: config.retention.days,
        protect: [],
      });
      const deliveries = stores.deliveries.prune(DELIVERY_RETENTION_DAYS);
      logger.info({ ...removed, deliveries }, "retention sweep complete");
    } catch (err) {
      logger.warn({ err: errorMessage(err) }, "retention sweep failed");
    } finally {
      this.sweeping = false;
    }
  }
}

export const startWorker = (deps: WorkerDeps): WorkerHandle => {
  if (deps.config.slots !== undefined && deps.slot === undefined) throw new Error("slots is configured but the worker was given no slot client");
  const lock = acquireRunLock(deps.config.dataDir);
  if (lock === null) throw new Error(`another steward process holds ${join(deps.config.dataDir, "run.lock")}`);
  const worker = new Worker(deps, lock);
  return { state: () => worker.state(), stop: () => worker.stop() };
};
```

Replace `src/worker/index.ts` with:

```ts
export { startWorker } from "./loop.js";
export type { WorkerDeps, WorkerHandle, WorkerOptions, WorkerState } from "./loop.js";
```

- [ ] **Step 4: Report the array from `/health`**

In `src/server/app.ts` add `import type { WorkerState } from "../worker/index.js";`, and change `workerState: () => { running: number | null };` to `workerState: () => WorkerState;` and `worker: { running: number | null };` to `worker: WorkerState;`.

In `src/cli/serve.ts` change `println(ctx, "shutting down: waiting for the in-flight job");` to `println(ctx, "shutting down: waiting for in-flight jobs");`.

- [ ] **Step 5: Run the tests and checks**

Run: `npx vitest run test/worker test/server test/store && npm run -s typecheck && npm run -s lint`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/worker/loop.ts src/worker/index.ts src/server/app.ts src/cli/serve.ts test/worker/loop.test.ts test/server/app.test.ts
git commit -m "feat(worker): one loop per slot; state lists every running job

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Doctor checks for slots

**Files:**
- Modify: `src/cli/context.ts:21-28`, `src/cli/doctor.ts:13-21,246-290`
- Modify: `test/cli/helpers.ts:50-96`
- Test: `test/cli/doctor.test.ts`

**Interfaces:**
- Consumes: `appPortOf`, `SlotsConfig` (Task 1); `SlotClient`, `SlotRunner` (Task 2); `missingOverrideKeys` (Task 3); `fakeSlotRunner` (Task 2).
- Produces:
  - `CliFactories.slotRunner?: SlotRunner`
  - Doctor lines with `slots` set (replacing the `port` line): `slot helper`, `slot sudo`, `slot <n> ports` for n = 1..count, `slot env keys`.
  - `test/cli/helpers.ts` `ConfigPaths`: `port: number | null` (null omits the line) and `slots?: Record<string, unknown>`.

- [ ] **Step 1: Extend the test config writer**

In `test/cli/helpers.ts`, in `ConfigPaths` change `port: number;` to:

```ts
  /** null leaves workspace.port out (required with `slots`). */
  port: number | null;
  slots?: Record<string, unknown>;
```

In `writeConfig`, after `const implement = …;` add:

```ts
  const slots = p.slots === undefined ? "" : `slots: ${JSON.stringify(p.slots)},`;
  const port = p.port === null ? "" : `port: ${p.port},`;
```

and in the `source` template replace the line `    port: ${p.port},` with `    ${port}` and add a line `  ${slots}` after `  ${implement}`.

- [ ] **Step 2: Write the failing tests**

In `test/cli/doctor.test.ts` add imports:

```ts
import { chmod } from "node:fs/promises";
import { createServer } from "node:net";
import type { SlotPorts } from "../../src/workspace/slots.js";
import { fakeSlotRunner, type FakeSlotRunner } from "../fakes/fakeSlotRunner.js";
```

and append:

```ts
describe("slot checks", () => {
  let helper: string;
  let appPortBase: number;
  let ports: Map<number, SlotPorts>;

  const distinctFreePorts = async (count: number): Promise<number[]> => {
    const found: number[] = [];
    while (found.length < count) {
      const port = await freeTcpPort();
      if (!found.includes(port)) found.push(port);
    }
    return found;
  };

  beforeEach(async () => {
    helper = join(dir, "steward-slot");
    await writeFile(helper, "#!/usr/bin/env bash\n");
    await chmod(helper, 0o755);
    await writeFile(join(repo.overlayDir, ".env"), "DB_PORT=5432\n");
    const [app, p1, r1, q1, p2, r2, q2] = await distinctFreePorts(7);
    appPortBase = (app ?? 0) - 1;
    ports = new Map([
      [1, { postgres: p1 ?? 0, redis: r1 ?? 0, rabbitmq: q1 ?? 0 }],
      [2, { postgres: p2 ?? 0, redis: r2 ?? 0, rabbitmq: q2 ?? 0 }],
    ]);
  });

  const slotRunner = (): FakeSlotRunner => fakeSlotRunner((n) => ports.get(n) ?? { postgres: 1, redis: 1, rabbitmq: 1 });

  const slotLines = async (runner: FakeSlotRunner, env: Record<string, string | null>, port: number | null = null): Promise<{ lines: string[]; out: string }> => {
    const configPath = await writeConfig(dir, {
      dataDir: repo.dataDir,
      overlayDir: repo.overlayDir,
      promptPath: repo.promptPath,
      fetchUrl: repo.repo,
      port,
      serverPort: await freeTcpPort(),
      slots: { count: 2, helper, appPortBase, env },
    });
    const { ctx, stdout } = makeContext({ factories: { codehostMcpSpec: fakeCodehostMcpSpec, slotRunner: runner.run } });
    await buildProgram(ctx).parseAsync(["node", "steward", "--config", configPath, "doctor"]).catch(() => undefined);
    return { lines: stdout().split("\n").filter((line) => line.includes("] slot ")), out: stdout() };
  };

  it.skipIf(process.getuid?.() === 0)("checks the helper, the sudo rule, every slot's ports and the env keys", async () => {
    const { lines } = await slotLines(slotRunner(), { DB_PORT: "{{postgres}}", REDIS_URL: "redis://localhost:{{redis}}" });

    const p1 = ports.get(1);
    const p2 = ports.get(2);
    expect(lines).toEqual([
      `[fail] slot helper: ${helper} is not owned by root; chown root:root ${helper}`,
      `[ok] slot sudo: sudo -n ${helper} check: ok`,
      `[ok] slot 1 ports: app ${appPortBase + 1}, postgres ${p1?.postgres}, redis ${p1?.redis}, rabbitmq ${p1?.rabbitmq} free`,
      `[ok] slot 2 ports: app ${appPortBase + 2}, postgres ${p2?.postgres}, redis ${p2?.redis}, rabbitmq ${p2?.rabbitmq} free`,
      "[fail] slot env keys: not in any overlay file: REDIS_URL; remove them from slots.env or sync the overlay",
    ]);
  });

  it("names a slot that is still up", async () => {
    const runner = slotRunner();
    runner.respond("status", { stdout: "steward-slot-1-postgres-1 Up 3 minutes\n" });
    const held = createServer();
    const postgres = ports.get(1)?.postgres ?? 0;
    await new Promise<void>((resolve) => held.listen(postgres, resolve));
    try {
      const { lines } = await slotLines(runner, { DB_PORT: "{{postgres}}" });
      expect(lines).toContain(`[fail] slot 1 ports: slot 1 is up (postgres ${postgres} in use); stop serve or run sudo -n ${helper} down 1`);
    } finally {
      await new Promise<void>((resolve) => held.close(() => resolve()));
    }
  });

  it("reports a failed sudo check with sudo's own words", async () => {
    const runner = slotRunner();
    runner.respond("check", { exitCode: 1, stdout: "", output: "sudo: a password is required\n" });
    const { lines } = await slotLines(runner, {});
    expect(lines).toContain(`[fail] slot sudo: sudo -n ${helper} check failed: sudo: a password is required; see docs/ops.md, "Worker slots"`);
  });

  it("reports workspace.port next to slots as a config failure", async () => {
    const { out } = await slotLines(slotRunner(), {}, 4100);
    expect(out.startsWith("[fail] config: ")).toBe(true);
    expect(out).toContain("workspace.port was replaced by slots.appPortBase (see docs/ops.md)");
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run test/cli/doctor.test.ts`
Expected: FAIL; no `slot …` lines are printed (doctor still prints the single `port` line), so `lines` is `[]`. The config-failure test already passes (Task 1).

- [ ] **Step 4: Implement**

In `src/cli/context.ts` add `import type { SlotRunner } from "../workspace/slots.js";` and to `CliFactories`:

```ts
  /** Stands in for `sudo -n <helper>`; tests never run sudo or Docker. */
  slotRunner?: SlotRunner;
```

In `src/cli/doctor.ts` extend the imports:

```ts
import { appPortOf, type SlotsConfig, type StewardConfig } from "../config/schema.js";
import { missingOverrideKeys } from "../workspace/overlay.js";
import { SlotClient } from "../workspace/slots.js";
```

(replacing the `appPortOf`-only import from Task 1), and add before `serviceChecks`:

```ts
const SLOTS_DOC = 'docs/ops.md, "Worker slots"';

const slotHelperCheck = (helper: string): Check => ({
  name: "slot helper",
  run: async () => {
    if (!existsSync(helper)) return flunk(`${helper} does not exist; install ops/steward-slot (${SLOTS_DOC})`);
    const info = await stat(helper);
    if (info.uid !== 0) return flunk(`${helper} is not owned by root; chown root:root ${helper}`);
    if ((info.mode & 0o022) !== 0) return flunk(`${helper} is writable by group or others; chmod 0755 ${helper}`);
    return ok(`${helper} is root-owned and not group- or world-writable`);
  },
});

/** Doctor expects every slot down (serve stopped or idle), so a held service port usually means a slot left up. */
const slotPortsCheck = (config: StewardConfig, slots: SlotsConfig, client: SlotClient, n: number): Check => ({
  name: `slot ${n} ports`,
  run: async () => {
    const ports = await client.ports(n);
    const named: Array<[string, number]> = [["app", appPortOf(config, n)], ["postgres", ports.postgres], ["redis", ports.redis], ["rabbitmq", ports.rabbitmq]];
    const busy: string[] = [];
    for (const [name, port] of named) if (!(await isPortFree(port))) busy.push(`${name} ${port}`);
    if (busy.length === 0) return ok(`${named.map(([name, port]) => `${name} ${port}`).join(", ")} free`);
    if ((await client.status(n)) !== "") return flunk(`slot ${n} is up (${busy.join(", ")} in use); stop serve or run sudo -n ${slots.helper} down ${n}`);
    return flunk(`in use: ${busy.join(", ")}`);
  },
});

/** Without `slots`: workspace.port is free. With `slots`: the helper, the sudo rule, every slot's ports and the env keys. */
const portChecks = ({ config }: LoadedConfig, ctx: CliContext): Check[] => {
  const slots = config.slots;
  if (slots === undefined) {
    return [
      {
        name: "port",
        run: async () => {
          const port = appPortOf(config, 1);
          return (await isPortFree(port)) ? ok(`${port} is free`) : flunk(`${port} is in use`);
        },
      },
    ];
  }
  const client = new SlotClient(slots, ctx.factories?.slotRunner);
  return [
    slotHelperCheck(slots.helper),
    {
      name: "slot sudo",
      run: async () => {
        const result = await client.check();
        return result.ok ? ok(`sudo -n ${slots.helper} check: ok`) : flunk(`sudo -n ${slots.helper} check failed: ${result.output}; see ${SLOTS_DOC}`);
      },
    },
    ...Array.from({ length: slots.count }, (_, index) => slotPortsCheck(config, slots, client, index + 1)),
    {
      name: "slot env keys",
      run: async () => {
        const keys = Object.keys(slots.env);
        const absent = await missingOverrideKeys(config.workspace.overlayDir, keys);
        return absent.length === 0 ? ok(`${keys.length} key(s) found in the overlay`) : flunk(`not in any overlay file: ${absent.join(", ")}; remove them from slots.env or sync the overlay`);
      },
    },
  ];
};
```

In `serviceChecks`, delete the `port` entry (the one Task 1 rewrote) and append `...portChecks(loaded, ctx),` as the last element of the returned array.

- [ ] **Step 5: Run the tests and checks**

Run: `npx vitest run test/cli && npm run -s typecheck && npm run -s lint`
Expected: PASS (the existing "reports every check" test still ends with `[ok] port: … is free` at index 16).

- [ ] **Step 6: Commit**

```bash
git add src/cli/context.ts src/cli/doctor.ts test/cli/helpers.ts test/cli/doctor.test.ts
git commit -m "feat(doctor): check the slot helper, sudo rule, slot ports and env keys

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Inline runs on slot 1, `steward jobs` running header, docs and example config

**Files:**
- Modify: `src/cli/runtime.ts:42-65`, `src/cli/jobs.ts:1-61`
- Modify: `docs/ops.md` (§1.5 line 148-149, §1.8 line 364, new §1.11 before `## 2. Why the overlay holds sandbox credentials`), `ops/ticket-steward.service`, `examples/kickoff/steward.config.ts`
- Test: `test/cli/enrich.test.ts`, `test/cli/jobs.test.ts`

**Interfaces:**
- Consumes: `SlotClient` (Task 2), `CliFactories.slotRunner` (Task 9), `PipelineDeps.slot` (Task 7), `WorkerState` shape on `/health` (Task 8).
- Produces: `buildRuntime` sets `deps.slot = { n: 1, client }` when `config.slots` is set; `steward jobs` prints `# running: slot 1 job 12, slot 2 job 14` (or `# running: none`) first when serve answers.

- [ ] **Step 1: Write the failing tests**

In `test/cli/enrich.test.ts` add `import { fakeSlotRunner } from "../fakes/fakeSlotRunner.js";` and append inside `describe("steward enrich (inline)", …)`:

```ts
  it("runs an inline job on slot 1 and brings the slot down afterwards", async () => {
    const runner = fakeSlotRunner();
    configPath = await writeConfig(dir, {
      dataDir: repo.dataDir,
      overlayDir: repo.overlayDir,
      promptPath: repo.promptPath,
      fetchUrl: repo.repo,
      port: null,
      serverPort,
      slots: { count: 2, appPortBase: (await freeTcpPort()) - 1, env: {} },
    });
    const context = makeContext({ factories: { tracker, brain: new FakeBrain({ result: brainResult }), codehost: new FakeCodeHost(), slotRunner: runner.run } });

    await buildProgram(context.ctx).parseAsync(["node", "steward", "--config", configPath, "enrich", "API-1"]);

    expect(context.stdout()).toBe("job 1 running (attempt 1)\njob 1 succeeded\n");
    expect(runner.calls).toEqual([["down", "1"], ["up", "1"], ["ports", "1"], ["down", "1"]]);
  });
```

In `test/cli/jobs.test.ts` append inside `describe("steward jobs", …)`:

```ts
  it("prints the running slots first when serve is up", async () => {
    const workerUp: typeof fetch = async (input) => {
      if (String(input) !== localHealthUrl(3020)) throw new Error("Intended Test Error");
      return new Response(JSON.stringify({ ok: true, worker: { running: [{ slot: 1, jobId: 12 }, { slot: 2, jobId: 14 }] } }), { status: 200 });
    };
    const { stdout, done } = run(["jobs"], workerUp);
    await done;
    expect(stdout()).toBe("# running: slot 1 job 12, slot 2 job 14\n");
  });

  it("prints running: none for an idle serve", async () => {
    const idle: typeof fetch = async () => new Response(JSON.stringify({ ok: true, worker: { running: [] } }), { status: 200 });
    const { stdout, done } = run(["jobs"], idle);
    await done;
    expect(stdout()).toBe("# running: none\n");
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/cli/enrich.test.ts test/cli/jobs.test.ts`
Expected: FAIL; the inline job fails with `slots is configured but this run has no slot` (stdout ends `job 1 failed: …`, `runner.calls` is `[]`), and `steward jobs` prints no header.

- [ ] **Step 3: Implement**

In `src/cli/runtime.ts` add `import { SlotClient } from "../workspace/slots.js";` and inside the `deps` literal, after `...(injectedBrain === undefined ? {} : brainRunner(injectedBrain)),`:

```ts
    // serve gives each worker loop its own slot; inline runs (enrich|implement KEY, jobs retry) use slot 1 under run.lock.
    ...(config.slots === undefined ? {} : { slot: { n: 1, client: new SlotClient(config.slots, ctx.factories?.slotRunner) } }),
```

In `src/cli/jobs.ts` add `import { z } from "zod";`, and after `const listArtifacts = …`:

```ts
const HealthWorker = z.object({ worker: z.object({ running: z.array(z.object({ slot: z.number(), jobId: z.number() })) }) });

/** The running slots as `steward serve` reports them; null when serve does not answer. */
const runningLine = async (ctx: CliContext, port: number): Promise<string | null> => {
  try {
    const response = await ctx.fetchImpl(localHealthUrl(port), { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
    const parsed = HealthWorker.safeParse(await response.json());
    if (!parsed.success) return null;
    const { running } = parsed.data.worker;
    return `# running: ${running.length === 0 ? "none" : running.map(({ slot, jobId }) => `slot ${slot} job ${jobId}`).join(", ")}`;
  } catch {
    return null;
  }
};
```

and in the `jobs` list action, before `for (const job of rows) …`:

```ts
      const running = await runningLine(ctx, config.server.port);
      if (running !== null) println(ctx, running);
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/cli && npm run -s typecheck && npm run -s lint`
Expected: PASS.

- [ ] **Step 5: Docs, unit note and example config**

`docs/ops.md` §1.5, replace:

```
0600, with `localhost:3000` / `127.0.0.1:3000` rewritten to the job's port when
`workspace.portRewrite` is set.
```

with:

```
0600, with `localhost:3000` / `127.0.0.1:3000` rewritten to the job's port (`workspace.port`, or the
slot's app port with `slots`) when `workspace.portRewrite` is set. With `slots`, `slots.env` then
overrides keys in the job's copy (§1.11).
```

`docs/ops.md` §1.8, replace the line `` `workspace.port` is free. `` with:

```
`workspace.port` is free, or, with `slots` (§1.11): the helper is root-owned and not group- or
world-writable, `sudo -n <helper> check` passes, every slot's app and service ports are free (a slot
left up is named), and every `slots.env` key is defined in the overlay.
```

`docs/ops.md`, insert immediately before `## 2. Why the overlay holds sandbox credentials`:

````markdown
### 1.11 Worker slots (optional)

Without `slots`, the worker runs one job at a time on `workspace.port`, against whatever the overlay's
env files point at. With `slots`, it runs `slots.count` jobs at once (1–9). Each job gets a **slot**: an
app port (`slots.appPortBase + n`) and three containers created fresh for that job and removed when it
ends: Postgres 17 with TimescaleDB (databases `concentrate` and `concentrate_tg`), Redis and RabbitMQ.
`slots.env` rewrites the job's copy of the overlay so every service the job starts talks to its slot,
never to Timescale Cloud, the dev Redis cluster, the dev RabbitMQ or a remote Postgres. Two jobs for the
same ticket (or the same merge request) never run at once.

**Why a root helper.** The agent runs as `steward`, and Docker access is root access, so `steward` stays
out of the `docker` group. It may run exactly one root-owned script through sudo:
`/usr/local/sbin/steward-slot up|down|status|ports <n>` and `check`, `n` 1–9, nothing else. The brain's
policy also denies `sudo` and `docker`. The accepted risk: an agent that gets around the policy could
`down` another slot; that slot's job then fails and is retried.

**Install** (as root, from a checkout of this repo):

```bash
install -o root -g root -m 0755 ops/steward-slot /usr/local/sbin/steward-slot
install -d -o root -g root -m 0755 /etc/ticket-steward/slots /etc/ticket-steward/slots/init /etc/ticket-steward/slots/docker
install -o root -g root -m 0644 ops/slots-compose.yml /etc/ticket-steward/slots/compose.yml
install -o root -g root -m 0644 ops/slots-init/01-databases.sql /etc/ticket-steward/slots/init/01-databases.sql
echo 'steward ALL=(root) NOPASSWD: /usr/local/sbin/steward-slot' > /etc/sudoers.d/ticket-steward-slots
chmod 0440 /etc/sudoers.d/ticket-steward-slots
visudo -cf /etc/sudoers.d/ticket-steward-slots
docker pull timescale/timescaledb-ha:pg17-ts2.27-all
docker pull redis:7-alpine
docker pull rabbitmq:4.2.0-management
# sudo cannot gain root under the unit's NoNewPrivileges=yes; lift it for this unit only
mkdir -p /etc/systemd/system/ticket-steward.service.d
printf '[Service]\nNoNewPrivileges=no\n' > /etc/systemd/system/ticket-steward.service.d/slots.conf
systemctl daemon-reload
sudo -u steward sudo -n /usr/local/sbin/steward-slot check   # prints ok
```

**Config.** Add `slots` and remove `workspace.port` (config load rejects it next to `slots`). Keep
`workspace.portRewrite`: it now rewrites `localhost:<from>` to the slot's app port, a substring rewrite
that keeps the other origins of a `CORS_ORIGIN` list.

```ts
slots: {
  count: 2,
  appPortBase: 4100,           // slot n's app port is 4100 + n
  // helper: "/usr/local/sbin/steward-slot", upTimeoutSeconds: 180 (defaults)
  env: {
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
    REDIS_CLUSTER_NODES: null, // deleted: kickoff's client then uses REDIS_URL
    REDIS_PASSWORD: null,
    RABBITMQ_URL: "amqp://steward:steward-slot@localhost:{{rabbitmq}}",
  },
},
```

Each `env` key is replaced in every copied overlay file that defines it (a `KEY=value` line, optionally
`export `-prefixed); `null` removes the line; keys are never added, and a key no overlay file defines
fails the job (not retried) and doctor, by name. Templates: `{{app}}`, `{{postgres}}`, `{{redis}}`,
`{{rabbitmq}}`; any other `{{name}}` fails config load. The overlay directory itself never changes, so
the redactor and the implement secret guard still know the remote credentials the overrides replaced.
Host ports come from `steward-slot ports <n>`: Postgres `15032 + 100n`, Redis `16079 + 100n`, RabbitMQ
`15072 + 100n`, all on 127.0.0.1. The slot credentials are throwaway, not secrets.

Per job: free the app port, `down` then `up` the slot (killed after `upTimeoutSeconds`), create the
worktree, copy the overlay with the overrides, run `workspace.setup` (`reset-dbs.sh` reads
`e2e/user/.env`, which now holds the slot's values), run the brain with `STEWARD_PORT` set to the
slot's app port, publish, and `down` the slot. A slot that does not come up fails the job as retryable
with `setup failed: slot <n>: …` and the helper's output tail in the attempt's `setupTail`. `steward
serve` brings every slot down when it starts and when it stops; retention sweeps only while no job
runs. `steward enrich|implement KEY` without serve runs on slot 1.

**Troubleshooting.**

- `sudo -n /usr/local/sbin/steward-slot status <n>` lists a slot's containers; `down <n>` removes them.
- `sudo: a password is required`: the sudoers drop-in is missing or not valid (`visudo -cf`).
- `sudo: The "no new privileges" flag is set`: the unit drop-in above is missing; `systemctl daemon-reload` and restart.
- Doctor reports `slot <n> is up` while serve is stopped: a crashed run left it; `down <n>`.
- A port in use that is not a slot: `ss -ltnp 'sport = :<port>'` names the holder; move `appPortBase` or stop it.
- `steward jobs` prints `# running: slot 1 job 12, …` while serve runs; `/health` has the same list under `worker.running`.
````

`ops/ticket-steward.service`: directly above `NoNewPrivileges=yes` add:

```
# With `slots` configured, sudo must gain root to run steward-slot; lift this in a drop-in
# (/etc/systemd/system/ticket-steward.service.d/slots.conf: NoNewPrivileges=no), see docs/ops.md §1.11.
```

`examples/kickoff/steward.config.ts`: delete the line `    port: 4100,` from `workspace`, and before the closing `});` add:

```ts
  // Parallel jobs, each on fresh local Postgres+TimescaleDB, Redis and RabbitMQ containers (docs/ops.md §1.11).
  // Without this block, put `port: 4100` back in workspace and jobs run one at a time against the overlay's services.
  slots: {
    count: 2,
    appPortBase: 4100,
    env: {
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
      REDIS_CLUSTER_NODES: null, // deleted: kickoff's client then uses REDIS_URL
      REDIS_PASSWORD: null,
      RABBITMQ_URL: "amqp://steward:steward-slot@localhost:{{rabbitmq}}",
    },
  },
```

- [ ] **Step 6: Run the full suite and checks**

Run: `npm run -s typecheck && npm run -s lint && npx vitest run`
Expected: PASS, every file green (live tests skip as today without credentials).

- [ ] **Step 7: Commit**

```bash
git add src/cli/runtime.ts src/cli/jobs.ts test/cli/enrich.test.ts test/cli/jobs.test.ts docs/ops.md ops/ticket-steward.service examples/kickoff/steward.config.ts
git commit -m "feat(cli): inline runs use slot 1, jobs shows running slots; docs for worker slots

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Ops (controller only, not a subagent task)

Run after the branch is merged and built on the host, as the controller, with sudo. Spec §10 steps 1–6.

- [ ] **1. Install the helper, compose file and init script** (root-owned):
  `install -o root -g root -m 0755 ops/steward-slot /usr/local/sbin/steward-slot`;
  `install -d -o root -g root -m 0755 /etc/ticket-steward/slots /etc/ticket-steward/slots/init /etc/ticket-steward/slots/docker`;
  `install -o root -g root -m 0644 ops/slots-compose.yml /etc/ticket-steward/slots/compose.yml`;
  `install -o root -g root -m 0644 ops/slots-init/01-databases.sql /etc/ticket-steward/slots/init/01-databases.sql`.
- [ ] **2. Sudoers drop-in:** write `steward ALL=(root) NOPASSWD: /usr/local/sbin/steward-slot` to `/etc/sudoers.d/ticket-steward-slots`, `chmod 0440`, `visudo -cf /etc/sudoers.d/ticket-steward-slots` must say `parsed OK`.
- [ ] **2a. Unit drop-in** (not in the spec; required): `/etc/systemd/system/ticket-steward.service.d/slots.conf` with `[Service]` / `NoNewPrivileges=no`, then `systemctl daemon-reload`. Without it every `sudo -n` from serve fails with "no new privileges" while doctor (run from a shell) passes.
- [ ] **3. Pull images:** `docker pull timescale/timescaledb-ha:pg17-ts2.27-all`, `docker pull redis:7-alpine`, `docker pull rabbitmq:4.2.0-management`.
- [ ] **3a. Verify the -ha image's data path:** `docker run --rm --entrypoint sh timescale/timescaledb-ha:pg17-ts2.27-all -c 'echo $PGDATA; id'` shows `/home/postgres/pgdata/data` and uid 1000; if it differs, fix `PGDATA`/tmpfs in `ops/slots-compose.yml` in a follow-up commit before step 4.
- [ ] **4. Smoke the helper as steward:** `sudo -u steward sudo -n /usr/local/sbin/steward-slot check` prints `ok`; `time sudo -u steward sudo -n /usr/local/sbin/steward-slot up 1` (target under 30 s); `… status 1` shows three healthy containers; `psql "postgres://postgres:steward-slot@127.0.0.1:15132/concentrate_tg" -c '\dx timescaledb'` lists the extension; `… down 1`; `docker ps --filter label=com.docker.compose.project=steward-slot-1` is empty. Then the same `up 1`/`down 1` under the unit's sandbox: `systemd-run --uid=steward --gid=steward -p NoNewPrivileges=no -p ProtectSystem=strict -p ProtectHome=yes -p PrivateTmp=yes --wait --pipe sudo -n /usr/local/sbin/steward-slot up 1` (and `down 1`).
- [ ] **5. Live config:** `cp /etc/ticket-steward/steward.config.ts /etc/ticket-steward/steward.config.ts.bak`; add the `slots` block (the owner's `env` map from spec §2), remove `workspace.port`, keep `workspace.portRewrite`; `sudo -u steward steward doctor` (from `/etc/ticket-steward`) shows `slot helper`, `slot sudo`, `slot 1 ports`, `slot 2 ports`, `slot env keys` all `[ok]`.
- [ ] **6. Restart while idle and prove it:** confirm `curl -s localhost:3020/health` shows `"running":[]`, `systemctl restart ticket-steward`; label two different tickets `needs-triage`; during the run `docker ps` shows `steward-slot-1-*` and `steward-slot-2-*` and `steward jobs` prints `# running: slot 1 job …, slot 2 job …`; afterwards `docker ps --filter name=steward-slot` is empty and both jobs are `succeeded`.
