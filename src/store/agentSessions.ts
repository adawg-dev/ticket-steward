import { nowIso, type Database } from "./db.js";

/**
 * Linear's agent sessions and their tickets. Linear opens a new session per delegation or mention; every one of a
 * ticket's sessions maps to its one brain session, and activities go to the current (latest recorded) one.
 */
export class AgentSessionStore {
  private readonly insert;
  private readonly selectCurrent;
  private readonly selectIssue;
  private readonly insertUnassigned;
  private readonly deleteUnassigned;
  private readonly selectUnassigned;

  constructor(db: Database) {
    this.insert = db.prepare<[string, string, string, string]>(
      "INSERT OR IGNORE INTO agent_sessions (linear_session_id, issue_id, identifier, created_at) VALUES (?, ?, ?, ?)",
    );
    // rowid breaks a tie between two sessions recorded in the same millisecond: the later insert is the latest.
    this.selectCurrent = db.prepare<[string], { linear_session_id: string }>(
      "SELECT linear_session_id FROM agent_sessions WHERE issue_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1",
    );
    this.selectIssue = db.prepare<[string], { issue_id: string }>("SELECT issue_id FROM agent_sessions WHERE linear_session_id = ?");
    this.insertUnassigned = db.prepare<[string, string]>("INSERT OR IGNORE INTO unassigned_tickets (issue_id, unassigned_at) VALUES (?, ?)");
    this.deleteUnassigned = db.prepare<[string]>("DELETE FROM unassigned_tickets WHERE issue_id = ?");
    this.selectUnassigned = db.prepare<[string], { issue_id: string }>("SELECT issue_id FROM unassigned_tickets WHERE issue_id = ?");
  }

  /**
   * The steward was removed as the ticket's delegate, whether or not it has a loop: until it is delegated again or a
   * mention revives it, prompts are ignored and nothing starts work on it.
   */
  markUnassigned(issueId: string): void {
    this.insertUnassigned.run(issueId, nowIso());
  }

  /** Delegated again, or revived by a mention. */
  clearUnassigned(issueId: string): void {
    this.deleteUnassigned.run(issueId);
  }

  isUnassigned(issueId: string): boolean {
    return this.selectUnassigned.get(issueId) !== undefined;
  }

  /** Records a session on its first event; a later event in it (a prompt) changes nothing, so it does not become current again. */
  record(sessionId: string, issueId: string, identifier: string): void {
    this.insert.run(sessionId, issueId, identifier, nowIso());
  }

  /** The ticket's latest session, where its activities go; null when Linear never opened one for it. */
  current(issueId: string): string | null {
    return this.selectCurrent.get(issueId)?.linear_session_id ?? null;
  }

  issueOf(sessionId: string): string | null {
    return this.selectIssue.get(sessionId)?.issue_id ?? null;
  }
}
