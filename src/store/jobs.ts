import { jobKindFor, type IssueJobKind } from "../core/intake.js";
import { StoredBrainResultSchema, type BrainResult, type StoredBrainResult } from "../core/result.js";
import type { JobOutcome } from "../core/types.js";
import { StoredFixSchema, type StoredFix } from "../greptile/result.js";
import { StoredImplementSchema, type StoredImplement } from "../implement/result.js";
import type { TriggerEvent } from "../tracker/types.js";
import { nowIso, readStored, type Database } from "./db.js";

/** Issue jobs (enrich, implement) and the fix loop's steps (await_review, fix, restart). */
export type JobKind = "enrich" | "implement" | "await_review" | "fix" | "restart";

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
  implementResult: StoredImplement | null;
  /** A fix job's validated result or hand-back, so a retry publishes it instead of running the brain again. */
  fixResult: StoredFix | null;
  branch: string | null;
  commitSha: string | null;
  pushedAt: string | null;
  /** The brain session this job's run left, for the fix loop to resume. */
  sessionId: string | null;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  notBefore: string | null;
  /** A GitLab webhook woke the loop while this job ran: its deferral comes due at once instead of after the poll interval. */
  wakeRequested: boolean;
  /**
   * Stored columns holding JSON that cannot be read: a bad result is null, a bad trigger is a bare `cli` trigger built from
   * the row's columns. Such a job must fail, not run.
   */
  unreadable: StoredColumn[];
}

export type StoredColumn = "trigger" | "result" | "implement_result" | "fix_result";

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
  implement_result: string | null;
  fix_result: string | null;
  branch: string | null;
  commit_sha: string | null;
  pushed_at: string | null;
  session_id: string | null;
  error: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  not_before: string | null;
  wake_requested: number;
}

const TRIGGER_KINDS = new Set<string>(["issue.created", "issue.labeled", "cli", "loop"]);

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
    implementResult: readStored(row.implement_result, "implement_result", StoredImplementSchema, unreadable),
    fixResult: readStored(row.fix_result, "fix_result", StoredFixSchema, unreadable),
    branch: row.branch,
    commitSha: row.commit_sha,
    pushedAt: row.pushed_at,
    sessionId: row.session_id,
    error: row.error,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    notBefore: row.not_before,
    wakeRequested: row.wake_requested === 1,
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

/** The subject of every job a loop runs; `LoopStore.stranded` matches it in SQL. */
export const loopSubject = (loopId: number): string => `loop:${loopId}`;

/** A loop step runs as its own job kind (`await` as `await_review`), with the loop as subject so its steps never overlap. */
const jobColumns = (event: TriggerEvent): JobColumns => {
  const ticket = { issueId: event.issueId, identifier: event.identifier, teamKey: event.teamKey };
  if (event.kind === "loop") return { ...ticket, kind: event.step === "await" ? "await_review" : event.step, subject: loopSubject(event.loopId) };
  return { ...ticket, kind: jobKindFor(event), subject: null };
};

const CLAIM = "UPDATE jobs SET status = 'running', attempts = attempts + 1, wake_requested = 0, started_at = ?";

export class JobStore {
  private readonly insert;
  private readonly selectQueued;
  private readonly existsSucceeded;
  private readonly claimOldest;
  private readonly claimOne;
  private readonly storeResult;
  private readonly storeImplement;
  private readonly storeFix;
  private readonly storeCommit;
  private readonly storePushed;
  private readonly storeSession;
  private readonly complete;
  private readonly deferRetry;
  private readonly deferUntil;
  private readonly unclaim;
  private readonly reopen;
  private readonly wakeSubject;
  private readonly selectById;
  private readonly selectLatestForSubject;
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
    this.selectQueued = db.prepare<[string, JobKind], JobRow>(
      "SELECT * FROM jobs WHERE issue_id = ? AND status = 'queued' AND kind = ? ORDER BY id LIMIT 1",
    );
    this.existsSucceeded = db.prepare<[string, IssueJobKind], { found: number }>(
      // A handed-back implement job also finishes succeeded; only one that pushed a branch implemented the ticket.
      "SELECT EXISTS (SELECT 1 FROM jobs WHERE issue_id = ? AND status = 'succeeded' AND kind = ? AND (kind <> 'implement' OR pushed_at IS NOT NULL)) AS found",
    );
    // The oldest due job with no running job on the same ticket (issue_id) or on the same non-null subject. One statement,
    // and better-sqlite3 is synchronous, so two loops can never claim the same job.
    this.claimOldest = db.prepare<[string, string, number], JobRow>(
      `${CLAIM} WHERE id = (
         SELECT q.id FROM jobs q
         WHERE q.status = 'queued' AND (q.not_before IS NULL OR q.not_before <= ?)
           AND (? = 0 OR q.kind = 'await_review')
           AND NOT EXISTS (
             SELECT 1 FROM jobs r WHERE r.status = 'running' AND (
               r.issue_id = q.issue_id
               OR (q.subject IS NOT NULL AND r.subject = q.subject)))
         ORDER BY q.id LIMIT 1)
       RETURNING *`,
    );
    this.claimOne = db.prepare<[string, number], JobRow>(`${CLAIM} WHERE id = ? AND status != 'running' RETURNING *`);
    this.storeResult = db.prepare<[string, string, number]>("UPDATE jobs SET result = ?, result_sha = ? WHERE id = ?");
    this.storeImplement = db.prepare<[string, number]>("UPDATE jobs SET implement_result = ? WHERE id = ?");
    this.storeFix = db.prepare<[string, number]>("UPDATE jobs SET fix_result = ? WHERE id = ?");
    this.storeCommit = db.prepare<[string, string, number]>("UPDATE jobs SET branch = ?, commit_sha = ? WHERE id = ?");
    this.storePushed = db.prepare<[string, number]>("UPDATE jobs SET pushed_at = ? WHERE id = ?");
    this.storeSession = db.prepare<[string, number]>("UPDATE jobs SET session_id = ? WHERE id = ?");
    this.complete = db.prepare<[JobStatus, string | null, string, number]>(
      "UPDATE jobs SET status = ?, error = ?, finished_at = ?, not_before = NULL, wake_requested = 0 WHERE id = ?",
    );
    this.deferRetry = db.prepare<[string, string, number]>(
      "UPDATE jobs SET status = 'queued', not_before = ?, error = ?, finished_at = NULL, wake_requested = 0 WHERE id = ?",
    );
    // A wake recorded while the job ran turns the deferral into "due now", once.
    this.deferUntil = db.prepare<[string, string, number]>(
      `UPDATE jobs SET status = 'queued', attempts = 0, not_before = CASE WHEN wake_requested = 1 THEN ? ELSE ? END, error = NULL,
         finished_at = NULL, wake_requested = 0 WHERE id = ?`,
    );
    this.unclaim = db.prepare<[string, number]>(
      "UPDATE jobs SET status = 'queued', attempts = MAX(attempts - 1, 0), not_before = NULL, error = ?, finished_at = NULL, wake_requested = 0 WHERE id = ?",
    );
    this.reopen = db.prepare<[number]>(
      "UPDATE jobs SET status = 'queued', not_before = NULL, finished_at = NULL WHERE id = ? AND status != 'running'",
    );
    // A queued job comes due now (one already due keeps its earlier time); a running one records the wake for its deferral.
    // SQLite counts every row the WHERE matched, so a repeat wake is still true.
    this.wakeSubject = db.prepare<[string, string, string]>(
      `UPDATE jobs SET
         not_before = CASE WHEN status = 'queued' AND not_before IS NOT NULL AND not_before > ? THEN ? ELSE not_before END,
         wake_requested = CASE WHEN status = 'running' THEN 1 ELSE wake_requested END
       WHERE subject = ? AND status IN ('queued', 'running')`,
    );
    this.selectById = db.prepare<[number], JobRow>("SELECT * FROM jobs WHERE id = ?");
    this.selectLatestForSubject = db.prepare<[string], JobRow>("SELECT * FROM jobs WHERE subject = ? ORDER BY id DESC LIMIT 1");
    this.selectByStatus = db.prepare<[JobStatus, number], JobRow>(
      "SELECT * FROM jobs WHERE status = ? ORDER BY id DESC LIMIT ?",
    );
    this.selectAll = db.prepare<[number], JobRow>("SELECT * FROM jobs ORDER BY id DESC LIMIT ?");
    this.requeueRunning = db.prepare<[number]>(
      "UPDATE jobs SET status = 'queued', wake_requested = 0 WHERE status = 'running' AND attempts < ?",
    );
    this.failRunning = db.prepare<[string]>(
      "UPDATE jobs SET status = 'failed', error = 'interrupted', finished_at = ?, wake_requested = 0 WHERE status = 'running'",
    );
    this.closeRunningAttempts = db.prepare<[string]>(
      `UPDATE attempts SET finished_at = ?, error = 'interrupted'
       WHERE finished_at IS NULL AND job_id IN (SELECT id FROM jobs WHERE status = 'running')`,
    );
    this.requeueOneRunning = db.prepare<[number, number]>(
      "UPDATE jobs SET status = 'queued', wake_requested = 0 WHERE id = ? AND status = 'running' AND attempts < ?",
    );
    this.failOneRunning = db.prepare<[string, number]>(
      "UPDATE jobs SET status = 'failed', error = 'interrupted', finished_at = ?, wake_requested = 0 WHERE id = ? AND status = 'running'",
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

  findQueued(issueId: string, kind: JobKind = "enrich"): Job | null {
    const row = this.selectQueued.get(issueId, kind);
    return row === undefined ? null : toJob(row);
  }

  hasSucceeded(issueId: string, kind: IssueJobKind = "enrich"): boolean {
    return this.existsSucceeded.get(issueId, kind)?.found === 1;
  }

  saveImplementResult(id: number, stored: StoredImplement): void {
    this.storeImplement.run(JSON.stringify(stored), id);
  }

  saveFixResult(id: number, stored: StoredFix): void {
    this.storeFix.run(JSON.stringify(stored), id);
  }

  recordCommit(id: number, branch: string, sha: string): void {
    this.storeCommit.run(branch, sha, id);
  }

  markPushed(id: number): void {
    this.storePushed.run(nowIso(), id);
  }

  recordSession(id: number, sessionId: string): void {
    this.storeSession.run(sessionId, id);
  }

  /** Claims the oldest due job; `waitsOnly` limits it to await_review jobs, which poll APIs and need no host resources. */
  claimNext(options: { waitsOnly?: boolean } = {}): Job | null {
    const now = nowIso();
    const row = this.claimOldest.get(now, now, options.waitsOnly === true ? 1 : 0);
    return row === undefined ? null : toJob(row);
  }

  claimById(id: number): Job | null {
    const row = this.claimOne.get(nowIso(), id);
    return row === undefined ? null : toJob(row);
  }

  saveResult(id: number, result: BrainResult, sha: string): void {
    this.storeResult.run(JSON.stringify(result), sha, id);
  }

  /** Ends the job with its outcome; a deferred one is not an end, so it goes back to the queue through `defer`. */
  finish(id: number, outcome: JobOutcome): void {
    if (outcome.status === "deferred") {
      this.defer(id, outcome.until);
      return;
    }
    const error = outcome.status === "succeeded" ? null : outcome.error;
    this.complete.run(outcome.status, error, nowIso(), id);
  }

  /** Puts the job back in the queue, invisible to claimNext until `notBefore` (ISO). */
  scheduleRetry(id: number, notBefore: Date, error: string): void {
    this.deferRetry.run(notBefore.toISOString(), error, id);
  }

  /**
   * A deferred outcome: back in the queue until `until`. Waiting is progress, not a failure, so the failure count starts
   * over: a long wait's polls never add up their occasional retryable errors into a terminal failure.
   */
  defer(id: number, until: Date): void {
    this.deferUntil.run(nowIso(), until.toISOString(), id);
  }

  /** Puts a claimed job back in the queue and gives back the attempt the claim counted. */
  releaseClaim(id: number, error: string): void {
    this.unclaim.run(error, id);
  }

  /** Re-queues a finished job for the worker; false when the job is running or unknown. */
  requeue(id: number): boolean {
    return this.reopen.run(id).changes === 1;
  }

  /**
   * Makes the queued job of this subject (a loop's deferred await) due at `now`, or, while it runs, makes its coming
   * deferral due at once. False when no job of the subject is queued or running. Never creates a job.
   */
  wake(subject: string, now: Date): boolean {
    const at = now.toISOString();
    return this.wakeSubject.run(at, at, subject).changes > 0;
  }

  get(id: number): Job | null {
    const row = this.selectById.get(id);
    return row === undefined ? null : toJob(row);
  }

  /** The newest job with this subject (a loop's last step), whatever its status. */
  latestForSubject(subject: string): Job | null {
    const row = this.selectLatestForSubject.get(subject);
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
