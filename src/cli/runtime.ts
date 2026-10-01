import { existsSync } from "node:fs";
import { join } from "node:path";
import { createBrain } from "../brain/index.js";
import type { Brain, BrainInput, BrainRun } from "../brain/types.js";
import { createGitLabReview } from "../codehost/gitlabReview.js";
import { createCodeHost } from "../codehost/index.js";
import type { LoadedConfig } from "../config/load.js";
import type { PipelineDeps } from "../core/pipeline.js";
import { collectSecretValues, Redactor } from "../core/redact.js";
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

export const buildRuntime = async (loaded: LoadedConfig, ctx: CliContext): Promise<Runtime> => {
  const { config, secrets, configPath } = loaded;
  const stores = openStores(config.dataDir);
  const tracker = openTracker(loaded, ctx);
  const injectedBrain = ctx.factories?.brain;
  const codehost = ctx.factories?.codehost ?? createCodeHost(config.codehost, secrets);
  const review = ctx.factories?.review ?? createGitLabReview(config, secrets);
  const deps: PipelineDeps = {
    config,
    secrets,
    configPath,
    binPath,
    tracker,
    brain: injectedBrain ?? createBrain(config.brain),
    codehost,
    mirror: openMirror(loaded),
    stores,
    redactor: await buildRedactor(loaded),
    now: () => new Date(),
    ...(review === undefined ? {} : { review }),
    ...(injectedBrain === undefined ? {} : brainRunner(injectedBrain)),
    // serve gives each worker loop its own slot; inline runs (enrich|implement KEY, jobs retry) use slot 1 under run.lock.
    ...(config.slots === undefined ? {} : { slot: { n: 1, client: new SlotClient(config.slots, ctx.factories?.slotRunner) } }),
  };
  return { loaded, stores, tracker, deps };
};
