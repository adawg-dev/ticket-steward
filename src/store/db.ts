import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { z } from "zod";
import { sessionProjectDir } from "../workspace/retention.js";

export type Database = BetterSqlite3.Database;

const MIGRATIONS = `
CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  issue_id TEXT NOT NULL,
  identifier TEXT NOT NULL,
  team_key TEXT NOT NULL,
  trigger TEXT NOT NULL,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  session_id TEXT,
  prompt_body TEXT,
  result TEXT,
  result_sha TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  not_before TEXT,
  kind TEXT NOT NULL DEFAULT 'enrich',
  subject TEXT,
  review_result TEXT,
  implement_result TEXT,
  branch TEXT,
  commit_sha TEXT,
  pushed_at TEXT,
  fix_result TEXT,
  wake_requested INTEGER NOT NULL DEFAULT 0,
  worktree_name TEXT,
  base_sha TEXT,
  chat_result TEXT,
  slot INTEGER,
  run_id TEXT
);
CREATE INDEX IF NOT EXISTS jobs_issue_status ON jobs (issue_id, status);
CREATE INDEX IF NOT EXISTS jobs_status ON jobs (status);

CREATE TABLE IF NOT EXISTS attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL REFERENCES jobs (id),
  number INTEGER NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  error TEXT,
  setup_tail TEXT,
  pre_write_description TEXT,
  transcript_path TEXT,
  usage TEXT
);
CREATE INDEX IF NOT EXISTS attempts_job ON attempts (job_id);

CREATE TABLE IF NOT EXISTS loops (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  issue_id TEXT NOT NULL,
  identifier TEXT NOT NULL,
  team_key TEXT NOT NULL,
  implement_job_id INTEGER NOT NULL REFERENCES jobs (id),
  branch TEXT NOT NULL,
  base_sha TEXT NOT NULL,
  head_sha TEXT NOT NULL,
  worktree_name TEXT NOT NULL,
  label_driven INTEGER NOT NULL,
  project_id INTEGER,
  mr_iid INTEGER,
  mr_url TEXT,
  session_id TEXT,
  round INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL,
  history TEXT NOT NULL DEFAULT '[]',
  decisions TEXT NOT NULL DEFAULT '[]',
  wait_started_at TEXT,
  review_count_at_trigger INTEGER,
  adopted_from TEXT,
  pending_push TEXT,
  handed_back_at TEXT,
  pending_notes_since TEXT,
  ended_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS loops_issue ON loops (issue_id);
CREATE INDEX IF NOT EXISTS loops_state ON loops (state);

CREATE TABLE IF NOT EXISTS pushes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL REFERENCES jobs (id),
  loop_id INTEGER REFERENCES loops (id),
  branch TEXT NOT NULL,
  sha TEXT NOT NULL,
  previous_sha TEXT,
  note TEXT,
  created_at TEXT NOT NULL,
  pushed_at TEXT
);
CREATE INDEX IF NOT EXISTS pushes_job ON pushes (job_id);

CREATE TABLE IF NOT EXISTS chat_leases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  issue_id TEXT NOT NULL,
  worktree_name TEXT NOT NULL,
  slot INTEGER,
  pid INTEGER NOT NULL,
  started_at TEXT NOT NULL,
  heartbeat_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS run_tokens (
  run_id TEXT NOT NULL,
  role TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (run_id, role)
);

CREATE TABLE IF NOT EXISTS deliveries (
  delivery_id TEXT PRIMARY KEY,
  seen_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_sessions (
  linear_session_id TEXT PRIMARY KEY,
  issue_id TEXT NOT NULL,
  identifier TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS agent_sessions_issue ON agent_sessions (issue_id);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT NOT NULL,
  old_value TEXT,
  new_value TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;

/** Columns added after the first release; applied to databases created before them. */
const ADDED_COLUMNS: Array<{ table: string; column: string; definition: string }> = [
  { table: "jobs", column: "not_before", definition: "TEXT" },
  { table: "jobs", column: "kind", definition: "TEXT NOT NULL DEFAULT 'enrich'" },
  { table: "jobs", column: "subject", definition: "TEXT" },
  { table: "jobs", column: "review_result", definition: "TEXT" },
  { table: "jobs", column: "implement_result", definition: "TEXT" },
  { table: "jobs", column: "branch", definition: "TEXT" },
  { table: "jobs", column: "commit_sha", definition: "TEXT" },
  { table: "jobs", column: "pushed_at", definition: "TEXT" },
  { table: "jobs", column: "fix_result", definition: "TEXT" },
  { table: "jobs", column: "wake_requested", definition: "INTEGER NOT NULL DEFAULT 0" },
  { table: "jobs", column: "worktree_name", definition: "TEXT" },
  { table: "jobs", column: "base_sha", definition: "TEXT" },
  { table: "jobs", column: "chat_result", definition: "TEXT" },
  { table: "jobs", column: "slot", definition: "INTEGER" },
  { table: "jobs", column: "run_id", definition: "TEXT" },
  { table: "loops", column: "decisions", definition: "TEXT NOT NULL DEFAULT '[]'" },
  { table: "loops", column: "pending_notes_since", definition: "TEXT" },
];

/** Indexes on added columns; created after addMissingColumns so older databases have the columns first. */
const POST_MIGRATIONS = "CREATE INDEX IF NOT EXISTS jobs_subject_status ON jobs (subject, status);";

/**
 * Tables of removed features: the Linear OAuth flow (dropped so stored OAuth tokens do not linger on disk) and the MR
 * reviewer's repro replay.
 */
const DROPPED_TABLES = ["tokens", "oauth_state", "flags", "repros"];

/** The MR reviewer is gone, so no worker can run a review job; one left queued or running fails instead. */
const FAIL_REMOVED_REVIEWS =
  "UPDATE jobs SET status = 'failed', error = 'MR review was removed', finished_at = ? WHERE kind = 'review' AND status IN ('queued', 'running')";

const TableInfo = z.array(z.object({ name: z.string() }));

const addMissingColumns = (db: Database): void => {
  for (const { table, column, definition } of ADDED_COLUMNS) {
    const present = TableInfo.parse(db.pragma(`table_info(${table})`)).some((row) => row.name === column);
    if (!present) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
};

const dropRemovedTables = (db: Database): void => {
  for (const table of DROPPED_TABLES) db.exec(`DROP TABLE IF EXISTS ${table}`);
};

const LegacySessionJobs = z.array(
  z.object({ id: z.number(), identifier: z.string(), attempts: z.number(), session_id: z.string(), implement_result: z.string().nullable() }),
);

/** The `baseSha` a stored implement result carries, or null. */
const storedBaseSha = (raw: string | null): string | null => {
  if (raw === null) return null;
  try {
    const value: unknown = JSON.parse(raw);
    return typeof value === "object" && value !== null && "baseSha" in value && typeof value.baseSha === "string" ? value.baseSha : null;
  } catch {
    return null;
  }
};

/**
 * Implement jobs from before `worktree_name`/`base_sha` were recorded: the worktree is whichever name it could have had (the
 * ticket's stable one, `stableWorktreeName`, or `<id>-<attempt>`) that holds the job's session transcript; the base comes from the stored result.
 * A job with no transcript on disk stays as it is.
 */
const backfillJobWorkspaces = (db: Database, dataDir: string): void => {
  const rows = LegacySessionJobs.parse(
    db
      .prepare("SELECT id, identifier, attempts, session_id, implement_result FROM jobs WHERE kind = 'implement' AND session_id IS NOT NULL AND worktree_name IS NULL")
      .all(),
  );
  const update = db.prepare<[string, string | null, number]>("UPDATE jobs SET worktree_name = ?, base_sha = COALESCE(base_sha, ?) WHERE id = ?");
  for (const row of rows) {
    const candidates = [`ticket-${row.identifier}`, ...Array.from({ length: row.attempts }, (_, i) => `${row.id}-${row.attempts - i}`)];
    const name = candidates.find((candidate) =>
      existsSync(join(dataDir, "sessions", "projects", sessionProjectDir(join(dataDir, "work", candidate)), `${row.session_id}.jsonl`)),
    );
    if (name !== undefined) update.run(name, storedBaseSha(row.implement_result), row.id);
  }
};

export const DB_FILENAME = "steward.db";

export const openDatabase = (dataDir: string): Database => {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const file = join(dataDir, DB_FILENAME);
  const db = new BetterSqlite3(file);
  chmodSync(file, 0o600);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.exec(MIGRATIONS);
  addMissingColumns(db);
  db.prepare(FAIL_REMOVED_REVIEWS).run(nowIso());
  db.exec(POST_MIGRATIONS);
  dropRemovedTables(db);
  backfillJobWorkspaces(db, dataDir);
  return db;
};

export const nowIso = (): string => new Date().toISOString();

type StoredSchema<T> = { safeParse: (value: unknown) => { success: true; data: T } | { success: false } };

/** One JSON column read through its schema: JSON the schema rejects is noted in `unreadable` and read as null instead of thrown. */
export const readStored = <T, C extends string>(raw: string | null, column: C, schema: StoredSchema<T>, unreadable: C[]): T | null => {
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
