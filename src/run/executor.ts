import type { RunReport, RunSpec, WorkReport } from "./protocol.js";

/** What the caller follows of a run while it executes. */
export interface RunHooks {
  /** Each of the brain's message lines, redacted, as they come. */
  onLine?: (line: string) => void;
}

/**
 * Executes a prepared run: builds its workspace, runs setup and the brain, and says what the agent left unpushed. The
 * local executor does it in-process; the Kubernetes one in a run pod. Either opens the run's channel (`RunChannels`) for
 * as long as it executes: brain lines go to `hooks.onLine`, and steering reaches the brain. Rejects only when the run
 * could not be started.
 */
export interface RunExecutor {
  execute(spec: RunSpec, signal?: AbortSignal, hooks?: RunHooks): Promise<{ report: RunReport; work: WorkReport }>;
}
