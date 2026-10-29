import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApiException, type V1ConfigMap, type V1Job } from "@kubernetes/client-node";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DETACHED_ERROR, kubernetesExecutor, NO_WORK_REPORT, POD_ENDED_WITHOUT_REPORT, type ConfigMapsApi, type JobsApi, type KubernetesExecutor } from "../../src/k8s/executor.js";
import { jobNameOf, SPEC_KEY, specConfigMapOf } from "../../src/k8s/runJob.js";
import type { RunReport, RunSpec, WorkReport } from "../../src/run/protocol.js";
import { openStores, type Stores } from "../../src/store/index.js";
import type { TriggerEvent } from "../../src/tracker/types.js";
import { podSpecFor, RUNTIME } from "./helpers.js";

const notFound = (): ApiException<string> => new ApiException(404, "not found", "", {});

/** The namespace's Jobs and ConfigMaps, in memory. */
class FakeCluster {
  readonly jobs = new Map<string, V1Job>();
  readonly configMaps = new Map<string, V1ConfigMap>();
  readonly createdJobs: string[] = [];
  readonly deletedJobs: Array<{ name: string; propagationPolicy: string | undefined }> = [];

  readonly batch: JobsApi = {
    createNamespacedJob: ({ body }) => {
      const name = body.metadata?.name ?? "";
      if (this.jobs.has(name)) return Promise.reject(new ApiException(409, "exists", "", {}));
      this.jobs.set(name, body);
      this.createdJobs.push(name);
      return Promise.resolve(body);
    },
    readNamespacedJob: ({ name }) => {
      const job = this.jobs.get(name);
      return job === undefined ? Promise.reject(notFound()) : Promise.resolve(job);
    },
    deleteNamespacedJob: ({ name, propagationPolicy }) => {
      if (!this.jobs.delete(name)) return Promise.reject(notFound());
      this.deletedJobs.push({ name, propagationPolicy });
      return Promise.resolve({});
    },
    listNamespacedJob: ({ labelSelector }) => {
      // `key=value`, or a bare `key`: every Job that carries the label.
      const [key = "", value] = (labelSelector ?? "").split("=");
      const labelled = (job: V1Job): boolean => (value === undefined ? job.metadata?.labels?.[key] !== undefined : job.metadata?.labels?.[key] === value);
      return Promise.resolve({ items: [...this.jobs.values()].filter(labelled) });
    },
  };

  readonly core: ConfigMapsApi = {
    createNamespacedConfigMap: ({ body }) => {
      const name = body.metadata?.name ?? "";
      if (this.configMaps.has(name)) return Promise.reject(new ApiException(409, "exists", "", {}));
      this.configMaps.set(name, body);
      return Promise.resolve(body);
    },
    readNamespacedConfigMap: ({ name }) => {
      const configMap = this.configMaps.get(name);
      return configMap === undefined ? Promise.reject(notFound()) : Promise.resolve(configMap);
    },
    deleteNamespacedConfigMap: ({ name }) => (this.configMaps.delete(name) ? Promise.resolve({}) : Promise.reject(notFound())),
  };

  /** The Job ends as the pod's agent container would leave it. */
  end(runId: string, type: "Complete" | "Failed"): void {
    const job = this.jobs.get(jobNameOf(runId));
    if (job === undefined) throw new Error(`no Job for ${runId}`);
    job.status = { conditions: [{ type, status: "True" }] };
  }

  /** A live run pod left by a steward that has since restarted. */
  leave(spec: RunSpec): void {
    this.configMaps.set(specConfigMapOf(spec.runId), { metadata: { name: specConfigMapOf(spec.runId) }, data: { [SPEC_KEY]: JSON.stringify(spec) } });
    this.jobs.set(jobNameOf(spec.runId), { metadata: { name: jobNameOf(spec.runId), labels: { "steward.run-id": spec.runId } }, status: { active: 1 } });
  }

  envOf(runId: string, container: string, name: string): string {
    const pod = this.jobs.get(jobNameOf(runId))?.spec?.template.spec;
    const all = [...(pod?.initContainers ?? []), ...(pod?.containers ?? [])];
    const value = all.find((candidate) => candidate.name === container)?.env?.find((variable) => variable.name === name)?.value;
    if (value === undefined) throw new Error(`no ${name} on ${container}`);
    return value;
  }
}

const trigger = (identifier: string): TriggerEvent => ({ kind: "cli", issueId: `issue-${identifier}`, identifier, teamKey: "API" });

let dataDir: string;
let stores: Stores;
let cluster: FakeCluster;
let executor: KubernetesExecutor;

const reportFor = (runId: string, patch: Partial<RunReport> = {}): RunReport => ({
  runId, ok: true, error: null, interrupted: false, setupFailed: false, sessionId: "session-1", output: { outcome: "done" }, usage: null, ...patch,
});
const workFor = (runId: string): WorkReport => ({ runId, unpushed: "", pushedSha: null });

/** A job claimed by the worker, as `execute` sees it: running, attempt 1. */
const runningJob = (identifier: string): { jobId: number; spec: RunSpec } => {
  const jobId = stores.jobs.enqueue(trigger(identifier));
  stores.jobs.claimById(jobId);
  stores.attempts.start(jobId);
  return { jobId, spec: podSpecFor({ runId: `${jobId}-1`, jobId, identifier, issueId: `issue-${identifier}`, push: null }) };
};

const settles = async <T>(promise: Promise<T>): Promise<T> => {
  const result = await Promise.race([promise, new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 2_000))]);
  if (result === "pending") throw new Error("the promise did not settle");
  return result;
};

const until = async (condition: () => boolean): Promise<void> => {
  for (let i = 0; i < 200 && !condition(); i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  if (!condition()) throw new Error("condition never held");
};

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "steward-k8s-"));
  stores = openStores(dataDir);
  cluster = new FakeCluster();
  executor = kubernetesExecutor({ runtime: RUNTIME, batch: cluster.batch, core: cluster.core, stores, pollMs: 10, ticketIdleMs: 50 });
});

afterEach(async () => {
  executor.close();
  stores.db.close();
  await rm(dataDir, { recursive: true, force: true });
});

describe("kubernetesExecutor", () => {
  it("creates the spec ConfigMap, the run's tokens and the Job, and resolves once the report and the work report arrived", async () => {
    const { jobId, spec } = runningJob("API-1");
    const executed = executor.execute(spec);
    await until(() => cluster.createdJobs.length === 1);

    expect(JSON.parse(cluster.configMaps.get(specConfigMapOf(spec.runId))?.data?.[SPEC_KEY] ?? "null")).toEqual(spec);
    expect(stores.jobs.get(jobId)?.runId).toBe(spec.runId);
    const runner = cluster.envOf(spec.runId, "agent", "STEWARD_RUNNER_TOKEN");
    const tools = cluster.envOf(spec.runId, "tools", "STEWARD_TOOLS_TOKEN");
    expect(stores.runTokens.verify(spec.runId, "runner", runner)).toBe(true);
    expect(stores.runTokens.verify(spec.runId, "tools", tools)).toBe(true);
    expect(stores.runTokens.verify(spec.runId, "tools", runner)).toBe(false);
    expect(executor.spec(spec.runId)).toEqual(spec);

    expect(executor.deliverWork(workFor(spec.runId))).toBe(true);
    expect(executor.deliverReport(reportFor(spec.runId))).toBe(true);
    const { report, work } = await settles(executed);
    expect(report).toEqual(reportFor(spec.runId));
    expect(work).toEqual(workFor(spec.runId));

    // The tokens die with the run, and its spec goes; the Job stays for its TTL so the session sidecar finishes.
    expect(stores.runTokens.verify(spec.runId, "runner", runner)).toBe(false);
    expect(stores.runTokens.verify(spec.runId, "tools", tools)).toBe(false);
    expect(cluster.configMaps.has(specConfigMapOf(spec.runId))).toBe(false);
    expect(cluster.jobs.has(jobNameOf(spec.runId))).toBe(true);
    expect(executor.deliverReport(reportFor(spec.runId))).toBe(false);
  });

  it("resolves as interrupted when the Job fails without a report", async () => {
    const { spec } = runningJob("API-1");
    const executed = executor.execute(spec);
    await until(() => cluster.createdJobs.length === 1);
    cluster.end(spec.runId, "Failed");
    const { report, work } = await settles(executed);
    expect(report).toMatchObject({ ok: false, error: POD_ENDED_WITHOUT_REPORT, interrupted: true });
    expect(work).toEqual({ runId: spec.runId, unpushed: NO_WORK_REPORT, pushedSha: null });
  });

  it("resolves as interrupted when the Job disappears, as cancel leaves it", async () => {
    const { spec } = runningJob("API-1");
    const executed = executor.execute(spec);
    await until(() => cluster.createdJobs.length === 1);
    await executor.cancel(spec.runId);
    expect(cluster.deletedJobs).toEqual([{ name: jobNameOf(spec.runId), propagationPolicy: "Foreground" }]);
    expect((await settles(executed)).report).toMatchObject({ interrupted: true, error: POD_ENDED_WITHOUT_REPORT });
  });

  it("cancelling a run nobody waits on (started before a restart) also revokes its tokens and deletes its spec", async () => {
    const spec = podSpecFor({ runId: "chat-3", jobId: 0, kind: "chat", interactive: true, push: null });
    cluster.leave(spec);
    const runner = stores.runTokens.issue(spec.runId, "runner");
    await executor.cancel(spec.runId);
    expect(cluster.jobs.has(jobNameOf(spec.runId))).toBe(false);
    expect(cluster.configMaps.has(specConfigMapOf(spec.runId))).toBe(false);
    expect(stores.runTokens.verify(spec.runId, "runner", runner)).toBe(false);
  });

  it("keeps the report of a pod that ended before its work report arrived, and reads the work as unchecked", async () => {
    const { spec } = runningJob("API-1");
    const executed = executor.execute(spec);
    await until(() => cluster.createdJobs.length === 1);
    executor.deliverReport(reportFor(spec.runId));
    cluster.end(spec.runId, "Complete");
    const { report, work } = await settles(executed);
    expect(report.ok).toBe(true);
    expect(work.unpushed).toBe(NO_WORK_REPORT);
  });

  it("detaches on abort, leaving the pod, its spec and its tokens for the next start", async () => {
    const { spec } = runningJob("API-1");
    const controller = new AbortController();
    const executed = executor.execute(spec, controller.signal);
    await until(() => cluster.createdJobs.length === 1);
    controller.abort();
    await expect(settles(executed)).rejects.toThrow(DETACHED_ERROR);
    expect(cluster.jobs.has(jobNameOf(spec.runId))).toBe(true);
    expect(cluster.configMaps.has(specConfigMapOf(spec.runId))).toBe(true);
    expect(stores.runTokens.verify(spec.runId, "runner", cluster.envOf(spec.runId, "agent", "STEWARD_RUNNER_TOKEN"))).toBe(true);
  });

  it("removes the run's tokens and spec when the Job cannot be created", async () => {
    const { spec } = runningJob("API-1");
    cluster.jobs.set(jobNameOf(spec.runId), { metadata: { name: jobNameOf(spec.runId) } });
    await expect(executor.execute(spec)).rejects.toThrow(/the run pod could not be created/);
    expect(cluster.configMaps.has(specConfigMapOf(spec.runId))).toBe(false);
    expect(executor.spec(spec.runId)).toBeNull();
  });

  it("waits for the ticket's earlier run pod to end before starting the next", async () => {
    const earlier = podSpecFor({ runId: "99-1", identifier: "API-1" });
    cluster.jobs.set(jobNameOf(earlier.runId), { metadata: { name: jobNameOf(earlier.runId), labels: { "steward.run-id": earlier.runId, "steward.ticket": "API-1" } }, status: { active: 1 } });
    const { spec } = runningJob("API-1");
    const executed = executor.execute(spec);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(cluster.createdJobs).toEqual([]);
    cluster.end(earlier.runId, "Complete");
    await until(() => cluster.createdJobs.length === 1);
    executor.deliverWork(workFor(spec.runId));
    executor.deliverReport(reportFor(spec.runId));
    await settles(executed);
  });

  it("reattach after a restart waits on the live run pod without a new Job and requeues the job whose pod is gone", async () => {
    const live = runningJob("API-1");
    const gone = runningJob("API-2");
    stores.jobs.recordRun(live.jobId, live.spec.runId);
    stores.jobs.recordRun(gone.jobId, gone.spec.runId);
    cluster.leave(live.spec);
    const runner = stores.runTokens.issue(live.spec.runId, "runner");
    const goneToken = stores.runTokens.issue(gone.spec.runId, "tools");
    cluster.configMaps.set(specConfigMapOf(gone.spec.runId), { metadata: { name: specConfigMapOf(gone.spec.runId) }, data: { [SPEC_KEY]: JSON.stringify(gone.spec) } });

    await executor.reattach();

    expect(stores.jobs.get(gone.jobId)?.status).toBe("queued");
    expect(stores.runTokens.verify(gone.spec.runId, "tools", goneToken)).toBe(false);
    expect(cluster.configMaps.has(specConfigMapOf(gone.spec.runId))).toBe(false);
    expect(stores.jobs.get(live.jobId)?.status).toBe("running");
    expect(executor.adopted()).toEqual([live.spec]);
    // The adopted run's tokens still hold: its pod posts with them.
    expect(stores.runTokens.verify(live.spec.runId, "runner", runner)).toBe(true);
    // A report that arrives before the worker picks the job up again is kept for it.
    expect(executor.deliverReport(reportFor(live.spec.runId))).toBe(true);

    const executed = executor.execute(live.spec);
    executor.deliverWork(workFor(live.spec.runId));
    const { report } = await settles(executed);
    expect(report).toEqual(reportFor(live.spec.runId));
    expect(cluster.createdJobs).toEqual([]);
    expect(executor.adopted()).toEqual([]);
    expect(stores.runTokens.verify(live.spec.runId, "runner", runner)).toBe(false);
  });

  it("release stops an adopted run that no execute took", async () => {
    const live = runningJob("API-1");
    stores.jobs.recordRun(live.jobId, live.spec.runId);
    cluster.leave(live.spec);
    await executor.reattach();
    await executor.release(live.spec.runId);
    expect(cluster.jobs.has(jobNameOf(live.spec.runId))).toBe(false);
    expect(executor.adopted()).toEqual([]);
    expect(executor.spec(live.spec.runId)).toBeNull();
  });

  it("reattach requeues a running job with no run recorded and stops a live pod whose spec is gone", async () => {
    const unstarted = runningJob("API-1");
    const orphan = runningJob("API-2");
    stores.jobs.recordRun(orphan.jobId, orphan.spec.runId);
    cluster.leave(orphan.spec);
    cluster.configMaps.delete(specConfigMapOf(orphan.spec.runId));
    await executor.reattach();
    expect(stores.jobs.get(unstarted.jobId)?.status).toBe("queued");
    expect(stores.jobs.get(orphan.jobId)?.status).toBe("queued");
    expect(cluster.jobs.has(jobNameOf(orphan.spec.runId))).toBe(false);
    expect(executor.adopted()).toEqual([]);
  });

  it("reattach adopts only the run of the job's open attempt, not an earlier attempt's pod still finishing", async () => {
    const { jobId, spec: earlier } = runningJob("API-1");
    stores.jobs.recordRun(jobId, earlier.runId);
    cluster.leave(earlier);
    // The steward moved on to attempt 2, then stopped before its pod was recorded.
    const [first] = stores.attempts.forJob(jobId);
    if (first !== undefined) stores.attempts.finish(first.id, { error: "the run failed" });
    stores.attempts.start(jobId);
    await executor.reattach();
    expect(executor.adopted()).toEqual([]);
    expect(stores.jobs.get(jobId)?.status).toBe("queued");
    // That pod is left to finish its session upload.
    expect(cluster.jobs.has(jobNameOf(earlier.runId))).toBe(true);
  });

  it("stopOrphans after a restart stops the chat runs no lease holds and revokes their tokens, leaving the rest", async () => {
    const chat = (runId: string): RunSpec => podSpecFor({ runId, jobId: 0, kind: "chat", interactive: true, push: null });
    // The restart cut these chats off: their pods run on, and their tokens are still valid.
    const orphan = chat("chat-1");
    const held = chat("chat-2");
    const ended = chat("chat-3");
    for (const spec of [orphan, held, ended]) cluster.leave(spec);
    cluster.end(ended.runId, "Complete");
    const tokens = Object.fromEntries(["chat-1", "chat-2", "chat-3", "chat-4"].map((runId) => [runId, stores.runTokens.issue(runId, "tools")]));
    const job = runningJob("API-1");
    stores.jobs.recordRun(job.jobId, job.spec.runId);
    cluster.leave(job.spec);
    const jobToken = stores.runTokens.issue(job.spec.runId, "runner");

    expect((await executor.stopOrphans("chat-", (runId) => runId === held.runId)).sort()).toEqual(["chat-1", "chat-3", "chat-4"]);

    expect(cluster.deletedJobs).toEqual([{ name: jobNameOf(orphan.runId), propagationPolicy: "Foreground" }]);
    expect(cluster.configMaps.has(specConfigMapOf(orphan.runId))).toBe(false);
    for (const runId of ["chat-1", "chat-3", "chat-4"]) expect(stores.runTokens.verify(runId, "tools", tokens[runId] ?? "")).toBe(false);
    // An ended Job is left to its TTL: its session sidecar may still be uploading.
    expect(cluster.jobs.has(jobNameOf(ended.runId))).toBe(true);
    // The held chat and the job's run are untouched.
    expect(cluster.jobs.has(jobNameOf(held.runId))).toBe(true);
    expect(stores.runTokens.verify(held.runId, "tools", tokens["chat-2"] ?? "")).toBe(true);
    expect(cluster.jobs.has(jobNameOf(job.spec.runId))).toBe(true);
    expect(stores.runTokens.verify(job.spec.runId, "runner", jobToken)).toBe(true);
    // Nothing is left to stop.
    expect(await executor.stopOrphans("chat-", (runId) => runId === held.runId)).toEqual([]);
  });

  it("stopOrphans skips a chat run this process still waits on", async () => {
    const spec = podSpecFor({ runId: "chat-5", jobId: 0, kind: "chat", interactive: true, push: null, identifier: "API-5" });
    const executed = executor.execute(spec);
    await until(() => cluster.createdJobs.length === 1);
    expect(await executor.stopOrphans("chat-", () => false)).toEqual([]);
    expect(cluster.jobs.has(jobNameOf(spec.runId))).toBe(true);
    await executor.cancel(spec.runId);
    expect((await settles(executed)).report).toMatchObject({ interrupted: true });
  });
});
