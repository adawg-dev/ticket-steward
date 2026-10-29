import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { AssumeRoleWithWebIdentityCommand, STSClient } from "@aws-sdk/client-sts";
import type { AwsCredentialIdentity } from "@aws-sdk/types";
import type { CoreV1Api, NetworkingV1Api, V1Pod } from "@kubernetes/client-node";
import { z } from "zod";
import type { LoadedConfig } from "../config/load.js";
import type { KubernetesRuntime } from "../config/schema.js";
import { awsSecretFetcher, readSecretValue, type SecretFetcher } from "../config/secretSource.js";
import { AGENT_CONTAINER } from "../k8s/chat.js";
import { doctorApis } from "../k8s/cluster.js";
import { RUN_LABELS } from "../k8s/runJob.js";
import { overlayTemplateSummary } from "../overlay/template.js";
import { MINIO_TOKEN_FILE, minioCredentials, s3ObjectStore, type ObjectStore } from "../sessions/store.js";
import { flunk, ok, warn, type Check, type CheckResult } from "./check.js";
import { errorMessage, type CliContext } from "./context.js";

/** The NetworkPolicies of `deploy/k8s/base/networkpolicy.yaml`; doctor expects each in the namespace. */
export const NETWORK_POLICIES = ["default-deny", "dispatcher", "minio", "run-pods", "run-pods-allow-cidrs"] as const;

/** The parts of the cluster doctor reads, and the probe pod it starts; tests stand in for them. */
export interface DoctorCluster {
  networking: Pick<NetworkingV1Api, "listNamespacedNetworkPolicy">;
  pods: Pick<CoreV1Api, "createNamespacedPod" | "readNamespacedPod" | "readNamespacedPodLog" | "deleteNamespacedPod">;
}

/** AWS STS `AssumeRoleWithWebIdentity` with a service-account token; resolves to the assumed role's ARN. */
export type AssumeWebIdentity = (p: { roleArn: string; region: string; token: string }) => Promise<string>;
/** MinIO STS sign-in with the token in `tokenFile` (audience `minio`). */
export type MinioSignIn = (p: { endpoint: string; tokenFile: string }) => Promise<AwsCredentialIdentity>;

export interface KubernetesDoctorDeps {
  fetchImpl: typeof fetch;
  cluster: DoctorCluster;
  assumeWebIdentity: AssumeWebIdentity;
  secretFetcher: SecretFetcher;
  minioSignIn: MinioSignIn;
  objectStore: (credentials: AwsCredentialIdentity) => Pick<ObjectStore, "list">;
  /** The dispatcher's projected AWS token (`AWS_WEB_IDENTITY_TOKEN_FILE`); its `iss` is the cluster's issuer. */
  awsTokenFile: string | undefined;
  minioTokenFile: string;
  probe: { pollMs: number; timeoutMs: number };
}

const HTTP_TIMEOUT_MS = 5_000;
const PROBE_POLL_MS = 2_000;
/** Covers pulling the agent image onto a node that has not run one yet. */
const PROBE_TIMEOUT_MS = 5 * 60_000;
const OPS_DOC = 'docs/ops.md, "Running on k3s"';

const Discovery = z.object({ issuer: z.string(), jwks_uri: z.string() });
const Jwks = z.object({ keys: z.array(z.unknown()) });
const TokenClaims = z.object({ iss: z.string() });

/** STS through the AWS SDK, outside the default credential chain: the token is the one doctor names. */
const stsAssumeWebIdentity: AssumeWebIdentity = async ({ roleArn, region, token }) => {
  const sts = new STSClient({ region });
  try {
    const { AssumedRoleUser: user } = await sts.send(
      new AssumeRoleWithWebIdentityCommand({ RoleArn: roleArn, RoleSessionName: "steward-doctor", WebIdentityToken: token, DurationSeconds: 900 }),
    );
    if (user?.Arn === undefined) throw new Error("STS returned no assumed role");
    return user.Arn;
  } finally {
    sts.destroy();
  }
};

/** Doctor's cluster checks with the real AWS, MinIO and cluster, or the fakes in `ctx.factories`. */
export const kubernetesDoctorDeps = (ctx: CliContext, loaded: LoadedConfig, runtime: KubernetesRuntime): KubernetesDoctorDeps => {
  const factories = ctx.factories;
  const secrets = loaded.config.secrets;
  const tokenFile = process.env.AWS_WEB_IDENTITY_TOKEN_FILE;
  return {
    fetchImpl: ctx.fetchImpl,
    cluster: factories?.doctorCluster ?? doctorApis(),
    assumeWebIdentity: factories?.assumeWebIdentity ?? stsAssumeWebIdentity,
    secretFetcher: factories?.secretFetcher ?? awsSecretFetcher(secrets?.source === "aws" ? secrets.region : runtime.aws.region),
    minioSignIn: factories?.minioSignIn ?? ((p) => minioCredentials({ ...p, durationSeconds: 3600 })),
    objectStore: (credentials) =>
      factories?.objectStore ?? s3ObjectStore({ endpoint: runtime.minio.endpoint, bucket: runtime.minio.bucket, credentials: async () => credentials }),
    awsTokenFile: tokenFile === undefined || tokenFile === "" ? undefined : tokenFile,
    minioTokenFile: MINIO_TOKEN_FILE,
    probe: { pollMs: PROBE_POLL_MS, timeoutMs: PROBE_TIMEOUT_MS },
  };
};

type Read<T> = { ok: true; value: T } | { ok: false; result: CheckResult };

/** The dispatcher's AWS token and its issuer claim; the signature is AWS's to check. Messages never carry the token. */
const readAwsToken = async (file: string | undefined): Promise<Read<{ token: string; issuer: string }>> => {
  if (file === undefined) return { ok: false, result: flunk("AWS_WEB_IDENTITY_TOKEN_FILE is not set; the dispatcher's Deployment projects its AWS token there") };
  const token = (await readFile(file, "utf8")).trim();
  const [, payload, signature] = token.split(".");
  let claims: unknown;
  try {
    claims = payload === undefined || signature === undefined ? undefined : JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    claims = undefined;
  }
  const parsed = TokenClaims.safeParse(claims);
  if (!parsed.success) return { ok: false, result: flunk(`${file} does not hold a service-account token`) };
  return { ok: true, value: { token, issuer: parsed.data.iss } };
};

/** k3s's default issuer is the in-cluster API server, which neither AWS nor MinIO can fetch. */
const isPublicHttps = (issuer: string): boolean => {
  let url: URL;
  try {
    url = new URL(issuer);
  } catch {
    return false;
  }
  const host = url.hostname;
  return url.protocol === "https:" && !host.startsWith("kubernetes.default") && !host.endsWith(".svc") && !host.endsWith(".cluster.local");
};

const issuerCheck = (deps: KubernetesDoctorDeps): Check => ({
  name: "k3s issuer",
  run: async () => {
    const read = await readAwsToken(deps.awsTokenFile);
    if (!read.ok) return read.result;
    const { issuer } = read.value;
    if (!isPublicHttps(issuer)) {
      return flunk(`the token's issuer is ${issuer}; start k3s with --kube-apiserver-arg=service-account-issuer=<public https url> (${OPS_DOC})`);
    }
    const discoveryUrl = `${issuer.replace(/\/+$/, "")}/.well-known/openid-configuration`;
    const discovery = await deps.fetchImpl(discoveryUrl, { signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
    if (!discovery.ok) return flunk(`${discoveryUrl} answered ${discovery.status}; AWS and MinIO fetch it to trust the cluster's tokens`);
    const document = Discovery.parse(await discovery.json());
    if (document.issuer !== issuer) return flunk(`${discoveryUrl} names the issuer ${document.issuer}, not ${issuer}`);
    const jwks = await deps.fetchImpl(document.jwks_uri, { signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
    if (!jwks.ok) return flunk(`${document.jwks_uri} answered ${jwks.status}`);
    const keys = Jwks.parse(await jwks.json()).keys.length;
    if (keys === 0) return flunk(`${document.jwks_uri} publishes no keys`);
    return ok(`${issuer}: discovery and JWKS (${keys} key${keys === 1 ? "" : "s"}) answer`);
  },
});

const roleCheck = (runtime: KubernetesRuntime, deps: KubernetesDoctorDeps): Check => ({
  name: "aws role",
  run: async () => {
    const read = await readAwsToken(deps.awsTokenFile);
    if (!read.ok) return read.result;
    const { roleArn, region } = runtime.aws;
    try {
      const assumed = await deps.assumeWebIdentity({ roleArn, region, token: read.value.token });
      return ok(`${roleArn} assumed as ${assumed}`);
    } catch (err) {
      return flunk(`${roleArn}: ${errorMessage(err)}; check the role's trust policy (deploy/aws/steward-role.tf.example)`);
    }
  },
});

/** The secret ids the dispatcher and the run pods read: the secrets map's and the overlay template's. */
const secretIds = async ({ config }: LoadedConfig): Promise<string[]> => {
  const mapped = config.secrets?.source === "aws" ? Object.values(config.secrets.map) : [];
  const templateDir = config.workspace.overlayTemplateDir;
  const templated = templateDir !== undefined && existsSync(templateDir) ? (await overlayTemplateSummary(templateDir)).secretIds : [];
  return [...new Set([...mapped, ...templated])].sort();
};

const secretsCheck = (loaded: LoadedConfig, deps: KubernetesDoctorDeps): Check => ({
  name: "dev secrets",
  run: async () => {
    const ids = await secretIds(loaded);
    if (ids.length === 0) return ok("neither the secrets map nor the overlay template names an id");
    const problems: string[] = [];
    for (const id of ids) {
      // Read to prove it is there and not empty; the value goes nowhere.
      await readSecretValue(deps.secretFetcher, id).catch((err: unknown) => problems.push(errorMessage(err)));
    }
    return problems.length === 0 ? ok(`${ids.length} id(s) present: ${ids.join(", ")}`) : flunk(problems.join("; "));
  },
});

const templateCheck = ({ config }: LoadedConfig): Check => ({
  name: "overlay template",
  run: async () => {
    const templateDir = config.workspace.overlayTemplateDir;
    if (templateDir === undefined) return flunk("workspace.overlayTemplateDir is not set");
    if (!existsSync(templateDir)) return flunk(`${templateDir} does not exist`);
    const summary = await overlayTemplateSummary(templateDir);
    if (summary.issues.length > 0) return flunk(summary.issues.join("; "));
    if (summary.warnings.length > 0) return warn(summary.warnings.join("; "));
    return ok(`${templateDir}: ${summary.files} file(s), ${summary.secretIds.length} outbound secret(s)`);
  },
});

const minioCheck = (runtime: KubernetesRuntime, deps: KubernetesDoctorDeps): Check => ({
  name: "minio sts",
  run: async () => {
    const { endpoint, bucket } = runtime.minio;
    try {
      const credentials = await deps.minioSignIn({ endpoint, tokenFile: deps.minioTokenFile });
      const objects = await deps.objectStore(credentials).list("sessions/");
      return ok(`signed in at ${endpoint}; ${bucket} holds ${objects.length} session object(s)`);
    } catch (err) {
      return flunk(errorMessage(err));
    }
  },
});

const networkPolicyCheck = (runtime: KubernetesRuntime, deps: KubernetesDoctorDeps): Check => ({
  name: "network policies",
  run: async () => {
    const { namespace } = runtime;
    const list = await deps.cluster.networking.listNamespacedNetworkPolicy({ namespace });
    const present = new Set(list.items.map((policy) => policy.metadata?.name));
    const absent = NETWORK_POLICIES.filter((name) => !present.has(name));
    return absent.length === 0 ? ok(`${NETWORK_POLICIES.join(", ")} in ${namespace}`) : flunk(`missing in ${namespace}: ${absent.join(", ")}; kubectl apply -k deploy/k8s/base`);
  },
});

/**
 * What the probe pod's agent container reports: any token under /var/run/secrets, and whether the API server answers
 * (any HTTP answer, even 401, means the NetworkPolicy let it through). Its own env carries no proxy.
 */
export const PROBE_SCRIPT = [
  'found="$(find /var/run/secrets -name token 2>/dev/null | tr "\\n" " ")"',
  'if [ -n "$found" ]; then echo "probe token: present $found"; else echo "probe token: none"; fi',
  'host="${KUBERNETES_SERVICE_HOST:-kubernetes.default.svc}"',
  'port="${KUBERNETES_SERVICE_PORT:-443}"',
  'if curl -sk --max-time 5 -o /dev/null "https://$host:$port/version"; then echo "probe apiserver: reachable"; else echo "probe apiserver: unreachable"; fi',
].join("\n");

/** A pod shaped like a run pod's agent container: the run pods' service account, no token, the run-id label for their NetworkPolicy. */
export const probePod = (runtime: KubernetesRuntime, name: string): V1Pod => ({
  apiVersion: "v1",
  kind: "Pod",
  metadata: { name, namespace: runtime.namespace, labels: { [RUN_LABELS.runId]: name } },
  spec: {
    serviceAccountName: runtime.serviceAccount,
    automountServiceAccountToken: false,
    enableServiceLinks: false,
    restartPolicy: "Never",
    activeDeadlineSeconds: Math.ceil(PROBE_TIMEOUT_MS / 1000),
    containers: [
      {
        name: AGENT_CONTAINER,
        image: runtime.images.agent,
        command: ["sh", "-c", PROBE_SCRIPT],
        resources: { requests: { cpu: "100m", memory: "64Mi" }, limits: { cpu: "500m", memory: "128Mi" } },
        securityContext: { allowPrivilegeEscalation: false },
      },
    ],
  },
});

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const runProbe = async (runtime: KubernetesRuntime, deps: KubernetesDoctorDeps): Promise<CheckResult> => {
  const { namespace } = runtime;
  const { pods } = deps.cluster;
  const name = `doctor-probe-${randomBytes(4).toString("hex")}`;
  await pods.createNamespacedPod({ namespace, body: probePod(runtime, name) });
  try {
    const deadline = Date.now() + deps.probe.timeoutMs;
    let phase: string | undefined;
    for (;;) {
      phase = (await pods.readNamespacedPod({ name, namespace })).status?.phase;
      if (phase === "Succeeded" || phase === "Failed") break;
      if (Date.now() >= deadline) return flunk(`${name} did not finish in ${deps.probe.timeoutMs / 1000} s (phase ${phase ?? "unknown"})`);
      await sleep(deps.probe.pollMs);
    }
    const log = await pods.readNamespacedPodLog({ name, namespace, container: AGENT_CONTAINER });
    const lines = log.split("\n").map((line) => line.trim());
    const token = lines.find((line) => line.startsWith("probe token: "))?.slice("probe token: ".length);
    const apiserver = lines.find((line) => line.startsWith("probe apiserver: "))?.slice("probe apiserver: ".length);
    if (token === undefined || apiserver === undefined) return flunk(`${name} ended ${phase} without the probe's answer: ${log.trim().slice(-500)}`);
    if (token !== "none") return flunk(`the agent container holds a token: ${token.replace(/^present\s*/, "").trim()}`);
    if (apiserver !== "unreachable") return flunk("the agent container reaches the API server; is the run-pods NetworkPolicy applied and enforced?");
    return ok("the agent container has no service-account token and cannot reach the API server");
  } finally {
    await pods.deleteNamespacedPod({ name, namespace, gracePeriodSeconds: 0 }).catch(() => undefined);
  }
};

const probeCheck = (runtime: KubernetesRuntime, deps: KubernetesDoctorDeps, probe: boolean): Check => ({
  name: "probe pod",
  run: async () => (probe ? runProbe(runtime, deps) : ok("skipped; steward doctor --probe-pod starts one")),
});

/**
 * The Kubernetes runtime's checks, run in the dispatcher pod: the issuer AWS and MinIO trust, the IAM role, every
 * `DEV_` id the steward and the overlay read, the overlay template, MinIO's STS sign-in, the NetworkPolicies, and with
 * `probePod` a throwaway pod that shows a run's agent container has no token and no way to the API server.
 */
export const kubernetesChecks = (loaded: LoadedConfig, runtime: KubernetesRuntime, deps: KubernetesDoctorDeps, opts: { probePod: boolean }): Check[] => [
  issuerCheck(deps),
  roleCheck(runtime, deps),
  secretsCheck(loaded, deps),
  templateCheck(loaded),
  minioCheck(runtime, deps),
  networkPolicyCheck(runtime, deps),
  probeCheck(runtime, deps, opts.probePod),
];
