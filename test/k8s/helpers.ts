import type { KubernetesRuntime } from "../../src/config/schema.js";
import type { RunSpec } from "../../src/run/protocol.js";

const SHA = "a".repeat(40);
export const TOKENS = { runner: "runner-token-value", tools: "tools-token-value" };

export const RUNTIME: KubernetesRuntime = {
  kind: "kubernetes",
  namespace: "ticket-steward",
  images: { steward: "steward:1", agent: "agent:1", egress: "egress:1", postgres: "timescale:1", redis: "redis:7", rabbitmq: "rabbitmq:3" },
  maxConcurrent: 2,
  callbackUrl: "http://steward-internal.ticket-steward.svc:3021",
  minio: { endpoint: "http://minio.ticket-steward.svc:9000", bucket: "steward-sessions" },
  aws: { roleArn: "arn:aws:iam::123456789012:role/steward", region: "us-east-1" },
  resources: { agent: { cpu: "4", memory: "8Gi" } },
  egressAllowCidrs: [],
  serviceAccount: "steward-run",
  config: { configMap: "steward-config", path: "/etc/ticket-steward/steward.config.ts" },
};

export const podSpecFor = (patch: Partial<RunSpec> = {}): RunSpec => ({
  version: 1,
  runId: "7-1",
  jobId: 7,
  kind: "implement",
  identifier: "API-1",
  issueId: "issue-1",
  checkout: { ref: null, sha: SHA },
  baseSha: SHA,
  worktreePath: "/var/lib/ticket-steward/work/ticket-API-1",
  artifactsDir: "/var/lib/ticket-steward/jobs/7/artifacts",
  transcriptPath: "/var/lib/ticket-steward/jobs/7/attempt-1.jsonl",
  prompt: "Implement API-1.",
  personCommits: null,
  output: "implement",
  resumeSessionId: null,
  limits: { timeoutMinutes: 60, maxTurns: 150, setupTimeoutMinutes: 15 },
  push: { jobId: 7, worktreePath: "/var/lib/ticket-steward/work/ticket-API-1", identifier: "API-1", issueId: "issue-1", mode: "create", branch: null, baseSha: SHA, loopId: null, port: 3000 },
  setup: ["pnpm install"],
  checks: [],
  interactive: false,
  ...patch,
});
