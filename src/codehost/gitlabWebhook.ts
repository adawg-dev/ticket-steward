import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

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

/** A signed delivery is checked against the signing token; an unsigned one against the legacy `X-Gitlab-Token` secret. */
export const verifyGitlabWebhook = (raw: string, headers: GitlabWebhookHeaders, secrets: GitlabWebhookSecrets, nowSeconds: number): boolean => {
  if (present(secrets.signingToken) && present(headers.signature)) return verifySigned(raw, headers, secrets.signingToken, nowSeconds);
  if (present(secrets.secret) && present(headers.token)) return sameText(headers.token, secrets.secret);
  return false;
};

/** What chat reads of a merge request note: who wrote it, what it says, and the discussion to answer in. */
export interface GitlabNote {
  id: number;
  authorId: number;
  authorUsername: string;
  /** GitLab's `bot` flag on the author, when the payload carries it. */
  authorIsBot: boolean;
  body: string;
  /** Null on GitLab versions that do not send it; the reply then goes on the MR itself. */
  discussionId: string | null;
  system: boolean;
}

/** A GitLab event that may move a waiting fix loop: its MR opened or changed, a note on it, or a pipeline on its branch. */
export interface GitlabWakeEvent {
  kind: "merge_request" | "note" | "pipeline";
  projectId: number;
  projectPath: string;
  branch: string;
  mrIid: number | null;
  /** A note event's note, when the payload has the fields chat needs. */
  note?: GitlabNote;
}

const Project = z.object({ id: z.number(), path_with_namespace: z.string() });
const MergeRequestRef = z.object({ iid: z.number(), source_branch: z.string() });

const MergeRequestHook = z.object({
  project: Project,
  object_attributes: z.object({ iid: z.number(), source_branch: z.string() }),
});

// Fires for created and edited notes alike: Greptile edits its summary note in place on a re-review.
const NoteHook = z.object({
  project: Project,
  object_attributes: z.object({ noteable_type: z.literal("MergeRequest") }),
  merge_request: MergeRequestRef,
});

const NoteDetail = z.object({
  user: z.object({ username: z.string(), bot: z.boolean().nullish() }),
  object_attributes: z.object({
    id: z.number(),
    note: z.string(),
    author_id: z.number(),
    discussion_id: z.string().nullish(),
    system: z.boolean().nullish(),
  }),
});

/** The note itself, or undefined when the payload lacks a field chat needs (the wake does not need them). */
const noteOf = (body: unknown): GitlabNote | undefined => {
  const parsed = NoteDetail.safeParse(body);
  if (!parsed.success) return undefined;
  const { user, object_attributes: note } = parsed.data;
  return {
    id: note.id,
    authorId: note.author_id,
    authorUsername: user.username,
    authorIsBot: user.bot === true,
    body: note.note,
    discussionId: note.discussion_id ?? null,
    system: note.system === true,
  };
};

const PipelineHook = z.object({
  project: Project,
  object_attributes: z.object({ ref: z.string() }),
  merge_request: MergeRequestRef.nullish(),
});

/** The wake-relevant fields of a GitLab event (by its `X-Gitlab-Event` header), or null for any other event or shape. */
export const parseGitlabEvent = (event: string | undefined, body: unknown): GitlabWakeEvent | null => {
  switch (event) {
    case "Merge Request Hook": {
      const parsed = MergeRequestHook.safeParse(body);
      if (!parsed.success) return null;
      const { project, object_attributes: mr } = parsed.data;
      return { kind: "merge_request", projectId: project.id, projectPath: project.path_with_namespace, branch: mr.source_branch, mrIid: mr.iid };
    }
    case "Note Hook": {
      const parsed = NoteHook.safeParse(body);
      if (!parsed.success) return null;
      const { project, merge_request: mr } = parsed.data;
      const note = noteOf(body);
      const event: GitlabWakeEvent = { kind: "note", projectId: project.id, projectPath: project.path_with_namespace, branch: mr.source_branch, mrIid: mr.iid };
      return note === undefined ? event : { ...event, note };
    }
    case "Pipeline Hook": {
      const parsed = PipelineHook.safeParse(body);
      if (!parsed.success) return null;
      const { project, object_attributes: pipeline, merge_request: mr } = parsed.data;
      // An MR pipeline's ref is refs/merge-requests/<iid>/head; its MR names the branch.
      const branch = mr?.source_branch ?? pipeline.ref;
      return { kind: "pipeline", projectId: project.id, projectPath: project.path_with_namespace, branch, mrIid: mr?.iid ?? null };
    }
    default:
      return null;
  }
};
