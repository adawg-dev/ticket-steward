import type { PipelineDeps } from "../core/deps.js";
import { closedReason } from "../core/intake.js";
import { transaction } from "../store/index.js";
import type { PushTarget } from "./target.js";

/** Where a push starts: a new branch on the job's base, or the branch's last steward-pushed head; or why it cannot. */
export type PushStart = { kind: "create"; base: string } | { kind: "fastForward"; branch: string; base: string } | { kind: "refused"; reason: string };

/** The remote branch's head, or null when the branch is not there. */
export type RemoteHead = (branch: string) => Promise<string | null>;

/**
 * Everything a push reads or writes outside the worktree and the remote: the push records and the ticket. The store
 * ledger is the steward's own; a run pod's tools sidecar reaches the same records through the dispatcher.
 */
export interface PushLedger {
  /** Settles an unfinished push (remote check through `remoteHead`), then where this push starts. */
  start(target: PushTarget, remoteHead: RemoteHead): Promise<PushStart>;
  /** The ticket's title, for a first push's branch name, and its closed reason, or null when open. */
  ticket(target: PushTarget): Promise<{ title: string; closed: string | null }>;
  /** Records the intent to push before the push, so a push that lands before `landed` is recognized as the steward's. */
  record(target: PushTarget, push: { branch: string; sha: string; previousSha: string | null; note: string | null }): Promise<{ id: number }>;
  /** The recorded push landed. */
  landed(target: PushTarget, id: number, sha: string): Promise<void>;
  /** The recorded push did not land: puts back what the job or loop recorded before it. */
  revert(target: PushTarget, id: number): Promise<void>;
}

type LedgerDeps = Pick<PipelineDeps, "stores" | "tracker">;

/** The job's or loop's push record before this push, put back if the push does not land. */
type Prior = { kind: "loop"; loopId: number; pendingPush: { sha: string; pushed: boolean } | null } | { kind: "job"; jobId: number; branch: string | null; commitSha: string | null; pushed: boolean };

/** Records a landed push everywhere the steward reads it: the push row, the implement job, or the loop's head. */
const markLanded = ({ stores }: Pick<LedgerDeps, "stores">, target: PushTarget, push: { id: number; sha: string }): void => {
  transaction(stores.db, () => {
    stores.pushes.markPushed(push.id);
    // The loop's head moves with the push, so the gate reads it as the loop's own and never as a person's.
    if (target.loopId !== null) stores.loops.update(target.loopId, { pendingPush: { sha: push.sha, pushed: true }, headSha: push.sha });
    else stores.jobs.markPushed(target.jobId);
  });
};

const priorOf = ({ stores }: Pick<LedgerDeps, "stores">, target: PushTarget): Prior => {
  if (target.loopId !== null) return { kind: "loop", loopId: target.loopId, pendingPush: stores.loops.get(target.loopId)?.pendingPush ?? null };
  const job = stores.jobs.get(target.jobId);
  return { kind: "job", jobId: target.jobId, branch: job?.branch ?? null, commitSha: job?.commitSha ?? null, pushed: (job?.pushedAt ?? null) !== null };
};

/**
 * After a push that did not land, so a refused push never reads as unpushed work over a push that did land. A first push
 * has nothing to go back to; its commit stays recorded as not pushed.
 */
const restorePrior = ({ stores }: Pick<LedgerDeps, "stores">, prior: Prior): void => {
  if (prior.kind === "loop") {
    stores.loops.update(prior.loopId, { pendingPush: prior.pendingPush });
    return;
  }
  const { jobId, branch, commitSha } = prior;
  if (branch === null || commitSha === null || !prior.pushed) return;
  transaction(stores.db, () => {
    stores.jobs.recordCommit(jobId, branch, commitSha);
    stores.jobs.markPushed(jobId);
  });
};

/**
 * A push recorded but not marked (the steward stopped between the push and its record): landed when the remote branch
 * is at its commit, so the next push starts from there instead of being refused by the lease.
 */
export const settleUnfinished = async (deps: Pick<LedgerDeps, "stores">, target: PushTarget, remoteHead: RemoteHead): Promise<void> => {
  const latest = deps.stores.pushes.latest(target.jobId);
  if (latest === null || latest.pushedAt !== null) return;
  if ((await remoteHead(latest.branch)) === latest.sha) markLanded(deps, target, latest);
};

/**
 * A loop pushes onto its head; a job that pushed already onto its last push, or onto the head the job recorded when the
 * steward pushed it before push rows existed; otherwise `target` decides.
 */
const startOf = ({ stores }: Pick<LedgerDeps, "stores">, target: PushTarget): PushStart => {
  if (target.loopId !== null) {
    const loop = stores.loops.get(target.loopId);
    if (loop === null) return { kind: "refused", reason: "this run's fix loop no longer exists" };
    return { kind: "fastForward", branch: loop.branch, base: loop.headSha };
  }
  const last = stores.pushes.latestPushed(target.jobId);
  if (last !== null) return { kind: "fastForward", branch: last.branch, base: last.sha };
  const job = stores.jobs.get(target.jobId);
  if (job !== null && job.pushedAt !== null && job.branch !== null && job.commitSha !== null) return { kind: "fastForward", branch: job.branch, base: job.commitSha };
  if (target.mode === "create") return { kind: "create", base: target.baseSha };
  if (target.branch === null) return { kind: "refused", reason: "this run has no branch to push to" };
  return { kind: "fastForward", branch: target.branch, base: target.baseSha };
};

/** The steward's own ledger: its store and its tracker. Priors live with the ledger, for the one push server it serves. */
export const storeLedger = (deps: LedgerDeps): PushLedger => {
  const { stores } = deps;
  const priors = new Map<number, Prior>();
  return {
    start: async (target, remoteHead) => {
      await settleUnfinished(deps, target, remoteHead);
      return startOf(deps, target);
    },
    ticket: async (target) => {
      const ticket = await deps.tracker.fetchTicket(target.issueId);
      return { title: ticket.title, closed: closedReason(target.identifier, ticket.state) };
    },
    record: (target, push) => {
      const prior = priorOf(deps, target);
      const id = transaction(stores.db, () => {
        const pushId = stores.pushes.record({ jobId: target.jobId, loopId: target.loopId, branch: push.branch, sha: push.sha, previousSha: push.previousSha, note: push.note });
        if (target.loopId !== null) stores.loops.update(target.loopId, { pendingPush: { sha: push.sha, pushed: false } });
        else stores.jobs.recordCommit(target.jobId, push.branch, push.sha);
        return pushId;
      });
      priors.set(id, prior);
      return Promise.resolve({ id });
    },
    landed: (target, id, sha) => {
      priors.delete(id);
      markLanded(deps, target, { id, sha });
      return Promise.resolve();
    },
    revert: (_target, id) => {
      const prior = priors.get(id);
      priors.delete(id);
      if (prior !== undefined) restorePrior(deps, prior);
      return Promise.resolve();
    },
  };
};
