import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { V1NetworkPolicyList, V1Pod } from "@kubernetes/client-node";
import type { Check } from "../../src/cli/check.js";
import {
  kubernetesChecks,
  NETWORK_POLICIES,
  type DoctorCluster,
  type KubernetesDoctorDeps,
} from "../../src/cli/doctorKubernetes.js";
import type { LoadedConfig } from "../../src/config/load.js";
import { StewardConfigSchema } from "../../src/config/schema.js";
import type { SecretFetcher } from "../../src/config/secretSource.js";
import { RUN_LABELS } from "../../src/k8s/runJob.js";
import { MemoryObjectStore } from "../fakes/fakeMinio.js";
import { RUNTIME } from "../k8s/helpers.js";

const ISSUER = "https://issuer.example.com/k3s";
const DISCOVERY_URL = `${ISSUER}/.well-known/openid-configuration`;
const JWKS_URL = `${ISSUER}/openid/v1/jwks`;
const SECRET_VALUE = "sk_test_real_value";

let dir: string;
let tokenFile: string;
let templateDir: string;

/** A service-account token as the kubelet projects it; only the payload is read, the signature is not checked here. */
const jwt = (payload: Record<string, unknown>): string =>
  [{ alg: "RS256" }, payload, "signature"].map((part) => Buffer.from(typeof part === "string" ? part : JSON.stringify(part)).toString("base64url")).join(".");

const loaded = (): LoadedConfig => {
  const config = StewardConfigSchema.parse({
    dataDir: join(dir, "data"),
    brain: { kind: "claude-code", model: "claude-test", maxTurns: 5, timeoutMinutes: 1 },
    tracker: { kind: "linear" },
    codehost: { kind: "gitlab", baseUrl: "https://gitlab.example", project: "acme/repo" },
    workspace: { fetchUrl: "https://gitlab.example/acme/repo.git", baseBranch: "main", overlayDir: join(dir, "overlay"), overlayTemplateDir: templateDir, setup: [] },
    server: { port: 3020, publicUrl: "https://steward.example" },
    implement: { prompt: "implement.md", commitAuthor: { name: "Steward", email: "steward@example.com" } },
    secrets: { source: "aws", region: "eu-west-2", map: { GITLAB_TOKEN: "DEV_STEWARD_GITLAB_TOKEN", LINEAR_CLIENT_SECRET: "DEV_STEWARD_LINEAR_CLIENT_SECRET" } },
    runtime: RUNTIME,
  });
  return { config, secrets: {}, configPath: join(dir, "steward.config.ts"), configDir: dir };
};

/** Answers the issuer's discovery document and JWKS. */
const issuerFetch = (overrides: { discovery?: () => Response; jwks?: () => Response } = {}, seen: string[] = []): typeof fetch =>
  async (input) => {
    const url = input instanceof Request ? input.url : input.toString();
    seen.push(url);
    if (url === DISCOVERY_URL) return overrides.discovery?.() ?? Response.json({ issuer: ISSUER, jwks_uri: JWKS_URL });
    if (url === JWKS_URL) return overrides.jwks?.() ?? Response.json({ keys: [{ kty: "RSA", kid: "k1" }] });
    return new Response("not found", { status: 404 });
  };

interface FakeCluster extends DoctorCluster {
  created: V1Pod[];
  deleted: string[];
}

/** A cluster whose probe pod ends in `phase` and logs `log`. */
const fakeCluster = (p: { policies?: string[]; phase?: string; log?: string } = {}): FakeCluster => {
  const created: V1Pod[] = [];
  const deleted: string[] = [];
  const list: V1NetworkPolicyList = { items: (p.policies ?? [...NETWORK_POLICIES]).map((name) => ({ metadata: { name } })) };
  return {
    created,
    deleted,
    networking: { listNamespacedNetworkPolicy: async () => list },
    pods: {
      createNamespacedPod: async ({ body }) => {
        created.push(body);
        return body;
      },
      readNamespacedPod: async ({ name }) => ({ metadata: { name }, status: { phase: p.phase ?? "Succeeded" } }),
      readNamespacedPodLog: async () => p.log ?? "probe token: none\nprobe apiserver: unreachable\n",
      deleteNamespacedPod: async ({ name }) => {
        deleted.push(name);
        return {};
      },
    },
  };
};

const fetcherOf = (values: Record<string, string>): SecretFetcher => ({ get: async (id) => values[id] ?? null });

const deps = (patch: Partial<KubernetesDoctorDeps> = {}): KubernetesDoctorDeps => ({
  fetchImpl: issuerFetch(),
  cluster: fakeCluster(),
  assumeWebIdentity: async () => "arn:aws:sts::123456789012:assumed-role/steward/steward-doctor",
  secretFetcher: fetcherOf({ DEV_STEWARD_GITLAB_TOKEN: SECRET_VALUE, DEV_STEWARD_LINEAR_CLIENT_SECRET: SECRET_VALUE, DEV_STRIPE_KEY: '{"STRIPE_KEY":"sk_test_x"}' }),
  minioSignIn: async () => ({ accessKeyId: "AK", secretAccessKey: "SK", sessionToken: "ST" }),
  objectStore: () => new MemoryObjectStore(),
  awsTokenFile: tokenFile,
  minioTokenFile: join(dir, "minio-token"),
  probe: { pollMs: 1, timeoutMs: 1_000 },
  ...patch,
});

const run = async (checks: Check[], name: string) => {
  const check = checks.find((candidate) => candidate.name === name);
  if (check === undefined) throw new Error(`no check named ${name}; have ${checks.map((candidate) => candidate.name).join(", ")}`);
  return check.run();
};

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "steward-doctor-k8s-"));
  tokenFile = join(dir, "aws-token");
  templateDir = join(dir, "overlay-template");
  await writeFile(tokenFile, jwt({ iss: ISSUER, aud: ["sts.amazonaws.com"], sub: "system:serviceaccount:ticket-steward:steward-dispatcher" }));
  await mkdir(join(templateDir, "apps", "api"), { recursive: true });
  await writeFile(join(templateDir, "apps", "api", ".env"), "STRIPE_KEY={{secret:DEV_STRIPE_KEY@api.stripe.com}}\nJWT_SECRET={{local}}\nPORT=3000\n");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("kubernetesChecks", () => {
  it("runs the cluster checks in order, the probe pod last", () => {
    const names = kubernetesChecks(loaded(), RUNTIME, deps(), { probePod: false }).map((check) => check.name);
    expect(names).toEqual(["k3s issuer", "aws role", "dev secrets", "overlay template", "minio sts", "network policies", "probe pod"]);
  });

  describe("k3s issuer", () => {
    it("reads the issuer from the dispatcher's AWS token and fetches its discovery document and JWKS", async () => {
      const seen: string[] = [];
      const result = await run(kubernetesChecks(loaded(), RUNTIME, deps({ fetchImpl: issuerFetch({}, seen) }), { probePod: false }), "k3s issuer");
      expect(result).toEqual({ level: "ok", message: `${ISSUER}: discovery and JWKS (1 key) answer` });
      expect(seen).toEqual([DISCOVERY_URL, JWKS_URL]);
    });

    it("fails when the discovery document does not answer, naming its URL", async () => {
      const fetchImpl = issuerFetch({ discovery: () => new Response("no", { status: 404 }) });
      const result = await run(kubernetesChecks(loaded(), RUNTIME, deps({ fetchImpl }), { probePod: false }), "k3s issuer");
      expect(result).toEqual({ level: "fail", message: `${DISCOVERY_URL} answered 404; AWS and MinIO fetch it to trust the cluster's tokens` });
    });

    it("fails when the discovery document names another issuer, or no keys are published", async () => {
      const other = issuerFetch({ discovery: () => Response.json({ issuer: "https://elsewhere.example", jwks_uri: JWKS_URL }) });
      expect(await run(kubernetesChecks(loaded(), RUNTIME, deps({ fetchImpl: other }), { probePod: false }), "k3s issuer")).toEqual({
        level: "fail",
        message: `${DISCOVERY_URL} names the issuer https://elsewhere.example, not ${ISSUER}`,
      });
      const empty = issuerFetch({ jwks: () => Response.json({ keys: [] }) });
      expect(await run(kubernetesChecks(loaded(), RUNTIME, deps({ fetchImpl: empty }), { probePod: false }), "k3s issuer")).toEqual({
        level: "fail",
        message: `${JWKS_URL} publishes no keys`,
      });
    });

    it("fails on the in-cluster issuer, which AWS cannot reach", async () => {
      await writeFile(tokenFile, jwt({ iss: "https://kubernetes.default.svc.cluster.local" }));
      const result = await run(kubernetesChecks(loaded(), RUNTIME, deps(), { probePod: false }), "k3s issuer");
      expect(result.level).toBe("fail");
      expect(result.message).toBe(
        "the token's issuer is https://kubernetes.default.svc.cluster.local; start k3s with --kube-apiserver-arg=service-account-issuer=<public https url> (docs/ops.md, \"Running on k3s\")",
      );
    });

    it("fails without the dispatcher's AWS token, and never prints a token", async () => {
      const unset = await run(kubernetesChecks(loaded(), RUNTIME, deps({ awsTokenFile: undefined }), { probePod: false }), "k3s issuer");
      expect(unset).toEqual({ level: "fail", message: "AWS_WEB_IDENTITY_TOKEN_FILE is not set; the dispatcher's Deployment projects its AWS token there" });
      await writeFile(tokenFile, "not-a-jwt-but-secret");
      const garbled = await run(kubernetesChecks(loaded(), RUNTIME, deps(), { probePod: false }), "k3s issuer");
      expect(garbled).toEqual({ level: "fail", message: `${tokenFile} does not hold a service-account token` });
    });
  });

  describe("aws role", () => {
    it("assumes the configured role with the dispatcher's token", async () => {
      const calls: Array<{ roleArn: string; region: string; token: string }> = [];
      const result = await run(
        kubernetesChecks(loaded(), RUNTIME, deps({ assumeWebIdentity: async (p) => (calls.push(p), "arn:aws:sts::1:assumed-role/steward/x") }), { probePod: false }),
        "aws role",
      );
      expect(result).toEqual({ level: "ok", message: `${RUNTIME.aws.roleArn} assumed as arn:aws:sts::1:assumed-role/steward/x` });
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({ roleArn: RUNTIME.aws.roleArn, region: RUNTIME.aws.region });
      expect(calls[0]?.token.split(".")).toHaveLength(3);
    });

    it("fails with STS's answer when the trust policy refuses the token", async () => {
      const assumeWebIdentity = async (): Promise<string> => {
        throw new Error("Not authorized to perform sts:AssumeRoleWithWebIdentity");
      };
      const result = await run(kubernetesChecks(loaded(), RUNTIME, deps({ assumeWebIdentity }), { probePod: false }), "aws role");
      expect(result).toEqual({
        level: "fail",
        message: `${RUNTIME.aws.roleArn}: Not authorized to perform sts:AssumeRoleWithWebIdentity; check the role's trust policy (deploy/aws/steward-role.tf.example)`,
      });
    });
  });

  describe("dev secrets", () => {
    it("finds every id the secrets map and the overlay template name, printing ids only", async () => {
      const result = await run(kubernetesChecks(loaded(), RUNTIME, deps(), { probePod: false }), "dev secrets");
      expect(result).toEqual({ level: "ok", message: "3 id(s) present: DEV_STEWARD_GITLAB_TOKEN, DEV_STEWARD_LINEAR_CLIENT_SECRET, DEV_STRIPE_KEY" });
    });

    it("fails naming each missing or empty id, never a value", async () => {
      const secretFetcher = fetcherOf({ DEV_STEWARD_GITLAB_TOKEN: SECRET_VALUE, DEV_STEWARD_LINEAR_CLIENT_SECRET: "" });
      const result = await run(kubernetesChecks(loaded(), RUNTIME, deps({ secretFetcher }), { probePod: false }), "dev secrets");
      expect(result).toEqual({ level: "fail", message: "Secrets Manager: DEV_STEWARD_LINEAR_CLIENT_SECRET is empty; Secrets Manager: DEV_STRIPE_KEY not found" });
      expect(result.message).not.toContain(SECRET_VALUE);
    });
  });

  describe("overlay template", () => {
    it("is ok for secrets, locals and literals", async () => {
      expect(await run(kubernetesChecks(loaded(), RUNTIME, deps(), { probePod: false }), "overlay template")).toEqual({
        level: "ok",
        message: `${templateDir}: 1 file(s), 1 outbound secret(s)`,
      });
    });

    it("reports a signing key, which the egress proxy cannot stand in for", async () => {
      await writeFile(join(templateDir, "apps", "api", ".env"), "AWS_SECRET={{signed:DEV_AWS_SECRET}}\n");
      expect(await run(kubernetesChecks(loaded(), RUNTIME, deps(), { probePod: false }), "overlay template")).toEqual({
        level: "fail",
        message: "apps/api/.env:1: DEV_AWS_SECRET is used to sign requests; the egress proxy cannot stand in for it",
      });
    });

    it("warns about a wildcard host on a multi-tenant domain", async () => {
      await writeFile(join(templateDir, "apps", "api", ".env"), "UPLOAD_KEY={{secret:DEV_UPLOAD_KEY@*.blob.core.windows.net}}\n");
      expect(await run(kubernetesChecks(loaded(), RUNTIME, deps(), { probePod: false }), "overlay template")).toEqual({
        level: "warn",
        message: "apps/api/.env:1: DEV_UPLOAD_KEY goes to *.blob.core.windows.net, a domain anyone can have a subdomain of; name the exact host",
      });
    });
  });

  describe("minio sts", () => {
    it("signs in with the minio-audience token and lists the sessions prefix", async () => {
      const store = new MemoryObjectStore();
      await store.put("sessions/API-1/a.jsonl", new Uint8Array([1]));
      const signIns: Array<{ endpoint: string; tokenFile: string }> = [];
      const result = await run(
        kubernetesChecks(
          loaded(),
          RUNTIME,
          deps({ minioSignIn: async (p) => (signIns.push(p), { accessKeyId: "AK", secretAccessKey: "SK" }), objectStore: () => store }),
          { probePod: false },
        ),
        "minio sts",
      );
      expect(result).toEqual({ level: "ok", message: `signed in at ${RUNTIME.minio.endpoint}; ${RUNTIME.minio.bucket} holds 1 session object(s)` });
      expect(signIns).toEqual([{ endpoint: RUNTIME.minio.endpoint, tokenFile: join(dir, "minio-token") }]);
    });

    it("fails with the sign-in error", async () => {
      const minioSignIn = async (): Promise<never> => {
        throw new Error("MinIO STS: AssumeRoleWithWebIdentity at http://minio:9000 failed: InvalidIdentityToken");
      };
      const result = await run(kubernetesChecks(loaded(), RUNTIME, deps({ minioSignIn }), { probePod: false }), "minio sts");
      expect(result).toEqual({ level: "fail", message: "MinIO STS: AssumeRoleWithWebIdentity at http://minio:9000 failed: InvalidIdentityToken" });
    });
  });

  describe("network policies", () => {
    it("is ok when every policy of deploy/k8s/base is in the namespace", async () => {
      expect(await run(kubernetesChecks(loaded(), RUNTIME, deps(), { probePod: false }), "network policies")).toEqual({
        level: "ok",
        message: `${NETWORK_POLICIES.join(", ")} in ${RUNTIME.namespace}`,
      });
    });

    it("fails naming the missing ones", async () => {
      const cluster = fakeCluster({ policies: ["default-deny", "dispatcher"] });
      expect(await run(kubernetesChecks(loaded(), RUNTIME, deps({ cluster }), { probePod: false }), "network policies")).toEqual({
        level: "fail",
        message: `missing in ${RUNTIME.namespace}: minio, run-pods, run-pods-allow-cidrs; kubectl apply -k deploy/k8s/base`,
      });
    });
  });

  describe("probe pod", () => {
    it("is skipped unless asked for", async () => {
      const cluster = fakeCluster();
      expect(await run(kubernetesChecks(loaded(), RUNTIME, deps({ cluster }), { probePod: false }), "probe pod")).toEqual({
        level: "ok",
        message: "skipped; steward doctor --probe-pod starts one",
      });
      expect(cluster.created).toEqual([]);
    });

    it("starts a run-like pod whose agent container holds no token and cannot reach the API server, then deletes it", async () => {
      const cluster = fakeCluster();
      const result = await run(kubernetesChecks(loaded(), RUNTIME, deps({ cluster }), { probePod: true }), "probe pod");
      expect(result).toEqual({ level: "ok", message: "the agent container has no service-account token and cannot reach the API server" });
      expect(cluster.created).toHaveLength(1);
      const pod = cluster.created[0];
      const name = pod?.metadata?.name ?? "";
      expect(name).toMatch(/^doctor-probe-[0-9a-f]{8}$/);
      expect(pod?.metadata?.namespace).toBe(RUNTIME.namespace);
      // The run-id label puts it under the run pods' NetworkPolicy.
      expect(pod?.metadata?.labels).toEqual({ [RUN_LABELS.runId]: name });
      expect(pod?.spec).toMatchObject({ serviceAccountName: "steward-run", automountServiceAccountToken: false, enableServiceLinks: false, restartPolicy: "Never" });
      expect(pod?.spec?.containers.map((container) => [container.name, container.image])).toEqual([["agent", RUNTIME.images.agent]]);
      expect(pod?.spec?.volumes).toBeUndefined();
      expect(cluster.deleted).toEqual([name]);
    });

    it("fails when the agent container finds a token or reaches the API server", async () => {
      const token = fakeCluster({ log: "probe token: present /var/run/secrets/kubernetes.io/serviceaccount/token\nprobe apiserver: unreachable\n" });
      expect(await run(kubernetesChecks(loaded(), RUNTIME, deps({ cluster: token }), { probePod: true }), "probe pod")).toEqual({
        level: "fail",
        message: "the agent container holds a token: /var/run/secrets/kubernetes.io/serviceaccount/token",
      });
      const reach = fakeCluster({ log: "probe token: none\nprobe apiserver: reachable\n" });
      expect(await run(kubernetesChecks(loaded(), RUNTIME, deps({ cluster: reach }), { probePod: true }), "probe pod")).toEqual({
        level: "fail",
        message: "the agent container reaches the API server; is the run-pods NetworkPolicy applied and enforced?",
      });
      expect(reach.deleted).toHaveLength(1);
    });

    it("fails and still deletes the pod when it does not finish", async () => {
      const cluster = fakeCluster({ phase: "Pending" });
      const result = await run(kubernetesChecks(loaded(), RUNTIME, deps({ cluster, probe: { pollMs: 1, timeoutMs: 20 } }), { probePod: true }), "probe pod");
      expect(result.level).toBe("fail");
      expect(result.message).toMatch(/^doctor-probe-[0-9a-f]{8} did not finish in 0\.02 s \(phase Pending\)$/);
      expect(cluster.deleted).toHaveLength(1);
    });
  });
});
