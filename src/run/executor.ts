import type { RunReport, RunSpec, WorkReport } from "./protocol.js";

/**
 * Executes a prepared run: builds its workspace, runs setup and the brain, and says what the agent left unpushed. The
 * local executor does it in-process; the Kubernetes one in a run pod. Rejects only when the run could not be started.
 */
export interface RunExecutor {
  execute(spec: RunSpec, signal?: AbortSignal): Promise<{ report: RunReport; work: WorkReport }>;
}
