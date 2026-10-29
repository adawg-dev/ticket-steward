import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buildProgram } from "../../src/cli/program.js";
import { acquireRunLock } from "../../src/core/lock.js";
import { jobLine, SERVE_DOWN } from "../../src/cli/jobs.js";
import { localHealthUrl } from "../../src/cli/probe.js";
import { openStores, type Stores } from "../../src/store/index.js";
import type { CliFactories } from "../../src/cli/context.js";
import type { TriggerEvent } from "../../src/tracker/types.js";
import { FakeBrain } from "../fakes/fakeBrain.js";
import { FakeCodeHost } from "../fakes/fakeCodeHost.js";
import { FakeTracker } from "../fakes/fakeTracker.js";
import { ExitSignal, makeContext, tmpConfigDir, waitFor, writeConfig } from "./helpers.js";

const createdEvent: TriggerEvent = {
  kind: "linear",
  run: "implement",
  issueId: "issue-1",
  identifier: "API-1",
  teamKey: "API",
  sessionId: "session-1",
  message: null,
};

const cliEvent: TriggerEvent = { kind: "cli", issueId: "issue-2", identifier: "API-2", teamKey: "API", action: "implement" };

const handedBack = { result: null, handback: { label: "readyForHuman" as const, reason: "the agent could not finish", detail: "" } };

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

const run = (args: string[], fetchImpl?: typeof fetch, overrides: CliFactories = {}) => {
  const factories: CliFactories = { tracker: new FakeTracker(), brain: new FakeBrain(), codehost: new FakeCodeHost(), ...overrides };
  const context = makeContext({ factories, ...(fetchImpl === undefined ? {} : { fetchImpl }) });
  return { ...context, done: buildProgram(context.ctx).parseAsync(["node", "steward", "--config", configPath, ...args]) };
};

/** Answers only the local /health probe, the way a running `steward serve` would. */
const serveIsUp: typeof fetch = async (input) => {
  if (String(input) === localHealthUrl(3020)) return new Response(JSON.stringify({ ok: true }), { status: 200 });
  throw new Error("Intended Test Error");
};

describe("steward jobs", () => {
  it("lists jobs newest first with status, identifier, kind and attempts", async () => {
    const first = stores.jobs.enqueue(createdEvent);
    const second = stores.jobs.enqueue(cliEvent);
    stores.jobs.claimById(second);
    const firstRow = stores.jobs.get(first);
    const secondRow = stores.jobs.get(second);

    const { stdout, done } = run(["jobs"]);
    await done;

    expect(stdout()).toBe(
      [`${second}\trunning\tAPI-2\timplement\tattempts=1\t${secondRow?.createdAt}`, `${first}\tqueued\tAPI-1\timplement\tattempts=0\t${firstRow?.createdAt}`, ""].join("\n"),
    );
  });

  it("prints the job kind, so loop jobs show as await_review, fix or restart", () => {
    const id = stores.jobs.enqueue({ kind: "loop", issueId: "issue-1", identifier: "API-1", teamKey: "API", loopId: 3, step: "await" });
    const job = stores.jobs.get(id);
    if (job === null) throw new Error("job missing");
    expect(jobLine(job)).toBe(`${id}\tqueued\tAPI-1\tawait_review\tattempts=0\t${job.createdAt}`);
  });

  it("shows the loop and its rounds for a fix job", async () => {
    const implementId = stores.jobs.enqueue({ kind: "cli", issueId: "issue-1", identifier: "API-1", teamKey: "API", action: "implement" });
    const loopId = stores.loops.create({
      issueId: "issue-1", identifier: "API-1", teamKey: "API", implementJobId: implementId, branch: "fix/API-1-a", baseSha: "a".repeat(40),
      headSha: "b".repeat(40), worktreeName: "ticket-API-1", labelDriven: true, sessionId: null,
    });
    stores.loops.appendRound(loopId, { round: 1, headSha: "c".repeat(40), score: 3, pipeline: "success", fixed: 2, declined: 1, outcome: "changed" });
    const fixId = stores.jobs.enqueue({ kind: "loop", issueId: "issue-1", identifier: "API-1", teamKey: "API", loopId, step: "fix" });
    const { ctx, stdout } = makeContext();

    await buildProgram(ctx).parseAsync(["node", "steward", "--config", configPath, "jobs", "show", String(fixId)]);
    expect(stdout()).toContain("round 1: 3/5 head ccccccc pipeline success fixed 2 declined 1 changed");

    const implement = makeContext();
    await buildProgram(implement.ctx).parseAsync(["node", "steward", "--config", configPath, "jobs", "show", String(implementId)]);
    expect(implement.stdout()).toContain("round 1: 3/5");
  });

  it("filters by status and honours the limit", async () => {
    stores.jobs.enqueue(createdEvent);
    const second = stores.jobs.enqueue(cliEvent);
    const third = stores.jobs.enqueue(cliEvent);
    const thirdRow = stores.jobs.get(third);

    const { stdout, done } = run(["jobs", "--status", "queued", "--limit", "1"]);
    await done;

    expect(second).toBeLessThan(third);
    expect(stdout()).toBe(`${third}\tqueued\tAPI-2\timplement\tattempts=0\t${thirdRow?.createdAt}\n`);
  });

  it("shows the row with its stored result, attempts, transcript and artifacts", async () => {
    const id = stores.jobs.enqueue(createdEvent);
    stores.jobs.claimById(id);
    const attempt = stores.attempts.start(id);
    stores.attempts.finish(attempt.id, { transcriptPath: join(dataDir, "jobs", String(id), "attempt-1.jsonl") });
    stores.jobs.saveImplementResult(id, handedBack);
    stores.jobs.finish(id, { status: "succeeded" });
    const artifacts = join(dataDir, "jobs", String(id), "artifacts");
    await mkdir(artifacts, { recursive: true });
    await writeFile(join(artifacts, "shot.png"), "png");
    const job = stores.jobs.get(id);
    expect(job?.implementResult).toEqual(handedBack);

    const { stdout, done } = run(["jobs", "show", String(id)]);
    await done;

    expect(stdout()).toBe(
      [
        `# job\n${JSON.stringify(job, null, 2)}`,
        `# attempts\n${JSON.stringify(stores.attempts.forJob(id), null, 2)}`,
        `# transcripts\n${join(dataDir, "jobs", String(id), "attempt-1.jsonl")}`,
        `# artifacts (${artifacts})\nshot.png`,
        "",
      ].join("\n"),
    );
  });

  it("exits 1 when the job does not exist", async () => {
    const { done, stderr } = run(["jobs", "show", "99"]);

    await expect(done).rejects.toEqual(new ExitSignal(1));
    expect(stderr()).toMatch(/99/);
  });

  it("retry requeues the job for the running worker and tails it", async () => {
    const id = stores.jobs.enqueue(createdEvent);
    stores.jobs.claimById(id);
    stores.jobs.saveImplementResult(id, handedBack);
    stores.jobs.finish(id, { status: "publish_failed", error: "linear 502" });

    const { stdout, done } = run(["jobs", "retry", String(id)], serveIsUp);
    await waitFor(() => stdout().includes(`job ${id} queued\n`));
    expect(stores.jobs.get(id)?.status).toBe("queued");
    expect(stores.jobs.get(id)?.finishedAt).toBeNull();
    stores.jobs.claimById(id);
    stores.jobs.finish(id, { status: "succeeded" });
    await done;

    expect(stdout()).toBe(`job ${id}: publish-only (hand-back stored; labels only, nothing to push)\nsteward serve is running; requeued job ${id}\njob ${id} queued\njob ${id} succeeded\n`);
    expect(stores.jobs.get(id)?.attempts).toBe(2);
  });

  describe("retry of an implement job", () => {
    const implementEvent: TriggerEvent = createdEvent;
    const result = { outcome: "implemented" as const, summary: "s", reviewNotes: [], checksRun: [], questions: [], failureDetail: null, media: [] };
    const retryLine = async (setup: (id: number) => void): Promise<string> => {
      const id = stores.jobs.enqueue(implementEvent);
      stores.jobs.claimById(id);
      setup(id);
      stores.jobs.finish(id, { status: "publish_failed", error: "push: 502" });
      const { stdout, done } = run(["jobs", "retry", String(id)], serveIsUp);
      await waitFor(() => stdout().includes(`job ${id} queued\n`));
      stores.jobs.claimById(id);
      stores.jobs.finish(id, { status: "succeeded" });
      await done;
      return stdout().split("\n")[0]?.replace(`job ${id}: `, "") ?? "";
    };

    it("is a full run without a stored result", async () => {
      expect(await retryLine(() => undefined)).toBe("full run");
    });

    it("checks the remote without pushing when the push was never marked", async () => {
      expect(
        await retryLine((id) => {
          stores.jobs.recordCommit(id, "fix/API-1-keep", "d".repeat(40));
          stores.jobs.saveImplementResult(id, { result, handback: null });
        }),
      ).toBe("publish-only (check whether fix/API-1-keep landed, then labels; never pushes)");
    });

    it("only publishes once the push landed", async () => {
      expect(
        await retryLine((id) => {
          stores.jobs.recordCommit(id, "fix/API-1-keep", "d".repeat(40));
          stores.jobs.saveImplementResult(id, { result, handback: null });
          stores.jobs.markPushed(id);
        }),
      ).toBe("publish-only (fix/API-1-keep already pushed; labels only)");
    });

    it("only publishes a stored hand-back", async () => {
      expect(await retryLine((id) => stores.jobs.saveImplementResult(id, { result: null, handback: { label: "readyForHuman", reason: "the steward's checks failed", detail: "" } }))).toBe(
        "publish-only (hand-back stored; labels only, nothing to push)",
      );
    });
  });

  it("retry without serve runs nothing in the CLI, which holds no Linear token, and leaves the job as it was", async () => {
    const id = stores.jobs.enqueue(createdEvent);
    stores.jobs.claimById(id);
    stores.jobs.finish(id, { status: "failed", error: "linear 502", retryable: false });
    // No tracker, brain or code host injected: a run the CLI started would have to reach them.
    const context = makeContext();
    const done = buildProgram(context.ctx).parseAsync(["node", "steward", "--config", configPath, "jobs", "retry", String(id)]);

    await expect(done).rejects.toEqual(new ExitSignal(1));
    expect(context.stderr()).toContain(SERVE_DOWN(id));
    expect(context.stdout()).toBe("");
    expect(stores.jobs.get(id)).toMatchObject({ status: "failed", attempts: 1, error: "linear 502" });
    expect(stores.attempts.forJob(id)).toHaveLength(0);
  });

  it("retry exits 1 when the job is running under the worker", async () => {
    const id = stores.jobs.enqueue(createdEvent);
    stores.jobs.claimById(id);

    const { done, stderr } = run(["jobs", "retry", String(id)], serveIsUp);

    await expect(done).rejects.toEqual(new ExitSignal(1));
    expect(stderr()).toMatch(new RegExp(String(id)));
  });

  it("gc reports what retention removed", async () => {
    const { stdout, done } = run(["jobs", "gc"]);
    await done;

    expect(stdout()).toBe("removed 0 worktrees, 0 job directories, 0 session directories, 0 deliveries\n");
  });

  it("gc refuses to run while another steward process holds run.lock", async () => {
    const lock = acquireRunLock(dataDir);
    const { stderr, done } = run(["jobs", "gc"]);

    await expect(done).rejects.toEqual(new ExitSignal(1));
    expect(stderr()).toMatch(/holds run\.lock/);
    lock?.release();
  });

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
});
