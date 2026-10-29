import type { MergeRequestInfo, MrDiscussion, MrNote, NotePosition } from "../codehost/gitlabMr.js";
import type { AuthorKind } from "../codehost/mrAuthors.js";
import type { GreptileConfig } from "../config/schema.js";
import type { Settings } from "../settings/schema.js";
import type { Loop } from "../store/loops.js";
import { parseSummary, shaMatches, type GreptileSummary } from "./summary.js";

/** One discussion the next round answers: by a change and a reply, or a reply alone. */
export interface WorkItem {
  discussionId: string;
  /** Who wrote the discussion's latest note: the one the round answers. */
  author: string;
  isBot: boolean;
  /** The note, or for a thread with replies the whole conversation, each note under its author. */
  body: string;
  /** Where the discussion's first note sits in the diff; null for a general comment. */
  position: NotePosition | null;
}
export type StartedBy = "person" | "bot";

export type GreptileStatus = "pending" | "completed" | "failed" | "skipped";
export type RoundDecision =
  /** `deadline`: when the wait's timeout runs out (null before its clock starts), so the next poll need not overrun it. */
  | { kind: "wait"; waitingFor: "mr" | "review" | "pipeline"; deadline: Date | null }
  /** `summary`: Greptile's review of the head; null when Greptile is off. */
  | { kind: "passed"; summary: GreptileSummary | null }
  /** The head pipeline is red and not yet triaged: its failed jobs may be retried before a round counts. */
  | { kind: "triage"; pipelineId: number }
  | { kind: "fix"; workList: WorkItem[]; startedBy: StartedBy; pipelineFailed: boolean }
  | { kind: "handback"; reason: string }
  | { kind: "stop"; reason: string; note: boolean };
export interface RoundInput {
  loop: Loop;
  /** The loop's timeouts. */
  config: GreptileConfig;
  settings: Settings;
  now: Date;
  ticketClosed: boolean;
  mr: MergeRequestInfo | null;
  /** Greptile's newest summary; null when it has posted none. Ignored while the `greptile.enabled` setting is off. */
  greptile: GreptileSummary | null;
  workList: WorkItem[];
  startedBy: StartedBy;
  /** Only known with the Greptile MCP. */
  greptileStatus: GreptileStatus | null;
  /** Whether CI triage already looked at this poll's red pipeline and retried nothing. */
  ciTriaged: boolean;
}

/**
 * The people who wrote in the round's discussions (any note of a thread on the work list), lowercased: Developers or
 * higher who are neither the steward nor a bot. Only their lasting instructions become decisions.
 */
export const peopleOn = (discussions: MrDiscussion[], items: readonly WorkItem[], kindOf: (note: MrNote) => AuthorKind): Set<string> => {
  const onList = new Set(items.map((item) => item.discussionId));
  const people = new Set<string>();
  for (const discussion of discussions) {
    if (!onList.has(discussion.id)) continue;
    for (const note of discussion.notes) {
      if (!note.system && kindOf(note) === "person") people.add(note.author.toLowerCase());
    }
  }
  return people;
};

/**
 * The round's work list: every unresolved discussion whose latest note is not the steward's, from people and bots alike.
 * An outsider's notes (below Developer, or a bot nobody listed or made a member) are left out of a thread entirely: they
 * neither make it work nor reach the agent. The steward's marker counts only on the steward's own notes. System notes
 * are skipped, and so is a Greptile summary, which the prompt shows whole and which nobody answers in its thread.
 */
export const workList = (discussions: MrDiscussion[], kindOf: (note: MrNote) => AuthorKind): WorkItem[] => {
  const out: WorkItem[] = [];
  for (const discussion of discussions) {
    const all = discussion.notes.filter((note) => !note.system);
    const notes = all.filter((note) => kindOf(note) !== "outsider");
    const first = all[0];
    const latest = notes.at(-1);
    if (first === undefined || latest === undefined) continue;
    if (all.some((note) => note.resolvable && note.resolved)) continue;
    const kind = kindOf(latest);
    if (kind === "steward") continue;
    if (parseSummary(latest.body, latest.updatedAt, "note") !== null) continue;
    out.push({
      discussionId: discussion.id,
      author: latest.author,
      isBot: kind === "bot",
      body: notes.length === 1 ? latest.body : notes.map((note) => `**${note.author}:** ${note.body}`).join("\n\n"),
      position: first.position,
    });
  }
  return out;
};

/** A round is a person's when anything on its list is a person's; otherwise bots or a red pipeline started it. */
export const startedBy = (items: readonly WorkItem[]): StartedBy => (items.some((item) => !item.isBot) ? "person" : "bot");

const UNFINISHED_PIPELINE = new Set(["created", "pending", "running", "waiting_for_resource", "preparing"]);
const DEAD_PIPELINE = new Set(["canceled", "skipped", "manual"]);

/**
 * Decide what the review loop does next; every timeout counts from `loop.waitStartedAt`. With Greptile on, the head's
 * review is waited for first. A red pipeline goes to CI triage first (`ci.triage`). Then: Greptile at the pass score on a
 * green head ends a round only bots started; an empty work list on a green head passes; a bot-started round past the
 * bot-round cap hands back; anything else is a fix.
 */
export const evaluateRound = (input: RoundInput): RoundDecision => {
  const { loop, config, settings, now, mr } = input;
  const greptileOn = settings["greptile.enabled"];
  const timedOut = (minutes: number): boolean =>
    loop.waitStartedAt !== null && now.getTime() - Date.parse(loop.waitStartedAt) > minutes * 60_000;
  const deadline = (minutes: number): Date | null =>
    loop.waitStartedAt === null ? null : new Date(Date.parse(loop.waitStartedAt) + minutes * 60_000);

  if (input.ticketClosed) return { kind: "stop", reason: "the ticket was closed", note: false };
  if (mr === null) {
    return timedOut(config.mrTimeoutMinutes)
      ? { kind: "handback", reason: `no merge request was opened for ${loop.branch}` }
      : { kind: "wait", waitingFor: "mr", deadline: deadline(config.mrTimeoutMinutes) };
  }
  if (mr.state === "merged" || mr.state === "closed") {
    return { kind: "stop", reason: `the merge request was ${mr.state}`, note: true };
  }
  const short = mr.sha.slice(0, 7);
  if (mr.sha.toLowerCase() !== loop.headSha.toLowerCase()) {
    return { kind: "handback", reason: "a person pushed to the branch; the loop stopped" };
  }
  let summary: GreptileSummary | null = null;
  if (greptileOn) {
    if (input.greptileStatus === "failed" || input.greptileStatus === "skipped") {
      return { kind: "handback", reason: `Greptile review ${input.greptileStatus} for ${short}` };
    }
    summary = input.greptile;
    const reviewed = summary !== null
      && shaMatches(summary.lastReviewedSha, mr.sha)
      && (loop.reviewCountAtTrigger === null || (summary.reviewCount ?? -1) > loop.reviewCountAtTrigger);
    if (!reviewed) {
      return timedOut(config.reviewTimeoutMinutes)
        ? { kind: "handback", reason: `Greptile did not review ${short}` }
        : { kind: "wait", waitingFor: "review", deadline: deadline(config.reviewTimeoutMinutes) };
    }
  }
  const pipeline = mr.headPipeline !== null && mr.headPipeline.sha === mr.sha ? mr.headPipeline : null;
  if (pipeline === null || UNFINISHED_PIPELINE.has(pipeline.status)) {
    return timedOut(config.pipelineTimeoutMinutes)
      ? { kind: "handback", reason: `no finished pipeline for ${short}` }
      : { kind: "wait", waitingFor: "pipeline", deadline: deadline(config.pipelineTimeoutMinutes) };
  }
  if (DEAD_PIPELINE.has(pipeline.status)) {
    return { kind: "handback", reason: `the pipeline for ${short} is ${pipeline.status}` };
  }
  if (pipeline.status === "failed" && settings["ci.triage"] && !input.ciTriaged) return { kind: "triage", pipelineId: pipeline.id };
  const green = pipeline.status === "success";
  // Greptile edits one summary instead of posting at its pass score, so its score, not silence, ends bots' rounds.
  if (green && summary !== null && summary.score >= settings["greptile.passScore"] && input.startedBy === "bot") {
    return { kind: "passed", summary };
  }
  if (green && input.workList.length === 0) return { kind: "passed", summary };
  const cap = settings["greptile.maxRounds"];
  if (input.startedBy === "bot" && loop.botRounds >= cap) {
    return { kind: "handback", reason: `stopped after ${loop.botRounds} rounds started by bots; a person's comment starts another` };
  }
  return { kind: "fix", workList: input.workList, startedBy: input.startedBy, pipelineFailed: pipeline.status === "failed" };
};
