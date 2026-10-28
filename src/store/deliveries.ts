import { nowIso, type Database } from "./db.js";

const DAY_MS = 24 * 60 * 60 * 1000;

export class DeliveryStore {
  private readonly insert;
  private readonly select;
  private readonly deleteOlder;

  constructor(db: Database) {
    this.insert = db.prepare<[string, string]>("INSERT OR IGNORE INTO deliveries (delivery_id, seen_at) VALUES (?, ?)");
    this.select = db.prepare<[string], { found: number }>("SELECT EXISTS (SELECT 1 FROM deliveries WHERE delivery_id = ?) AS found");
    this.deleteOlder = db.prepare<[string]>("DELETE FROM deliveries WHERE seen_at < ?");
  }

  markSeen(deliveryId: string): boolean {
    return this.insert.run(deliveryId, nowIso()).changes === 1;
  }

  /** Whether `markSeen` recorded this id already; a check before slow work, never instead of `markSeen`. */
  seen(deliveryId: string): boolean {
    return this.select.get(deliveryId)?.found === 1;
  }

  prune(olderThanDays: number): number {
    const cutoff = new Date(Date.now() - olderThanDays * DAY_MS).toISOString();
    return this.deleteOlder.run(cutoff).changes;
  }
}
