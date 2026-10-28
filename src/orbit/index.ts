import { logger } from "../log.js";
import { execOrbit, orbitEnv, type OrbitExec } from "./run.js";

export const ORBIT_INDEX_TIMEOUT_MS = 120_000;
const DETAIL_CHARS = 500;

/**
 * Indexes a worktree into the steward's local Orbit graph before a brain run, so the agent's `orbit grep` and `orbit
 * context` answer at once. Best effort: a missing binary, a failure or a timeout logs a warning and the run goes on.
 */
export const indexWorktree = async (worktreePath: string, dataDir: string, exec: OrbitExec = execOrbit): Promise<boolean> => {
  try {
    const run = await exec(["workspace", "index", "."], { cwd: worktreePath, env: orbitEnv(dataDir), timeoutMs: ORBIT_INDEX_TIMEOUT_MS });
    if (run.exitCode === 0 && !run.timedOut) return true;
    const detail = run.timedOut ? `timed out after ${ORBIT_INDEX_TIMEOUT_MS / 1000} s` : (run.stderr.trim() || `exited ${run.exitCode ?? "without a code"}`).slice(0, DETAIL_CHARS);
    logger.warn({ worktree: worktreePath, detail }, "orbit index failed; the agent's orbit commands index on their own");
  } catch (err) {
    logger.warn({ worktree: worktreePath, err: err instanceof Error ? err.message : String(err) }, "orbit index failed; the agent's orbit commands index on their own");
  }
  return false;
};
