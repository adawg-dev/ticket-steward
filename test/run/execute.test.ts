import { join } from "node:path";
import type { BrainInput, BrainRun } from "../../src/brain/types.js";
import { Redactor } from "../../src/core/redact.js";
import { executeRun, PERSON_COMMITS_MARKER, type ExecuteEnv } from "../../src/run/execute.js";
import type { RunSpec } from "../../src/run/protocol.js";
import { FakeBrain } from "../fakes/fakeBrain.js";
import { commitFile, git, makeSourceRepo, removeDir, tmpDir } from "../workspace/helpers.js";

let root: string;
let repo: string;
let base: string;

const specFor = (patch: Partial<RunSpec> = {}): RunSpec => ({
  version: 1,
  runId: "7-1",
  jobId: 7,
  kind: "fix",
  identifier: "API-1",
  issueId: "issue-1",
  checkout: { ref: null, sha: base },
  baseSha: base,
  worktreePath: repo,
  artifactsDir: join(root, "artifacts"),
  transcriptPath: join(root, "attempt-1.jsonl"),
  prompt: "Fix the findings.",
  personCommits: null,
  output: "fix",
  resumeSessionId: "session-1",
  limits: { timeoutMinutes: 1, maxTurns: 5, setupTimeoutMinutes: 1 },
  push: null,
  setup: [],
  checks: [],
  interactive: false,
  ...patch,
});

const envFor = (brain: FakeBrain, patch: Partial<ExecuteEnv> = {}): ExecuteEnv => ({
  workspace: { path: repo, sha: base },
  brain: { kind: "claude-code", model: "claude-test", maxTurns: 5, timeoutMinutes: 1 },
  brainEnv: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
  mcpServers: { push: { type: "http", url: "http://127.0.0.1:4181/mcp/push" } },
  denyPaths: ["/run/egress-ca"],
  redactor: new Redactor(["sk_live_value"]),
  runBrain: (_config, input: BrainInput): Promise<BrainRun> => brain.run(input, () => undefined),
  ...patch,
});

beforeEach(async () => {
  root = await tmpDir();
  ({ repo, sha: base } = await makeSourceRepo(root));
});

afterEach(async () => {
  await removeDir(root);
});

describe("executeRun", () => {
  it("runs the brain in the workspace with the spec's prompt, limits, session and MCP servers", async () => {
    const brain = new FakeBrain({ result: { outcome: "changed" }, sessionId: "session-2", usage: { inputTokens: 3, outputTokens: 2 } });

    const report = await executeRun(specFor(), envFor(brain));

    expect(report).toEqual({ runId: "7-1", ok: true, error: null, interrupted: false, setupFailed: false, sessionId: "session-2", output: { outcome: "changed" }, usage: { inputTokens: 3, outputTokens: 2 } });
    expect(brain.lastInput()).toMatchObject({
      workspacePath: repo,
      prompt: "Fix the findings.",
      timeoutMs: 60_000,
      maxTurns: 5,
      model: "claude-test",
      output: "fix",
      resumeSessionId: "session-1",
      denyPaths: ["/run/egress-ca"],
      mcpServers: { push: { type: "http", url: "http://127.0.0.1:4181/mcp/push" } },
    });
  });

  it("reports a failed setup without running the brain, its tail redacted", async () => {
    const brain = new FakeBrain({ result: {} });

    const report = await executeRun(specFor({ setup: ["echo sk_live_value", "exit 3"] }), envFor(brain));

    expect(report).toMatchObject({ ok: false, setupFailed: true, interrupted: false, sessionId: null });
    expect(report.error).toBe("setup failed:\n$ echo ***\n***\n$ exit 3\n[exit 3]\n");
    expect(brain.runs).toBe(0);
  });

  it("runs setup in the workspace with the brain's env before the brain", async () => {
    const brain = new FakeBrain({ result: {} });

    const report = await executeRun(specFor({ setup: ["test \"$STEWARD_MARK\" = set"] }), envFor(brain, { brainEnv: { PATH: process.env.PATH ?? "/usr/bin:/bin", STEWARD_MARK: "set" } }));

    expect(report.ok).toBe(true);
    expect(brain.runs).toBe(1);
  });

  it("replaces the person-commits marker with the commits between the spec's two shas", async () => {
    const first = await commitFile(repo, "a.txt", "a\n");
    const second = await commitFile(repo, "b.txt", "b\n");
    const brain = new FakeBrain({ result: {} });

    await executeRun(specFor({ prompt: `People pushed:\n${PERSON_COMMITS_MARKER}\nEnd.`, personCommits: { from: base, to: second } }), envFor(brain));

    const short = async (sha: string): Promise<string> => git(repo, ["rev-parse", "--short", sha]);
    expect(first).not.toBe(second);
    expect(brain.lastInput().prompt).toBe(`People pushed:\n${await short(second)} Test add b.txt\n${await short(first)} Test add a.txt\nEnd.`);
  });

  it("repeats a list item's prefix for each person commit", async () => {
    const first = await commitFile(repo, "a.txt", "a\n");
    const second = await commitFile(repo, "b.txt", "b\n");
    const brain = new FakeBrain({ result: {} });

    await executeRun(specFor({ prompt: `People pushed:\n  - ${PERSON_COMMITS_MARKER}\nEnd.`, personCommits: { from: base, to: second } }), envFor(brain));

    const short = async (sha: string): Promise<string> => git(repo, ["rev-parse", "--short", sha]);
    expect(brain.lastInput().prompt).toBe(`People pushed:\n  - ${await short(second)} Test add b.txt\n  - ${await short(first)} Test add a.txt\nEnd.`);
  });

  it("drops the marker when the spec has no person commits", async () => {
    const brain = new FakeBrain({ result: {} });

    await executeRun(specFor({ prompt: `Before.${PERSON_COMMITS_MARKER}After.` }), envFor(brain));

    expect(brain.lastInput().prompt).toBe("Before.After.");
  });

  it("reports an interrupted brain run as interrupted, and a failing one with its error", async () => {
    const interrupted = await executeRun(specFor(), envFor(new FakeBrain({ fail: true, error: "interrupted" })));
    const failed = await executeRun(specFor(), envFor(new FakeBrain({ fail: true, error: "error_max_turns" })));

    expect(interrupted).toMatchObject({ ok: false, interrupted: true, error: "interrupted" });
    expect(failed).toMatchObject({ ok: false, interrupted: false, error: "error_max_turns" });
  });

  it("reports a brain that throws as a failed run", async () => {
    const report = await executeRun(specFor(), envFor(new FakeBrain(), { runBrain: () => Promise.reject(new Error("runner exited")) }));

    expect(report).toMatchObject({ ok: false, interrupted: false, setupFailed: false, error: "runner exited" });
  });
});
