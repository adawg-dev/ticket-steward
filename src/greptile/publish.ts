import { renderMedia, type MediaUploads } from "../codehost/media.js";
import type { PipelineDeps } from "../core/deps.js";
import type { JobOutcome } from "../core/types.js";
import { errorMessage } from "../core/workspace.js";
import { linearSessionFor } from "../linear/session.js";
import { STOPPED_JOB_ERROR } from "../run/execute.js";
import { ACTIVE_LOOP_STATES, type Loop, type LoopPatch } from "../store/loops.js";
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

type Step = { what: string; run: () => Promise<void> };

/**
 * Runs each publish step; the loop state is written only once every step succeeded, so a retry publishes again. Then
 * the ticket's agent session hears `panel`, if any (best effort: a failed post is logged, never retried). Only a running
 * loop is published for.
 */
const publish = async (deps: PipelineDeps, loop: Loop, steps: Step[], patch: LoopPatch, done: JobOutcome, panel: string | null = null): Promise<JobOutcome> => {
  // A loop parked (the steward unassigned) or ended since its step read it is left as it is, and nothing is posted.
  const parked = (): JobOutcome => ({ status: "succeeded", warning: `loop ${loop.id} is already ${deps.stores.loops.get(loop.id)?.state ?? "gone"}` });
  const current = deps.stores.loops.get(loop.id);
  if (current === null || !ACTIVE_LOOP_STATES.includes(current.state)) return parked();
  for (const step of steps) {
    try {
      await step.run();
    } catch (err) {
      return { status: "publish_failed", error: `${step.what}: ${errorMessage(err)}` };
    }
  }
  if (!deps.stores.loops.update(loop.id, patch, ACTIVE_LOOP_STATES)) return parked();
  if (panel !== null) await linearSessionFor(deps, loop.issueId).finish({ type: "response", body: panel });
  return done;
};

/**
 * Success: the MR gets the round history. `summary` is Greptile's review of the head, null when Greptile is off. Outcome
 * labels were removed with the label trigger.
 */
export const publishPassed = (deps: PipelineDeps, loop: Loop, summary: GreptileSummary | null): Promise<JobOutcome> => {
  const verdict = summary === null ? "Nothing left to answer and the pipeline is green" : `Greptile ${summary.score}/5`;
  const lines = [
    `${verdict} after ${loop.round} fix rounds.`,
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
    ],
    { state: "passed" },
    { status: "succeeded" },
    `${summary === null ? "Nothing is left to answer" : `Greptile scored ${summary.score}/5`} after ${loop.round} fix rounds; the merge request is ready for a person's review.`,
  );
};

/** Hands the ticket back to a person: a note on the MR saying why the steward stopped. */
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
    ],
    { state: "handed_back", handedBackAt: deps.now().toISOString() },
    { status: "succeeded", warning: `handed back: ${reason}` },
    // A stopped run says where it got to itself.
    reason === STOPPED_JOB_ERROR ? null : `I handed the merge request back to a person: ${reason}.`,
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
    `I stopped working on the merge request: ${reason}.`,
  );
};

/**
 * The round's note: its summary and the screenshots and recordings the fix attached, once per round and life of the loop.
 * Nothing is posted for a round without media; its threads' replies say what it did.
 */
export const publishRoundMedia = async (deps: PipelineDeps, loop: Loop, summary: string, media: MediaUploads | undefined): Promise<JobOutcome> => {
  const lines = renderMedia(media);
  if (lines.length === 0) return { status: "succeeded" };
  try {
    await noteOnce(deps, loop, LOOP_MARKER(loop.id, `round ${loop.round} media ${lifetime(loop)}`), [`Round ${loop.round + 1}: ${summary.trim()}`, "", ...lines].join("\n"));
  } catch (err) {
    return { status: "publish_failed", error: `round note: ${errorMessage(err)}` };
  }
  return { status: "succeeded" };
};

/**
 * Replies to every thread the fix answered (a `fixed` one with the pushed commit). Threads are never resolved: whoever
 * opened one decides when it is done, and the steward's reply as its latest note takes it off the work list. A retry
 * skips replies whose marker is there.
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
    }
  } catch (err) {
    return { status: "publish_failed", error: `replies: ${errorMessage(err)}` };
  }
  return { status: "succeeded" };
};
