import type { PipelineDeps } from "../core/deps.js";
import type { JobOutcome } from "../core/types.js";
import { errorMessage } from "../core/workspace.js";
import type { Loop, LoopPatch } from "../store/loops.js";
import type { FixResult } from "./result.js";
import type { GreptileSummary } from "./summary.js";

/** The hidden marker on every steward comment about a loop; a post is skipped when its marker is already there. */
export const LOOP_MARKER = (loopId: number, what: string): string => `<!-- ticket-steward:loop id=${loopId} ${what} -->`;

/**
 * Which life of the loop a post belongs to: the last hand-back time, written only once a hand-back is fully published. A
 * retry of one publish keeps it, while a restarted loop gets a new one, even at the same round and head.
 */
const lifetime = (loop: Loop): string => `after=${loop.handedBackAt ?? "start"}`;

/** One hand-back per round, head and life of the loop. */
const handbackMarker = (loop: Loop): string =>
  LOOP_MARKER(loop.id, `handback round=${loop.round} head=${loop.headSha.slice(0, 7)} ${lifetime(loop)}`);

const hasMarker = (bodies: string[], marker: string): boolean => bodies.some((body) => body.includes(marker));

const score = (value: number | null): string => (value === null ? "?" : String(value));

/** Posts the MR note unless one with the marker is already on the MR; a loop with no known MR has nowhere to post. */
export const noteOnce = async (deps: Pick<PipelineDeps, "gitlab" | "redactor">, loop: Loop, marker: string, text: string): Promise<void> => {
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

/** Success: the MR gets the round history and the label moves to approved. */
export const publishPassed = (deps: PipelineDeps, loop: Loop, summary: GreptileSummary): Promise<JobOutcome> => {
  const lines = [
    `Greptile ${summary.score}/5 after ${loop.round} fix rounds.`,
    "",
    ...loop.history.map(
      (r) => `- round ${r.round}: ${score(r.score)}/5, pipeline ${r.pipeline ?? "none"}, ${r.fixed} fixed, ${r.declined} declined`,
    ),
  ];
  return publish(
    deps,
    loop,
    [
      { what: "merge request note", run: () => noteOnce(deps, loop, LOOP_MARKER(loop.id, "passed"), lines.join("\n")) },
      { what: "labels", run: () => swapFromImplemented(deps, loop, "approved") },
    ],
    { state: "passed" },
    { status: "succeeded" },
  );
};

/** Hands the ticket back to a person: a note on the MR saying why the steward stopped, then `ready-for-human`. */
export const publishHandback = (deps: PipelineDeps, loop: Loop, reason: string, detail = ""): Promise<JobOutcome> => {
  const marker = handbackMarker(loop);
  const last = loop.history.at(-1);
  const lines = [
    `Ticket Steward stopped and handed this back: ${reason}.`,
    "",
    last === undefined ? "Last Greptile score: none yet" : `Last Greptile score: ${score(last.score)}/5 (round ${last.round})`,
    ...(detail === "" ? [] : ["", "```", detail, "```"]),
  ];
  return publish(
    deps,
    loop,
    [
      { what: "merge request note", run: () => noteOnce(deps, loop, marker, lines.join("\n")) },
      { what: "labels", run: () => swapFromImplemented(deps, loop, "readyForHuman") },
    ],
    { state: "handed_back", handedBackAt: deps.now().toISOString() },
    { status: "succeeded", warning: `handed back: ${reason}` },
  );
};

/** Ends the loop quietly: labels stay, and the MR hears about it only when `note` is set. */
export const publishStop = (deps: PipelineDeps, loop: Loop, reason: string, note: boolean): Promise<JobOutcome> => {
  const text = `Ticket Steward stopped the Greptile loop: ${reason}.`;
  return publish(
    deps,
    loop,
    note ? [{ what: "merge request note", run: () => noteOnce(deps, loop, LOOP_MARKER(loop.id, "stop"), text) }] : [],
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

/** Asks Greptile to review the unchanged head after a round with no push; once per round, head and life of the loop. */
export const requestReview = async (deps: PipelineDeps, loop: Loop): Promise<JobOutcome> => {
  if (deps.gitlab === undefined || loop.projectId === null || loop.mrIid === null) return { status: "publish_failed", error: "review request: no merge request" };
  try {
    await noteOnce(deps, loop, LOOP_MARKER(loop.id, `review round=${loop.round} head=${loop.headSha.slice(0, 7)} ${lifetime(loop)}`), "@greptileai review");
  } catch (err) {
    return { status: "publish_failed", error: `review request: ${errorMessage(err)}` };
  }
  return { status: "succeeded" };
};
