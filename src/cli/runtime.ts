import { existsSync } from "node:fs";
import { join } from "node:path";
import { createBrain } from "../brain/index.js";
import type { Brain, BrainInput, BrainRun } from "../brain/types.js";
import { createGitLabMr } from "../codehost/gitlabMr.js";
import { createCodeHost } from "../codehost/index.js";
import type { LoadedConfig } from "../config/load.js";
import { kubernetesRuntime } from "../config/schema.js";
import type { PipelineDeps } from "../core/deps.js";
import type { RunExecutor } from "../run/executor.js";
import { collectSecretValues, Redactor } from "../core/redact.js";
import { interactiveChatSpec } from "../chat/run.js";
import { kubernetesChat } from "../k8s/chat.js";
import { clusterApis } from "../k8s/cluster.js";
import { kubernetesExecutor, type KubernetesExecutor } from "../k8s/executor.js";
import type { ChatLauncher } from "../server/admin.js";
import { openStores, type Stores } from "../store/index.js";
import { createLinearTracker } from "../tracker/linear/index.js";
import type { Tracker } from "../tracker/types.js";
import { listFiles } from "../workspace/files.js";
import { injectToken, Mirror } from "../workspace/mirror.js";
import { SlotClient } from "../workspace/slots.js";
import type { CliContext } from "./context.js";
import { binPath, mirrorPath } from "./paths.js";

export interface Runtime {
  loaded: LoadedConfig;
  stores: Stores;
  tracker: Tracker;
  deps: PipelineDeps;
  /** On the Kubernetes runtime: the executor that runs each job as a run pod, which `serve` also reattaches and serves callbacks for. */
  kubernetes?: KubernetesExecutor;
  /** On the Kubernetes runtime: `steward chat`'s interactive run pods, which serve's admin API launches. */
  chat?: ChatLauncher;
}

export const openMirror = (loaded: LoadedConfig): Mirror =>
  new Mirror(mirrorPath(loaded.config.dataDir), injectToken(loaded.config.workspace.fetchUrl, loaded.secrets.MIRROR_TOKEN, loaded.secrets.MIRROR_USERNAME));

/** Secrets from `.env` (including `LINEAR_API_KEY`) and the overlay are collected once. */
export const buildRedactor = async (loaded: LoadedConfig): Promise<Redactor> => {
  const { overlayDir } = loaded.config.workspace;
  const overlayFiles = existsSync(overlayDir) ? (await listFiles(overlayDir)).map((file) => join(overlayDir, file)) : [];
  return new Redactor(collectSecretValues(loaded.secrets, overlayFiles));
};

export const openTracker = (loaded: LoadedConfig, ctx: CliContext): Tracker => ctx.factories?.tracker ?? createLinearTracker(loaded.secrets);

/** An injected brain runs in-process; the real brains run detached via the pipeline's default. */
const brainRunner = (brain: Brain): Pick<PipelineDeps, "runBrain"> => ({
  runBrain: (_config, input: BrainInput): Promise<BrainRun> => brain.run(input, () => undefined),
});

/** On the Kubernetes runtime only `serve` runs jobs: a run pod reports to its internal run API, which nothing else serves. */
export const INLINE_ON_KUBERNETES = "on the kubernetes runtime, jobs run in the dispatcher (steward serve); this command cannot run one inline";

const refuseInline: RunExecutor = { execute: () => Promise.reject(new Error(INLINE_ON_KUBERNETES)) };

export const buildRuntime = async (loaded: LoadedConfig, ctx: CliContext, opts: { serve?: boolean } = {}): Promise<Runtime> => {
  const { config, secrets, configPath } = loaded;
  const stores = openStores(config.dataDir);
  const tracker = openTracker(loaded, ctx);
  const injectedBrain = ctx.factories?.brain;
  const codehost = ctx.factories?.codehost ?? createCodeHost(config.codehost, secrets);
  const gitlab = ctx.factories?.gitlab ?? createGitLabMr(config, secrets);
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
    ...(injectedBrain === undefined ? {} : brainRunner(injectedBrain)),
  };
  const kubernetes = kubernetesRuntime(config);
  if (kubernetes !== null) {
    if (opts.serve !== true) return { loaded, stores, tracker, deps: { ...deps, executor: refuseInline } };
    // Run pods replace slots: each brings its own services on fixed loopback ports.
    const cluster = ctx.factories?.cluster ?? clusterApis(kubernetes.namespace);
    const executor = kubernetesExecutor({ runtime: kubernetes, ...cluster, stores });
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
    return { loaded, stores, tracker, deps: { ...deps, executor }, kubernetes: executor, ...(chat === undefined ? {} : { chat }) };
  }
  // serve gives each worker loop its own slot; inline runs (implement KEY, jobs retry) use slot 1 under run.lock.
  const slot = config.slots === undefined ? {} : { slot: { n: 1, client: new SlotClient(config.slots, ctx.factories?.slotRunner) } };
  return { loaded, stores, tracker, deps: { ...deps, ...slot } };
};
