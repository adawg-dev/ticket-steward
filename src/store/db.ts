import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { z } from "zod";

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
  not_before TEXT
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

CREATE TABLE IF NOT EXISTS deliveries (
  delivery_id TEXT PRIMARY KEY,
  seen_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tokens (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  access_token TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  app_user_id TEXT
);

CREATE TABLE IF NOT EXISTS oauth_state (
  state TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS flags (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

/** Columns added after the first release; applied to databases created before them. */
const ADDED_COLUMNS: Array<{ table: string; column: string; definition: string }> = [{ table: "jobs", column: "not_before", definition: "TEXT" }];

const TableInfo = z.array(z.object({ name: z.string() }));

const addMissingColumns = (db: Database): void => {
  for (const { table, column, definition } of ADDED_COLUMNS) {
    const present = TableInfo.parse(db.pragma(`table_info(${table})`)).some((row) => row.name === column);
    if (!present) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
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
  return db;
};

export const nowIso = (): string => new Date().toISOString();
