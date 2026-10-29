import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RunCallbacks } from "../../src/k8s/executor.js";
import type { PushLedger } from "../../src/push/ledger.js";
import type { PushTarget } from "../../src/push/target.js";
import type { RunReport, RunSpec, WorkReport } from "../../src/run/protocol.js";
import { buildInternalServer } from "../../src/server/internal.js";
import { openStores, type Stores } from "../../src/store/index.js";
import { podSpecFor } from "../k8s/helpers.js";

const SHA = "b".repeat(40);

let dataDir: string;
let stores: Stores;
let app: FastifyInstance;
let specs: Map<string, RunSpec>;
let reports: RunReport[];
let works: WorkReport[];
let ledgerCalls: string[];

const ledger: PushLedger = {
  start: (target) => {
    ledgerCalls.push(`start ${target.jobId}`);
    return Promise.resolve({ kind: "create", base: target.baseSha });
  },
  ticket: (target) => {
    ledgerCalls.push(`ticket ${target.issueId}`);
    return Promise.resolve({ title: "Fix the adapter", closed: null });
  },
  record: (target, push) => {
    ledgerCalls.push(`record ${target.jobId} ${push.branch}`);
    return Promise.resolve({ id: stores.pushes.record({ jobId: target.jobId, loopId: null, ...push }) });
  },
  landed: (target, id) => {
    ledgerCalls.push(`landed ${target.jobId} ${id}`);
    return Promise.resolve();
  },
  revert: (target, id) => {
    ledgerCalls.push(`revert ${target.jobId} ${id}`);
    return Promise.resolve();
  },
};

const runs: RunCallbacks = {
  spec: (runId) => specs.get(runId) ?? null,
  deliverReport: (report) => {
    reports.push(report);
    return true;
  },
  deliverWork: (work) => {
    works.push(work);
    return true;
  },
};

const reportFor = (runId: string): RunReport => ({ runId, ok: true, error: null, interrupted: false, setupFailed: false, sessionId: null, output: null, usage: null });

/** A run of a job with a row, as the executor registers it, with both of its tokens. */
const startRun = (identifier: string): { spec: RunSpec; runner: string; tools: string } => {
  const jobId = stores.jobs.enqueue({ kind: "cli", issueId: `issue-${identifier}`, identifier, teamKey: "API" });
  const runId = `${jobId}-1`;
  const push: PushTarget = { jobId, worktreePath: "/w", identifier, issueId: `issue-${identifier}`, mode: "create", branch: null, baseSha: SHA, loopId: null, port: 3000 };
  const spec = podSpecFor({ runId, jobId, identifier, push });
  specs.set(runId, spec);
  return { spec, runner: stores.runTokens.issue(runId, "runner"), tools: stores.runTokens.issue(runId, "tools") };
};

const post = (url: string, token: string | null, payload?: unknown) =>
  app.inject({ method: "POST", url, ...(token === null ? {} : { headers: { authorization: `Bearer ${token}` } }), ...(payload === undefined ? {} : { payload: payload as object }) });

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "steward-internal-"));
  stores = openStores(dataDir);
  specs = new Map();
  reports = [];
  works = [];
  ledgerCalls = [];
  app = buildInternalServer({
    runs,
    tokens: stores.runTokens,
    ledger,
    remoteHead: () => () => Promise.resolve(null),
    pushIdsOf: (jobId) => stores.pushes.forJob(jobId).map((push) => push.id),
  });
  await app.ready();
});

afterEach(async () => {
  await app.close();
  stores.db.close();
  await rm(dataDir, { recursive: true, force: true });
});

describe("the internal run API", () => {
  it("takes the run's report with its runner token and its work report with its tools token", async () => {
    const { spec, runner, tools } = startRun("API-1");
    expect((await post(`/internal/runs/${spec.runId}/report`, runner, reportFor(spec.runId))).statusCode).toBe(200);
    const work = { runId: spec.runId, unpushed: "", pushedSha: null };
    expect((await post(`/internal/runs/${spec.runId}/work`, tools, work)).statusCode).toBe(200);
    expect(reports).toEqual([reportFor(spec.runId)]);
    expect(works).toEqual([work]);
  });

  it("refuses a runner token on the push routes and on the work report, and a tools token on the report", async () => {
    const { spec, runner, tools } = startRun("API-1");
    const record = { branch: "feature/API-1-x", sha: SHA, previousSha: null, note: null };
    expect((await post(`/internal/runs/${spec.runId}/push/record`, runner, record)).statusCode).toBe(401);
    expect((await post(`/internal/runs/${spec.runId}/push/start`, runner, {})).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: `/internal/runs/${spec.runId}/ticket`, headers: { authorization: `Bearer ${runner}` } })).statusCode).toBe(401);
    expect((await post(`/internal/runs/${spec.runId}/work`, runner, { runId: spec.runId, unpushed: "", pushedSha: null })).statusCode).toBe(401);
    expect((await post(`/internal/runs/${spec.runId}/report`, tools, reportFor(spec.runId))).statusCode).toBe(401);
    expect((await post(`/internal/runs/${spec.runId}/report`, null, reportFor(spec.runId))).statusCode).toBe(401);
    expect(ledgerCalls).toEqual([]);
    expect(reports).toEqual([]);
  });

  it("refuses a revoked token, and another run's token", async () => {
    const one = startRun("API-1");
    const two = startRun("API-2");
    expect((await post(`/internal/runs/${one.spec.runId}/report`, two.runner, reportFor(one.spec.runId))).statusCode).toBe(401);
    stores.runTokens.revoke(one.spec.runId);
    expect((await post(`/internal/runs/${one.spec.runId}/report`, one.runner, reportFor(one.spec.runId))).statusCode).toBe(401);
    expect((await post(`/internal/runs/${one.spec.runId}/push/start`, one.tools, {})).statusCode).toBe(401);
    expect(reports).toEqual([]);
  });

  it("serves the push ledger for the run's own target, and only the run's own pushes", async () => {
    const one = startRun("API-1");
    const two = startRun("API-2");
    const start = await post(`/internal/runs/${one.spec.runId}/push/start`, one.tools, {});
    expect(start.json()).toEqual({ kind: "create", base: SHA });
    const ticket = await app.inject({ method: "GET", url: `/internal/runs/${one.spec.runId}/ticket`, headers: { authorization: `Bearer ${one.tools}` } });
    expect(ticket.json()).toEqual({ title: "Fix the adapter", closed: null });
    const recorded = await post(`/internal/runs/${one.spec.runId}/push/record`, one.tools, { branch: "feature/API-1-x", sha: SHA, previousSha: null, note: null });
    const { id } = recorded.json<{ id: number }>();
    expect((await post(`/internal/runs/${one.spec.runId}/push/${id}/landed`, one.tools, { sha: SHA })).statusCode).toBe(200);
    // Run two's tools token cannot touch run one's push through its own run either.
    expect((await post(`/internal/runs/${two.spec.runId}/push/${id}/revert`, two.tools, {})).statusCode).toBe(404);
    expect(ledgerCalls).toEqual([`start ${one.spec.jobId}`, "ticket issue-API-1", `record ${one.spec.jobId} feature/API-1-x`, `landed ${one.spec.jobId} ${id}`]);
  });

  it("refuses a report for another run and answers 503 while no execute waits on a valid run", async () => {
    const { spec, runner } = startRun("API-1");
    expect((await post(`/internal/runs/${spec.runId}/report`, runner, reportFor("other-1"))).statusCode).toBe(400);
    specs.delete(spec.runId);
    expect((await post(`/internal/runs/${spec.runId}/report`, runner, reportFor(spec.runId))).statusCode).toBe(503);
    expect(reports).toEqual([]);
  });
});
