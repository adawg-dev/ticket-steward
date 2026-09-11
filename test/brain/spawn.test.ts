import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FakeBrainPids } from "../../src/brain/fake.js";
import { runBrainDetached } from "../../src/brain/spawn.js";
import { INTERRUPTED_ERROR, type BrainInput } from "../../src/brain/types.js";
import type { BrainConfig } from "../../src/config/schema.js";
import { Redactor } from "../../src/core/redact.js";

const fakeBrain = { kind: "fake", model: "fake", maxTurns: 1, timeoutMinutes: 1 } as unknown as BrainConfig;
const SECRET = "supersecretvalue123";

let dir: string;

const input = (overrides: Partial<BrainInput>): BrainInput => ({
  workspacePath: dir,
  artifactsDir: join(dir, "artifacts"),
  transcriptPath: join(dir, "jobs", "1", "attempt-1.jsonl"),
  prompt: `investigate ${SECRET}`,
  env: { PATH: process.env.PATH ?? "/usr/bin:/bin", NODE_ENV: "test" },
  timeoutMs: 10_000,
  maxTurns: 1,
  model: "fake",
  mcpServers: {},
  denyPaths: [],
  ...overrides,
});

const pidIsGone = (pid: number) => expect(() => process.kill(pid, 0)).toThrow();

/** The fake brain's second transcript line carries its runner pid and the pid of the `sleep` it spawned. */
const transcriptPids = async (transcriptPath: string): Promise<FakeBrainPids> => {
  const [, pids] = (await readFile(transcriptPath, "utf8")).trim().split("\n");
  return JSON.parse(pids ?? "") as FakeBrainPids;
};

const pidsAreGone = async (transcriptPath: string): Promise<void> => {
  const { runnerPid, sleepPid } = await transcriptPids(transcriptPath);
  expect(typeof sleepPid).toBe("number");
  await vi.waitFor(() => pidIsGone(runnerPid));
  await vi.waitFor(() => pidIsGone(sleepPid ?? -1));
};

describe("runBrainDetached", () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    dir = await mkdtemp(join(tmpdir(), "steward-brain-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("completes the run and kills everything the brain spawned", async () => {
    const run = await runBrainDetached(fakeBrain, input({}), new Redactor([]));
    expect(run.ok).toBe(true);
    const { sleepPid } = run.output as { sleepPid: number };
    expect(typeof sleepPid).toBe("number");
    await vi.waitFor(() => pidIsGone(sleepPid));
  });

  it("returns ok:false on timeout and kills the runner and its children", async () => {
    const brainInput = input({ prompt: "hang forever", timeoutMs: 5_000 });
    const run = await runBrainDetached(fakeBrain, brainInput, new Redactor([]));
    expect(run.ok).toBe(false);
    expect(run.output).toBeUndefined();
    await pidsAreGone(brainInput.transcriptPath);
  });

  it("settles as interrupted and kills the process group when the signal aborts", async () => {
    const brainInput = input({ prompt: "hang forever" });
    const controller = new AbortController();
    const running = runBrainDetached(fakeBrain, brainInput, new Redactor([]), { signal: controller.signal });
    await vi.waitFor(() => transcriptPids(brainInput.transcriptPath), { timeout: 15_000 });
    controller.abort();
    const run = await running;
    expect(run).toEqual({ ok: false, output: undefined, error: INTERRUPTED_ERROR });
    await pidsAreGone(brainInput.transcriptPath);
  });

  it("returns ok:false when the runner exits before reporting a result", async () => {
    const run = await runBrainDetached(fakeBrain, input({ prompt: "crash now" }), new Redactor([]));
    expect(run.ok).toBe(false);
    expect(run.output).toBeUndefined();
  });

  it("writes redacted lines to the transcript", async () => {
    const brainInput = input({});
    await runBrainDetached(fakeBrain, brainInput, new Redactor([SECRET]));
    const [first] = (await readFile(brainInput.transcriptPath, "utf8")).split("\n");
    expect(first).toBe(JSON.stringify({ type: "fake", prompt: "investigate ***" }));
  });

  it("still settles the run when the transcript cannot be written", async () => {
    const run = await runBrainDetached(fakeBrain, input({ transcriptPath: "/dev/full" }), new Redactor([]));
    expect(run.ok).toBe(true);
  });
});
