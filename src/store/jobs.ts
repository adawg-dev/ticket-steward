import type { BrainResult } from "../core/result.js";
import type { JobOutcome } from "../core/types.js";
import type { TriggerEvent } from "../tracker/types.js";
import { nowIso, type Database } from "./db.js";

export type JobStatus = "queued" | "running" | "succeeded" | "failed" | "publish_failed" | "skipped";

export interface Job {
  id: number;
  issueId: string;
  identifier: string;
  teamKey: string;
  trigger: TriggerEvent;
  status: JobStatus;
  attempts: number;
  sessionId: string | null;
  promptBody: string | null;
  result: BrainResult | null;
  resultSha: string | null;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

interface JobRow {
  id: number;
  issue_id: string;
  identifier: string;
  team_key: string;
  trigger: string;
  status: JobStatus;
  attempts: number;
  session_id: string | null;
  prompt_body: string | null;
  result: string | null;
  result_sha: string | null;
  error: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

const toJob = (row: JobRow): Job => ({
  id: row.id,
  issueId: row.issue_id,
  identifier: row.identifier,
  teamKey: row.team_key,
  trigger: JSON.parse(row.trigger) as TriggerEvent,
  status: row.status,
  attempts: row.attempts,
  sessionId: row.session_id,
  promptBody: row.prompt_body,
  result: row.result === null ? null : (JSON.parse(row.result) as BrainResult),
  resultSha: row.result_sha,
  error: row.error,
  createdAt: row.created_at,
  startedAt: row.started_at,
  finishedAt: row.finished_at,
});

const CLAIM = "UPDATE jobs SET status = 'running', attempts = attempts + 1, started_at = ?";

export class JobStore {
  private readonly insert;
  private readonly attach;
  private readonly selectQueued;
  private readonly existsSucceeded;
  private readonly claimOldest;
  private readonly claimOne;
  private readonly storeResult;
  private readonly complete;
  private readonly selectById;
  private readonly selectByStatus;
  private readonly selectAll;
  private readonly requeueRunning;
  private readonly failRunning;

  constructor(private readonly db: Database) {
    this.insert = db.prepare<[string, string, string, string, string | null, string | null, string]>(
      `INSERT INTO jobs (issue_id, identifier, team_key, trigger, status, session_id, prompt_body, created_at)
       VALUES (?, ?, ?, ?, 'queued', ?, ?, ?)`,
    );
    this.attach = db.prepare<[string, string | null, string]>(
      "UPDATE jobs SET session_id = ?, prompt_body = COALESCE(?, prompt_body) WHERE issue_id = ? AND status = 'queued'",
    );
    this.selectQueued = db.prepare<[string], JobRow>(
      "SELECT * FROM jobs WHERE issue_id = ? AND status = 'queued' ORDER BY id LIMIT 1",
    );
    this.existsSucceeded = db.prepare<[string], { found: number }>(
      "SELECT EXISTS (SELECT 1 FROM jobs WHERE issue_id = ? AND status = 'succeeded') AS found",
    );
    this.claimOldest = db.prepare<[string], JobRow>(
      `${CLAIM} WHERE id = (SELECT id FROM jobs WHERE status = 'queued' ORDER BY id LIMIT 1) RETURNING *`,
    );
    this.claimOne = db.prepare<[string, number], JobRow>(`${CLAIM} WHERE id = ? AND status != 'running' RETURNING *`);
    this.storeResult = db.prepare<[string, string, number]>("UPDATE jobs SET result = ?, result_sha = ? WHERE id = ?");
    this.complete = db.prepare<[JobStatus, string | null, string, number]>(
      "UPDATE jobs SET status = ?, error = ?, finished_at = ? WHERE id = ?",
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
  }

  enqueue(event: TriggerEvent): number {
    const sessionId = event.kind === "agent.session" ? event.sessionId : null;
    const promptBody = event.kind === "agent.session" ? (event.promptBody ?? null) : null;
    const { lastInsertRowid } = this.insert.run(
      event.issueId,
      event.identifier,
      event.teamKey,
      JSON.stringify(event),
      sessionId,
      promptBody,
      nowIso(),
    );
    return Number(lastInsertRowid);
  }

  attachSession(issueId: string, sessionId: string, promptBody?: string): void {
    this.attach.run(sessionId, promptBody ?? null, issueId);
  }

  findQueued(issueId: string): Job | null {
    const row = this.selectQueued.get(issueId);
    return row === undefined ? null : toJob(row);
  }

  hasSucceeded(issueId: string): boolean {
    return this.existsSucceeded.get(issueId)?.found === 1;
  }

  claimNext(): Job | null {
    const row = this.claimOldest.get(nowIso());
    return row === undefined ? null : toJob(row);
  }

  claimById(id: number): Job | null {
    const row = this.claimOne.get(nowIso(), id);
    return row === undefined ? null : toJob(row);
  }

  saveResult(id: number, result: BrainResult, sha: string): void {
    this.storeResult.run(JSON.stringify(result), sha, id);
  }

  finish(id: number, outcome: JobOutcome): void {
    const error = outcome.status === "succeeded" ? null : outcome.error;
    this.complete.run(outcome.status, error, nowIso(), id);
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
      const requeued = this.requeueRunning.run(maxAttempts).changes;
      const failed = this.failRunning.run(nowIso()).changes;
      return { requeued, failed };
    })();
  }
}
