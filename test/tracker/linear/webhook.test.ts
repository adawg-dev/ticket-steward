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

const STEWARD_LABEL = { id: "label-steward", name: "steward" };

const labeledCreateBody = { ...issueCreateBody, data: { ...issueCreateBody.data, labels: [{ id: "label-bug", name: "Bug" }, STEWARD_LABEL] } };

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

  describe("with a trigger label", () => {
    const opts = { triggerLabel: "steward" };

    it("maps an Issue create that carries the label to issue.created", () => {
      expect(parseEvent({ event: "Issue", delivery: "d-1" }, labeledCreateBody, opts)).toEqual({
        kind: "issue.created",
        issueId: "issue-uuid-1",
        identifier: "API-42",
        teamKey: "API",
        deliveryId: "d-1",
        description: "Something is broken",
        stateType: "triage",
      });
    });

    it("matches the label name case-insensitively", () => {
      expect(parseEvent({ event: "Issue", delivery: "d-1" }, labeledCreateBody, { triggerLabel: "Steward" })?.kind).toBe("issue.created");
    });

    it("ignores an Issue create without the label", () => {
      expect(parseEvent({ event: "Issue", delivery: "d-1" }, issueCreateBody, opts)).toBeNull();
    });

    it("maps an Issue update that just added the label to issue.labeled", () => {
      const body = issueUpdateBody([{ id: "label-bug", name: "Bug" }, STEWARD_LABEL], { labelIds: ["label-bug"] });
      expect(parseEvent({ event: "Issue", delivery: "d-1" }, body, opts)).toEqual({
        kind: "issue.labeled",
        issueId: "issue-uuid-1",
        identifier: "API-42",
        teamKey: "API",
        deliveryId: "d-1",
        description: "Something is broken",
        stateType: "triage",
      });
    });

    it("ignores an Issue update that did not change the labels", () => {
      const body = issueUpdateBody([STEWARD_LABEL], { title: "Old title" });
      expect(parseEvent({ event: "Issue", delivery: "d-1" }, body, opts)).toBeNull();
    });

    it("ignores an Issue update where the label was already there", () => {
      const body = issueUpdateBody([{ id: "label-bug", name: "Bug" }, STEWARD_LABEL], { labelIds: ["label-steward"] });
      expect(parseEvent({ event: "Issue", delivery: "d-1" }, body, opts)).toBeNull();
    });

    it("ignores an Issue update that added some other label", () => {
      const body = issueUpdateBody([{ id: "label-bug", name: "Bug" }], { labelIds: [] });
      expect(parseEvent({ event: "Issue", delivery: "d-1" }, body, opts)).toBeNull();
    });

    it("ignores an Issue update that removed the label", () => {
      const body = issueUpdateBody([], { labelIds: ["label-steward"] });
      expect(parseEvent({ event: "Issue", delivery: "d-1" }, body, opts)).toBeNull();
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
