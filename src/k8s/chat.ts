import type { CoreV1Api } from "@kubernetes/client-node";
import { errorMessage } from "../core/workspace.js";
import { logger } from "../log.js";
import type { RunReport, RunSpec, WorkReport } from "../run/protocol.js";
import { CHAT_RUN_PREFIX, type ChatEnd, type ChatLauncher, type ChatStart } from "../server/admin.js";
import type { KubernetesExecutor } from "./executor.js";
import { RUN_LABELS } from "./runJob.js";

/** The pod listing the chat launcher uses to find a run's pod; tests stand in for it. */
export type PodsApi = Pick<CoreV1Api, "listNamespacedPod">;

/** The agent container of a run pod: the one a person attaches to. */
export const AGENT_CONTAINER = "agent";

const DEFAULT_POLL_MS = 1_000;
/** Covers the executor's wait for the ticket's earlier run pods (their session upload) and the Job controller. */
const DEFAULT_POD_TIMEOUT_MS = 10 * 60_000;
/** How long a closed chat's run may take to report on its own before it is stopped. */
const DEFAULT_END_GRACE_MS = 60_000;

type Settled = { result: { report: RunReport; work: WorkReport } } | { error: string };

interface ChatRun {
  done: Promise<Settled>;
  settled: Settled | null;
}

/** The chat launcher of the Kubernetes runtime, with what `serve` uses to stop the chat runs no lease holds. */
export interface KubernetesChat extends ChatLauncher {
  /**
   * Ends every chat run `held` rejects: one this process started as `end` does (grace, then stop), and any other chat
   * run pod or token left behind (started before a restart, or its CLI died without releasing) is stopped and revoked.
   * Returns the run ids it ended or stopped.
   */
  reap(held: (runId: string) => boolean): Promise<string[]>;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * `steward chat` on Kubernetes: each chat is an interactive run (`interactiveSpec`) the executor runs as a run pod like
 * any job's, with the same sidecars, policy hook and session sync. `start` resolves with the pod's name once it exists;
 * the CLI attaches to its agent container. `end` gives the run a grace period to report after the person left, then stops it.
 * `reap` does the same for the runs whose lease is gone, so a chat whose CLI or steward died does not keep its pod and tokens.
 */
export const kubernetesChat = (p: {
  executor: Pick<KubernetesExecutor, "execute" | "cancel" | "stopOrphans">;
  pods: PodsApi;
  namespace: string;
  interactiveSpec: (start: ChatStart) => RunSpec;
  redact: (text: string) => string;
  pollMs?: number;
  podTimeoutMs?: number;
  endGraceMs?: number;
}): KubernetesChat => {
  const pollMs = p.pollMs ?? DEFAULT_POLL_MS;
  const runs = new Map<string, ChatRun>();

  const podOf = async (runId: string): Promise<string | null> => {
    const list = await p.pods.listNamespacedPod({ namespace: p.namespace, labelSelector: `${RUN_LABELS.runId}=${runId}` });
    const pod = list.items.find((item) => item.metadata?.deletionTimestamp === undefined);
    return pod?.metadata?.name ?? null;
  };

  const settle = async (run: ChatRun, timeoutMs: number): Promise<Settled | null> => {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), timeoutMs);
    });
    try {
      return await Promise.race([run.done, timeout]);
    } finally {
      clearTimeout(timer);
    }
  };

  const ended = (settled: Settled): ChatEnd => {
    if ("error" in settled) return { ok: false, error: p.redact(settled.error), unpushed: null };
    const { report, work } = settled.result;
    return { ok: report.ok, error: report.error === null ? null : p.redact(report.error), unpushed: p.redact(work.unpushed) };
  };

  const end = async (runId: string): Promise<ChatEnd> => {
    const run = runs.get(runId);
    // Started before a restart: nothing waits on it here, so it is stopped and its tokens and spec go.
    if (run === undefined) {
      await p.executor.cancel(runId);
      return { ok: null, error: null, unpushed: null };
    }
    runs.delete(runId);
    const settled = await settle(run, p.endGraceMs ?? DEFAULT_END_GRACE_MS);
    if (settled !== null) return ended(settled);
    logger.info({ runId }, "steward chat: the run did not end after the person left; stopping it");
    await p.executor.cancel(runId);
    return ended(await run.done);
  };

  return {
    start: async (start) => {
      const spec = p.interactiveSpec(start);
      const run: ChatRun = { done: Promise.resolve({ error: "not started" }), settled: null };
      run.done = p.executor.execute(spec).then(
        (result): Settled => (run.settled = { result }),
        (err: unknown): Settled => (run.settled = { error: errorMessage(err) }),
      );
      runs.set(spec.runId, run);
      const deadline = Date.now() + (p.podTimeoutMs ?? DEFAULT_POD_TIMEOUT_MS);
      for (;;) {
        if (run.settled !== null) {
          runs.delete(spec.runId);
          const why = "error" in run.settled ? run.settled.error : (run.settled.result.report.error ?? "it ended at once");
          throw new Error(`the run ended before its pod could be attached: ${p.redact(why)}`);
        }
        const pod = await podOf(spec.runId).catch((err: unknown) => {
          logger.warn({ runId: spec.runId, err: errorMessage(err) }, "steward chat: the run's pod could not be listed");
          return null;
        });
        if (pod !== null) return { pod };
        if (Date.now() >= deadline) {
          await p.executor.cancel(spec.runId);
          await run.done;
          runs.delete(spec.runId);
          throw new Error("its pod did not appear in time");
        }
        await sleep(pollMs);
      }
    },

    end,

    reap: async (held) => {
      // Taken out of `runs` by `end` at once, so a reap that overlaps this one does not end them again.
      const mine = [...runs.keys()].filter((runId) => !held(runId));
      const results = await Promise.allSettled(mine.map((runId) => end(runId)));
      results.forEach((result, i) => {
        if (result.status === "rejected") logger.warn({ runId: mine[i], err: errorMessage(result.reason) }, "steward chat: a run no lease holds could not be ended");
      });
      if (mine.length > 0) logger.info({ runIds: mine }, "steward chat: ended runs whose lease is gone");
      // Runs this process waits on are the executor's, and skipped there; the others no lease holds are stopped.
      const others = await p.executor.stopOrphans(CHAT_RUN_PREFIX, held);
      return [...mine, ...others];
    },
  };
};
