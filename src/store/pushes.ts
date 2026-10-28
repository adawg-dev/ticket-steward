import { nowIso, type Database } from "./db.js";

/** One push an agent asked for through the push tool: recorded before git runs, marked pushed once it lands. */
export interface Push {
  id: number;
  jobId: number;
  loopId: number | null;
  branch: string;
  sha: string;
  /** The branch head the push fast-forwarded from; null when it created the branch. */
  previousSha: string | null;
  note: string | null;
  createdAt: string;
  pushedAt: string | null;
}

export type NewPush = Pick<Push, "jobId" | "loopId" | "branch" | "sha" | "previousSha" | "note">;

interface PushRow {
  id: number;
  job_id: number;
  loop_id: number | null;
  branch: string;
  sha: string;
  previous_sha: string | null;
  note: string | null;
  created_at: string;
  pushed_at: string | null;
}

const toPush = (row: PushRow): Push => ({
  id: row.id,
  jobId: row.job_id,
  loopId: row.loop_id,
  branch: row.branch,
  sha: row.sha,
  previousSha: row.previous_sha,
  note: row.note,
  createdAt: row.created_at,
  pushedAt: row.pushed_at,
});

export class PushStore {
  private readonly insert;
  private readonly storePushed;
  private readonly selectLatest;
  private readonly selectLatestPushed;
  private readonly selectForJob;

  constructor(db: Database) {
    this.insert = db.prepare<[number, number | null, string, string, string | null, string | null, string]>(
      "INSERT INTO pushes (job_id, loop_id, branch, sha, previous_sha, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    this.storePushed = db.prepare<[string, number]>("UPDATE pushes SET pushed_at = ? WHERE id = ?");
    this.selectLatest = db.prepare<[number], PushRow>("SELECT * FROM pushes WHERE job_id = ? ORDER BY id DESC LIMIT 1");
    this.selectLatestPushed = db.prepare<[number], PushRow>("SELECT * FROM pushes WHERE job_id = ? AND pushed_at IS NOT NULL ORDER BY id DESC LIMIT 1");
    this.selectForJob = db.prepare<[number], PushRow>("SELECT * FROM pushes WHERE job_id = ? ORDER BY id");
  }

  record(input: NewPush): number {
    const { lastInsertRowid } = this.insert.run(input.jobId, input.loopId, input.branch, input.sha, input.previousSha, input.note, nowIso());
    return Number(lastInsertRowid);
  }

  markPushed(id: number): void {
    this.storePushed.run(nowIso(), id);
  }

  /** The job's newest push, landed or not. */
  latest(jobId: number): Push | null {
    const row = this.selectLatest.get(jobId);
    return row === undefined ? null : toPush(row);
  }

  /** The job's newest push that landed. */
  latestPushed(jobId: number): Push | null {
    const row = this.selectLatestPushed.get(jobId);
    return row === undefined ? null : toPush(row);
  }

  forJob(jobId: number): Push[] {
    return this.selectForJob.all(jobId).map(toPush);
  }
}
