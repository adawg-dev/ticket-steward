import { rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildProgram } from "../../src/cli/program.js";
import { openStores } from "../../src/store/index.js";
import type { TicketBundle } from "../../src/tracker/types.js";
import { FakeBrain } from "../fakes/fakeBrain.js";
import { FakeCodeHost } from "../fakes/fakeCodeHost.js";
import { FakeGitLabMr, fakeMergeRequest } from "../fakes/fakeGitLabMr.js";
import { FakeTracker } from "../fakes/fakeTracker.js";
import { freeTcpPort, tmpRepo, type TmpRepo } from "../fakes/tmpRepo.js";
import { ExitSignal, makeContext, tmpConfigDir, writeConfig } from "./helpers.js";

const IMPLEMENT_PROMPT = fileURLToPath(new URL("../../prompts/implement.md", import.meta.url));
const FIX_PROMPT = fileURLToPath(new URL("../../prompts/fix.md", import.meta.url));
const HEAD = "c".repeat(40);
const PERSON = "d".repeat(40);

const issue: TicketBundle = {
  id: "issue-1",
  identifier: "API-1",
  url: "https://linear.app/acme/issue/API-1",
  title: "Adapter drops the last chunk",
  description: "The adapter loses the final chunk.",
  team: { id: "team-1", key: "API", name: "API" },
  state: { name: "In Review", type: "started" },
  labels: ["ready-for-human"],
  priority: 2,
  creator: { name: "Ada", isBot: false },
  createdAt: "2026-10-27T00:00:00.000Z",
  comments: [],
  attachments: [],
  appliedTemplate: null,
  templates: [],
};

let dir: string;
let repo: TmpRepo;
let tracker: FakeTracker;
let gitlab: FakeGitLabMr;
let port: number;
let serverPort: number;

const config = (greptile: boolean): Promise<string> =>
  writeConfig(dir, {
    dataDir: repo.dataDir,
    overlayDir: repo.overlayDir,
    promptPath: repo.promptPath,
    fetchUrl: repo.repo,
    port,
    serverPort,
    implement: { prompt: IMPLEMENT_PROMPT },
    ...(greptile ? { greptile: { prompt: FIX_PROMPT } } : {}),
  });

/** A loop for API-1 in `state`, as the steward's own store holds it; returns its id. */
const seedLoop = (state: "handed_back" | "awaiting_review"): number => {
  const stores = openStores(repo.dataDir);
  try {
    const jobId = stores.jobs.enqueue({ kind: "cli", issueId: "issue-1", identifier: "API-1", teamKey: "API", action: "implement" });
    stores.jobs.claimById(jobId);
    stores.jobs.finish(jobId, { status: "succeeded" });
    const id = stores.loops.create({
      issueId: "issue-1", identifier: "API-1", teamKey: "API", implementJobId: jobId, branch: "fix/API-1-adapter", baseSha: "a".repeat(40),
      headSha: HEAD, worktreeName: "ticket-API-1", labelDriven: true, sessionId: "session-1",
    });
    stores.loops.update(id, { state, round: 3, handedBackAt: "2026-10-27T09:00:00.000Z" });
    return id;
  } finally {
    stores.db.close();
  }
};

const run = (configPath: string) => {
  const context = makeContext({ factories: { tracker, codehost: new FakeCodeHost(), brain: new FakeBrain(), gitlab } });
  return { ...context, parse: () => buildProgram(context.ctx).parseAsync(["node", "steward", "--config", configPath, "fix", "API-1"]) };
};

beforeEach(async () => {
  dir = await tmpConfigDir();
  repo = await tmpRepo("unused");
  tracker = new FakeTracker([structuredClone(issue)]);
  gitlab = new FakeGitLabMr();
  port = await freeTcpPort();
  serverPort = await freeTcpPort();
});

afterEach(async () => {
  await repo.cleanup();
  await rm(dir, { recursive: true, force: true });
});

describe("steward fix", () => {
  it("exits 1 when the ticket has no fix loop", async () => {
    const { parse, stderr } = run(await config(true));

    await expect(parse()).rejects.toEqual(new ExitSignal(1));
    expect(stderr()).toContain("API-1 has no handed-back fix loop");
  });

  it("exits 1 when the ticket's loop is still running", async () => {
    seedLoop("awaiting_review");
    const { parse, stderr } = run(await config(true));

    await expect(parse()).rejects.toEqual(new ExitSignal(1));
    expect(stderr()).toContain("API-1 has no handed-back fix loop");
  });

  it("refuses when greptile is not configured", async () => {
    const { parse, stderr } = run(await config(false));

    await expect(parse()).rejects.toBeInstanceOf(ExitSignal);
    expect(stderr()).toContain("greptile is not configured");
  });

  it("restarts a handed-back loop inline, leaving labels alone", async () => {
    const id = seedLoop("handed_back");
    gitlab.openMr = fakeMergeRequest({ sha: PERSON, sourceBranch: "fix/API-1-adapter" });
    const { parse, stdout } = run(await config(true));

    await parse();

    expect(stdout()).toMatch(/job \d+ succeeded/);
    const stores = openStores(repo.dataDir);
    try {
      expect(stores.loops.get(id)).toMatchObject({ state: "awaiting_review", round: 0, headSha: PERSON, adoptedFrom: HEAD, labelDriven: false });
      expect(stores.jobs.list({ limit: 50 }).filter((job) => job.kind === "restart")).toHaveLength(1);
    } finally {
      stores.db.close();
    }
    expect(tracker.labelSwaps()).toEqual([]);
  });
});
