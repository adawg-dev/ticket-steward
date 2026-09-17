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
  },
};

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
    });
  });

  it("ignores Issue update", () => {
    expect(parseEvent({ event: "Issue", delivery: "d-1" }, { ...issueCreateBody, action: "update" })).toBeNull();
  });

  it("maps AgentSessionEvent created to agent.session without a prompt body", () => {
    expect(parseEvent({ event: "AgentSessionEvent", delivery: "d-2" }, agentSessionBody("created", undefined))).toEqual({
      kind: "agent.session",
      action: "created",
      issueId: "issue-uuid-1",
      identifier: "API-42",
      teamKey: "API",
      sessionId: "session-1",
      deliveryId: "d-2",
    });
  });

  it("maps AgentSessionEvent prompted with agentActivity.body", () => {
    expect(
      parseEvent({ event: "AgentSessionEvent", delivery: "d-3" }, agentSessionBody("prompted", { body: "Look at the API" })),
    ).toEqual({
      kind: "agent.session",
      action: "prompted",
      issueId: "issue-uuid-1",
      identifier: "API-42",
      teamKey: "API",
      sessionId: "session-1",
      deliveryId: "d-3",
      promptBody: "Look at the API",
    });
  });

  it("maps AgentSessionEvent prompted with agentActivity.content.body", () => {
    expect(
      parseEvent(
        { event: "AgentSessionEvent", delivery: "d-3" },
        agentSessionBody("prompted", { content: { type: "prompt", body: "Check the worker" } }),
      ),
    ).toEqual({
      kind: "agent.session",
      action: "prompted",
      issueId: "issue-uuid-1",
      identifier: "API-42",
      teamKey: "API",
      sessionId: "session-1",
      deliveryId: "d-3",
      promptBody: "Check the worker",
    });
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
