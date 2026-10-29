import { existsSync } from "node:fs";
import { join } from "node:path";
import { createBrain } from "../brain/index.js";
import type { Brain, BrainInput, BrainRun } from "../brain/types.js";
import { createGitLabMr } from "../codehost/gitlabMr.js";
import { createCodeHost } from "../codehost/index.js";
import type { LoadedConfig } from "../config/load.js";
import { kubernetesRuntime } from "../config/schema.js";
import type { PipelineDeps } from "../core/deps.js";
import { RunChannels } from "../run/channel.js";
import type { RunExecutor } from "../run/executor.js";
import { collectSecretValues, Redactor } from "../core/redact.js";
import { interactiveChatSpec } from "../chat/run.js";
import { kubernetesChat, type KubernetesChat } from "../k8s/chat.js";
import { clusterApis } from "../k8s/cluster.js";
import { kubernetesExecutor, type KubernetesExecutor } from "../k8s/executor.js";
import { openStores, type Stores } from "../store/index.js";
import { createLinearToken, createLinearTracker, type LinearToken } from "../tracker/linear/index.js";
import type { Tracker } from "../tracker/types.js";
import { listFiles } from "../workspace/files.js";
import { injectToken, Mirror } from "../workspace/mirror.js";
import { SlotClient } from "../workspace/slots.js";
import { connectAdmin, type AdminClient } from "./client.js";
import type { CliContext } from "./context.js";
import { binPath, mirrorPath } from "./paths.js";

export interface Runtime {
  loaded: LoadedConfig;
  stores: Stores;
  tracker: Tracker;
  /** The Linear app's token behind `tracker`, unless a factory supplied the tracker; `serve` revokes it on shutdown. */
  linearToken?: LinearToken;
  /** The open runs' event and steering channels (also `deps.channels`); `serve`'s internal run API reaches them for run pods. */
  channels: RunChannels;
  deps: PipelineDeps;
  /** On the Kubernetes runtime: the executor that runs each job as a run pod, which `serve` also reattaches and serves callbacks for. */
  kubernetes?: KubernetesExecutor;
  /** On the Kubernetes runtime: `steward chat`'s interactive run pods, which serve's admin API launches and serve reaps. */
  chat?: KubernetesChat;
}

export const openMirror = (loaded: LoadedConfig): Mirror =>
  new Mirror(mirrorPath(loaded.config.dataDir), injectToken(loaded.config.workspace.fetchUrl, loaded.secrets.MIRROR_TOKEN, loaded.secrets.MIRROR_USERNAME));

/** Secrets from `.env` (including `LINEAR_CLIENT_SECRET`) and the overlay are collected once. */
export const buildRedactor = async (loaded: LoadedConfig): Promise<Redactor> => {
  const { overlayDir } = loaded.config.workspace;
  const overlayFiles = existsSync(overlayDir) ? (await listFiles(overlayDir)).map((file) => join(overlayDir, file)) : [];
  return new Redactor(collectSecretValues(loaded.secrets, overlayFiles));
};

/** The dispatcher's tracker and the app token it holds in memory; only `serve` opens it. */
export const openTracker = (loaded: LoadedConfig, ctx: CliContext): { tracker: Tracker; linearToken?: LinearToken } => {
  if (ctx.factories?.tracker !== undefined) return { tracker: ctx.factories.tracker };
  const linearToken = createLinearToken(loaded.secrets);
  return { tracker: createLinearTracker(loaded.secrets, { token: linearToken }), linearToken };
};

/** Ticket reads through the dispatcher's admin API, which reads Linear with its own token. */
export const adminTracker = (client: Pick<AdminClient, "ticketBundle">): Pick<Tracker, "resolveIssueId" | "fetchTicket" | "readDescription"> => ({
  resolveIssueId: async (idOrKey) => {
    const { id, identifier, team } = await client.ticketBundle(idOrKey);
    return { id, identifier, teamKey: team.key };
  },
  fetchTicket: (issueId) => client.ticketBundle(issueId),
  readDescription: async (issueId) => (await client.ticketBundle(issueId)).description,
});

export const NO_ADMIN_API = "the CLI reaches Linear only through steward serve's admin API, which only the kubernetes runtime serves and which does not answer here";

/** A CLI command's tracker: reads through the admin API, connected on first use; it holds no token and writes nothing. */
const cliTracker = (loaded: LoadedConfig, ctx: CliContext): Tracker => {
  let connected: Promise<Pick<Tracker, "resolveIssueId" | "fetchTicket" | "readDescription">> | undefined;
  const reads = (): Promise<Pick<Tracker, "resolveIssueId" | "fetchTicket" | "readDescription">> => {
    connected ??= connectAdmin(ctx, loaded.config).then((client) => {
      if (client === null) throw new Error(NO_ADMIN_API);
      return adminTracker(client);
    });
    return connected;
  };
  return {
    kind: "linear",
    resolveIssueId: async (idOrKey) => (await reads()).resolveIssueId(idOrKey),
    fetchTicket: async (issueId) => (await reads()).fetchTicket(issueId),
    readDescription: async (issueId) => (await reads()).readDescription(issueId),
    appUserId: () => Promise.reject(new Error("the CLI reaches Linear only through steward serve's admin API, which keeps the app's user to itself")),
    credentialsRejected: () => false,
  };
};

/** An injected brain runs in-process; the real brains run detached via the pipeline's default. */
const brainRunner = (brain: Brain): Pick<PipelineDeps, "runBrain"> => ({
  runBrain: (_config, input: BrainInput, redactor, opts = {}): Promise<BrainRun> => {
    const { onLine } = opts;
    return brain.run(input, onLine === undefined ? () => undefined : (line) => onLine(redactor.redact(line)), opts.control);
  },
});

/** On the Kubernetes runtime only `serve` runs jobs: a run pod reports to its internal run API, which nothing else serves. */
export const INLINE_ON_KUBERNETES = "on the kubernetes runtime, jobs run in the dispatcher (steward serve); this command cannot run one inline";

const refuseInline: RunExecutor = { execute: () => Promise.reject(new Error(INLINE_ON_KUBERNETES)) };

export const buildRuntime = async (loaded: LoadedConfig, ctx: CliContext, opts: { serve?: boolean } = {}): Promise<Runtime> => {
  const { config, secrets, configPath } = loaded;
  // Only the dispatcher holds the Linear token; every other command reads Linear through its admin API.
  const { tracker, linearToken } = opts.serve === true ? openTracker(loaded, ctx) : { tracker: ctx.factories?.tracker ?? cliTracker(loaded, ctx) };
  const stores = openStores(config.dataDir);
  const linear = linearToken === undefined ? {} : { linearToken };
  const injectedBrain = ctx.factories?.brain;
  const codehost = ctx.factories?.codehost ?? createCodeHost(config.codehost, secrets);
  const gitlab = ctx.factories?.gitlab ?? createGitLabMr(config, secrets);
  const channels = new RunChannels();
  const deps: PipelineDeps = {
    config,
    secrets,
    configPath,
    binPath,
    tracker,
    brain: injectedBrain ?? createBrain(config.brain),
    codehost,
    ...(gitlab === undefined ? {} : { gitlab }),
    mirror: openMirror(loaded),
    stores,
    redactor: await buildRedactor(loaded),
    now: () => new Date(),
    channels,
    ...(injectedBrain === undefined ? {} : brainRunner(injectedBrain)),
  };
  const kubernetes = kubernetesRuntime(config);
  if (kubernetes !== null) {
    if (opts.serve !== true) return { loaded, stores, tracker, ...linear, channels, deps: { ...deps, executor: refuseInline } };
    // Run pods replace slots: each brings its own services on fixed loopback ports.
    const cluster = ctx.factories?.cluster ?? clusterApis(kubernetes.namespace);
    const executor = kubernetesExecutor({ runtime: kubernetes, ...cluster, stores, channels, checksTimeoutMinutes: config.implement?.checksTimeoutMinutes ?? 0 });
    const chat =
      cluster.pods === undefined
        ? undefined
        : kubernetesChat({
            executor,
            pods: cluster.pods,
            namespace: kubernetes.namespace,
            interactiveSpec: (start) => interactiveChatSpec(deps, start),
            redact: (text) => deps.redactor.redact(text),
          });
    return { loaded, stores, tracker, ...linear, channels, deps: { ...deps, executor }, kubernetes: executor, ...(chat === undefined ? {} : { chat }) };
  }
  // serve gives each worker loop its own slot; `steward chat` leases one of its own.
  const slot = config.slots === undefined ? {} : { slot: { n: 1, client: new SlotClient(config.slots, ctx.factories?.slotRunner) } };
  return { loaded, stores, tracker, ...linear, channels, deps: { ...deps, ...slot } };
};
