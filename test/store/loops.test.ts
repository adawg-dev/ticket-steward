import { openStores, type Stores } from "../../src/store/index.js";
import type { LoopRound, NewLoop } from "../../src/store/loops.js";
import { freshDataDir } from "./helpers.js";

let stores: Stores;

beforeEach(() => {
  vi.restoreAllMocks();
  stores = openStores(freshDataDir());
});

afterEach(() => {
  stores.db.close();
});

/** The implement job a loop starts from; loops reference it. */
const implementJob = (issueId = "issue-1"): number =>
  stores.jobs.enqueue({ kind: "cli", issueId, identifier: "API-1", teamKey: "API", action: "implement" });

/** A loop on issue-1 started by a fresh implement job, unless the overrides say otherwise. */
const newLoop = (overrides: Partial<NewLoop> = {}): NewLoop => ({
  issueId: "issue-1",
  identifier: "API-1",
  teamKey: "API",
  implementJobId: overrides.implementJobId ?? implementJob(overrides.issueId),
  branch: "fix/API-1-keep",
  baseSha: "b".repeat(40),
  headSha: "h".repeat(40),
  worktreeName: "API-1-7",
  labelDriven: true,
  sessionId: "session-1",
  ...overrides,
});

const round: LoopRound = { round: 1, headSha: "c".repeat(40), score: 4, pipeline: "success", fixed: 2, declined: 1, outcome: "changed" };

describe("LoopStore", () => {
  it("create then get round-trips every field", () => {
    const input = newLoop();
    const id = stores.loops.create(input);
    stores.loops.update(id, {
      projectId: 42,
      mrIid: 9,
      mrUrl: "https://gitlab.example/acme/repo/-/merge_requests/9",
      waitStartedAt: "2026-10-27T10:00:00.000Z",
      reviewCountAtTrigger: 3,
      adoptedFrom: "API-0",
      pendingPush: { sha: "d".repeat(40), pushed: false },
      handedBackAt: "2026-10-27T09:00:00.000Z",
      pendingNotesSince: "2026-10-27T10:05:00.000Z",
      botRounds: 2,
      ciRetries: { unit: { sha: "d".repeat(40), infra: 1, flaky: 0 } },
    });

    expect(stores.loops.get(id)).toEqual({
      id,
      ...input,
      projectId: 42,
      mrIid: 9,
      mrUrl: "https://gitlab.example/acme/repo/-/merge_requests/9",
      round: 0,
      state: "awaiting_mr",
      history: [],
      decisions: [],
      waitStartedAt: "2026-10-27T10:00:00.000Z",
      reviewCountAtTrigger: 3,
      adoptedFrom: "API-0",
      pendingPush: { sha: "d".repeat(40), pushed: false },
      handedBackAt: "2026-10-27T09:00:00.000Z",
      pendingNotesSince: "2026-10-27T10:05:00.000Z",
      botRounds: 2,
      ciRetries: { unit: { sha: "d".repeat(40), infra: 1, flaky: 0 } },
      endedAt: null,
      createdAt: expect.any(String),
    });
  });

  it("creates a loop with nulls for what is not known yet", () => {
    const id = stores.loops.create(newLoop({ labelDriven: false, sessionId: null }));
    const loop = stores.loops.get(id);
    expect(loop?.labelDriven).toBe(false);
    expect(loop?.sessionId).toBeNull();
    expect(loop?.projectId).toBeNull();
    expect(loop?.pendingPush).toBeNull();
    expect(loop?.handedBackAt).toBeNull();
    expect(loop?.pendingNotesSince).toBeNull();
    expect(loop?.botRounds).toBe(0);
    expect(loop?.ciRetries).toEqual({});
  });

  it("get returns null for an unknown id", () => {
    expect(stores.loops.get(99)).toBeNull();
  });

  it("update to an ended state sets endedAt; an active state does not", () => {
    const id = stores.loops.create(newLoop());
    stores.loops.update(id, { state: "fixing", round: 1 });
    expect(stores.loops.get(id)?.endedAt).toBeNull();
    expect(stores.loops.get(id)?.round).toBe(1);

    stores.loops.update(id, { state: "passed" });

    expect(stores.loops.get(id)?.state).toBe("passed");
    expect(stores.loops.get(id)?.endedAt).toEqual(expect.any(String));
  });

  it("update can clear a nullable field", () => {
    const id = stores.loops.create(newLoop());
    stores.loops.update(id, { pendingPush: { sha: "d".repeat(40), pushed: true } });
    stores.loops.update(id, { pendingPush: null, sessionId: null });
    expect(stores.loops.get(id)?.pendingPush).toBeNull();
    expect(stores.loops.get(id)?.sessionId).toBeNull();
  });

  it("appendRound appends to history", () => {
    const id = stores.loops.create(newLoop());
    stores.loops.appendRound(id, round);
    stores.loops.appendRound(id, { ...round, round: 2, outcome: "passed", score: 5 });
    expect(stores.loops.get(id)?.history).toEqual([round, { ...round, round: 2, outcome: "passed", score: 5 }]);
  });

  it("appendRound refuses to overwrite a history it cannot read", () => {
    const id = stores.loops.create(newLoop());
    stores.db.prepare("UPDATE loops SET history = 'not json' WHERE id = ?").run(id);
    expect(stores.loops.get(id)?.history).toEqual([]);
    expect(() => stores.loops.appendRound(id, round)).toThrow(/history/);
    expect(stores.db.prepare<[number], { history: string }>("SELECT history FROM loops WHERE id = ?").get(id)?.history).toBe("not json");
  });

  it("appendDecisions adds new decisions after the stored ones, skipping blanks and ones already there", () => {
    const id = stores.loops.create(newLoop());
    expect(stores.loops.get(id)?.decisions).toEqual([]);
    stores.loops.appendDecisions(id, ["Keep the v1 endpoint", "  "]);
    stores.loops.appendDecisions(id, ["keep the  v1 endpoint.", " Don't rename the queue ", "Don't rename the queue"]);
    expect(stores.loops.get(id)?.decisions).toEqual(["Keep the v1 endpoint", "Don't rename the queue"]);
  });

  it("appendDecisions refuses to overwrite decisions it cannot read", () => {
    const id = stores.loops.create(newLoop());
    stores.db.prepare("UPDATE loops SET decisions = '{}' WHERE id = ?").run(id);
    expect(stores.loops.get(id)?.decisions).toEqual([]);
    expect(() => stores.loops.appendDecisions(id, ["Keep the v1 endpoint"])).toThrow(/decisions/);
    expect(stores.db.prepare<[number], { decisions: string }>("SELECT decisions FROM loops WHERE id = ?").get(id)?.decisions).toBe("{}");
  });

  it("forImplementJob finds the loop its implement job started", () => {
    const jobId = implementJob();
    const id = stores.loops.create(newLoop({ implementJobId: jobId }));
    expect(stores.loops.forImplementJob(jobId)?.id).toBe(id);
    expect(stores.loops.forImplementJob(jobId + 1)).toBeNull();
  });

  it("latestForIssue returns the highest id", () => {
    stores.loops.create(newLoop());
    const latest = stores.loops.create(newLoop());
    stores.loops.create(newLoop({ issueId: "issue-2" }));
    expect(stores.loops.latestForIssue("issue-1")?.id).toBe(latest);
    expect(stores.loops.latestForIssue("issue-3")).toBeNull();
  });

  it("active excludes passed, handed_back and stopped", () => {
    const awaitingMr = stores.loops.create(newLoop());
    const awaitingReview = stores.loops.create(newLoop());
    const fixing = stores.loops.create(newLoop());
    const passed = stores.loops.create(newLoop());
    const handedBack = stores.loops.create(newLoop());
    const stopped = stores.loops.create(newLoop());
    stores.loops.update(awaitingReview, { state: "awaiting_review" });
    stores.loops.update(fixing, { state: "fixing" });
    stores.loops.update(passed, { state: "passed" });
    stores.loops.update(handedBack, { state: "handed_back" });
    stores.loops.update(stopped, { state: "stopped" });

    expect(stores.loops.active().map((loop) => loop.id)).toEqual([awaitingMr, awaitingReview, fixing]);
  });

  it("reads an unassigned loop back as unassigned: parked, neither active nor ended", () => {
    const id = stores.loops.create(newLoop());
    stores.db.prepare("UPDATE loops SET state = 'unassigned' WHERE id = ?").run(id);

    expect(stores.loops.get(id)).toMatchObject({ state: "unassigned", endedAt: null });
    expect(stores.loops.active()).toEqual([]);
    expect(stores.loops.stranded()).toEqual([]);
  });

  it("stranded returns running loops with no queued or running job", () => {
    const step = (loopId: number) => ({ kind: "loop", issueId: "issue-1", identifier: "API-1", teamKey: "API", loopId, step: "await" }) as const;
    const queued = stores.loops.create(newLoop());
    stores.jobs.enqueue(step(queued));
    const running = stores.loops.create(newLoop());
    stores.jobs.claimById(stores.jobs.enqueue(step(running)));
    const failed = stores.loops.create(newLoop());
    const failedJob = stores.jobs.enqueue(step(failed));
    stores.jobs.claimById(failedJob);
    stores.jobs.finish(failedJob, { status: "failed", error: "GitLab down", retryable: true });
    const noJob = stores.loops.create(newLoop());
    stores.loops.update(noJob, { state: "fixing" });
    const ended = stores.loops.create(newLoop());
    stores.loops.update(ended, { state: "handed_back" });

    expect(stores.loops.stranded().map((loop) => loop.id)).toEqual([failed, noJob]);
  });

  it("a chat queued on a loop's subject does not keep it from counting as stranded", () => {
    const loopId = stores.loops.create(newLoop());
    stores.loops.update(loopId, { state: "fixing" });
    stores.jobs.enqueue({ kind: "chat", issueId: "issue-1", identifier: "API-1", teamKey: "API", loopId, projectId: 42, mrIid: 7, discussionId: null, noteId: 1, author: "ada", message: "hi" });

    expect(stores.loops.stranded().map((loop) => loop.id)).toEqual([loopId]);
  });

  it("latestForBranch returns the newest loop on the branch", () => {
    stores.loops.create(newLoop({ branch: "fix/API-1-a" }));
    const newer = stores.loops.create(newLoop({ branch: "fix/API-1-a" }));
    stores.loops.create(newLoop({ branch: "fix/API-1-b" }));

    expect(stores.loops.latestForBranch("fix/API-1-a")?.id).toBe(newer);
    expect(stores.loops.latestForBranch("fix/API-1-c")).toBeNull();
  });

  it("keptWithin returns active loops and loops ended inside the window", () => {
    const active = stores.loops.create(newLoop({ worktreeName: "a" }));
    const recent = stores.loops.create(newLoop({ worktreeName: "b" }));
    const old = stores.loops.create(newLoop({ worktreeName: "c" }));
    stores.loops.update(recent, { state: "passed" });
    stores.loops.update(old, { state: "stopped", endedAt: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString() });

    expect(stores.loops.keptWithin(30).map((loop) => loop.id)).toEqual([active, recent]);
  });
});
