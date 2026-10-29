import type { JobOutcome } from "../core/types.js";
import { StoredChatSchema, type StoredChat } from "../chat/result.js";
import { StoredFixSchema, type StoredFix } from "../greptile/result.js";
import { StoredImplementSchema, type StoredImplement } from "../implement/result.js";
import type { TriggerEvent } from "../tracker/types.js";
import { nowIso, readStored, type Database } from "./db.js";
import { leaseCutoff } from "./leases.js";

/** Issue jobs (implement), the fix loop's steps (await_review, fix, restart) and chat turns from MR notes. */
export type JobKind = "implement" | "await_review" | "fix" | "restart" | "chat";

/** Kinds a job row may carry: today's, plus `enrich` (removed 2026-10-28), kept so its history still lists. Such a job never runs. */
export type StoredJobKind = JobKind | "enrich";

/** The error `failRetiredKinds` gives a queued or running job of a removed kind. */
export const RETIRED_KIND_ERROR = "enrich was removed; this job will not run";

const JOB_KINDS: readonly JobKind[] = ["implement", "await_review", "fix", "restart", "chat"];

export type JobStatus = "queued" | "running" | "succeeded" | "failed" | "publish_failed" | "skipped";

export interface Job {
  id: number;
  issueId: string;
  identifier: string;
  teamKey: string;
  kind: StoredJobKind;
  subject: string | null;
  trigger: TriggerEvent;
  status: JobStatus;
  attempts: number;
  implementResult: StoredImplement | null;
  /** A fix job's validated result or hand-back, so a retry publishes it instead of running the brain again. */
  fixResult: StoredFix | null;
  /** A chat job's reply, stored before it is posted, so a retry posts it instead of running the brain again. */
  chatResult: StoredChat | null;
  branch: string | null;
  commitSha: string | null;
  pushedAt: string | null;
  /** The brain session this job's run left, for the fix loop to resume. */
  sessionId: string | null;
  /** The worktree (`work/<name>`) an implement job ran in; its session is keyed by that path. */
  worktreeName: string | null;
  /** The base commit an implement job's worktree started from. */
  baseSha: string | null;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  notBefore: string | null;
  /** A GitLab webhook woke the loop while this job ran: its deferral comes due at once instead of after the poll interval. */
  wakeRequested: boolean;
  /** The slot the job was claimed on (each worker lane's own; 1 for inline runs); `acquireLease` skips a running job's. */
  slot: number | null;
  /** The run (`<jobId>-<attempt>`) the job's latest attempt executes as a run pod; null on the local runtime. */
  runId: string | null;
  /**
   * Stored columns holding JSON that cannot be read: a bad result is null, a bad trigger is a bare `cli` trigger built from
   * the row's columns. Such a job must fail, not run.
   */
  unreadable: StoredColumn[];
}

export type StoredColumn = "trigger" | "implement_result" | "fix_result" | "chat_result";

interface JobRow {
  id: number;
  issue_id: string;
  identifier: string;
  team_key: string;
  kind: StoredJobKind;
  subject: string | null;
  trigger: string;
  status: JobStatus;
  attempts: number;
  implement_result: string | null;
  fix_result: string | null;
  chat_result: string | null;
  branch: string | null;
  commit_sha: string | null;
  pushed_at: string | null;
  session_id: string | null;
  worktree_name: string | null;
  base_sha: string | null;
  error: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  not_before: string | null;
  wake_requested: number;
  slot: number | null;
  run_id: string | null;
}

const TRIGGER_KINDS = new Set<string>(["cli", "linear", "loop", "chat"]);

/** Kinds of the label trigger, removed when assignment in Linear replaced it; their jobs still read and run. */
const LEGACY_LABEL_KINDS = new Set<string>(["issue.created", "issue.labeled"]);

/** A stored label trigger as today's: its implement as a Linear implement with no agent session, anything else as a bare CLI trigger. */
const fromLabelTrigger = (row: JobRow, value: object): TriggerEvent => {
  const ticket = { issueId: row.issue_id, identifier: row.identifier, teamKey: row.team_key };
  return "action" in value && value.action === "implement" ? { kind: "linear", run: "implement", ...ticket, sessionId: null, message: null } : { kind: "cli", ...ticket };
};

/** The stored trigger, or (noted in `unreadable`) a stand-in from the row's own columns when it is not a trigger object. */
const readTrigger = (row: JobRow, unreadable: StoredColumn[]): TriggerEvent => {
  try {
    const value: unknown = JSON.parse(row.trigger);
    if (typeof value === "object" && value !== null && "kind" in value && typeof value.kind === "string") {
      if (TRIGGER_KINDS.has(value.kind)) return value as TriggerEvent;
      if (LEGACY_LABEL_KINDS.has(value.kind)) return fromLabelTrigger(row, value);
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
    implementResult: readStored(row.implement_result, "implement_result", StoredImplementSchema, unreadable),
    fixResult: readStored(row.fix_result, "fix_result", StoredFixSchema, unreadable),
    chatResult: readStored(row.chat_result, "chat_result", StoredChatSchema, unreadable),
    branch: row.branch,
    commitSha: row.commit_sha,
    pushedAt: row.pushed_at,
    sessionId: row.session_id,
    worktreeName: row.worktree_name,
    baseSha: row.base_sha,
    error: row.error,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    notBefore: row.not_before,
    wakeRequested: row.wake_requested === 1,
    slot: row.slot,
    runId: row.run_id,
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

/**
 * A loop step runs as its own job kind (`await` as `await_review`), with the loop as subject so its steps never overlap.
 * A chat on a loop's ticket takes the loop as subject too; without a loop the ticket (issue_id) serializes it.
 */
const jobColumns = (event: TriggerEvent): JobColumns => {
  const ticket = { issueId: event.issueId, identifier: event.identifier, teamKey: event.teamKey };
  if (event.kind === "loop") return { ...ticket, kind: event.step === "await" ? "await_review" : event.step, subject: loopSubject(event.loopId) };
  if (event.kind === "chat") return { ...ticket, kind: "chat", subject: event.loopId === null ? null : loopSubject(event.loopId) };
  // A Linear chat, like an implement, is serialized by its ticket (issue_id).
  if (event.kind === "linear" && event.run === "chat") return { ...ticket, kind: "chat", subject: null };
  return { ...ticket, kind: "implement", subject: null };
};

/** The slot a job claimed by id (`claimById`) runs on. */
export const INLINE_SLOT = 1;

const CLAIM = "UPDATE jobs SET status = 'running', attempts = attempts + 1, wake_requested = 0, started_at = ?, slot = ?";

export class JobStore {
  private readonly insert;
  private readonly selectQueued;
  private readonly selectQueuedForIssue;
  private readonly cancelOne;
  private readonly existsSucceeded;
  private readonly claimOldest;
  private readonly claimOne;
  private readonly selectRunningForIssue;
  private readonly selectRunningSlots;
  private readonly failRetired;
  private readonly storeImplement;
  private readonly storeFix;
  private readonly storeChat;
  private readonly storeCommit;
  private readonly storePushed;
  private readonly storeSession;
  private readonly storeWorkspace;
  private readonly storeRun;
  private readonly selectLatestSession;
  private readonly selectImplementForBranch;
  private readonly selectLatestForTicket;
  private readonly selectLatestOfKind;
  private readonly selectSessionWorktrees;
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
    this.selectQueuedForIssue = db.prepare<[string], JobRow>("SELECT * FROM jobs WHERE issue_id = ? AND status = 'queued' ORDER BY id");
    // Only a job still queued: one a worker claimed meanwhile is running and must be stopped through its run.
    this.cancelOne = db.prepare<[string, string, number]>(
      "UPDATE jobs SET status = 'failed', error = ?, finished_at = ?, not_before = NULL, wake_requested = 0 WHERE id = ? AND status = 'queued'",
    );
    this.existsSucceeded = db.prepare<[string, JobKind], { found: number }>(
      // A handed-back implement job also finishes succeeded; only one that pushed a branch implemented the ticket.
      "SELECT EXISTS (SELECT 1 FROM jobs WHERE issue_id = ? AND status = 'succeeded' AND kind = ? AND (kind <> 'implement' OR pushed_at IS NOT NULL)) AS found",
    );
    // The oldest due job with no running job on the same ticket (issue_id) or on the same non-null subject, and no active
    // `steward chat` lease on its ticket or on the claiming lane's slot: a lease counts as a running job. One statement, and
    // better-sqlite3 is synchronous, so two loops can never claim the same job; `acquireLease` decides in an immediate
    // transaction, so a claim and a lease never both take one slot.
    this.claimOldest = db.prepare<[string, number, string, number, string, number], JobRow>(
      `${CLAIM} WHERE id = (
         SELECT q.id FROM jobs q
         WHERE q.status = 'queued' AND (q.not_before IS NULL OR q.not_before <= ?)
           AND (? = 0 OR q.kind = 'await_review')
           AND NOT EXISTS (
             SELECT 1 FROM jobs r WHERE r.status = 'running' AND (
               r.issue_id = q.issue_id
               OR (q.subject IS NOT NULL AND r.subject = q.subject)))
           AND NOT EXISTS (
             SELECT 1 FROM chat_leases l WHERE l.heartbeat_at >= ? AND (l.issue_id = q.issue_id OR l.slot = ?))
         ORDER BY q.id LIMIT 1)
       RETURNING *`,
    );
    // An inline claim takes slot 1 under run.lock, which `steward chat` never takes, so the lease guard here is what keeps an
    // inline run off a chatting ticket and off the slot a chat holds.
    this.claimOne = db.prepare<[string, number, number, string, number], JobRow>(
      `${CLAIM} WHERE id = ? AND status != 'running'
         AND NOT EXISTS (
           SELECT 1 FROM chat_leases l WHERE l.heartbeat_at >= ? AND (l.issue_id = jobs.issue_id OR l.slot = ?))
       RETURNING *`,
    );
    this.selectRunningForIssue = db.prepare<[string], JobRow>("SELECT * FROM jobs WHERE issue_id = ? AND status = 'running' ORDER BY id LIMIT 1");
    this.selectRunningSlots = db.prepare<[], { slot: number }>("SELECT DISTINCT slot FROM jobs WHERE status = 'running' AND slot IS NOT NULL ORDER BY slot");
    this.failRetired = db.prepare<[string, string]>(
      `UPDATE jobs SET status = 'failed', error = ?, finished_at = ?, wake_requested = 0
       WHERE status IN ('queued', 'running') AND kind NOT IN (${JOB_KINDS.map((kind) => `'${kind}'`).join(", ")})`,
    );
    this.storeImplement = db.prepare<[string, number]>("UPDATE jobs SET implement_result = ? WHERE id = ?");
    this.storeFix = db.prepare<[string, number]>("UPDATE jobs SET fix_result = ? WHERE id = ?");
    this.storeChat = db.prepare<[string, number]>("UPDATE jobs SET chat_result = ? WHERE id = ?");
    this.storeCommit = db.prepare<[string, string, number]>("UPDATE jobs SET branch = ?, commit_sha = ?, pushed_at = NULL WHERE id = ?");
    this.storePushed = db.prepare<[string, number]>("UPDATE jobs SET pushed_at = ? WHERE id = ?");
    this.storeSession = db.prepare<[string, number]>("UPDATE jobs SET session_id = ? WHERE id = ?");
    this.storeWorkspace = db.prepare<[string, string, number]>("UPDATE jobs SET worktree_name = ?, base_sha = ? WHERE id = ?");
    this.storeRun = db.prepare<[string, number]>("UPDATE jobs SET run_id = ? WHERE id = ?");
    this.selectLatestSession = db.prepare<[string], JobRow>(
      `SELECT * FROM jobs WHERE issue_id = ? AND kind = 'implement' AND session_id IS NOT NULL AND worktree_name IS NOT NULL
       ORDER BY id DESC LIMIT 1`,
    );
    this.selectImplementForBranch = db.prepare<[string], JobRow>("SELECT * FROM jobs WHERE kind = 'implement' AND branch = ? ORDER BY id DESC LIMIT 1");
    this.selectLatestOfKind = db.prepare<[string, JobKind], JobRow>("SELECT * FROM jobs WHERE issue_id = ? AND kind = ? ORDER BY id DESC LIMIT 1");
    this.selectLatestForTicket = db.prepare<[string, string], JobRow>("SELECT * FROM jobs WHERE issue_id = ? OR identifier = ? COLLATE NOCASE ORDER BY id DESC LIMIT 1");
    // A session's last activity is its ticket's: any later job on the ticket (a fix round, a chat) may have resumed it.
    this.selectSessionWorktrees = db.prepare<[string], { worktree_name: string }>(
      `SELECT DISTINCT j.worktree_name FROM jobs j
       WHERE j.session_id IS NOT NULL AND j.worktree_name IS NOT NULL
         AND EXISTS (SELECT 1 FROM jobs a WHERE a.issue_id = j.issue_id AND COALESCE(a.finished_at, a.started_at, a.created_at) >= ?)
       ORDER BY j.worktree_name`,
    );
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
       WHERE subject = ? AND status IN ('queued', 'running') AND kind <> 'chat'`,
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

  findQueued(issueId: string, kind: JobKind = "implement"): Job | null {
    const row = this.selectQueued.get(issueId, kind);
    return row === undefined ? null : toJob(row);
  }

  /** The ticket's queued jobs, oldest first. */
  queuedForIssue(issueId: string): Job[] {
    return this.selectQueuedForIssue.all(issueId).map(toJob);
  }

  /** Fails a job that is still queued, so it never runs; false when it is not queued (a worker may have just claimed it). */
  cancelQueued(id: number, error: string): boolean {
    return this.cancelOne.run(error, nowIso(), id).changes === 1;
  }

  hasSucceeded(issueId: string, kind: JobKind = "implement"): boolean {
    return this.existsSucceeded.get(issueId, kind)?.found === 1;
  }

  saveImplementResult(id: number, stored: StoredImplement): void {
    this.storeImplement.run(JSON.stringify(stored), id);
  }

  saveFixResult(id: number, stored: StoredFix): void {
    this.storeFix.run(JSON.stringify(stored), id);
  }

  saveChatResult(id: number, stored: StoredChat): void {
    this.storeChat.run(JSON.stringify(stored), id);
  }

  /** The commit about to be pushed; clears `pushedAt` until `markPushed`, so a push that never lands is not read as pushed. */
  recordCommit(id: number, branch: string, sha: string): void {
    this.storeCommit.run(branch, sha, id);
  }

  markPushed(id: number): void {
    this.storePushed.run(nowIso(), id);
  }

  recordSession(id: number, sessionId: string): void {
    this.storeSession.run(sessionId, id);
  }

  /** Where an implement job's worktree is and which commit it started from, recorded before its brain runs. */
  recordWorkspace(id: number, worktreeName: string, baseSha: string): void {
    this.storeWorkspace.run(worktreeName, baseSha, id);
  }

  /** The run pod the job's current attempt runs as, recorded before the pod is created so a restart can find it. */
  recordRun(id: number, runId: string): void {
    this.storeRun.run(runId, id);
  }

  /** The ticket's newest implement job that left a brain session in a recorded worktree. */
  latestImplementSession(issueId: string): Job | null {
    const row = this.selectLatestSession.get(issueId);
    return row === undefined ? null : toJob(row);
  }

  /** The ticket's newest job of `kind`, whatever its status. */
  latestOfKind(issueId: string, kind: JobKind): Job | null {
    const row = this.selectLatestOfKind.get(issueId, kind);
    return row === undefined ? null : toJob(row);
  }

  /** The newest implement job that recorded `branch` as its push; chat finds a loop-less ticket by its MR's branch. */
  latestImplementForBranch(branch: string): Job | null {
    const row = this.selectImplementForBranch.get(branch);
    return row === undefined ? null : toJob(row);
  }

  /** The ticket (issue UUID or key, the key in any case) as the steward's newest job on it recorded it; null when none did. */
  ticketOf(idOrKey: string): { issueId: string; identifier: string } | null {
    const row = this.selectLatestForTicket.get(idOrKey, idOrKey);
    return row === undefined ? null : { issueId: row.issue_id, identifier: row.identifier };
  }

  /** Worktree names of job sessions whose ticket saw activity at or after `since`; retention keeps their session dirs. */
  sessionWorktreesActiveSince(since: Date): string[] {
    return this.selectSessionWorktrees.all(since.toISOString()).map((row) => row.worktree_name);
  }

  /**
   * Claims the oldest due job for the lane on `slot` (default 1); `waitsOnly` limits it to await_review jobs, which poll APIs
   * and need no host resources. Nothing is claimed while a `steward chat` lease holds the slot.
   */
  claimNext(options: { waitsOnly?: boolean; slot?: number } = {}): Job | null {
    const now = new Date();
    const at = now.toISOString();
    const slot = options.slot ?? 1;
    const row = this.claimOldest.get(at, slot, at, options.waitsOnly === true ? 1 : 0, leaseCutoff(now), slot);
    return row === undefined ? null : toJob(row);
  }

  /**
   * Claims one job for an inline run, which uses slot 1 under run.lock; null when it is running, or while a `steward chat`
   * lease holds its ticket or slot 1.
   */
  claimById(id: number): Job | null {
    const now = new Date();
    const row = this.claimOne.get(now.toISOString(), INLINE_SLOT, id, leaseCutoff(now), INLINE_SLOT);
    return row === undefined ? null : toJob(row);
  }

  /** A running job on the ticket, if any: `steward chat` refuses to open while one runs. */
  runningForIssue(issueId: string): Job | null {
    const row = this.selectRunningForIssue.get(issueId);
    return row === undefined ? null : toJob(row);
  }

  /** The slots running jobs were claimed on. */
  runningSlots(): number[] {
    return this.selectRunningSlots.all().map((row) => row.slot);
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

  /** Fails every queued or running job of a kind no worker runs any more (enrich); returns how many. Called at worker start. */
  failRetiredKinds(): number {
    return this.failRetired.run(RETIRED_KIND_ERROR, nowIso()).changes;
  }

  /** Requeues (or, past `maxAttempts`, fails) every running job except those in `keep`: run pods the steward reattached to. */
  requeueInterrupted(maxAttempts: number, keep: readonly number[] = []): { requeued: number; failed: number } {
    if (keep.length > 0) {
      return this.db.transaction(() => {
        const kept = new Set(keep);
        const ids = this.list({ status: "running", limit: Number.MAX_SAFE_INTEGER }).map((job) => job.id).filter((id) => !kept.has(id));
        let requeued = 0;
        for (const id of ids) {
          this.requeueInterruptedJob(id, maxAttempts);
          if (this.get(id)?.status === "queued") requeued += 1;
        }
        return { requeued, failed: ids.length - requeued };
      })();
    }
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
