import { nowIso, type Database } from "./db.js";

export interface Attempt {
  id: number;
  jobId: number;
  number: number;
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
  setupTail: string | null;
  preWriteDescription: string | null;
  transcriptPath: string | null;
  usage: { inputTokens: number; outputTokens: number; costUsd?: number } | null;
}

export type AttemptPatch = Partial<Pick<Attempt, "error" | "setupTail" | "preWriteDescription" | "transcriptPath" | "usage">>;

interface AttemptRow {
  id: number;
  job_id: number;
  number: number;
  started_at: string;
  finished_at: string | null;
  error: string | null;
  setup_tail: string | null;
  pre_write_description: string | null;
  transcript_path: string | null;
  usage: string | null;
}

const toAttempt = (row: AttemptRow): Attempt => ({
  id: row.id,
  jobId: row.job_id,
  number: row.number,
  startedAt: row.started_at,
  finishedAt: row.finished_at,
  error: row.error,
  setupTail: row.setup_tail,
  preWriteDescription: row.pre_write_description,
  transcriptPath: row.transcript_path,
  usage: row.usage === null ? null : (JSON.parse(row.usage) as Attempt["usage"]),
});

const PATCH_COLUMNS: Record<keyof AttemptPatch, string> = {
  error: "error",
  setupTail: "setup_tail",
  preWriteDescription: "pre_write_description",
  transcriptPath: "transcript_path",
  usage: "usage",
};

const isPatchKey = (key: string): key is keyof AttemptPatch => key in PATCH_COLUMNS;

const columnValues = (patch: AttemptPatch): Array<[string, string | null]> =>
  Object.keys(patch)
    .filter(isPatchKey)
    .map((key) => [PATCH_COLUMNS[key], key === "usage" ? JSON.stringify(patch.usage) : (patch[key] ?? null)]);

export class AttemptStore {
  private readonly insert;
  private readonly selectByJob;

  constructor(private readonly db: Database) {
    this.insert = db.prepare<[number, number, string], AttemptRow>(
      `INSERT INTO attempts (job_id, number, started_at)
       VALUES (?, (SELECT COALESCE(MAX(number), 0) + 1 FROM attempts WHERE job_id = ?), ?) RETURNING *`,
    );
    this.selectByJob = db.prepare<[number], AttemptRow>("SELECT * FROM attempts WHERE job_id = ? ORDER BY number");
  }

  start(jobId: number): Attempt {
    const row = this.insert.get(jobId, jobId, nowIso());
    if (row === undefined) throw new Error("attempt insert returned no row");
    return toAttempt(row);
  }

  /** Records mid-run details without closing the attempt. */
  patch(id: number, patch: AttemptPatch): void {
    this.update(id, columnValues(patch));
  }

  finish(id: number, patch: AttemptPatch): void {
    this.update(id, [["finished_at", nowIso()], ...columnValues(patch)]);
  }

  private update(id: number, columns: Array<[string, string | null]>): void {
    if (columns.length === 0) return;
    this.db.prepare(`UPDATE attempts SET ${columns.map(([column]) => `${column} = ?`).join(", ")} WHERE id = ?`).run(...columns.map(([, value]) => value), id);
  }

  forJob(jobId: number): Attempt[] {
    return this.selectByJob.all(jobId).map(toAttempt);
  }
}
