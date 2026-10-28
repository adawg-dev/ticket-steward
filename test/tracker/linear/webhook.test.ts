import { createHmac } from "node:crypto";
import { parseEvent, verifySignature } from "../../../src/tracker/linear/webhook.js";

const secret = "whsec_test_secret";
const body = JSON.stringify({ hello: "world" });
const sign = (raw: string, s: string) => createHmac("sha256", s).update(raw).digest("hex");

const issueCreateBody = {
  action: "create",
  type: "Issue",
  data: {
    id: "issue-uuid-1",
    identifier: "API-42",
    description: "Something is broken",
    team: { id: "team-1", key: "API", name: "API" },
    state: { id: "state-1", name: "Triage", type: "triage" },
    labels: [{ id: "label-bug", name: "Bug" }],
  },
};

const issueUpdateBody = (labels: Array<{ id: string; name: string }>, updatedFrom: Record<string, unknown>) => ({
  ...issueCreateBody,
  action: "update",
  data: { ...issueCreateBody.data, labels },
  updatedFrom,
});

const agentSessionBody = (action: string, agentActivity: unknown) => ({
  action,
  type: "AgentSessionEvent",
  agentSession: {
    id: "session-1",
    issueId: "issue-uuid-1",
    issue: { id: "issue-uuid-1", identifier: "API-42", team: { key: "API" } },
  },
  agentActivity,
});

describe("verifySignature", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("accepts a valid hex HMAC-SHA256 signature", () => {
    expect(verifySignature(body, sign(body, secret), secret)).toBe(true);
  });

  it("accepts a Buffer body", () => {
    expect(verifySignature(Buffer.from(body), sign(body, secret), secret)).toBe(true);
  });

  it("rejects a tampered body", () => {
    expect(verifySignature(body + " ", sign(body, secret), secret)).toBe(false);
  });

  it("rejects a signature made with another secret", () => {
    expect(verifySignature(body, sign(body, "other"), secret)).toBe(false);
  });

  it("rejects a missing signature", () => {
    expect(verifySignature(body, undefined, secret)).toBe(false);
  });

  it("rejects a malformed signature", () => {
    expect(verifySignature(body, "nothex", secret)).toBe(false);
  });
});

describe("parseEvent", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("maps Issue create to issue.created", () => {
    expect(parseEvent({ event: "Issue", delivery: "d-1" }, issueCreateBody)).toEqual({
      kind: "issue.created",
      issueId: "issue-uuid-1",
      identifier: "API-42",
      teamKey: "API",
      deliveryId: "d-1",
      description: "Something is broken",
      stateType: "triage",
    });
  });

  it("uses an empty description when Issue create has none", () => {
    const data = { id: "issue-uuid-1", identifier: "API-42", team: { id: "team-1", key: "API", name: "API" } };
    expect(parseEvent({ event: "Issue", delivery: "d-1" }, { ...issueCreateBody, data })).toEqual({
      kind: "issue.created",
      issueId: "issue-uuid-1",
      identifier: "API-42",
      teamKey: "API",
      deliveryId: "d-1",
      description: "",
      stateType: null,
    });
  });

  it("ignores Issue update", () => {
    expect(parseEvent({ event: "Issue", delivery: "d-1" }, { ...issueCreateBody, action: "update" })).toBeNull();
  });

  describe("with labels", () => {
    const opts = { labels: { implement: "ready-for-agent" } };
    const TRIAGE = { id: "label-triage", name: "needs-triage" };
    const AGENT = { id: "label-agent", name: "ready-for-agent" };
    const actionOf = (event: ReturnType<typeof parseEvent>) => (event === null ? undefined : event.action);
    const withLabels = (labels: Array<{ id: string; name: string }>) => ({ ...issueCreateBody, data: { ...issueCreateBody.data, labels } });

    it("maps a create carrying ready-for-agent to issue.created with action implement", () => {
      expect(parseEvent({ event: "Issue", delivery: "d-1" }, withLabels([AGENT]), opts)).toEqual({
        kind: "issue.created",
        issueId: "issue-uuid-1",
        identifier: "API-42",
        teamKey: "API",
        deliveryId: "d-1",
        description: "Something is broken",
        stateType: "triage",
        action: "implement",
      });
    });

    it("maps a create without ready-for-agent to issue.created with no action, for intake to skip", () => {
      const event = parseEvent({ event: "Issue", delivery: "d-1" }, withLabels([TRIAGE]), opts);
      expect(event?.kind).toBe("issue.created");
      expect(actionOf(event)).toBeUndefined();
    });

    it("matches label names case-insensitively", () => {
      expect(actionOf(parseEvent({ event: "Issue", delivery: "d-1" }, withLabels([{ id: "x", name: "Ready-For-Agent" }]), opts))).toBe("implement");
    });

    it("maps an update that just added ready-for-agent to issue.labeled", () => {
      const body = issueUpdateBody([TRIAGE, AGENT], { labelIds: ["label-triage"] });
      const event = parseEvent({ event: "Issue", delivery: "d-1" }, body, opts);
      expect(event?.kind).toBe("issue.labeled");
      expect(actionOf(event)).toBe("implement");
    });

    it("ignores an update that added another label", () => {
      expect(parseEvent({ event: "Issue", delivery: "d-1" }, issueUpdateBody([TRIAGE], { labelIds: [] }), opts)).toBeNull();
    });

    it("ignores an update where the labels did not change", () => {
      expect(parseEvent({ event: "Issue", delivery: "d-1" }, issueUpdateBody([AGENT], { title: "Old" }), opts)).toBeNull();
    });

    it("ignores an update where the label was already there", () => {
      expect(parseEvent({ event: "Issue", delivery: "d-1" }, issueUpdateBody([AGENT], { labelIds: ["label-agent"] }), opts)).toBeNull();
    });
  });

  it("ignores AgentSessionEvent deliveries", () => {
    expect(parseEvent({ event: "AgentSessionEvent", delivery: "d-2" }, agentSessionBody("created", undefined))).toBeNull();
  });

  it("ignores unknown event types", () => {
    expect(parseEvent({ event: "Comment", delivery: "d-4" }, { action: "create", data: {} })).toBeNull();
  });

  it("ignores a missing event header", () => {
    expect(parseEvent({ event: undefined, delivery: "d-4" }, issueCreateBody)).toBeNull();
  });

  it("ignores a missing delivery header", () => {
    expect(parseEvent({ event: "Issue", delivery: undefined }, issueCreateBody)).toBeNull();
  });

  it("ignores a body that does not match the Issue shape", () => {
    expect(parseEvent({ event: "Issue", delivery: "d-1" }, { action: "create", data: { id: 1 } })).toBeNull();
  });
});
