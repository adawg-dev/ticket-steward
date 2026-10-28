import type { Stores } from "../store/index.js";

/** How often an open `steward chat` refreshes its lease; `LEASE_STALE_MS` is four missed beats. */
export const HEARTBEAT_MS = 30_000;

export type LeaseResult = { leaseId: number; slot: number } | { busy: string };

/**
 * Takes the ticket for a terminal chat, in one immediate transaction so no worker lane claims the ticket or the slot in
 * between. Refuses while a job on the ticket runs (naming it) or another live lease holds the ticket. The slot is the
 * lowest of 1..`slotCount` that no running job and no live lease holds, or 0 when none is free (or `slotCount` is 0,
 * `--no-slot`): the lease then holds the ticket only. Stale leases (holders that died) are pruned first.
 */
export const acquireLease = (
  stores: Pick<Stores, "db" | "jobs" | "leases">,
  lease: { issueId: string; identifier: string; worktreeName: string; pid?: number },
  slotCount: number,
): LeaseResult =>
  stores.db
    .transaction((): LeaseResult => {
      stores.leases.pruneStale();
      const running = stores.jobs.runningForIssue(lease.issueId);
      if (running !== null) return { busy: `job ${running.id} (${running.kind}) is running for ${lease.identifier}; wait for it to finish` };
      const active = stores.leases.active();
      const holder = active.find((row) => row.issueId === lease.issueId);
      if (holder !== undefined) return { busy: `another steward chat (pid ${holder.pid}) holds ${lease.identifier}` };
      const taken = new Set([...stores.jobs.runningSlots(), ...active.flatMap((row) => (row.slot === null ? [] : [row.slot]))]);
      const slot = Array.from({ length: slotCount }, (_, i) => i + 1).find((n) => !taken.has(n)) ?? 0;
      const leaseId = stores.leases.create({ issueId: lease.issueId, worktreeName: lease.worktreeName, slot: slot === 0 ? null : slot, pid: lease.pid ?? process.pid });
      return { leaseId, slot };
    })
    .immediate();

/** Keeps the lease live until the returned function releases it (exit, error or signal). */
export const holdLease = (stores: Pick<Stores, "leases">, leaseId: number, heartbeatMs = HEARTBEAT_MS): (() => void) => {
  const timer = setInterval(() => {
    try {
      stores.leases.heartbeat(leaseId);
    } catch {
      // A busy database misses one beat; the lease goes stale only after four.
    }
  }, heartbeatMs);
  timer.unref();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    clearInterval(timer);
    stores.leases.release(leaseId);
  };
};
