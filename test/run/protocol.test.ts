import { RunReportSchema, RunSpecSchema, WorkReportSchema, type RunReport, type RunSpec } from "../../src/run/protocol.js";

const SHA = "a".repeat(40);

const spec: RunSpec = {
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
  prompt: "Implement API-1.\n{{steward:personCommits}}",
  personCommits: { from: SHA, to: "b".repeat(40) },
  output: "implement",
  resumeSessionId: null,
  limits: { timeoutMinutes: 60, maxTurns: 200, setupTimeoutMinutes: 20 },
  push: { jobId: 7, worktreePath: "/var/lib/ticket-steward/work/ticket-API-1", identifier: "API-1", issueId: "issue-1", title: "Adapter drops the last chunk", mode: "create", branch: null, baseSha: SHA, loopId: null, port: 3000 },
  setup: ["pnpm install"],
  checks: ["pnpm test"],
  interactive: false,
};

const report: RunReport = {
  runId: "7-1",
  ok: true,
  error: null,
  interrupted: false,
  setupFailed: false,
  sessionId: "session-1",
  output: { outcome: "implemented", summary: "done" },
  usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.01 },
};

const roundTrip = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

describe("the run protocol", () => {
  it("round-trips a spec, a report and a work report through JSON", () => {
    expect(RunSpecSchema.parse(roundTrip(spec))).toEqual(spec);
    expect(RunReportSchema.parse(roundTrip(report))).toEqual(report);
    expect(RunReportSchema.parse(roundTrip({ ...report, ok: false, error: "interrupted", interrupted: true, sessionId: null, output: null, usage: null }))).toMatchObject({ ok: false, usage: null });
    const work = { runId: "7-1", unpushed: "uncommitted:\n  notes.md", pushedSha: null };
    expect(WorkReportSchema.parse(roundTrip(work))).toEqual(work);
  });

  it("rejects an unknown kind, a newer version and a malformed checkout", () => {
    expect(RunSpecSchema.safeParse({ ...spec, kind: "deploy" }).success).toBe(false);
    expect(RunSpecSchema.safeParse({ ...spec, version: 2 }).success).toBe(false);
    expect(RunSpecSchema.safeParse({ ...spec, checkout: { ref: null, sha: "main" } }).success).toBe(false);
  });
});
