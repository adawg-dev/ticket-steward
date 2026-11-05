import type { ModelAnswer } from "../decisions/client.js";
import { nowIso, type Database } from "./db.js";

/** Where a shadow decision was asked: a ticket's first implement, or one work item of a fix round. */
export type DecisionPoint = "intake" | "fix_item";

/** One model's answer to one question set, where it was asked. The input itself is never stored, only its size and hash. */
export interface NewDecision {
  jobId: number;
  issueId: string;
  loopId: number | null;
  round: number | null;
  point: DecisionPoint;
  /** null for intake; the discussion id for a fix item. */
  subject: string | null;
  inputChars: number;
  inputSha256: string;
  answer: ModelAnswer;
}

export class DecisionStore {
  private readonly insert;
  private readonly exists;
  private readonly outcomeAll;
  private readonly outcomeOne;

  constructor(db: Database) {
    this.insert = db.prepare<[string, number, string, number | null, number | null, string, string | null, string, string, string | null, number, number | null, string | null, number, string]>(
      `INSERT INTO decisions (created_at, job_id, issue_id, loop_id, round, point, subject, requested, model, answers, latency_ms, cost, error, input_chars, input_sha256)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.exists = db.prepare<[number, string, string | null, string], { found: number }>(
      "SELECT EXISTS (SELECT 1 FROM decisions WHERE job_id = ? AND point = ? AND subject IS ? AND requested = ?) AS found",
    );
    this.outcomeAll = db.prepare<[string, number, string]>("UPDATE decisions SET outcome = ? WHERE job_id = ? AND point = ?");
    this.outcomeOne = db.prepare<[string, number, string, string]>("UPDATE decisions SET outcome = ? WHERE job_id = ? AND point = ? AND subject = ?");
  }

  has(jobId: number, point: DecisionPoint, subject: string | null, requested: string): boolean {
    return this.exists.get(jobId, point, subject, requested)?.found === 1;
  }

  record(row: NewDecision): void {
    const { answer } = row;
    this.insert.run(
      nowIso(), row.jobId, row.issueId, row.loopId, row.round, row.point, row.subject, answer.requested, answer.model,
      answer.answers === null ? null : JSON.stringify(answer.answers), answer.latencyMs, answer.cost, answer.error, row.inputChars, row.inputSha256,
    );
  }

  /** Sets `outcome` on the job's rows at `point`, and only the `subject`'s when one is given. */
  setOutcome(jobId: number, point: DecisionPoint, outcome: string, subject?: string): void {
    if (subject === undefined) this.outcomeAll.run(outcome, jobId, point);
    else this.outcomeOne.run(outcome, jobId, point, subject);
  }
}
