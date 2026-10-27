import type { PipelineDeps } from "../../src/core/deps.js";
import { join } from "node:path";
import { brainInput, jobPaths, sessionsDir } from "../../src/core/workspace.js";
import type { RunContext } from "../../src/core/types.js";
import type { Worktree } from "../../src/workspace/worktree.js";

const ctx = (dryRun: boolean): RunContext => ({
  jobId: 12,
  attempt: 2,
  issueId: "issue-1",
  identifier: "API-1",
  teamKey: "API",
  trigger: { kind: "cli", issueId: "issue-1", identifier: "API-1", teamKey: "API" },
  dryRun,
});

const deps = { config: { dataDir: "/data" } } as PipelineDeps;

describe("jobPaths", () => {
  it("names the worktree after the job and attempt", () => {
    expect(jobPaths(ctx(false), deps)).toEqual({
      worktreeName: "12-2",
      jobDir: "/data/jobs/12",
      workRoot: "/data/work",
      artifactsDir: "/data/jobs/12/artifacts",
      transcriptPath: "/data/jobs/12/attempt-2.jsonl",
    });
  });

  it("uses a pid-scoped worktree for dry runs", () => {
    expect(jobPaths(ctx(true), deps).worktreeName).toBe(`dry-${process.pid}`);
  });

  it("exposes the job directory", () => {
    expect(jobPaths(ctx(false), deps).jobDir).toBe(join(deps.config.dataDir, "jobs", String(ctx(false).jobId)));
  });
});

describe("brainInput", () => {
  const fullDeps = {
    config: {
      dataDir: "/data",
      brain: { kind: "claude-code", model: "claude-test", maxTurns: 80, timeoutMinutes: 30 },
      workspace: { overlayDir: "/overlay" },
    },
    mirror: { path: "/mirror.git" },
    binPath: "/bin/steward",
    configPath: "/etc/steward/config.json",
  } as unknown as PipelineDeps;
  const worktree: Worktree = { path: "/data/work/12-2", sha: "abc123", destroy: async () => undefined };
  const paths = jobPaths(ctx(false), fullDeps);

  it("uses the configured brain limits by default", () => {
    const input = brainInput(fullDeps, paths, worktree, "prompt", {}, "enrich");
    expect(input.timeoutMs).toBe(1_800_000);
    expect(input.maxTurns).toBe(80);
  });

  it("uses per-kind limits when given", () => {
    const input = brainInput(fullDeps, paths, worktree, "prompt", {}, "implement", { limits: { timeoutMinutes: 60, maxTurns: 150 } });
    expect(input.timeoutMs).toBe(3_600_000);
    expect(input.maxTurns).toBe(150);
    expect(input.output).toBe("implement");
  });

  it("denies the sessions dir to the agent", () => {
    expect(brainInput(fullDeps, paths, worktree, "prompt", {}, "enrich").denyPaths).toContain("/data/sessions");
  });

  it("passes the session to resume only when given", () => {
    expect(brainInput(fullDeps, paths, worktree, "prompt", {}, "fix", { resumeSessionId: "s0" }).resumeSessionId).toBe("s0");
    expect(brainInput(fullDeps, paths, worktree, "prompt", {}, "enrich")).not.toHaveProperty("resumeSessionId");
  });
});

describe("sessionsDir", () => {
  it("lives under the data dir", () => {
    expect(sessionsDir(deps.config)).toBe("/data/sessions");
  });
});
