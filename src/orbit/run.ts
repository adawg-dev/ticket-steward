import { homedir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";

/** The Orbit CLI on PATH; the image installs a pinned native build (docs/ops.md). */
export const ORBIT_BIN = "orbit";

/** Where Orbit keeps its local graph and settings for steward runs: under the data dir, so the index outlives a run. */
export const orbitDataDir = (dataDir: string): string => join(dataDir, "orbit");

export interface OrbitRun {
  /** Null when the process never started or was killed. */
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export type OrbitExec = (args: string[], opts: { cwd: string; env: Record<string, string>; timeoutMs: number }) => Promise<OrbitRun>;

/** Orbit's output beyond this is cut before it is kept; the tools truncate further. */
const MAX_BUFFER_BYTES = 8 * 1024 * 1024;

/** Runs the Orbit CLI with exactly `env`; never throws, a spawn failure comes back as stderr with no exit code. */
export const execOrbit: OrbitExec = async (args, opts) => {
  const result = await execa(ORBIT_BIN, args, {
    cwd: opts.cwd,
    env: opts.env,
    extendEnv: false,
    reject: false,
    stdin: "ignore",
    timeout: opts.timeoutMs,
    maxBuffer: MAX_BUFFER_BYTES,
  });
  // Output past maxBuffer is cut, not lost: what came first is still the answer.
  if (result.isMaxBuffer) return { exitCode: 0, stdout: result.stdout, stderr: "", timedOut: false };
  const stderr = result.exitCode === undefined && !result.timedOut ? (result.originalMessage ?? "orbit did not start") : result.stderr;
  return { exitCode: result.exitCode ?? null, stdout: result.stdout, stderr, timedOut: result.timedOut };
};

/** The env every Orbit process gets: no credentials, its data dir under the steward's. */
export const orbitEnv = (dataDir: string): Record<string, string> => ({
  PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
  HOME: process.env.HOME ?? homedir(),
  ORBIT_DATA_DIR: orbitDataDir(dataDir),
});
