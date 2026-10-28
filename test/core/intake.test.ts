import { closedReason, shouldEnqueue } from "../../src/core/intake.js";
import type { TriggerEvent } from "../../src/tracker/types.js";

/** A created ticket without the implement label. */
const unlabeled: TriggerEvent = {
  kind: "issue.created",
  issueId: "issue-1",
  identifier: "API-1",
  teamKey: "API",
  deliveryId: "delivery-1",
  description: "Something is broken",
  stateType: "triage",
};

const created: TriggerEvent = { ...unlabeled, action: "implement" };

const labeled: TriggerEvent = { ...created, kind: "issue.labeled" };

const cli: TriggerEvent = { kind: "cli", issueId: "issue-1", identifier: "API-1", teamKey: "API", action: "implement" };

const base = { allowlist: ["API"], priorSuccess: false, hasQueuedJob: false, loop: null };

describe("shouldEnqueue", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("skips a created ticket without the implement label", () => {
    expect(shouldEnqueue({ ...base, event: unlabeled })).toEqual({ action: "skip", reason: "no implement label" });
  });

  it("enqueues a created ticket that carries the implement label", () => {
    expect(shouldEnqueue({ ...base, event: created })).toEqual({ action: "enqueue" });
  });

  it("skips a labeled event without the implement label", () => {
    expect(shouldEnqueue({ ...base, event: { ...unlabeled, kind: "issue.labeled" } })).toEqual({ action: "skip", reason: "no implement label" });
  });

  it("skips issue.created for a team outside the allowlist", () => {
    const decision = shouldEnqueue({ ...base, event: created, allowlist: ["OPS"] });
    expect(decision.action).toBe("skip");
  });

  it("skips cli for a team outside the allowlist", () => {
    const decision = shouldEnqueue({ ...base, event: cli, allowlist: ["OPS"] });
    expect(decision.action).toBe("skip");
  });

  it("treats an empty allowlist as every team", () => {
    expect(shouldEnqueue({ ...base, event: created, allowlist: [] })).toEqual({ action: "enqueue" });
  });

  it("does not skip cli when a prior run succeeded", () => {
    expect(shouldEnqueue({ ...base, event: cli, priorSuccess: true })).toEqual({ action: "enqueue" });
  });

  it("attaches issue.created when a queued job exists", () => {
    expect(shouldEnqueue({ ...base, event: created, hasQueuedJob: true })).toEqual({ action: "attach" });
  });

  it("attaches cli when a queued job exists", () => {
    expect(shouldEnqueue({ ...base, event: cli, hasQueuedJob: true })).toEqual({ action: "attach" });
  });

  it("enqueues cli otherwise", () => {
    expect(shouldEnqueue({ ...base, event: cli })).toEqual({ action: "enqueue" });
  });

  it.each(["completed", "canceled"])("skips issue.created for a %s ticket", (stateType) => {
    const decision = shouldEnqueue({ ...base, event: { ...created, stateType } });
    expect(decision).toEqual({ action: "skip", reason: "API-1 is closed (completed or canceled)" });
  });

  it.each(["completed", "canceled"])("skips issue.labeled for a %s ticket", (stateType) => {
    const decision = shouldEnqueue({ ...base, event: { ...labeled, stateType } });
    expect(decision.action).toBe("skip");
  });

  it("enqueues issue.labeled otherwise", () => {
    expect(shouldEnqueue({ ...base, event: labeled })).toEqual({ action: "enqueue" });
  });
});

describe("implement intake", () => {
  const implementEvent: TriggerEvent = labeled;

  it("skips an implement event when a prior implement job succeeded", () => {
    expect(shouldEnqueue({ ...base, event: implementEvent, priorSuccess: true })).toEqual({ action: "skip", reason: "API-1 was already implemented" });
  });

  it("restarts a handed-back loop even when a prior implement succeeded", () => {
    expect(shouldEnqueue({ ...base, event: implementEvent, priorSuccess: true, loop: { state: "handed_back" } })).toEqual({ action: "restart" });
  });

  it("attaches to a queued restart instead of restarting twice", () => {
    expect(shouldEnqueue({ ...base, event: implementEvent, hasQueuedJob: true, loop: { state: "handed_back" } })).toEqual({ action: "attach" });
  });

  it.each(["awaiting_mr", "awaiting_review", "fixing"] as const)("skips an implement event while the loop is %s", (state) => {
    expect(shouldEnqueue({ ...base, event: implementEvent, loop: { state } })).toEqual({ action: "skip", reason: "API-1 already has a fix loop running" });
  });

  it.each(["passed", "stopped"] as const)("applies the usual rules when the latest loop is %s", (state) => {
    expect(shouldEnqueue({ ...base, event: implementEvent, loop: { state } })).toEqual({ action: "enqueue" });
    expect(shouldEnqueue({ ...base, event: implementEvent, priorSuccess: true, loop: { state } })).toEqual({ action: "skip", reason: "API-1 was already implemented" });
  });

  it("skips an implement event for a closed ticket", () => {
    expect(shouldEnqueue({ ...base, event: { ...implementEvent, stateType: "completed" } }).action).toBe("skip");
  });

  it("names a closed state", () => {
    expect(closedReason("API-1", { name: "Done", type: "completed" })).toBe("API-1 is Done; Ticket Steward does not work on Done or Canceled tickets");
    expect(closedReason("API-1", { name: "Todo", type: "unstarted" })).toBeNull();
  });
});
