import { ApiException, type BatchV1Api, type CoreV1Api, type V1Job } from "@kubernetes/client-node";
import type { KubernetesRuntime } from "../config/schema.js";
import { logger } from "../log.js";
import type { RunExecutor } from "../run/executor.js";
import { RunSpecSchema, type RunReport, type RunSpec, type WorkReport } from "../run/protocol.js";
import type { Stores } from "../store/index.js";
import { buildRunJob, jobNameOf, RUN_LABELS, runLabels, SPEC_KEY, specConfigMapOf } from "./runJob.js";

/** The parts of the Kubernetes API the executor uses; tests stand in for them. */
export type JobsApi = Pick<BatchV1Api, "createNamespacedJob" | "readNamespacedJob" | "deleteNamespacedJob" | "listNamespacedJob">;
export type ConfigMapsApi = Pick<CoreV1Api, "createNamespacedConfigMap" | "readNamespacedConfigMap" | "deleteNamespacedConfigMap">;

/** Watches the namespace's Jobs matching `labelSelector`; `onDone` when the watch ends (it is then started again). */
export type JobWatch = (labelSelector: string, onJob: (phase: string, job: V1Job) => void, onDone: (err: unknown) => void) => Promise<{ abort: () => void }>;

/** What the internal run API hands the executor, and what it asks of it. */
export interface RunCallbacks {
  /** The spec of a run the steward is waiting on, or null. */
  spec(runId: string): RunSpec | null;
  /** False when no run of that id is being waited on. */
  deliverReport(report: RunReport): boolean;
  deliverWork(work: WorkReport): boolean;
}

export interface KubernetesExecutor extends RunExecutor, RunCallbacks {
  /**
   * Deletes the run's Job (foreground: its pod goes first); the waiting `execute` resolves as interrupted. A run nobody
   * waits on (one started before a restart) also loses its tokens and spec here.
   */
  cancel(runId: string): Promise<void>;
  /**
   * After a restart, before the worker starts: running jobs whose run pod is still live are adopted, to be waited on by
   * the next `execute` of the same run; the others are requeued and their run's objects removed.
   */
  reattach(): Promise<void>;
  /**
   * Stops the runs whose id starts with `prefix` that nothing here waits on and `keep` does not hold: a live Job is
   * deleted, and the run's tokens and spec go. An ended Job is left to its TTL (its session sidecar may still be
   * uploading); a run with neither a live Job nor tokens is skipped. Returns the run ids it stopped.
   */
  stopOrphans(prefix: string, keep: (runId: string) => boolean): Promise<string[]>;
  /** The specs of adopted runs no `execute` has taken yet. */
  adopted(): RunSpec[];
  /** Stops an adopted run nobody will wait on (its job ended another way): its Job, tokens and spec are removed. */
  release(runId: string): Promise<void>;
  /** Stops watching. */
  close(): void;
}

export const POD_ENDED_WITHOUT_REPORT = "the run pod ended without a report";
export const NO_WORK_REPORT = "the tools sidecar sent no work report";
/** The steward stopped while the run pod kept going: the job stays running and the next start reattaches to it. */
export const DETACHED_ERROR = "the steward stopped; the run pod keeps running and is reattached at the next start";

const DEFAULT_POLL_MS = 30_000;
const DEFAULT_TICKET_IDLE_MS = 5 * 60_000;
const DEFAULT_MAX_ATTEMPTS = 3;
const ALL_ROWS = 1_000_000;

type Ended = "succeeded" | "failed" | "gone";

interface LiveRun {
  spec: RunSpec;
  report: RunReport | null;
  work: WorkReport | null;
  ended: Ended | null;
  /** Adopted by `reattach` and not yet taken by an `execute`. */
  adopted: boolean;
  /** Wakes the waiting `execute`. */
  check: () => void;
}

const isNotFound = (err: unknown): boolean => err instanceof ApiException && err.code === 404;
const isConflict = (err: unknown): boolean => err instanceof ApiException && err.code === 409;
const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** How a Job ended, or null while it runs. A Job being deleted counts as ended: its pod is going. */
export const jobEnded = (job: V1Job): Ended | null => {
  const conditions = job.status?.conditions ?? [];
  const holds = (type: string): boolean => conditions.some((condition) => condition.type === type && condition.status === "True");
  if (job.metadata?.deletionTimestamp !== undefined) return "gone";
  if (holds("Failed") || (job.status?.failed ?? 0) > 0) return "failed";
  if (holds("Complete") || (job.status?.succeeded ?? 0) > 0) return "succeeded";
  return null;
};

const interruptedReport = (runId: string): RunReport => ({
  runId, ok: false, error: POD_ENDED_WITHOUT_REPORT, interrupted: true, setupFailed: false, sessionId: null, output: null, usage: null,
});

/**
 * Runs each spec as a Kubernetes Job (`buildRunJob`) and waits for the run pod's report and the tools sidecar's work
 * report, both posted to the internal run API with the run's own tokens. A Job that fails or disappears without a
 * report resolves as interrupted. The tokens are revoked and the spec's ConfigMap deleted when the run ends; the Job is
 * left to its TTL, so the session sidecar finishes its last upload.
 */
export const kubernetesExecutor = (p: {
  runtime: KubernetesRuntime;
  batch: JobsApi;
  core: ConfigMapsApi;
  watch?: JobWatch;
  stores: Pick<Stores, "jobs" | "attempts" | "runTokens">;
  pollMs?: number;
  /** How long a run waits for the ticket's earlier run pods (still uploading their session) to end. */
  ticketIdleMs?: number;
  maxAttempts?: number;
  /** `implement.checksTimeoutMinutes`, for the run pods' grace period. */
  checksTimeoutMinutes: number;
}): KubernetesExecutor => {
  const { namespace } = p.runtime;
  const pollMs = p.pollMs ?? DEFAULT_POLL_MS;
  const runs = new Map<string, LiveRun>();
  let watching: { abort: () => void } | null = null;
  let watchTimer: NodeJS.Timeout | null = null;
  let closed = false;

  const readJob = async (runId: string): Promise<V1Job | null> => {
    try {
      return await p.batch.readNamespacedJob({ name: jobNameOf(runId), namespace });
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  };

  const deleteJob = async (runId: string): Promise<void> => {
    try {
      await p.batch.deleteNamespacedJob({ name: jobNameOf(runId), namespace, propagationPolicy: "Foreground" });
    } catch (err) {
      if (!isNotFound(err)) throw err;
    }
  };

  const deleteSpec = async (runId: string): Promise<void> => {
    try {
      await p.core.deleteNamespacedConfigMap({ name: specConfigMapOf(runId), namespace });
    } catch (err) {
      if (!isNotFound(err)) logger.warn({ runId, err: message(err) }, "the run's spec ConfigMap could not be deleted");
    }
  };

  const readSpec = async (runId: string): Promise<RunSpec | null> => {
    try {
      const configMap = await p.core.readNamespacedConfigMap({ name: specConfigMapOf(runId), namespace });
      const parsed = RunSpecSchema.safeParse(JSON.parse(configMap.data?.[SPEC_KEY] ?? "null"));
      return parsed.success ? parsed.data : null;
    } catch (err) {
      if (isNotFound(err) || err instanceof SyntaxError) return null;
      throw err;
    }
  };

  /** The run's tokens stop working and its spec goes; the Job stays for its TTL. */
  const endRun = async (runId: string): Promise<void> => {
    runs.delete(runId);
    p.stores.runTokens.revoke(runId);
    await deleteSpec(runId);
  };

  const noteJob = (phase: string, job: V1Job): void => {
    const runId = job.metadata?.labels?.[RUN_LABELS.runId];
    const run = runId === undefined ? undefined : runs.get(runId);
    if (run === undefined) return;
    const ended = phase === "DELETED" ? "gone" : jobEnded(job);
    if (ended !== null) {
      run.ended = ended;
      run.check();
    }
  };

  /** One watch over every run Job; polling every `pollMs` covers its gaps. */
  const ensureWatch = (): void => {
    if (p.watch === undefined || watching !== null || watchTimer !== null || closed) return;
    const restart = (): void => {
      watching = null;
      if (closed) return;
      watchTimer = setTimeout(() => {
        watchTimer = null;
        ensureWatch();
      }, pollMs).unref();
    };
    p.watch(RUN_LABELS.runId, noteJob, (err) => {
      if (err !== null && err !== undefined) logger.warn({ err: message(err) }, "the run Job watch ended");
      restart();
    }).then(
      (handle) => {
        watching = handle;
        if (closed) handle.abort();
      },
      (err: unknown) => {
        logger.warn({ err: message(err) }, "the run Job watch could not start");
        restart();
      },
    );
  };

  /** Run pods of this ticket that have not ended: an earlier run's session sync may still be uploading. */
  const waitTicketIdle = async (spec: RunSpec): Promise<void> => {
    const deadline = Date.now() + (p.ticketIdleMs ?? DEFAULT_TICKET_IDLE_MS);
    for (;;) {
      const list = await p.batch.listNamespacedJob({ namespace, labelSelector: `${RUN_LABELS.ticket}=${spec.identifier}` });
      const busy = list.items.filter((job) => job.metadata?.labels?.[RUN_LABELS.runId] !== spec.runId && jobEnded(job) === null);
      if (busy.length === 0) return;
      if (Date.now() >= deadline) {
        logger.warn({ runId: spec.runId, busy: busy.map((job) => job.metadata?.name) }, "the ticket's earlier run pods have not ended; starting anyway");
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, Math.min(pollMs, 5_000)));
    }
  };

  const start = async (spec: RunSpec): Promise<LiveRun> => {
    await waitTicketIdle(spec);
    const tokens = { runner: p.stores.runTokens.issue(spec.runId, "runner"), tools: p.stores.runTokens.issue(spec.runId, "tools") };
    const run: LiveRun = { spec, report: null, work: null, ended: null, adopted: false, check: () => undefined };
    // Registered first: the pod may report before the create call returns.
    runs.set(spec.runId, run);
    try {
      // Recorded before the pod exists, so a restart finds it.
      if (spec.jobId > 0) p.stores.jobs.recordRun(spec.jobId, spec.runId);
      const specConfigMap = specConfigMapOf(spec.runId);
      const body = { metadata: { name: specConfigMap, namespace, labels: runLabels(spec) }, data: { [SPEC_KEY]: JSON.stringify(spec) } };
      try {
        await p.core.createNamespacedConfigMap({ namespace, body });
      } catch (err) {
        // A leftover of an attempt that never started: its pod does not exist, so the spec is replaced.
        if (!isConflict(err)) throw err;
        await deleteSpec(spec.runId);
        await p.core.createNamespacedConfigMap({ namespace, body });
      }
      await p.batch.createNamespacedJob({ namespace, body: buildRunJob(spec, { runtime: p.runtime, tokens, specConfigMap, checksTimeoutMinutes: p.checksTimeoutMinutes }) });
    } catch (err) {
      await endRun(spec.runId);
      throw new Error(`the run pod could not be created: ${message(err)}`, { cause: err });
    }
    return run;
  };

  const waitFor = (run: LiveRun, signal: AbortSignal | undefined): Promise<{ report: RunReport; work: WorkReport }> =>
    new Promise((resolve, reject) => {
      const { runId } = run.spec;
      let polling = false;
      const done = (): void => {
        clearInterval(timer);
        signal?.removeEventListener("abort", onAbort);
        run.check = () => undefined;
      };
      run.check = () => {
        if (run.report !== null && run.work !== null) {
          done();
          resolve({ report: run.report, work: run.work });
          return;
        }
        if (run.ended === null) return;
        done();
        // A pod that reported and ended without the work report: what it left could not be checked, so it reads as unpushed.
        const report = run.report ?? interruptedReport(runId);
        resolve({ report, work: run.work ?? { runId, unpushed: NO_WORK_REPORT, pushedSha: null } });
      };
      const poll = async (): Promise<void> => {
        if (polling) return;
        polling = true;
        try {
          const job = await readJob(runId);
          const ended = job === null ? "gone" : jobEnded(job);
          if (ended !== null) {
            run.ended = ended;
            run.check();
          }
        } catch (err) {
          logger.warn({ runId, err: message(err) }, "the run Job could not be read");
        } finally {
          polling = false;
        }
      };
      const onAbort = (): void => {
        done();
        // Nothing is removed: the pod goes on and the next start reattaches to it.
        reject(new Error(DETACHED_ERROR));
      };
      const timer = setInterval(() => void poll(), pollMs);
      if (signal?.aborted === true) return onAbort();
      signal?.addEventListener("abort", onAbort, { once: true });
      run.check();
    });

  return {
    execute: async (spec, signal) => {
      let run = runs.get(spec.runId);
      if (run !== undefined && !run.adopted) throw new Error(`run ${spec.runId} is already executing`);
      if (run !== undefined) run.adopted = false;
      else run = await start(spec);
      ensureWatch();
      let result: { report: RunReport; work: WorkReport };
      try {
        result = await waitFor(run, signal);
      } catch (err) {
        if (signal?.aborted === true) runs.delete(spec.runId);
        throw err;
      }
      await endRun(spec.runId);
      return result;
    },

    cancel: async (runId) => {
      await deleteJob(runId);
      if (!runs.has(runId)) await endRun(runId);
    },

    reattach: async () => {
      for (const job of p.stores.jobs.list({ status: "running", limit: ALL_ROWS })) {
        // Only the run of the job's open attempt: an earlier attempt's pod may still be finishing its session upload.
        const attempt = p.stores.attempts.forJob(job.id).at(-1);
        const current = attempt !== undefined && attempt.finishedAt === null && job.runId === `${job.id}-${attempt.number}`;
        if (job.runId !== null && current) {
          const live = await readJob(job.runId);
          if (live !== null && jobEnded(live) === null) {
            const spec = await readSpec(job.runId);
            if (spec !== null && spec.jobId === job.id) {
              runs.set(job.runId, { spec, report: null, work: null, ended: null, adopted: true, check: () => undefined });
              logger.info({ jobId: job.id, runId: job.runId }, "reattached to a live run pod");
              continue;
            }
            // Without its spec the run cannot be finished: it stops, and the job runs again.
            await deleteJob(job.runId);
          }
          await endRun(job.runId);
        }
        p.stores.jobs.requeueInterruptedJob(job.id, p.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
        logger.info({ jobId: job.id, runId: job.runId }, "requeued a running job whose run pod is gone");
      }
      if (runs.size > 0) ensureWatch();
    },

    stopOrphans: async (prefix, keep) => {
      const list = await p.batch.listNamespacedJob({ namespace, labelSelector: RUN_LABELS.runId });
      const live = new Set(
        list.items.filter((job) => jobEnded(job) === null).flatMap((job) => {
          const runId = job.metadata?.labels?.[RUN_LABELS.runId];
          return runId === undefined ? [] : [runId];
        }),
      );
      const candidates = new Set([...live, ...p.stores.runTokens.runIds()]);
      const orphans = [...candidates].filter((runId) => runId.startsWith(prefix) && !runs.has(runId) && !keep(runId));
      for (const runId of orphans) {
        if (live.has(runId)) await deleteJob(runId);
        await endRun(runId);
        logger.info({ runId }, "stopped a run nothing holds");
      }
      return orphans;
    },

    adopted: () => [...runs.values()].filter((run) => run.adopted).map((run) => run.spec),

    release: async (runId) => {
      const run = runs.get(runId);
      if (run === undefined || !run.adopted) return;
      await deleteJob(runId);
      await endRun(runId);
    },

    spec: (runId) => runs.get(runId)?.spec ?? null,

    deliverReport: (report) => {
      const run = runs.get(report.runId);
      if (run === undefined) return false;
      run.report = report;
      run.check();
      return true;
    },

    deliverWork: (work) => {
      const run = runs.get(work.runId);
      if (run === undefined) return false;
      run.work = work;
      run.check();
      return true;
    },

    close: () => {
      closed = true;
      watching?.abort();
      if (watchTimer !== null) clearTimeout(watchTimer);
    },
  };
};
