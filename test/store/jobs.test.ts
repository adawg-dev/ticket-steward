import { INTERRUPTED_ERROR } from "../../src/brain/index.js";
import { LEASE_STALE_MS, openStores, type Stores } from "../../src/store/index.js";
import type { TriggerEvent } from "../../src/tracker/types.js";
import { createdEvent, freshDataDir, secondEvent } from "./helpers.js";

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
    stores.db.prepare("UPDATE jobs SET fix_result = ?, implement_result = ? WHERE id = ?").run('{"summary":1}', "not json", bad);

    expect(stores.jobs.list({ limit: 10 }).map((job) => job.id)).toEqual([bad, good]);
    const job = stores.jobs.get(bad);
    expect(job?.fixResult).toBeNull();
    expect(job?.implementResult).toBeNull();
    expect(job?.unreadable).toEqual(["implement_result", "fix_result"]);
    expect(stores.jobs.get(good)?.unreadable).toEqual([]);
    expect(stores.jobs.claimNext()?.id).toBe(good);
    expect(stores.jobs.claimNext()?.unreadable).toEqual(["implement_result", "fix_result"]);
  });

  it("fails review jobs left from before the reviewer was removed", () => {
    const dir = freshDataDir();
    const first = openStores(dir);
    const insert = first.db.prepare(
      "INSERT INTO jobs (issue_id, identifier, team_key, trigger, status, created_at, kind, subject) VALUES (?, ?, ?, ?, ?, ?, 'review', ?)",
    );
    const trigger = JSON.stringify({ kind: "mr.review", projectId: 42, mrIid: 7, headSha: "a".repeat(40), linearKey: "API-1", teamKey: "API" });
    const queued = Number(insert.run("API-1", "API-1", "API", trigger, "queued", new Date().toISOString(), "mr:42!7").lastInsertRowid);
    const running = Number(insert.run("API-1", "API-1", "API", trigger, "running", new Date().toISOString(), "mr:42!7").lastInsertRowid);
    const done = Number(insert.run("API-1", "API-1", "API", trigger, "succeeded", new Date().toISOString(), "mr:42!7").lastInsertRowid);
    first.db.exec("CREATE TABLE repros (issue_id TEXT PRIMARY KEY)");
    first.db.close();

    const reopened = openStores(dir);
    try {
      expect(reopened.jobs.get(queued)).toMatchObject({ status: "failed", error: "MR review was removed", finishedAt: expect.any(String) });
      expect(reopened.jobs.get(running)).toMatchObject({ status: "failed", error: "MR review was removed" });
      expect(reopened.jobs.get(done)).toMatchObject({ status: "succeeded", error: null });
      expect(reopened.jobs.claimNext()).toBeNull();
      expect(reopened.db.prepare("SELECT name FROM sqlite_master WHERE name = 'repros'").all()).toEqual([]);
    } finally {
      reopened.db.close();
    }
  });

  it("failRetiredKinds fails queued and running enrich jobs and keeps their history readable", () => {
    const insert = stores.db.prepare(
      "INSERT INTO jobs (issue_id, identifier, team_key, trigger, status, created_at, kind) VALUES (?, ?, ?, ?, ?, ?, 'enrich')",
    );
    const trigger = JSON.stringify({ ...createdEvent, action: undefined });
    const queued = Number(insert.run("issue-1", "API-1", "API", trigger, "queued", new Date().toISOString()).lastInsertRowid);
    const running = Number(insert.run("issue-1", "API-1", "API", trigger, "running", new Date().toISOString()).lastInsertRowid);
    const done = Number(insert.run("issue-1", "API-1", "API", trigger, "succeeded", new Date().toISOString()).lastInsertRowid);
    const current = stores.jobs.enqueue(createdEvent);

    expect(stores.jobs.failRetiredKinds()).toBe(2);

    for (const id of [queued, running]) {
      expect(stores.jobs.get(id)).toMatchObject({ kind: "enrich", status: "failed", error: "enrich was removed; this job will not run", finishedAt: expect.any(String) });
    }
    expect(stores.jobs.get(done)).toMatchObject({ kind: "enrich", status: "succeeded", error: null });
    expect(stores.jobs.get(current)).toMatchObject({ kind: "implement", status: "queued" });
    expect(stores.jobs.list({ limit: 10 }).map((job) => job.kind)).toEqual(["implement", "enrich", "enrich", "enrich"]);
    expect(stores.jobs.failRetiredKinds()).toBe(0);
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
    expect(job?.kind).toBe("implement");
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

  it("claimNext with waitsOnly skips older heavy jobs and claims the oldest due await_review", () => {
    const heavy = stores.jobs.enqueue(createdEvent);
    const awaitId = stores.jobs.enqueue({ kind: "loop", issueId: "issue-2", identifier: "API-2", teamKey: "API", loopId: 4, step: "await" });

    expect(stores.jobs.claimNext({ waitsOnly: true })?.id).toBe(awaitId);
    expect(stores.jobs.claimNext({ waitsOnly: true })).toBeNull();
    expect(stores.jobs.get(heavy)?.status).toBe("queued");
    expect(stores.jobs.claimNext()?.id).toBe(heavy);
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

    stores.jobs.markPushed(id);
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

  it("claimById refuses while an active chat lease holds the job's ticket or slot 1, and ignores a stale one", () => {
    const id = stores.jobs.enqueue(createdEvent);
    const onTicket = stores.leases.create({ issueId: "issue-1", worktreeName: "ticket-API-1", slot: null, pid: 4242 });

    expect(stores.jobs.claimById(id)).toBeNull();
    expect(stores.jobs.get(id)?.status).toBe("queued");

    stores.leases.release(onTicket);
    const onSlot = stores.leases.create({ issueId: "issue-2", worktreeName: "ticket-API-2", slot: 1, pid: 4242 });
    expect(stores.jobs.claimById(id)).toBeNull();

    const old = new Date(Date.now() - LEASE_STALE_MS - 1_000).toISOString();
    stores.db.prepare("UPDATE chat_leases SET heartbeat_at = ? WHERE id = ?").run(old, onSlot);
    expect(stores.jobs.claimById(id)?.status).toBe("running");
  });

  it("claimById claims beside a chat lease on another ticket and slot", () => {
    const id = stores.jobs.enqueue(createdEvent);
    stores.leases.create({ issueId: "issue-2", worktreeName: "ticket-API-2", slot: 2, pid: 4242 });

    expect(stores.jobs.claimById(id)).toMatchObject({ status: "running", slot: 1 });
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

  it("scopes findQueued and hasSucceeded by kind, implement by default", () => {
    const id = stores.jobs.enqueue(implementEvent);
    expect(stores.jobs.findQueued("issue-1")?.id).toBe(id);
    expect(stores.jobs.findQueued("issue-1", "restart")).toBeNull();
    stores.jobs.claimById(id);
    stores.jobs.markPushed(id);
    stores.jobs.finish(id, { status: "succeeded" });
    expect(stores.jobs.hasSucceeded("issue-1")).toBe(true);
    expect(stores.jobs.hasSucceeded("issue-1", "fix")).toBe(false);
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

  it("stores a fix job's decision and names an unreadable one", () => {
    const id = stores.jobs.enqueue({ kind: "loop", issueId: "issue-1", identifier: "API-1", teamKey: "API", loopId: 1, step: "fix" });
    stores.jobs.saveFixResult(id, { result: null, handback: { reason: "the agent's result was invalid", detail: "summary is empty" }, score: 3, reviewCount: 2, pipeline: "success" });
    expect(stores.jobs.get(id)?.fixResult).toMatchObject({ handback: { reason: "the agent's result was invalid" }, score: 3 });

    stores.db.prepare("UPDATE jobs SET fix_result = ? WHERE id = ?").run('{"score":"x"}', id);
    expect(stores.jobs.get(id)?.fixResult).toBeNull();
    expect(stores.jobs.get(id)?.unreadable).toEqual(["fix_result"]);
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
    const heavy = stores.jobs.enqueue(createdEvent);
    expect(stores.jobs.claimNext()?.id).toBe(heavy);
    const implement = stores.jobs.enqueue(implementIssue1);
    const other = stores.jobs.enqueue(secondEvent);

    expect(stores.jobs.claimNext()?.id).toBe(other);
    expect(stores.jobs.claimNext()).toBeNull();

    stores.jobs.finish(heavy, { status: "succeeded" });
    expect(stores.jobs.claimNext()?.id).toBe(implement);
  });

  it("skips a job whose subject has a running job, even on another ticket", () => {
    const running = stores.jobs.enqueue(createdEvent);
    const sameSubject = stores.jobs.enqueue(secondEvent);
    const noSubject = stores.jobs.enqueue({ kind: "cli", issueId: "issue-3", identifier: "API-3", teamKey: "API" });
    stores.db.prepare("UPDATE jobs SET subject = 'mr:42!7' WHERE id IN (?, ?)").run(running, sameSubject);
    expect(stores.jobs.claimNext()?.id).toBe(running);

    expect(stores.jobs.claimNext()?.id).toBe(noSubject);
    expect(stores.jobs.claimNext()).toBeNull();

    stores.jobs.finish(running, { status: "succeeded" });
    expect(stores.jobs.claimNext()?.id).toBe(sameSubject);
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

describe("loop jobs", () => {
  const loopEvent = (step: "await" | "fix" | "restart"): TriggerEvent => ({ kind: "loop", issueId: "issue-1", identifier: "API-1", teamKey: "API", loopId: 3, step });

  it("stores an await step as kind await_review with the loop as subject", () => {
    const id = stores.jobs.enqueue(loopEvent("await"));
    const job = stores.jobs.get(id);
    expect(job?.kind).toBe("await_review");
    expect(job?.subject).toBe("loop:3");
    expect(job?.trigger).toEqual(loopEvent("await"));
    expect(job?.unreadable).toEqual([]);
  });

  it("stores fix and restart steps under their own names", () => {
    expect(stores.jobs.get(stores.jobs.enqueue(loopEvent("fix")))?.kind).toBe("fix");
    expect(stores.jobs.get(stores.jobs.enqueue(loopEvent("restart")))?.kind).toBe("restart");
  });

  it("does not claim a queued fix while an implement for the same ticket is running", () => {
    const implement = stores.jobs.enqueue({ kind: "cli", issueId: "issue-1", identifier: "API-1", teamKey: "API", action: "implement" });
    expect(stores.jobs.claimNext()?.id).toBe(implement);
    const fix = stores.jobs.enqueue(loopEvent("fix"));

    expect(stores.jobs.claimNext()).toBeNull();

    stores.jobs.finish(implement, { status: "succeeded" });
    expect(stores.jobs.claimNext()?.id).toBe(fix);
  });

  it("recordSession stores the session id on the job", () => {
    const id = stores.jobs.enqueue(loopEvent("fix"));
    expect(stores.jobs.get(id)?.sessionId).toBeNull();
    stores.jobs.recordSession(id, "session-9");
    expect(stores.jobs.get(id)?.sessionId).toBe("session-9");
  });

  it("latestForSubject returns a loop's newest job, whatever its status", () => {
    const first = stores.jobs.enqueue(loopEvent("await"));
    stores.jobs.claimById(first);
    stores.jobs.finish(first, { status: "succeeded" });
    const second = stores.jobs.enqueue(loopEvent("fix"));
    stores.jobs.claimById(second);
    stores.jobs.finish(second, { status: "failed", error: "crashed: boom", retryable: false });

    expect(stores.jobs.latestForSubject("loop:3")).toMatchObject({ id: second, kind: "fix", status: "failed", error: "crashed: boom" });
    expect(stores.jobs.latestForSubject("loop:4")).toBeNull();
  });

  it("defer after a claim requeues the job until the given time and starts its failure count over", () => {
    const id = stores.jobs.enqueue(loopEvent("await"));
    stores.jobs.claimNext();
    stores.jobs.scheduleRetry(id, new Date(), "an earlier error");
    expect(stores.jobs.claimNext()?.attempts).toBe(2);
    const until = new Date(Date.now() + 60_000);

    stores.jobs.defer(id, until);

    const job = stores.jobs.get(id);
    expect(job?.status).toBe("queued");
    expect(job?.attempts).toBe(0);
    expect(job?.notBefore).toBe(until.toISOString());
    expect(job?.error).toBeNull();
    expect(job?.finishedAt).toBeNull();
    expect(stores.jobs.claimNext()).toBeNull();
  });

  describe("chat jobs", () => {
    const chatEvent = (loopId: number | null, issueId = "issue-1"): TriggerEvent => ({
      kind: "chat", issueId, identifier: "API-1", teamKey: "API", loopId, projectId: 42, mrIid: 7, discussionId: "d1", noteId: 9, author: "ada", message: "hi",
    });

    it("stores a chat on a loop's ticket with the loop as subject, and one without a loop with no subject", () => {
      const onLoop = stores.jobs.get(stores.jobs.enqueue(chatEvent(3)));
      expect(onLoop).toMatchObject({ kind: "chat", subject: "loop:3", trigger: chatEvent(3), chatResult: null, unreadable: [] });
      expect(stores.jobs.get(stores.jobs.enqueue(chatEvent(null)))).toMatchObject({ kind: "chat", subject: null });
    });

    it("waits while a step of its loop or any job of its ticket runs", () => {
      const fix = stores.jobs.enqueue(loopEvent("fix"));
      expect(stores.jobs.claimNext()?.id).toBe(fix);
      const chat = stores.jobs.enqueue(chatEvent(3, "issue-9"));
      const loose = stores.jobs.enqueue(chatEvent(null));

      expect(stores.jobs.claimNext()).toBeNull();

      stores.jobs.finish(fix, { status: "succeeded" });
      expect(stores.jobs.claimNext()?.id).toBe(chat);
      expect(stores.jobs.claimNext()?.id).toBe(loose);
    });

    it("stores its reply and names the column when it cannot be read", () => {
      const id = stores.jobs.enqueue(chatEvent(3));
      stores.jobs.saveChatResult(id, { reply: "hello", warning: null });
      expect(stores.jobs.get(id)?.chatResult).toEqual({ reply: "hello", warning: null });
      stores.db.prepare("UPDATE jobs SET chat_result = ? WHERE id = ?").run('{"reply":1}', id);
      expect(stores.jobs.get(id)?.unreadable).toEqual(["chat_result"]);
    });

    it("is never woken: a wake is for the loop's await, and reports nothing to wake without one", () => {
      const chat = stores.jobs.enqueue(chatEvent(3));
      stores.jobs.claimById(chat);

      expect(stores.jobs.wake("loop:3", new Date())).toBe(false);
      expect(stores.jobs.get(chat)?.wakeRequested).toBe(false);
    });
  });

  describe("wake", () => {
    const deferred = (): number => {
      const id = stores.jobs.enqueue(loopEvent("await"));
      stores.jobs.claimNext();
      stores.jobs.defer(id, new Date(Date.now() + 300_000));
      return id;
    };

    it("makes a deferred job of the subject due now", () => {
      const id = deferred();
      expect(stores.jobs.claimNext()).toBeNull();
      const now = new Date();

      expect(stores.jobs.wake("loop:3", now)).toBe(true);

      expect(stores.jobs.get(id)?.notBefore).toBe(now.toISOString());
      expect(stores.jobs.claimNext()?.id).toBe(id);
    });

    it("is idempotent and never pushes a due job later", () => {
      const id = deferred();
      const first = new Date();
      expect(stores.jobs.wake("loop:3", first)).toBe(true);
      expect(stores.jobs.wake("loop:3", new Date(first.getTime() + 1_000))).toBe(true);
      expect(stores.jobs.get(id)?.notBefore).toBe(first.toISOString());
      expect(stores.jobs.list({ limit: 10 })).toHaveLength(1);
    });

    it("records a wake on a running job, so its deferred finish makes it due now and clears the flag", () => {
      const id = stores.jobs.enqueue(loopEvent("await"));
      stores.jobs.claimNext();

      expect(stores.jobs.wake("loop:3", new Date())).toBe(true);
      expect(stores.jobs.get(id)).toMatchObject({ status: "running", wakeRequested: true });

      stores.jobs.finish(id, { status: "deferred", until: new Date(Date.now() + 300_000) });

      const job = stores.jobs.get(id);
      expect(job).toMatchObject({ status: "queued", wakeRequested: false });
      expect(Date.parse(job?.notBefore ?? "")).toBeLessThanOrEqual(Date.now());
      expect(stores.jobs.claimNext()?.id).toBe(id);
      // The flag was used up: the next deferral waits its full time.
      stores.jobs.defer(id, new Date(Date.now() + 300_000));
      expect(stores.jobs.claimNext()).toBeNull();
    });

    it("clears a recorded wake when the running job finishes any other way", () => {
      const id = stores.jobs.enqueue(loopEvent("await"));
      stores.jobs.claimNext();
      stores.jobs.wake("loop:3", new Date());
      stores.jobs.scheduleRetry(id, new Date(Date.now() + 60_000), "boom");
      expect(stores.jobs.get(id)?.wakeRequested).toBe(false);

      const other = stores.jobs.enqueue({ kind: "loop", issueId: "issue-2", identifier: "API-2", teamKey: "API", loopId: 4, step: "await" });
      stores.jobs.claimById(other);
      stores.jobs.wake("loop:4", new Date());
      stores.jobs.finish(other, { status: "succeeded" });
      expect(stores.jobs.get(other)?.wakeRequested).toBe(false);
    });

    it("leaves finished jobs alone and creates none", () => {
      const id = stores.jobs.enqueue(loopEvent("await"));
      stores.jobs.claimNext();
      stores.jobs.finish(id, { status: "succeeded" });

      expect(stores.jobs.wake("loop:3", new Date())).toBe(false);
      expect(stores.jobs.get(id)).toMatchObject({ status: "succeeded", wakeRequested: false });
      expect(stores.jobs.wake("loop:4", new Date())).toBe(false);
      expect(stores.jobs.list({ limit: 10 })).toHaveLength(1);
    });
  });
});
