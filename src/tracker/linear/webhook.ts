import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { IssueTrigger, LabelAction } from "../types.js";

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

export interface TriggerLabels {
  triage: string;
  /** Absent when implement is not configured: the label is then not a trigger, so a ticket created with both labels triages. */
  implement?: string;
}

/** True when the payload carries `name` and it is new: present on a create, or absent from updatedFrom.labelIds on an update. */
const newlyAdded = (payload: IssuePayload, name: string): boolean => {
  const wanted = name.toLowerCase();
  const label = payload.data.labels?.find((candidate) => candidate.name.toLowerCase() === wanted);
  if (label === undefined) return false;
  if (payload.action === "create") return true;
  const previous = payload.updatedFrom?.labelIds;
  return previous !== undefined && previous !== null && !previous.includes(label.id);
};

/** Implement wins when both labels arrive together: the direct path skips triage. */
const labelAction = (payload: IssuePayload, labels: TriggerLabels): LabelAction | null => {
  if (labels.implement !== undefined && newlyAdded(payload, labels.implement)) return "implement";
  if (newlyAdded(payload, labels.triage)) return "triage";
  return null;
};

export const parseEvent = (
  headers: { event: string | undefined; delivery: string | undefined },
  body: unknown,
  opts: { labels?: TriggerLabels | undefined } = {},
): IssueTrigger | null => {
  const { event, delivery } = headers;
  if (delivery === undefined || event !== "Issue") return null;
  const parsed = IssueSchema.safeParse(body);
  if (!parsed.success) return null;
  const { id, identifier, description, team, state } = parsed.data.data;
  const base = { issueId: id, identifier, teamKey: team.key, deliveryId: delivery, description: description ?? "", stateType: state?.type ?? null };
  if (opts.labels === undefined) return parsed.data.action === "create" ? { kind: "issue.created", ...base } : null;
  const action = labelAction(parsed.data, opts.labels);
  if (action === null) return null;
  return { kind: parsed.data.action === "create" ? "issue.created" : "issue.labeled", ...base, action };
};
