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
}

export type JobOutcome =
  | { status: "succeeded"; warning?: string }
  | { status: "failed"; error: string; retryable: boolean }
  | { status: "publish_failed"; error: string };
