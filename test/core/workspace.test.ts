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
    const input = brainInput(fullDeps, paths, worktree, "prompt", {}, "implement");
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
    expect(brainInput(fullDeps, paths, worktree, "prompt", {}, "implement").denyPaths).toContain("/data/sessions");
  });

  it("adds the push server, with its target and no secrets, only for a run that may push", () => {
    const target = { jobId: 12, worktreePath: worktree.path, identifier: "API-1", issueId: "issue-1", mode: "create" as const, branch: null, baseSha: "b".repeat(40), loopId: null, port: 4100 };
    const push = brainInput(fullDeps, paths, worktree, "prompt", {}, "implement", { push: target }).mcpServers.push;
    expect(push?.args).toEqual(["/bin/steward", "mcp", "push", "--config", "/etc/steward/config.json", "--target", JSON.stringify(target)]);
    expect(Object.keys(push?.env ?? {}).sort()).toEqual(["HOME", "PATH"]);
    expect(brainInput(fullDeps, paths, worktree, "prompt", {}, "implement").mcpServers).not.toHaveProperty("push");
  });

  it("tells the Playwright server where the browsers are only when the steward's env names it", () => {
    vi.stubEnv("PLAYWRIGHT_BROWSERS_PATH", "/opt/ms-playwright");
    expect(brainInput(fullDeps, paths, worktree, "prompt", {}, "implement").mcpServers.playwright?.env?.PLAYWRIGHT_BROWSERS_PATH).toBe("/opt/ms-playwright");
    vi.stubEnv("PLAYWRIGHT_BROWSERS_PATH", undefined);
    expect(brainInput(fullDeps, paths, worktree, "prompt", {}, "implement").mcpServers.playwright?.env).not.toHaveProperty("PLAYWRIGHT_BROWSERS_PATH");
    vi.unstubAllEnvs();
  });

  it("adds the Orbit server with no secrets and points the agent's own orbit at the data dir's graph", () => {
    const input = brainInput(fullDeps, paths, worktree, "prompt", { PATH: "/bin" }, "implement");
    expect(input.mcpServers.orbit?.args).toEqual(["/bin/steward", "mcp", "orbit", "--config", "/etc/steward/config.json", "--workspace", worktree.path]);
    expect(Object.keys(input.mcpServers.orbit?.env ?? {}).sort()).toEqual(["HOME", "PATH"]);
    expect(input.env).toEqual({ PATH: "/bin", ORBIT_DATA_DIR: "/data/orbit" });
  });

  it("passes the session to resume only when given", () => {
    expect(brainInput(fullDeps, paths, worktree, "prompt", {}, "fix", { resumeSessionId: "s0" }).resumeSessionId).toBe("s0");
    expect(brainInput(fullDeps, paths, worktree, "prompt", {}, "implement")).not.toHaveProperty("resumeSessionId");
  });
});

describe("sessionsDir", () => {
  it("lives under the data dir", () => {
    expect(sessionsDir(deps.config)).toBe("/data/sessions");
  });
});
