import { AttemptStore } from "./attempts.js";
import { openDatabase, type Database } from "./db.js";
import { DeliveryStore } from "./deliveries.js";
import { JobStore } from "./jobs.js";
import { ReproStore } from "./repros.js";

export type { Database } from "./db.js";
export { openDatabase } from "./db.js";
export { JobStore, unreadableOutcome, type Job, type JobStatus } from "./jobs.js";
export { AttemptStore, type Attempt, type AttemptPatch } from "./attempts.js";
export { DeliveryStore } from "./deliveries.js";
export { ReproStore, type ReproRecord } from "./repros.js";

export interface Stores {
  db: Database;
  jobs: JobStore;
  attempts: AttemptStore;
  deliveries: DeliveryStore;
  repros: ReproStore;
}

export const openStores = (dataDir: string): Stores => {
  const db = openDatabase(dataDir);
  return {
    db,
    jobs: new JobStore(db),
    attempts: new AttemptStore(db),
    deliveries: new DeliveryStore(db),
    repros: new ReproStore(db),
  };
};

export const transaction = <T>(db: Database, fn: () => T): T => db.transaction(fn)();
