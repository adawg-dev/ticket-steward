import { createHmac } from "node:crypto";
import { freshWebhook, parseLinearEvent, verifySignature } from "../../../src/tracker/linear/webhook.js";

const secret = "whsec_test_secret";
const body = JSON.stringify({ hello: "world" });
const sign = (raw: string, s: string) => createHmac("sha256", s).update(raw).digest("hex");

const APP = "app-user-1";

const issue = { id: "issue-uuid-1", identifier: "API-42", title: "Adapter drops the last chunk", url: "https://linear.app/x/API-42", teamId: "team-1", team: { id: "team-1", key: "API", name: "API" } };

const sessionCreated = (over: { comment?: { id: string; body: string; userId?: string } } = {}) => ({
  action: "created",
  type: "AgentSessionEvent",
  appUserId: APP,
  agentSession: { id: "session-1", appUserId: APP, issueId: issue.id, issue, status: "pending", ...(over.comment === undefined ? {} : { comment: over.comment, commentId: over.comment.id }) },
  promptContext: "<issue identifier=\"API-42\">...</issue>",
});

const sessionPrompted = (activity: { body: string; signal?: string; userId?: string; name?: string }) => ({
  action: "prompted",
  type: "AgentSessionEvent",
  appUserId: APP,
  agentSession: { id: "session-1", appUserId: APP, issueId: issue.id, issue, status: "active" },
  agentActivity: {
    id: "activity-1",
    agentSessionId: "session-1",
    content: { type: "prompt", body: activity.body },
    ...(activity.signal === undefined ? {} : { signal: activity.signal }),
    userId: activity.userId ?? "user-9",
    user: { id: activity.userId ?? "user-9", name: activity.name ?? "Ada Lovelace", email: "ada@example.com", url: "https://linear.app/u/ada" },
  },
});

const issueUpdate = (delegateId: string | null, updatedFrom: Record<string, unknown>) => ({
  action: "update",
  type: "Issue",
  data: { id: issue.id, identifier: issue.identifier, team: { id: "team-1", key: "API" }, delegateId },
  updatedFrom,
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

describe("freshWebhook", () => {
  const now = Date.parse("2026-10-29T10:00:00Z");
  it("accepts a signed timestamp within a minute either way, and nothing else", () => {
    expect(freshWebhook({ webhookTimestamp: now - 60_000 }, now)).toBe(true);
    expect(freshWebhook({ webhookTimestamp: now + 30_000 }, now)).toBe(true);
    expect(freshWebhook({ webhookTimestamp: now - 60_001 }, now)).toBe(false);
    expect(freshWebhook({ webhookTimestamp: String(now) }, now)).toBe(false);
    expect(freshWebhook({}, now)).toBe(false);
  });
});

describe("parseLinearEvent", () => {
  const parse = (event: string | undefined, body: unknown) => parseLinearEvent({ event, delivery: "d-1" }, body, APP);

  it("maps a delegation's created session (no comment) to session.created, delegated", () => {
    expect(parse("AgentSessionEvent", sessionCreated())).toEqual({
      kind: "session.created",
      deliveryId: "linear-session-created:session-1",
      sessionId: "session-1",
      issueId: "issue-uuid-1",
      identifier: "API-42",
      teamKey: "API",
      delegated: true,
      commentBody: null,
      promptContext: "<issue identifier=\"API-42\">...</issue>",
      byApp: false,
    });
  });

  it("maps a mention's created session to session.created with the comment, not delegated", () => {
    const event = parse("AgentSessionEvent", sessionCreated({ comment: { id: "c-1", body: "@steward why is this slow?", userId: "user-9" } }));
    expect(event).toMatchObject({ kind: "session.created", delegated: false, commentBody: "@steward why is this slow?", byApp: false });
  });

  it("marks a session created from the steward's own comment as by the app", () => {
    const event = parse("AgentSessionEvent", sessionCreated({ comment: { id: "c-1", body: "Picked this up", userId: APP } }));
    expect(event).toMatchObject({ kind: "session.created", byApp: true });
  });

  it("maps a prompt to session.prompted with its body and author", () => {
    expect(parse("AgentSessionEvent", sessionPrompted({ body: "use v2 instead" }))).toEqual({
      kind: "session.prompted",
      deliveryId: "linear-activity:activity-1",
      sessionId: "session-1",
      issueId: "issue-uuid-1",
      identifier: "API-42",
      teamKey: "API",
      body: "use v2 instead",
      stop: false,
      authorName: "Ada Lovelace",
      byApp: false,
    });
  });

  it("reads the stop signal", () => {
    expect(parse("AgentSessionEvent", sessionPrompted({ body: "", signal: "stop" }))).toMatchObject({ kind: "session.prompted", stop: true });
  });

  it("marks a prompt by the app user as by the app", () => {
    expect(parse("AgentSessionEvent", sessionPrompted({ body: "x", userId: APP }))).toMatchObject({ byApp: true });
  });

  it("maps an Issue update that removed the steward as delegate to issue.undelegated", () => {
    expect(parse("Issue", issueUpdate(null, { delegateId: APP }))).toEqual({
      kind: "issue.undelegated",
      deliveryId: "d-1",
      issueId: "issue-uuid-1",
      identifier: "API-42",
      teamKey: "API",
    });
    expect(parse("Issue", issueUpdate("someone-else", { delegateId: APP }))?.kind).toBe("issue.undelegated");
  });

  it("keys an Issue update by its issue and signed update time when the body has one", () => {
    const update = { ...issueUpdate(null, { delegateId: APP }), data: { ...issueUpdate(null, {}).data, updatedAt: "2026-10-29T10:00:00.000Z" } };
    expect(parse("Issue", update)).toMatchObject({ deliveryId: "linear-issue:issue-uuid-1:2026-10-29T10:00:00.000Z" });
  });

  it("ignores a delegate change that does not involve the steward", () => {
    expect(parse("Issue", issueUpdate("someone-else", { delegateId: "another" }))).toBeNull();
    expect(parse("Issue", issueUpdate(null, { delegateId: "another" }))).toBeNull();
  });

  it("ignores a delegation to the steward (its agent session event starts the work) and other Issue updates", () => {
    expect(parse("Issue", issueUpdate(APP, { delegateId: null }))).toBeNull();
    expect(parse("Issue", issueUpdate(APP, { title: "Old" }))).toBeNull();
    expect(parse("Issue", { ...issueUpdate(null, { delegateId: APP }), action: "create" })).toBeNull();
  });

  it("ignores another app's agent session", () => {
    expect(parse("AgentSessionEvent", { ...sessionCreated(), appUserId: "other-app" })).toBeNull();
  });

  it("ignores a session event without an issue", () => {
    const body = sessionCreated();
    expect(parse("AgentSessionEvent", { ...body, agentSession: { ...body.agentSession, issue: undefined, issueId: undefined } })).toBeNull();
  });

  it("ignores other event types, a missing event header or delivery id, and malformed bodies", () => {
    expect(parse("Comment", { action: "create", data: {} })).toBeNull();
    expect(parse(undefined, sessionCreated())).toBeNull();
    expect(parseLinearEvent({ event: "AgentSessionEvent", delivery: undefined }, sessionCreated(), APP)).toBeNull();
    expect(parse("AgentSessionEvent", { action: "created", agentSession: { id: 1 } })).toBeNull();
    expect(parse("AgentSessionEvent", { ...sessionCreated(), action: "archived" })).toBeNull();
  });
});
