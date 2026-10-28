import { acquireLease, holdLease } from "../../src/chat/lease.js";
import { LEASE_STALE_MS, openStores, type Stores } from "../../src/store/index.js";
import { createdEvent, freshDataDir, secondEvent } from "../store/helpers.js";

let stores: Stores;

beforeEach(() => {
  vi.restoreAllMocks();
  stores = openStores(freshDataDir());
});

afterEach(() => {
  vi.useRealTimers();
  stores.db.close();
});

const ticket = { issueId: "issue-1", identifier: "API-1", worktreeName: "ticket-API-1" };

/** Ages a lease's heartbeat past the stale limit, as if its holder died. */
const makeStale = (leaseId: number): void => {
  const old = new Date(Date.now() - LEASE_STALE_MS - 1_000).toISOString();
  stores.db.prepare("UPDATE chat_leases SET heartbeat_at = ? WHERE id = ?").run(old, leaseId);
};

describe("acquireLease", () => {
  it("takes the lowest slot no running job holds", () => {
    stores.jobs.enqueue(secondEvent);
    expect(stores.jobs.claimNext({ slot: 1 })?.issueId).toBe("issue-2");

    const lease = acquireLease(stores, ticket, 3);

    expect(lease).toMatchObject({ slot: 2 });
    expect(stores.leases.active()).toEqual([expect.objectContaining({ issueId: "issue-1", worktreeName: "ticket-API-1", slot: 2, pid: process.pid })]);
  });

  it("skips slots other chats hold and answers slot 0 when none is free", () => {
    expect(acquireLease(stores, ticket, 1)).toMatchObject({ slot: 1 });

    const other = acquireLease(stores, { ...ticket, issueId: "issue-2", identifier: "API-2" }, 1);

    expect(other).toMatchObject({ slot: 0 });
    expect(stores.leases.active().map((lease) => lease.slot)).toEqual([1, null]);
  });

  it("holds the ticket only with slotCount 0 (--no-slot)", () => {
    expect(acquireLease(stores, ticket, 0)).toMatchObject({ slot: 0 });
    expect(stores.leases.active()[0]?.slot).toBeNull();
  });

  it("refuses while a job on the ticket runs, naming it", () => {
    const jobId = stores.jobs.enqueue(createdEvent);
    stores.jobs.claimNext();

    expect(acquireLease(stores, ticket, 2)).toEqual({ busy: `job ${jobId} (implement) is running for API-1; wait for it to finish` });
    expect(stores.leases.active()).toEqual([]);
  });

  it("refuses while another chat holds the ticket", () => {
    acquireLease(stores, { ...ticket, pid: 4242 }, 2);

    expect(acquireLease(stores, ticket, 2)).toEqual({ busy: "another steward chat (pid 4242) holds API-1" });
  });

  it("ignores and prunes a stale lease", () => {
    const stale = acquireLease(stores, { ...ticket, pid: 4242 }, 1);
    if (!("leaseId" in stale)) throw new Error("expected a lease");
    makeStale(stale.leaseId);

    expect(acquireLease(stores, ticket, 1)).toMatchObject({ slot: 1 });
    expect(stores.db.prepare("SELECT pid FROM chat_leases").all()).toEqual([{ pid: process.pid }]);
  });
});

describe("holdLease", () => {
  it("heartbeats until released, then deletes the lease", () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const lease = acquireLease(stores, ticket, 1);
    if (!("leaseId" in lease)) throw new Error("expected a lease");
    makeStale(lease.leaseId);
    const release = holdLease(stores, lease.leaseId, 1_000);

    vi.advanceTimersByTime(1_000);
    expect(stores.leases.active()).toHaveLength(1);

    release();
    release();
    expect(stores.db.prepare("SELECT id FROM chat_leases").all()).toEqual([]);
  });
});

describe("JobStore claim with leases", () => {
  it("skips a ticket a live chat holds and claims it once the lease ends", () => {
    const leased = stores.jobs.enqueue(createdEvent);
    const other = stores.jobs.enqueue(secondEvent);
    const lease = acquireLease(stores, ticket, 0);
    if (!("leaseId" in lease)) throw new Error("expected a lease");

    expect(stores.jobs.claimNext({ slot: 1 })?.id).toBe(other);
    expect(stores.jobs.claimNext({ slot: 2 })).toBeNull();

    stores.leases.release(lease.leaseId);
    expect(stores.jobs.claimNext({ slot: 2 })).toMatchObject({ id: leased, slot: 2 });
  });

  it("claims nothing on a slot a live chat leased; other slots still claim", () => {
    const jobId = stores.jobs.enqueue(secondEvent);
    expect(acquireLease(stores, ticket, 1)).toMatchObject({ slot: 1 });

    expect(stores.jobs.claimNext({ slot: 1 })).toBeNull();
    expect(stores.jobs.claimNext({ slot: 2 })?.id).toBe(jobId);
  });

  it("ignores a stale lease", () => {
    const jobId = stores.jobs.enqueue(createdEvent);
    const lease = acquireLease(stores, ticket, 1);
    if (!("leaseId" in lease)) throw new Error("expected a lease");
    makeStale(lease.leaseId);

    expect(stores.jobs.claimNext({ slot: 1 })?.id).toBe(jobId);
  });
});
