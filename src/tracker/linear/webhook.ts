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

export const parseEvent = (headers: { event: string | undefined; delivery: string | undefined }, body: unknown): TriggerEvent | null => {
  const { event, delivery } = headers;
  if (delivery === undefined) return null;

  if (event === "Issue") {
    const parsed = IssueCreateSchema.safeParse(body);
    if (!parsed.success) return null;
    const { id, identifier, description, team } = parsed.data.data;
    return { kind: "issue.created", issueId: id, identifier, teamKey: team.key, deliveryId: delivery, description: description ?? "" };
  }

  return null;
};
