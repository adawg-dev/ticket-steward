import { shouldEnqueue, STEWARD_BEGIN, STEWARD_END } from "../../src/core/intake.js";
import type { TriggerEvent } from "../../src/tracker/types.js";

const created: TriggerEvent = {
  kind: "issue.created",
  issueId: "issue-1",
  identifier: "API-1",
  teamKey: "API",
  deliveryId: "delivery-1",
  description: "Something is broken",
};

const cli: TriggerEvent = { kind: "cli", issueId: "issue-1", identifier: "API-1", teamKey: "API" };

const base = { allowlist: ["API"], gatewayIssues: "enrich" as const, priorSuccess: false, hasQueuedJob: false };

const gatewayFooter = "\n\n---\n\n_Routed by ticket-gateway · class `gateway` (p=0.91, margin 0.40, auto) → API · reported by Ana via Slack /ticket_";

describe("shouldEnqueue", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
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

  it("skips issue.created when a prior run succeeded", () => {
    const decision = shouldEnqueue({ ...base, event: created, priorSuccess: true });
    expect(decision.action).toBe("skip");
  });

  it("skips issue.created when the description already holds the steward marker", () => {
    const description = `Body\n\n${STEWARD_BEGIN}\n## Enrichment\n${STEWARD_END}`;
    const decision = shouldEnqueue({ ...base, event: { ...created, description } });
    expect(decision.action).toBe("skip");
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

  it("enqueues issue.created otherwise", () => {
    expect(shouldEnqueue({ ...base, event: created })).toEqual({ action: "enqueue" });
  });

  it("enqueues cli otherwise", () => {
    expect(shouldEnqueue({ ...base, event: cli })).toEqual({ action: "enqueue" });
  });

  it("enqueues a gateway issue by default", () => {
    expect(shouldEnqueue({ ...base, event: { ...created, description: `Body${gatewayFooter}` } })).toEqual({ action: "enqueue" });
  });

  it("skips a gateway issue when gatewayIssues is skip", () => {
    const decision = shouldEnqueue({ ...base, gatewayIssues: "skip", event: { ...created, description: `Body${gatewayFooter}` } });
    expect(decision).toEqual({ action: "skip", reason: "API-1 was created by ticket-gateway, which enriches its own tickets (tracker.gatewayIssues: skip)" });
  });

  it("still enqueues a non-gateway issue when gatewayIssues is skip", () => {
    expect(shouldEnqueue({ ...base, gatewayIssues: "skip", event: created })).toEqual({ action: "enqueue" });
  });

  it("never skips a cli run", () => {
    expect(shouldEnqueue({ ...base, gatewayIssues: "skip", event: cli })).toEqual({ action: "enqueue" });
  });
});
