import { INTERRUPTED_ERROR } from "../../src/brain/index.js";
import { openStores, type Stores } from "../../src/store/index.js";
import { brainResult, createdEvent, freshDataDir, sessionEvent } from "./helpers.js";

let stores: Stores;

beforeEach(() => {
  vi.restoreAllMocks();
  stores = openStores(freshDataDir());
});

afterEach(() => {
  stores.db.close();
});

describe("JobStore", () => {
  it("enqueue then get returns a queued job carrying the trigger", () => {
    const id = stores.jobs.enqueue(createdEvent);

    const job = stores.jobs.get(id);

    expect(job?.id).toBe(id);
    expect(job?.issueId).toBe("issue-1");
    expect(job?.identifier).toBe("API-1");
    expect(job?.teamKey).toBe("API");
    expect(job?.trigger).toEqual(createdEvent);
    expect(job?.status).toBe("queued");
    expect(job?.attempts).toBe(0);
    expect(job?.sessionId).toBeNull();
    expect(job?.promptBody).toBeNull();
    expect(job?.result).toBeNull();
    expect(job?.resultSha).toBeNull();
    expect(job?.error).toBeNull();
    expect(job?.startedAt).toBeNull();
    expect(job?.finishedAt).toBeNull();
    expect(job?.notBefore).toBeNull();
  });

  it("claimNext returns the oldest queued job and marks it running", () => {
    const first = stores.jobs.enqueue(createdEvent);
    stores.jobs.enqueue(sessionEvent);

    const claimed = stores.jobs.claimNext();

    expect(claimed?.id).toBe(first);
    expect(claimed?.status).toBe("running");
    expect(claimed?.attempts).toBe(1);
    expect(typeof claimed?.startedAt).toBe("string");
    expect(stores.jobs.get(first)?.status).toBe("running");
    expect(stores.jobs.claimNext()?.id).toBe(first + 1);
  });

  it("claimNext on an empty queue returns null", () => {
    expect(stores.jobs.claimNext()).toBeNull();
  });

  it("attachSession updates the queued job for the issue", () => {
    const id = stores.jobs.enqueue(createdEvent);

    stores.jobs.attachSession("issue-1", "session-9", "please look again");

    const job = stores.jobs.get(id);
    expect(job?.sessionId).toBe("session-9");
    expect(job?.promptBody).toBe("please look again");
    expect(stores.jobs.findQueued("issue-1")?.id).toBe(id);
    expect(stores.jobs.findQueued("issue-404")).toBeNull();
  });

  it("hasSucceeded is true only after a job finished succeeded", () => {
    const id = stores.jobs.enqueue(createdEvent);
    stores.jobs.claimNext();
    expect(stores.jobs.hasSucceeded("issue-1")).toBe(false);

    stores.jobs.finish(id, { status: "succeeded" });

    expect(stores.jobs.hasSucceeded("issue-1")).toBe(true);
    expect(stores.jobs.get(id)?.status).toBe("succeeded");
    expect(typeof stores.jobs.get(id)?.finishedAt).toBe("string");
  });

  it("publish_failed job can be claimed again by id", () => {
    const id = stores.jobs.enqueue(createdEvent);
    stores.jobs.claimNext();
    stores.jobs.finish(id, { status: "publish_failed", error: "linear 500" });
    expect(stores.jobs.get(id)?.error).toBe("linear 500");

    const reclaimed = stores.jobs.claimById(id);

    expect(reclaimed?.id).toBe(id);
    expect(reclaimed?.status).toBe("running");
    expect(reclaimed?.attempts).toBe(2);
    expect(stores.jobs.claimById(id)).toBeNull();
    expect(stores.jobs.claimById(999)).toBeNull();
  });

  it("saveResult then get shows the stored result and sha", () => {
    const id = stores.jobs.enqueue(createdEvent);
    stores.jobs.claimNext();

    stores.jobs.saveResult(id, brainResult, "1a2b3c4");

    const job = stores.jobs.get(id);
    expect(job?.result).toEqual(brainResult);
    expect(job?.resultSha).toBe("1a2b3c4");
  });

  it("scheduleRetry keeps the job queued but hidden from claimNext until not_before", () => {
    const id = stores.jobs.enqueue(createdEvent);
    stores.jobs.claimNext();

    stores.jobs.scheduleRetry(id, new Date(Date.now() + 60_000), "mirror fetch failed");

    const job = stores.jobs.get(id);
    expect(job?.status).toBe("queued");
    expect(job?.error).toBe("mirror fetch failed");
    expect(job?.finishedAt).toBeNull();
    expect(job?.notBefore).toEqual(expect.any(String));
    expect(stores.jobs.findQueued("issue-1")?.id).toBe(id);
    expect(stores.jobs.claimNext()).toBeNull();
  });

  it("claimNext claims a scheduled retry once not_before has passed", () => {
    const id = stores.jobs.enqueue(createdEvent);
    stores.jobs.claimNext();
    stores.jobs.scheduleRetry(id, new Date(Date.now() - 1_000), "mirror fetch failed");

    const claimed = stores.jobs.claimNext();

    expect(claimed?.id).toBe(id);
    expect(claimed?.attempts).toBe(2);
  });

  it("requeue puts a finished job back in the queue and refuses a running one", () => {
    const id = stores.jobs.enqueue(createdEvent);
    stores.jobs.claimNext();
    stores.jobs.finish(id, { status: "publish_failed", error: "linear 500" });

    expect(stores.jobs.requeue(id)).toBe(true);

    const job = stores.jobs.get(id);
    expect(job?.status).toBe("queued");
    expect(job?.finishedAt).toBeNull();
    expect(job?.notBefore).toBeNull();
    expect(stores.jobs.claimNext()?.id).toBe(id);
    expect(stores.jobs.requeue(id)).toBe(false);
    expect(stores.jobs.requeue(999)).toBe(false);
  });

  it("requeueInterrupted closes the dangling attempt of a running job", () => {
    const id = stores.jobs.enqueue(createdEvent);
    stores.jobs.claimNext();
    stores.attempts.start(id);

    stores.jobs.requeueInterrupted(3);

    const [attempt] = stores.attempts.forJob(id);
    expect(attempt?.finishedAt).toEqual(expect.any(String));
    expect(attempt?.error).toBe(INTERRUPTED_ERROR);
    expect(stores.jobs.get(id)?.status).toBe("queued");
  });

  it("requeueInterrupted requeues running jobs under the attempt limit and fails the rest", () => {
    const fresh = stores.jobs.enqueue(createdEvent);
    const exhausted = stores.jobs.enqueue(sessionEvent);
    stores.jobs.claimNext();
    stores.jobs.claimNext();
    stores.jobs.finish(exhausted, { status: "publish_failed", error: "e" });
    stores.jobs.claimById(exhausted);
    stores.jobs.finish(exhausted, { status: "publish_failed", error: "e" });
    stores.jobs.claimById(exhausted);
    expect(stores.jobs.get(exhausted)?.attempts).toBe(3);

    const outcome = stores.jobs.requeueInterrupted(3);

    expect(outcome).toEqual({ requeued: 1, failed: 1 });
    expect(stores.jobs.get(fresh)?.status).toBe("queued");
    expect(stores.jobs.get(exhausted)?.status).toBe("failed");
    expect(stores.jobs.get(exhausted)?.error).toBe(INTERRUPTED_ERROR);
  });

  it("list filters by status and returns newest first within the limit", () => {
    const a = stores.jobs.enqueue(createdEvent);
    const b = stores.jobs.enqueue(sessionEvent);
    const c = stores.jobs.enqueue(createdEvent);
    stores.jobs.claimNext();

    const queued = stores.jobs.list({ status: "queued", limit: 10 });
    const all = stores.jobs.list({ limit: 2 });

    expect(queued.length).toBe(2);
    expect(queued[0]?.id).toBe(c);
    expect(queued[1]?.id).toBe(b);
    expect(all.length).toBe(2);
    expect(all[0]?.id).toBe(c);
    expect(all[1]?.id).toBe(b);
    expect(stores.jobs.get(a)?.status).toBe("running");
  });

  it("enqueue of an agent session stores the session id and prompt body", () => {
    const id = stores.jobs.enqueue({ ...sessionEvent, action: "prompted", promptBody: "check auth" });

    const job = stores.jobs.get(id);
    expect(job?.sessionId).toBe("session-1");
    expect(job?.promptBody).toBe("check auth");
  });
});
