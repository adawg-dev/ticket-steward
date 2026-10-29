import type { RunSpec } from "../run/protocol.js";
import type { TriggerEvent } from "../tracker/types.js";

export type TriggerKind = TriggerEvent["kind"];

export interface RunContext {
  jobId: number;
  attempt: number;
  issueId: string;
  identifier: string;
  teamKey: string;
  trigger: TriggerEvent;
  dryRun: boolean;
  /**
   * The spec of this attempt's run pod, still running after the steward restarted (Kubernetes runtime): prepare returns
   * it instead of building a new one, its checks for an earlier attempt's push are skipped (the push is this run's), and
   * the executor waits on that pod instead of starting another.
   */
  resume?: RunSpec;
}

export type JobOutcome =
  | { status: "succeeded"; warning?: string }
  | { status: "failed"; error: string; retryable: boolean }
  | { status: "publish_failed"; error: string }
  /** Not done yet and not a failure: the job goes back to the queue until `until`, with its attempt given back. */
  | { status: "deferred"; until: Date };
