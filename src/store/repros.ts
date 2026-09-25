import { ReproSchema, type Repro } from "../core/result.js";
import { nowIso, type Database } from "./db.js";

export interface ReproRecord {
  issueId: string;
  identifier: string;
  jobId: number;
  sha: string;
  recipe: Repro;
  filesDir: string;
  updatedAt: string;
}

interface ReproRow {
  issue_id: string;
  identifier: string;
  job_id: number;
  sha: string;
  recipe: string;
  files_dir: string;
  updated_at: string;
}

export class ReproStore {
  private readonly write;
  private readonly select;

  constructor(db: Database) {
    this.write = db.prepare<[string, string, number, string, string, string, string]>(
      `INSERT INTO repros (issue_id, identifier, job_id, sha, recipe, files_dir, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (issue_id) DO UPDATE SET identifier = excluded.identifier, job_id = excluded.job_id, sha = excluded.sha,
         recipe = excluded.recipe, files_dir = excluded.files_dir, updated_at = excluded.updated_at`,
    );
    this.select = db.prepare<[string], ReproRow>("SELECT * FROM repros WHERE issue_id = ?");
  }

  upsert(record: Omit<ReproRecord, "updatedAt">): void {
    this.write.run(record.issueId, record.identifier, record.jobId, record.sha, JSON.stringify(record.recipe), record.filesDir, nowIso());
  }

  get(issueId: string): ReproRecord | null {
    const row = this.select.get(issueId);
    if (row === undefined) return null;
    return {
      issueId: row.issue_id,
      identifier: row.identifier,
      jobId: row.job_id,
      sha: row.sha,
      recipe: ReproSchema.parse(JSON.parse(row.recipe)),
      filesDir: row.files_dir,
      updatedAt: row.updated_at,
    };
  }
}
