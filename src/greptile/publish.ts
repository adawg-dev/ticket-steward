import type { PipelineDeps } from "../core/deps.js";
import type { JobOutcome } from "../core/types.js";
import { errorMessage } from "../core/workspace.js";
import type { Loop, LoopPatch } from "../store/loops.js";
import type { FixResult } from "./result.js";
import type { GreptileSummary } from "./summary.js";

/** The hidden marker on every steward comment about a loop; a post is skipped when its marker is already there. */
export const LOOP_MARKER = (loopId: number, what: string): string => `<!-- ticket-steward:loop id=${loopId} ${what} -->`;

/** One hand-back per round and head: a restarted loop that is handed back again gets a fresh marker. */
const handbackMarker = (loop: Loop): string => LOOP_MARKER(loop.id, `handback round=${loop.round} head=${loop.headSha.slice(0, 7)}`);

const hasMarker = (bodies: string[], marker: string): boolean => bodies.some((body) => body.includes(marker));

const score = (value: number | null): string => (value === null ? "?" : String(value));

/** Posts the Linear comment unless one with the marker is already on the ticket. */
const commentOnce = async (deps: PipelineDeps, loop: Loop, marker: string, lines: string[]): Promise<void> => {
  const ticket = await deps.tracker.fetchTicket(loop.issueId);
  if (hasMarker(ticket.comments.map((comment) => comment.body), marker)) return;
  await deps.tracker.postComment(loop.issueId, deps.redactor.redact([...lines, "", marker].join("\n")));
};

/** Posts the MR note unless one with the marker is already on the MR; a loop with no known MR has nowhere to post. */
const noteOnce = async (deps: PipelineDeps, loop: Loop, marker: string, text: string): Promise<void> => {
  if (deps.gitlab === undefined || loop.projectId === null || loop.mrIid === null) return;
  const discussions = await deps.gitlab.listDiscussions(loop.projectId, loop.mrIid);
  if (hasMarker(discussions.flatMap((discussion) => discussion.notes.map((note) => note.body)), marker)) return;
  await deps.gitlab.createNote(loop.projectId, loop.mrIid, deps.redactor.redact(`${text}\n\n${marker}`));
};

/** Swaps `agent-implemented` for `to`, only for a loop a label started. */
const swapFromImplemented = async (deps: PipelineDeps, loop: Loop, to: "approved" | "readyForHuman"): Promise<void> => {
  const labels = deps.config.tracker.labels;
  if (!loop.labelDriven || labels === undefined) return;
  await deps.tracker.swapLabel(loop.issueId, labels.implemented, labels[to]);
};

type Step = { what: string; run: () => Promise<void> };

/** Runs each publish step; the loop state is written only once every step succeeded, so a retry publishes again. */
const publish = async (deps: PipelineDeps, loop: Loop, steps: Step[], patch: LoopPatch, done: JobOutcome): Promise<JobOutcome> => {
  for (const step of steps) {
    try {
      await step.run();
    } catch (err) {
      return { status: "publish_failed", error: `${step.what}: ${errorMessage(err)}` };
    }
  }
  deps.stores.loops.update(loop.id, patch);
  return done;
};

/** Success: the ticket gets the round history, the label moves to approved, the MR is left alone. */
export const publishPassed = (deps: PipelineDeps, loop: Loop, summary: GreptileSummary): Promise<JobOutcome> => {
  const lines = [
    `Greptile ${summary.score}/5 after ${loop.round} fix rounds: ${loop.mrUrl ?? "(merge request link unknown)"}`,
    "",
    ...loop.history.map(
      (r) => `- round ${r.round}: ${score(r.score)}/5, pipeline ${r.pipeline ?? "none"}, ${r.fixed} fixed, ${r.declined} declined`,
    ),
  ];
  return publish(
    deps,
    loop,
    [
      { what: "comment", run: () => commentOnce(deps, loop, LOOP_MARKER(loop.id, "passed"), lines) },
      { what: "labels", run: () => swapFromImplemented(deps, loop, "approved") },
    ],
    { state: "passed" },
    { status: "succeeded" },
  );
};

/**
 * Hands the ticket back to a person: a Linear comment, `ready-for-human`, and a note on the MR saying why the steward stopped.
 * `detail` (an output tail, paths) goes in the Linear comment only.
 */
export const publishHandback = (deps: PipelineDeps, loop: Loop, reason: string, detail = ""): Promise<JobOutcome> => {
  const marker = handbackMarker(loop);
  const last = loop.history.at(-1);
  const lines = [
    `Ticket Steward handed this back: ${reason}.`,
    "",
    `Merge request: ${loop.mrUrl ?? "none found"}`,
    last === undefined ? "Last Greptile score: none yet" : `Last Greptile score: ${score(last.score)}/5 (round ${last.round})`,
    ...(detail === "" ? [] : ["", "```", detail, "```"]),
  ];
  return publish(
    deps,
    loop,
    [
      { what: "comment", run: () => commentOnce(deps, loop, marker, lines) },
      { what: "labels", run: () => swapFromImplemented(deps, loop, "readyForHuman") },
      { what: "merge request note", run: () => noteOnce(deps, loop, marker, `Ticket Steward stopped: ${reason}`) },
    ],
    { state: "handed_back", handedBackAt: deps.now().toISOString() },
    { status: "succeeded", warning: `handed back: ${reason}` },
  );
};

/** Ends the loop quietly: labels stay, and Linear hears about it only when `comment` is set. */
export const publishStop = (deps: PipelineDeps, loop: Loop, reason: string, comment: boolean): Promise<JobOutcome> => {
  const lines = [`Ticket Steward stopped the Greptile loop: ${reason}.`, ...(loop.mrUrl === null ? [] : ["", `Merge request: ${loop.mrUrl}`])];
  return publish(
    deps,
    loop,
    comment ? [{ what: "comment", run: () => commentOnce(deps, loop, LOOP_MARKER(loop.id, "stop"), lines) }] : [],
    { state: "stopped" },
    { status: "succeeded", warning: `stopped: ${reason}` },
  );
};

/**
 * Replies to every thread the fix answered (a `fixed` one with the pushed commit), then resolves it: Greptile keeps an
 * unresolved finding in its summary, so declined threads are resolved too. A retry skips replies whose marker is there and
 * threads already resolved.
 */
export const publishThreads = async (deps: PipelineDeps, loop: Loop, result: FixResult, pushedSha: string | null): Promise<JobOutcome> => {
  const gitlab = deps.gitlab;
  if (gitlab === undefined || loop.projectId === null || loop.mrIid === null) return { status: "publish_failed", error: "replies: no merge request to reply on" };
  const { projectId, mrIid } = loop;
  try {
    const discussions = await gitlab.listDiscussions(projectId, mrIid);
    for (const thread of result.threads) {
      const marker = LOOP_MARKER(loop.id, `reply ${thread.discussionId} ${pushedSha ?? "nopush"}`);
      const notes = discussions.find((discussion) => discussion.id === thread.discussionId)?.notes ?? [];
      if (!hasMarker(notes.map((note) => note.body), marker)) {
        const fixedIn = thread.action === "fixed" && pushedSha !== null ? `\n\nFixed in ${pushedSha.slice(0, 7)}.` : "";
        await gitlab.replyToDiscussion(projectId, mrIid, thread.discussionId, deps.redactor.redact(`${thread.reply}${fixedIn}\n\n${marker}`));
      }
      if (notes[0]?.resolved !== true) await gitlab.resolveDiscussion(projectId, mrIid, thread.discussionId);
    }
  } catch (err) {
    return { status: "publish_failed", error: `replies: ${errorMessage(err)}` };
  }
  return { status: "succeeded" };
};

/** Asks Greptile to review the unchanged head after a round with no push; once per round and head. */
export const requestReview = async (deps: PipelineDeps, loop: Loop): Promise<JobOutcome> => {
  if (deps.gitlab === undefined || loop.projectId === null || loop.mrIid === null) return { status: "publish_failed", error: "review request: no merge request" };
  try {
    await noteOnce(deps, loop, LOOP_MARKER(loop.id, `review round=${loop.round} head=${loop.headSha.slice(0, 7)}`), "@greptileai review");
  } catch (err) {
    return { status: "publish_failed", error: `review request: ${errorMessage(err)}` };
  }
  return { status: "succeeded" };
};
