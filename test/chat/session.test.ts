import { existsSync } from "node:fs";
import { mkdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ensureWorktree, latestSession, retentionProtection } from "../../src/chat/session.js";
import type { StewardConfig } from "../../src/config/schema.js";
import type { PipelineDeps } from "../../src/core/deps.js";
import { Redactor } from "../../src/core/redact.js";
import { openStores, type Stores } from "../../src/store/index.js";
import { createWorktree, sessionProjectDir, sweep } from "../../src/workspace/index.js";
import { tmpRepo, type TmpRepo } from "../fakes/tmpRepo.js";
import { commitFile, git } from "../workspace/helpers.js";

const DAY_MS = 24 * 60 * 60 * 1000;

let repo: TmpRepo;
let stores: Stores;

beforeEach(async () => {
  vi.restoreAllMocks();
  repo = await tmpRepo("");
  stores = openStores(repo.dataDir);
});

afterEach(async () => {
  stores.db.close();
  await repo.cleanup();
});

const daysAgo = (days: number): string => new Date(Date.now() - days * DAY_MS).toISOString();

/** An implement job on `issueId` that ran in `worktreeName` from `baseSha` and left `sessionId`, finished `ageDays` ago. */
const sessionJob = (opts: { issueId?: string; worktreeName: string; sessionId: string; baseSha?: string; ageDays?: number }): number => {
  const issueId = opts.issueId ?? "issue-1";
  const id = stores.jobs.enqueue({ kind: "cli", issueId, identifier: "API-1", teamKey: "API", action: "implement" });
  stores.jobs.recordWorkspace(id, opts.worktreeName, opts.baseSha ?? "b".repeat(40));
  stores.jobs.recordSession(id, opts.sessionId);
  const at = daysAgo(opts.ageDays ?? 0);
  stores.db.prepare("UPDATE jobs SET status = 'succeeded', created_at = ?, started_at = ?, finished_at = ? WHERE id = ?").run(at, at, at, id);
  return id;
};

const loopOn = (implementJobId: number, overrides: { sessionId?: string | null; worktreeName?: string } = {}): number =>
  stores.loops.create({
    issueId: "issue-1",
    identifier: "API-1",
    teamKey: "API",
    implementJobId,
    branch: "fix/API-1-keep",
    baseSha: "b".repeat(40),
    headSha: "h".repeat(40),
    worktreeName: overrides.worktreeName ?? "ticket-API-1",
    labelDriven: true,
    sessionId: overrides.sessionId === undefined ? "session-loop" : overrides.sessionId,
  });

describe("latestSession", () => {
  it("is null for a ticket with no session", () => {
    stores.jobs.enqueue({ kind: "cli", issueId: "issue-1", identifier: "API-1", teamKey: "API", action: "implement" });
    expect(latestSession(stores, "issue-1")).toBeNull();
  });

  it("prefers the loop's session, at the loop's head and branch", () => {
    const jobId = sessionJob({ worktreeName: "ticket-API-1", sessionId: "session-impl" });
    const loopId = loopOn(jobId);

    expect(latestSession(stores, "issue-1")).toEqual({
      sessionId: "session-loop",
      worktreeName: "ticket-API-1",
      headSha: "h".repeat(40),
      branch: "fix/API-1-keep",
      loopId,
      jobId,
    });
  });

  it("falls back to the newest implement job's session when the loop has none", () => {
    const older = sessionJob({ worktreeName: "1-1", sessionId: "session-old" });
    loopOn(older, { sessionId: null });
    const newer = sessionJob({ worktreeName: "2-1", sessionId: "session-new", baseSha: "c".repeat(40) });

    expect(latestSession(stores, "issue-1")).toEqual({ sessionId: "session-new", worktreeName: "2-1", headSha: "c".repeat(40), branch: null, loopId: null, jobId: newer });
  });

  it("takes a job's commit and branch as the head only once its push landed", () => {
    const id = sessionJob({ worktreeName: "1-1", sessionId: "session-1" });
    stores.jobs.recordCommit(id, "fix/API-1-keep", "d".repeat(40));
    expect(latestSession(stores, "issue-1")).toMatchObject({ headSha: "b".repeat(40), branch: null });

    stores.jobs.markPushed(id);
    expect(latestSession(stores, "issue-1")).toMatchObject({ headSha: "d".repeat(40), branch: "fix/API-1-keep" });
  });
});

describe("retentionProtection", () => {
  const config = (dataDir: string, chat?: StewardConfig["chat"]): Pick<StewardConfig, "dataDir" | "retention" | "chat"> => ({
    dataDir,
    retention: { keptWorktrees: 0, days: 30 },
    ...(chat === undefined ? {} : { chat }),
  });

  /** A session dir for `work/<name>` whose mtime is `ageDays` old. */
  const sessionDir = async (name: string, ageDays: number): Promise<string> => {
    const dir = join(repo.dataDir, "sessions", "projects", sessionProjectDir(join(repo.dataDir, "work", name)));
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "session.jsonl"), "{}\n");
    const at = new Date(Date.now() - ageDays * DAY_MS);
    await utimes(dir, at, at);
    return dir;
  };

  const runSweep = (chat?: StewardConfig["chat"]) =>
    sweep({
      workRoot: join(repo.dataDir, "work"),
      jobsDir: join(repo.dataDir, "jobs"),
      keptWorktrees: 0,
      days: 30,
      sessionsDir: join(repo.dataDir, "sessions"),
      ...retentionProtection(stores, config(repo.dataDir, chat)),
    });

  it("keeps a 60-day-old session dir whose worktree was removed, and removes one past 180 days", async () => {
    sessionJob({ issueId: "issue-1", worktreeName: "1-1", sessionId: "session-1", ageDays: 60 });
    sessionJob({ issueId: "issue-2", worktreeName: "2-1", sessionId: "session-2", ageDays: 200 });
    const kept = await sessionDir("1-1", 60);
    const stale = await sessionDir("2-1", 200);

    const removed = await runSweep();

    expect(removed.removedSessionDirs).toEqual([stale]);
    expect(existsSync(kept)).toBe(true);
  });

  it("dates a session by its ticket's latest job, and honours chat.sessionRetentionDays", async () => {
    sessionJob({ issueId: "issue-1", worktreeName: "1-1", sessionId: "session-1", ageDays: 200 });
    // A later job on the ticket (a fix round or a chat) resumed it 100 days ago.
    sessionJob({ issueId: "issue-1", worktreeName: "1-2", sessionId: "session-2", ageDays: 100 });
    const dir = await sessionDir("1-1", 200);

    expect((await runSweep()).removedSessionDirs).toEqual([]);
    expect((await runSweep({ prefix: "/agent", sessionRetentionDays: 90 })).removedSessionDirs).toEqual(expect.arrayContaining([dir]));
  });

  it("keeps a running loop's session dir however old, and an ended loop's for 180 days after its end", async () => {
    const running = loopOn(sessionJob({ worktreeName: "ticket-API-1", sessionId: "s", ageDays: 400 }));
    stores.db.prepare("UPDATE loops SET created_at = ? WHERE id = ?").run(daysAgo(400), running);
    const ended = stores.loops.create({
      issueId: "issue-3",
      identifier: "API-3",
      teamKey: "API",
      implementJobId: sessionJob({ issueId: "issue-3", worktreeName: "x", sessionId: "s3", ageDays: 400 }),
      branch: "fix/API-3-x",
      baseSha: "b".repeat(40),
      headSha: "h".repeat(40),
      worktreeName: "ticket-API-3",
      labelDriven: true,
      sessionId: "s3",
    });
    stores.db.prepare("UPDATE loops SET state = 'merged', created_at = ?, ended_at = ? WHERE id = ?").run(daysAgo(400), daysAgo(150), ended);
    const runningDir = await sessionDir("ticket-API-1", 400);
    const endedDir = await sessionDir("ticket-API-3", 150);

    const removed = await runSweep();

    expect(removed.removedSessionDirs).not.toContain(runningDir);
    expect(removed.removedSessionDirs).not.toContain(endedDir);
  });

  it("keeps the worktree and session of an open steward chat (a live lease), however old", async () => {
    sessionJob({ worktreeName: "1-1", sessionId: "session-1", ageDays: 400 });
    await createWorktree(repo.mirror, join(repo.dataDir, "work"), "1-1", repo.sha);
    const dir = await sessionDir("1-1", 400);
    stores.leases.create({ issueId: "issue-1", worktreeName: "1-1", slot: null, pid: process.pid });

    const removed = await runSweep();

    expect(removed.removedWorktrees).toEqual([]);
    expect(removed.removedSessionDirs).not.toContain(dir);
    expect(existsSync(join(repo.dataDir, "work", "1-1"))).toBe(true);
  });
});

describe("ensureWorktree", () => {
  const deps = (): Pick<PipelineDeps, "config" | "mirror" | "redactor"> => ({
    config: {
      dataDir: repo.dataDir,
      workspace: { fetchUrl: repo.repo, baseBranch: "main", overlayDir: repo.overlayDir, setup: ["touch setup-ran"], setupTimeoutMinutes: 1, keepOnFailure: true },
    } as StewardConfig,
    mirror: repo.mirror,
    redactor: new Redactor([]),
  });
  const placement = { env: { PATH: process.env.PATH ?? "" }, port: 4101, slot: null };
  const workPath = (name: string): string => join(repo.dataDir, "work", name);

  it("recreates a removed worktree at the same path and sha, with the overlay and setup", async () => {
    await writeFile(join(repo.overlayDir, ".env"), "KEY=1\n");
    const older = repo.sha;
    await commitFile(repo.repo, "later.txt", "later\n");
    const created = await createWorktree(repo.mirror, join(repo.dataDir, "work"), "ticket-API-1", older);
    await rm(created.path, { recursive: true, force: true });

    const worktree = await ensureWorktree(deps(), { worktreeName: "ticket-API-1", headSha: older }, placement);

    expect(worktree.path).toBe(workPath("ticket-API-1"));
    expect(worktree.sha).toBe(older);
    expect(await git(worktree.path, ["rev-parse", "HEAD"])).toBe(older);
    expect(await readFile(join(worktree.path, ".env"), "utf8")).toBe("KEY=1\n");
    expect(existsSync(join(worktree.path, "setup-ran"))).toBe(true);
  });

  it("fetches a head the mirror does not have yet before recreating", async () => {
    const head = await commitFile(repo.repo, "pushed.txt", "pushed\n");

    const worktree = await ensureWorktree(deps(), { worktreeName: "1-1", headSha: head }, placement);

    expect(await readFile(join(worktree.path, "pushed.txt"), "utf8")).toBe("pushed\n");
  });

  it("reuses an existing worktree with its uncommitted changes, without setup or moving it", async () => {
    await commitFile(repo.repo, "later.txt", "later\n");
    await repo.mirror.fetch();
    const head = await repo.mirror.resolveSha("main");
    const created = await createWorktree(repo.mirror, join(repo.dataDir, "work"), "ticket-API-1", repo.sha);
    await writeFile(join(created.path, "README.md"), "edited\n");

    const worktree = await ensureWorktree(deps(), { worktreeName: "ticket-API-1", headSha: head }, placement);

    expect(worktree.sha).toBe(repo.sha);
    expect(await readFile(join(worktree.path, "README.md"), "utf8")).toBe("edited\n");
    expect(existsSync(join(worktree.path, "setup-ran"))).toBe(false);
  });

  it("moves a clean worktree that is behind up to the head", async () => {
    const created = await createWorktree(repo.mirror, join(repo.dataDir, "work"), "ticket-API-1", repo.sha);
    const head = await commitFile(repo.repo, "later.txt", "later\n");

    const worktree = await ensureWorktree(deps(), { worktreeName: "ticket-API-1", headSha: head }, placement);

    expect(worktree.path).toBe(created.path);
    expect(worktree.sha).toBe(head);
    expect(await git(worktree.path, ["rev-parse", "HEAD"])).toBe(head);
  });

  it("leaves a worktree with unpushed commits ahead of the head where it is", async () => {
    const created = await createWorktree(repo.mirror, join(repo.dataDir, "work"), "ticket-API-1", repo.sha);
    const local = await commitFile(created.path, "local.txt", "local\n");

    const worktree = await ensureWorktree(deps(), { worktreeName: "ticket-API-1", headSha: repo.sha }, placement);

    expect(worktree.sha).toBe(local);
  });

  it("recreates a directory that is not one of the mirror's worktrees", async () => {
    await mkdir(workPath("ticket-API-1"), { recursive: true });
    await writeFile(join(workPath("ticket-API-1"), "junk"), "x");

    const worktree = await ensureWorktree(deps(), { worktreeName: "ticket-API-1", headSha: repo.sha }, placement);

    expect(await git(worktree.path, ["rev-parse", "HEAD"])).toBe(repo.sha);
    expect(existsSync(join(worktree.path, "junk"))).toBe(false);
  });
});
