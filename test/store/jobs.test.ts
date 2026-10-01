import { INTERRUPTED_ERROR } from "../../src/brain/index.js";
import { openStores, type Stores } from "../../src/store/index.js";
import { reviewSubject } from "../../src/store/jobs.js";
import type { ReviewTrigger, TriggerEvent } from "../../src/tracker/types.js";
import { brainResult, createdEvent, freshDataDir, secondEvent } from "./helpers.js";

let stores: Stores;

beforeEach(() => {
  vi.restoreAllMocks();
  stores = openStores(freshDataDir());
});

afterEach(() => {
  stores.db.close();
});

describe("JobStore", () => {
  it("loads a job whose stored results are unreadable, nulls them and names the columns, and still lists every job", () => {
    const good = stores.jobs.enqueue(createdEvent);
    const bad = stores.jobs.enqueue(secondEvent);
    stores.db.prepare("UPDATE jobs SET result = ?, implement_result = ? WHERE id = ?").run('{"summary":1}', "not json", bad);

    expect(stores.jobs.list({ limit: 10 }).map((job) => job.id)).toEqual([bad, good]);
    const job = stores.jobs.get(bad);
    expect(job?.result).toBeNull();
    expect(job?.implementResult).toBeNull();
    expect(job?.unreadable).toEqual(["result", "implement_result"]);
    expect(stores.jobs.get(good)?.unreadable).toEqual([]);
    expect(stores.jobs.claimNext()?.id).toBe(good);
    expect(stores.jobs.claimNext()?.unreadable).toEqual(["result", "implement_result"]);
  });

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
    expect(job?.result).toBeNull();
    expect(job?.resultSha).toBeNull();
    expect(job?.error).toBeNull();
    expect(job?.startedAt).toBeNull();
    expect(job?.finishedAt).toBeNull();
    expect(job?.notBefore).toBeNull();
  });

  it("loads a job whose stored trigger is unreadable and names the column", () => {
    const good = stores.jobs.enqueue(createdEvent);
    const bad = stores.jobs.enqueue(secondEvent);
    stores.db.prepare("UPDATE jobs SET trigger = ? WHERE id = ?").run("{not json", bad);

    expect(stores.jobs.list({ limit: 10 }).map((job) => job.id)).toEqual([bad, good]);
    const job = stores.jobs.get(bad);
    expect(job?.unreadable).toEqual(["trigger"]);
    expect(job?.issueId).toBe("issue-2");
    expect(job?.trigger).toEqual({ kind: "cli", issueId: "issue-2", identifier: job?.identifier, teamKey: job?.teamKey });
    stores.db.prepare("UPDATE jobs SET trigger = ? WHERE id = ?").run('{"kind":"nope"}', good);
    expect(stores.jobs.get(good)?.unreadable).toEqual(["trigger"]);
  });

  it("claimNext returns the oldest queued job and marks it running", () => {
    const first = stores.jobs.enqueue(createdEvent);
    stores.jobs.enqueue(secondEvent);

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

  it("findQueued returns the queued job for the issue", () => {
    const id = stores.jobs.enqueue(createdEvent);

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

  it("releaseClaim puts a claimed job back in the queue and refunds the claimed attempt", () => {
    const id = stores.jobs.enqueue(createdEvent);
    stores.jobs.claimNext();

    stores.jobs.releaseClaim(id, "linear 401");

    const job = stores.jobs.get(id);
    expect(job?.status).toBe("queued");
    expect(job?.attempts).toBe(0);
    expect(job?.error).toBe("linear 401");
    expect(job?.notBefore).toBeNull();
    expect(stores.jobs.claimNext()?.id).toBe(id);
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
    const exhausted = stores.jobs.enqueue(secondEvent);
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
    const b = stores.jobs.enqueue(secondEvent);
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
});

const review = (headSha: string, deliveryId = `d-${headSha}`): ReviewTrigger => ({
  kind: "mr.review",
  deliveryId,
  projectId: 42,
  projectPath: "acme/repo",
  mrIid: 7,
  mrUrl: "https://gitlab.example/acme/repo/-/merge_requests/7",
  headSha,
  linearKey: "API-1",
  teamKey: "API",
  reason: "push",
});

describe("review jobs", () => {
  it("stores kind and subject", () => {
    const id = stores.jobs.enqueue(review("a".repeat(40)));
    expect(stores.jobs.get(id)).toMatchObject({ kind: "review", subject: "mr:42!7", issueId: "API-1", identifier: "API-1", teamKey: "API" });
    expect(stores.jobs.get(stores.jobs.enqueue(createdEvent))).toMatchObject({ kind: "enrich", subject: null });
  });

  it("keeps enrichment dedupe blind to review jobs", () => {
    const id = stores.jobs.enqueue({ ...review("a".repeat(40)), linearKey: "issue-1" });
    stores.jobs.claimById(id);
    stores.jobs.finish(id, { status: "succeeded" });
    expect(stores.jobs.hasSucceeded("issue-1")).toBe(false);
    stores.jobs.enqueue({ ...review("b".repeat(40)), linearKey: "issue-1" });
    expect(stores.jobs.findQueued("issue-1")).toBeNull();
  });

  it("finds a queued review by subject and replaces its trigger", () => {
    const id = stores.jobs.enqueue(review("a".repeat(40)));
    expect(stores.jobs.findQueuedBySubject(reviewSubject(42, 7))?.id).toBe(id);
    expect(stores.jobs.replaceTrigger(id, review("b".repeat(40)))).toBe(true);
    const job = stores.jobs.get(id);
    expect(job?.trigger.kind === "mr.review" ? job.trigger.headSha : null).toBe("b".repeat(40));
  });

  it("resets a retrying review when a newer push replaces its trigger", () => {
    const id = stores.jobs.enqueue(review("a".repeat(40)));
    stores.jobs.claimById(id);
    stores.jobs.claimById(id);
    stores.jobs.saveReviewResult(id, {
      result: { verdict: "not_fixed", rerun: { observed: "still 500", deviations: null }, summary: "s", comments: [], confidence: "medium" },
      diffRefs: { baseSha: "1".repeat(40), startSha: "1".repeat(40), headSha: "a".repeat(40) },
    });
    stores.jobs.scheduleRetry(id, new Date(Date.now() + 60_000), "GitLab 502");
    expect(stores.jobs.findQueuedBySubject(reviewSubject(42, 7))?.id).toBe(id);

    expect(stores.jobs.replaceTrigger(id, review("b".repeat(40)))).toBe(true);

    const job = stores.jobs.get(id);
    expect(job?.trigger.kind === "mr.review" ? job.trigger.headSha : null).toBe("b".repeat(40));
    expect(job).toMatchObject({ status: "queued", reviewResult: null, attempts: 0, notBefore: null, error: null });
    expect(stores.jobs.claimNext()?.id).toBe(id);
  });

  it("does not replace the trigger of a running review", () => {
    const id = stores.jobs.enqueue(review("a".repeat(40)));
    stores.jobs.claimById(id);
    expect(stores.jobs.findQueuedBySubject(reviewSubject(42, 7))).toBeNull();
    expect(stores.jobs.replaceTrigger(id, review("b".repeat(40)))).toBe(false);
  });

  it("stores and reads back a review result", () => {
    const id = stores.jobs.enqueue(review("a".repeat(40)));
    const stored = {
      result: { verdict: "not_fixed" as const, rerun: { observed: "still 500", deviations: null }, summary: "s", comments: [], confidence: "medium" as const },
      diffRefs: { baseSha: "1".repeat(40), startSha: "1".repeat(40), headSha: "a".repeat(40) },
    };
    stores.jobs.saveReviewResult(id, stored);
    expect(stores.jobs.get(id)?.reviewResult).toEqual(stored);
    expect(stores.jobs.get(id)?.result).toBeNull();
  });
});

describe("implement jobs", () => {
  const implementEvent: TriggerEvent = {
    kind: "issue.labeled",
    action: "implement",
    issueId: "issue-1",
    identifier: "API-1",
    teamKey: "API",
    deliveryId: "delivery-1",
    description: "A bug report",
    stateType: null,
  };

  it("stores an implement trigger as kind implement", () => {
    const id = stores.jobs.enqueue(implementEvent);
    expect(stores.jobs.get(id)?.kind).toBe("implement");
  });

  it("scopes findQueued and hasSucceeded by kind", () => {
    const id = stores.jobs.enqueue(implementEvent);
    expect(stores.jobs.findQueued("issue-1")).toBeNull();
    expect(stores.jobs.findQueued("issue-1", "implement")?.id).toBe(id);
    stores.jobs.claimById(id);
    stores.jobs.markPushed(id);
    stores.jobs.finish(id, { status: "succeeded" });
    expect(stores.jobs.hasSucceeded("issue-1")).toBe(false);
    expect(stores.jobs.hasSucceeded("issue-1", "implement")).toBe(true);
  });

  it("does not count a handed-back implement job (nothing pushed) as implemented", () => {
    const id = stores.jobs.enqueue(implementEvent);
    stores.jobs.claimById(id);
    stores.jobs.finish(id, { status: "succeeded", warning: "handed back: the agent could not finish" });
    expect(stores.jobs.hasSucceeded("issue-1", "implement")).toBe(false);
  });

  it("records the stored result, commit and push", () => {
    const id = stores.jobs.enqueue(implementEvent);
    stores.jobs.saveImplementResult(id, { result: null, handback: { label: "readyForHuman", reason: "branch exists", detail: "fix/API-1-x" } });
    stores.jobs.recordCommit(id, "fix/API-1-x", "a".repeat(40));
    stores.jobs.markPushed(id);
    const job = stores.jobs.get(id);
    expect(job?.implementResult?.handback?.reason).toBe("branch exists");
    expect(job?.branch).toBe("fix/API-1-x");
    expect(job?.commitSha).toBe("a".repeat(40));
    expect(job?.pushedAt).not.toBeNull();
  });
});

describe("claimNext with running jobs", () => {
  const implementIssue1: TriggerEvent = {
    kind: "issue.labeled",
    action: "implement",
    issueId: "issue-1",
    identifier: "API-1",
    teamKey: "API",
    deliveryId: "delivery-3",
    description: "A bug report",
    stateType: null,
  };

  it("skips a job whose ticket has a running job, takes the next one, and takes the skipped one once the ticket is free", () => {
    const enrich = stores.jobs.enqueue(createdEvent);
    expect(stores.jobs.claimNext()?.id).toBe(enrich);
    const implement = stores.jobs.enqueue(implementIssue1);
    const other = stores.jobs.enqueue(secondEvent);

    expect(stores.jobs.claimNext()?.id).toBe(other);
    expect(stores.jobs.claimNext()).toBeNull();

    stores.jobs.finish(enrich, { status: "succeeded" });
    expect(stores.jobs.claimNext()?.id).toBe(implement);
  });

  it("skips a review whose merge request has a running review, but not an issue job of the same key", () => {
    const first = stores.jobs.enqueue(review("a".repeat(40)));
    expect(stores.jobs.claimNext()?.id).toBe(first);
    const second = stores.jobs.enqueue(review("b".repeat(40)));
    const issueJob = stores.jobs.enqueue({ kind: "cli", issueId: "API-1", identifier: "API-1", teamKey: "API" });

    expect(stores.jobs.claimNext()?.id).toBe(issueJob);
    expect(stores.jobs.claimNext()).toBeNull();

    stores.jobs.finish(first, { status: "succeeded" });
    expect(stores.jobs.claimNext()?.id).toBe(second);
  });

  it("requeueInterruptedJob requeues only that job and closes only its attempt", () => {
    const interrupted = stores.jobs.enqueue(createdEvent);
    const running = stores.jobs.enqueue(secondEvent);
    stores.jobs.claimNext();
    stores.attempts.start(interrupted);
    stores.jobs.claimNext();
    stores.attempts.start(running);

    stores.jobs.requeueInterruptedJob(interrupted, 3);

    expect(stores.jobs.get(interrupted)?.status).toBe("queued");
    expect(stores.attempts.forJob(interrupted)[0]?.error).toBe(INTERRUPTED_ERROR);
    expect(stores.attempts.forJob(interrupted)[0]?.finishedAt).toEqual(expect.any(String));
    expect(stores.jobs.get(running)?.status).toBe("running");
    expect(stores.attempts.forJob(running)[0]?.finishedAt).toBeNull();
  });

  it("requeueInterruptedJob fails a job that has used its last attempt", () => {
    const id = stores.jobs.enqueue(createdEvent);
    stores.jobs.claimById(id);
    stores.jobs.finish(id, { status: "publish_failed", error: "e" });
    stores.jobs.claimById(id);
    stores.jobs.finish(id, { status: "publish_failed", error: "e" });
    stores.jobs.claimById(id);

    stores.jobs.requeueInterruptedJob(id, 3);

    expect(stores.jobs.get(id)?.status).toBe("failed");
    expect(stores.jobs.get(id)?.error).toBe(INTERRUPTED_ERROR);
  });
});
