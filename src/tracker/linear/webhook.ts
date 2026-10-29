import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

export const verifySignature = (rawBody: string | Buffer, signatureHex: string | undefined, secret: string): boolean => {
  if (signatureHex === undefined || !/^[0-9a-f]+$/i.test(signatureHex)) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest();
  const given = Buffer.from(signatureHex, "hex");
  return given.length === expected.length && timingSafeEqual(given, expected);
};

/** A Linear webhook the steward acts on: its agent sessions (delegation, mention, prompt) and losing a delegation. */
export type LinearEvent =
  | {
      kind: "session.created";
      deliveryId: string;
      sessionId: string;
      issueId: string;
      identifier: string;
      teamKey: string;
      /** True when the issue was delegated to the steward; false when a comment mentioned it. */
      delegated: boolean;
      /** The mentioning comment; null on a delegation. */
      commentBody: string | null;
      promptContext: string;
      /** The comment that opened the session is the steward's own: never work. */
      byApp: boolean;
    }
  | {
      kind: "session.prompted";
      deliveryId: string;
      sessionId: string;
      issueId: string;
      identifier: string;
      teamKey: string;
      body: string;
      /** The person pressed stop in the agent panel. */
      stop: boolean;
      authorName: string;
      /** The prompt is the steward's own: never work. */
      byApp: boolean;
    }
  | { kind: "issue.undelegated"; deliveryId: string; issueId: string; identifier: string; teamKey: string };

const SessionIssue = z.object({ id: z.string(), identifier: z.string(), team: z.object({ key: z.string() }) });

const AgentSessionEventSchema = z.object({
  action: z.enum(["created", "prompted"]),
  appUserId: z.string(),
  agentSession: z.object({
    id: z.string(),
    issue: SessionIssue.nullish(),
    comment: z.object({ body: z.string(), userId: z.string().nullish() }).nullish(),
  }),
  agentActivity: z
    .object({
      content: z.object({ body: z.string().nullish() }),
      signal: z.string().nullish(),
      userId: z.string().nullish(),
      user: z.object({ name: z.string() }).nullish(),
    })
    .nullish(),
  promptContext: z.string().nullish(),
});

const IssueUpdateSchema = z.object({
  action: z.literal("update"),
  data: z.object({ id: z.string(), identifier: z.string(), team: z.object({ key: z.string() }), delegateId: z.string().nullish() }),
  updatedFrom: z.object({ delegateId: z.string().nullish() }).nullish(),
});

const parseSession = (deliveryId: string, body: unknown, appUserId: string): LinearEvent | null => {
  const parsed = AgentSessionEventSchema.safeParse(body);
  // Another app's session (a workspace may install several agents) is not ours to answer.
  if (!parsed.success || parsed.data.appUserId !== appUserId) return null;
  const { action, agentSession, agentActivity, promptContext } = parsed.data;
  const issue = agentSession.issue;
  if (issue === undefined || issue === null) return null;
  const base = { deliveryId, sessionId: agentSession.id, issueId: issue.id, identifier: issue.identifier, teamKey: issue.team.key };
  if (action === "created") {
    const comment = agentSession.comment ?? null;
    return {
      kind: "session.created",
      ...base,
      delegated: comment === null,
      commentBody: comment?.body ?? null,
      promptContext: promptContext ?? "",
      byApp: comment !== null && comment.userId === appUserId,
    };
  }
  if (agentActivity === undefined || agentActivity === null) return null;
  return {
    kind: "session.prompted",
    ...base,
    body: agentActivity.content.body ?? "",
    stop: agentActivity.signal === "stop",
    authorName: agentActivity.user?.name ?? "someone",
    byApp: agentActivity.userId === appUserId,
  };
};

/** An Issue update whose previous delegate was the steward and whose delegate now is not. Any other Issue event is not ours. */
const parseIssue = (deliveryId: string, body: unknown, appUserId: string): LinearEvent | null => {
  const parsed = IssueUpdateSchema.safeParse(body);
  if (!parsed.success) return null;
  const { data, updatedFrom } = parsed.data;
  if (updatedFrom?.delegateId !== appUserId || data.delegateId === appUserId) return null;
  return { kind: "issue.undelegated", deliveryId, issueId: data.id, identifier: data.identifier, teamKey: data.team.key };
};

/** The event the steward acts on, or null for anything else (other types, other apps' sessions, malformed bodies). */
export const parseLinearEvent = (
  headers: { event?: string | undefined; delivery?: string | undefined },
  body: unknown,
  appUserId: string,
): LinearEvent | null => {
  const { event, delivery } = headers;
  if (delivery === undefined) return null;
  if (event === "AgentSessionEvent") return parseSession(delivery, body, appUserId);
  if (event === "Issue") return parseIssue(delivery, body, appUserId);
  return null;
};
