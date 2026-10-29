import type { FailedJob, GitLabMrApi, TestCase } from "../codehost/gitlabMr.js";
import { logger } from "../log.js";
import { orbitCount, type OrbitQuery } from "../orbit/query.js";
import type { Settings } from "../settings/schema.js";
import type { CiRetries, CiRetry, Loop } from "../store/loops.js";

/** GitLab `failure_reason`s that say the CI broke, not the code: such a job is retried without counting a round. */
export const INFRA_FAILURE_REASONS: ReadonlySet<string> = new Set([
  "runner_system_failure",
  "stuck_or_timeout_failure",
  "api_failure",
  "job_execution_timeout",
  "scheduler_failure",
  "no_matching_runner",
  "stuck_pending_no_matching_runners",
  "stuck_pending_with_matching_runners",
  "runner_unsupported",
  "data_integrity_failure",
  "job_execution_server_timeout",
  "server_timeout_running",
  "job_router_failure",
  "job_token_expired",
]);

/** Retries of one job for an infrastructure failure on one commit; `ci.retryLimit` does not apply to them. */
const MAX_INFRA_RETRIES = 2;
/** Default-branch pipelines whose test reports are read for a flaky test, newest first. */
const MAX_DEFAULT_PIPELINES = 10;
const FAILED_TESTS = new Set(["failed", "error"]);

export interface TriageDeps {
  gitlab: GitLabMrApi;
  /** The remote Orbit query; null when it does not work for the steward, and triage uses the test reports alone. */
  orbit: OrbitQuery | null;
  settings: Settings;
  now: Date;
}

/** The red head pipeline triage looks at: its project, commit, the MR's branch and the branch it merges into. */
export interface TriageTarget {
  project: number;
  pipelineId: number;
  sha: string;
  /** Where failures count as a flaky signal: the MR's target branch. */
  defaultBranch: string;
  /** The MR's own branch, whose retries (the steward's among them) are no signal. */
  branch: string;
}

/**
 * `retry`: jobs to retry, and only when every failure is one, so no round runs on a red pipeline the retries may turn green.
 * `real`: the failures a round works on. `notes`: what triage found, for the MR, the panel and the round's prompt.
 * `ciRetries`: the loop's retry record once `retry` is retried.
 */
export interface Triage {
  retry: FailedJob[];
  real: FailedJob[];
  notes: string[];
  ciRetries: CiRetries;
}

type Verdict =
  | { kind: "retry"; job: FailedJob; record: CiRetry; note: string; held: string }
  | { kind: "real"; job: FailedJob; note: string };

/** A Cypher string literal. */
const literal = (value: string): string => `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;

/** The flaky signals one triage reads, each fetched at most once whatever the number of failed jobs. */
const signals = (deps: TriageDeps, target: TriageTarget) => {
  const days = deps.settings["ci.lookbackDays"];
  const since = new Date(deps.now.getTime() - days * 24 * 60 * 60_000).toISOString();
  let head: Promise<TestCase[]> | undefined;
  let defaultFailures: Promise<Map<string, number>> | undefined;
  const report = (pipelineId: number): Promise<TestCase[]> => deps.gitlab.testReport(target.project, pipelineId).catch(() => []);

  /** Failed test names on the default branch's failed pipelines in the window, each with the newest pipeline it failed in. */
  const onDefault = async (): Promise<Map<string, number>> => {
    const failures = new Map<string, number>();
    const pipelines = await deps.gitlab.recentPipelines(target.project, target.defaultBranch, since).catch(() => []);
    for (const pipeline of pipelines.filter((p) => p.status === "failed").slice(0, MAX_DEFAULT_PIPELINES)) {
      for (const test of await report(pipeline.id)) {
        if (FAILED_TESTS.has(test.status) && !failures.has(test.name)) failures.set(test.name, pipeline.id);
      }
    }
    return failures;
  };

  const fromTests = async (job: FailedJob): Promise<string | null> => {
    head ??= report(target.pipelineId);
    const failing = (await head).filter((test) => test.suite === job.name && FAILED_TESTS.has(test.status));
    if (failing.length === 0) return null;
    defaultFailures ??= onDefault();
    const known = await defaultFailures;
    for (const test of failing) {
      const pipeline = known.get(test.name);
      if (pipeline !== undefined) return `test "${test.name}" also failed on ${target.defaultBranch} in pipeline #${pipeline}`;
    }
    return null;
  };

  /** One count query; a failure is logged and is no signal. */
  const count = async (orbit: OrbitQuery, where: string): Promise<number> => {
    try {
      return orbitCount(await orbit(`MATCH (j:Job) WHERE ${where} AND j.created_at >= ${literal(since)} RETURN count(j) AS n`)) ?? 0;
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : String(err) }, "ci triage: an Orbit query failed; going on without it");
      return 0;
    }
  };

  const fromOrbit = async (job: FailedJob): Promise<string | null> => {
    const orbit = deps.orbit;
    if (orbit === null) return null;
    const failedJob = `j.project_id = ${target.project} AND j.name = ${literal(job.name)} AND j.status = 'failed'`;
    const onDefaultBranch = await count(orbit, `${failedJob} AND j.ref = ${literal(target.defaultBranch)}`);
    if (onDefaultBranch > 0) return `it failed ${onDefaultBranch} times on ${target.defaultBranch} in the last ${days} days`;
    const retried = await count(
      orbit,
      `${failedJob} AND j.retried = true AND NOT j.ref = ${literal(target.defaultBranch)} AND NOT j.ref = ${literal(target.branch)}`,
    );
    if (retried > 0) return `it was retried after failing ${retried} times on other branches in the last ${days} days`;
    return null;
  };

  return { flaky: async (job: FailedJob): Promise<string | null> => (await fromTests(job)) ?? (await fromOrbit(job)) };
};

/**
 * Sorts a red pipeline's failed jobs before they cost a round. An infrastructure failure is retried (twice at most per job
 * and commit); a job that looks flaky (a failing test that also failed on the default branch, or with Orbit the job
 * failing there or being retried after failing elsewhere) is retried `ci.retryLimit` times per commit. Anything else is
 * real, and with any real failure nothing is retried. With `ci.triage` off every failure is real.
 */
export const triageFailures = async (deps: TriageDeps, loop: Loop, failed: FailedJob[], target: TriageTarget): Promise<Triage> => {
  if (!deps.settings["ci.triage"] || failed.length === 0) return { retry: [], real: failed, notes: [], ciRetries: loop.ciRetries };
  const limit = deps.settings["ci.retryLimit"];
  const lookup = signals(deps, target);
  const recordOf = (name: string): CiRetry => {
    const record = loop.ciRetries[name];
    return record !== undefined && record.sha === target.sha ? record : { sha: target.sha, infra: 0, flaky: 0 };
  };

  const verdicts: Verdict[] = [];
  for (const job of failed) {
    const record = recordOf(job.name);
    const reason = job.failureReason;
    if (reason !== null && INFRA_FAILURE_REASONS.has(reason)) {
      verdicts.push(
        record.infra < MAX_INFRA_RETRIES
          ? {
              kind: "retry", job, record: { ...record, infra: record.infra + 1 },
              note: `Retried ${job.name} (infrastructure failure: ${reason})`,
              held: `${job.name} looked like an infrastructure failure (${reason})`,
            }
          : { kind: "real", job, note: `${job.name} failed with ${reason} again after ${record.infra} retries on this commit` },
      );
      continue;
    }
    if (record.flaky > 0 && record.flaky >= limit) {
      verdicts.push({ kind: "real", job, note: `${job.name} failed again after a retry on this commit; treat it as a real failure` });
      continue;
    }
    const signal = limit > 0 ? await lookup.flaky(job) : null;
    verdicts.push(
      signal === null
        ? { kind: "real", job, note: `${job.name}: no sign of a flaky test or a CI fault; treat it as a real failure` }
        : {
            kind: "retry", job, record: { ...record, flaky: record.flaky + 1 },
            note: `Retried ${job.name} (looked flaky: ${signal})`,
            held: `${job.name} looked flaky (${signal})`,
          },
    );
  }

  const retries = verdicts.filter((verdict) => verdict.kind === "retry");
  const reals = verdicts.filter((verdict) => verdict.kind === "real");
  if (reals.length > 0) {
    return {
      retry: [],
      real: failed,
      notes: [
        ...reals.map((verdict) => verdict.note),
        ...retries.map((verdict) => `${verdict.held} but was not retried, since other jobs failed for real`),
      ],
      ciRetries: loop.ciRetries,
    };
  }
  const ciRetries: CiRetries = { ...loop.ciRetries };
  for (const verdict of retries) ciRetries[verdict.job.name] = verdict.record;
  return { retry: retries.map((verdict) => verdict.job), real: [], notes: retries.map((verdict) => verdict.note), ciRetries };
};
