import { storeLedger, type PushLedger } from "../../src/push/ledger.js";
import type { PushTarget } from "../../src/push/target.js";
import { openStores, type Stores } from "../../src/store/index.js";
import type { TicketBundle } from "../../src/tracker/types.js";
import { FakeTracker } from "../fakes/fakeTracker.js";
import { freshDataDir } from "../store/helpers.js";

const BRANCH = "fix/API-1-keep";
const BASE = "b".repeat(40);
const FIRST = "1".repeat(40);
const SECOND = "2".repeat(40);

const issue: TicketBundle = {
  id: "issue-1",
  identifier: "API-1",
  url: "https://linear.app/acme/issue/API-1",
  title: "Adapter drops the last chunk",
  description: "",
  team: { id: "team-1", key: "API", name: "API" },
  state: { name: "In Progress", type: "started" },
  labels: [],
  priority: 2,
  creator: { name: "Ada", isBot: false },
  createdAt: "2026-10-27T00:00:00.000Z",
  comments: [],
  attachments: [],
  appliedTemplate: null,
  templates: [],
};

let stores: Stores;
let tracker: FakeTracker;
let ledger: PushLedger;
let jobId: number;

const targetOf = (over: Partial<PushTarget> = {}): PushTarget => ({
  jobId,
  worktreePath: "/work/ticket-API-1",
  identifier: "API-1",
  issueId: "issue-1",
  title: "Adapter drops the last chunk",
  mode: "create",
  branch: null,
  baseSha: BASE,
  loopId: null,
  port: 3000,
  ...over,
});

/** The remote never consulted: a start with nothing unfinished must not look. */
const noRemote = (): Promise<string | null> => Promise.reject(new Error("the remote was consulted"));

const newLoop = (headSha = FIRST): number =>
  stores.loops.create({ issueId: "issue-1", identifier: "API-1", teamKey: "API", implementJobId: jobId, branch: BRANCH, baseSha: BASE, headSha, worktreeName: "ticket-API-1", labelDriven: true, sessionId: "session-1" });

beforeEach(() => {
  stores = openStores(freshDataDir());
  tracker = new FakeTracker([issue]);
  ledger = storeLedger({ stores, tracker });
  jobId = stores.jobs.enqueue({ kind: "cli", issueId: "issue-1", identifier: "API-1", teamKey: "API", action: "implement" });
});

afterEach(() => {
  stores.db.close();
});

describe("storeLedger start", () => {
  it("creates on the target's base for a job that never pushed", async () => {
    expect(await ledger.start(targetOf(), noRemote)).toEqual({ kind: "create", base: BASE });
  });

  it("fast-forwards a target branch from its base, and refuses a fast-forward without a branch", async () => {
    expect(await ledger.start(targetOf({ mode: "fastForward", branch: BRANCH }), noRemote)).toEqual({ kind: "fastForward", branch: BRANCH, base: BASE });
    expect(await ledger.start(targetOf({ mode: "fastForward" }), noRemote)).toEqual({ kind: "refused", reason: "this run has no branch to push to" });
  });

  it("fast-forwards a legacy pushed job without push rows from the job's commit", async () => {
    stores.jobs.recordCommit(jobId, BRANCH, FIRST);
    stores.jobs.markPushed(jobId);

    expect(await ledger.start(targetOf({ mode: "fastForward", branch: BRANCH }), noRemote)).toEqual({ kind: "fastForward", branch: BRANCH, base: FIRST });
  });

  it("fast-forwards from the job's last landed push", async () => {
    const { id } = await ledger.record(targetOf(), { branch: BRANCH, sha: FIRST, previousSha: null, note: null });
    await ledger.landed(targetOf(), id, FIRST);

    expect(await ledger.start(targetOf(), noRemote)).toEqual({ kind: "fastForward", branch: BRANCH, base: FIRST });
  });

  it("fast-forwards a loop from the loop's head, and refuses a loop that is gone", async () => {
    const loopId = newLoop();

    expect(await ledger.start(targetOf({ mode: "fastForward", branch: BRANCH, loopId }), noRemote)).toEqual({ kind: "fastForward", branch: BRANCH, base: FIRST });
    expect(await ledger.start(targetOf({ loopId: loopId + 1 }), noRemote)).toEqual({ kind: "refused", reason: "this run's fix loop no longer exists" });
  });

  it("settles an unfinished push the remote holds, and starts from it", async () => {
    await ledger.record(targetOf(), { branch: BRANCH, sha: FIRST, previousSha: null, note: null });
    const asked: string[] = [];

    const start = await ledger.start(targetOf(), (branch) => {
      asked.push(branch);
      return Promise.resolve(FIRST);
    });

    expect(asked).toEqual([BRANCH]);
    expect(start).toEqual({ kind: "fastForward", branch: BRANCH, base: FIRST });
    expect(stores.jobs.get(jobId)?.pushedAt).not.toBeNull();
  });

  it("leaves an unfinished push the remote does not hold unsettled", async () => {
    await ledger.record(targetOf(), { branch: BRANCH, sha: FIRST, previousSha: null, note: null });

    expect(await ledger.start(targetOf(), () => Promise.resolve(null))).toEqual({ kind: "create", base: BASE });
    expect(stores.pushes.latest(jobId)?.pushedAt).toBeNull();
  });
});

describe("storeLedger records", () => {
  it("records a loop push as pending and lands it on the loop's head", async () => {
    const loopId = newLoop();
    const target = targetOf({ mode: "fastForward", branch: BRANCH, loopId });

    const { id } = await ledger.record(target, { branch: BRANCH, sha: SECOND, previousSha: FIRST, note: "review" });
    expect(stores.loops.get(loopId)).toMatchObject({ headSha: FIRST, pendingPush: { sha: SECOND, pushed: false } });

    await ledger.landed(target, id, SECOND);
    expect(stores.loops.get(loopId)).toMatchObject({ headSha: SECOND, pendingPush: { sha: SECOND, pushed: true } });
    expect(stores.pushes.forJob(jobId)).toMatchObject([{ loopId, branch: BRANCH, sha: SECOND, previousSha: FIRST, note: "review" }]);
  });

  it("reverts a loop push to the prior pendingPush", async () => {
    const loopId = newLoop();
    stores.loops.update(loopId, { pendingPush: { sha: FIRST, pushed: true } });
    const target = targetOf({ mode: "fastForward", branch: BRANCH, loopId });

    const { id } = await ledger.record(target, { branch: BRANCH, sha: SECOND, previousSha: FIRST, note: null });
    await ledger.revert(target, id);

    expect(stores.loops.get(loopId)).toMatchObject({ headSha: FIRST, pendingPush: { sha: FIRST, pushed: true } });
  });

  it("reverts a job's push to its last landed push, and leaves a first push recorded as not pushed", async () => {
    const first = await ledger.record(targetOf(), { branch: BRANCH, sha: FIRST, previousSha: null, note: null });
    await ledger.revert(targetOf(), first.id);
    expect(stores.jobs.get(jobId)).toMatchObject({ branch: BRANCH, commitSha: FIRST, pushedAt: null });

    const again = await ledger.record(targetOf(), { branch: BRANCH, sha: FIRST, previousSha: null, note: null });
    await ledger.landed(targetOf(), again.id, FIRST);
    const second = await ledger.record(targetOf(), { branch: BRANCH, sha: SECOND, previousSha: FIRST, note: null });
    expect(stores.jobs.get(jobId)).toMatchObject({ commitSha: SECOND, pushedAt: null });

    await ledger.revert(targetOf(), second.id);
    expect(stores.jobs.get(jobId)?.commitSha).toBe(FIRST);
    expect(stores.jobs.get(jobId)?.pushedAt).not.toBeNull();
  });
});

describe("storeLedger ticket", () => {
  it("gives the title, and the closed reason once the ticket is done, as the tracker reads them", async () => {
    expect(await ledger.ticket(targetOf({ title: "The title the run started with" }))).toEqual({ title: "Adapter drops the last chunk", closed: null });

    tracker.addIssue({ ...issue, state: { name: "Done", type: "completed" } });
    expect(await ledger.ticket(targetOf())).toEqual({ title: "Adapter drops the last chunk", closed: "API-1 is Done; Ticket Steward does not work on Done or Canceled tickets" });
  });

  it("without a tracker (the local push server, which holds no Linear credential): the target's title, never closed", async () => {
    const local = storeLedger({ stores, tracker: null });
    tracker.addIssue({ ...issue, state: { name: "Done", type: "completed" } });

    expect(await local.ticket(targetOf({ title: "The title the run started with" }))).toEqual({ title: "The title the run started with", closed: null });
    expect(await local.ticket(targetOf({ mode: "fastForward", branch: BRANCH, title: null }))).toEqual({ title: "API-1", closed: null });
  });
});
