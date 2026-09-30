import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { TriggerEvent } from "../types.js";

export const verifySignature = (rawBody: string | Buffer, signatureHex: string | undefined, secret: string): boolean => {
  if (signatureHex === undefined || !/^[0-9a-f]+$/i.test(signatureHex)) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest();
  const given = Buffer.from(signatureHex, "hex");
  return given.length === expected.length && timingSafeEqual(given, expected);
};

const IssueSchema = z.object({
  action: z.enum(["create", "update"]),
  data: z.object({
    id: z.string(),
    identifier: z.string(),
    description: z.string().nullish(),
    team: z.object({ key: z.string() }),
    state: z.object({ type: z.string() }).nullish(),
    labels: z.array(z.object({ id: z.string(), name: z.string() })).nullish(),
  }),
  updatedFrom: z.object({ labelIds: z.array(z.string()).nullish() }).nullish(),
});

type IssuePayload = z.infer<typeof IssueSchema>;
type IssueEventKind = "issue.created" | "issue.labeled";

/** Without a trigger label every create counts; with one, a create carrying it or an update that just added it. */
const issueEventKind = (payload: IssuePayload, triggerLabel: string | undefined): IssueEventKind | null => {
  if (triggerLabel === undefined) return payload.action === "create" ? "issue.created" : null;
  const wanted = triggerLabel.toLowerCase();
  const label = payload.data.labels?.find((candidate) => candidate.name.toLowerCase() === wanted);
  if (label === undefined) return null;
  if (payload.action === "create") return "issue.created";
  const previous = payload.updatedFrom?.labelIds;
  return previous !== undefined && previous !== null && !previous.includes(label.id) ? "issue.labeled" : null;
};

export const parseEvent = (
  headers: { event: string | undefined; delivery: string | undefined },
  body: unknown,
  opts: { triggerLabel?: string | undefined } = {},
): TriggerEvent | null => {
  const { event, delivery } = headers;
  if (delivery === undefined) return null;

  if (event === "Issue") {
    const parsed = IssueSchema.safeParse(body);
    if (!parsed.success) return null;
    const kind = issueEventKind(parsed.data, opts.triggerLabel);
    if (kind === null) return null;
    const { id, identifier, description, team, state } = parsed.data.data;
    return { kind, issueId: id, identifier, teamKey: team.key, deliveryId: delivery, description: description ?? "", stateType: state?.type ?? null };
  }

  return null;
};
