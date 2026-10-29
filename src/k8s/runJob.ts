import { dirname } from "node:path";
import type { V1Container, V1EnvVar, V1Job, V1Volume, V1VolumeMount } from "@kubernetes/client-node";
import type { KubernetesRuntime } from "../config/schema.js";
import { RUNNER_TOKEN_ENV } from "../cli/runPod.js";
import { CALLBACK_URL_ENV, TOOLS_TOKEN_ENV } from "../cli/tools.js";
import { EGRESS_CA_DIR, EGRESS_CA_FILE, POD_OVERLAY_DIR, POD_PORTS, podShutdownBudgetMs } from "../run/pod.js";
import type { RunSpec } from "../run/protocol.js";
import { MINIO_TOKEN_FILE, SESSIONS_CONFIG_DIR } from "../sessions/store.js";

/** The labels every run Job and its pod carry; the executor finds and watches runs by them. */
export const RUN_LABELS = { runId: "steward.run-id", jobId: "steward.job-id", ticket: "steward.ticket" } as const;

/** Projected service-account token audiences: AWS STS for Secrets Manager, MinIO's STS for the session bucket. */
export const AWS_AUDIENCE = "sts.amazonaws.com";
export const MINIO_AUDIENCE = "minio";
export const TOKEN_EXPIRY_SECONDS = 3600;
/** Margin past the run's own limits for the pod's start, the sidecars and the report's retries. */
const DEADLINE_MARGIN_MINUTES = 15;
const TTL_AFTER_FINISHED_SECONDS = 3600;

const AWS_TOKEN_DIR = "/var/run/secrets/steward/aws";
const SPEC_DIR = "/run/steward/spec";
export const SPEC_KEY = "spec.json";
const GUARD_DIR = "/run/steward/guard";
const RULES_DIR = "/run/egress-rules";
/**
 * The steward image's user. render-overlay writes the rules file mode 0600 as this user, so egress (whose image runs as
 * mitmproxy, uid 1000) runs as it too to read them; its entrypoint sets mitmproxy's confdir, so it needs no home.
 */
export const STEWARD_UID = 1001;
const EGRESS_CONFDIR = "/run/egress-confdir";

/**
 * The config dir travels as one gzipped tar under this key of `runtime.config.configMap`: ConfigMap keys are flat and
 * the dir is not (the overlay template's `apps/<app>/.env`, prompts). The dispatcher and every run pod unpack it into
 * an emptyDir that the other containers mount read-only (docs/ops.md, "Running on k3s").
 */
export const CONFIG_BUNDLE_KEY = "config.tgz";
export const CONFIG_BUNDLE_DIR = "/etc/steward-config-bundle";

/**
 * The unpack container's command: the bundle's tree (made with `tar -C <config dir> .`) into `configDir`, owned by the
 * container's user. Stripping the leading `./` skips the archive's own `.` entry, whose mode and mtime a non-root user
 * cannot set on the root-owned emptyDir.
 */
export const configUnpackCommand = (p: { bundle: string; configDir: string }): string[] => [
  "sh",
  "-c",
  'tar -xzf "$1" -C "$2" --strip-components=1 --no-same-owner --no-same-permissions',
  "config-unpack",
  p.bundle,
  p.configDir,
];

/** A Kubernetes object name for the run: lower case, `[a-z0-9-]`, at most 63 characters. */
const dnsName = (prefix: string, runId: string): string =>
  `${prefix}-${runId.toLowerCase().replace(/[^a-z0-9-]+/g, "-")}`.slice(0, 63).replace(/-+$/, "");

export const jobNameOf = (runId: string): string => dnsName("run", runId);
/** The ConfigMap holding the run's spec (the spec carries no secret). */
export const specConfigMapOf = (runId: string): string => dnsName("run", runId);

/** The labels of one run's objects. */
export const runLabels = (spec: Pick<RunSpec, "runId" | "jobId" | "identifier">): Record<string, string> => ({
  [RUN_LABELS.runId]: spec.runId,
  [RUN_LABELS.jobId]: String(spec.jobId),
  [RUN_LABELS.ticket]: spec.identifier,
});

const env = (values: Record<string, string>): V1EnvVar[] => Object.entries(values).map(([name, value]) => ({ name, value }));

const mount = (name: string, mountPath: string, readOnly = false): V1VolumeMount => (readOnly ? { name, mountPath, readOnly } : { name, mountPath });

/**
 * The run's Job: one pod whose agent container holds no credential. The init containers unpack the config dir, clone the
 * worktree, render the overlay and pull the session; the sidecars (native, so the pod ends when the agent does and session-sync still pushes
 * on its SIGTERM) put credentials on the agent's requests and serve its throwaway services. Only containers that read
 * AWS or MinIO get a projected token, each for its own audience.
 */
export const buildRunJob = (spec: RunSpec, p: {
  runtime: KubernetesRuntime;
  tokens: { runner: string; tools: string };
  specConfigMap: string;
  /** `implement.checksTimeoutMinutes`: sizes the pod's grace period. */
  checksTimeoutMinutes: number;
}): V1Job => {
  const { runtime } = p;
  const configPath = runtime.config.path;
  const steward = (...args: string[]): string[] => ["steward", "--config", configPath, ...args];
  const specFile = `${SPEC_DIR}/${SPEC_KEY}`;
  const workRoot = dirname(spec.worktreePath);
  const jobDir = dirname(spec.artifactsDir);

  const awsEnv = env({ AWS_ROLE_ARN: runtime.aws.roleArn, AWS_WEB_IDENTITY_TOKEN_FILE: `${AWS_TOKEN_DIR}/token`, AWS_REGION: runtime.aws.region });
  const awsToken = mount("aws-token", AWS_TOKEN_DIR, true);
  const minioToken = mount("minio-token", dirname(MINIO_TOKEN_FILE), true);
  const config = mount("config", dirname(configPath), true);
  const specMount = mount("spec", SPEC_DIR, true);
  const sessionArgs = ["--identifier", spec.identifier, "--worktree", spec.worktreePath, "--bucket", runtime.minio.bucket, "--endpoint", runtime.minio.endpoint];
  const sidecar = (container: V1Container): V1Container => ({ ...container, restartPolicy: "Always" });
  const asSteward = { runAsUser: STEWARD_UID, runAsGroup: STEWARD_UID };

  const init: V1Container[] = [
    {
      name: "config-unpack",
      image: runtime.images.steward,
      command: configUnpackCommand({ bundle: `${CONFIG_BUNDLE_DIR}/${CONFIG_BUNDLE_KEY}`, configDir: dirname(configPath) }),
      volumeMounts: [mount("config-bundle", CONFIG_BUNDLE_DIR, true), mount("config", dirname(configPath))],
    },
    {
      name: "git-init",
      image: runtime.images.steward,
      command: steward("git-init", "--spec", specFile),
      env: awsEnv,
      volumeMounts: [awsToken, config, specMount, mount("work", workRoot)],
    },
    {
      name: "render-overlay",
      image: runtime.images.steward,
      command: steward("render-overlay", "--agent-out", POD_OVERLAY_DIR, "--rules-out", `${RULES_DIR}/rules.json`, "--guard-out", `${GUARD_DIR}/guard.json`),
      env: awsEnv,
      volumeMounts: [awsToken, config, mount("overlay", POD_OVERLAY_DIR), mount("rules", RULES_DIR), mount("guard", GUARD_DIR)],
      securityContext: asSteward,
    },
    {
      name: "sessions-pull",
      image: runtime.images.steward,
      command: ["steward", "sessions", "pull", ...sessionArgs],
      volumeMounts: [minioToken, mount("sessions", SESSIONS_CONFIG_DIR)],
    },
  ];

  const sidecars: V1Container[] = [
    sidecar({
      name: "egress",
      image: runtime.images.egress,
      env: env({ EGRESS_CONFDIR, EGRESS_CA_OUT: EGRESS_CA_FILE, EGRESS_RULES: `${RULES_DIR}/rules.json` }),
      volumeMounts: [mount("rules", RULES_DIR, true), mount("egress-ca", EGRESS_CA_DIR), mount("egress-confdir", EGRESS_CONFDIR)],
      securityContext: asSteward,
    }),
    sidecar({ name: "keyproxy", image: runtime.images.steward, command: steward("keyproxy"), env: awsEnv, volumeMounts: [awsToken, config] }),
    sidecar({
      name: "tools",
      image: runtime.images.steward,
      command: steward("tools", "--spec", specFile, "--guard", `${GUARD_DIR}/guard.json`),
      env: [...awsEnv, ...env({ [CALLBACK_URL_ENV]: runtime.callbackUrl, [TOOLS_TOKEN_ENV]: p.tokens.tools })],
      // The job dir read-only: it attaches the screenshots and videos the agent left in the artifacts dir.
      volumeMounts: [awsToken, config, specMount, mount("guard", GUARD_DIR, true), mount("work", workRoot), mount("job", jobDir, true)],
    }),
    // The run's throwaway services answer on the pod's loopback only.
    sidecar({
      name: "postgres",
      image: runtime.images.postgres,
      args: ["-c", "listen_addresses=127.0.0.1", "-c", `port=${POD_PORTS.postgres}`],
      env: env({ POSTGRES_HOST_AUTH_METHOD: "trust" }),
    }),
    sidecar({ name: "redis", image: runtime.images.redis, args: ["--bind", "127.0.0.1", "--port", String(POD_PORTS.redis)] }),
    sidecar({ name: "rabbitmq", image: runtime.images.rabbitmq, env: env({ RABBITMQ_NODE_IP_ADDRESS: "127.0.0.1", RABBITMQ_NODE_PORT: String(POD_PORTS.rabbitmq) }) }),
    sidecar({
      name: "sessions-sync",
      image: runtime.images.steward,
      command: ["steward", "sessions", "sync", ...sessionArgs],
      volumeMounts: [minioToken, mount("sessions", SESSIONS_CONFIG_DIR, true)],
    }),
  ];

  const agent: V1Container = {
    name: "agent",
    image: runtime.images.agent,
    command: steward("run-pod", "--spec", specFile),
    // The runner token may only post this run's report; nothing else here is a credential.
    env: env({ [CALLBACK_URL_ENV]: runtime.callbackUrl, [RUNNER_TOKEN_ENV]: p.tokens.runner }),
    volumeMounts: [
      config,
      specMount,
      mount("work", workRoot),
      mount("sessions", SESSIONS_CONFIG_DIR),
      mount("job", jobDir),
      mount("overlay", POD_OVERLAY_DIR, true),
      mount("egress-ca", EGRESS_CA_DIR, true),
    ],
    resources: { requests: { ...runtime.resources.agent }, limits: { ...runtime.resources.agent } },
    securityContext: { allowPrivilegeEscalation: false },
    ...(spec.interactive ? { stdin: true, stdinOnce: true, tty: true } : {}),
  };

  const token = (name: string, audience: string): V1Volume => ({
    name,
    projected: { sources: [{ serviceAccountToken: { audience, expirationSeconds: TOKEN_EXPIRY_SECONDS, path: "token" } }] },
  });
  const empty = (name: string): V1Volume => ({ name, emptyDir: {} });
  const volumes: V1Volume[] = [
    token("aws-token", AWS_AUDIENCE),
    token("minio-token", MINIO_AUDIENCE),
    { name: "config-bundle", configMap: { name: runtime.config.configMap, items: [{ key: CONFIG_BUNDLE_KEY, path: CONFIG_BUNDLE_KEY }] } },
    { name: "spec", configMap: { name: p.specConfigMap, items: [{ key: SPEC_KEY, path: SPEC_KEY }] } },
    ...["config", "work", "sessions", "job", "overlay", "rules", "guard", "egress-ca", "egress-confdir"].map(empty),
  ];

  const labels = runLabels(spec);
  const limits = spec.limits.timeoutMinutes + spec.limits.setupTimeoutMinutes + DEADLINE_MARGIN_MINUTES;
  return {
    apiVersion: "batch/v1",
    kind: "Job",
    metadata: { name: jobNameOf(spec.runId), namespace: runtime.namespace, labels },
    spec: {
      backoffLimit: 0,
      activeDeadlineSeconds: Math.ceil(limits * 60),
      ttlSecondsAfterFinished: TTL_AFTER_FINISHED_SECONDS,
      template: {
        metadata: { labels },
        spec: {
          serviceAccountName: runtime.serviceAccount,
          automountServiceAccountToken: false,
          enableServiceLinks: false,
          restartPolicy: "Never",
          terminationGracePeriodSeconds: Math.ceil(podShutdownBudgetMs(p.checksTimeoutMinutes) / 1000),
          initContainers: [...init, ...sidecars],
          containers: [agent],
          volumes,
        },
      },
    },
  };
};
