import type { Command } from "commander";
import type { FastifyInstance } from "fastify";
import { HEARTBEAT_MS } from "../chat/lease.js";
import { kubernetesRuntime } from "../config/schema.js";
import { settingsOf } from "../implement/pipeline.js";
import type { KubernetesChat } from "../k8s/chat.js";
import { logger } from "../log.js";
import { storeLedger } from "../push/ledger.js";
import { remoteHeadOf } from "../push/service.js";
import { ADMIN_HOST, ADMIN_PORT, buildAdminServer, heldChatRuns, writeAdminToken } from "../server/admin.js";
import { seedSettings } from "../settings/schema.js";
import { SettingsStore } from "../settings/store.js";
import { buildServer } from "../server/app.js";
import { buildInternalServer, INTERNAL_PORT } from "../server/internal.js";
import type { Stores } from "../store/index.js";
import { startWorker, type WorkerDeps } from "../worker/index.js";
import { errorMessage, exitWith, fail, loadFromProgram, println, type CliContext } from "./context.js";
import { buildRuntime, type Runtime } from "./runtime.js";

/**
 * The address the server binds. Unset is Fastify's localhost, right for the host install behind a tunnel; the
 * Compose image sets STEWARD_LISTEN_HOST=0.0.0.0 so the port published from the dind service reaches it.
 */
export const listenHost = (env: NodeJS.ProcessEnv): string => env.STEWARD_LISTEN_HOST ?? "localhost";

/** Where run pods reach the internal run API: every interface of the dispatcher pod; the NetworkPolicy admits run pods only. */
const INTERNAL_HOST = "0.0.0.0";

/** The run pods' callback API over the steward's own push ledger, the run's target always taken from its spec. */
const internalServer = (runtime: Runtime, kubernetes: NonNullable<Runtime["kubernetes"]>) => {
  const { deps, stores } = runtime;
  return buildInternalServer({
    runs: kubernetes,
    tokens: stores.runTokens,
    ledger: storeLedger(deps),
    remoteHead: (target) => {
      const configured = settingsOf(deps);
      return configured === null ? () => Promise.resolve(null) : remoteHeadOf(deps, target, configured.remote);
    },
    pushIdsOf: (jobId) => stores.pushes.forJob(jobId).map((push) => push.id),
  });
};

/**
 * Stops the chat runs no live lease holds, now and every `HEARTBEAT_MS`: a chat whose CLI died (or that the restart cut
 * off) would otherwise keep its run pod and tokens, and once its lease is stale a job on the ticket may start beside it.
 * Returns the function that stops the timer.
 */
export const reapChats = async (chat: KubernetesChat, stores: Pick<Stores, "leases">, everyMs = HEARTBEAT_MS): Promise<() => void> => {
  let reaping = false;
  const reap = async (): Promise<void> => {
    if (reaping) return;
    reaping = true;
    try {
      const held = heldChatRuns(stores);
      await chat.reap((runId) => held.has(runId));
    } finally {
      reaping = false;
    }
  };
  await reap();
  const timer = setInterval(() => {
    reap().catch((err: unknown) => logger.warn({ err: errorMessage(err) }, "steward chat: the runs no lease holds could not be reaped"));
  }, everyMs);
  timer.unref();
  return () => clearInterval(timer);
};

export const registerServe = (program: Command, ctx: CliContext): void => {
  program
    .command("serve")
    .description("run the webhook server and the job worker; takes run.lock")
    .action(async () => {
      const runtime = await buildRuntime(await loadFromProgram(program, ctx), ctx, { serve: true });
      const { config, secrets } = runtime.loaded;
      const { kubernetes } = runtime;
      const internal = kubernetes === undefined ? null : internalServer(runtime, kubernetes);
      let admin: FastifyInstance | null = null;
      let workerDeps: WorkerDeps = runtime.deps;
      let stopReaping = (): void => undefined;
      const k8s = kubernetesRuntime(config);
      if (kubernetes !== undefined && internal !== null && k8s !== null) {
        try {
          // Before the worker claims anything: a live run pod is waited on again, never started a second time.
          await kubernetes.reattach();
          // Also before the worker: a chat run left by the last start, its lease gone, no longer holds the ticket's session.
          if (runtime.chat !== undefined) stopReaping = await reapChats(runtime.chat, runtime.stores);
          await internal.listen({ port: INTERNAL_PORT, host: INTERNAL_HOST });
        } catch (err) {
          stopReaping();
          return fail(ctx, `could not reattach to the run pods: ${errorMessage(err)}`);
        }
        try {
          // The CLI in this pod is the admin API's client; a new token each start, in memory only.
          const token = await writeAdminToken(k8s.runtimeDir);
          const { stores, tracker, chat } = runtime;
          const settings = new SettingsStore(stores.db, seedSettings(config));
          admin = buildAdminServer({ token, stores, settings, resolveTicket: (key) => tracker.resolveIssueId(key), ...(chat === undefined ? {} : { chat }) });
          await admin.listen({ port: ADMIN_PORT, host: ADMIN_HOST });
        } catch (err) {
          stopReaping();
          await internal.close();
          return fail(ctx, `could not start the admin API: ${errorMessage(err)}`);
        }
        workerDeps = { ...workerDeps, resume: { specs: kubernetes.adopted(), release: (runId) => kubernetes.release(runId) } };
      }
      let worker;
      try {
        worker = startWorker(workerDeps);
      } catch (err) {
        stopReaping();
        await internal?.close();
        await admin?.close();
        return fail(ctx, errorMessage(err));
      }
      const gitlab = runtime.deps.gitlab;
      const app = buildServer({ config, secrets, stores: runtime.stores, tracker: runtime.tracker, workerState: worker.state, ...(gitlab === undefined ? {} : { gitlab }) });
      await app.listen({ port: config.server.port, host: listenHost(process.env) });
      println(ctx, `listening on http://localhost:${config.server.port} (public ${config.server.publicUrl})`);
      if (internal !== null) println(ctx, `run callbacks on ${INTERNAL_HOST}:${INTERNAL_PORT}`);
      if (admin !== null) println(ctx, `admin API on ${ADMIN_HOST}:${ADMIN_PORT}`);

      const shutdown = async (): Promise<void> => {
        println(ctx, "shutting down: waiting for in-flight jobs");
        stopReaping();
        await worker.stop();
        await app.close();
        await internal?.close();
        await admin?.close();
        kubernetes?.close();
        exitWith(ctx, 0);
      };
      process.once("SIGINT", () => void shutdown());
      process.once("SIGTERM", () => void shutdown());
    });
};
