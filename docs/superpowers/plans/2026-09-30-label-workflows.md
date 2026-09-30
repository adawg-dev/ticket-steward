# Label Workflows (Triage + Agent Implementation) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Linear labels drive the steward: `needs-triage` runs enrichment plus a triage verdict that swaps the label to `needs-info` or `ready-for-human`; `ready-for-agent` runs an implement job that commits on a `<type>/<IDENTIFIER>-<slug>` branch cut from `dev`, and the steward (never the agent) verifies, commits with kickoff's hooks, pushes, comments and swaps the label.

**Architecture:** Triage extends the existing enrich job (new required `triage` field on the brain result, publish swaps labels last). Implement is a new job kind with its own module `src/implement/` (result, branch, brief, prompt, git, publish, pipeline) mirroring `src/review/`. Webhook intake maps the configured label that was first added to a job kind. All git write steps (stage, guard, checks, commit with hook wrappers, bundle, push) run in the steward process with a credential-free env; the agent's policy stays read/edit-only.

**Tech Stack:** TypeScript (ESM, Node 22), zod 4, vitest, better-sqlite3, execa, `@linear/sdk`, Mustache, git CLI.

**Spec:** `docs/superpowers/specs/2026-09-30-label-workflows-design.md`

## Global Constraints

- Label names (defaults): `needs-triage`, `ready-for-agent`, `needs-info`, `ready-for-human`, `agent-implemented`; matched case-insensitively; a label counts only when first added (or present on create).
- The steward never applies `needs-triage` or `ready-for-agent`, never creates merge requests, never force-pushes, never touches an existing branch.
- Branch: `<type>/<IDENTIFIER>-<slug>`; type ∈ `implement.branchTypes` (default `feature`, `fix`, `chore`, `refactor`), chosen by the agent (`branchType`); identifier keeps Linear casing; slug = title lowercased, `[a-z0-9-]`, hyphens collapsed, ≤ 40 chars (fallback `change`).
- Pre-push refusals: target must match `refs/heads/(<branchTypes>)/<IDENTIFIER>-[a-z0-9-]+`; no remote branch carries the ticket (`refs/heads/*/<IDENTIFIER>-*`, any type, case-insensitive); commit has exactly one parent equal to the job's base `dev` commit.
- `GITLAB_PUSH_TOKEN` is used only for `ls-remote`/`push`, supplied per git process via `splitCredentials` (http extraHeader), never in git config, never in the brain env, redacted everywhere. `MIRROR_TOKEN` stays read-only; `GITLAB_TOKEN` untouched.
- Labels change **last** in every publish; a failure before the label swap leaves the trigger label on the ticket and the job `publish_failed`.
- Hand-backs (empty diff, guard, checks, hooks, existing branch, agent `failed`/`needs_info`) are job **successes** with `warning: "handed back: <reason>"`.
- Done/Canceled tickets are never worked on (intake, job start, before every write).
- Never typecast to `any`. Before claiming a task done run `pnpm typecheck && pnpm lint && pnpm test`.

## Review Focus

1. A ticket that receives `needs-triage` and `ready-for-agent` in the same update → implement wins (direct path), triage does not also run. Test in Task 2.
2. kickoff overlay `.env` files are gitignored in production but a new overlay file that is **not** ignored would be staged by `git add -A` → the guard must refuse and name the path, never commit it. Test in Task 8.
3. The agent returns `branchType: "Fix"` or `"hotfix"` (not in the list) → `failed` hand-back, nothing pushed. Test in Task 9.
4. `steward jobs retry` on an implement job whose push already landed → must not push again, only publish comment + labels. Test in Task 9.
5. Ticket title that slugifies to nothing (emoji/non-ASCII only) → branch `<type>/<IDENT>-change`, still matches the push pattern. Test in Task 7.

---

### Task 1: Config: labels, implement block, push token

**Files:**
- Modify: `src/config/schema.ts`
- Modify: `src/config/load.ts`
- Test: `test/config/schema.test.ts`, `test/config/load.test.ts`

**Interfaces:**
- Produces: `StewardConfig["tracker"]["labels"]` (optional) with `{ triage, implement, needsInfo, readyForHuman, implemented }: string`; `StewardConfig["implement"]` (optional) with `{ prompt: string; branchTypes: string[]; checks: string[]; checksTimeoutMinutes: number; commitAuthor: { name: string; email: string }; timeoutMinutes: number; maxTurns: number; protectedBranches: string[] }`; exported types `LabelsConfig`, `ImplementConfig`; `Secrets["GITLAB_PUSH_TOKEN"]?: string`.
- `tracker.triggerLabel` stays in this task (removed in Task 2).

- [ ] **Step 1: Write the failing tests**

Append to `test/config/schema.test.ts` (it already defines `minimalInput`):

```ts
describe("tracker.labels and implement", () => {
  const labels = {};
  const implement = { prompt: "./prompts/implement.md", commitAuthor: { name: "Ticket Steward", email: "steward@example.com" } };

  it("fills every label name with its default", () => {
    const parsed = StewardConfigSchema.parse({ ...minimalInput, tracker: { ...minimalInput.tracker, labels } });
    expect(parsed.tracker.labels).toEqual({
      triage: "needs-triage",
      implement: "ready-for-agent",
      needsInfo: "needs-info",
      readyForHuman: "ready-for-human",
      implemented: "agent-implemented",
    });
  });

  it("leaves labels and implement unset by default", () => {
    const parsed = StewardConfigSchema.parse(minimalInput);
    expect(parsed.tracker.labels).toBeUndefined();
    expect(parsed.implement).toBeUndefined();
  });

  it("fills implement defaults", () => {
    const parsed = StewardConfigSchema.parse({ ...minimalInput, tracker: { ...minimalInput.tracker, labels }, implement });
    expect(parsed.implement).toEqual({
      ...implement,
      branchTypes: ["feature", "fix", "chore", "refactor"],
      checks: [],
      checksTimeoutMinutes: 20,
      timeoutMinutes: 60,
      maxTurns: 150,
      protectedBranches: ["main", "staging", "dev"],
    });
  });

  it("rejects implement without tracker.labels", () => {
    const result = StewardConfigSchema.safeParse({ ...minimalInput, implement });
    expect(result.success).toBe(false);
  });

  it("rejects a branch type that is not lowercase kebab", () => {
    const result = StewardConfigSchema.safeParse({ ...minimalInput, tracker: { ...minimalInput.tracker, labels }, implement: { ...implement, branchTypes: ["Fix"] } });
    expect(result.success).toBe(false);
  });
});
```

Append to `test/config/load.test.ts`:

```ts
describe("implement secrets", () => {
  const writeFiles = (dir: string, env: string) => {
    const config = {
      dataDir: "./data",
      brain: { kind: "claude-code", model: "m", maxTurns: 1, timeoutMinutes: 1 },
      tracker: { kind: "linear", labels: {} },
      codehost: { kind: "gitlab", baseUrl: "https://gitlab.example", project: "acme/repo" },
      workspace: { fetchUrl: "https://gitlab.example/acme/repo.git", baseBranch: "dev", overlayDir: "./overlay", setup: [], port: 4100 },
      prompt: "./prompts/enrich.md",
      server: { port: 3020, publicUrl: "https://steward.example" },
      implement: { prompt: "./prompts/implement.md", commitAuthor: { name: "Ticket Steward", email: "steward@example.com" } },
    };
    writeFileSync(join(dir, "steward.config.ts"), `export default ${JSON.stringify(config)};\n`);
    writeFileSync(join(dir, ".env"), env);
  };

  it("fails when implement is configured without GITLAB_PUSH_TOKEN", async () => {
    const dir = mkdtempSync(join(tmpdir(), "steward-load-"));
    writeFiles(dir, "LINEAR_API_KEY=x\n");
    await expect(loadConfig({ configPath: join(dir, "steward.config.ts") })).rejects.toThrow("implement requires GITLAB_PUSH_TOKEN in .env");
  });

  it("resolves implement.prompt against the config dir and reads the push token", async () => {
    const dir = mkdtempSync(join(tmpdir(), "steward-load-"));
    writeFiles(dir, "GITLAB_PUSH_TOKEN=glpat-push-token-value\n");
    const loaded = await loadConfig({ configPath: join(dir, "steward.config.ts") });
    expect(loaded.config.implement?.prompt).toBe(join(dir, "prompts/implement.md"));
    expect(loaded.secrets.GITLAB_PUSH_TOKEN).toBe("glpat-push-token-value");
  });
});
```

(Add `import { mkdtempSync, writeFileSync } from "node:fs"; import { tmpdir } from "node:os"; import { join } from "node:path";` if the file lacks them.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/config`
Expected: FAIL (labels/implement are unknown keys and stripped; `GITLAB_PUSH_TOKEN` undefined; no throw).

- [ ] **Step 3: Implement**

In `src/config/schema.ts`, above `StewardConfigSchema`:

```ts
const LabelsSchema = z.object({
  triage: z.string().min(1).default("needs-triage"),
  implement: z.string().min(1).default("ready-for-agent"),
  needsInfo: z.string().min(1).default("needs-info"),
  readyForHuman: z.string().min(1).default("ready-for-human"),
  implemented: z.string().min(1).default("agent-implemented"),
});

const BRANCH_TYPE = /^[a-z][a-z0-9-]*$/;

const ImplementSchema = z.object({
  prompt: z.string(),
  branchTypes: z.array(z.string().regex(BRANCH_TYPE)).min(1).default(["feature", "fix", "chore", "refactor"]),
  /** Run by the steward in the worktree after the brain; `{{baseSha}}` is replaced with the job's base commit. */
  checks: z.array(z.string()).default([]),
  checksTimeoutMinutes: z.number().positive().default(20),
  commitAuthor: z.object({ name: z.string().min(1), email: z.string().min(1) }),
  timeoutMinutes: z.number().positive().default(60),
  maxTurns: z.number().int().positive().default(150),
  /** Branches doctor expects GitLab to protect from the push token. */
  protectedBranches: z.array(z.string().min(1)).default(["main", "staging", "dev"]),
});
```

In `tracker`, add after `triggerLabel`:

```ts
    /** Label-driven workflows; unset keeps the old behaviour of enriching every new ticket. */
    labels: LabelsSchema.optional(),
```

Add `implement: ImplementSchema.optional(),` after `review`. In `superRefine` add:

```ts
  if (config.implement !== undefined && config.tracker.labels === undefined) {
    ctx.addIssue({ code: "custom", path: ["implement"], message: "implement requires tracker.labels" });
  }
```

At the bottom add:

```ts
export type LabelsConfig = NonNullable<StewardConfig["tracker"]["labels"]>;
export type ImplementConfig = NonNullable<StewardConfig["implement"]>;
```

In `src/config/load.ts`: add `GITLAB_PUSH_TOKEN: z.string().optional(),` to `SecretsSchema` after `GITLAB_WEBHOOK_SIGNING_TOKEN`. In `loadConfig`, add to the `config` object after the `review` spread:

```ts
    ...(parsed.implement === undefined ? {} : { implement: { ...parsed.implement, prompt: resolveFromConfigDir(configDir, parsed.implement.prompt) } }),
```

and replace the final `return` with:

```ts
  const secrets = await readSecrets(configDir);
  if (config.implement !== undefined && (secrets.GITLAB_PUSH_TOKEN ?? "") === "") throw new Error("implement requires GITLAB_PUSH_TOKEN in .env");
  return { config, secrets, configPath, configDir };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/config && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/config test/config
git commit -m "feat(config): tracker.labels, implement block and GITLAB_PUSH_TOKEN"
```

---

### Task 2: Webhook label routing (replaces triggerLabel)

**Files:**
- Modify: `src/tracker/types.ts`
- Modify: `src/tracker/linear/webhook.ts`
- Modify: `src/server/app.ts`
- Modify: `src/config/schema.ts` (remove `triggerLabel`)
- Test: `test/tracker/linear/webhook.test.ts`, `test/server/app.test.ts`, `test/config/schema.test.ts`

**Interfaces:**
- Consumes: `LabelsConfig` (Task 1).
- Produces: `export type LabelAction = "triage" | "implement"` in `src/tracker/types.ts`; issue triggers and `cli` triggers gain optional `action?: LabelAction`; `export interface TriggerLabels { triage: string; implement: string }` and `parseEvent(headers, body, opts?: { labels?: TriggerLabels | undefined })` in `webhook.ts`.

- [ ] **Step 1: Write the failing tests**

In `test/tracker/linear/webhook.test.ts` replace the whole `describe("with a trigger label", …)` block with:

```ts
  describe("with labels", () => {
    const opts = { labels: { triage: "needs-triage", implement: "ready-for-agent" } };
    const TRIAGE = { id: "label-triage", name: "needs-triage" };
    const AGENT = { id: "label-agent", name: "ready-for-agent" };
    const withLabels = (labels: Array<{ id: string; name: string }>) => ({ ...issueCreateBody, data: { ...issueCreateBody.data, labels } });

    it("maps a create carrying needs-triage to issue.created with action triage", () => {
      expect(parseEvent({ event: "Issue", delivery: "d-1" }, withLabels([TRIAGE]), opts)).toEqual({
        kind: "issue.created",
        issueId: "issue-uuid-1",
        identifier: "API-42",
        teamKey: "API",
        deliveryId: "d-1",
        description: "Something is broken",
        stateType: "triage",
        action: "triage",
      });
    });

    it("maps a create carrying ready-for-agent to action implement", () => {
      expect(parseEvent({ event: "Issue", delivery: "d-1" }, withLabels([AGENT]), opts)?.action).toBe("implement");
    });

    it("prefers implement when both labels arrive together", () => {
      expect(parseEvent({ event: "Issue", delivery: "d-1" }, withLabels([TRIAGE, AGENT]), opts)?.action).toBe("implement");
    });

    it("matches label names case-insensitively", () => {
      expect(parseEvent({ event: "Issue", delivery: "d-1" }, withLabels([{ id: "x", name: "Needs-Triage" }]), opts)?.action).toBe("triage");
    });

    it("ignores a create without either label", () => {
      expect(parseEvent({ event: "Issue", delivery: "d-1" }, issueCreateBody, opts)).toBeNull();
    });

    it("maps an update that just added ready-for-agent to issue.labeled", () => {
      const body = issueUpdateBody([TRIAGE, AGENT], { labelIds: ["label-triage"] });
      const event = parseEvent({ event: "Issue", delivery: "d-1" }, body, opts);
      expect(event?.kind).toBe("issue.labeled");
      expect(event?.kind === "issue.labeled" ? event.action : null).toBe("implement");
    });

    it("ignores an update where the labels did not change", () => {
      expect(parseEvent({ event: "Issue", delivery: "d-1" }, issueUpdateBody([TRIAGE], { title: "Old" }), opts)).toBeNull();
    });

    it("ignores an update where the label was already there", () => {
      expect(parseEvent({ event: "Issue", delivery: "d-1" }, issueUpdateBody([TRIAGE], { labelIds: ["label-triage"] }), opts)).toBeNull();
    });
  });
```

(Remove the now-unused `STEWARD_LABEL` and `labeledCreateBody` constants.)

In `test/config/schema.test.ts` delete the two `triggerLabel` tests ("leaves triggerLabel unset by default", "rejects an empty triggerLabel").

In `test/server/app.test.ts`:
- Replace `makeConfig`'s signature and tracker line with:

```ts
const LABELS = { triage: "needs-triage", implement: "ready-for-agent", needsInfo: "needs-info", readyForHuman: "ready-for-human", implemented: "agent-implemented" };

const makeConfig = (gatewayIssues: "enrich" | "skip" = "enrich", labels?: typeof LABELS): StewardConfig => ({
  dataDir,
  brain: { kind: "claude-code", model: "claude-test", maxTurns: 5, timeoutMinutes: 1 },
  tracker: { kind: "linear", teams: ["API"], gatewayIssues, bugLabels: ["Bug"], ...(labels === undefined ? {} : { labels }) },
```

- In the `describe("with a trigger label", …)` block: rename it `"with labels"`, change `labels: [{ id: "label-steward", name: "steward" }]` to `labels: [{ id: "label-triage", name: "needs-triage" }]`, change every `["label-steward"]` to `["label-triage"]`, change `makeConfig("enrich", "steward")` to `makeConfig("enrich", LABELS)`, and in "queues a job when the label is added" add:

```ts
        expect(stores.jobs.list({ limit: 10 })[0]?.trigger).toMatchObject({ kind: "issue.labeled", action: "triage" });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/tracker/linear/webhook.test.ts test/server/app.test.ts`
Expected: FAIL (`labels` option unknown, no `action`).

- [ ] **Step 3: Implement**

`src/tracker/types.ts` — replace the first two union members:

```ts
export type LabelAction = "triage" | "implement";

export type TriggerEvent =
  | {
      kind: "issue.created" | "issue.labeled";
      issueId: string;
      identifier: string;
      teamKey: string;
      deliveryId: string;
      description: string;
      stateType: string | null;
      /** Which configured label started this; absent when labels are not configured (every new ticket is triaged). */
      action?: LabelAction;
    }
  | { kind: "cli"; issueId: string; identifier: string; teamKey: string; action?: LabelAction }
```

`src/tracker/linear/webhook.ts` — replace `IssueEventKind`, `issueEventKind` and `parseEvent` with:

```ts
type IssuePayload = z.infer<typeof IssueSchema>;

export interface TriggerLabels {
  triage: string;
  implement: string;
}

/** True when the payload carries `name` and it is new: present on a create, or absent from updatedFrom.labelIds on an update. */
const newlyAdded = (payload: IssuePayload, name: string): boolean => {
  const wanted = name.toLowerCase();
  const label = payload.data.labels?.find((candidate) => candidate.name.toLowerCase() === wanted);
  if (label === undefined) return false;
  if (payload.action === "create") return true;
  const previous = payload.updatedFrom?.labelIds;
  return previous !== undefined && previous !== null && !previous.includes(label.id);
};

/** Implement wins when both labels arrive together: the direct path skips triage. */
const labelAction = (payload: IssuePayload, labels: TriggerLabels): LabelAction | null => {
  if (newlyAdded(payload, labels.implement)) return "implement";
  if (newlyAdded(payload, labels.triage)) return "triage";
  return null;
};

export const parseEvent = (
  headers: { event: string | undefined; delivery: string | undefined },
  body: unknown,
  opts: { labels?: TriggerLabels | undefined } = {},
): TriggerEvent | null => {
  const { event, delivery } = headers;
  if (delivery === undefined || event !== "Issue") return null;
  const parsed = IssueSchema.safeParse(body);
  if (!parsed.success) return null;
  const { id, identifier, description, team, state } = parsed.data.data;
  const base = { issueId: id, identifier, teamKey: team.key, deliveryId: delivery, description: description ?? "", stateType: state?.type ?? null };
  if (opts.labels === undefined) return parsed.data.action === "create" ? { kind: "issue.created", ...base } : null;
  const action = labelAction(parsed.data, opts.labels);
  if (action === null) return null;
  return { kind: parsed.data.action === "create" ? "issue.created" : "issue.labeled", ...base, action };
};
```

and change the type import to `import type { LabelAction, TriggerEvent } from "../types.js";`.

`src/server/app.ts` — in `registerWebhook` change the `parseEvent` options to `{ labels: deps.config.tracker.labels }`.

`src/config/schema.ts` — delete the `triggerLabel` line and its comment.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm typecheck && npx vitest run test/tracker test/server test/config`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tracker src/server src/config test/tracker test/server test/config
git commit -m "feat(webhook): route by configured label; implement wins over triage"
```

---

### Task 3: Implement job kind in the store and intake

**Files:**
- Create: `src/implement/result.ts`
- Modify: `src/core/intake.ts`, `src/store/db.ts`, `src/store/jobs.ts`, `src/server/app.ts`
- Test: `test/implement/result.test.ts`, `test/core/intake.test.ts`, `test/store/jobs.test.ts`, `test/server/app.test.ts`

**Interfaces:**
- Consumes: `LabelAction`, `IssueTrigger` (Task 2).
- Produces:
  - `src/implement/result.ts`: `ImplementResultSchema`, `type ImplementResult`, `implementResultJsonSchema: Record<string, unknown>`, `validateImplementResult(output: unknown, branchTypes: string[]): { ok: true; result: ImplementResult } | { ok: false; error: string }`, `HandbackSchema`/`type Handback = { label: "readyForHuman" | "needsInfo"; reason: string; detail: string }`, `StoredImplementSchema`/`type StoredImplement = { result: ImplementResult | null; handback: Handback | null }`.
  - `src/core/intake.ts`: `type IssueJobKind = "enrich" | "implement"`, `jobKindFor(event: IssueTrigger): IssueJobKind`, `closedReason(identifier: string, state: { name: string; type: string }): string | null`.
  - `JobKind = "enrich" | "review" | "implement"`; `Job` gains `implementResult: StoredImplement | null; branch: string | null; commitSha: string | null; pushedAt: string | null`; `JobStore.findQueued(issueId, kind?: IssueJobKind)`, `hasSucceeded(issueId, kind?: IssueJobKind)` (default `"enrich"`), `saveImplementResult(id: number, stored: StoredImplement): void`, `recordCommit(id: number, branch: string, sha: string): void`, `markPushed(id: number): void`.

- [ ] **Step 1: Write the failing tests**

Create `test/implement/result.test.ts`:

```ts
import { validateImplementResult, type ImplementResult } from "../../src/implement/result.js";

const TYPES = ["feature", "fix", "chore", "refactor"];
const implemented: ImplementResult = {
  outcome: "implemented",
  branchType: "fix",
  commitMessage: "Keep the last chunk\n\nThe adapter dropped it.",
  summary: "Flush the buffer before closing.",
  reviewNotes: [],
  checksRun: ["pnpm turbo check-types: ok"],
  questions: [],
  failureDetail: null,
};

describe("validateImplementResult", () => {
  it("accepts a complete implemented result", () => {
    expect(validateImplementResult(implemented, TYPES)).toEqual({ ok: true, result: implemented });
  });

  it("rejects a branch type outside the configured list", () => {
    const result = validateImplementResult({ ...implemented, branchType: "hotfix" }, TYPES);
    expect(result).toEqual({ ok: false, error: 'branchType "hotfix" is not one of feature, fix, chore, refactor' });
  });

  it("rejects implemented without a commit message", () => {
    expect(validateImplementResult({ ...implemented, commitMessage: " " }, TYPES).ok).toBe(false);
  });

  it("requires questions for needs_info", () => {
    expect(validateImplementResult({ ...implemented, outcome: "needs_info", branchType: null, questions: [] }, TYPES).ok).toBe(false);
    expect(validateImplementResult({ ...implemented, outcome: "needs_info", branchType: null, questions: ["Which page?"] }, TYPES).ok).toBe(true);
  });

  it("requires failureDetail for failed", () => {
    expect(validateImplementResult({ ...implemented, outcome: "failed", branchType: null }, TYPES).ok).toBe(false);
    expect(validateImplementResult({ ...implemented, outcome: "failed", branchType: null, failureDetail: "tests fail" }, TYPES).ok).toBe(true);
  });

  it("rejects an empty summary", () => {
    expect(validateImplementResult({ ...implemented, summary: "" }, TYPES).ok).toBe(false);
  });
});
```

Append to `test/core/intake.test.ts`:

```ts
describe("implement intake", () => {
  const implementEvent: TriggerEvent = { ...created, kind: "issue.labeled", action: "implement" };

  it("maps action implement to the implement job kind", () => {
    expect(jobKindFor(implementEvent)).toBe("implement");
    expect(jobKindFor(created)).toBe("enrich");
    expect(jobKindFor({ ...cli, action: "implement" })).toBe("implement");
  });

  it("enqueues an implement event on an already-enriched ticket", () => {
    const description = `Body\n\n${STEWARD_BEGIN}\n## Enrichment\n${STEWARD_END}`;
    expect(shouldEnqueue({ ...base, event: { ...implementEvent, description } })).toEqual({ action: "enqueue" });
  });

  it("skips an implement event when a prior implement job succeeded", () => {
    expect(shouldEnqueue({ ...base, event: implementEvent, priorSuccess: true })).toEqual({ action: "skip", reason: "API-1 was already implemented" });
  });

  it("skips an implement event for a closed ticket", () => {
    expect(shouldEnqueue({ ...base, event: { ...implementEvent, stateType: "completed" } }).action).toBe("skip");
  });

  it("names a closed state", () => {
    expect(closedReason("API-1", { name: "Done", type: "completed" })).toBe("API-1 is Done; Ticket Steward does not work on Done or Canceled tickets");
    expect(closedReason("API-1", { name: "Todo", type: "unstarted" })).toBeNull();
  });
});
```

(Extend the import to `import { closedReason, jobKindFor, shouldEnqueue, STEWARD_BEGIN, STEWARD_END } from "../../src/core/intake.js";`.)

Append to `test/store/jobs.test.ts` (it uses `freshDataDir`, `createdEvent` from `./helpers.js` and `openStores`; follow its existing setup for `stores`):

```ts
describe("implement jobs", () => {
  const implementEvent = { ...createdEvent, kind: "issue.labeled" as const, action: "implement" as const };

  it("stores an implement trigger as kind implement", () => {
    const id = stores.jobs.enqueue(implementEvent);
    expect(stores.jobs.get(id)?.kind).toBe("implement");
  });

  it("scopes findQueued and hasSucceeded by kind", () => {
    const id = stores.jobs.enqueue(implementEvent);
    expect(stores.jobs.findQueued("issue-1")).toBeNull();
    expect(stores.jobs.findQueued("issue-1", "implement")?.id).toBe(id);
    stores.jobs.claimById(id);
    stores.jobs.finish(id, { status: "succeeded" });
    expect(stores.jobs.hasSucceeded("issue-1")).toBe(false);
    expect(stores.jobs.hasSucceeded("issue-1", "implement")).toBe(true);
  });

  it("records the stored result, commit and push", () => {
    const id = stores.jobs.enqueue(implementEvent);
    stores.jobs.saveImplementResult(id, { result: null, handback: { label: "readyForHuman", reason: "branch exists", detail: "fix/API-1-x" } });
    stores.jobs.recordCommit(id, "fix/API-1-x", "a".repeat(40));
    stores.jobs.markPushed(id);
    const job = stores.jobs.get(id);
    expect(job?.implementResult?.handback?.reason).toBe("branch exists");
    expect(job?.branch).toBe("fix/API-1-x");
    expect(job?.commitSha).toBe("a".repeat(40));
    expect(job?.pushedAt).not.toBeNull();
  });
});
```

Append to `test/server/app.test.ts` inside `describe("with labels", …)`:

```ts
      it("queues an implement job when ready-for-agent is added to an enriched ticket", async () => {
        const body = JSON.stringify({
          action: "update",
          type: "Issue",
          data: {
            id: "issue-1",
            identifier: "API-1",
            description: "Body\n\n<!-- ticket-steward:begin -->\n## Enrichment\n<!-- ticket-steward:end -->",
            team: { key: "API" },
            state: { name: "Todo", type: "unstarted" },
            labels: [{ id: "label-agent", name: "ready-for-agent" }],
          },
          updatedFrom: { labelIds: [] },
        });
        const response = await post("Issue", "delivery-9", body);

        expect(response.json()).toEqual({ ok: true, action: "enqueue" });
        expect(stores.jobs.list({ limit: 10 })[0]?.kind).toBe("implement");
      });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/implement test/core/intake.test.ts test/store test/server`
Expected: FAIL (module/exports missing).

- [ ] **Step 3: Implement**

Create `src/implement/result.ts`:

```ts
import { z } from "zod";

export const ImplementResultSchema = z.object({
  outcome: z.enum(["implemented", "failed", "needs_info"]),
  /** implemented only; validated against implement.branchTypes in code (config-driven, so not a schema enum). */
  branchType: z.string().nullable(),
  commitMessage: z.string(),
  summary: z.string(),
  reviewNotes: z.array(z.string()),
  checksRun: z.array(z.string()),
  questions: z.array(z.string()),
  failureDetail: z.string().nullable(),
});
export type ImplementResult = z.infer<typeof ImplementResultSchema>;

export const implementResultJsonSchema: Record<string, unknown> = z.toJSONSchema(ImplementResultSchema, { target: "draft-07" });

export const validateImplementResult = (output: unknown, branchTypes: string[]): { ok: true; result: ImplementResult } | { ok: false; error: string } => {
  const parsed = ImplementResultSchema.safeParse(output);
  if (!parsed.success) return { ok: false, error: z.prettifyError(parsed.error) };
  const result = parsed.data;
  if (result.summary.trim() === "") return { ok: false, error: "summary is empty" };
  if (result.outcome === "implemented") {
    if (result.branchType === null || !branchTypes.includes(result.branchType)) {
      return { ok: false, error: `branchType "${result.branchType ?? "null"}" is not one of ${branchTypes.join(", ")}` };
    }
    if (result.commitMessage.trim() === "") return { ok: false, error: "commitMessage is empty" };
  }
  if (result.outcome === "needs_info" && result.questions.every((q) => q.trim() === "")) return { ok: false, error: "needs_info without questions" };
  if (result.outcome === "failed" && (result.failureDetail === null || result.failureDetail.trim() === "")) return { ok: false, error: "failed without failureDetail" };
  return { ok: true, result };
};

export const HandbackSchema = z.object({
  label: z.enum(["readyForHuman", "needsInfo"]),
  /** One line, shown in the job warning and the comment's first line. */
  reason: z.string(),
  /** Longer text for the comment (output tails, paths); already redacted. */
  detail: z.string(),
});
export type Handback = z.infer<typeof HandbackSchema>;

export const StoredImplementSchema = z.object({
  /** null when the job handed back before the brain ran (e.g. the branch already exists). */
  result: ImplementResultSchema.nullable(),
  handback: HandbackSchema.nullable(),
});
export type StoredImplement = z.infer<typeof StoredImplementSchema>;
```

`src/core/intake.ts` — add after `CLOSED_STATE_TYPES`:

```ts
export type IssueJobKind = "enrich" | "implement";

export const jobKindFor = (event: IssueTrigger): IssueJobKind => (event.action === "implement" ? "implement" : "enrich");

export const closedReason = (identifier: string, state: { name: string; type: string }): string | null =>
  CLOSED_STATE_TYPES.includes(state.type) ? `${identifier} is ${state.name}; Ticket Steward does not work on Done or Canceled tickets` : null;
```

and in `shouldEnqueue`, right after the closed-state check, insert:

```ts
  if (jobKindFor(event) === "implement") {
    if (priorSuccess) return { action: "skip", reason: `${event.identifier} was already implemented` };
    return hasQueuedJob ? { action: "attach" } : { action: "enqueue" };
  }
```

`src/store/db.ts` — add to the `CREATE TABLE jobs` column list after `review_result TEXT`:

```sql
  review_result TEXT,
  implement_result TEXT,
  branch TEXT,
  commit_sha TEXT,
  pushed_at TEXT
```

(replace the existing `review_result TEXT` line so commas stay valid) and append to `ADDED_COLUMNS`:

```ts
  { table: "jobs", column: "implement_result", definition: "TEXT" },
  { table: "jobs", column: "branch", definition: "TEXT" },
  { table: "jobs", column: "commit_sha", definition: "TEXT" },
  { table: "jobs", column: "pushed_at", definition: "TEXT" },
```

`src/store/jobs.ts`:
- imports: add `import { jobKindFor, type IssueJobKind } from "../core/intake.js";` and `import { StoredImplementSchema, type StoredImplement } from "../implement/result.js";`
- `export type JobKind = "enrich" | "review" | "implement";`
- `Job` add `implementResult: StoredImplement | null; branch: string | null; commitSha: string | null; pushedAt: string | null;`; `JobRow` add `implement_result: string | null; branch: string | null; commit_sha: string | null; pushed_at: string | null;`; `toJob` add:

```ts
  implementResult: row.implement_result === null ? null : StoredImplementSchema.parse(JSON.parse(row.implement_result)),
  branch: row.branch,
  commitSha: row.commit_sha,
  pushedAt: row.pushed_at,
```

- `jobColumns` non-review branch: `kind: jobKindFor(event)` instead of `"enrich"`.
- Statements: change `selectQueued` to `db.prepare<[string, IssueJobKind], JobRow>("SELECT * FROM jobs WHERE issue_id = ? AND status = 'queued' AND kind = ? ORDER BY id LIMIT 1")` and `existsSucceeded` to `db.prepare<[string, IssueJobKind], { found: number }>("SELECT EXISTS (SELECT 1 FROM jobs WHERE issue_id = ? AND status = 'succeeded' AND kind = ?) AS found")`; add fields and constructor lines:

```ts
    this.storeImplement = db.prepare<[string, number]>("UPDATE jobs SET implement_result = ? WHERE id = ?");
    this.storeCommit = db.prepare<[string, string, number]>("UPDATE jobs SET branch = ?, commit_sha = ? WHERE id = ?");
    this.storePushed = db.prepare<[string, number]>("UPDATE jobs SET pushed_at = ? WHERE id = ?");
```

- Methods:

```ts
  findQueued(issueId: string, kind: IssueJobKind = "enrich"): Job | null {
    const row = this.selectQueued.get(issueId, kind);
    return row === undefined ? null : toJob(row);
  }

  hasSucceeded(issueId: string, kind: IssueJobKind = "enrich"): boolean {
    return this.existsSucceeded.get(issueId, kind)?.found === 1;
  }

  saveImplementResult(id: number, stored: StoredImplement): void {
    this.storeImplement.run(JSON.stringify(stored), id);
  }

  recordCommit(id: number, branch: string, sha: string): void {
    this.storeCommit.run(branch, sha, id);
  }

  markPushed(id: number): void {
    this.storePushed.run(nowIso(), id);
  }
```

`src/server/app.ts` `intake`: import `jobKindFor` from `../core/intake.js` and use

```ts
    const kind = jobKindFor(event);
    const decision = shouldEnqueue({
      event,
      allowlist: deps.config.tracker.teams,
      gatewayIssues: deps.config.tracker.gatewayIssues,
      priorSuccess: jobs.hasSucceeded(event.issueId, kind),
      hasQueuedJob: jobs.findQueued(event.issueId, kind) !== null,
    });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm typecheck && npx vitest run`
Expected: PASS (whole suite: the store change touches the worker and CLI).

- [ ] **Step 5: Commit**

```bash
git add src/implement/result.ts src/core/intake.ts src/store src/server test/implement test/core/intake.test.ts test/store test/server
git commit -m "feat(store): implement job kind, per-kind intake and implement result schema"
```

---

### Task 4: Tracker label swap

**Files:**
- Modify: `src/tracker/types.ts`, `src/tracker/linear/client.ts`, `src/tracker/readOnly.ts`, `test/fakes/fakeTracker.ts`
- Test: `test/tracker/linear/client.test.ts`, `test/tracker/readOnly.test.ts`

**Interfaces:**
- Produces: `Tracker.swapLabel(issueId: string, from: string, to: string): Promise<void>` — adds `to` (if absent) **then** removes `from` (if present); names matched case-insensitively; a team label beats a workspace label of the same name; throws `Linear label "<to>" does not exist for this team or the workspace` when missing. `FakeTracker.labelSwaps(): Array<{ issueId: string; from: string; to: string }>`, `FakeTracker.labelsOf(issueId): string[]` and `FakeTracker.failNextSwap(): void` (next `swapLabel` throws `Linear down`). `RecordedWrite["method"]` gains `"swapLabel"`.

- [ ] **Step 1: Write the failing tests**

In `test/tracker/linear/client.test.ts` add mocks next to the existing ones and to `fakeClient`:

```ts
const issueAddLabelMock = vi.fn<LinearClient["issueAddLabel"]>();
const issueRemoveLabelMock = vi.fn<LinearClient["issueRemoveLabel"]>();
const issueLabelsMock = vi.fn<LinearClient["issueLabels"]>();
```

(`fakeClient` gains `issueAddLabel: issueAddLabelMock, issueRemoveLabel: issueRemoveLabelMock, issueLabels: issueLabelsMock`.) Then:

```ts
describe("LinearTracker.swapLabel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clientFactoryMock.mockReturnValue(fakeClient);
    issueAddLabelMock.mockResolvedValue(okPayload as never);
    issueRemoveLabelMock.mockResolvedValue(okPayload as never);
    issueMock.mockResolvedValue({
      labels: async () => ({ nodes: [{ id: "l-triage", name: "needs-triage" }] }),
      team: Promise.resolve({ id: "team-1" }),
    } as never);
    issueLabelsMock.mockResolvedValue({
      nodes: [
        { id: "l-info-workspace", team: undefined },
        { id: "l-info-team", team: Promise.resolve({ id: "team-1" }) },
      ],
    } as never);
  });

  it("adds the team label first, then removes the old one", async () => {
    await makeTracker().swapLabel("issue-1", "Needs-Triage", "needs-info");
    expect(issueLabelsMock).toHaveBeenCalledWith({ filter: { name: { eqIgnoreCase: "needs-info" } } });
    expect(issueAddLabelMock).toHaveBeenCalledWith("issue-1", "l-info-team");
    expect(issueRemoveLabelMock).toHaveBeenCalledWith("issue-1", "l-triage");
    expect(issueAddLabelMock.mock.invocationCallOrder[0]).toBeLessThan(issueRemoveLabelMock.mock.invocationCallOrder[0] ?? 0);
  });

  it("falls back to the workspace label", async () => {
    issueLabelsMock.mockResolvedValue({ nodes: [{ id: "l-info-workspace", team: undefined }] } as never);
    await makeTracker().swapLabel("issue-1", "needs-triage", "needs-info");
    expect(issueAddLabelMock).toHaveBeenCalledWith("issue-1", "l-info-workspace");
  });

  it("fails when the target label does not exist", async () => {
    issueLabelsMock.mockResolvedValue({ nodes: [] } as never);
    await expect(makeTracker().swapLabel("issue-1", "needs-triage", "needs-info")).rejects.toThrow('Linear label "needs-info" does not exist for this team or the workspace');
    expect(issueRemoveLabelMock).not.toHaveBeenCalled();
  });

  it("skips the removal when the old label is absent", async () => {
    await makeTracker().swapLabel("issue-1", "ready-for-agent", "needs-info");
    expect(issueRemoveLabelMock).not.toHaveBeenCalled();
  });
});
```

In `test/tracker/readOnly.test.ts` add:

```ts
it("records swapLabel without forwarding it", async () => {
  const inner = new FakeTracker([issue]);
  const tracker = new ReadOnlyTracker(inner);
  await tracker.swapLabel("issue-1", "needs-triage", "needs-info");
  expect(tracker.writes).toEqual([{ method: "swapLabel", args: ["issue-1", "needs-triage", "needs-info"] }]);
  expect(inner.labelSwaps()).toEqual([]);
});
```

(Use the file's existing `issue` fixture and imports; add `FakeTracker` import if missing.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/tracker`
Expected: FAIL (`swapLabel` not a function).

- [ ] **Step 3: Implement**

`src/tracker/types.ts` — add to `Tracker`:

```ts
  /** Adds `to` (if missing), then removes `from` (if present); names match case-insensitively. */
  swapLabel(issueId: string, from: string, to: string): Promise<void>;
```

`src/tracker/linear/client.ts` — add to `LinearTracker`:

```ts
  async swapLabel(issueId: string, from: string, to: string): Promise<void> {
    await this.write(async (client) => {
      const issue = await client.issue(issueId);
      const [labels, team] = await Promise.all([issue.labels(), issue.team]);
      const target = await labelIdFor(client, to, team?.id ?? null);
      if (!labels.nodes.some((label) => label.id === target)) await client.issueAddLabel(issueId, target);
      const wanted = from.toLowerCase();
      const current = labels.nodes.find((label) => label.name.toLowerCase() === wanted);
      if (current !== undefined) await client.issueRemoveLabel(issueId, current.id);
    });
  }
```

and a module-level helper above the class:

```ts
/** A team's own label wins over a workspace label of the same name. */
const labelIdFor = async (client: LinearClient, name: string, teamId: string | null): Promise<string> => {
  const found = await client.issueLabels({ filter: { name: { eqIgnoreCase: name } } });
  const owners = await Promise.all(found.nodes.map(async (label) => ({ id: label.id, teamId: (await label.team)?.id ?? null })));
  const match = owners.find((owner) => owner.teamId !== null && owner.teamId === teamId) ?? owners.find((owner) => owner.teamId === null);
  if (match === undefined) throw new Error(`Linear label "${name}" does not exist for this team or the workspace`);
  return match.id;
};
```

`src/tracker/readOnly.ts` — `method: "writeDescription" | "postComment" | "uploadFile" | "swapLabel";` and:

```ts
  async swapLabel(issueId: string, from: string, to: string): Promise<void> {
    this.record("swapLabel", [issueId, from, to]);
  }
```

`test/fakes/fakeTracker.ts` — add fields `private readonly swaps: Array<{ issueId: string; from: string; to: string }> = [];` and `private failingSwaps = 0;`, and:

```ts
  labelSwaps(): Array<{ issueId: string; from: string; to: string }> {
    return [...this.swaps];
  }

  labelsOf(issueId: string): string[] {
    return [...this.issue(issueId).labels];
  }

  failNextSwap(): void {
    this.failingSwaps += 1;
  }

  async swapLabel(issueId: string, from: string, to: string): Promise<void> {
    if (this.failingSwaps > 0) {
      this.failingSwaps -= 1;
      throw new Error("Linear down");
    }
    this.write();
    const current = this.issue(issueId);
    const kept = current.labels.filter((label) => label.toLowerCase() !== from.toLowerCase());
    const labels = kept.some((label) => label.toLowerCase() === to.toLowerCase()) ? kept : [...kept, to];
    this.issues.set(issueId, { ...current, labels });
    this.swaps.push({ issueId, from, to });
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm typecheck && npx vitest run test/tracker`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tracker test/tracker test/fakes/fakeTracker.ts
git commit -m "feat(tracker): swapLabel (add new first, then remove old)"
```

---

### Task 5: Triage verdict (result, section, comment, label swap, prompt)

**Files:**
- Modify: `src/core/result.ts`, `src/core/render.ts`, `src/core/pipeline.ts`, `src/cli/enrich.ts` (only if it references `buildComment`), `prompts/enrich.md`
- Test: `test/core/result.test.ts`, `test/core/render.test.ts`, `test/core/pipeline.test.ts`, plus every test fixture typed `BrainResult`

**Interfaces:**
- Consumes: `Tracker.swapLabel` (Task 4), `LabelsConfig` (Task 1), `TriggerEvent.action` (Task 2).
- Produces: `BrainResult.triage: { state: "needs-info" | "ready-for-human"; questions: string[]; agentBrief: string | null }`; `BRIEF_BEGIN = "<!-- ticket-steward:brief:begin -->"`, `BRIEF_END = "<!-- ticket-steward:brief:end -->"` exported from `src/core/render.ts`; `buildTriageComment(result: BrainResult, jobId: number): string` replaces `buildComment`.

- [ ] **Step 1: Write the failing tests**

`test/core/result.test.ts` — add `triage: { state: "ready-for-human", questions: [], agentBrief: "Goal: keep the last chunk." }` to its base fixture, then:

```ts
describe("triage validation", () => {
  it("requires questions for needs-info", () => {
    expect(validateResult({ ...base, triage: { state: "needs-info", questions: [], agentBrief: null } })).toEqual({ ok: false, error: "triage needs-info without questions" });
  });

  it("requires an agent brief for ready-for-human", () => {
    expect(validateResult({ ...base, triage: { state: "ready-for-human", questions: [], agentBrief: null } })).toEqual({ ok: false, error: "triage ready-for-human without an agentBrief" });
  });

  it("rejects a result without triage", () => {
    const { triage: _omitted, ...rest } = base;
    expect(validateResult(rest).ok).toBe(false);
  });
});
```

(Use the fixture name the file already uses in place of `base`.)

`test/core/render.test.ts` — add:

```ts
describe("triage rendering", () => {
  const meta = { now: new Date("2026-09-11T14:02:30.000Z"), sha: "a".repeat(40), branch: "dev", jobId: 7, permalink: (p: string) => `https://x/${p}` };

  it("puts the agent brief between markers for ready-for-human", () => {
    const section = buildEnrichmentSection({ ...result, triage: { state: "ready-for-human", questions: [], agentBrief: "Goal: fix it." } }, [], [], meta);
    expect(section).toContain(`### Agent brief\n${BRIEF_BEGIN}\nGoal: fix it.\n${BRIEF_END}`);
  });

  it("has no brief for needs-info", () => {
    const section = buildEnrichmentSection({ ...result, triage: { state: "needs-info", questions: ["Which page?"], agentBrief: null } }, [], [], meta);
    expect(section).not.toContain(BRIEF_BEGIN);
  });

  it("lists numbered questions in the needs-info comment", () => {
    const comment = buildTriageComment({ ...result, confidence: "medium", triage: { state: "needs-info", questions: ["Which page?", "Which browser?"], agentBrief: null } }, 7);
    expect(comment).toBe("Triage (job 7, confidence medium): this ticket needs more information before it can be built.\n\n1. Which page?\n2. Which browser?");
  });

  it("points at the brief in the ready-for-human comment", () => {
    const comment = buildTriageComment({ ...result, confidence: "high", summary: "Flush before close.", triage: { state: "ready-for-human", questions: [], agentBrief: "Goal" } }, 7);
    expect(comment).toBe("Triage (job 7, confidence high): ready to build; the agent brief is in the Enrichment section. Flush before close.");
  });
});
```

(`result` = the file's existing `BrainResult` fixture; add `triage` to it; import `BRIEF_BEGIN, BRIEF_END, buildTriageComment`.)

`test/core/pipeline.test.ts`:
- add `triage: { state: "ready-for-human", questions: [], agentBrief: "Goal: keep the last chunk." }` to `brainResult`;
- change `expectedComment` to `` (jobId: number): string => `Triage (job ${jobId}, confidence high): ready to build; the agent brief is in the Enrichment section. The adapter truncates the final chunk.` ``;
- replace `expectedSection` with (the brief follows the enrichment text; any notes passed as `extra` follow the brief):

```ts
const expectedSection = (sha: string, jobId: number, extra = ""): string =>
  [
    "<!-- ticket-steward:begin -->",
    "## Enrichment",
    `_Ticket Steward · 2026-09-11 14:02 UTC · main@${sha.slice(0, 7)} · confidence: high · job ${jobId}_`,
    "",
    "**Template:** Bugs — missing: Repro Steps",
    "",
    `See [src/adapter.ts:12](https://fake.example/blob/${sha}/src/adapter.ts#L12).`,
    "",
    "### Agent brief",
    "<!-- ticket-steward:brief:begin -->",
    "Goal: keep the last chunk.",
    `<!-- ticket-steward:brief:end -->${extra}`,
    "<!-- ticket-steward:end -->",
  ].join("\n");
```

- add a labels-enabled config helper and tests:

```ts
const LABELS = { triage: "needs-triage", implement: "ready-for-agent", needsInfo: "needs-info", readyForHuman: "ready-for-human", implemented: "agent-implemented" };
const withLabels = (config: StewardConfig): StewardConfig => ({ ...config, tracker: { ...config.tracker, labels: LABELS } });

  it("swaps needs-triage for ready-for-human last when triggered by the triage label", async () => {
    tracker.addIssue({ ...issue, labels: ["bug", "needs-triage"] });
    const ctx = claimJob({ ...createdTrigger, action: "triage" });

    const outcome = await runJob(ctx, makeDeps(brainWith(), { config: withLabels(makeConfig()) }));

    expect(outcome).toEqual({ status: "succeeded" });
    expect(tracker.labelSwaps()).toEqual([{ issueId: "issue-1", from: "needs-triage", to: "ready-for-human" }]);
    expect(tracker.labelsOf("issue-1")).toEqual(["bug", "ready-for-human"]);
  });

  it("swaps to needs-info for a needs-info verdict", async () => {
    tracker.addIssue({ ...issue, labels: ["needs-triage"] });
    const ctx = claimJob({ ...createdTrigger, action: "triage" });
    const brain = brainWith({ result: { ...brainResult, triage: { state: "needs-info", questions: ["Which page?"], agentBrief: null } } });

    await runJob(ctx, makeDeps(brain, { config: withLabels(makeConfig()) }));

    expect(tracker.labelsOf("issue-1")).toEqual(["needs-info"]);
  });

  it("leaves labels alone for a job without the triage action", async () => {
    const ctx = claimJob(createdTrigger);
    await runJob(ctx, makeDeps(brainWith(), { config: withLabels(makeConfig()) }));
    expect(tracker.labelSwaps()).toEqual([]);
  });

  it("keeps needs-triage and reports publish_failed when the label swap fails", async () => {
    tracker.addIssue({ ...issue, labels: ["needs-triage"] });
    const ctx = claimJob({ ...createdTrigger, action: "triage" });
    tracker.failNextSwap();
    const outcome = await runJob(ctx, makeDeps(brainWith(), { config: withLabels(makeConfig()) }));

    expect(outcome).toEqual({ status: "publish_failed", error: "labels: Linear down" });
    expect(tracker.labelsOf("issue-1")).toEqual(["needs-triage"]);
  });
```

Then fix every other `BrainResult` fixture in the tests: run `grep -rln 'confidence: "high"' test` and add the same `triage` object to each result literal that has `template:`/`enrichment:` fields.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/core`
Expected: FAIL.

- [ ] **Step 3: Implement**

`src/core/result.ts`:

```ts
export const TriageSchema = z.object({
  state: z.enum(["needs-info", "ready-for-human"]),
  questions: z.array(z.string()),
  agentBrief: z.string().nullable(),
});
export type Triage = z.infer<typeof TriageSchema>;
```

add `triage: TriageSchema,` to `BrainResultSchema` (after `repro`), and in `validateResult` before the final return:

```ts
  const { triage } = parsed.data;
  if (triage.state === "needs-info" && triage.questions.every((q) => q.trim() === "")) return { ok: false, error: "triage needs-info without questions" };
  if (triage.state === "ready-for-human" && (triage.agentBrief === null || triage.agentBrief.trim() === "")) return { ok: false, error: "triage ready-for-human without an agentBrief" };
```

`src/core/render.ts`:

```ts
export const BRIEF_BEGIN = "<!-- ticket-steward:brief:begin -->";
export const BRIEF_END = "<!-- ticket-steward:brief:end -->";

const briefBlock = (triage: BrainResult["triage"], permalink: SectionMeta["permalink"]): string =>
  triage.state === "ready-for-human" && triage.agentBrief !== null
    ? ["### Agent brief", BRIEF_BEGIN, linkify(triage.agentBrief.trim(), permalink), BRIEF_END].join("\n")
    : "";
```

In `buildEnrichmentSection`'s `blocks` array insert `briefBlock(result.triage, meta.permalink),` directly after the `linkify(result.enrichment…)` entry. Replace `buildComment` with:

```ts
export const buildTriageComment = (result: BrainResult, jobId: number): string => {
  const head = `Triage (job ${jobId}, confidence ${result.confidence}): `;
  if (result.triage.state === "needs-info") {
    const questions = result.triage.questions.filter((q) => q.trim() !== "").map((q, index) => `${index + 1}. ${q.trim()}`);
    return [`${head}this ticket needs more information before it can be built.`, "", ...questions].join("\n");
  }
  return `${head}ready to build; the agent brief is in the Enrichment section. ${truncate(result.summary, SUMMARY_MAX)}`;
};
```

`src/core/pipeline.ts` — import `buildTriageComment` instead of `buildComment`, and replace the comment part of `publish` (from `const comment = buildComment(…)` to the end of the function) with:

```ts
  let warning: string | undefined;
  try {
    await tracker.postComment(ctx.issueId, buildTriageComment(result, ctx.jobId));
  } catch (err) {
    warning = errorMessage(err);
  }
  const labels = config.tracker.labels;
  if (ctx.trigger.kind !== "mr.review" && ctx.trigger.action === "triage" && labels !== undefined) {
    const target = result.triage.state === "needs-info" ? labels.needsInfo : labels.readyForHuman;
    try {
      await tracker.swapLabel(ctx.issueId, labels.triage, target);
    } catch (err) {
      return { status: "publish_failed", error: `labels: ${errorMessage(err)}` };
    }
  }
  return warning === undefined ? { status: "succeeded" } : { status: "succeeded", warning };
```

If `grep -rn buildComment src` shows other users, switch them to `buildTriageComment`.

`prompts/enrich.md` — add after step 6 (before the output description):

```md
7. Give a triage verdict in the `triage` field.
   - `needs-info` when something only a person can supply is missing: expected behaviour, acceptance criteria, reproduction details the code cannot settle, or a product decision. Put each specific question in `questions` (what you need and why), and set `agentBrief` to null.
   - `ready-for-human` when the ticket plus your enrichment is enough to build from. Set `questions` to an empty list and write `agentBrief` for an agent that has only the ticket and this brief and cannot ask questions. Use these headings: **Goal**, **Acceptance criteria** (a checklist), **Files to change** (as `path:line`), **Approach**, **Out of scope**.
   You never decide whether an agent implements the ticket; a person does that after reading your verdict.
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm typecheck && pnpm lint && npx vitest run`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core prompts/enrich.md test src/cli
git commit -m "feat(triage): triage verdict, agent brief section and label swap"
```

---

### Task 6: Brain plumbing for implement (output kind, env, limits, job dir)

**Files:**
- Modify: `src/brain/types.ts`, `src/brain/claudeCode.ts`, `src/brain/openaiAgents.ts`, `src/brain/env.ts`, `src/brain/index.ts`, `src/core/workspace.ts`
- Test: `test/brain/env.test.ts`, `test/brain/claudeCode.test.ts`, `test/core/workspace.test.ts`

**Interfaces:**
- Consumes: `implementResultJsonSchema`, `ImplementResultSchema` (Task 3).
- Produces: `BrainOutput = "enrich" | "review" | "implement"`; `buildWorkspaceEnv(port: number): Record<string, string>` (no credentials) exported from `src/brain/index.ts`; `brainInput(deps, paths, worktree, prompt, env, output, limits?: { timeoutMinutes: number; maxTurns: number })`; `JobPaths.jobDir: string`.

- [ ] **Step 1: Write the failing tests**

`test/brain/env.test.ts` add:

```ts
it("builds a workspace env without any credentials", () => {
  const env = buildWorkspaceEnv(4100);
  expect(env.STEWARD_PORT).toBe("4100");
  expect(Object.keys(env).filter((key) => /KEY|TOKEN|SECRET/.test(key))).toEqual([]);
});
```

`test/brain/claudeCode.test.ts` add (reuse the file's `queryImpl` stub pattern and input fixture):

```ts
it("asks for the implement schema when output is implement", async () => {
  let seen: Options | undefined;
  const brain = createClaudeCodeBrain({ queryImpl: ({ options }) => { seen = options; return successStream(); } });
  await brain.run({ ...input, output: "implement" }, () => undefined);
  expect(seen?.outputFormat).toEqual({ type: "json_schema", schema: implementResultJsonSchema });
});
```

(`successStream`/`input` = the helpers the file already uses; import `implementResultJsonSchema`.)

`test/core/workspace.test.ts` add (use its existing deps/paths/worktree fixtures):

```ts
it("uses per-kind limits when given", () => {
  const input = brainInput(deps, paths, worktree, "prompt", {}, "implement", { timeoutMinutes: 60, maxTurns: 150 });
  expect(input.timeoutMs).toBe(3_600_000);
  expect(input.maxTurns).toBe(150);
  expect(input.output).toBe("implement");
});

it("exposes the job directory", () => {
  expect(jobPaths(ctx, deps).jobDir).toBe(join(deps.config.dataDir, "jobs", String(ctx.jobId)));
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/brain test/core/workspace.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

`src/brain/types.ts`: `export type BrainOutput = "enrich" | "review" | "implement";`

`src/brain/claudeCode.ts`: import `implementResultJsonSchema` from `../implement/result.js` and set `OUTPUT_SCHEMAS = { enrich: brainResultJsonSchema, review: reviewResultJsonSchema, implement: implementResultJsonSchema }`.

`src/brain/openaiAgents.ts`: import `ImplementResultSchema`; widen `agentFor`'s type parameter to `typeof BrainResultSchema | typeof ReviewResultSchema | typeof ImplementResultSchema`; replace the agent selection with:

```ts
      const agent =
        input.output === "review"
          ? agentFor(input, servers, processes, ReviewResultSchema)
          : input.output === "implement"
            ? agentFor(input, servers, processes, ImplementResultSchema)
            : agentFor(input, servers, processes, BrainResultSchema);
```

`src/brain/env.ts`:

```ts
/** The job's process env without any credential: setup, checks and commit hooks run with this. */
export const buildWorkspaceEnv = (port: number): Record<string, string> => ({
  PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
  HOME: process.env.HOME ?? homedir(),
  LANG: process.env.LANG ?? "C.UTF-8",
  TERM: process.env.TERM ?? "dumb",
  NODE_ENV: "development",
  STEWARD_PORT: String(port),
  PORT: String(port),
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
  CI: "1",
});

export const buildBrainEnv = (secrets: Secrets, brain: BrainConfig, port: number): Record<string, string> => ({
  ...buildWorkspaceEnv(port),
  ...credentialEnv(secrets, brain),
});
```

`src/brain/index.ts`: `export { buildBrainEnv, buildWorkspaceEnv } from "./env.js";`

`src/core/workspace.ts`:
- `JobPaths` add `jobDir: string;` and in `jobPaths` return `jobDir,` (the existing `jobDir` local).
- `brainInput(…, output: BrainOutput, limits?: { timeoutMinutes: number; maxTurns: number })`, with
  `timeoutMs: (limits?.timeoutMinutes ?? config.brain.timeoutMinutes) * MINUTE_MS,` and `maxTurns: limits?.maxTurns ?? config.brain.maxTurns,`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm typecheck && npx vitest run test/brain test/core`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/brain src/core/workspace.ts test/brain test/core/workspace.test.ts
git commit -m "feat(brain): implement output kind, credential-free workspace env, per-kind limits"
```

---

### Task 7: Branch naming, brief extraction, implement prompt

**Files:**
- Create: `src/implement/branch.ts`, `src/implement/brief.ts`, `src/implement/prompt.ts`, `prompts/implement.md`
- Test: `test/implement/branch.test.ts`, `test/implement/brief.test.ts`, `test/implement/prompt.test.ts`

**Interfaces:**
- Consumes: `BRIEF_BEGIN`, `BRIEF_END` (Task 5).
- Produces: `slugify(title: string): string`; `branchName(type: string, identifier: string, title: string): string`; `branchRefPattern(types: string[], identifier: string): RegExp`; `carriesTicket(ref: string, identifier: string): boolean`; `extractAgentBrief(description: string): string | null`; `interface ImplementPromptVars { identifier: string; teamKey: string; teamName: string; ticket: string; workspacePath: string; baseBranch: string; sha: string; artifactsDir: string; stewardPort: number; hasBrief: boolean; brief: string; branchTypes: string }`; `renderImplementPrompt(template: string, vars: ImplementPromptVars): string`.

- [ ] **Step 1: Write the failing tests**

`test/implement/branch.test.ts`:

```ts
import { branchName, branchRefPattern, carriesTicket, slugify } from "../../src/implement/branch.js";

describe("branch naming", () => {
  it("slugifies a title", () => {
    expect(slugify("Routing settings: UI & API (v2)!")).toBe("routing-settings-ui-api-v2");
  });

  it("cuts the slug to 40 characters without a trailing hyphen", () => {
    const slug = slugify("a".repeat(39) + " bcdef");
    expect(slug.length).toBeLessThanOrEqual(40);
    expect(slug.endsWith("-")).toBe(false);
  });

  it("falls back to change when nothing survives", () => {
    expect(branchName("fix", "USRAPP-101", "🔥🔥")).toBe("fix/USRAPP-101-change");
  });

  it("keeps the identifier casing", () => {
    expect(branchName("chore", "API-101", "Bump pg")).toBe("chore/API-101-bump-pg");
  });

  it("matches only allowed types for this ticket", () => {
    const pattern = branchRefPattern(["feature", "fix"], "API-101");
    expect(pattern.test("refs/heads/fix/API-101-bump-pg")).toBe(true);
    expect(pattern.test("refs/heads/fix/API-101-change")).toBe(true);
    expect(pattern.test("refs/heads/hotfix/API-101-bump")).toBe(false);
    expect(pattern.test("refs/heads/fix/API-102-bump")).toBe(false);
    expect(pattern.test("refs/heads/dev")).toBe(false);
    expect(pattern.test("refs/heads/fix/API-101-Bump")).toBe(false);
  });

  it("detects any branch that carries the ticket, whatever its type", () => {
    expect(carriesTicket("refs/heads/feature/API-101-old-attempt", "API-101")).toBe(true);
    expect(carriesTicket("refs/heads/feature/api-101-old-attempt", "API-101")).toBe(true);
    expect(carriesTicket("refs/heads/feature/API-1010-other", "API-101")).toBe(false);
    expect(carriesTicket("refs/heads/dev", "API-101")).toBe(false);
  });
});
```

`test/implement/brief.test.ts`:

```ts
import { BRIEF_BEGIN, BRIEF_END } from "../../src/core/render.js";
import { extractAgentBrief } from "../../src/implement/brief.js";

describe("extractAgentBrief", () => {
  it("returns the text between the markers", () => {
    expect(extractAgentBrief(`Body\n### Agent brief\n${BRIEF_BEGIN}\nGoal: fix.\n${BRIEF_END}\nmore`)).toBe("Goal: fix.");
  });

  it("returns null without markers or with an empty brief", () => {
    expect(extractAgentBrief("Body only")).toBeNull();
    expect(extractAgentBrief(`${BRIEF_BEGIN}\n  \n${BRIEF_END}`)).toBeNull();
  });
});
```

`test/implement/prompt.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderImplementPrompt, type ImplementPromptVars } from "../../src/implement/prompt.js";

const template = readFileSync(fileURLToPath(new URL("../../prompts/implement.md", import.meta.url)), "utf8");
const vars: ImplementPromptVars = {
  identifier: "API-1",
  teamKey: "API",
  teamName: "API",
  ticket: "# API-1: Adapter drops the last chunk",
  workspacePath: "/work/1-1",
  baseBranch: "dev",
  sha: "a".repeat(40),
  artifactsDir: "/jobs/1/artifacts",
  stewardPort: 4100,
  hasBrief: false,
  brief: "",
  branchTypes: "feature, fix, chore, refactor",
};

describe("implement prompt", () => {
  it("asks for investigation first without a brief", () => {
    const prompt = renderImplementPrompt(template, vars);
    expect(prompt).toContain("Investigate first");
    expect(prompt).not.toContain("## Agent brief");
    expect(prompt).toContain("feature, fix, chore, refactor");
  });

  it("uses the brief as the spec when there is one", () => {
    const prompt = renderImplementPrompt(template, { ...vars, hasBrief: true, brief: "Goal: <keep> & flush." });
    expect(prompt).toContain("## Agent brief\n\nGoal: <keep> & flush.");
    expect(prompt).not.toContain("Investigate first");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/implement`
Expected: FAIL (modules missing).

- [ ] **Step 3: Implement**

`src/implement/branch.ts`:

```ts
const SLUG_MAX = 40;
const FALLBACK_SLUG = "change";

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export const slugify = (title: string): string =>
  title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SLUG_MAX)
    .replace(/-+$/, "");

export const branchName = (type: string, identifier: string, title: string): string => {
  const slug = slugify(title);
  return `${type}/${identifier}-${slug === "" ? FALLBACK_SLUG : slug}`;
};

/** The only refs the steward will push for this ticket. */
export const branchRefPattern = (types: string[], identifier: string): RegExp =>
  new RegExp(`^refs/heads/(?:${types.map(escapeRegExp).join("|")})/${escapeRegExp(identifier)}-[a-z0-9-]+$`);

/** True when a remote branch already belongs to this ticket, whatever its type prefix or casing. */
export const carriesTicket = (ref: string, identifier: string): boolean =>
  new RegExp(`^refs/heads/[^/]+/${escapeRegExp(identifier)}-`, "i").test(ref);
```

`src/implement/brief.ts`:

```ts
import { BRIEF_BEGIN, BRIEF_END } from "../core/render.js";

/** The agent brief triage wrote into the Enrichment section, or null when the ticket went straight to ready-for-agent. */
export const extractAgentBrief = (description: string): string | null => {
  const begin = description.indexOf(BRIEF_BEGIN);
  const end = description.indexOf(BRIEF_END, begin);
  if (begin === -1 || end === -1) return null;
  const brief = description.slice(begin + BRIEF_BEGIN.length, end).trim();
  return brief === "" ? null : brief;
};
```

`src/implement/prompt.ts`:

```ts
import Mustache from "mustache";

const { render } = Mustache;

export interface ImplementPromptVars {
  identifier: string;
  teamKey: string;
  teamName: string;
  ticket: string;
  workspacePath: string;
  baseBranch: string;
  sha: string;
  artifactsDir: string;
  stewardPort: number;
  hasBrief: boolean;
  brief: string;
  /** Comma-separated implement.branchTypes. */
  branchTypes: string;
}

const verbatim = (value: string): string => value;

export const renderImplementPrompt = (template: string, vars: ImplementPromptVars): string => render(template, vars, undefined, { escape: verbatim });
```

`prompts/implement.md`:

```md
You are Ticket Steward, a coding agent that implements tickets for the {{teamName}} team ({{teamKey}}). You have a fresh checkout of the monorepo at `{{workspacePath}}`, cut from `{{baseBranch}}` at commit `{{sha}}`. Nobody else works in this checkout. The local databases were reset to the schema of this commit before you started.

Your job is to implement ticket {{identifier}} below as a small, reviewable change. You edit files; the steward verifies your work, commits it, and pushes a branch. A person reviews the merge request.

## Ticket

{{ticket}}

{{#hasBrief}}
## Agent brief

{{brief}}

This brief was written during triage and is your spec. Check it against the current code before relying on it: if a file or function it names has moved, follow the code. If the brief and the ticket disagree, follow the brief and say so in `reviewNotes`.
{{/hasBrief}}
{{^hasBrief}}
## Investigate first

Nobody has triaged this ticket. Before changing anything, find the code involved (entry points, the files most likely affected, related tests and configuration), use the `recent_changes` tool on those paths, and decide on an approach.

If the ticket is too vague to implement responsibly (no clear expected behaviour, several plausible readings, or a product decision nobody has made), do not change any code. Return `outcome: "needs_info"` with specific questions for the reporter.
{{/hasBrief}}

## Rules

1. Edit files only inside `{{workspacePath}}`. Screenshots and scratch files go under `{{artifactsDir}}`.
2. Never run `git commit`, `git push`, `git remote`, `git config`, or anything else that changes history, branches or the remote. `git status`, `git diff` and `git log` are fine.
3. Keep the change scoped to the ticket: no unrelated refactors, renames or formatting sweeps.
4. While you work, run the type checker, the linter and the tests closest to your change, and fix what they report. List each command you ran and its result in `checksRun`.
5. For UI work, you may start the app on port {{stewardPort}} with the steward-provided skill and take screenshots with the Playwright tools.
6. Never copy values from `.env` files into source files.

## Result

- `outcome: "implemented"` when the change is complete and your checks pass. Set `branchType` to one of: {{branchTypes}} (the kind of change: `feature` for new behaviour, `fix` for a bug fix, `chore` for maintenance, `refactor` for restructuring without behaviour change). Write `commitMessage` as a subject line of at most 72 characters (no ticket ID; the steward adds it), a blank line, then a short body explaining what changed and why. Write `summary` for the ticket comment and `reviewNotes` for anything a reviewer should check.
- `outcome: "failed"` when you tried and could not get to a working change. Put what you tried, what failed and where you stopped in `failureDetail`. Set `branchType` to null.
- `outcome: "needs_info"` when the ticket cannot be implemented without answers only a person can give. Put the questions in `questions`. Set `branchType` to null.
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm typecheck && npx vitest run test/implement`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/implement prompts/implement.md test/implement
git commit -m "feat(implement): branch naming, brief extraction and implement prompt"
```

---

### Task 8: Steward-only git steps (guard, hooks, commit, bundle, push)

**Files:**
- Create: `src/implement/git.ts`
- Test: `test/implement/git.test.ts`

**Interfaces:**
- Consumes: `git`, `gitOrThrow` (`src/workspace/git.ts`), `RemoteCredentials` (`src/workspace/mirror.ts`), `branchRefPattern`, `carriesTicket` (Task 7).
- Produces:
  - `stageAndGuard(input: { worktreePath: string; overlayFiles: string[]; skillsPrefix: string; secretValues: string[] }): Promise<{ ok: true; paths: string[] } | { ok: false; reason: string; detail: string }>`
  - `installHookWrappers(worktreePath: string, hooksDir: string): Promise<string[]>` (returns hook names installed)
  - `commitWithHooks(input: { worktreePath: string; hooksDir: string; messagePath: string; message: string; author: { name: string; email: string }; env: Record<string, string> }): Promise<{ ok: true; sha: string } | { ok: false; output: string }>`
  - `saveBundle(worktreePath: string, baseSha: string, bundlePath: string): Promise<void>`
  - `restoreFromBundle(repoPath: string, bundlePath: string, sha: string): Promise<void>`
  - `remoteTicketBranches(remote: RemoteCredentials, cwd: string, identifier: string): Promise<Array<{ ref: string; sha: string }>>`
  - `class BranchExistsError extends Error { ref: string }`
  - `pushCommit(input: { cwd: string; remote: RemoteCredentials; sha: string; baseSha: string; branch: string; identifier: string; branchTypes: string[] }): Promise<void>`

- [ ] **Step 1: Write the failing tests**

`test/implement/git.test.ts`:

```ts
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { execa } from "execa";
import { BranchExistsError, commitWithHooks, installHookWrappers, pushCommit, remoteTicketBranches, restoreFromBundle, saveBundle, stageAndGuard } from "../../src/implement/git.js";
import { gitEnvRecord } from "../../src/workspace/git.js";
import { Mirror } from "../../src/workspace/mirror.js";
import { createWorktree, type Worktree } from "../../src/workspace/worktree.js";
import { commitFile, git, makeSourceRepo, removeDir, tmpDir } from "../workspace/helpers.js";

const AUTHOR = { name: "Ticket Steward", email: "steward@example.com" };
const TYPES = ["feature", "fix", "chore", "refactor"];

let root: string;
let source: string;
let base: string;
let mirror: Mirror;
let worktree: Worktree;

const env = (): Record<string, string> => ({ ...gitEnvRecord() });

beforeEach(async () => {
  root = await tmpDir();
  ({ repo: source } = await makeSourceRepo(root));
  await commitFile(source, ".gitignore", ".env\n");
  base = await commitFile(source, "src/a.ts", "export const a = 1;\n");
  mirror = await Mirror.init(join(root, "repo.git"), source);
  worktree = await createWorktree(mirror, join(root, "work"), "1-1", base);
});

afterEach(async () => {
  await removeDir(root);
});

describe("stageAndGuard", () => {
  it("stages the change and returns the paths", async () => {
    await writeFile(join(worktree.path, "src/a.ts"), "export const a = 2;\n");
    expect(await stageAndGuard({ worktreePath: worktree.path, overlayFiles: [".env"], skillsPrefix: ".claude/skills/", secretValues: [] })).toEqual({ ok: true, paths: ["src/a.ts"] });
  });

  it("refuses an empty change", async () => {
    const result = await stageAndGuard({ worktreePath: worktree.path, overlayFiles: [], skillsPrefix: ".claude/skills/", secretValues: [] });
    expect(result).toMatchObject({ ok: false, reason: "the agent reported the work as implemented but changed nothing" });
  });

  it("refuses an overlay file that is not gitignored and names it", async () => {
    await mkdir(join(worktree.path, "apps/web"), { recursive: true });
    await writeFile(join(worktree.path, "apps/web/.env.local"), "DB_PASSWORD=hunter2hunter2\n");
    await writeFile(join(worktree.path, "src/a.ts"), "export const a = 2;\n");
    const result = await stageAndGuard({ worktreePath: worktree.path, overlayFiles: ["apps/web/.env.local"], skillsPrefix: ".claude/skills/", secretValues: [] });
    expect(result).toEqual({ ok: false, reason: "the change would commit files the steward copied in", detail: "apps/web/.env.local" });
  });

  it("refuses copied skills", async () => {
    await mkdir(join(worktree.path, ".claude/skills/verify"), { recursive: true });
    await writeFile(join(worktree.path, ".claude/skills/verify/SKILL.md"), "x\n");
    const result = await stageAndGuard({ worktreePath: worktree.path, overlayFiles: [], skillsPrefix: ".claude/skills/", secretValues: [] });
    expect(result).toMatchObject({ ok: false, detail: ".claude/skills/verify/SKILL.md" });
  });

  it("refuses a diff containing a secret value and names the file, not the value", async () => {
    await writeFile(join(worktree.path, "src/a.ts"), 'export const key = "sk-live-abcdef123456";\n');
    const result = await stageAndGuard({ worktreePath: worktree.path, overlayFiles: [], skillsPrefix: ".claude/skills/", secretValues: ["sk-live-abcdef123456"] });
    expect(result).toEqual({ ok: false, reason: "the change contains a secret value from the overlay", detail: "src/a.ts" });
  });
});

describe("commitWithHooks", () => {
  const message = "API-1: Keep the last chunk\n\nFlush before close.";

  it("commits with the configured author on top of the base", async () => {
    await writeFile(join(worktree.path, "src/a.ts"), "export const a = 2;\n");
    await stageAndGuard({ worktreePath: worktree.path, overlayFiles: [], skillsPrefix: ".claude/skills/", secretValues: [] });
    const hooksDir = join(root, "hooks");
    await installHookWrappers(worktree.path, hooksDir);
    const result = await commitWithHooks({ worktreePath: worktree.path, hooksDir, messagePath: join(root, "MSG"), message, author: AUTHOR, env: env() });
    expect(result.ok).toBe(true);
    const sha = result.ok ? result.sha : "";
    expect(await git(worktree.path, ["log", "-1", "--format=%an <%ae>%n%P%n%B", sha])).toBe(`Ticket Steward <steward@example.com>\n${base}\n${message}`);
  });

  it("runs the repo's husky pre-commit hook and reports its output on failure", async () => {
    await mkdir(join(worktree.path, ".husky"), { recursive: true });
    await writeFile(join(worktree.path, ".husky/pre-commit"), 'echo "lint failed: no-unused-vars"\nexit 1\n');
    await writeFile(join(worktree.path, "src/a.ts"), "export const a = 2;\n");
    await stageAndGuard({ worktreePath: worktree.path, overlayFiles: [], skillsPrefix: ".claude/skills/", secretValues: [] });
    const hooksDir = join(root, "hooks");
    expect(await installHookWrappers(worktree.path, hooksDir)).toEqual(["pre-commit"]);
    const result = await commitWithHooks({ worktreePath: worktree.path, hooksDir, messagePath: join(root, "MSG"), message, author: AUTHOR, env: env() });
    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.output).toContain("lint failed: no-unused-vars");
  });

  it("does not change the shared git config", async () => {
    await writeFile(join(worktree.path, "src/a.ts"), "export const a = 2;\n");
    await stageAndGuard({ worktreePath: worktree.path, overlayFiles: [], skillsPrefix: ".claude/skills/", secretValues: [] });
    const before = await readFile(join(mirror.path, "config"), "utf8");
    await installHookWrappers(worktree.path, join(root, "hooks"));
    await commitWithHooks({ worktreePath: worktree.path, hooksDir: join(root, "hooks"), messagePath: join(root, "MSG"), message, author: AUTHOR, env: env() });
    expect(await readFile(join(mirror.path, "config"), "utf8")).toBe(before);
  });
});

describe("push", () => {
  const commitChange = async (): Promise<string> => {
    await writeFile(join(worktree.path, "src/a.ts"), "export const a = 2;\n");
    await stageAndGuard({ worktreePath: worktree.path, overlayFiles: [], skillsPrefix: ".claude/skills/", secretValues: [] });
    await installHookWrappers(worktree.path, join(root, "hooks"));
    const result = await commitWithHooks({ worktreePath: worktree.path, hooksDir: join(root, "hooks"), messagePath: join(root, "MSG"), message: "API-1: x", author: AUTHOR, env: env() });
    if (!result.ok) throw new Error(result.output);
    return result.sha;
  };
  const remote = () => ({ url: source, env: {} });

  it("pushes the commit to a new branch", async () => {
    const sha = await commitChange();
    await pushCommit({ cwd: worktree.path, remote: remote(), sha, baseSha: base, branch: "fix/API-1-keep-last-chunk", identifier: "API-1", branchTypes: TYPES });
    expect(await git(source, ["rev-parse", "refs/heads/fix/API-1-keep-last-chunk"])).toBe(sha);
  });

  it("refuses a branch outside the pattern", async () => {
    const sha = await commitChange();
    await expect(pushCommit({ cwd: worktree.path, remote: remote(), sha, baseSha: base, branch: "main", identifier: "API-1", branchTypes: TYPES })).rejects.toThrow("refusing to push to refs/heads/main");
  });

  it("refuses a commit that is not directly on the base", async () => {
    const sha = await commitChange();
    await expect(pushCommit({ cwd: worktree.path, remote: remote(), sha, baseSha: "b".repeat(40), branch: "fix/API-1-x", identifier: "API-1", branchTypes: TYPES })).rejects.toThrow("is not a single commit on top of");
  });

  it("refuses when any branch already carries the ticket", async () => {
    await git(source, ["branch", "feature/API-1-by-hand", base]);
    const sha = await commitChange();
    expect(await remoteTicketBranches(remote(), worktree.path, "API-1")).toEqual([{ ref: "refs/heads/feature/API-1-by-hand", sha: base }]);
    await expect(pushCommit({ cwd: worktree.path, remote: remote(), sha, baseSha: base, branch: "fix/API-1-x", identifier: "API-1", branchTypes: TYPES })).rejects.toBeInstanceOf(BranchExistsError);
  });

  it("restores a commit from its bundle into another repo and pushes it from there", async () => {
    const sha = await commitChange();
    const bundle = join(root, "implement.bundle");
    await saveBundle(worktree.path, base, bundle);
    const other = join(root, "other.git");
    await execa("git", ["clone", "--quiet", "--bare", source, other], { env: gitEnvRecord(), extendEnv: false });
    await restoreFromBundle(other, bundle, sha);
    await pushCommit({ cwd: other, remote: remote(), sha, baseSha: base, branch: "fix/API-1-x", identifier: "API-1", branchTypes: TYPES });
    expect(await git(source, ["rev-parse", "refs/heads/fix/API-1-x"])).toBe(sha);
  });
});
```

(`chmod` import is unused unless you need it — drop it if lint complains.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/implement/git.test.ts`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement**

`src/implement/git.ts`:

```ts
import { existsSync } from "node:fs";
import { chmod, mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { git, gitOrThrow, scrubCredentials } from "../workspace/git.js";
import type { RemoteCredentials } from "../workspace/mirror.js";
import { branchRefPattern, carriesTicket } from "./branch.js";

const MIN_SECRET_LENGTH = 8;
const GIT_HOOKS = new Set(["pre-commit", "prepare-commit-msg", "commit-msg", "post-commit"]);

export type GuardResult = { ok: true; paths: string[] } | { ok: false; reason: string; detail: string };

const stagedPaths = async (worktreePath: string): Promise<string[]> => {
  const out = await gitOrThrow(["diff", "--cached", "--name-only", "-z"], worktreePath);
  return out.split("\0").filter((path) => path !== "");
};

/** Stages everything and refuses (nothing committed) if the change is empty, includes steward-copied files, or leaks an overlay secret. */
export const stageAndGuard = async (input: { worktreePath: string; overlayFiles: string[]; skillsPrefix: string; secretValues: string[] }): Promise<GuardResult> => {
  await gitOrThrow(["add", "-A"], input.worktreePath);
  const paths = await stagedPaths(input.worktreePath);
  if (paths.length === 0) return { ok: false, reason: "the agent reported the work as implemented but changed nothing", detail: "" };
  const overlay = new Set(input.overlayFiles);
  const copied = paths.filter((path) => overlay.has(path) || path.startsWith(input.skillsPrefix));
  if (copied.length > 0) return { ok: false, reason: "the change would commit files the steward copied in", detail: copied.join("\n") };
  const secrets = input.secretValues.filter((value) => value.length >= MIN_SECRET_LENGTH);
  if (secrets.length > 0) {
    const leaking: string[] = [];
    for (const path of paths) {
      const diff = await git(["diff", "--cached", "--no-color", "--unified=0", "--", path], input.worktreePath);
      const added = diff.stdout.split("\n").filter((line) => line.startsWith("+") && !line.startsWith("+++"));
      if (added.some((line) => secrets.some((secret) => line.includes(secret)))) leaking.push(path);
    }
    if (leaking.length > 0) return { ok: false, reason: "the change contains a secret value from the overlay", detail: leaking.join("\n") };
  }
  return { ok: true, paths };
};

/**
 * Writes wrappers for the repo's Husky hooks into `hooksDir` (outside the worktree), so one commit can run them
 * via `-c core.hooksPath` without `husky install` touching the shared mirror config.
 */
export const installHookWrappers = async (worktreePath: string, hooksDir: string): Promise<string[]> => {
  await mkdir(hooksDir, { recursive: true, mode: 0o700 });
  const huskyDir = join(worktreePath, ".husky");
  if (!existsSync(huskyDir)) return [];
  const installed: string[] = [];
  for (const name of (await readdir(huskyDir)).sort()) {
    if (!GIT_HOOKS.has(name) || !(await stat(join(huskyDir, name))).isFile()) continue;
    const wrapper = join(hooksDir, name);
    await writeFile(wrapper, `#!/bin/sh\nexec sh ${JSON.stringify(join(huskyDir, name))} "$@"\n`);
    await chmod(wrapper, 0o755);
    installed.push(name);
  }
  return installed;
};

export const commitWithHooks = async (input: {
  worktreePath: string;
  hooksDir: string;
  messagePath: string;
  message: string;
  author: { name: string; email: string };
  env: Record<string, string>;
}): Promise<{ ok: true; sha: string } | { ok: false; output: string }> => {
  await writeFile(input.messagePath, `${input.message.trim()}\n`, { mode: 0o600 });
  const path = `${join(input.worktreePath, "node_modules", ".bin")}:${input.env.PATH ?? process.env.PATH ?? "/usr/bin:/bin"}`;
  const result = await git(
    ["-c", `core.hooksPath=${input.hooksDir}`, "-c", `user.name=${input.author.name}`, "-c", `user.email=${input.author.email}`, "commit", "--quiet", "--no-gpg-sign", "-F", input.messagePath],
    input.worktreePath,
    { ...input.env, PATH: path },
  );
  if (result.exitCode !== 0) return { ok: false, output: [result.stdout, result.stderr].filter((part) => part !== "").join("\n") };
  return { ok: true, sha: await gitOrThrow(["rev-parse", "HEAD"], input.worktreePath) };
};

/** Keeps the commit on disk after the worktree is gone, so a failed push can be retried. */
export const saveBundle = async (worktreePath: string, baseSha: string, bundlePath: string): Promise<void> => {
  await gitOrThrow(["bundle", "create", "--quiet", bundlePath, `${baseSha}..HEAD`], worktreePath);
};

export const restoreFromBundle = async (repoPath: string, bundlePath: string, sha: string): Promise<void> => {
  await gitOrThrow(["fetch", "--quiet", bundlePath, "HEAD"], repoPath);
  await gitOrThrow(["cat-file", "-e", `${sha}^{commit}`], repoPath);
};

export const remoteTicketBranches = async (remote: RemoteCredentials, cwd: string, identifier: string): Promise<Array<{ ref: string; sha: string }>> => {
  const out = await gitOrThrow(["ls-remote", "--heads", remote.url], cwd, remote.env);
  return out
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => {
      const [sha = "", ref = ""] = line.split("\t");
      return { ref, sha };
    })
    .filter(({ ref }) => carriesTicket(ref, identifier));
};

export class BranchExistsError extends Error {
  constructor(readonly ref: string) {
    super(`${ref} already exists on the remote`);
    this.name = "BranchExistsError";
  }
}

/** Pushes `sha` to a new branch after checking the ref pattern, the ancestry, and that no branch carries the ticket. Never forces. */
export const pushCommit = async (input: { cwd: string; remote: RemoteCredentials; sha: string; baseSha: string; branch: string; identifier: string; branchTypes: string[] }): Promise<void> => {
  const ref = `refs/heads/${input.branch}`;
  if (!branchRefPattern(input.branchTypes, input.identifier).test(ref)) throw new Error(`refusing to push to ${ref}: not a ${input.branchTypes.join("|")}/${input.identifier}-<slug> branch`);
  const parents = (await gitOrThrow(["rev-list", "--parents", "-n", "1", input.sha], input.cwd)).split(" ").slice(1);
  if (parents.length !== 1 || parents[0] !== input.baseSha) throw new Error(`refusing to push: ${input.sha.slice(0, 7)} is not a single commit on top of ${input.baseSha.slice(0, 7)}`);
  const existing = await remoteTicketBranches(input.remote, input.cwd, input.identifier);
  if (existing[0] !== undefined) throw new BranchExistsError(existing[0].ref);
  const pushed = await git(["push", "--quiet", "--porcelain", input.remote.url, `${input.sha}:${ref}`], input.cwd, input.remote.env);
  if (pushed.exitCode !== 0) throw new Error(`git push exited ${pushed.exitCode}: ${scrubCredentials(pushed.stderr)}`);
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm typecheck && npx vitest run test/implement/git.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/implement/git.ts test/implement/git.test.ts
git commit -m "feat(implement): guard, hook wrappers, commit, bundle and guarded push"
```

---

### Task 9: Implement pipeline, publish and worker dispatch

**Files:**
- Create: `src/implement/publish.ts`, `src/implement/pipeline.ts`
- Modify: `src/worker/loop.ts`, `src/cli/inline.ts`
- Test: `test/implement/pipeline.test.ts`, `test/worker/loop.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–8; `prepareWorkspace`, `jobPaths`, `brainInput`, `cleanupWorkspace`, `crashed`, `redactOutcome`, `patchAttempt`, `errorMessage` (`src/core/workspace.ts`); `renderTicketMarkdown` (`src/core/context.ts`); `runSetup` (`src/workspace/setup.ts`); `listFiles` (`src/workspace/files.ts`); `collectSecretValues` (`src/core/redact.ts`); `injectToken`, `splitCredentials` (`src/workspace/mirror.ts`); `buildWorkspaceEnv`, `buildBrainEnv`, `runBrainDetached`, `INTERRUPTED_ERROR` (`src/brain/index.js`).
- Produces: `runImplement(ctx: RunContext, deps: PipelineDeps): Promise<JobOutcome>`; `publishImplementOnly(ctx: RunContext, deps: PipelineDeps): Promise<JobOutcome>`; `buildImplementComment(input: { jobId: number; stored: StoredImplement; branch: string | null; branchUrl: string | null }): string`; `branchUrl(codehost: CodeHostConfig, branch: string): string`; `WorkerOptions.runImplement?`, `WorkerOptions.publishImplementOnly?`.

- [ ] **Step 1: Write the failing tests**

`test/implement/pipeline.test.ts`:

```ts
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { BrainInput, BrainRun } from "../../src/brain/types.js";
import type { StewardConfig } from "../../src/config/schema.js";
import type { PipelineDeps } from "../../src/core/pipeline.js";
import { Redactor } from "../../src/core/redact.js";
import type { RunContext } from "../../src/core/types.js";
import type { ImplementResult } from "../../src/implement/result.js";
import { publishImplementOnly, runImplement } from "../../src/implement/pipeline.js";
import { openStores, type Stores } from "../../src/store/index.js";
import type { IssueTrigger, TicketBundle } from "../../src/tracker/types.js";
import { FakeBrain } from "../fakes/fakeBrain.js";
import { FakeCodeHost } from "../fakes/fakeCodeHost.js";
import { FakeTracker } from "../fakes/fakeTracker.js";
import { freeTcpPort, tmpRepo, type TmpRepo } from "../fakes/tmpRepo.js";
import { commitFile, git } from "../workspace/helpers.js";

const IMPLEMENT_PROMPT = fileURLToPath(new URL("../../prompts/implement.md", import.meta.url));
const LABELS = { triage: "needs-triage", implement: "ready-for-agent", needsInfo: "needs-info", readyForHuman: "ready-for-human", implemented: "agent-implemented" };

const issue: TicketBundle = {
  id: "issue-1",
  identifier: "API-1",
  url: "https://linear.app/acme/issue/API-1",
  title: "Adapter drops the last chunk",
  description: "The adapter loses the final chunk.",
  team: { id: "team-1", key: "API", name: "API" },
  state: { name: "Todo", type: "unstarted" },
  labels: ["ready-for-agent"],
  priority: 2,
  creator: { name: "Ada", isBot: false },
  createdAt: "2026-09-11T00:00:00.000Z",
  comments: [],
  attachments: [],
  appliedTemplate: null,
  templates: [],
};

const trigger: IssueTrigger = { kind: "issue.labeled", issueId: "issue-1", identifier: "API-1", teamKey: "API", deliveryId: "d-1", description: issue.description, stateType: "unstarted", action: "implement" };

const implemented: ImplementResult = {
  outcome: "implemented",
  branchType: "fix",
  commitMessage: "Keep the last chunk\n\nFlush the buffer before closing.",
  summary: "Flush the buffer before closing the stream.",
  reviewNotes: ["Check the streaming test."],
  checksRun: ["tsc: ok"],
  questions: [],
  failureDetail: null,
};

let repo: TmpRepo;
let stores: Stores;
let tracker: FakeTracker;
let port: number;

const makeConfig = (implement: Partial<NonNullable<StewardConfig["implement"]>> = {}): StewardConfig => ({
  dataDir: repo.dataDir,
  brain: { kind: "claude-code", model: "claude-test", maxTurns: 5, timeoutMinutes: 1 },
  tracker: { kind: "linear", teams: ["API"], gatewayIssues: "enrich", bugLabels: ["Bug"], labels: LABELS },
  codehost: { kind: "gitlab", baseUrl: "https://gitlab.example", project: "acme/repo" },
  workspace: { fetchUrl: repo.repo, baseBranch: "main", overlayDir: repo.overlayDir, setup: [], setupTimeoutMinutes: 1, port, keepOnFailure: false },
  retention: { keptWorktrees: 3, days: 30 },
  prompt: repo.promptPath,
  server: { port: 3020, publicUrl: "https://steward.example" },
  implement: {
    prompt: IMPLEMENT_PROMPT,
    branchTypes: ["feature", "fix", "chore", "refactor"],
    checks: [],
    checksTimeoutMinutes: 1,
    commitAuthor: { name: "Ticket Steward", email: "steward@example.com" },
    timeoutMinutes: 1,
    maxTurns: 5,
    protectedBranches: ["main"],
    ...implement,
  },
});

/** A brain that edits the worktree, then returns `result`. */
const editingBrain = (result: unknown, edit: (workspace: string) => Promise<void> = async (w) => writeFile(join(w, "src/adapter.ts"), "export const adapter = 2;\n")) => {
  const calls: BrainInput[] = [];
  const runBrain = async (_config: unknown, input: BrainInput): Promise<BrainRun> => {
    calls.push(input);
    await edit(input.workspacePath);
    return { ok: true, output: result };
  };
  return { calls, runBrain };
};

const makeDeps = (runBrain: PipelineDeps["runBrain"], config: StewardConfig = makeConfig()): PipelineDeps => ({
  config,
  secrets: { GITLAB_PUSH_TOKEN: "glpat-push-token-value" },
  configPath: join(repo.root, "steward.config.ts"),
  binPath: join(repo.root, "bin", "steward.js"),
  tracker,
  brain: new FakeBrain(),
  codehost: new FakeCodeHost(),
  mirror: repo.mirror,
  stores,
  redactor: new Redactor([]),
  now: () => new Date("2026-09-30T12:00:00.000Z"),
  ...(runBrain === undefined ? {} : { runBrain }),
});

const claim = (event: IssueTrigger = trigger): RunContext => {
  const jobId = stores.jobs.enqueue(event);
  stores.jobs.claimById(jobId);
  stores.attempts.start(jobId);
  return { jobId, attempt: 1, issueId: event.issueId, identifier: event.identifier, teamKey: event.teamKey, trigger: event, dryRun: false };
};

beforeEach(async () => {
  repo = await tmpRepo("unused");
  await commitFile(repo.repo, ".gitignore", ".env\n");
  await repo.mirror.fetch();
  stores = openStores(repo.dataDir);
  tracker = new FakeTracker([issue]);
  port = await freeTcpPort();
});

afterEach(async () => {
  stores.db.close();
  await repo.cleanup();
});

describe("runImplement", () => {
  it("commits, pushes the branch, comments and swaps to agent-implemented", async () => {
    const brain = editingBrain(implemented);
    const ctx = claim();

    const outcome = await runImplement(ctx, makeDeps(brain.runBrain));

    expect(outcome).toEqual({ status: "succeeded" });
    const job = stores.jobs.get(ctx.jobId);
    expect(job?.branch).toBe("fix/API-1-adapter-drops-the-last-chunk");
    expect(await git(repo.repo, ["rev-parse", "refs/heads/fix/API-1-adapter-drops-the-last-chunk"])).toBe(job?.commitSha);
    expect(await git(repo.repo, ["log", "-1", "--format=%s", "refs/heads/fix/API-1-adapter-drops-the-last-chunk"])).toBe("API-1: Keep the last chunk");
    expect(job?.pushedAt).not.toBeNull();
    expect(tracker.comments("issue-1")[0]).toContain("fix/API-1-adapter-drops-the-last-chunk");
    expect(tracker.labelsOf("issue-1")).toEqual(["agent-implemented"]);
    expect(brain.calls[0]?.output).toBe("implement");
    expect(brain.calls[0]?.timeoutMs).toBe(60_000);
  });

  it("hands back to needs-info without touching git", async () => {
    const ctx = claim();
    const outcome = await runImplement(ctx, makeDeps(editingBrain({ ...implemented, outcome: "needs_info", branchType: null, questions: ["Which stream?"] }, async () => undefined).runBrain));

    expect(outcome).toEqual({ status: "succeeded", warning: "handed back: the ticket needs more information" });
    expect(tracker.labelsOf("issue-1")).toEqual(["needs-info"]);
    expect(tracker.comments("issue-1")[0]).toContain("1. Which stream?");
    expect(await git(repo.repo, ["branch", "--list", "*/API-1-*"])).toBe("");
  });

  it("hands back to ready-for-human when the agent failed", async () => {
    const ctx = claim();
    await runImplement(ctx, makeDeps(editingBrain({ ...implemented, outcome: "failed", branchType: null, failureDetail: "the streaming test keeps failing" }).runBrain));
    expect(tracker.labelsOf("issue-1")).toEqual(["ready-for-human"]);
    expect(tracker.comments("issue-1")[0]).toContain("the streaming test keeps failing");
  });

  it("hands back without running the brain when a branch already carries the ticket", async () => {
    await git(repo.repo, ["branch", "feature/API-1-by-hand"]);
    const brain = editingBrain(implemented);
    const ctx = claim();

    const outcome = await runImplement(ctx, makeDeps(brain.runBrain));

    expect(outcome).toEqual({ status: "succeeded", warning: "handed back: a branch for API-1 already exists" });
    expect(brain.calls).toHaveLength(0);
    expect(tracker.comments("issue-1")[0]).toContain("feature/API-1-by-hand");
    expect(tracker.labelsOf("issue-1")).toEqual(["ready-for-human"]);
  });

  it("hands back when the agent picks a branch type outside the list", async () => {
    const ctx = claim();
    const outcome = await runImplement(ctx, makeDeps(editingBrain({ ...implemented, branchType: "hotfix" }).runBrain));
    expect(outcome).toMatchObject({ status: "succeeded", warning: expect.stringContaining("handed back:") });
    expect(tracker.labelsOf("issue-1")).toEqual(["ready-for-human"]);
    expect(await git(repo.repo, ["branch", "--list", "*/API-1-*"])).toBe("");
  });

  it("hands back when the steward's checks fail", async () => {
    const ctx = claim();
    const outcome = await runImplement(ctx, makeDeps(editingBrain(implemented).runBrain, makeConfig({ checks: ["echo 'type error in adapter.ts'; exit 2"] })));
    expect(outcome).toEqual({ status: "succeeded", warning: "handed back: the steward's checks failed" });
    expect(tracker.comments("issue-1")[0]).toContain("type error in adapter.ts");
    expect(await git(repo.repo, ["branch", "--list", "*/API-1-*"])).toBe("");
  });

  it("hands back when the change contains an overlay secret", async () => {
    await writeFile(join(repo.overlayDir, ".env"), "API_SECRET=supersecretvalue123\n");
    const ctx = claim();
    const brain = editingBrain(implemented, async (w) => writeFile(join(w, "src/adapter.ts"), 'export const s = "supersecretvalue123";\n'));
    const outcome = await runImplement(ctx, makeDeps(brain.runBrain));
    expect(outcome).toEqual({ status: "succeeded", warning: "handed back: the change contains a secret value from the overlay" });
    expect(tracker.comments("issue-1")[0]).not.toContain("supersecretvalue123");
  });

  it("refuses a Done ticket without running the brain", async () => {
    tracker.addIssue({ ...issue, state: { name: "Done", type: "completed" } });
    const brain = editingBrain(implemented);
    const outcome = await runImplement(claim(), makeDeps(brain.runBrain));
    expect(outcome).toEqual({ status: "failed", error: "API-1 is Done; Ticket Steward does not work on Done or Canceled tickets", retryable: false });
    expect(brain.calls).toHaveLength(0);
  });

  it("does not commit or push when the ticket is closed while the agent runs", async () => {
    const brain = editingBrain(implemented, async (w) => {
      await writeFile(join(w, "src/adapter.ts"), "export const adapter = 2;\n");
      tracker.addIssue({ ...issue, state: { name: "Canceled", type: "canceled" } });
    });
    const outcome = await runImplement(claim(), makeDeps(brain.runBrain));
    expect(outcome).toEqual({ status: "failed", error: "API-1 is Canceled; Ticket Steward does not work on Done or Canceled tickets", retryable: false });
    expect(await git(repo.repo, ["branch", "--list", "*/API-1-*"])).toBe("");
    expect(tracker.comments("issue-1")).toEqual([]);
  });

  it("leaves labels alone for a CLI-triggered job", async () => {
    await runImplement(claim({ kind: "cli", issueId: "issue-1", identifier: "API-1", teamKey: "API", action: "implement" }), makeDeps(editingBrain(implemented).runBrain));
    expect(tracker.labelSwaps()).toEqual([]);
  });
});

describe("publishImplementOnly", () => {
  it("re-publishes after a failed comment without pushing again", async () => {
    const ctx = claim();
    tracker.failNextWrite();
    const first = await runImplement(ctx, makeDeps(editingBrain(implemented).runBrain));
    expect(first.status).toBe("publish_failed");
    const pushed = await git(repo.repo, ["rev-parse", "refs/heads/fix/API-1-adapter-drops-the-last-chunk"]);

    const retry = await publishImplementOnly({ ...ctx, attempt: 2 }, makeDeps(undefined));

    expect(retry).toEqual({ status: "succeeded" });
    expect(await git(repo.repo, ["rev-parse", "refs/heads/fix/API-1-adapter-drops-the-last-chunk"])).toBe(pushed);
    expect(tracker.labelsOf("issue-1")).toEqual(["agent-implemented"]);
  });

  it("does not record a push when the remote is unreachable", async () => {
    const ctx = claim();
    const deps = makeDeps(editingBrain(implemented).runBrain);
    const unreachable = { ...deps, config: { ...deps.config, workspace: { ...deps.config.workspace, fetchUrl: join(repo.root, "missing.git") } } };

    const outcome = await runImplement(ctx, unreachable);

    expect(outcome).toMatchObject({ status: "failed", retryable: true });
    expect(stores.jobs.get(ctx.jobId)?.pushedAt ?? null).toBeNull();
  });
});
```

(Pushing from the bundle after a failed push is covered end to end by the `restoreFromBundle` test in `test/implement/git.test.ts`.)

`test/worker/loop.test.ts` — add, following the file's existing pattern for `runJob` overrides:

```ts
it("dispatches implement jobs to runImplement and republish to publishImplementOnly", async () => {
  const runImplement = vi.fn(async () => ({ status: "succeeded" }) as const);
  const handle = start({ runImplement });
  const jobId = stores.jobs.enqueue({ ...createdTrigger, action: "implement" });
  await waitForStatus(jobId, "succeeded");
  expect(runImplement).toHaveBeenCalledTimes(1);
  await handle.stop();
});
```

(Use the file's `start`/`waitForStatus` helpers; if `start` does not accept options, extend it to pass them through to the worker deps.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/implement/pipeline.test.ts test/worker`
Expected: FAIL.

- [ ] **Step 3: Implement**

`src/implement/publish.ts`:

```ts
import type { CodeHostConfig, LabelsConfig } from "../config/schema.js";
import type { Redactor } from "../core/redact.js";
import { truncate } from "../core/render.js";
import type { JobOutcome, RunContext } from "../core/types.js";
import { errorMessage } from "../core/workspace.js";
import type { Tracker } from "../tracker/types.js";
import type { StoredImplement } from "./result.js";

const DETAIL_MAX = 4_000;

export const branchUrl = (codehost: CodeHostConfig, branch: string): string =>
  codehost.kind === "gitlab"
    ? `${codehost.baseUrl.replace(/\/$/, "")}/${codehost.project}/-/tree/${encodeURI(branch)}`
    : `https://github.com/${codehost.owner}/${codehost.repo}/tree/${encodeURI(branch)}`;

const list = (items: string[]): string[] => items.filter((item) => item.trim() !== "").map((item) => `- ${item.trim()}`);

export const buildImplementComment = (input: { jobId: number; stored: StoredImplement; branch: string | null; branchUrl: string | null }): string => {
  const { stored, jobId } = input;
  const result = stored.result;
  if (stored.handback === null && result !== null && input.branch !== null) {
    return [
      `Implementation pushed (job ${jobId}): [\`${input.branch}\`](${input.branchUrl ?? ""}). The pipeline opens the merge request when it passes.`,
      "",
      result.summary.trim(),
      ...(result.reviewNotes.length > 0 ? ["", "**For the reviewer**", ...list(result.reviewNotes)] : []),
      ...(result.checksRun.length > 0 ? ["", "**Checks the agent ran**", ...list(result.checksRun)] : []),
    ].join("\n");
  }
  const handback = stored.handback;
  if (handback?.label === "needsInfo") {
    const questions = (result?.questions ?? []).filter((q) => q.trim() !== "").map((q, index) => `${index + 1}. ${q.trim()}`);
    return [`Not implemented (job ${jobId}): this ticket needs more information first.`, "", ...questions].join("\n");
  }
  return [
    `Not implemented (job ${jobId}): ${handback?.reason ?? "the agent could not finish"}. Nothing was pushed.`,
    ...(result?.failureDetail ? ["", result.failureDetail.trim()] : []),
    ...(handback !== null && handback.detail !== "" ? ["", "```", truncate(handback.detail, DETAIL_MAX), "```"] : []),
  ].join("\n");
};

/** Comment first, labels last; a failure in either is publish_failed so a retry re-runs only this. */
export const publishImplement = async (input: {
  ctx: RunContext;
  tracker: Tracker;
  redactor: Redactor;
  labels: LabelsConfig | undefined;
  stored: StoredImplement;
  branch: string | null;
  branchUrl: string | null;
}): Promise<JobOutcome> => {
  const { ctx, tracker, labels, stored } = input;
  try {
    await tracker.postComment(ctx.issueId, input.redactor.redact(buildImplementComment({ jobId: ctx.jobId, stored, branch: input.branch, branchUrl: input.branchUrl })));
  } catch (err) {
    return { status: "publish_failed", error: `comment: ${errorMessage(err)}` };
  }
  if (ctx.trigger.kind !== "mr.review" && ctx.trigger.action === "implement" && labels !== undefined) {
    const target = stored.handback === null ? labels.implemented : labels[stored.handback.label];
    try {
      await tracker.swapLabel(ctx.issueId, labels.implement, target);
    } catch (err) {
      return { status: "publish_failed", error: `labels: ${errorMessage(err)}` };
    }
  }
  return stored.handback === null ? { status: "succeeded" } : { status: "succeeded", warning: `handed back: ${stored.handback.reason}` };
};
```

`src/implement/pipeline.ts`:

```ts
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { buildBrainEnv, buildWorkspaceEnv, INTERRUPTED_ERROR, runBrainDetached } from "../brain/index.js";
import type { BrainRun } from "../brain/types.js";
import type { ImplementConfig } from "../config/schema.js";
import { renderTicketMarkdown } from "../core/context.js";
import type { PipelineDeps } from "../core/deps.js";
import { closedReason } from "../core/intake.js";
import { collectSecretValues } from "../core/redact.js";
import type { JobOutcome, RunContext } from "../core/types.js";
import { brainInput, cleanupWorkspace, crashed, errorMessage, jobPaths, patchAttempt, prepareWorkspace, redactOutcome } from "../core/workspace.js";
import type { TicketBundle } from "../tracker/types.js";
import { listFiles } from "../workspace/files.js";
import { git } from "../workspace/git.js";
import { injectToken, splitCredentials, type RemoteCredentials } from "../workspace/mirror.js";
import { runSetup } from "../workspace/setup.js";
import type { Worktree } from "../workspace/worktree.js";
import { branchName } from "./branch.js";
import { extractAgentBrief } from "./brief.js";
import { BranchExistsError, commitWithHooks, installHookWrappers, pushCommit, remoteTicketBranches, restoreFromBundle, saveBundle, stageAndGuard } from "./git.js";
import { renderImplementPrompt } from "./prompt.js";
import { branchUrl, publishImplement } from "./publish.js";
import { validateImplementResult, type Handback, type StoredImplement } from "./result.js";

const MINUTE_MS = 60_000;
const CHECK_TAIL_BYTES = 8 * 1024;
const BUNDLE_FILE = "implement.bundle";
const SKILLS_PREFIX = ".claude/skills/";

const notConfigured: JobOutcome = { status: "failed", error: "implement is not configured (implement block and GITLAB_PUSH_TOKEN)", retryable: false };

type Settings = { settings: ImplementConfig; remote: RemoteCredentials };

const settingsOf = (deps: PipelineDeps): Settings | null => {
  const settings = deps.config.implement;
  const token = deps.secrets.GITLAB_PUSH_TOKEN;
  if (settings === undefined || token === undefined || token === "") return null;
  return { settings, remote: splitCredentials(injectToken(deps.config.workspace.fetchUrl, token)) };
};

const handback = (label: Handback["label"], reason: string, detail = ""): Handback => ({ label, reason, detail });

const commitMessage = (identifier: string, message: string): string => {
  const [subject = "", ...body] = message.trim().split("\n");
  return [`${identifier}: ${subject.trim()}`, ...body].join("\n");
};

/** Stored, then published; dry runs stop before storing. */
const finish = async (ctx: RunContext, deps: PipelineDeps, stored: StoredImplement, branch: string | null): Promise<JobOutcome> => {
  if (ctx.dryRun) return { status: "succeeded", warning: stored.handback === null ? `dry run: would push ${branch ?? "?"}` : `dry run: would hand back: ${stored.handback.reason}` };
  deps.stores.jobs.saveImplementResult(ctx.jobId, stored);
  return publishImplement({
    ctx,
    tracker: deps.tracker,
    redactor: deps.redactor,
    labels: deps.config.tracker.labels,
    stored,
    branch,
    branchUrl: branch === null ? null : branchUrl(deps.config.codehost, branch),
  });
};

const overlaySecrets = async (overlayDir: string): Promise<{ files: string[]; secrets: string[] }> => {
  const files = existsSync(overlayDir) ? await listFiles(overlayDir) : [];
  return { files, secrets: collectSecretValues({}, files.map((file) => join(overlayDir, file))) };
};

const executeImplement = async (ctx: RunContext, deps: PipelineDeps, onWorktree: (worktree: Worktree) => void): Promise<JobOutcome> => {
  const configured = settingsOf(deps);
  if (configured === null) return notConfigured;
  const { settings, remote } = configured;
  const paths = jobPaths(ctx, deps);

  let bundle: TicketBundle;
  let baseSha: string;
  let existing: Array<{ ref: string; sha: string }>;
  try {
    bundle = await deps.tracker.fetchTicket(ctx.issueId);
    const closed = closedReason(ctx.identifier, bundle.state);
    if (closed !== null) return { status: "failed", error: closed, retryable: false };
    await deps.mirror.fetch();
    baseSha = await deps.mirror.resolveSha(deps.config.workspace.baseBranch);
    existing = await remoteTicketBranches(remote, deps.mirror.path, ctx.identifier);
  } catch (err) {
    return { status: "failed", error: errorMessage(err), retryable: true };
  }
  if (existing[0] !== undefined) {
    const ref = existing[0].ref.replace(/^refs\/heads\//, "");
    return finish(ctx, deps, { result: null, handback: handback("readyForHuman", `a branch for ${ctx.identifier} already exists`, ref) }, null);
  }

  const env = buildBrainEnv(deps.secrets, deps.config.brain, deps.config.workspace.port);
  let worktree: Worktree;
  let prompt: string;
  try {
    worktree = await prepareWorkspace(ctx, deps, paths, env, baseSha, onWorktree);
    const brief = extractAgentBrief(bundle.description);
    prompt = renderImplementPrompt(await readFile(settings.prompt, "utf8"), {
      identifier: ctx.identifier,
      teamKey: ctx.teamKey,
      teamName: bundle.team.name,
      ticket: renderTicketMarkdown(bundle),
      workspacePath: worktree.path,
      baseBranch: deps.config.workspace.baseBranch,
      sha: baseSha,
      artifactsDir: paths.artifactsDir,
      stewardPort: deps.config.workspace.port,
      hasBrief: brief !== null,
      brief: brief ?? "",
      branchTypes: settings.branchTypes.join(", "),
    });
  } catch (err) {
    return { status: "failed", error: deps.signal?.aborted === true ? INTERRUPTED_ERROR : errorMessage(err), retryable: true };
  }

  let run: BrainRun;
  try {
    run = await (deps.runBrain ?? runBrainDetached)(
      deps.config.brain,
      brainInput(deps, paths, worktree, prompt, env, "implement", { timeoutMinutes: settings.timeoutMinutes, maxTurns: settings.maxTurns }),
      deps.redactor,
      { ...(deps.signal === undefined ? {} : { signal: deps.signal }) },
    );
  } catch (err) {
    return { status: "failed", error: errorMessage(err), retryable: false };
  }
  patchAttempt(ctx, deps, { transcriptPath: paths.transcriptPath, ...(run.usage === undefined ? {} : { usage: run.usage }) });
  if (!run.ok) return { status: "failed", error: run.error ?? "brain run failed", retryable: run.error === INTERRUPTED_ERROR };

  const validated = validateImplementResult(run.output, settings.branchTypes);
  if (!validated.ok) return finish(ctx, deps, { result: null, handback: handback("readyForHuman", "the agent's result was invalid", validated.error) }, null);
  const result = validated.result;
  if (result.outcome === "needs_info") return finish(ctx, deps, { result, handback: handback("needsInfo", "the ticket needs more information") }, null);
  if (result.outcome === "failed") return finish(ctx, deps, { result, handback: handback("readyForHuman", "the agent could not finish") }, null);

  const { files: overlayFiles, secrets } = await overlaySecrets(deps.config.workspace.overlayDir);
  const guard = await stageAndGuard({ worktreePath: worktree.path, overlayFiles, skillsPrefix: SKILLS_PREFIX, secretValues: secrets });
  if (!guard.ok) return finish(ctx, deps, { result, handback: handback("readyForHuman", guard.reason, guard.detail) }, null);

  const workspaceEnv = buildWorkspaceEnv(deps.config.workspace.port);
  const checks = settings.checks.map((command) => command.replaceAll("{{baseSha}}", baseSha));
  const checked = await runSetup(checks, worktree.path, workspaceEnv, {
    timeoutMs: settings.checksTimeoutMinutes * MINUTE_MS,
    tailBytes: CHECK_TAIL_BYTES,
    ...(deps.signal === undefined ? {} : { signal: deps.signal }),
  });
  if (!checked.ok) return finish(ctx, deps, { result, handback: handback("readyForHuman", "the steward's checks failed", deps.redactor.redact(checked.tail)) }, null);

  const branch = branchName(result.branchType ?? "", ctx.identifier, bundle.title);
  if (ctx.dryRun) {
    const stat = await git(["diff", "--cached", "--stat"], worktree.path);
    return { status: "succeeded", warning: `dry run: would commit on ${branch}\n${commitMessage(ctx.identifier, result.commitMessage)}\n\n${stat.stdout}` };
  }

  // The brain runs for up to an hour; never commit or push for a ticket that was closed meanwhile.
  let latest: TicketBundle;
  try {
    latest = await deps.tracker.fetchTicket(ctx.issueId);
  } catch (err) {
    return { status: "failed", error: errorMessage(err), retryable: true };
  }
  const closedNow = closedReason(ctx.identifier, latest.state);
  if (closedNow !== null) return { status: "failed", error: closedNow, retryable: false };

  const hooksDir = join(paths.jobDir, "hooks");
  await installHookWrappers(worktree.path, hooksDir);
  const committed = await commitWithHooks({
    worktreePath: worktree.path,
    hooksDir,
    messagePath: join(paths.jobDir, "COMMIT_MSG"),
    message: commitMessage(ctx.identifier, result.commitMessage),
    author: settings.commitAuthor,
    env: workspaceEnv,
  });
  if (!committed.ok) return finish(ctx, deps, { result, handback: handback("readyForHuman", "kickoff's commit hooks rejected the change", deps.redactor.redact(committed.output)) }, null);

  await saveBundle(worktree.path, baseSha, join(paths.jobDir, BUNDLE_FILE));
  deps.stores.jobs.recordCommit(ctx.jobId, branch, committed.sha);
  const stored: StoredImplement = { result, handback: null };
  try {
    await pushCommit({ cwd: worktree.path, remote, sha: committed.sha, baseSha, branch, identifier: ctx.identifier, branchTypes: settings.branchTypes });
  } catch (err) {
    if (err instanceof BranchExistsError) return finish(ctx, deps, { result, handback: handback("readyForHuman", `a branch for ${ctx.identifier} already exists`, err.ref) }, null);
    deps.stores.jobs.saveImplementResult(ctx.jobId, stored);
    return { status: "publish_failed", error: `push: ${errorMessage(err)}` };
  }
  deps.stores.jobs.markPushed(ctx.jobId);
  return finish(ctx, deps, stored, branch);
};

export const runImplement = async (ctx: RunContext, deps: PipelineDeps): Promise<JobOutcome> => {
  const workspace: { worktree: Worktree | null } = { worktree: null };
  const outcome = redactOutcome(
    await executeImplement(ctx, deps, (created) => {
      workspace.worktree = created;
    }).catch(crashed),
    deps.redactor,
  );
  await cleanupWorkspace(deps, workspace.worktree, outcome);
  return outcome;
};

/** Retry path: push from the bundle if the push never landed, then comment and labels. Never re-runs the brain or pushes twice. */
export const publishImplementOnly = async (ctx: RunContext, deps: PipelineDeps): Promise<JobOutcome> => {
  const configured = settingsOf(deps);
  if (configured === null) return notConfigured;
  const job = deps.stores.jobs.get(ctx.jobId);
  const stored = job?.implementResult ?? null;
  if (job === null || stored === null) return { status: "failed", error: "no stored implement result to publish", retryable: false };
  if (stored.handback === null && job.pushedAt === null) {
    if (job.branch === null || job.commitSha === null) return { status: "failed", error: "no recorded commit to push", retryable: false };
    try {
      // The recorded commit's parent is the job's base by construction; pushCommit re-verifies the ancestry anyway.
      await restoreFromBundle(deps.mirror.path, join(jobPaths(ctx, deps).jobDir, BUNDLE_FILE), job.commitSha);
      const baseSha = (await git(["rev-parse", `${job.commitSha}^`], deps.mirror.path)).stdout;
      await pushCommit({ cwd: deps.mirror.path, remote: configured.remote, sha: job.commitSha, baseSha, branch: job.branch, identifier: ctx.identifier, branchTypes: configured.settings.branchTypes });
    } catch (err) {
      return { status: "publish_failed", error: `push: ${errorMessage(err)}` };
    }
    deps.stores.jobs.markPushed(ctx.jobId);
  }
  return publishImplement({
    ctx,
    tracker: deps.tracker,
    redactor: deps.redactor,
    labels: deps.config.tracker.labels,
    stored,
    branch: stored.handback === null ? job.branch : null,
    branchUrl: stored.handback === null && job.branch !== null ? branchUrl(deps.config.codehost, job.branch) : null,
  });
};
```

Also: in `executeImplement`, the pre-push `publish_failed` path must save `stored` **before** returning (done above) so the retry has it; the handback paths save via `finish`.

`src/worker/loop.ts`:
- import `{ publishImplementOnly, runImplement } from "../implement/pipeline.js";`
- `WorkerOptions` add `runImplement?: typeof runImplement; publishImplementOnly?: typeof publishImplementOnly;`
- fields `private readonly implement: typeof runImplement; private readonly republishImplement: typeof publishImplementOnly;` set in the constructor from `deps.runImplement ?? runImplement` / `deps.publishImplementOnly ?? publishImplementOnly`.
- in `run`, before the review line: `if (job.kind === "implement") return job.implementResult === null ? await this.implement(ctx, deps) : await this.republishImplement(ctx, deps);`

`src/cli/inline.ts` `dispatch`: add first line
`if (job.kind === "implement") return job.implementResult === null ? runImplement(ctx, runtime.deps) : publishImplementOnly(ctx, runtime.deps);` (import from `../implement/pipeline.js`).

Worker retry semantics: an implement job that returned `publish_failed` after a failed push has `implementResult` saved, so the retry goes to `publishImplementOnly`; one that failed before storing re-runs `runImplement` from scratch (safe: nothing was pushed).

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm typecheck && pnpm lint && npx vitest run`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/implement src/worker src/cli/inline.ts test/implement test/worker
git commit -m "feat(implement): pipeline, publish, retry and worker dispatch"
```

---

### Task 10: `steward implement KEY [--dry-run]`

**Files:**
- Create: `src/cli/implement.ts`
- Modify: `src/cli/program.ts`, `test/cli/helpers.ts`
- Test: `test/cli/implement.test.ts`

**Interfaces:**
- Consumes: `runImplement` (Task 9), `shouldEnqueue`, `jobKindFor` (Task 3), `ReadOnlyTracker` (Task 4), `withRunLock`, `runInline`, `tailJob`, `reportOutcome` (`src/cli/inline.ts`), `answers`, `localHealthUrl` (`src/cli/probe.ts`), `buildRuntime`.
- Produces: `registerImplement(program: Command, ctx: CliContext): void`; `ConfigPaths.implement?: { prompt: string; checks?: string[] }` and `ConfigPaths.labels?: boolean` in the test helper (writes `.env` with `GITLAB_PUSH_TOKEN` when `implement` is set).

- [ ] **Step 1: Write the failing tests**

In `test/cli/helpers.ts` `writeConfig`: add to `ConfigPaths` `labels?: boolean; implement?: { prompt: string; checks?: string[] };` and in the template put `${p.labels === true || p.implement !== undefined ? 'labels: {},' : ""}` inside `tracker: { … }` and, after `${review}`, `${p.implement === undefined ? "" : `implement: ${JSON.stringify({ prompt: p.implement.prompt, checks: p.implement.checks ?? [], commitAuthor: { name: "Ticket Steward", email: "steward@example.com" } })},`}`; after writing the config, when `p.implement !== undefined` also `await writeFile(join(dir, ".env"), "GITLAB_PUSH_TOKEN=glpat-push-token-value\n")`.

`test/cli/implement.test.ts` (define `implemented` exactly as in `test/implement/pipeline.test.ts`; mirror the setup of `test/cli/enrich.test.ts`: `tmpRepo`, `FakeTracker`, `makeContext` with `factories: { tracker, codehost: new FakeCodeHost(), brain }`, `writeConfig(dir, {…, implement: { prompt: <repo prompts/implement.md path> } })`, `.gitignore` committed to the source repo containing `.env`, then `repo.mirror.fetch()`):

```ts
it("dry run prints the branch and commit message and writes nothing", async () => {
  const brain = new FakeBrain({ result: implemented, editWorkspace: { "src/adapter.ts": "export const adapter = 2;\n" } });
  const { ctx, stdout } = makeContext({ factories: { tracker, codehost: new FakeCodeHost(), brain } });

  await buildProgram(ctx).parseAsync(["node", "steward", "--config", configPath, "implement", "API-1", "--dry-run"]);

  expect(stdout()).toContain("would commit on fix/API-1-adapter-drops-the-last-chunk");
  expect(stdout()).toContain("API-1: Keep the last chunk");
  expect(tracker.comments("issue-1")).toEqual([]);
  expect(await git(repo.repo, ["branch", "--list", "*/API-1-*"])).toBe("");
});

it("refuses when implement is not configured", async () => {
  const plain = await writeConfig(await tmpConfigDir(), { dataDir: repo.dataDir, overlayDir: repo.overlayDir, promptPath: repo.promptPath, fetchUrl: repo.repo, port, serverPort });
  const { ctx, stderr } = makeContext({ factories: { tracker, codehost: new FakeCodeHost(), brain: new FakeBrain() } });
  await expect(buildProgram(ctx).parseAsync(["node", "steward", "--config", plain, "implement", "API-1"])).rejects.toBeInstanceOf(ExitSignal);
  expect(stderr()).toContain("implement is not configured");
});
```

`FakeBrain` gains an `editWorkspace?: Record<string, string>` option in `test/fakes/fakeBrain.ts`: in `run`, after `writeFiles`, write each entry relative to `input.workspacePath` (mkdir parent, writeFile).

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/cli/implement.test.ts`
Expected: FAIL (unknown command `implement`).

- [ ] **Step 3: Implement**

`src/cli/implement.ts`:

```ts
import type { Command } from "commander";
import { jobKindFor, shouldEnqueue } from "../core/intake.js";
import type { RunContext } from "../core/types.js";
import { runImplement } from "../implement/pipeline.js";
import { ReadOnlyTracker } from "../tracker/readOnly.js";
import type { IssueTrigger } from "../tracker/types.js";
import { fail, loadFromProgram, println, type CliContext } from "./context.js";
import { reportOutcome, runInline, tailJob, withRunLock } from "./inline.js";
import { answers, localHealthUrl } from "./probe.js";
import { buildRuntime } from "./runtime.js";

const HEALTH_TIMEOUT_MS = 2_000;

export const registerImplement = (program: Command, ctx: CliContext): void => {
  program
    .command("implement")
    .description("implement one ticket on a new branch: enqueue when serve is running, otherwise run inline")
    .argument("<key>", "issue key or UUID")
    .option("--dry-run", "run up to the steward's checks, print the would-be commit, write nothing", false)
    .action(async (key: string, opts: { dryRun: boolean }) => {
      const runtime = await buildRuntime(await loadFromProgram(program, ctx), ctx);
      const { config } = runtime.loaded;
      if (config.implement === undefined) return fail(ctx, "implement is not configured (add an implement block and GITLAB_PUSH_TOKEN)");
      const { id, identifier, teamKey } = await runtime.tracker.resolveIssueId(key);
      const event: IssueTrigger = { kind: "cli", issueId: id, identifier, teamKey, action: "implement" };
      const { jobs } = runtime.stores;
      const kind = jobKindFor(event);
      const decision = shouldEnqueue({
        event,
        allowlist: config.tracker.teams,
        gatewayIssues: config.tracker.gatewayIssues,
        priorSuccess: false,
        hasQueuedJob: opts.dryRun ? false : jobs.findQueued(id, kind) !== null,
      });
      if (decision.action === "skip") return fail(ctx, decision.reason);
      if (opts.dryRun) {
        const tracker = new ReadOnlyTracker(runtime.tracker);
        const dryCtx: RunContext = { jobId: 0, attempt: 1, issueId: id, identifier, teamKey, trigger: event, dryRun: true };
        println(ctx, `dry run for ${identifier}; nothing will be committed, pushed or written`);
        const outcome = await withRunLock(runtime, ctx, () => runImplement(dryCtx, { ...runtime.deps, tracker }));
        if (outcome.status === "succeeded" && outcome.warning !== undefined) println(ctx, outcome.warning);
        return reportOutcome(ctx, 0, outcome.status === "succeeded" ? { status: "succeeded" } : outcome);
      }
      if (decision.action === "attach") return println(ctx, `${identifier} already has queued implement job ${jobs.findQueued(id, kind)?.id}`);
      const jobId = jobs.enqueue(event);
      if (await answers(ctx.fetchImpl, localHealthUrl(config.server.port), HEALTH_TIMEOUT_MS)) {
        println(ctx, `steward serve is running; enqueued job ${jobId}`);
        return reportOutcome(ctx, jobId, await tailJob(runtime.stores, jobId, ctx));
      }
      reportOutcome(ctx, jobId, await runInline(runtime, jobId, ctx));
    });
};
```

`src/cli/program.ts`: import and call `registerImplement(program, ctx);` after `registerEnrich`.

`priorSuccess: false` is deliberate: the CLI re-runs an implemented ticket on purpose (the existing-branch check still stops a second push).

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm typecheck && pnpm lint && npx vitest run test/cli`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cli test/cli test/fakes/fakeBrain.ts
git commit -m "feat(cli): steward implement KEY [--dry-run]"
```

---

### Task 11: Doctor checks (labels, push token, branch protection)

**Files:**
- Create: `src/codehost/gitlabProtection.ts`
- Modify: `src/cli/doctor.ts`
- Test: `test/codehost/gitlabProtection.test.ts`, `test/cli/doctor.test.ts`

**Interfaces:**
- Produces: `interface ProtectedBranch { name: string; push: AccessLevel[]; merge: AccessLevel[] }`, `interface AccessLevel { accessLevel: number; description: string; userId: number | null; groupId: number | null; deployKeyId: number | null }`, `listProtectedBranches(opts: { baseUrl: string; project: string; token: string; fetchImpl: typeof fetch }): Promise<ProtectedBranch[]>`, `protectionProblems(branches: ProtectedBranch[], required: string[]): string[]`.

- [ ] **Step 1: Write the failing tests**

`test/codehost/gitlabProtection.test.ts`:

```ts
import { listProtectedBranches, protectionProblems, type ProtectedBranch } from "../../src/codehost/gitlabProtection.js";

const level = (accessLevel: number, description: string, userId: number | null = null) => ({ accessLevel, description, userId, groupId: null, deployKeyId: null });

describe("protectionProblems", () => {
  const good: ProtectedBranch[] = [
    { name: "main", push: [level(40, "Ada Lovelace", 1)], merge: [level(0, "No one")] },
    { name: "dev", push: [level(30, "Grace Hopper", 2)], merge: [level(40, "Maintainers")] },
  ];

  it("passes named-user and maintainer-only protection", () => {
    expect(protectionProblems(good, ["main", "dev"])).toEqual([]);
  });

  it("flags a missing branch", () => {
    expect(protectionProblems(good, ["main", "dev", "staging"])).toEqual(["staging is not protected"]);
  });

  it("flags a role grant that lets Developers push or merge", () => {
    const loose = [{ name: "dev", push: [level(30, "Developers + Maintainers")], merge: [] }];
    expect(protectionProblems(loose, ["dev"])).toEqual(["dev lets Developers push"]);
  });

  it("flags a project bot on an allowlist", () => {
    const bot = [{ name: "main", push: [], merge: [level(30, "project_74525306_bot_ab12", 9)] }];
    expect(protectionProblems(bot, ["main"])).toEqual(["main lets project_74525306_bot_ab12 merge"]);
  });
});

describe("listProtectedBranches", () => {
  it("reads and maps the API response", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      new Response(JSON.stringify([{ name: "main", push_access_levels: [{ access_level: 40, access_level_description: "Maintainers", user_id: null, group_id: null, deploy_key_id: null }], merge_access_levels: [] }]), { status: 200 }),
    );
    const branches = await listProtectedBranches({ baseUrl: "https://gitlab.example", project: "acme/repo", token: "t", fetchImpl });
    expect(branches).toEqual([{ name: "main", push: [level(40, "Maintainers")], merge: [] }]);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe("https://gitlab.example/api/v4/projects/acme%2Frepo/protected_branches?per_page=100");
  });
});
```

`test/cli/doctor.test.ts` — add (reuse the file's `repo`/`dir`/`port`/`serverPort` setup; `writeConfig` with `implement` from Task 10):

```ts
it("fails when a workflow label is missing in Linear", async () => {
  const configPath = await writeConfig(dir, { dataDir: repo.dataDir, overlayDir: repo.overlayDir, promptPath: repo.promptPath, fetchUrl: repo.repo, port, serverPort, implement: { prompt: repo.promptPath } });
  const fetchImpl: typeof fetch = async (input, init) => {
    const body = typeof init?.body === "string" ? init.body : "";
    if (String(input) === "https://api.linear.app/graphql" && body.includes("issueLabels")) {
      return new Response(JSON.stringify({ data: { issueLabels: { nodes: [{ name: "needs-triage" }] } } }), { status: 200 });
    }
    if (String(input) === "https://api.linear.app/graphql") return new Response(JSON.stringify({ data: { viewer: { id: "u", name: "Bot" } } }), { status: 200 });
    throw new Error(`unexpected fetch ${String(input)}`);
  };
  const { ctx, stdout } = makeContext({ fetchImpl });

  await expect(buildProgram(ctx).parseAsync(["node", "steward", "--config", configPath, "doctor"])).rejects.toBeInstanceOf(ExitSignal);

  expect(stdout()).toContain("[fail] linear labels: missing in Linear: ready-for-agent, needs-info, ready-for-human, agent-implemented");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/codehost/gitlabProtection.test.ts test/cli/doctor.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

`src/codehost/gitlabProtection.ts`:

```ts
import { z } from "zod";

export interface AccessLevel {
  accessLevel: number;
  description: string;
  userId: number | null;
  groupId: number | null;
  deployKeyId: number | null;
}

export interface ProtectedBranch {
  name: string;
  push: AccessLevel[];
  merge: AccessLevel[];
}

const DEVELOPER = 30;
const PROJECT_BOT = /^project_\d+_bot/;

const LevelSchema = z.object({
  access_level: z.number(),
  access_level_description: z.string(),
  user_id: z.number().nullish(),
  group_id: z.number().nullish(),
  deploy_key_id: z.number().nullish(),
});
const BranchesSchema = z.array(z.object({ name: z.string(), push_access_levels: z.array(LevelSchema).default([]), merge_access_levels: z.array(LevelSchema).default([]) }));

const toLevel = (level: z.infer<typeof LevelSchema>): AccessLevel => ({
  accessLevel: level.access_level,
  description: level.access_level_description,
  userId: level.user_id ?? null,
  groupId: level.group_id ?? null,
  deployKeyId: level.deploy_key_id ?? null,
});

export const listProtectedBranches = async (opts: { baseUrl: string; project: string; token: string; fetchImpl: typeof fetch }): Promise<ProtectedBranch[]> => {
  const url = `${opts.baseUrl.replace(/\/$/, "")}/api/v4/projects/${encodeURIComponent(opts.project)}/protected_branches?per_page=100`;
  const response = await opts.fetchImpl(url, { headers: { "PRIVATE-TOKEN": opts.token } });
  if (!response.ok) throw new Error(`protected_branches answered ${response.status}`);
  return BranchesSchema.parse(await response.json()).map((branch) => ({ name: branch.name, push: branch.push_access_levels.map(toLevel), merge: branch.merge_access_levels.map(toLevel) }));
};

const isRoleGrant = (level: AccessLevel): boolean => level.userId === null && level.groupId === null && level.deployKeyId === null;

/** What would let a Developer-role project bot push to or merge into a branch that must stay closed to it. */
export const protectionProblems = (branches: ProtectedBranch[], required: string[]): string[] =>
  required.flatMap((name) => {
    const branch = branches.find((candidate) => candidate.name === name);
    if (branch === undefined) return [`${name} is not protected`];
    const problems: string[] = [];
    for (const [verb, levels] of [["push", branch.push], ["merge", branch.merge]] as const) {
      if (levels.some((level) => isRoleGrant(level) && level.accessLevel === DEVELOPER)) problems.push(`${name} lets Developers ${verb}`);
      for (const level of levels.filter((candidate) => PROJECT_BOT.test(candidate.description))) problems.push(`${name} lets ${level.description} ${verb}`);
    }
    return problems;
  });
```

`src/cli/doctor.ts` — add `implementChecks(loaded, ctx): Check[]` and include it wherever the other check groups are concatenated:

```ts
const LabelsResponse = z.object({ data: z.object({ issueLabels: z.object({ nodes: z.array(z.object({ name: z.string() })) }) }) });

const implementChecks = (loaded: LoadedConfig, ctx: CliContext): Check[] => {
  const { config, secrets } = loaded;
  const labels = config.tracker.labels;
  const checks: Check[] = [];
  if (labels !== undefined) {
    checks.push({
      name: "linear labels",
      run: async () => {
        const apiKey = secrets.LINEAR_API_KEY ?? "";
        const names = [labels.triage, labels.implement, labels.needsInfo, labels.readyForHuman, labels.implemented];
        const response = await ctx.fetchImpl(LINEAR_GRAPHQL_URL, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: apiKey },
          body: JSON.stringify({ query: "query($names: [String!]) { issueLabels(first: 250, filter: { name: { in: $names } }) { nodes { name } } }", variables: { names } }),
          signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
        });
        if (!response.ok) return flunk(`issueLabels answered ${response.status}`);
        const found = new Set(LabelsResponse.parse(await response.json()).data.issueLabels.nodes.map((node) => node.name.toLowerCase()));
        const absent = names.filter((name) => !found.has(name.toLowerCase()));
        return absent.length === 0 ? ok(names.join(", ")) : flunk(`missing in Linear: ${absent.join(", ")}`);
      },
    });
  }
  const settings = config.implement;
  if (settings === undefined) return checks;
  checks.push({
    name: "push token",
    run: async () => {
      const token = secrets.GITLAB_PUSH_TOKEN ?? "";
      if (token === "") return flunk("GITLAB_PUSH_TOKEN is missing");
      const remote = splitCredentials(injectToken(config.workspace.fetchUrl, token));
      const result = await git(["ls-remote", "--heads", remote.url, config.workspace.baseBranch], config.dataDir, remote.env);
      return result.exitCode === 0 ? ok(`GITLAB_PUSH_TOKEN reaches ${remote.url}`) : flunk(`ls-remote failed: ${scrubCredentials(result.stderr)}`);
    },
  });
  if (config.codehost.kind === "gitlab") {
    const { baseUrl, project } = config.codehost;
    checks.push({
      name: "branch protection",
      run: async () => {
        const token = secrets.GITLAB_TOKEN ?? "";
        if (token === "") return warn("GITLAB_TOKEN is missing; cannot read branch protection");
        const problems = protectionProblems(await listProtectedBranches({ baseUrl, project, token, fetchImpl: ctx.fetchImpl }), settings.protectedBranches);
        return problems.length === 0 ? ok(`${settings.protectedBranches.join(", ")} closed to Developer-role bots`) : flunk(problems.join("; "));
      },
    });
  }
  return checks;
};
```

(imports: `listProtectedBranches, protectionProblems` from `../codehost/gitlabProtection.js`; `git, scrubCredentials` from `../workspace/git.js`; `injectToken, splitCredentials` from `../workspace/mirror.js`.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm typecheck && pnpm lint && npx vitest run`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/codehost/gitlabProtection.ts src/cli/doctor.ts test/codehost test/cli/doctor.test.ts
git commit -m "feat(doctor): check labels, push token and branch protection"
```

---

### Task 12: Docs and example config

**Files:**
- Modify: `docs/ops.md`, `README.md`, `examples/kickoff/steward.config.ts`

- [ ] **Step 1: Update the example config**

In `examples/kickoff/steward.config.ts` replace `triggerLabel: "steward"` in `tracker` with `labels: {}` (all defaults) and add after `review`:

```ts
  // Label-driven implementation (ready-for-agent). Requires GITLAB_PUSH_TOKEN in .env: a project access token, Developer role, write_repository only.
  implement: {
    prompt: "./prompts/implement.md",
    checks: ["pnpm turbo check-types lint --filter='...[{{baseSha}}]'"],
    commitAuthor: { name: "Ticket Steward", email: "steward@concentrate.ai" },
  },
```

- [ ] **Step 2: Update `docs/ops.md`**

Replace the `tracker.triggerLabel` paragraph added earlier with a "Label workflows" subsection covering: the five labels to create in Linear (workspace-level), the two human decisions, the flow table from the spec, `GITLAB_PUSH_TOKEN` (project access token, Developer, `write_repository` only; never `api`), branch protection (keep `main`/`staging`/`dev` protected with named allowlists; never add the bot), the `implement` config block with defaults, `steward implement KEY [--dry-run]`, that hand-backs are successes with a `handed back:` warning, and that Done/Canceled tickets are never worked on. Add `GITLAB_PUSH_TOKEN` to the secrets rotation table: "Create a new token, update `.env`, restart; `steward doctor` confirms it reaches the repo; revoke the old one."

- [ ] **Step 3: Update `README.md`**

Add a short "Label workflows" section after "Running alongside ticket-gateway": `needs-triage` → triage verdict; `ready-for-agent` → branch pushed, pipeline opens the MR; link to `docs/ops.md`.

- [ ] **Step 4: Verify and commit**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: PASS.

```bash
git add docs/ops.md README.md examples/kickoff/steward.config.ts
git commit -m "docs: label workflows, push token and implement config"
```

---

### Task 13: Deploy and live verification (on the box)

Not TDD; each step states its check. Outward-facing steps (GitLab push, Linear writes) are marked **confirm first**.

- [ ] **Step 1: Pre-flight**

Run: `curl -s http://127.0.0.1:3020/health | jq -c .worker` → expect `{"running":null}` and `queued: 0` before touching the service. If a job is running, wait.

- [ ] **Step 2: Deploy the build**

```bash
sudo git -C /opt/ticket-steward -c safe.directory='*' fetch -q /home/admin/ticket-steward feat/label-workflows
sudo git -C /opt/ticket-steward -c safe.directory='*' merge --ff-only FETCH_HEAD
cd /opt/ticket-steward && sudo env PATH=/usr/local/lib/ticket-steward/bin:$PATH pnpm install --frozen-lockfile && sudo env PATH=/usr/local/lib/ticket-steward/bin:$PATH pnpm build
```

Check: `sudo grep -rl "publishImplementOnly" /opt/ticket-steward/dist | head -1` prints a path.

- [ ] **Step 3: Prompts**

```bash
sudo cp -p /etc/ticket-steward/prompts/enrich.md /etc/ticket-steward/prompts/enrich.md.bak-$(date +%Y%m%d)
sudo install -o steward -g steward -m 0640 /home/admin/ticket-steward/prompts/enrich.md /etc/ticket-steward/prompts/enrich.md
sudo install -o steward -g steward -m 0640 /home/admin/ticket-steward/prompts/implement.md /etc/ticket-steward/prompts/implement.md
```

(Before this change the live `enrich.md` was byte-identical to the repo's, checked 2026-09-30. If `sudo cmp /etc/ticket-steward/prompts/enrich.md <(git -C /home/admin/ticket-steward show main:prompts/enrich.md)` reports a difference at deploy time, someone edited it on the box: merge those edits instead of overwriting.)

- [ ] **Step 4: Live config**

Back up `/etc/ticket-steward/steward.config.ts`, then: replace `triggerLabel: "steward"` with `labels: {}`, and add the `implement` block from Task 12 Step 1. Check: `steward doctor` (as the steward user, from `/etc/ticket-steward`) — every line `[ok]`, including `linear labels`, `push token`, `branch protection`. If `linear labels` fails, the labels do not exist yet: ask the user to create them (or, on their go-ahead, create them as workspace labels via the API).

- [ ] **Step 5: Push smoke test — confirm first**

Proves `GITLAB_PUSH_TOKEN` can push (Developer role) without triggering CI or an MR, then removes the branch:

```bash
sudo -u steward bash -c 'cd /var/lib/ticket-steward && T=$(grep "^GITLAB_PUSH_TOKEN=" /etc/ticket-steward/.env | cut -d= -f2- | tr -d "\"");
  U="https://oauth2:${T}@gitlab.com/concentrateai/kickoff.git"; S=$(git -C repo.git rev-parse dev);
  git -C repo.git push -o ci.skip "$U" "$S:refs/heads/chore/STEWARD-0-push-check" 2>&1 | sed -E "s#//[^@]*@#//***@#";
  git -C repo.git push -o ci.skip "$U" --delete refs/heads/chore/STEWARD-0-push-check 2>&1 | sed -E "s#//[^@]*@#//***@#"'
```

Expected: both pushes succeed (the token has Developer access and `ci.skip` stops the pipeline, so no MR is opened). Optionally, and only with the user's agreement, prove protection server-side by pushing the same `dev` commit to `refs/heads/dev` with the push token: it is a no-op update if accepted, and GitLab must **reject** it (`You are not allowed to push code to protected branches`); rejection is the pass condition. `steward doctor`'s `branch protection` check already covers this from the API side.

- [ ] **Step 6: Restart and watch**

`sudo systemctl restart ticket-steward`, then `journalctl -u ticket-steward -f`. Ask the user to add `needs-triage` to a test ticket; expect `webhook received … action: enqueue`, then a job that ends with the Enrichment section (brief for ready-for-human) and the label swapped. Then `ready-for-agent` on a small, well-specified ticket; expect `job finished … kind: implement` and the branch on GitLab.

- [ ] **Step 7: Record**

Update the memory/ops notes only if something non-obvious came up (e.g. `pnpm audit` blocking commits).
