import type { V1Pod } from "@kubernetes/client-node";
import { beforeEach, describe, expect, it } from "vitest";
import type { AgentSession } from "../../src/chat/session.js";
import { kubernetesChat, type KubernetesChat, type PodsApi } from "../../src/k8s/chat.js";
import { containerState } from "../../src/k8s/cluster.js";
import type { KubernetesExecutor } from "../../src/k8s/executor.js";
import type { RunReport, RunSpec, WorkReport } from "../../src/run/protocol.js";
import type { ChatStart } from "../../src/server/admin.js";
import { podSpecFor } from "./helpers.js";

const SESSION: AgentSession = { sessionId: "session-1", worktreeName: "ticket-API-1", headSha: "a".repeat(40), branch: "fix/API-1", loopId: null, jobId: 7 };
const START: ChatStart = { runId: "chat-1", ticket: { id: "issue-1", identifier: "API-1" }, session: SESSION };

type Result = { report: RunReport; work: WorkReport };

/** An executor whose runs end when the test says so; cancel ends a run as interrupted, as deleting its Job does. */
class FakeExecutor {
  readonly specs: RunSpec[] = [];
  readonly cancelled: string[] = [];
  /** What `stopOrphans` was asked, and the run ids it reports stopped. */
  readonly orphanCalls: Array<{ prefix: string; kept: string[] }> = [];
  orphans: string[] = [];
  private readonly finishers = new Map<string, { resolve: (result: Result) => void; reject: (err: Error) => void }>();

  readonly api: Pick<KubernetesExecutor, "execute" | "cancel" | "stopOrphans"> = {
    execute: (spec) =>
      new Promise<Result>((resolve, reject) => {
        this.specs.push(spec);
        this.finishers.set(spec.runId, { resolve, reject });
      }),
    cancel: (runId) => {
      this.cancelled.push(runId);
      this.finish(runId, { ok: false, error: "the run pod ended without a report", interrupted: true }, "");
      return Promise.resolve();
    },
    stopOrphans: (prefix, keep) => {
      this.orphanCalls.push({ prefix, kept: ["chat-1", "chat-2", "chat-8"].filter(keep) });
      return Promise.resolve(this.orphans);
    },
  };

  finish(runId: string, patch: Partial<RunReport>, unpushed: string): void {
    const report: RunReport = { runId, ok: true, error: null, interrupted: false, stopped: false, setupFailed: false, sessionId: "session-1", output: undefined, usage: null, ...patch };
    this.finishers.get(runId)?.resolve({ report, work: { runId, unpushed, pushedSha: null } });
    this.finishers.delete(runId);
  }

  fail(runId: string, message: string): void {
    this.finishers.get(runId)?.reject(new Error(message));
    this.finishers.delete(runId);
  }
}

let executor: FakeExecutor;
let pods: V1Pod[];
let launcher: KubernetesChat;

const podsApi: PodsApi = {
  listNamespacedPod: ({ labelSelector }) => {
    const [key = "", value = ""] = (labelSelector ?? "").split("=");
    return Promise.resolve({ items: pods.filter((pod) => pod.metadata?.labels?.[key] === value) });
  },
};

const until = async (condition: () => boolean): Promise<void> => {
  for (let i = 0; i < 200 && !condition(); i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  if (!condition()) throw new Error("condition never held");
};

beforeEach(() => {
  executor = new FakeExecutor();
  pods = [];
  launcher = kubernetesChat({
    executor: executor.api,
    pods: podsApi,
    namespace: "ticket-steward",
    interactiveSpec: (start) => podSpecFor({ runId: start.runId, jobId: 0, kind: "chat", output: "chat", interactive: true, resumeSessionId: start.session.sessionId }),
    redact: (text) => text.replaceAll("sk-real", "[redacted]"),
    pollMs: 5,
    podTimeoutMs: 500,
    endGraceMs: 50,
  });
});

describe("kubernetesChat", () => {
  it("starts the interactive run and resolves with its pod once the Job controller created it", async () => {
    const started = launcher.start(START);
    await until(() => executor.specs.length === 1);
    expect(executor.specs[0]).toMatchObject({ runId: "chat-1", interactive: true, resumeSessionId: "session-1" });
    pods.push({ metadata: { name: "run-chat-1-xyz", labels: { "steward.run-id": "chat-1" } } });
    expect(await started).toEqual({ pod: "run-chat-1-xyz" });
  });

  it("rejects when the run ends before its pod exists", async () => {
    const started = launcher.start(START);
    await until(() => executor.specs.length === 1);
    executor.fail("chat-1", "the run pod could not be created: forbidden");
    await expect(started).rejects.toThrow("the run ended before its pod could be attached: the run pod could not be created: forbidden");
  });

  it("stops the run when its pod never appears", async () => {
    await expect(launcher.start(START)).rejects.toThrow("its pod did not appear in time");
    expect(executor.cancelled).toEqual(["chat-1"]);
  });

  it("ends with the run's report and what it left unpushed, redacted", async () => {
    pods.push({ metadata: { name: "run-chat-1-xyz", labels: { "steward.run-id": "chat-1" } } });
    await launcher.start(START);
    const ending = launcher.end("chat-1");
    executor.finish("chat-1", { ok: false, error: "claude exited with code 1 (sk-real)" }, "?? secrets.txt sk-real");
    expect(await ending).toEqual({ ok: false, error: "claude exited with code 1 ([redacted])", unpushed: "?? secrets.txt [redacted]" });
    expect(executor.cancelled).toEqual([]);
  });

  it("stops a run that has not ended after the grace period", async () => {
    pods.push({ metadata: { name: "run-chat-1-xyz", labels: { "steward.run-id": "chat-1" } } });
    await launcher.start(START);
    expect(await launcher.end("chat-1")).toEqual({ ok: false, error: "the run pod ended without a report", unpushed: "" });
    expect(executor.cancelled).toEqual(["chat-1"]);
  });

  it("stops a run it did not start (the steward restarted while the chat was open)", async () => {
    expect(await launcher.end("chat-9")).toEqual({ ok: null, error: null, unpushed: null });
    expect(executor.cancelled).toEqual(["chat-9"]);
  });

  it("reap ends its runs no lease holds, keeps the held ones, and has the executor stop the other chat runs", async () => {
    pods.push({ metadata: { name: "run-chat-1-xyz", labels: { "steward.run-id": "chat-1" } } });
    pods.push({ metadata: { name: "run-chat-2-xyz", labels: { "steward.run-id": "chat-2" } } });
    await launcher.start(START);
    await launcher.start({ ...START, runId: "chat-2" });
    executor.orphans = ["chat-8"];
    expect(await launcher.reap((runId) => runId === "chat-2")).toEqual(["chat-1", "chat-8"]);
    // Its own run had the grace period, then was stopped; the held one goes on.
    expect(executor.cancelled).toEqual(["chat-1"]);
    expect(executor.orphanCalls).toEqual([{ prefix: "chat-", kept: ["chat-2"] }]);
    // A later reap does not end it again; once its lease is gone the held run is ended too.
    executor.orphans = [];
    expect(await launcher.reap(() => false)).toEqual(["chat-2"]);
    expect(executor.cancelled).toEqual(["chat-1", "chat-2"]);
  });
});

describe("containerState", () => {
  const pod = (status: NonNullable<V1Pod["status"]>, deleting = false): V1Pod => ({ metadata: { name: "p", ...(deleting ? { deletionTimestamp: new Date() } : {}) }, status });

  it("waits until the agent container runs, and is ended once it exited or the pod went", () => {
    expect(containerState(pod({ phase: "Pending" }), "agent")).toBe("waiting");
    expect(containerState(pod({ phase: "Running", containerStatuses: [{ name: "agent", image: "a", imageID: "", ready: false, restartCount: 0, state: { waiting: {} } }] }), "agent")).toBe("waiting");
    expect(containerState(pod({ phase: "Running", containerStatuses: [{ name: "agent", image: "a", imageID: "", ready: true, restartCount: 0, state: { running: {} } }] }), "agent")).toBe("running");
    expect(containerState(pod({ phase: "Running", containerStatuses: [{ name: "agent", image: "a", imageID: "", ready: false, restartCount: 0, state: { terminated: { exitCode: 0 } } }] }), "agent")).toBe("ended");
    expect(containerState(pod({ phase: "Failed" }), "agent")).toBe("ended");
    expect(containerState(pod({ phase: "Running" }, true), "agent")).toBe("ended");
  });
});
