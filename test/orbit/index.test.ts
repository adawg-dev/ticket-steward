import { indexWorktree, ORBIT_INDEX_TIMEOUT_MS } from "../../src/orbit/index.js";
import type { OrbitExec } from "../../src/orbit/run.js";
import { logger } from "../../src/log.js";

describe("indexWorktree", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("indexes the worktree into the data dir's graph, with no credential in the env", async () => {
    const calls: Array<{ args: string[]; cwd: string; env: Record<string, string>; timeoutMs: number }> = [];
    const exec: OrbitExec = async (args, opts) => {
      calls.push({ args, ...opts });
      return { exitCode: 0, stdout: "{}", stderr: "", timedOut: false };
    };

    expect(await indexWorktree("/data/work/42-1", "/data", exec)).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ args: ["workspace", "index", "."], cwd: "/data/work/42-1", timeoutMs: ORBIT_INDEX_TIMEOUT_MS });
    expect(Object.keys(calls[0]?.env ?? {}).sort()).toEqual(["HOME", "ORBIT_DATA_DIR", "PATH"]);
    expect(calls[0]?.env.ORBIT_DATA_DIR).toBe("/data/orbit");
  });

  it("warns and goes on when the index fails, times out or Orbit is missing", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    const failing: OrbitExec = async () => ({ exitCode: 1, stdout: "", stderr: "duckdb crashed", timedOut: false });
    const slow: OrbitExec = async () => ({ exitCode: null, stdout: "", stderr: "", timedOut: true });
    const missing: OrbitExec = async () => {
      throw new Error("spawn orbit ENOENT");
    };

    expect(await indexWorktree("/w", "/data", failing)).toBe(false);
    expect(await indexWorktree("/w", "/data", slow)).toBe(false);
    expect(await indexWorktree("/w", "/data", missing)).toBe(false);
    expect(warn).toHaveBeenCalledTimes(3);
    expect(warn.mock.calls[0]?.[0]).toEqual({ worktree: "/w", detail: "duckdb crashed" });
    expect(warn.mock.calls[1]?.[0]).toEqual({ worktree: "/w", detail: "timed out after 120 s" });
  });

  it("is non-fatal with the real Orbit runner when no orbit binary is on PATH", async () => {
    vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    vi.stubEnv("PATH", "/nonexistent");
    try {
      expect(await indexWorktree(process.cwd(), "/nonexistent-data")).toBe(false);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
