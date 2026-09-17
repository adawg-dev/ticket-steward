import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { TriggerEvent } from "../types.js";

export const verifySignature = (rawBody: string | Buffer, signatureHex: string | undefined, secret: string): boolean => {
  if (signatureHex === undefined || !/^[0-9a-f]+$/i.test(signatureHex)) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest();
  const given = Buffer.from(signatureHex, "hex");
  return given.length === expected.length && timingSafeEqual(given, expected);
};

const IssueCreateSchema = z.object({
  action: z.literal("create"),
  data: z.object({
    id: z.string(),
    identifier: z.string(),
    description: z.string().nullish(),
    team: z.object({ key: z.string() }),
  }),
});

const AgentSessionEventSchema = z.object({
  action: z.enum(["created", "prompted"]),
  agentSession: z.object({
    id: z.string(),
    issueId: z.string(),
    issue: z.object({ identifier: z.string(), team: z.object({ key: z.string() }) }),
  }),
  agentActivity: z
    .object({ body: z.string().nullish(), content: z.object({ body: z.string().nullish() }).nullish() })
    .nullish(),
});

export const parseEvent = (headers: { event: string | undefined; delivery: string | undefined }, body: unknown): TriggerEvent | null => {
  const { event, delivery } = headers;
  if (delivery === undefined) return null;

  if (event === "Issue") {
    const parsed = IssueCreateSchema.safeParse(body);
    if (!parsed.success) return null;
    const { id, identifier, description, team } = parsed.data.data;
    return { kind: "issue.created", issueId: id, identifier, teamKey: team.key, deliveryId: delivery, description: description ?? "" };
  }

  if (event === "AgentSessionEvent") {
    const parsed = AgentSessionEventSchema.safeParse(body);
    if (!parsed.success) return null;
    const { action, agentSession, agentActivity } = parsed.data;
    const promptBody = agentActivity?.body ?? agentActivity?.content?.body;
    return {
      kind: "agent.session",
      action,
      issueId: agentSession.issueId,
      identifier: agentSession.issue.identifier,
      teamKey: agentSession.issue.team.key,
      sessionId: agentSession.id,
      deliveryId: delivery,
      ...(promptBody == null ? {} : { promptBody }),
    };
  }

  return null;
};
