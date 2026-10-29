import type { runBrainDetached } from "../brain/index.js";
import type { Brain } from "../brain/types.js";
import type { GitLabMrApi } from "../codehost/gitlabMr.js";
import type { CodeHost } from "../codehost/types.js";
import type { Secrets } from "../config/load.js";
import type { StewardConfig } from "../config/schema.js";
import type { Settings } from "../settings/schema.js";
import type { Stores } from "../store/index.js";
import type { LinearAgentApi } from "../tracker/linear/agent.js";
import type { Tracker } from "../tracker/types.js";
import type { RunChannels } from "../run/channel.js";
import type { RunExecutor } from "../run/executor.js";
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
  /**
   * Where a run's execute half happens. Unset, it runs in-process through `localExecutor` over the run's own deps, so
   * each worker loop's slot and signal apply; the Kubernetes runtime sets its executor here.
   */
  executor?: RunExecutor;
  /** The open runs' event and steering channels, shared by the executors and whatever steers them (the dispatcher's). */
  channels?: RunChannels;
  /** The dispatcher's Linear agent API: runs show their work in the ticket's agent session. Absent, nothing is posted. */
  linear?: LinearAgentApi;
  /** The runtime settings, read on each use; absent, their defaults apply. */
  settings?: { get(): Settings };
}
