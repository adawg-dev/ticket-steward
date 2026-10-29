import type { ActivityContent, LinearAgentApi, PlanStep } from "../../src/tracker/linear/agent.js";

export type LinearCall =
  | { kind: "activity"; sessionId: string; content: ActivityContent; ephemeral: boolean }
  | { kind: "plan"; sessionId: string; plan: PlanStep[] }
  | { kind: "urls"; sessionId: string; urls: Array<{ label: string; url: string }> }
  | { kind: "delegate"; issueId: string; appUserId: string | null }
  | { kind: "state"; issueId: string; which: { type: "started" } | { name: string } };

/** Linear's agent API in memory: every call recorded in order; `moveToState` answers `stateAnswer`. */
export class RecordingLinear implements LinearAgentApi {
  readonly calls: LinearCall[] = [];
  stateAnswer: "moved" | "already" | "missing" = "moved";

  createActivity(sessionId: string, content: ActivityContent, opts: { ephemeral?: boolean } = {}): Promise<void> {
    this.calls.push({ kind: "activity", sessionId, content, ephemeral: opts.ephemeral ?? false });
    return Promise.resolve();
  }

  setExternalUrls(sessionId: string, urls: Array<{ label: string; url: string }>): Promise<void> {
    this.calls.push({ kind: "urls", sessionId, urls });
    return Promise.resolve();
  }

  setPlan(sessionId: string, plan: PlanStep[]): Promise<void> {
    this.calls.push({ kind: "plan", sessionId, plan });
    return Promise.resolve();
  }

  setDelegate(issueId: string, appUserId: string | null): Promise<void> {
    this.calls.push({ kind: "delegate", issueId, appUserId });
    return Promise.resolve();
  }

  moveToState(issueId: string, which: { type: "started" } | { name: string }): Promise<"moved" | "already" | "missing"> {
    this.calls.push({ kind: "state", issueId, which });
    return Promise.resolve(this.stateAnswer);
  }

  issueState(): Promise<{ type: string; name: string }> {
    return Promise.resolve({ type: "started", name: "In Progress" });
  }

  /** The activities posted, in order. */
  activities(): Array<{ sessionId: string; content: ActivityContent; ephemeral: boolean }> {
    return this.calls.flatMap((call) => (call.kind === "activity" ? [call] : []));
  }
}
