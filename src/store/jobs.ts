import { jobKindFor, type IssueJobKind } from "../core/intake.js";
import { StoredBrainResultSchema, type BrainResult, type StoredBrainResult } from "../core/result.js";
import type { JobOutcome } from "../core/types.js";
import { StoredImplementSchema, type StoredImplement } from "../implement/result.js";
import { StoredReviewSchema, type StoredReview } from "../review/result.js";
import type { ReviewTrigger, TriggerEvent } from "../tracker/types.js";
import { nowIso, type Database } from "./db.js";

export type JobKind = "enrich" | "review" | "implement";

export const reviewSubject = (projectId: number, mrIid: number): string => `mr:${projectId}!${mrIid}`;

export type JobStatus = "queued" | "running" | "succeeded" | "failed" | "publish_failed" | "skipped";

export interface Job {
  id: number;
  issueId: string;
  identifier: string;
  teamKey: string;
  kind: JobKind;
  subject: string | null;
  trigger: TriggerEvent;
  status: JobStatus;
  attempts: number;
  result: StoredBrainResult | null;
  resultSha: string | null;
  reviewResult: StoredReview | null;
  implementResult: StoredImplement | null;
  branch: string | null;
  commitSha: string | null;
  pushedAt: string | null;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  notBefore: string | null;
  /**
   * Stored columns holding JSON that cannot be read: a bad result is null, a bad trigger is a bare `cli` trigger built from
   * the row's columns. Such a job must fail, not run.
   */
  unreadable: StoredColumn[];
}

export type StoredColumn = "trigger" | "result" | "review_result" | "implement_result";

interface JobRow {
  id: number;
  issue_id: string;
  identifier: string;
  team_key: string;
  kind: JobKind;
  subject: string | null;
  trigger: string;
  status: JobStatus;
  attempts: number;
  result: string | null;
  result_sha: string | null;
  review_result: string | null;
  implement_result: string | null;
  branch: string | null;
  commit_sha: string | null;
  pushed_at: string | null;
  error: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  not_before: string | null;
}

type StoredSchema<T> = { safeParse: (value: unknown) => { success: true; data: T } | { success: false } };

/** One stored-result column: JSON the schema rejects is noted in `unreadable` and read as null instead of thrown. */
const readStored = <T>(raw: string | null, column: StoredColumn, schema: StoredSchema<T>, unreadable: StoredColumn[]): T | null => {
  if (raw === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    unreadable.push(column);
    return null;
  }
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  unreadable.push(column);
  return null;
};

const TRIGGER_KINDS = new Set<string>(["issue.created", "issue.labeled", "cli", "mr.review"]);

/** The stored trigger, or (noted in `unreadable`) a stand-in from the row's own columns when it is not a trigger object. */
const readTrigger = (row: JobRow, unreadable: StoredColumn[]): TriggerEvent => {
  try {
    const value: unknown = JSON.parse(row.trigger);
    if (typeof value === "object" && value !== null && "kind" in value && typeof value.kind === "string" && TRIGGER_KINDS.has(value.kind)) {
      return value as TriggerEvent;
    }
  } catch {
    // Falls through to the stand-in below.
  }
  unreadable.push("trigger");
  return { kind: "cli", issueId: row.issue_id, identifier: row.identifier, teamKey: row.team_key };
};

const toJob = (row: JobRow): Job => {
  const unreadable: StoredColumn[] = [];
  return {
    id: row.id,
    issueId: row.issue_id,
    identifier: row.identifier,
    teamKey: row.team_key,
    kind: row.kind,
    subject: row.subject,
    trigger: readTrigger(row, unreadable),
    status: row.status,
    attempts: row.attempts,
    result: readStored(row.result, "result", StoredBrainResultSchema, unreadable),
    resultSha: row.result_sha,
    reviewResult: readStored(row.review_result, "review_result", StoredReviewSchema, unreadable),
    implementResult: readStored(row.implement_result, "implement_result", StoredImplementSchema, unreadable),
    branch: row.branch,
    commitSha: row.commit_sha,
    pushedAt: row.pushed_at,
    error: row.error,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    notBefore: row.not_before,
    unreadable,
  };
};

/** A job whose stored result cannot be read fails for good: running it again could repeat the brain run or a push. */
export const unreadableOutcome = (job: Job): JobOutcome | null =>
  job.unreadable.length === 0
    ? null
    : { status: "failed", error: `stored ${job.unreadable.join(", ")} is unreadable; fix or clear the column before retrying`, retryable: false };

interface JobColumns {
  issueId: string;
  identifier: string;
  teamKey: string;
  kind: JobKind;
  subject: string | null;
}

/** A review job is keyed by its Linear key until the worker resolves it; its subject names the MR. */
const jobColumns = (event: TriggerEvent): JobColumns =>
  event.kind === "mr.review"
    ? { issueId: event.linearKey, identifier: event.linearKey, teamKey: event.teamKey, kind: "review", subject: reviewSubject(event.projectId, event.mrIid) }
    : { issueId: event.issueId, identifier: event.identifier, teamKey: event.teamKey, kind: jobKindFor(event), subject: null };

const CLAIM = "UPDATE jobs SET status = 'running', attempts = attempts + 1, started_at = ?";

export class JobStore {
  private readonly insert;
  private readonly selectQueued;
  private readonly selectQueuedBySubject;
  private readonly swapTrigger;
  private readonly existsSucceeded;
  private readonly claimOldest;
  private readonly claimOne;
  private readonly storeResult;
  private readonly storeReview;
  private readonly storeImplement;
  private readonly storeCommit;
  private readonly storePushed;
  private readonly complete;
  private readonly deferRetry;
  private readonly unclaim;
  private readonly reopen;
  private readonly selectById;
  private readonly selectByStatus;
  private readonly selectAll;
  private readonly requeueRunning;
  private readonly failRunning;
  private readonly closeRunningAttempts;
  private readonly requeueOneRunning;
  private readonly failOneRunning;
  private readonly closeJobAttempts;

  constructor(private readonly db: Database) {
    this.insert = db.prepare<[string, string, string, string, string, JobKind, string | null]>(
      `INSERT INTO jobs (issue_id, identifier, team_key, trigger, status, created_at, kind, subject)
       VALUES (?, ?, ?, ?, 'queued', ?, ?, ?)`,
    );
    this.selectQueued = db.prepare<[string, IssueJobKind], JobRow>(
      "SELECT * FROM jobs WHERE issue_id = ? AND status = 'queued' AND kind = ? ORDER BY id LIMIT 1",
    );
    this.existsSucceeded = db.prepare<[string, IssueJobKind], { found: number }>(
      // A handed-back implement job also finishes succeeded; only one that pushed a branch implemented the ticket.
      "SELECT EXISTS (SELECT 1 FROM jobs WHERE issue_id = ? AND status = 'succeeded' AND kind = ? AND (kind <> 'implement' OR pushed_at IS NOT NULL)) AS found",
    );
    this.selectQueuedBySubject = db.prepare<[string], JobRow>(
      "SELECT * FROM jobs WHERE subject = ? AND status = 'queued' ORDER BY id LIMIT 1",
    );
    this.swapTrigger = db.prepare<[string, string, string, string, number]>(
      `UPDATE jobs SET trigger = ?, issue_id = ?, identifier = ?, team_key = ?,
         review_result = NULL, attempts = 0, not_before = NULL, error = NULL
       WHERE id = ? AND status = 'queued'`,
    );
    // The oldest due job whose ticket (enrich, implement: same issue_id) or merge request (review: same subject) has no
    // running job. One statement, and better-sqlite3 is synchronous, so two loops can never claim the same job.
    this.claimOldest = db.prepare<[string, string], JobRow>(
      `${CLAIM} WHERE id = (
         SELECT q.id FROM jobs q
         WHERE q.status = 'queued' AND (q.not_before IS NULL OR q.not_before <= ?)
           AND NOT EXISTS (
             SELECT 1 FROM jobs r WHERE r.status = 'running' AND (
               (q.kind <> 'review' AND r.kind <> 'review' AND r.issue_id = q.issue_id)
               OR (q.subject IS NOT NULL AND r.subject = q.subject)))
         ORDER BY q.id LIMIT 1)
       RETURNING *`,
    );
    this.claimOne = db.prepare<[string, number], JobRow>(`${CLAIM} WHERE id = ? AND status != 'running' RETURNING *`);
    this.storeResult = db.prepare<[string, string, number]>("UPDATE jobs SET result = ?, result_sha = ? WHERE id = ?");
    this.storeReview = db.prepare<[string, number]>("UPDATE jobs SET review_result = ? WHERE id = ?");
    this.storeImplement = db.prepare<[string, number]>("UPDATE jobs SET implement_result = ? WHERE id = ?");
    this.storeCommit = db.prepare<[string, string, number]>("UPDATE jobs SET branch = ?, commit_sha = ? WHERE id = ?");
    this.storePushed = db.prepare<[string, number]>("UPDATE jobs SET pushed_at = ? WHERE id = ?");
    this.complete = db.prepare<[JobStatus, string | null, string, number]>(
      "UPDATE jobs SET status = ?, error = ?, finished_at = ?, not_before = NULL WHERE id = ?",
    );
    this.deferRetry = db.prepare<[string, string, number]>(
      "UPDATE jobs SET status = 'queued', not_before = ?, error = ?, finished_at = NULL WHERE id = ?",
    );
    this.unclaim = db.prepare<[string, number]>(
      "UPDATE jobs SET status = 'queued', attempts = MAX(attempts - 1, 0), not_before = NULL, error = ?, finished_at = NULL WHERE id = ?",
    );
    this.reopen = db.prepare<[number]>(
      "UPDATE jobs SET status = 'queued', not_before = NULL, finished_at = NULL WHERE id = ? AND status != 'running'",
    );
    this.selectById = db.prepare<[number], JobRow>("SELECT * FROM jobs WHERE id = ?");
    this.selectByStatus = db.prepare<[JobStatus, number], JobRow>(
      "SELECT * FROM jobs WHERE status = ? ORDER BY id DESC LIMIT ?",
    );
    this.selectAll = db.prepare<[number], JobRow>("SELECT * FROM jobs ORDER BY id DESC LIMIT ?");
    this.requeueRunning = db.prepare<[number]>(
      "UPDATE jobs SET status = 'queued' WHERE status = 'running' AND attempts < ?",
    );
    this.failRunning = db.prepare<[string]>(
      "UPDATE jobs SET status = 'failed', error = 'interrupted', finished_at = ? WHERE status = 'running'",
    );
    this.closeRunningAttempts = db.prepare<[string]>(
      `UPDATE attempts SET finished_at = ?, error = 'interrupted'
       WHERE finished_at IS NULL AND job_id IN (SELECT id FROM jobs WHERE status = 'running')`,
    );
    this.requeueOneRunning = db.prepare<[number, number]>(
      "UPDATE jobs SET status = 'queued' WHERE id = ? AND status = 'running' AND attempts < ?",
    );
    this.failOneRunning = db.prepare<[string, number]>(
      "UPDATE jobs SET status = 'failed', error = 'interrupted', finished_at = ? WHERE id = ? AND status = 'running'",
    );
    this.closeJobAttempts = db.prepare<[string, number]>(
      "UPDATE attempts SET finished_at = ?, error = 'interrupted' WHERE finished_at IS NULL AND job_id = ?",
    );
  }

  enqueue(event: TriggerEvent): number {
    const columns = jobColumns(event);
    const { lastInsertRowid } = this.insert.run(
      columns.issueId,
      columns.identifier,
      columns.teamKey,
      JSON.stringify(event),
      nowIso(),
      columns.kind,
      columns.subject,
    );
    return Number(lastInsertRowid);
  }

  findQueuedBySubject(subject: string): Job | null {
    const row = this.selectQueuedBySubject.get(subject);
    return row === undefined ? null : toJob(row);
  }

  /**
   * Points a still-queued review at a newer push; false once the job has been claimed.
   * The job starts over for the new head: a review saved for the old head is dropped,
   * and the attempt count and any retry backoff are reset.
   */
  replaceTrigger(id: number, trigger: ReviewTrigger): boolean {
    const columns = jobColumns(trigger);
    return this.swapTrigger.run(JSON.stringify(trigger), columns.issueId, columns.identifier, columns.teamKey, id).changes === 1;
  }

  findQueued(issueId: string, kind: IssueJobKind = "enrich"): Job | null {
    const row = this.selectQueued.get(issueId, kind);
    return row === undefined ? null : toJob(row);
  }

  hasSucceeded(issueId: string, kind: IssueJobKind = "enrich"): boolean {
    return this.existsSucceeded.get(issueId, kind)?.found === 1;
  }

  saveImplementResult(id: number, stored: StoredImplement): void {
    this.storeImplement.run(JSON.stringify(stored), id);
  }

  recordCommit(id: number, branch: string, sha: string): void {
    this.storeCommit.run(branch, sha, id);
  }

  markPushed(id: number): void {
    this.storePushed.run(nowIso(), id);
  }

  claimNext(): Job | null {
    const now = nowIso();
    const row = this.claimOldest.get(now, now);
    return row === undefined ? null : toJob(row);
  }

  claimById(id: number): Job | null {
    const row = this.claimOne.get(nowIso(), id);
    return row === undefined ? null : toJob(row);
  }

  saveResult(id: number, result: BrainResult, sha: string): void {
    this.storeResult.run(JSON.stringify(result), sha, id);
  }

  saveReviewResult(id: number, stored: StoredReview): void {
    this.storeReview.run(JSON.stringify(stored), id);
  }

  finish(id: number, outcome: JobOutcome): void {
    const error = outcome.status === "succeeded" ? null : outcome.error;
    this.complete.run(outcome.status, error, nowIso(), id);
  }

  /** Puts the job back in the queue, invisible to claimNext until `notBefore` (ISO). */
  scheduleRetry(id: number, notBefore: Date, error: string): void {
    this.deferRetry.run(notBefore.toISOString(), error, id);
  }

  /** Puts a claimed job back in the queue and gives back the attempt the claim counted. */
  releaseClaim(id: number, error: string): void {
    this.unclaim.run(error, id);
  }

  /** Re-queues a finished job for the worker; false when the job is running or unknown. */
  requeue(id: number): boolean {
    return this.reopen.run(id).changes === 1;
  }

  get(id: number): Job | null {
    const row = this.selectById.get(id);
    return row === undefined ? null : toJob(row);
  }

  list(filter: { status?: JobStatus; limit: number }): Job[] {
    const rows =
      filter.status === undefined ? this.selectAll.all(filter.limit) : this.selectByStatus.all(filter.status, filter.limit);
    return rows.map(toJob);
  }

  requeueInterrupted(maxAttempts: number): { requeued: number; failed: number } {
    return this.db.transaction(() => {
      const now = nowIso();
      this.closeRunningAttempts.run(now);
      const requeued = this.requeueRunning.run(maxAttempts).changes;
      const failed = this.failRunning.run(now).changes;
      return { requeued, failed };
    })();
  }

  /** `requeueInterrupted` for one job: other loops' running jobs and their attempts stay as they are. */
  requeueInterruptedJob(id: number, maxAttempts: number): void {
    this.db.transaction(() => {
      const now = nowIso();
      this.closeJobAttempts.run(now, id);
      this.requeueOneRunning.run(id, maxAttempts);
      this.failOneRunning.run(now, id);
    })();
  }
}
