import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseAllDocuments } from "yaml";
import { z } from "zod";
import { NETWORK_POLICIES } from "../../src/cli/doctorKubernetes.js";
import { RUN_LABELS } from "../../src/k8s/runJob.js";
import { INTERNAL_PORT } from "../../src/server/internal.js";
import { MINIO_TOKEN_FILE, SESSIONS_BUCKET } from "../../src/sessions/store.js";

const BASE = resolve("deploy/k8s/base");
const RFC1918 = ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"];

const Metadata = z.object({ name: z.string(), namespace: z.string().optional(), labels: z.record(z.string(), z.string()).optional() });
const Manifest = z.looseObject({ apiVersion: z.string(), kind: z.string(), metadata: Metadata });
type Manifest = z.infer<typeof Manifest>;

const EnvVar = z.object({
  name: z.string(),
  value: z.string().optional(),
  valueFrom: z.object({ configMapKeyRef: z.object({ name: z.string(), key: z.string() }) }).optional(),
});
const Mount = z.object({ name: z.string(), mountPath: z.string(), readOnly: z.boolean().optional() });
const Container = z.looseObject({
  name: z.string(),
  image: z.string(),
  env: z.array(EnvVar).default([]),
  volumeMounts: z.array(Mount).default([]),
  ports: z.array(z.object({ containerPort: z.number(), name: z.string().optional() })).default([]),
});
const Volume = z.looseObject({ name: z.string() });
const PodSpec = z.looseObject({
  serviceAccountName: z.string().optional(),
  automountServiceAccountToken: z.boolean().optional(),
  initContainers: z.array(Container).default([]),
  containers: z.array(Container),
  volumes: z.array(Volume).default([]),
});
const Workload = z.object({
  kind: z.string(),
  metadata: Metadata,
  spec: z.looseObject({
    replicas: z.number(),
    strategy: z.object({ type: z.string() }).optional(),
    selector: z.object({ matchLabels: z.record(z.string(), z.string()) }),
    template: z.object({ metadata: z.object({ labels: z.record(z.string(), z.string()) }), spec: PodSpec }),
    volumeClaimTemplates: z.array(z.unknown()).optional(),
  }),
});
const Claim = z.object({
  metadata: Metadata,
  spec: z.object({ accessModes: z.array(z.string()), storageClassName: z.string(), resources: z.object({ requests: z.object({ storage: z.string() }) }) }),
});

const Selector = z.object({
  matchLabels: z.record(z.string(), z.string()).optional(),
  matchExpressions: z.array(z.object({ key: z.string(), operator: z.string(), values: z.array(z.string()).optional() })).optional(),
});
const Peer = z.object({
  podSelector: Selector.optional(),
  namespaceSelector: Selector.optional(),
  ipBlock: z.object({ cidr: z.string(), except: z.array(z.string()).optional() }).optional(),
});
const PolicyPort = z.object({ port: z.number().optional(), protocol: z.string().optional() });
const Rule = z.object({ to: z.array(Peer).optional(), from: z.array(Peer).optional(), ports: z.array(PolicyPort).optional() });
const NetworkPolicy = z.object({
  metadata: Metadata,
  spec: z.object({ podSelector: Selector, policyTypes: z.array(z.string()), ingress: z.array(Rule).optional(), egress: z.array(Rule).optional() }),
});
type NetworkPolicy = z.infer<typeof NetworkPolicy>;

const PolicyRule = z.object({ apiGroups: z.array(z.string()), resources: z.array(z.string()), verbs: z.array(z.string()) });
const Role = z.object({ metadata: Metadata, rules: z.array(PolicyRule) });
const RoleBinding = z.object({
  metadata: Metadata,
  roleRef: z.object({ kind: z.string(), name: z.string() }),
  subjects: z.array(z.object({ kind: z.string(), name: z.string() })),
});

const Kustomization = z.object({
  namespace: z.string(),
  resources: z.array(z.string()),
  configMapGenerator: z.array(z.object({ name: z.string(), literals: z.array(z.string()).optional(), files: z.array(z.string()).optional() })),
  replacements: z.array(
    z.object({
      source: z.object({ kind: z.string(), name: z.string(), fieldPath: z.string() }),
      targets: z.array(z.object({ select: z.object({ kind: z.string(), name: z.string() }), fieldPaths: z.array(z.string()) })),
    }),
  ),
});

const PolicyDocument = z.object({
  Statement: z.array(z.object({ Effect: z.string(), Action: z.array(z.string()), Resource: z.array(z.string()) })),
});

/** Every document of every manifest under the base, with the file it came from. */
const loadManifests = async (): Promise<Array<{ file: string; manifest: Manifest }>> => {
  const files = (await readdir(BASE)).filter((file) => file.endsWith(".yaml") && file !== "kustomization.yaml");
  const out: Array<{ file: string; manifest: Manifest }> = [];
  for (const file of files) {
    for (const doc of parseAllDocuments(await readFile(join(BASE, file), "utf8"))) {
      if (doc.errors.length > 0) throw new Error(`${file}: ${doc.errors.map((error) => error.message).join("; ")}`);
      const value: unknown = doc.toJS();
      if (value !== null) out.push({ file, manifest: Manifest.parse(value) });
    }
  }
  return out;
};

let manifests: Array<{ file: string; manifest: Manifest }>;
let kustomization: z.infer<typeof Kustomization>;

const find = (kind: string, name: string): Manifest => {
  const found = manifests.find(({ manifest }) => manifest.kind === kind && manifest.metadata.name === name)?.manifest;
  if (found === undefined) throw new Error(`no ${kind} ${name} in ${BASE}`);
  return found;
};
const ofKind = (kind: string): Manifest[] => manifests.filter(({ manifest }) => manifest.kind === kind).map(({ manifest }) => manifest);
const policies = (): NetworkPolicy[] => ofKind("NetworkPolicy").map((policy) => NetworkPolicy.parse(policy));
const policy = (name: string): NetworkPolicy => NetworkPolicy.parse(find("NetworkPolicy", name));

/** Does the selector pick run pods, which carry the run-id label (the doctor's probe pod too)? */
const selectsRunPods = (selector: z.infer<typeof Selector>): boolean =>
  selector.matchExpressions?.some((expression) => expression.key === RUN_LABELS.runId && expression.operator === "Exists") ?? false;

const container = (spec: z.infer<typeof PodSpec>, name: string): z.infer<typeof Container> => {
  const found = [...spec.containers, ...spec.initContainers].find((candidate) => candidate.name === name);
  if (found === undefined) throw new Error(`no container ${name}`);
  return found;
};

beforeAll(async () => {
  manifests = await loadManifests();
  kustomization = Kustomization.parse(parseAllDocuments(await readFile(join(BASE, "kustomization.yaml"), "utf8"))[0]?.toJS());
});

describe("deploy/k8s/base", () => {
  it("lists every manifest in the kustomization, all in the ticket-steward namespace", async () => {
    const files = (await readdir(BASE)).filter((file) => file.endsWith(".yaml") && file !== "kustomization.yaml");
    expect([...kustomization.resources].sort()).toEqual(files.sort());
    expect(kustomization.namespace).toBe("ticket-steward");
    const namespace = find("Namespace", "ticket-steward");
    expect(namespace.apiVersion).toBe("v1");
  });

  it("runs the dispatcher as one replica, recreated rather than rolled, on a 20 Gi Ceph RBD volume", () => {
    const deployment = Workload.parse(find("Deployment", "steward"));
    expect(deployment.spec.replicas).toBe(1);
    expect(deployment.spec.strategy?.type).toBe("Recreate");
    const pod = deployment.spec.template.spec;
    expect(pod.serviceAccountName).toBe("steward-dispatcher");

    const claim = Claim.parse(find("PersistentVolumeClaim", "steward-data"));
    expect(claim.spec).toEqual({ accessModes: ["ReadWriteOnce"], storageClassName: "ceph-rbd", resources: { requests: { storage: "20Gi" } } });
    expect(pod.volumes).toContainEqual({ name: "data", persistentVolumeClaim: { claimName: "steward-data" } });

    const steward = container(pod, "steward");
    expect(steward.volumeMounts).toContainEqual({ name: "data", mountPath: "/var/lib/ticket-steward" });
    expect(steward.volumeMounts).toContainEqual({ name: "config", mountPath: "/etc/ticket-steward", readOnly: true });
    expect(pod.volumes).toContainEqual({ name: "config", configMap: { name: "steward-config" } });
    // serve writes the admin API's token to the runtime dir; it never reaches the disk.
    expect(steward.volumeMounts).toContainEqual({ name: "runtime", mountPath: "/run/steward" });
    expect(pod.volumes).toContainEqual({ name: "runtime", emptyDir: { medium: "Memory", sizeLimit: "1Mi" } });
    expect(steward.ports.map((port) => port.containerPort).sort()).toEqual([3020, INTERNAL_PORT]);
  });

  it("gives the dispatcher an AWS token and a MinIO token, each for its own audience, at the paths the code reads", () => {
    const pod = Workload.parse(find("Deployment", "steward")).spec.template.spec;
    const steward = container(pod, "steward");
    const env = Object.fromEntries(steward.env.map((variable) => [variable.name, variable]));
    expect(env.AWS_WEB_IDENTITY_TOKEN_FILE?.value).toBe("/var/run/secrets/steward/aws/token");
    expect(env.AWS_ROLE_ARN?.valueFrom?.configMapKeyRef).toEqual({ name: "steward-cluster", key: "awsRoleArn" });
    const projected = (audience: string) => ({ projected: { sources: [{ serviceAccountToken: { audience, expirationSeconds: 3600, path: "token" } }] } });
    expect(pod.volumes).toContainEqual({ name: "aws-token", ...projected("sts.amazonaws.com") });
    expect(pod.volumes).toContainEqual({ name: "minio-token", ...projected("minio") });
    expect(steward.volumeMounts).toContainEqual({ name: "aws-token", mountPath: "/var/run/secrets/steward/aws", readOnly: true });
    expect(steward.volumeMounts).toContainEqual({ name: "minio-token", mountPath: MINIO_TOKEN_FILE.replace(/\/token$/, ""), readOnly: true });
  });

  it("exposes the webhooks on 3020 and the run callbacks on 3021 as separate services", () => {
    const ports = (name: string): unknown => z.object({ spec: z.object({ ports: z.unknown() }) }).parse(find("Service", name)).spec.ports;
    expect(ports("steward")).toEqual([{ name: "http", port: 3020, targetPort: 3020 }]);
    expect(ports("steward-internal")).toEqual([{ name: "internal", port: INTERNAL_PORT, targetPort: INTERNAL_PORT }]);
    expect(ports("minio")).toEqual([{ name: "s3", port: 9000, targetPort: 9000 }]);
  });

  it("gives the run pods' service account no token", () => {
    const run = find("ServiceAccount", "steward-run");
    expect(run.automountServiceAccountToken).toBe(false);
    // The dispatcher's needs one: it talks to the API server.
    expect(find("ServiceAccount", "steward-dispatcher").automountServiceAccountToken).toBeUndefined();
  });

  it("grants the dispatcher its namespace only: no cluster-scoped role or binding", () => {
    expect(manifests.filter(({ manifest }) => manifest.kind.startsWith("Cluster"))).toEqual([]);
    const role = Role.parse(find("Role", "steward-dispatcher"));
    const verbsOn = (resource: string): string[] => role.rules.filter((rule) => rule.resources.includes(resource)).flatMap((rule) => rule.verbs);
    for (const resource of ["jobs", "configmaps", "pods"]) {
      expect(verbsOn(resource)).toEqual(expect.arrayContaining(["create", "get", "list", "watch", "delete"]));
    }
    for (const resource of ["pods/attach", "pods/exec"]) expect(verbsOn(resource)).toEqual(expect.arrayContaining(["create", "get"]));
    expect(verbsOn("pods/log")).toContain("get");
    expect(verbsOn("networkpolicies").sort()).toEqual(["get", "list"]);
    expect(role.rules.flatMap((rule) => rule.verbs)).not.toContain("*");
    expect(role.rules.flatMap((rule) => rule.resources)).not.toContain("*");

    const binding = RoleBinding.parse(find("RoleBinding", "steward-dispatcher"));
    expect(binding.roleRef).toMatchObject({ kind: "Role", name: "steward-dispatcher" });
    expect(binding.subjects).toEqual([{ kind: "ServiceAccount", name: "steward-dispatcher" }]);
  });

  it("names the NetworkPolicies doctor looks for", () => {
    expect(policies().map((candidate) => candidate.metadata.name).sort()).toEqual([...NETWORK_POLICIES].sort());
    const deny = policy("default-deny");
    expect(deny.spec).toEqual({ podSelector: {}, policyTypes: ["Ingress", "Egress"] });
  });

  it("blocks run pods' egress to the private ranges except the listed allow CIDRs", () => {
    const runPolicies = policies().filter((candidate) => selectsRunPods(candidate.spec.podSelector));
    expect(runPolicies.map((candidate) => candidate.metadata.name).sort()).toEqual(["run-pods", "run-pods-allow-cidrs"]);
    for (const candidate of runPolicies) expect(candidate.spec.ingress ?? []).toEqual([]);

    const blocks = (policy("run-pods").spec.egress ?? []).flatMap((rule) => rule.to ?? []).flatMap((peer) => (peer.ipBlock === undefined ? [] : [peer.ipBlock]));
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.cidr).toBe("0.0.0.0/0");
    expect(blocks[0]?.except).toEqual(expect.arrayContaining(RFC1918));
    // The cluster's service and pod CIDRs, replaced from the steward-cluster ConfigMap; k3s's defaults until then.
    expect(blocks[0]?.except?.slice(3)).toEqual(["10.43.0.0/16", "10.42.0.0/16"]);

    // The allow policy holds only exact ipBlocks, without exceptions: the operator's runtime.egressAllowCidrs.
    const allowed = (policy("run-pods-allow-cidrs").spec.egress ?? []).flatMap((rule) => rule.to ?? []);
    for (const peer of allowed) expect(Object.keys(peer)).toEqual(["ipBlock"]);
  });

  it("lets run pods reach DNS, MinIO's S3 port and the dispatcher's callback port, nothing else in the cluster", () => {
    const rules = (policy("run-pods").spec.egress ?? []).filter((rule) => rule.to?.some((peer) => peer.ipBlock === undefined));
    expect(rules).toEqual([
      {
        to: [{ namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": "kube-system" } }, podSelector: { matchLabels: { "k8s-app": "kube-dns" } } }],
        ports: [{ protocol: "UDP", port: 53 }, { protocol: "TCP", port: 53 }],
      },
      { to: [{ podSelector: { matchLabels: { app: "minio" } } }], ports: [{ protocol: "TCP", port: 9000 }] },
      { to: [{ podSelector: { matchLabels: { app: "steward" } } }], ports: [{ protocol: "TCP", port: INTERNAL_PORT }] },
    ]);
  });

  it("admits only run pods to the dispatcher's callback port, and anyone to its webhook port", () => {
    const dispatcher = policy("dispatcher");
    expect(dispatcher.spec.podSelector).toEqual({ matchLabels: { app: "steward" } });
    const ingress = dispatcher.spec.ingress ?? [];
    const callback = ingress.filter((rule) => rule.ports?.some((port) => port.port === INTERNAL_PORT));
    expect(callback).toHaveLength(1);
    expect(callback[0]?.from?.every((peer) => peer.podSelector !== undefined && selectsRunPods(peer.podSelector) && peer.namespaceSelector === undefined)).toBe(true);
    expect(callback[0]?.ports).toEqual([{ protocol: "TCP", port: INTERNAL_PORT }]);
    expect(ingress.filter((rule) => rule !== callback[0])).toEqual([{ ports: [{ protocol: "TCP", port: 3020 }] }]);
  });

  it("keeps the API server out of every pod's reach but the dispatcher's", () => {
    for (const candidate of policies().filter((entry) => entry.metadata.name !== "dispatcher")) {
      for (const rule of candidate.spec.egress ?? []) {
        expect(rule.to, `${candidate.metadata.name} allows egress to everything`).toBeDefined();
        for (const peer of rule.to ?? []) {
          if (peer.ipBlock !== undefined && candidate.metadata.name !== "run-pods-allow-cidrs") expect(peer.ipBlock.except).toEqual(expect.arrayContaining(RFC1918));
        }
      }
    }
  });

  it("replaces the service and pod CIDRs from the steward-cluster ConfigMap", () => {
    const literals = kustomization.configMapGenerator.find((generator) => generator.name === "steward-cluster")?.literals ?? [];
    const keys = literals.map((literal) => literal.split("=", 1)[0]);
    expect(keys).toEqual(expect.arrayContaining(["issuer", "awsRoleArn", "awsRegion", "serviceCidr", "podCidr"]));
    const targets = (key: string) =>
      kustomization.replacements.filter((replacement) => replacement.source.name === "steward-cluster" && replacement.source.fieldPath === `data.${key}`).flatMap((replacement) => replacement.targets);
    expect(targets("serviceCidr")).toEqual([
      { select: { kind: "NetworkPolicy", name: "run-pods" }, fieldPaths: ["spec.egress.3.to.0.ipBlock.except.3"] },
      { select: { kind: "NetworkPolicy", name: "minio" }, fieldPaths: ["spec.egress.1.to.0.ipBlock.except.3"] },
    ]);
    expect(targets("podCidr")).toEqual([
      { select: { kind: "NetworkPolicy", name: "run-pods" }, fieldPaths: ["spec.egress.3.to.0.ipBlock.except.4"] },
      { select: { kind: "NetworkPolicy", name: "minio" }, fieldPaths: ["spec.egress.1.to.0.ipBlock.except.4"] },
    ]);
    // The paths point where the test above found the placeholders.
    const minioBlock = policy("minio").spec.egress?.[1]?.to?.[0]?.ipBlock;
    expect(minioBlock?.except?.slice(3)).toEqual(["10.43.0.0/16", "10.42.0.0/16"]);
    expect(policy("run-pods").spec.egress?.[3]?.to?.[0]?.ipBlock?.except?.slice(3)).toEqual(["10.43.0.0/16", "10.42.0.0/16"]);
  });

  it("runs MinIO on a 50 Gi Ceph RBD volume, signing in pods with the k3s issuer under the steward-sessions policy", async () => {
    const minio = Workload.parse(find("StatefulSet", "minio"));
    expect(minio.spec.replicas).toBe(1);
    expect(minio.spec.template.spec.automountServiceAccountToken).toBe(false);
    expect(minio.spec.volumeClaimTemplates).toEqual([
      { metadata: { name: "data" }, spec: { accessModes: ["ReadWriteOnce"], storageClassName: "ceph-rbd", resources: { requests: { storage: "50Gi" } } } },
    ]);
    const env = Object.fromEntries(container(minio.spec.template.spec, "minio").env.map((variable) => [variable.name, variable]));
    expect(env.K3S_ISSUER?.valueFrom?.configMapKeyRef).toEqual({ name: "steward-cluster", key: "issuer" });
    expect(env.MINIO_IDENTITY_OPENID_CONFIG_URL?.value).toBe("$(K3S_ISSUER)/.well-known/openid-configuration");
    expect(env.MINIO_IDENTITY_OPENID_CLIENT_ID?.value).toBe("minio");
    expect(env.MINIO_IDENTITY_OPENID_ROLE_POLICY?.value).toBe(SESSIONS_BUCKET);
    // No root credential in the manifests: the image makes a new one on each start and keeps it in memory.
    expect(Object.keys(env).filter((name) => name.startsWith("MINIO_ROOT"))).toEqual([]);

    const policyFile = kustomization.configMapGenerator.find((generator) => generator.name === "minio-policy")?.files ?? [];
    expect(policyFile).toEqual(["policy.json=minio-policy.json"]);
    const document = PolicyDocument.parse(JSON.parse(await readFile(join(BASE, "minio-policy.json"), "utf8")));
    for (const statement of document.Statement) {
      expect(statement.Effect).toBe("Allow");
      for (const resource of statement.Resource) expect(resource === `arn:aws:s3:::${SESSIONS_BUCKET}` || resource.startsWith(`arn:aws:s3:::${SESSIONS_BUCKET}/`)).toBe(true);
      for (const action of statement.Action) expect(["s3:ListBucket", "s3:GetObject", "s3:PutObject"]).toContain(action);
    }
  });
});
