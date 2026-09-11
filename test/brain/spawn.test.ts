import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runBrainDetached } from "../../src/brain/spawn.js";
import type { BrainInput } from "../../src/brain/types.js";
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

  it("returns ok:false on timeout", async () => {
    const run = await runBrainDetached(fakeBrain, input({ prompt: "hang forever", timeoutMs: 500 }), new Redactor([]));
    expect(run.ok).toBe(false);
    expect(run.output).toBeUndefined();
  });

  it("writes redacted lines to the transcript", async () => {
    const brainInput = input({});
    await runBrainDetached(fakeBrain, brainInput, new Redactor([SECRET]));
    const transcript = await readFile(brainInput.transcriptPath, "utf8");
    expect(transcript).toBe(`${JSON.stringify({ type: "fake", prompt: "investigate ***" })}\n`);
  });
});
