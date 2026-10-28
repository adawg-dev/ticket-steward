import { statSync } from "node:fs";
import { join } from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { openStores, transaction } from "../../src/store/index.js";
import { createdEvent, freshDataDir } from "./helpers.js";

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("openStores", () => {
  it("two stores on the same data dir see each other's writes", () => {
    const dataDir = freshDataDir();
    const a = openStores(dataDir);
    const b = openStores(dataDir);

    const id = a.jobs.enqueue(createdEvent);
    expect(b.deliveries.markSeen("delivery-1")).toBe(true);

    expect(b.jobs.get(id)?.issueId).toBe("issue-1");
    expect(a.deliveries.markSeen("delivery-1")).toBe(false);
    a.db.close();
    b.db.close();
  });

  it("creates a 0700 data dir and a 0600 database file", () => {
    const dataDir = join(freshDataDir(), "nested", "data");

    const stores = openStores(dataDir);

    expect(statSync(dataDir).mode & 0o777).toBe(0o700);
    expect(statSync(join(dataDir, "steward.db")).mode & 0o777).toBe(0o600);
    stores.db.close();
  });

  it("opens a database from the OAuth era and drops its token tables", () => {
    const dataDir = freshDataDir();
    const legacy = openStores(dataDir);
    const id = legacy.jobs.enqueue(createdEvent);
    legacy.db.exec(`
      CREATE TABLE tokens (id INTEGER PRIMARY KEY CHECK (id = 1), access_token TEXT NOT NULL, refresh_token TEXT NOT NULL, expires_at TEXT NOT NULL, app_user_id TEXT);
      INSERT INTO tokens VALUES (1, 'lin_oauth_access', 'lin_oauth_refresh', '2026-01-01T00:00:00.000Z', 'app-user');
      CREATE TABLE oauth_state (state TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
      CREATE TABLE flags (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO flags VALUES ('auth_broken', '1');
    `);
    legacy.db.close();

    const stores = openStores(dataDir);

    expect(stores.jobs.get(id)?.issueId).toBe("issue-1");
    const tables = stores.db.prepare<[], { name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name);
    expect(tables).not.toContain("tokens");
    expect(tables).not.toContain("oauth_state");
    expect(tables).not.toContain("flags");
    stores.db.close();
  });

  it("adds the job kind and subject columns to an existing database", () => {
    const dir = freshDataDir();
    const old = new BetterSqlite3(join(dir, "steward.db"));
    old.exec(`CREATE TABLE jobs (id INTEGER PRIMARY KEY AUTOINCREMENT, issue_id TEXT NOT NULL, identifier TEXT NOT NULL, team_key TEXT NOT NULL,
      trigger TEXT NOT NULL, status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, session_id TEXT, prompt_body TEXT, result TEXT,
      result_sha TEXT, error TEXT, created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT)`);
    old.prepare("INSERT INTO jobs (issue_id, identifier, team_key, trigger, status, created_at) VALUES ('i', 'API-1', 'API', '{\"kind\":\"cli\",\"issueId\":\"i\",\"identifier\":\"API-1\",\"teamKey\":\"API\"}', 'succeeded', '2026-01-01')").run();
    old.close();
    const stores = openStores(dir);
    expect(stores.jobs.list({ limit: 5 })[0]).toMatchObject({ kind: "enrich", subject: null, wakeRequested: false });
    stores.db.close();
  });

  it("transaction rolls back every write when the callback throws", () => {
    const stores = openStores(freshDataDir());

    expect(() =>
      transaction(stores.db, () => {
        stores.deliveries.markSeen("delivery-1");
        stores.jobs.enqueue(createdEvent);
        throw new Error("abort");
      }),
    ).toThrow();

    expect(stores.deliveries.markSeen("delivery-1")).toBe(true);
    expect(stores.jobs.list({ limit: 10 })).toEqual([]);
    stores.db.close();
  });
});
