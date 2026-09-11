import { rm } from "node:fs/promises";
import { buildProgram } from "../../src/cli/program.js";
import { STEWARD_BEGIN, STEWARD_END } from "../../src/core/intake.js";
import type { BrainResult } from "../../src/core/result.js";
import { openStores } from "../../src/store/index.js";
import type { TicketBundle } from "../../src/tracker/types.js";
import { FakeBrain } from "../fakes/fakeBrain.js";
import { FakeCodeHost } from "../fakes/fakeCodeHost.js";
import { FakeTracker } from "../fakes/fakeTracker.js";
import { freeTcpPort, tmpRepo, type TmpRepo } from "../fakes/tmpRepo.js";
import { ExitSignal, makeContext, tmpConfigDir, writeConfig } from "./helpers.js";

const PROMPT_TEMPLATE = "Ticket:\n{{ticket}}\nWorkspace: {{workspacePath}} @ {{sha}}\n";

const issue: TicketBundle = {
  id: "issue-1",
  identifier: "API-1",
  url: "https://linear.app/acme/issue/API-1",
  title: "Adapter drops the last chunk",
  description: "The adapter loses the final chunk.",
  team: { id: "team-1", key: "API", name: "API" },
  state: { name: "Triage", type: "triage" },
  labels: ["bug"],
  priority: 2,
  creator: { name: "Ada", isBot: false },
  createdAt: "2026-09-11T00:00:00.000Z",
  comments: [],
  attachments: [],
  appliedTemplate: null,
  templates: [],
};

const brainResult: BrainResult = {
  template: { matched: "Bugs", conforms: false, missing: ["Repro Steps"] },
  summary: "The adapter truncates the final chunk.",
  enrichment: "See `src/adapter.ts:12`.",
  attachments: [],
  confidence: "high",
};

let dir: string;
let repo: TmpRepo;
let configPath: string;
let tracker: FakeTracker;

beforeEach(async () => {
  vi.restoreAllMocks();
  dir = await tmpConfigDir();
  repo = await tmpRepo(PROMPT_TEMPLATE);
  tracker = new FakeTracker([issue]);
  configPath = await writeConfig(dir, {
    dataDir: repo.dataDir,
    overlayDir: repo.overlayDir,
    promptPath: repo.promptPath,
    fetchUrl: repo.repo,
    port: await freeTcpPort(),
    serverPort: await freeTcpPort(),
  });
});

afterEach(async () => {
  await repo.cleanup();
  await rm(dir, { recursive: true, force: true });
});

const run = (args: string[], brain = new FakeBrain({ result: brainResult })) => {
  const context = makeContext({ factories: { tracker, brain, codehost: new FakeCodeHost() } });
  return { ...context, brain, done: buildProgram(context.ctx).parseAsync(["node", "steward", "--config", configPath, "enrich", ...args]) };
};

describe("steward enrich --dry-run", () => {
  it("prints the rendered section and recorded writes without touching the ticket or the store", async () => {
    const { stdout, done, brain } = run(["API-1", "--dry-run"]);
    await done;

    const out = stdout();
    const section = out.slice(out.indexOf(STEWARD_BEGIN), out.indexOf(STEWARD_END) + STEWARD_END.length);
    expect(section.split("\n")[1]).toBe("## Enrichment");
    expect(section).toContain(`See [src/adapter.ts:12](https://fake.example/blob/${repo.sha}/src/adapter.ts#L12).`);
    expect(out).toContain("--- recorded writes (2) ---\nwriteDescription(issue-1)");
    expect(out).toContain("\npostComment(issue-1)");
    expect(out.endsWith("job 0 succeeded\n")).toBe(true);
    expect(brain.runs).toBe(1);
    expect(tracker.getDescription("issue-1")).toBe("The adapter loses the final chunk.");
    expect(tracker.comments("issue-1")).toEqual([]);
    expect(openStores(repo.dataDir).jobs.list({ limit: 10 })).toEqual([]);
  });

  it("exits 1 when the brain fails", async () => {
    const { done } = run(["API-1", "--dry-run"], new FakeBrain({ fail: true }));

    await expect(done).rejects.toEqual(new ExitSignal(1));
  });
});

describe("steward enrich (inline)", () => {
  it("runs the job under run.lock when serve is not running and writes the section", async () => {
    const { stdout, done } = run(["API-1"]);
    await done;

    const stores = openStores(repo.dataDir);
    const jobs = stores.jobs.list({ limit: 10 });
    expect(jobs.length).toBe(1);
    expect(jobs[0]?.status).toBe("succeeded");
    expect(jobs[0]?.trigger).toEqual({ kind: "cli", issueId: "issue-1", identifier: "API-1", teamKey: "API" });
    expect(stores.attempts.forJob(1).length).toBe(1);
    expect(stdout()).toBe("job 1 running (attempt 1)\njob 1 succeeded\n");
    expect(tracker.getDescription("issue-1")).toContain(STEWARD_BEGIN);
    expect(tracker.comments("issue-1").length).toBe(1);
  });

  it("exits 1 with the intake reason when the team is not allowlisted", async () => {
    tracker.addIssue({ ...issue, id: "issue-2", identifier: "OPS-7", team: { id: "team-2", key: "OPS", name: "Ops" } });

    const { done, stderr, brain } = run(["OPS-7"]);

    await expect(done).rejects.toEqual(new ExitSignal(1));
    expect(stderr()).toBe("Ticket Steward is not configured for team OPS\n");
    expect(brain.runs).toBe(0);
    expect(openStores(repo.dataDir).jobs.list({ limit: 10 })).toEqual([]);
  });

  it("does not run a second full enrichment when a stored result exists and jobs retry is used", async () => {
    await run(["API-1"]).done;
    tracker.setDescription("issue-1", "Edited by a human.");
    const context = makeContext({ factories: { tracker, brain: new FakeBrain({ result: brainResult }), codehost: new FakeCodeHost() } });

    await buildProgram(context.ctx).parseAsync(["node", "steward", "--config", configPath, "jobs", "retry", "1"]);

    expect(context.stdout()).toBe(`job 1: publish-only (result stored at ${repo.sha})\njob 1 running (attempt 2)\njob 1 succeeded\n`);
    expect(tracker.getDescription("issue-1").startsWith("Edited by a human.\n\n<!-- ticket-steward:begin -->")).toBe(true);
  });
});
