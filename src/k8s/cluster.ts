import { BatchV1Api, CoreV1Api, KubeConfig, Watch, type V1Job } from "@kubernetes/client-node";
import type { ConfigMapsApi, JobsApi, JobWatch } from "./executor.js";

const isJob = (value: unknown): value is V1Job => typeof value === "object" && value !== null && "metadata" in value;

/**
 * The cluster as the dispatcher's service account sees it: the in-cluster config (or `KUBECONFIG` off-cluster), the Job
 * and ConfigMap APIs of its namespace, and a watch on the namespace's Jobs.
 */
export const clusterApis = (namespace: string): { batch: JobsApi; core: ConfigMapsApi; watch: JobWatch } => {
  const config = new KubeConfig();
  config.loadFromDefault();
  const watcher = new Watch(config);
  return {
    batch: config.makeApiClient(BatchV1Api),
    core: config.makeApiClient(CoreV1Api),
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
