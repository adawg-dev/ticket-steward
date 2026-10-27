import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { GreptileConfig, StewardConfig } from "../../src/config/schema.js";
import { startLoop } from "../../src/greptile/start.js";
import { openStores, type Job, type Stores } from "../../src/store/index.js";
import type { TriggerEvent } from "../../src/tracker/types.js";
import { freshDataDir } from "../store/helpers.js";

const HEAD = "c".repeat(40);
const BASE = "a".repeat(40);

const GREPTILE: GreptileConfig = {
  botUsername: "greptile-bot", maxRounds: 5, prompt: "/dev/null", pollSeconds: 60, mrTimeoutMinutes: 60,
  reviewTimeoutMinutes: 30, pipelineTimeoutMinutes: 60, ciLogLines: 200,
};

const labeled: TriggerEvent = {
  kind: "issue.labeled", issueId: "issue-1", identifier: "API-1", teamKey: "API", deliveryId: "d-1", description: "", stateType: "unstarted", action: "implement",
};

let dataDir: string;
let stores: Stores;

const LABELS = { triage: "needs-triage", implement: "ready-for-agent", needsInfo: "needs-info", readyForHuman: "ready-for-human", implemented: "agent-implemented", approved: "agent-approved" };

const depsWith = (greptile: GreptileConfig | undefined): { config: StewardConfig; stores: Stores } => {
  const config: StewardConfig = {
    dataDir,
    brain: { kind: "claude-code", model: "claude-test", maxTurns: 5, timeoutMinutes: 1 },
    tracker: { kind: "linear", teams: ["API"], gatewayIssues: "enrich", bugLabels: ["Bug"], labels: LABELS },
    codehost: { kind: "gitlab", baseUrl: "https://gitlab.example", project: "acme/repo" },
    workspace: { fetchUrl: "https://gitlab.example/acme/repo.git", baseBranch: "dev", overlayDir: join(dataDir, "overlay"), setup: [], setupTimeoutMinutes: 1, port: 4100, keepOnFailure: false },
    retention: { keptWorktrees: 3, days: 30 },
    prompt: join(dataDir, "prompt.md"),
    server: { port: 3020, publicUrl: "https://steward.example" },
    ...(greptile === undefined ? {} : { greptile }),
  };
  return { config, stores };
};

/** An implement job that committed on a branch, pushed it unless told otherwise, and left a session. */
const implementJob = (trigger: TriggerEvent = labeled, opts: { pushed?: boolean } = {}): Job => {
  const id = stores.jobs.enqueue(trigger);
  stores.jobs.claimById(id);
  stores.jobs.recordCommit(id, "fix/API-1-adapter", HEAD);
  stores.jobs.recordSession(id, "session-1");
  if (opts.pushed !== false) stores.jobs.markPushed(id);
  const job = stores.jobs.get(id);
  if (job === null) throw new Error("job not stored");
  return job;
};

const start = { baseSha: BASE, worktreeName: "ticket-API-1" };

beforeEach(() => {
  dataDir = freshDataDir();
  stores = openStores(dataDir);
});

afterEach(() => {
  stores.db.close();
});

describe("startLoop", () => {
  it("creates a loop at round 0 from the pushed implement job and enqueues its first await", () => {
    const job = implementJob();

    const id = startLoop(depsWith(GREPTILE), job, start);

    expect(id).not.toBeNull();
    expect(stores.loops.get(id ?? 0)).toMatchObject({
      issueId: "issue-1", identifier: "API-1", teamKey: "API", implementJobId: job.id, branch: "fix/API-1-adapter", baseSha: BASE, headSha: HEAD,
      worktreeName: "ticket-API-1", labelDriven: true, sessionId: "session-1", round: 0, state: "awaiting_mr",
    });
    const awaits = stores.jobs.list({ limit: 50 }).filter((row) => row.kind === "await_review");
    expect(awaits).toHaveLength(1);
    expect(awaits[0]?.trigger).toEqual({ kind: "loop", issueId: "issue-1", identifier: "API-1", teamKey: "API", loopId: id, step: "await" });
  });

  it("is idempotent: a second call returns the same loop and enqueues nothing more", () => {
    const job = implementJob();
    const first = startLoop(depsWith(GREPTILE), job, start);

    const second = startLoop(depsWith(GREPTILE), job, start);

    expect(second).toBe(first);
    expect(stores.jobs.list({ limit: 50 }).filter((row) => row.kind === "await_review")).toHaveLength(1);
  });

  it("starts from a new-ticket implement trigger too", () => {
    const job = implementJob({ ...labeled, kind: "issue.created" });

    expect(startLoop(depsWith(GREPTILE), job, start)).not.toBeNull();
  });

  it("returns null without greptile configured", () => {
    expect(startLoop(depsWith(undefined), implementJob(), start)).toBeNull();
    expect(stores.loops.latestForIssue("issue-1")).toBeNull();
  });

  it("returns null for a cli trigger", () => {
    const job = implementJob({ kind: "cli", issueId: "issue-1", identifier: "API-1", teamKey: "API", action: "implement" });

    expect(startLoop(depsWith(GREPTILE), job, start)).toBeNull();
    expect(stores.loops.latestForIssue("issue-1")).toBeNull();
  });

  it("returns null for a label trigger that is not implement", () => {
    expect(startLoop(depsWith(GREPTILE), implementJob({ ...labeled, action: "triage" }), start)).toBeNull();
  });

  it("returns null before the push", () => {
    expect(startLoop(depsWith(GREPTILE), implementJob(labeled, { pushed: false }), start)).toBeNull();
    expect(stores.jobs.list({ limit: 50 }).filter((row) => row.kind === "await_review")).toHaveLength(0);
  });
});
