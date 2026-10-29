import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { parseAllDocuments } from "yaml";
import { z } from "zod";
import { NETWORK_POLICIES } from "../../src/cli/doctorKubernetes.js";
import { CONFIG_BUNDLE_DIR, CONFIG_BUNDLE_KEY, configUnpackCommand, RUN_LABELS } from "../../src/k8s/runJob.js";
import { INTERNAL_PORT } from "../../src/server/internal.js";
import { MINIO_TOKEN_FILE, SESSIONS_BUCKET } from "../../src/sessions/store.js";

const CHART = resolve("deploy/helm/ticket-steward");
const VALUES = resolve("deploy/helm/values");
const run = promisify(execFile);
const RFC1918 = ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"];

const Metadata = z.object({
  name: z.string(),
  namespace: z.string().optional(),
  labels: z.record(z.string(), z.string()).optional(),
  annotations: z.record(z.string(), z.string()).optional(),
});
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

const PolicyDocument = z.object({
  Statement: z.array(z.object({ Effect: z.string(), Action: z.array(z.string()), Resource: z.array(z.string()) })),
});

type Rendered = Manifest[];

/** `helm template` of the chart in the ticket-steward namespace with these helm args. */
const render = async (args: string[]): Promise<Rendered> => {
  const { stdout } = await run("helm", ["template", "ticket-steward", CHART, "--namespace", "ticket-steward", ...args], { maxBuffer: 16 * 1024 * 1024 }).catch((err: unknown) => {
    if (err instanceof Error && "code" in err && err.code === "ENOENT") throw new Error("these tests render the chart with helm 3: install it (docs/ops.md, \"Running on Kubernetes\")", { cause: err });
    throw err;
  });
  const out: Rendered = [];
  for (const doc of parseAllDocuments(stdout)) {
    if (doc.errors.length > 0) throw new Error(doc.errors.map((error) => error.message).join("; "));
    const value: unknown = doc.toJS();
    if (value !== null) out.push(Manifest.parse(value));
  }
  return out;
};

/** Renders with these values on top of the k3s values file. */
const renderWith = (values: string[]): Promise<Rendered> => render(["-f", join(VALUES, "k3s.yaml"), ...values.flatMap((value) => ["--set", value])]);

let manifests: Rendered;

const findIn = (rendered: Rendered, kind: string, name: string): Manifest => {
  const found = rendered.find((manifest) => manifest.kind === kind && manifest.metadata.name === name);
  if (found === undefined) throw new Error(`no ${kind} ${name} in the chart`);
  return found;
};
const find = (kind: string, name: string): Manifest => findIn(manifests, kind, name);
const ofKind = (kind: string): Manifest[] => manifests.filter((manifest) => manifest.kind === kind);
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
  manifests = await render(["-f", join(VALUES, "k3s.yaml")]);
});

describe("deploy/helm/ticket-steward", () => {
  it("renders into the release namespace, creating no namespace and no object outside it", () => {
    expect(ofKind("Namespace")).toEqual([]);
    for (const manifest of manifests) expect(manifest.metadata.namespace, `${manifest.kind} ${manifest.metadata.name}`).toBeUndefined();
  });

  it("refuses to render without the issuer, the dispatcher's role and the region", async () => {
    await expect(render([])).rejects.toThrow("cluster.issuer is required");
    await expect(render(["--set", "cluster.issuer=https://oidc.example.com"])).rejects.toThrow("aws.roleArn is required");
    await expect(render(["--set", "cluster.issuer=https://oidc.example.com", "--set", "aws.roleArn=arn:aws:iam::1:role/x"])).rejects.toThrow("aws.region is required");
  });

  it("renders every values file in deploy/helm/values", async () => {
    const files = (await readdir(VALUES)).filter((file) => file.endsWith(".yaml"));
    expect(files.sort()).toEqual(["k3s.yaml", "minikube.yaml"]);
    for (const file of files) expect((await render(["-f", join(VALUES, file)])).length).toBeGreaterThan(0);
  });

  it("runs the dispatcher as one replica, recreated rather than rolled, on a 20 Gi volume kept on uninstall", () => {
    const deployment = Workload.parse(find("Deployment", "steward"));
    expect(deployment.spec.replicas).toBe(1);
    expect(deployment.spec.strategy?.type).toBe("Recreate");
    const pod = deployment.spec.template.spec;
    expect(pod.serviceAccountName).toBe("steward-dispatcher");

    const claim = Claim.parse(find("PersistentVolumeClaim", "steward-data"));
    expect(claim.spec).toEqual({ accessModes: ["ReadWriteOnce"], storageClassName: "ceph-rbd", resources: { requests: { storage: "20Gi" } } });
    expect(find("PersistentVolumeClaim", "steward-data").metadata).toMatchObject({ annotations: { "helm.sh/resource-policy": "keep" } });
    expect(pod.volumes).toContainEqual({ name: "data", persistentVolumeClaim: { claimName: "steward-data" } });

    const steward = container(pod, "steward");
    expect(steward.volumeMounts).toContainEqual({ name: "data", mountPath: "/var/lib/ticket-steward" });
    expect(steward.volumeMounts).toContainEqual({ name: "config", mountPath: "/etc/ticket-steward", readOnly: true });
    // serve writes the admin API's token to the runtime dir; it never reaches the disk.
    expect(steward.volumeMounts).toContainEqual({ name: "runtime", mountPath: "/run/steward" });
    expect(pod.volumes).toContainEqual({ name: "runtime", emptyDir: { medium: "Memory", sizeLimit: "1Mi" } });
    expect(steward.ports.map((port) => port.containerPort).sort()).toEqual([3020, INTERNAL_PORT]);
  });

  it("unpacks the config dir from the steward-config bundle as run pods do, into a dir the steward mounts read-only", () => {
    const pod = Workload.parse(find("Deployment", "steward")).spec.template.spec;
    const unpack = container(pod, "config-unpack");
    expect(unpack.command).toEqual(configUnpackCommand({ bundle: `${CONFIG_BUNDLE_DIR}/${CONFIG_BUNDLE_KEY}`, configDir: "/etc/ticket-steward" }));
    expect(unpack.volumeMounts).toEqual([
      { name: "config-bundle", mountPath: CONFIG_BUNDLE_DIR, readOnly: true },
      { name: "config", mountPath: "/etc/ticket-steward" },
    ]);
    expect(unpack.securityContext).toMatchObject({ runAsUser: 1001, runAsNonRoot: true });
    expect(pod.volumes).toContainEqual({ name: "config-bundle", configMap: { name: "steward-config", items: [{ key: CONFIG_BUNDLE_KEY, path: CONFIG_BUNDLE_KEY }] } });
    expect(pod.volumes).toContainEqual({ name: "config", emptyDir: { sizeLimit: "64Mi" } });
    expect(container(pod, "steward").volumeMounts.filter((mount) => mount.name === "config-bundle")).toEqual([]);
  });

  it("restores a config dir's nested files from a bundle made as deploy/helm/install.sh makes it", async () => {
    const install = await readFile(resolve("deploy/helm/install.sh"), "utf8");
    expect(install).toContain('tar -czf "$bundle" -C "$config_dir" .');

    const dir = await mkdtemp(join(tmpdir(), "steward-config-bundle-"));
    try {
      const files: Record<string, string> = {
        "steward.config.ts": "export default {};\n",
        "prompts/implement.md": "Implement it.\n",
        "overlay-template/apps/web/.env": "API_KEY={{DEV_WEB_API_KEY}}\n",
        "overlay-template/apps/api/config/local.json": "{}\n",
      };
      const source = join(dir, "source");
      for (const [name, text] of Object.entries(files)) {
        await mkdir(dirname(join(source, name)), { recursive: true });
        await writeFile(join(source, name), text);
      }
      const bundle = join(dir, "steward-config.tgz");
      await run("tar", ["-czf", bundle, "-C", source, "."]);
      const unpacked = join(dir, "unpacked");
      await mkdir(unpacked);

      const [command = "", ...args] = configUnpackCommand({ bundle, configDir: unpacked });
      await run(command, args);

      const tree = (await readdir(unpacked, { recursive: true, withFileTypes: true })).filter((entry) => entry.isFile()).map((entry) => join(entry.parentPath, entry.name).slice(unpacked.length + 1));
      expect(tree.sort()).toEqual(Object.keys(files).sort());
      for (const [name, text] of Object.entries(files)) expect(await readFile(join(unpacked, name), "utf8")).toBe(text);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
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
    expect(manifests.filter((manifest) => manifest.kind.startsWith("Cluster"))).toEqual([]);
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

  it("keeps the cluster's service and pod CIDRs from the values out of run pods' and MinIO's reach", async () => {
    const rendered = await renderWith(["cluster.serviceCidr=10.96.0.0/12", "cluster.podCidr=10.244.0.0/16"]);
    const except = (name: string): string[] =>
      (NetworkPolicy.parse(findIn(rendered, "NetworkPolicy", name)).spec.egress ?? []).flatMap((rule) => rule.to ?? []).flatMap((peer) => peer.ipBlock?.except ?? []);
    for (const name of ["run-pods", "minio"]) expect(except(name)).toEqual([...RFC1918, "10.96.0.0/12", "10.244.0.0/16"]);
    const cluster = z.object({ data: z.record(z.string(), z.string()) }).parse(findIn(rendered, "ConfigMap", "steward-cluster"));
    expect(Object.keys(cluster.data).sort()).toEqual(["awsRegion", "awsRoleArn", "issuer"]);
  });

  it("lets run pods reach the private ranges of runPods.allowCidrs and nothing more", async () => {
    const rendered = await renderWith(["runPods.allowCidrs={192.168.10.5/32,10.1.2.0/24}"]);
    const allow = NetworkPolicy.parse(findIn(rendered, "NetworkPolicy", "run-pods-allow-cidrs"));
    expect(selectsRunPods(allow.spec.podSelector)).toBe(true);
    expect(allow.spec.egress).toEqual([{ to: [{ ipBlock: { cidr: "192.168.10.5/32" } }, { ipBlock: { cidr: "10.1.2.0/24" } }] }]);
    expect(policy("run-pods-allow-cidrs").spec.egress).toEqual([]);
  });

  it("trims a trailing slash from the issuer", async () => {
    const rendered = await renderWith(["cluster.issuer=https://oidc.example.com/"]);
    expect(z.object({ data: z.object({ issuer: z.string() }) }).parse(findIn(rendered, "ConfigMap", "steward-cluster")).data.issuer).toBe("https://oidc.example.com");
  });

  it("leaves the storage class to the cluster's default when none is named", async () => {
    const rendered = await renderWith(["storage.className="]);
    const claim = z.object({ spec: z.record(z.string(), z.unknown()) }).parse(findIn(rendered, "PersistentVolumeClaim", "steward-data"));
    expect(Object.keys(claim.spec)).not.toContain("storageClassName");
    const minio = Workload.parse(findIn(rendered, "StatefulSet", "minio"));
    expect(JSON.stringify(minio.spec.volumeClaimTemplates)).not.toContain("storageClassName");
  });

  it("bundles the config dir as binary config.tgz, and a new bundle restarts the dispatcher", async () => {
    expect(manifests.filter((manifest) => manifest.kind === "ConfigMap" && manifest.metadata.name === "steward-config")).toEqual([]);
    const checksum = async (bundle: string): Promise<string | undefined> => {
      const rendered = await renderWith([`config.bundle=${bundle}`]);
      const config = z.object({ binaryData: z.record(z.string(), z.string()) }).parse(findIn(rendered, "ConfigMap", "steward-config"));
      expect(config.binaryData).toEqual({ [CONFIG_BUNDLE_KEY]: bundle });
      const template = z.object({ spec: z.object({ template: z.object({ metadata: Metadata.omit({ name: true }) }) }) }).parse(findIn(rendered, "Deployment", "steward"));
      return template.spec.template.metadata.annotations?.["steward/config-checksum"];
    };
    const first = await checksum("H4sIAAAAAAAAA0tMSgYAAP//");
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(await checksum("H4sIAAAAAAAAA0vKz8sBAP//")).not.toBe(first);
  });

  it("serves the webhooks through the ingress, or on a fixed node port", async () => {
    const ingress = z.object({ spec: z.unknown() }).parse(find("Ingress", "steward")).spec;
    expect(ingress).toEqual({
      ingressClassName: "traefik",
      tls: [{ hosts: ["steward.example.com"], secretName: "steward-tls" }],
      rules: [{ host: "steward.example.com", http: { paths: [{ path: "/", pathType: "Prefix", backend: { service: { name: "steward", port: { number: 3020 } } } }] } }],
    });
    const local = await render(["-f", join(VALUES, "minikube.yaml")]);
    expect(local.filter((manifest) => manifest.kind === "Ingress")).toEqual([]);
    expect(z.object({ spec: z.unknown() }).parse(findIn(local, "Service", "steward")).spec).toEqual({
      type: "NodePort",
      selector: { app: "steward" },
      ports: [{ name: "http", port: 3020, targetPort: 3020, nodePort: 30320 }],
    });
  });

  it("runs MinIO on a 50 Gi volume, signing in pods with the cluster's issuer under the steward-sessions policy", async () => {
    const minio = Workload.parse(find("StatefulSet", "minio"));
    expect(minio.spec.replicas).toBe(1);
    expect(minio.spec.template.spec.automountServiceAccountToken).toBe(false);
    expect(minio.spec.volumeClaimTemplates).toEqual([
      { metadata: { name: "data" }, spec: { accessModes: ["ReadWriteOnce"], storageClassName: "ceph-rbd", resources: { requests: { storage: "50Gi" } } } },
    ]);
    const env = Object.fromEntries(container(minio.spec.template.spec, "minio").env.map((variable) => [variable.name, variable]));
    expect(env.CLUSTER_ISSUER?.valueFrom?.configMapKeyRef).toEqual({ name: "steward-cluster", key: "issuer" });
    expect(env.MINIO_IDENTITY_OPENID_CONFIG_URL?.value).toBe("$(CLUSTER_ISSUER)/.well-known/openid-configuration");
    expect(env.MINIO_IDENTITY_OPENID_CLIENT_ID?.value).toBe("minio");
    expect(env.MINIO_IDENTITY_OPENID_ROLE_POLICY?.value).toBe(SESSIONS_BUCKET);
    // No root credential in the manifests: the image makes a new one on each start and keeps it in memory.
    expect(Object.keys(env).filter((name) => name.startsWith("MINIO_ROOT"))).toEqual([]);

    const policyMap = z.object({ data: z.object({ "policy.json": z.string() }) }).parse(find("ConfigMap", "minio-policy"));
    expect(policyMap.data["policy.json"].trim()).toBe((await readFile(join(CHART, "files", "minio-policy.json"), "utf8")).trim());
    const document = PolicyDocument.parse(JSON.parse(policyMap.data["policy.json"]));
    for (const statement of document.Statement) {
      expect(statement.Effect).toBe("Allow");
      for (const resource of statement.Resource) expect(resource === `arn:aws:s3:::${SESSIONS_BUCKET}` || resource.startsWith(`arn:aws:s3:::${SESSIONS_BUCKET}/`)).toBe(true);
      for (const action of statement.Action) expect(["s3:ListBucket", "s3:GetObject", "s3:PutObject"]).toContain(action);
    }
  });
});
