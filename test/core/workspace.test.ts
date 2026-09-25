import type { PipelineDeps } from "../../src/core/deps.js";
import { jobPaths } from "../../src/core/workspace.js";
import type { RunContext } from "../../src/core/types.js";

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
      workRoot: "/data/work",
      artifactsDir: "/data/jobs/12/artifacts",
      transcriptPath: "/data/jobs/12/attempt-2.jsonl",
    });
  });

  it("uses a pid-scoped worktree for dry runs", () => {
    expect(jobPaths(ctx(true), deps).worktreeName).toBe(`dry-${process.pid}`);
  });
});
