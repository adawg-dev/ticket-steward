import type { V1Container, V1Job, V1Volume } from "@kubernetes/client-node";
import { describe, expect, it } from "vitest";
import { StewardConfigSchema } from "../../src/config/schema.js";
import { AWS_AUDIENCE, buildRunJob, jobNameOf, MINIO_AUDIENCE, RUN_LABELS } from "../../src/k8s/runJob.js";
import type { RunSpec } from "../../src/run/protocol.js";
import { podSpecFor, RUNTIME, TOKENS } from "./helpers.js";

const build = (patch: Partial<RunSpec> = {}): V1Job => buildRunJob(podSpecFor(patch), { runtime: RUNTIME, tokens: TOKENS, specConfigMap: "run-7-1" });

const allContainers = (job: V1Job): V1Container[] => [...(job.spec?.template.spec?.initContainers ?? []), ...(job.spec?.template.spec?.containers ?? [])];
const named = (job: V1Job, name: string): V1Container => {
  const container = allContainers(job).find((candidate) => candidate.name === name);
  if (container === undefined) throw new Error(`no container ${name}`);
  return container;
};
const volumes = (job: V1Job): V1Volume[] => job.spec?.template.spec?.volumes ?? [];
const projectedNames = (job: V1Job): string[] => volumes(job).filter((volume) => volume.projected !== undefined).map((volume) => volume.name);
const audienceOf = (job: V1Job, container: V1Container): string[] =>
  (container.volumeMounts ?? []).flatMap((mount) => {
    const volume = volumes(job).find((candidate) => candidate.name === mount.name);
    return (volume?.projected?.sources ?? []).flatMap((source) => (source.serviceAccountToken?.audience === undefined ? [] : [source.serviceAccountToken.audience]));
  });

describe("buildRunJob", () => {
  it("labels the Job and its pod with the run, the job and the ticket, and bounds it", () => {
    const job = build();
    expect(job.metadata?.name).toBe(jobNameOf("7-1"));
    const labels = { [RUN_LABELS.runId]: "7-1", [RUN_LABELS.jobId]: "7", [RUN_LABELS.ticket]: "API-1" };
    expect(job.metadata?.labels).toMatchObject(labels);
    expect(job.spec?.template.metadata?.labels).toMatchObject(labels);
    expect(job.spec?.backoffLimit).toBe(0);
    expect(job.spec?.ttlSecondsAfterFinished).toBe(3600);
    // The run's limits plus 15 minutes for the pod's start and the report.
    expect(job.spec?.activeDeadlineSeconds).toBe((60 + 15 + 15) * 60);
    expect(job.spec?.template.spec?.automountServiceAccountToken).toBe(false);
    expect(job.spec?.template.spec?.restartPolicy).toBe("Never");
  });

  it("gives the agent container no token: no projected volume, no envFrom, no tools token, only the runner token", () => {
    const job = build();
    const agent = named(job, "agent");
    const projected = projectedNames(job);
    expect((agent.volumeMounts ?? []).filter((mount) => projected.includes(mount.name))).toEqual([]);
    expect((agent.volumeMounts ?? []).some((mount) => mount.mountPath.startsWith("/var/run/secrets"))).toBe(false);
    expect(agent.envFrom).toBeUndefined();
    const env = agent.env ?? [];
    expect(env.some((variable) => variable.value === TOKENS.tools)).toBe(false);
    expect(env.some((variable) => variable.valueFrom !== undefined)).toBe(false);
    expect(env.filter((variable) => variable.value === TOKENS.runner).map((variable) => variable.name)).toEqual(["STEWARD_RUNNER_TOKEN"]);
    expect(env.some((variable) => /^AWS_/.test(variable.name))).toBe(false);
    expect(agent.resources?.limits).toEqual({ cpu: "4", memory: "8Gi" });
  });

  it("mounts the agent's shared volumes read-only where it must not write: the overlay and egress's CA", () => {
    const agent = named(build(), "agent");
    const mount = (path: string) => (agent.volumeMounts ?? []).find((candidate) => candidate.mountPath === path);
    expect(mount("/run/steward/overlay")?.readOnly).toBe(true);
    expect(mount("/run/egress-ca")?.readOnly).toBe(true);
    expect(mount("/var/lib/ticket-steward/work")?.readOnly).not.toBe(true);
    expect(mount("/var/lib/ticket-steward/sessions")?.readOnly).not.toBe(true);
  });

  it("projects exactly the sts.amazonaws.com and minio audiences, each to the containers that need it", () => {
    const job = build();
    const audiences = volumes(job).flatMap((volume) => (volume.projected?.sources ?? []).flatMap((source) => (source.serviceAccountToken === undefined ? [] : [source.serviceAccountToken])));
    expect(audiences.map((token) => token.audience).sort()).toEqual([AWS_AUDIENCE, MINIO_AUDIENCE].sort());
    expect(audiences.every((token) => token.expirationSeconds === 3600)).toBe(true);
    for (const name of ["git-init", "render-overlay", "keyproxy", "tools"]) expect(audienceOf(job, named(job, name))).toEqual([AWS_AUDIENCE]);
    for (const name of ["sessions-pull", "sessions-sync"]) expect(audienceOf(job, named(job, name))).toEqual([MINIO_AUDIENCE]);
    for (const name of ["agent", "egress", "postgres", "redis", "rabbitmq"]) expect(audienceOf(job, named(job, name))).toEqual([]);
    expect(named(job, "tools").env?.find((variable) => variable.name === "STEWARD_TOOLS_TOKEN")?.value).toBe(TOKENS.tools);
  });

  it("keeps stdin and a TTY for the agent of an interactive run only", () => {
    const plain = build();
    expect(named(plain, "agent").stdin).toBeUndefined();
    const chat = build({ interactive: true });
    expect(named(chat, "agent")).toMatchObject({ stdin: true, tty: true });
    for (const job of [plain, chat]) {
      for (const container of allContainers(job).filter((candidate) => candidate.name !== "agent")) {
        expect(container.stdin, container.name).toBeUndefined();
        expect(container.tty, container.name).toBeUndefined();
      }
    }
  });

  it("runs the sidecars alongside the agent, so the pod ends when the agent does, and mounts the spec from its ConfigMap", () => {
    const job = build();
    const pod = job.spec?.template.spec;
    expect(pod?.containers.map((container) => container.name)).toEqual(["agent"]);
    const init = pod?.initContainers ?? [];
    expect(init.filter((container) => container.restartPolicy !== "Always").map((container) => container.name)).toEqual(["git-init", "render-overlay", "sessions-pull"]);
    expect(init.filter((container) => container.restartPolicy === "Always").map((container) => container.name).sort()).toEqual(
      ["egress", "keyproxy", "postgres", "rabbitmq", "redis", "sessions-sync", "tools"],
    );
    expect(volumes(job).find((volume) => volume.name === "spec")?.configMap?.name).toBe("run-7-1");
    // Private volumes stay private.
    for (const [volume, owners] of [["rules", ["egress", "render-overlay"]], ["guard", ["render-overlay", "tools"]], ["egress-confdir", ["egress"]]] as const) {
      expect(allContainers(job).filter((container) => (container.volumeMounts ?? []).some((mount) => mount.name === volume)).map((container) => container.name).sort()).toEqual([...owners]);
    }
  });
});

describe("the runtime config", () => {
  const base = {
    dataDir: "/var/lib/ticket-steward",
    brain: { kind: "claude-code", model: "claude-test", maxTurns: 5, timeoutMinutes: 1 },
    tracker: { kind: "linear", labels: {} },
    codehost: { kind: "gitlab", baseUrl: "https://gitlab.example", project: "acme/repo" },
    workspace: { fetchUrl: "https://gitlab.example/acme/repo.git", baseBranch: "dev", overlayDir: "/x", overlayTemplateDir: "/t", setup: [] },
    server: { port: 3020, publicUrl: "https://steward.example" },
    implement: { prompt: "p.md", commitAuthor: { name: "Steward", email: "steward@example.com" } },
  };
  const kubernetes = {
    namespace: RUNTIME.namespace,
    images: RUNTIME.images,
    maxConcurrent: RUNTIME.maxConcurrent,
    callbackUrl: RUNTIME.callbackUrl,
    minio: RUNTIME.minio,
    aws: RUNTIME.aws,
    resources: RUNTIME.resources,
  };
  const secrets = { source: "aws", region: "us-west-2", map: { GITLAB_TOKEN: "DEV_STEWARD_GITLAB_TOKEN" } };

  it("is local when unset and needs no workspace.port on kubernetes", () => {
    expect(StewardConfigSchema.safeParse({ ...base, workspace: { ...base.workspace, port: 3000 } }).success).toBe(true);
    const parsed = StewardConfigSchema.parse({ ...base, secrets, runtime: { kind: "kubernetes", ...kubernetes } });
    expect(parsed.runtime).toMatchObject({ kind: "kubernetes", serviceAccount: "steward-run", config: { configMap: "steward-config" } });
  });

  it("refuses the openai-agents brain on kubernetes", () => {
    const result = StewardConfigSchema.safeParse({ ...base, brain: { ...base.brain, kind: "openai-agents" }, secrets, runtime: { kind: "kubernetes", ...kubernetes } });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain('requires brain.kind \\"claude-code\\"');
  });

  it("refuses a config-dir .env on kubernetes, since run pods mount the config dir", () => {
    for (const patch of [{}, { secrets: { source: "file" } }]) {
      const result = StewardConfigSchema.safeParse({ ...base, ...patch, runtime: { kind: "kubernetes", ...kubernetes } });
      expect(result.success).toBe(false);
      expect(JSON.stringify(result.error?.issues)).toContain('requires secrets.source \\"aws\\"');
    }
  });
});
