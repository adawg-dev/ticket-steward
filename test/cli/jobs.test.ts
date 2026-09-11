import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buildProgram } from "../../src/cli/program.js";
import { openStores, type Stores } from "../../src/store/index.js";
import type { BrainResult } from "../../src/core/result.js";
import type { TriggerEvent } from "../../src/tracker/types.js";
import { ExitSignal, makeContext, tmpConfigDir, writeConfig } from "./helpers.js";

const createdEvent: TriggerEvent = {
  kind: "issue.created",
  issueId: "issue-1",
  identifier: "API-1",
  teamKey: "API",
  deliveryId: "delivery-1",
  description: "A bug report",
};

const cliEvent: TriggerEvent = { kind: "cli", issueId: "issue-2", identifier: "API-2", teamKey: "API" };

const brainResult: BrainResult = {
  template: { matched: "Bugs", conforms: false, missing: ["Repro Steps"] },
  summary: "The bug is in the adapter.",
  enrichment: "See `src/adapter.ts:12`.",
  attachments: [],
  confidence: "high",
};

let dir: string;
let dataDir: string;
let configPath: string;
let stores: Stores;

beforeEach(async () => {
  vi.restoreAllMocks();
  dir = await tmpConfigDir();
  dataDir = join(dir, "data");
  configPath = await writeConfig(dir, {
    dataDir,
    overlayDir: join(dir, "overlay"),
    promptPath: join(dir, "prompt.md"),
    fetchUrl: "https://gitlab.example/acme/repo.git",
    port: 4100,
    serverPort: 3020,
  });
  stores = openStores(dataDir);
});

afterEach(async () => {
  stores.db.close();
  await rm(dir, { recursive: true, force: true });
});

const run = (args: string[]) => {
  const context = makeContext();
  return { ...context, done: buildProgram(context.ctx).parseAsync(["node", "steward", "--config", configPath, ...args]) };
};

describe("steward jobs", () => {
  it("lists jobs newest first with status, identifier, trigger and attempts", async () => {
    const first = stores.jobs.enqueue(createdEvent);
    const second = stores.jobs.enqueue(cliEvent);
    stores.jobs.claimById(second);
    const firstRow = stores.jobs.get(first);
    const secondRow = stores.jobs.get(second);

    const { stdout, done } = run(["jobs"]);
    await done;

    expect(stdout()).toBe(
      [`${second}\trunning\tAPI-2\tcli\tattempts=1\t${secondRow?.createdAt}`, `${first}\tqueued\tAPI-1\tissue.created\tattempts=0\t${firstRow?.createdAt}`, ""].join("\n"),
    );
  });

  it("filters by status and honours the limit", async () => {
    stores.jobs.enqueue(createdEvent);
    const second = stores.jobs.enqueue(cliEvent);
    const third = stores.jobs.enqueue(cliEvent);
    const thirdRow = stores.jobs.get(third);

    const { stdout, done } = run(["jobs", "--status", "queued", "--limit", "1"]);
    await done;

    expect(second).toBeLessThan(third);
    expect(stdout()).toBe(`${third}\tqueued\tAPI-2\tcli\tattempts=0\t${thirdRow?.createdAt}\n`);
  });

  it("shows the row, attempts, transcript, artifacts and stored result", async () => {
    const id = stores.jobs.enqueue(createdEvent);
    stores.jobs.claimById(id);
    const attempt = stores.attempts.start(id);
    stores.attempts.finish(attempt.id, { transcriptPath: join(dataDir, "jobs", String(id), "attempt-1.jsonl") });
    stores.jobs.saveResult(id, brainResult, "abc1234");
    stores.jobs.finish(id, { status: "succeeded" });
    const artifacts = join(dataDir, "jobs", String(id), "artifacts");
    await mkdir(artifacts, { recursive: true });
    await writeFile(join(artifacts, "shot.png"), "png");
    const job = stores.jobs.get(id);
    const { result, ...row } = job ?? { result: null };

    const { stdout, done } = run(["jobs", "show", String(id)]);
    await done;

    expect(stdout()).toBe(
      [
        `# job\n${JSON.stringify(row, null, 2)}`,
        `# attempts\n${JSON.stringify(stores.attempts.forJob(id), null, 2)}`,
        `# transcripts\n${join(dataDir, "jobs", String(id), "attempt-1.jsonl")}`,
        `# artifacts (${artifacts})\nshot.png`,
        `# result\n${JSON.stringify(result, null, 2)}`,
        "",
      ].join("\n"),
    );
  });

  it("exits 1 when the job does not exist", async () => {
    const { done, stderr } = run(["jobs", "show", "99"]);

    await expect(done).rejects.toEqual(new ExitSignal(1));
    expect(stderr()).toBe("job 99 not found\n");
  });

  it("gc reports what retention removed", async () => {
    const { stdout, done } = run(["jobs", "gc"]);
    await done;

    expect(stdout()).toBe("removed 0 worktrees, 0 job directories, 0 deliveries\n");
  });
});
