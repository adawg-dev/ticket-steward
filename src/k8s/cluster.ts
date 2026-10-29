import { Attach, BatchV1Api, CoreV1Api, KubeConfig, Watch, type V1Job, type V1Pod } from "@kubernetes/client-node";
import type { PodsApi } from "./chat.js";
import type { ConfigMapsApi, JobsApi, JobWatch } from "./executor.js";

const isJob = (value: unknown): value is V1Job => typeof value === "object" && value !== null && "metadata" in value;

/**
 * The cluster as the dispatcher's service account sees it: the in-cluster config (or `KUBECONFIG` off-cluster), the Job,
 * ConfigMap and Pod APIs of its namespace, and a watch on the namespace's Jobs.
 */
export const clusterApis = (namespace: string): { batch: JobsApi; core: ConfigMapsApi; pods: PodsApi; watch: JobWatch } => {
  const config = new KubeConfig();
  config.loadFromDefault();
  const watcher = new Watch(config);
  const core = config.makeApiClient(CoreV1Api);
  return {
    batch: config.makeApiClient(BatchV1Api),
    core,
    pods: core,
    watch: (labelSelector, onJob, onDone) =>
      watcher.watch(
        `/apis/batch/v1/namespaces/${encodeURIComponent(namespace)}/jobs`,
        { labelSelector },
        (phase: string, object: unknown) => {
          if (isJob(object)) onJob(phase, object);
        },
        onDone,
      ),
  };
};

/** Attaches this terminal to a container's TTY until the container's process exits or the connection drops. */
export type AttachTty = (p: { namespace: string; pod: string; container: string; onWaiting?: () => void }) => Promise<void>;

const ATTACH_POLL_MS = 2_000;
/** The init containers (clone, overlay, session pull) and the sidecars come first. */
const ATTACH_WAIT_MS = 20 * 60_000;

/** Where a pod's container is: not started yet, running, or done (it exited, or the pod ended). */
export const containerState = (pod: V1Pod, container: string): "waiting" | "running" | "ended" => {
  if (pod.metadata?.deletionTimestamp !== undefined || pod.status?.phase === "Succeeded" || pod.status?.phase === "Failed") return "ended";
  const status = pod.status?.containerStatuses?.find((candidate) => candidate.name === container);
  if (status?.state?.terminated !== undefined) return "ended";
  return status?.state?.running === undefined ? "waiting" : "running";
};

/**
 * `kubectl attach -it`: waits for the container to run, then puts the terminal in raw mode and joins its TTY (stdin,
 * output and resizes). Ctrl-C goes to the container's process, not to this one.
 */
export const attachTty: AttachTty = async ({ namespace, pod, container, onWaiting }) => {
  const config = new KubeConfig();
  config.loadFromDefault();
  const core = config.makeApiClient(CoreV1Api);
  const deadline = Date.now() + ATTACH_WAIT_MS;
  for (let waited = false; ; waited = true) {
    const state = containerState(await core.readNamespacedPod({ name: pod, namespace }), container);
    if (state === "running") break;
    if (state === "ended") throw new Error(`the ${container} container of ${pod} has already ended`);
    if (Date.now() >= deadline) throw new Error(`the ${container} container of ${pod} did not start in time`);
    if (!waited) onWaiting?.();
    await new Promise((resolve) => setTimeout(resolve, ATTACH_POLL_MS));
  }
  const { stdin, stdout } = process;
  const raw = stdin.isTTY;
  if (raw) stdin.setRawMode(true);
  try {
    // With a TTY the container's stderr arrives on its stdout.
    const socket = await new Attach(config).attach(namespace, pod, container, stdout, null, stdin, true);
    await new Promise<void>((resolve) => {
      socket.on("close", () => resolve());
      socket.on("error", () => resolve());
    });
  } finally {
    if (raw) stdin.setRawMode(false);
    stdin.pause();
  }
};
