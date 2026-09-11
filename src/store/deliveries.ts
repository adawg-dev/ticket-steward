import { nowIso, type Database } from "./db.js";

const DAY_MS = 24 * 60 * 60 * 1000;

export class DeliveryStore {
  private readonly insert;
  private readonly deleteOlder;

  constructor(db: Database) {
    this.insert = db.prepare<[string, string]>("INSERT OR IGNORE INTO deliveries (delivery_id, seen_at) VALUES (?, ?)");
    this.deleteOlder = db.prepare<[string]>("DELETE FROM deliveries WHERE seen_at < ?");
  }

  markSeen(deliveryId: string): boolean {
    return this.insert.run(deliveryId, nowIso()).changes === 1;
  }

  prune(olderThanDays: number): number {
    const cutoff = new Date(Date.now() - olderThanDays * DAY_MS).toISOString();
    return this.deleteOlder.run(cutoff).changes;
  }
}
