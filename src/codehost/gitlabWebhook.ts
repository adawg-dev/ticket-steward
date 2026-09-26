import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { ReviewTrigger } from "../tracker/types.js";

export interface GitlabWebhookHeaders {
  token: string | undefined;
  id: string | undefined;
  timestamp: string | undefined;
  signature: string | undefined;
}

export interface GitlabWebhookSecrets {
  secret: string | undefined;
  signingToken: string | undefined;
}

const TOLERANCE_SECONDS = 300;

const present = (value: string | undefined): value is string => value !== undefined && value !== "";

const sameText = (a: string, b: string): boolean => {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};

/** Standard Webhooks signature, as GitLab 19.1+ signing tokens send it. */
const verifySigned = (raw: string, headers: GitlabWebhookHeaders, signingToken: string, nowSeconds: number): boolean => {
  const { id, timestamp, signature } = headers;
  if (!present(id) || !present(timestamp) || !present(signature)) return false;
  const sent = Number(timestamp);
  if (!Number.isInteger(sent) || Math.abs(nowSeconds - sent) > TOLERANCE_SECONDS) return false;
  const key = Buffer.from(signingToken.replace(/^whsec_/, ""), "base64");
  const expected = `v1,${createHmac("sha256", key).update(`${id}.${timestamp}.${raw}`).digest("base64")}`;
  return signature.split(" ").some((candidate) => sameText(candidate, expected));
};

export const verifyGitlabWebhook = (raw: string, headers: GitlabWebhookHeaders, secrets: GitlabWebhookSecrets, nowSeconds: number): boolean => {
  if (present(secrets.signingToken) && present(headers.signature)) return verifySigned(raw, headers, secrets.signingToken, nowSeconds);
  if (present(secrets.secret) && present(headers.token)) return sameText(headers.token, secrets.secret);
  return false;
};

const KEY = /(?<![A-Za-z0-9])([A-Za-z][A-Za-z0-9]{0,9})-([1-9][0-9]{0,6})(?![0-9])/g;

export const extractLinearKey = (texts: string[], teams: string[]): { key: string; teamKey: string } | null => {
  const allowed = new Set(teams.map((team) => team.toUpperCase()));
  for (const text of texts) {
    for (const match of text.matchAll(KEY)) {
      const team = (match[1] ?? "").toUpperCase();
      if (allowed.size > 0 && !allowed.has(team)) continue;
      return { key: `${team}-${match[2] ?? ""}`, teamKey: team };
    }
  }
  return null;
};

const UserRef = z.object({ username: z.string() });
const Users = z.array(UserRef).nullish();

const MergeRequestHook = z.object({
  object_kind: z.literal("merge_request"),
  project: z.object({ id: z.number(), path_with_namespace: z.string() }),
  object_attributes: z.object({
    iid: z.number(),
    action: z.string().nullish(),
    state: z.string(),
    title: z.string(),
    description: z.string().nullish(),
    source_branch: z.string(),
    source_project_id: z.number(),
    target_project_id: z.number(),
    url: z.string(),
    oldrev: z.string().nullish(),
    last_commit: z.object({ id: z.string() }),
  }),
  reviewers: Users,
  changes: z
    .object({
      // GitLab documents [previous, current]; the payload builder emits { previous, current }. Accept both.
      reviewers: z.union([z.object({ previous: Users, current: Users }), z.tuple([Users, Users])]).nullish(),
    })
    .nullish(),
});

type ReviewerChange = z.infer<typeof MergeRequestHook>["changes"];

export type ParsedMergeRequest = { ok: true; trigger: ReviewTrigger } | { ok: false; reason: string };

const names = (users: Array<{ username: string }> | null | undefined): string[] => (users ?? []).map((user) => user.username);

const newlyAdded = (changes: ReviewerChange, bot: string): boolean => {
  const change = changes?.reviewers;
  if (change === null || change === undefined) return false;
  const [previous, current] = Array.isArray(change) ? [names(change[0]), names(change[1])] : [names(change.previous), names(change.current)];
  return current.includes(bot) && !previous.includes(bot);
};

const triggerReason = (action: string | null | undefined, oldrev: string | null | undefined, changes: ReviewerChange, bot: string): ReviewTrigger["reason"] | null => {
  if (action === "open" || action === "reopen") return "opened";
  if (action !== "update") return null;
  if (oldrev !== null && oldrev !== undefined && oldrev !== "") return "push";
  return newlyAdded(changes, bot) ? "reviewer_added" : null;
};

export const parseMergeRequestEvent = (
  body: unknown,
  opts: { deliveryId: string | undefined; botUsername: string; teams: string[]; allowForks: boolean },
): ParsedMergeRequest => {
  const parsed = MergeRequestHook.safeParse(body);
  if (!parsed.success) return { ok: false, reason: "not a merge request event" };
  const { project, object_attributes: mr, reviewers, changes } = parsed.data;
  if (mr.state !== "opened") return { ok: false, reason: `merge request is ${mr.state}` };
  if (!names(reviewers).includes(opts.botUsername)) return { ok: false, reason: "the steward is not a reviewer" };
  const reason = triggerReason(mr.action, mr.oldrev, changes, opts.botUsername);
  if (reason === null) return { ok: false, reason: `no review-relevant change (action ${mr.action ?? "none"})` };
  if (mr.source_project_id !== mr.target_project_id && !opts.allowForks) return { ok: false, reason: "merge request comes from a fork" };
  const key = extractLinearKey([mr.source_branch, mr.title, mr.description ?? ""], opts.teams);
  if (key === null) return { ok: false, reason: "no Linear key in the branch, title or description" };
  const headSha = mr.last_commit.id;
  return {
    ok: true,
    trigger: {
      kind: "mr.review",
      deliveryId: opts.deliveryId ?? `gitlab:${project.id}:${mr.iid}:${headSha}:${reason}`,
      projectId: project.id,
      projectPath: project.path_with_namespace,
      mrIid: mr.iid,
      mrUrl: mr.url,
      headSha,
      linearKey: key.key,
      teamKey: key.teamKey,
      reason,
    },
  };
};
