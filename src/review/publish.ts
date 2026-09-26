import { GitLabApiError, type GitLabReviewApi, type ReviewDiscussion } from "../codehost/gitlabReview.js";
import type { Redactor } from "../core/redact.js";
import { truncate } from "../core/render.js";
import type { JobOutcome } from "../core/types.js";
import { errorMessage } from "../core/workspace.js";
import type { ReviewTrigger, Tracker } from "../tracker/types.js";
import { anchorFor, parseDiffAnchors, toPosition } from "./diff.js";
import type { ReviewComment, ReviewResult, StoredReview } from "./result.js";

export interface ReviewPublishInput {
  jobId: number;
  trigger: ReviewTrigger;
  /** Resolved Linear issue id. */
  issueId: string;
  identifier: string;
  stored: StoredReview;
  /** Contents of mr.diff. */
  diff: string;
  botUsername: string;
  maxComments: number;
}

export interface ReviewPublishDeps {
  api: GitLabReviewApi;
  tracker: Tracker;
  redactor: Redactor;
  permalink: (path: string, sha: string, line?: number) => string;
}

const MARKER = /<!-- ticket-steward:review job=(\d+) sha=([0-9a-f]+) key=([\w-]+) -->/;
const SUMMARY_MAX = 600;
const SEVERITY_RANK: Record<ReviewComment["severity"], number> = { blocker: 0, major: 1, minor: 2 };
const SEVERITY_LABEL: Record<ReviewComment["severity"], string> = { blocker: "Blocker", major: "Major", minor: "Minor" };
const VERDICT_LINE: Record<ReviewResult["verdict"], string> = {
  fixed: "**Verdict: fixed.** The original reproduction no longer shows the bug.",
  not_fixed: "**Verdict: not fixed.** The original reproduction still shows the bug.",
  could_not_run: "**Verdict: could not verify.** The original reproduction could not be replayed.",
  not_applicable: "**Verdict: reviewed.** The ticket is not a bug, so there was nothing to reproduce.",
};

export const reviewMarker = (jobId: number, sha: string, key: string): string => `<!-- ticket-steward:review job=${jobId} sha=${sha} key=${key} -->`;

export const parseMarker = (body: string): { jobId: number; sha: string; key: string } | null => {
  const match = MARKER.exec(body);
  if (match?.[1] === undefined || match[2] === undefined || match[3] === undefined) return null;
  return { jobId: Number(match[1]), sha: match[2], key: match[3] };
};

const short = (sha: string): string => sha.slice(0, 7);

const ownDiscussions = (discussions: ReviewDiscussion[], bot: string): ReviewDiscussion[] =>
  discussions.filter((discussion) => discussion.notes[0]?.author === bot && parseMarker(discussion.notes[0].body) !== null);

const postedKeys = (discussions: ReviewDiscussion[], jobId: number): Set<string> =>
  new Set(
    discussions
      .flatMap((discussion) => discussion.notes)
      .map((note) => parseMarker(note.body))
      .filter((marker): marker is { jobId: number; sha: string; key: string } => marker !== null && marker.jobId === jobId)
      .map((marker) => marker.key),
  );

/** Resolves the steward's own open threads from earlier jobs; human threads are never touched. */
const supersede = async (api: GitLabReviewApi, input: ReviewPublishInput, own: ReviewDiscussion[]): Promise<void> => {
  const head = input.stored.diffRefs.headSha;
  for (const discussion of own) {
    const first = discussion.notes[0];
    const marker = first === undefined ? null : parseMarker(first.body);
    if (first === undefined || marker === null || marker.jobId === input.jobId || !first.resolvable || first.resolved) continue;
    await api.replyToDiscussion(input.trigger.projectId, input.trigger.mrIid, discussion.id, `Superseded by the steward's review of \`${short(head)}\` (job ${input.jobId}).`);
    await api.resolveDiscussion(input.trigger.projectId, input.trigger.mrIid, discussion.id);
  }
};

const commentBody = (comment: ReviewComment): string => `**${SEVERITY_LABEL[comment.severity]}:** ${comment.body}`;

const summaryBody = (input: ReviewPublishInput, overflow: ReviewComment[], permalink: ReviewPublishDeps["permalink"]): string => {
  const { result, diffRefs } = input.stored;
  const lines = [`### Ticket Steward review · ${input.identifier}`, "", VERDICT_LINE[result.verdict]];
  if (result.rerun !== null) {
    lines.push("", `**Replay:** ${result.rerun.observed}`);
    if (result.rerun.deviations !== null) lines.push("", `**Deviations from the recipe:** ${result.rerun.deviations}`);
  }
  lines.push("", result.summary);
  if (overflow.length > 0) {
    lines.push("", "**Other findings** (not attached to a diff line):", "");
    for (const item of overflow) {
      const sha = item.side === "new" ? diffRefs.headSha : diffRefs.baseSha;
      lines.push(`- **${SEVERITY_LABEL[item.severity]}** [${item.path}:${item.line}](${permalink(item.path, sha, item.line)}): ${item.body}`);
    }
  }
  lines.push("", `_Ticket Steward · job ${input.jobId} · \`${short(diffRefs.headSha)}\` · confidence: ${result.confidence}_`);
  return lines.join("\n");
};

export const publishReview = async (input: ReviewPublishInput, deps: ReviewPublishDeps): Promise<JobOutcome> => {
  const { api, redactor } = deps;
  const { projectId, mrIid } = input.trigger;
  const { result, diffRefs } = input.stored;
  try {
    const discussions = await api.listDiscussions(projectId, mrIid);
    const own = ownDiscussions(discussions, input.botUsername);
    const posted = postedKeys(own, input.jobId);
    await supersede(api, input, own);

    const files = parseDiffAnchors(input.diff);
    const ranked = result.comments
      .map((comment, index) => ({ comment, index }))
      .sort((a, b) => SEVERITY_RANK[a.comment.severity] - SEVERITY_RANK[b.comment.severity] || a.index - b.index);
    const overflow: ReviewComment[] = [];
    for (const [rank, { comment, index }] of ranked.entries()) {
      const anchor = anchorFor(files, comment);
      if (rank >= input.maxComments || anchor === null) {
        overflow.push(comment);
        continue;
      }
      const key = `c${index}`;
      if (posted.has(key)) continue;
      const body = `${redactor.redact(commentBody(comment))}\n\n${reviewMarker(input.jobId, diffRefs.headSha, key)}`;
      try {
        await api.createDiffDiscussion(projectId, mrIid, body, toPosition(anchor, diffRefs));
      } catch (err) {
        if (!(err instanceof GitLabApiError && err.status === 400)) throw err;
        overflow.push(comment);
      }
    }

    if (!posted.has("summary")) {
      await api.createNote(projectId, mrIid, `${redactor.redact(summaryBody(input, overflow, deps.permalink))}\n\n${reviewMarker(input.jobId, diffRefs.headSha, "summary")}`);
    }
  } catch (err) {
    return { status: "publish_failed", error: errorMessage(err) };
  }

  if (result.verdict !== "fixed") return { status: "succeeded" };
  try {
    const note = `Verified fixed by !${mrIid} (${input.trigger.mrUrl}) at \`${short(diffRefs.headSha)}\`: the original reproduction no longer shows the bug. ${truncate(result.summary, SUMMARY_MAX)}`;
    await deps.tracker.postComment(input.issueId, redactor.redact(note));
  } catch (err) {
    return { status: "succeeded", warning: errorMessage(err) };
  }
  return { status: "succeeded" };
};

export const postUnverifiable = async (
  api: GitLabReviewApi,
  input: { jobId: number; trigger: ReviewTrigger; identifier: string; botUsername: string; reason: string },
  redactor: Redactor,
): Promise<void> => {
  const { projectId, mrIid, headSha } = input.trigger;
  const discussions = await api.listDiscussions(projectId, mrIid);
  const already = discussions.some((discussion) => discussion.notes.some((note) => note.author === input.botUsername && parseMarker(note.body)?.key === "unverifiable"));
  if (already) return;
  const body = `Ticket Steward could not reproduce ${input.identifier} when the ticket was enriched, so it cannot verify this fix by replaying the reproduction. ${input.reason}`;
  await api.createNote(projectId, mrIid, `${redactor.redact(body)}\n\n${reviewMarker(input.jobId, headSha, "unverifiable")}`);
};
