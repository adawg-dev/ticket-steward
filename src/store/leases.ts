import { nowIso, type Database } from "./db.js";

/** A lease whose holder has not heartbeated for this long is stale: its holder died, and every reader ignores it. */
export const LEASE_STALE_MS = 120_000;

/** A `steward chat` holding a ticket (and, unless it runs with `--no-slot`, a slot) while its terminal session is open. */
export interface ChatLease {
  id: number;
  issueId: string;
  /** The worktree the session runs in; retention keeps it while the lease is active. */
  worktreeName: string;
  /** The slot it holds; null when it runs without slot services. */
  slot: number | null;
  pid: number;
  startedAt: string;
  heartbeatAt: string;
}

interface LeaseRow {
  id: number;
  issue_id: string;
  worktree_name: string;
  slot: number | null;
  pid: number;
  started_at: string;
  heartbeat_at: string;
}

const toLease = (row: LeaseRow): ChatLease => ({
  id: row.id,
  issueId: row.issue_id,
  worktreeName: row.worktree_name,
  slot: row.slot,
  pid: row.pid,
  startedAt: row.started_at,
  heartbeatAt: row.heartbeat_at,
});

/** The oldest heartbeat an active lease may have at `now`; `JobStore`'s claim compares against the same cutoff. */
export const leaseCutoff = (now: Date = new Date()): string => new Date(now.getTime() - LEASE_STALE_MS).toISOString();

export class LeaseStore {
  private readonly insert;
  private readonly touch;
  private readonly remove;
  private readonly selectActive;
  private readonly removeStale;

  constructor(db: Database) {
    this.insert = db.prepare<[string, string, number | null, number, string, string]>(
      "INSERT INTO chat_leases (issue_id, worktree_name, slot, pid, started_at, heartbeat_at) VALUES (?, ?, ?, ?, ?, ?)",
    );
    this.touch = db.prepare<[string, number]>("UPDATE chat_leases SET heartbeat_at = ? WHERE id = ?");
    this.remove = db.prepare<[number]>("DELETE FROM chat_leases WHERE id = ?");
    this.selectActive = db.prepare<[string], LeaseRow>("SELECT * FROM chat_leases WHERE heartbeat_at >= ? ORDER BY id");
    this.removeStale = db.prepare<[string]>("DELETE FROM chat_leases WHERE heartbeat_at < ?");
  }

  /** Records a lease; `acquireLease` decides first, in the same transaction, that the ticket and slot are free. */
  create(lease: Pick<ChatLease, "issueId" | "worktreeName" | "slot" | "pid">): number {
    const now = nowIso();
    return Number(this.insert.run(lease.issueId, lease.worktreeName, lease.slot, lease.pid, now, now).lastInsertRowid);
  }

  /** False when the lease is gone. */
  heartbeat(id: number): boolean {
    return this.touch.run(nowIso(), id).changes === 1;
  }

  release(id: number): void {
    this.remove.run(id);
  }

  /** Deletes stale leases (their holders died); returns how many. */
  pruneStale(now: Date = new Date()): number {
    return this.removeStale.run(leaseCutoff(now)).changes;
  }

  /** Leases heartbeated within `LEASE_STALE_MS`; stale rows are ignored until `pruneStale`. */
  active(now: Date = new Date()): ChatLease[] {
    return this.selectActive.all(leaseCutoff(now)).map(toLease);
  }
}
