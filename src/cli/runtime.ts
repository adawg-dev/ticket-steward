import { existsSync } from "node:fs";
import { join } from "node:path";
import { createBrain } from "../brain/index.js";
import type { Brain, BrainInput, BrainRun } from "../brain/types.js";
import { createCodeHost } from "../codehost/index.js";
import type { LoadedConfig } from "../config/load.js";
import type { PipelineDeps } from "../core/pipeline.js";
import { collectSecretValues, Redactor } from "../core/redact.js";
import { openStores, type Stores } from "../store/index.js";
import { createLinearTracker } from "../tracker/linear/index.js";
import type { Tracker } from "../tracker/types.js";
import { listFiles } from "../workspace/files.js";
import { injectToken, Mirror } from "../workspace/mirror.js";
import type { CliContext } from "./context.js";
import { binPath, mirrorPath } from "./paths.js";

export interface Runtime {
  loaded: LoadedConfig;
  stores: Stores;
  tracker: Tracker;
  deps: PipelineDeps;
}

export const openMirror = (loaded: LoadedConfig): Mirror =>
  new Mirror(mirrorPath(loaded.config.dataDir), injectToken(loaded.config.workspace.fetchUrl, loaded.secrets.MIRROR_TOKEN));

export const buildRedactor = async (loaded: LoadedConfig): Promise<Redactor> => {
  const { overlayDir } = loaded.config.workspace;
  const overlayFiles = existsSync(overlayDir) ? (await listFiles(overlayDir)).map((file) => join(overlayDir, file)) : [];
  return new Redactor(collectSecretValues(loaded.secrets, overlayFiles));
};

export const openTracker = (loaded: LoadedConfig, stores: Stores, ctx: CliContext): Tracker =>
  ctx.factories?.tracker ?? createLinearTracker(stores, loaded.secrets);

/** An injected brain runs in-process; the real brains run detached via the pipeline's default. */
const brainRunner = (brain: Brain): Pick<PipelineDeps, "runBrain"> => ({
  runBrain: (_config, input: BrainInput): Promise<BrainRun> => brain.run(input, () => undefined),
});

export const buildRuntime = async (loaded: LoadedConfig, ctx: CliContext): Promise<Runtime> => {
  const { config, secrets, configPath } = loaded;
  const stores = openStores(config.dataDir);
  const tracker = openTracker(loaded, stores, ctx);
  const injectedBrain = ctx.factories?.brain;
  const deps: PipelineDeps = {
    config,
    secrets,
    configPath,
    binPath,
    tracker,
    brain: injectedBrain ?? createBrain(config.brain),
    codehost: ctx.factories?.codehost ?? createCodeHost(config.codehost, secrets),
    mirror: openMirror(loaded),
    stores,
    redactor: await buildRedactor(loaded),
    now: () => new Date(),
    ...(injectedBrain === undefined ? {} : brainRunner(injectedBrain)),
  };
  return { loaded, stores, tracker, deps };
};
