import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { nowIso, type Database } from "./db.js";

/** Who holds a run's token: the agent container (it may only post the run's report) or the tools sidecar (pushes, the work report). */
export type RunTokenRole = "runner" | "tools";

const sha256 = (value: string): Buffer => createHash("sha256").update(value, "utf8").digest();

/**
 * Per-run bearer tokens for the internal run API. Only their sha256 is stored, so the database never holds a usable
 * token; they are kept across a dispatcher restart (a reattached run pod still holds them) and revoked when the run ends.
 */
export class RunTokens {
  private readonly insert;
  private readonly select;
  private readonly remove;
  private readonly selectRuns;

  constructor(db: Database) {
    this.insert = db.prepare<[string, string, string, string]>(
      "INSERT OR REPLACE INTO run_tokens (run_id, role, token_hash, created_at) VALUES (?, ?, ?, ?)",
    );
    this.select = db.prepare<[string, string], { token_hash: string }>("SELECT token_hash FROM run_tokens WHERE run_id = ? AND role = ?");
    this.remove = db.prepare<[string]>("DELETE FROM run_tokens WHERE run_id = ?");
    this.selectRuns = db.prepare<[], { run_id: string }>("SELECT DISTINCT run_id FROM run_tokens ORDER BY run_id");
  }

  /** A new token for the run's role; one issued before for the same role stops working. */
  issue(runId: string, role: RunTokenRole): string {
    const token = randomBytes(32).toString("base64url");
    this.insert.run(runId, role, sha256(token).toString("hex"), nowIso());
    return token;
  }

  verify(runId: string, role: RunTokenRole, token: string): boolean {
    const row = this.select.get(runId, role);
    if (row === undefined) return false;
    const stored = Buffer.from(row.token_hash, "hex");
    const given = sha256(token);
    return stored.length === given.length && timingSafeEqual(stored, given);
  }

  /** The runs that hold tokens: those not yet revoked. */
  runIds(): string[] {
    return this.selectRuns.all().map((row) => row.run_id);
  }

  /** Both of the run's tokens stop working. */
  revoke(runId: string): void {
    this.remove.run(runId);
  }
}
