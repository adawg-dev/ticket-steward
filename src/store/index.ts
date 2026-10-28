import { AttemptStore } from "./attempts.js";
import { openDatabase, type Database } from "./db.js";
import { DeliveryStore } from "./deliveries.js";
import { JobStore } from "./jobs.js";
import { LoopStore } from "./loops.js";
import { PushStore } from "./pushes.js";

export type { Database } from "./db.js";
export { openDatabase } from "./db.js";
export { JobStore, loopSubject, RETIRED_KIND_ERROR, unreadableOutcome, type Job, type JobKind, type JobStatus, type StoredJobKind } from "./jobs.js";
export {
  ACTIVE_LOOP_STATES,
  LoopStore,
  type Loop,
  type LoopPatch,
  type LoopRound,
  type LoopState,
  type NewLoop,
} from "./loops.js";
export { AttemptStore, type Attempt, type AttemptPatch } from "./attempts.js";
export { DeliveryStore } from "./deliveries.js";
export { PushStore, type NewPush, type Push } from "./pushes.js";

export interface Stores {
  db: Database;
  jobs: JobStore;
  attempts: AttemptStore;
  deliveries: DeliveryStore;
  loops: LoopStore;
  pushes: PushStore;
}

export const openStores = (dataDir: string): Stores => {
  const db = openDatabase(dataDir);
  return {
    db,
    jobs: new JobStore(db),
    attempts: new AttemptStore(db),
    deliveries: new DeliveryStore(db),
    loops: new LoopStore(db),
    pushes: new PushStore(db),
  };
};

export const transaction = <T>(db: Database, fn: () => T): T => db.transaction(fn)();
