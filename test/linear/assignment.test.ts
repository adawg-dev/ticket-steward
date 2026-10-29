import { restoreDelegate, reviveTicket, UNASSIGNED_JOB_ERROR, unassignTicket } from "../../src/linear/assignment.js";
import { logger } from "../../src/log.js";
import { RunChannels } from "../../src/run/channel.js";
import { openStores, type Loop, type LoopState, type Stores } from "../../src/store/index.js";
import type { TriggerEvent } from "../../src/tracker/types.js";
import { RecordingLinear } from "../fakes/fakeLinearAgent.js";
import { freshDataDir } from "../store/helpers.js";

const ISSUE = { issueId: "issue-1", identifier: "API-1", teamKey: "API" };
const HEAD = "b".repeat(40);

let stores: Stores;

beforeEach(() => {
  vi.restoreAllMocks();
  stores = openStores(freshDataDir());
});

afterEach(() => {
  stores.db.close();
});

const loopIn = (state: LoopState): Loop => {
  const jobId = stores.jobs.enqueue({ kind: "linear", run: "implement", ...ISSUE, sessionId: "session-0", message: null });
  stores.jobs.claimById(jobId);
  stores.jobs.finish(jobId, { status: "succeeded" });
  const loopId = stores.loops.create({
    ...ISSUE, implementJobId: jobId, branch: "fix/API-1-keep", baseSha: "a".repeat(40), headSha: HEAD,
    worktreeName: "ticket-API-1", labelDriven: false, sessionId: "claude-session-1",
  });
  stores.loops.update(loopId, { state, projectId: 42, mrIid: 7 });
  const loop = stores.loops.get(loopId);
  if (loop === null) throw new Error("loop not stored");
  return loop;
};

const linearChat: TriggerEvent = { kind: "linear", run: "chat", ...ISSUE, sessionId: "session-2", message: "@steward please continue" };

describe("unassignTicket", () => {
  it("stops the fix running on the ticket, parks its loop and leaves the branch alone", () => {
    const loop = loopIn("fixing");
    const fixId = stores.jobs.enqueue({ kind: "loop", ...ISSUE, loopId: loop.id, step: "fix" });
    stores.jobs.claimById(fixId);
    const channels = new RunChannels();
    channels.open(`${fixId}-1`, () => undefined, "issue-1", fixId);

    unassignTicket({ stores, channels }, "issue-1");

    expect(stores.loops.get(loop.id)).toMatchObject({ state: "unassigned", headSha: HEAD, branch: "fix/API-1-keep", endedAt: null });
    expect(stores.jobs.get(fixId)?.status).toBe("running");
    return expect(channels.next(`${fixId}-1`, 0)).resolves.toEqual([{ type: "stop" }]);
  });

  it("cancels every queued job of the ticket, its loop steps and chats included", () => {
    const loop = loopIn("awaiting_review");
    const awaitId = stores.jobs.enqueue({ kind: "loop", ...ISSUE, loopId: loop.id, step: "await" });
    const chatId = stores.jobs.enqueue(linearChat);
    const other = stores.jobs.enqueue({ kind: "linear", run: "chat", issueId: "issue-2", identifier: "API-2", teamKey: "API", sessionId: "s", message: "hi" });

    unassignTicket({ stores, channels: new RunChannels() }, "issue-1");

    expect(stores.jobs.get(awaitId)).toMatchObject({ status: "failed", error: UNASSIGNED_JOB_ERROR });
    expect(stores.jobs.get(chatId)).toMatchObject({ status: "failed", error: UNASSIGNED_JOB_ERROR });
    expect(stores.jobs.get(other)?.status).toBe("queued");
    expect(stores.loops.get(loop.id)?.state).toBe("unassigned");
  });

  it("records the ticket as unassigned though it has no loop yet, and cancels its queued implement", () => {
    const implementId = stores.jobs.enqueue({ kind: "linear", run: "implement", ...ISSUE, sessionId: "session-1", message: null });

    unassignTicket({ stores }, "issue-1");

    expect(stores.agentSessions.isUnassigned("issue-1")).toBe(true);
    expect(stores.jobs.get(implementId)).toMatchObject({ status: "failed", error: UNASSIGNED_JOB_ERROR });
  });

  it("holds a stop for a brain job claimed before its run opened", () => {
    const jobId = stores.jobs.enqueue({ kind: "linear", run: "implement", ...ISSUE, sessionId: "session-1", message: null });
    stores.jobs.claimById(jobId);
    const channels = new RunChannels();

    unassignTicket({ stores, channels }, "issue-1");

    channels.open(`${jobId}-1`, () => undefined, "issue-1", jobId);
    return expect(channels.next(`${jobId}-1`, 0)).resolves.toEqual([{ type: "stop" }]);
  });

  it("parks a handed-back loop too, so a mention can revive it", () => {
    const loop = loopIn("handed_back");

    unassignTicket({ stores }, "issue-1");

    expect(stores.loops.get(loop.id)?.state).toBe("unassigned");
  });
});

describe("reviveTicket", () => {
  const queued = (): TriggerEvent[] => stores.jobs.list({ status: "queued", limit: 50 }).map((job) => job.trigger);

  it("queues the loop's restart step once, then the reviving chat", () => {
    const loop = loopIn("unassigned");

    const chatId = reviveTicket(stores, "issue-1", loop, linearChat);
    reviveTicket(stores, "issue-1", loop, null);

    expect(stores.jobs.get(chatId ?? -1)?.trigger).toEqual(linearChat);
    expect(stores.jobs.queuedForIssue("issue-1").map((job) => job.trigger)).toEqual([{ kind: "loop", ...ISSUE, loopId: loop.id, step: "restart" }, linearChat]);
  });

  it("queues no restart for a loop that is still running", () => {
    const loop = loopIn("awaiting_review");

    expect(reviveTicket(stores, "issue-1", loop, null)).toBeNull();
    expect(queued()).toEqual([]);
  });

  it("revives a ticket that has no loop: no restart, the chat, and the ticket no longer unassigned", () => {
    stores.agentSessions.markUnassigned("issue-1");

    const chatId = reviveTicket(stores, "issue-1", null, linearChat);

    expect(queued()).toEqual([linearChat]);
    expect(stores.jobs.get(chatId ?? -1)?.trigger).toEqual(linearChat);
    expect(stores.agentSessions.isUnassigned("issue-1")).toBe(false);
  });
});

describe("restoreDelegate", () => {
  it("sets the steward back as the issue's delegate", async () => {
    const linear = new RecordingLinear();

    await restoreDelegate({ linear, tracker: { appUserId: () => Promise.resolve("app-user") } }, "issue-1");

    expect(linear.calls).toEqual([{ kind: "delegate", issueId: "issue-1", appUserId: "app-user" }]);
  });

  it("logs a delegate that could not be set, and does not throw", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    const linear = new RecordingLinear();
    vi.spyOn(linear, "setDelegate").mockRejectedValue(new Error("forbidden"));

    await restoreDelegate({ linear, tracker: { appUserId: () => Promise.resolve("app-user") } }, "issue-1");

    expect(warn).toHaveBeenCalledWith({ issueId: "issue-1", err: "forbidden" }, "linear: the steward could not be set back as the delegate");
  });
});
