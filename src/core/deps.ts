import type { runBrainDetached } from "../brain/index.js";
import type { Brain } from "../brain/types.js";
import type { GitLabMrApi } from "../codehost/gitlabMr.js";
import type { CodeHost } from "../codehost/types.js";
import type { Secrets } from "../config/load.js";
import type { StewardConfig } from "../config/schema.js";
import type { Stores } from "../store/index.js";
import type { Tracker } from "../tracker/types.js";
import type { Mirror } from "../workspace/mirror.js";
import type { SlotRef } from "../workspace/slots.js";
import type { Redactor } from "./redact.js";

export interface PipelineDeps {
  config: StewardConfig;
  secrets: Secrets;
  configPath: string;
  binPath: string;
  tracker: Tracker;
  brain: Brain;
  codehost: CodeHost;
  /** Set when the Greptile fix loop can talk to GitLab (GitLab code host and token). */
  gitlab?: GitLabMrApi;
  mirror: Mirror;
  stores: Stores;
  redactor: Redactor;
  now: () => Date;
  runBrain?: typeof runBrainDetached;
  /** Aborted on shutdown: setup and the brain stop, and the outcome carries `INTERRUPTED_ERROR`. */
  signal?: AbortSignal;
  /** With `slots` configured: the job's slot (each worker loop's own, or slot 1 for inline CLI runs). */
  slot?: SlotRef;
}
