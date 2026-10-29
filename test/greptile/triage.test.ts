import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FailedJob } from "../../src/codehost/gitlabMr.js";
import { INFRA_FAILURE_REASONS, triageFailures, type TriageTarget } from "../../src/greptile/triage.js";
import { logger } from "../../src/log.js";
import type { OrbitQuery } from "../../src/orbit/query.js";
import { DEFAULT_SETTINGS, type Settings } from "../../src/settings/schema.js";
import type { Loop } from "../../src/store/loops.js";
import { FakeGitLabMr } from "../fakes/fakeGitLabMr.js";

const SHA = "c".repeat(40);
const NOW = new Date("2026-10-29T12:00:00.000Z");
const SINCE = "2026-10-15T12:00:00.000Z";

const loop = (over: Partial<Loop> = {}): Loop => ({
  id: 1, issueId: "i", identifier: "API-1", teamKey: "API", implementJobId: 1, branch: "api-1-fix", baseSha: "a".repeat(40),
  headSha: SHA, worktreeName: "w", labelDriven: false, projectId: 42, mrIid: 7, mrUrl: null, sessionId: null, round: 1,
  state: "awaiting_review", history: [], decisions: [], waitStartedAt: null, reviewCountAtTrigger: null, adoptedFrom: null,
  pendingPush: null, handedBackAt: null, pendingNotesSince: null, botRounds: 0, ciRetries: {}, endedAt: null, createdAt: "2026-10-28T00:00:00Z", ...over,
});
const job = (id: number, name: string, failureReason: string | null = "script_failure"): FailedJob => ({
  id, name, stage: "test", webUrl: `https://gitlab.example/acme/repo/-/jobs/${id}`, failureReason,
});
const target: TriageTarget = { project: 42, pipelineId: 9, sha: SHA, defaultBranch: "main", branch: "api-1-fix" };

let gitlab: FakeGitLabMr;
const deps = (over: { orbit?: OrbitQuery | null; settings?: Partial<Settings> } = {}) => ({
  gitlab,
  orbit: over.orbit ?? null,
  settings: { ...DEFAULT_SETTINGS, ...over.settings },
  now: NOW,
});

/** An Orbit that answers each query with the count `answer` gives it, and records the queries. */
const fakeOrbit = (answer: (cypher: string) => number | Error) => {
  const queries: string[] = [];
  const orbit: OrbitQuery = async (cypher) => {
    queries.push(cypher);
    const n = answer(cypher);
    if (n instanceof Error) throw n;
    return { result: { rows: [{ n }] } };
  };
  return { orbit, queries };
};

/** The head pipeline's `unit` job failed `adapter flushes`; so did main's pipeline 70, a week ago. */
const flakyTestReports = (): void => {
  gitlab.testReports.set(9, [
    { suite: "unit", name: "adapter flushes", status: "failed" },
    { suite: "unit", name: "adapter opens", status: "success" },
  ]);
  gitlab.pipelines.set("main", [{ id: 71, sha: "e", status: "success" }, { id: 70, sha: "d", status: "failed" }]);
  gitlab.testReports.set(70, [{ suite: "unit", name: "adapter flushes", status: "failed" }]);
};

beforeEach(() => {
  gitlab = new FakeGitLabMr();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("triageFailures", () => {
  it("retries an infrastructure failure, at most twice per job on one commit", async () => {
    const failed = [job(5, "unit", "runner_system_failure")];

    const first = await triageFailures(deps(), loop(), failed, target);
    expect(first).toEqual({
      retry: failed,
      real: [],
      notes: ["Retried unit (infrastructure failure: runner_system_failure)"],
      ciRetries: { unit: { sha: SHA, infra: 1, flaky: 0 } },
    });

    const second = await triageFailures(deps(), loop({ ciRetries: first.ciRetries }), failed, target);
    expect(second.retry).toEqual(failed);
    expect(second.ciRetries).toEqual({ unit: { sha: SHA, infra: 2, flaky: 0 } });

    const third = await triageFailures(deps(), loop({ ciRetries: second.ciRetries }), failed, target);
    expect(third).toMatchObject({ retry: [], real: failed });
    expect(third.notes).toEqual(["unit failed with runner_system_failure again after 2 retries on this commit"]);
  });

  it("ignores retryLimit for infrastructure failures, and starts a job's count again on a new commit", async () => {
    const failed = [job(5, "unit", "stuck_or_timeout_failure")];
    const settled = { unit: { sha: "b".repeat(40), infra: 2, flaky: 1 } };

    const result = await triageFailures(deps({ settings: { "ci.retryLimit": 0 } }), loop({ ciRetries: settled }), failed, target);

    expect(result.retry).toEqual(failed);
    expect(result.ciRetries).toEqual({ unit: { sha: SHA, infra: 1, flaky: 0 } });
  });

  it("knows GitLab's infrastructure failure reasons", () => {
    for (const reason of ["runner_system_failure", "api_failure", "job_execution_timeout", "no_matching_runner", "job_token_expired"]) {
      expect(INFRA_FAILURE_REASONS.has(reason)).toBe(true);
    }
    expect(INFRA_FAILURE_REASONS.has("script_failure")).toBe(false);
  });

  it("retries a job whose failing test also failed on the default branch once, then calls the second failure on that commit real", async () => {
    flakyTestReports();
    const failed = [job(5, "unit")];

    const first = await triageFailures(deps(), loop(), failed, target);
    expect(first).toEqual({
      retry: failed,
      real: [],
      notes: ['Retried unit (looked flaky: test "adapter flushes" also failed on main in pipeline #70)'],
      ciRetries: { unit: { sha: SHA, infra: 0, flaky: 1 } },
    });
    expect(gitlab.pipelineQueries).toEqual([{ ref: "main", sinceIso: SINCE }]);

    const second = await triageFailures(deps(), loop({ ciRetries: first.ciRetries }), failed, target);
    expect(second).toEqual({
      retry: [],
      real: failed,
      notes: ["unit failed again after a retry on this commit; treat it as a real failure"],
      ciRetries: first.ciRetries,
    });
  });

  it("calls a failure with no flaky signal real, and without Orbit asks only the test reports", async () => {
    gitlab.testReports.set(9, [{ suite: "unit", name: "adapter flushes", status: "failed" }]);
    gitlab.pipelines.set("main", [{ id: 70, sha: "d", status: "failed" }]);
    gitlab.testReports.set(70, [{ suite: "unit", name: "adapter opens", status: "failed" }]);
    const failed = [job(5, "unit")];

    const result = await triageFailures(deps({ orbit: null }), loop(), failed, target);

    expect(result).toEqual({ retry: [], real: failed, notes: ["unit: no sign of a flaky test or a CI fault; treat it as a real failure"], ciRetries: {} });
  });

  it("goes on when the head pipeline has no test report", async () => {
    const failed = [job(5, "lint")];

    expect(await triageFailures(deps(), loop(), failed, target)).toMatchObject({ retry: [], real: failed });
  });

  it("with Orbit, retries a job that failed on the default branch within the lookback window", async () => {
    const { orbit, queries } = fakeOrbit((cypher) => (cypher.includes("j.ref = 'main'") ? 3 : 0));
    const failed = [job(5, "e2e 'smoke'")];

    const result = await triageFailures(deps({ orbit }), loop(), failed, target);

    expect(result.retry).toEqual(failed);
    expect(result.notes).toEqual(["Retried e2e 'smoke' (looked flaky: it failed 3 times on main in the last 14 days)"]);
    expect(queries).toEqual([
      `MATCH (j:Job) WHERE j.project_id = 42 AND j.name = 'e2e \\'smoke\\'' AND j.status = 'failed' AND j.ref = 'main' AND j.created_at >= '${SINCE}' RETURN count(j) AS n`,
    ]);
  });

  it("with Orbit, retries a job that was retried after failing on other branches, this one aside", async () => {
    const { orbit, queries } = fakeOrbit((cypher) => (cypher.includes("j.retried = true") ? 2 : 0));
    const failed = [job(5, "unit")];

    const result = await triageFailures(deps({ orbit }), loop(), failed, target);

    expect(result.notes).toEqual(["Retried unit (looked flaky: it was retried after failing 2 times on other branches in the last 14 days)"]);
    expect(queries[1]).toBe(
      `MATCH (j:Job) WHERE j.project_id = 42 AND j.name = 'unit' AND j.status = 'failed' AND j.retried = true AND NOT j.ref = 'main' AND NOT j.ref = 'api-1-fix' AND j.created_at >= '${SINCE}' RETURN count(j) AS n`,
    );
  });

  it("goes on without a signal when an Orbit query fails, without throwing", async () => {
    vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    const { orbit } = fakeOrbit(() => new Error("Orbit remote is unavailable: 403 Forbidden"));
    const failed = [job(5, "unit")];

    expect(await triageFailures(deps({ orbit }), loop(), failed, target)).toMatchObject({ retry: [], real: failed });
  });

  it("retries nothing when another job failed for real, and tells the round what looked flaky", async () => {
    const failed = [job(5, "unit", "runner_system_failure"), job(6, "lint")];

    const result = await triageFailures(deps(), loop(), failed, target);

    expect(result).toEqual({
      retry: [],
      real: failed,
      notes: [
        "lint: no sign of a flaky test or a CI fault; treat it as a real failure",
        "unit looked like an infrastructure failure (runner_system_failure) but was not retried, since other jobs failed for real",
      ],
      ciRetries: {},
    });
  });

  it("calls everything real with ci.triage off, asking nothing", async () => {
    const { orbit, queries } = fakeOrbit(() => 5);
    const failed = [job(5, "unit", "runner_system_failure")];

    expect(await triageFailures(deps({ orbit, settings: { "ci.triage": false } }), loop(), failed, target)).toEqual({ retry: [], real: failed, notes: [], ciRetries: {} });
    expect(queries).toEqual([]);
  });
});
