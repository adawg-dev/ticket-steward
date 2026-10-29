import { renderMedia } from "../codehost/media.js";
import type { StoredImplement } from "../implement/result.js";
import { logger } from "../log.js";
import type { RunChannels } from "../run/channel.js";
import { STOPPED_JOB_ERROR } from "../run/execute.js";
import type { RunHooks } from "../run/executor.js";
import type { Settings } from "../settings/schema.js";
import type { Stores } from "../store/index.js";
import type { ActivityContent, LinearAgentApi } from "../tracker/linear/agent.js";
import type { LinearEvent } from "../tracker/linear/webhook.js";
import { createBrainLineMapper, panelScrub } from "./activities.js";
import { ASSIGN_ME_REPLY, type LinearIntakeResult } from "./intake.js";
import { ActivityPoster } from "./poster.js";

/** What the agent panel needs: Linear's agent API (absent, nothing is posted), the runtime settings and the run redactor. */
export interface LinearPanelDeps {
  linear?: LinearAgentApi;
  settings?: { get(): Settings };
  stores: Pick<Stores, "agentSessions">;
  redactor: { redact(text: string): string };
}

/** A run's view of the ticket's current agent session. On a ticket Linear never opened a session for, every call is a no-op. */
export interface LinearSession {
  /** A thought of the steward's own, through the run's poster. */
  thought(text: string): void;
  /** Null when the ticket has no agent session (CLI runs, loops from before the Linear app). */
  poster: ActivityPoster | null;
  /** The executor hooks: each brain line is mapped to panel events and posted. */
  hooks: RunHooks;
  /** The last thought the brain (or the steward) had in this run, scrubbed; null before the first. */
  lastThought(): string | null;
  /** Posts everything queued (ephemerals dropped), then `content`. Never throws: a failed post is logged. */
  finish(content: ActivityContent): Promise<void>;
  /** Links the merge request from the session. Never throws. */
  setMrUrl(url: string): Promise<void>;
}

/** Thoughts and answers the steward posts itself, never the agent. */
export const PANEL_TEXT = {
  pickedUp: "Picked this up; reading the ticket",
  answerTaken: "Got your answer; picking the work back up",
  reading: "Reading your message",
  steered: "Got it; passing that on while I work",
  waitForLease: "Someone is in a terminal session on this ticket; I'll pick your message up when they leave",
  nothingToStop: "Stopped. Nothing was running.",
} as const;

const DEFAULT_INTERVAL_MS = 2_000;
const DEFAULT_REVIEW_STATE = "In Review";
/** An error activity shows this much of the job's error: its first line, never output tails. */
const MAX_ERROR_CHARS = 300;

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** The steering message the brain gets for a prompt sent while it works. */
export const steerText = (authorName: string, body: string): string => `Message from ${authorName} in Linear while you were working:\n${body}`;

/** The session of a ticket Linear never opened one for (or of a dry run): it posts nothing. */
export const NO_SESSION: LinearSession = {
  thought: () => undefined,
  poster: null,
  hooks: {},
  lastThought: () => null,
  finish: () => Promise.resolve(),
  setMrUrl: () => Promise.resolve(),
};

/** Every text the panel shows passes the run redactor plus placeholder stripping. */
export const panelScrubOf = (deps: Pick<LinearPanelDeps, "redactor">): ((text: string) => string) =>
  // Guard values are rendered inside each run pod and never reach the dispatcher; its redactor holds the real secrets.
  panelScrub({ redact: (text) => deps.redactor.redact(text), guardValues: () => [] });

const scrubContent = (content: ActivityContent, scrub: (text: string) => string): ActivityContent =>
  content.type === "action" ? { ...content, parameter: scrub(content.parameter) } : { ...content, body: scrub(content.body) };

/**
 * The ticket's agent session as one run sees it: brain lines become panel events posted at the configured rate, and its
 * end is one final activity. Activities go to the ticket's current session, read on each post, so a mention that opens
 * a new session mid-run gets the rest. A no-op object when Linear is not wired or the ticket never had a session.
 */
export const linearSessionFor = (
  deps: LinearPanelDeps,
  issueId: string,
  opts: { workspacePath?: string; now?: () => number; setTimer?: typeof setTimeout } = {},
): LinearSession => {
  const api = deps.linear;
  if (api === undefined || deps.stores.agentSessions.current(issueId) === null) return NO_SESSION;
  const sessionId = (): string | null => deps.stores.agentSessions.current(issueId);
  const scrub = panelScrubOf(deps);
  const poster = new ActivityPoster({
    api,
    sessionId,
    intervalMs: () => deps.settings?.get()["linear.activityIntervalMs"] ?? DEFAULT_INTERVAL_MS,
    now: opts.now ?? Date.now,
    setTimer: opts.setTimer ?? setTimeout,
  });
  const map = createBrainLineMapper({ scrub, ...(opts.workspacePath === undefined ? {} : { workspacePath: opts.workspacePath }) });
  let last: string | null = null;
  return {
    thought: (text) => {
      last = scrub(text);
      poster.push({ activity: { type: "thought", body: last }, ephemeral: false });
    },
    poster,
    hooks: {
      onLine: (line) => {
        for (const event of map(line)) {
          if ("activity" in event && event.activity.type === "thought") last = event.activity.body;
          poster.push(event);
        }
      },
    },
    lastThought: () => last,
    finish: async (content) => {
      poster.push({ activity: scrubContent(content, scrub), ephemeral: false });
      await poster.flush();
    },
    setMrUrl: async (url) => {
      const current = sessionId();
      if (current === null) return;
      try {
        await api.setExternalUrls(current, [{ label: "Merge request", url }]);
      } catch (err) {
        logger.warn({ issueId, err: errorMessage(err) }, "linear: the merge request link could not be set");
      }
    },
  };
};

const bullets = (items: string[]): string[] => items.filter((item) => item.trim() !== "").map((item) => `- ${item.trim()}`);

/** What a stopped run says: where it got to (its last thought) and the last commit it pushed, if any. */
export const stoppedResponse = (lastThought: string | null, pushedSha: string | null): ActivityContent => ({
  type: "response",
  body: [
    `Stopped. Where I got to: ${lastThought ?? "I had not started on anything yet."}`,
    ...(pushedSha === null ? [] : ["", `Last pushed commit: ${pushedSha.slice(0, 7)}.`]),
  ].join("\n"),
});

/**
 * The implement's last word in the panel, from its stored result: questions as an elicitation, a hand-back as an error,
 * and a pushed change as a response with its summary, checks and media. Null when nothing was stored.
 */
export const implementFinish = (stored: StoredImplement | null): ActivityContent | null => {
  if (stored === null) return null;
  const { result, handback } = stored;
  if (result?.outcome === "needs_info") {
    return { type: "elicitation", body: ["I need more information before I can implement this:", "", ...bullets(result.questions)].join("\n") };
  }
  if (handback !== null) {
    const detail = result?.outcome === "failed" && result.failureDetail !== null ? ["", result.failureDetail.trim()] : [];
    return { type: "error", body: [`I stopped and handed this back: ${handback.reason}.`, ...detail].join("\n") };
  }
  if (result === null) return null;
  const media = renderMedia(stored.media);
  return {
    type: "response",
    body: [
      result.summary.trim(),
      ...(result.checksRun.length > 0 ? ["", "**Checks I ran**", ...bullets(result.checksRun)] : []),
      ...(media.length > 0 ? ["", ...media] : []),
    ].join("\n"),
  };
};

/** A job that failed for good, as an error activity: the first line of its error only. */
export const failureContent = (error: string): ActivityContent => {
  const first = (error.split("\n")[0] ?? "").trim();
  return { type: "error", body: `The run failed: ${first.length > MAX_ERROR_CHARS ? `${first.slice(0, MAX_ERROR_CHARS)}…` : first}` };
};

/** The state names already logged missing, per agent API (one per process): a missing state is logged once, not per ticket. */
const loggedMissing = new WeakMap<LinearAgentApi, Set<string>>();

const logMissingOnce = (api: LinearAgentApi, state: string, issueId: string): void => {
  const logged = loggedMissing.get(api) ?? new Set<string>();
  loggedMissing.set(api, logged);
  if (logged.has(state)) return;
  logged.add(state);
  logger.warn({ state, issueId }, "linear: the team has no such workflow state; tickets stay where they are");
};

/**
 * Moves the ticket to `which`. A missing state is logged (once per state) and the session's panel says so; a failed
 * move is logged. Never throws: the work goes on wherever the ticket is.
 */
const moveTicket = async (deps: LinearPanelDeps, api: LinearAgentApi, issueId: string, which: { type: "started" } | { name: string }, sessionId: string | null): Promise<void> => {
  const state = "name" in which ? which.name : "started";
  try {
    if ((await api.moveToState(issueId, which)) !== "missing") return;
    logMissingOnce(api, state, issueId);
    if (sessionId !== null) {
      const body = `I could not move the ticket to "${state}": its team has no workflow state by that name.`;
      await api.createActivity(sessionId, { type: "thought", body: panelScrubOf(deps)(body) });
    }
  } catch (err) {
    logger.warn({ issueId, state, err: errorMessage(err) }, "linear: the ticket's workflow state could not be moved");
  }
};

/** On delegation, the ticket moves to its team's first started state unless it is there or later (`linear.moveToStarted`). */
export const moveToStarted = async (deps: LinearPanelDeps, issueId: string, sessionId: string | null): Promise<void> => {
  const api = deps.linear;
  if (api === undefined || deps.settings?.get()["linear.moveToStarted"] === false) return;
  await moveTicket(deps, api, issueId, { type: "started" }, sessionId);
};

/**
 * The ticket's MR is open: the session links it, and the ticket moves to the review state (`linear.reviewStateName`).
 * A ticket Linear never opened a session for is left alone.
 */
export const mergeRequestOpened = async (deps: LinearPanelDeps, issueId: string, url: string): Promise<void> => {
  const api = deps.linear;
  const sessionId = deps.stores.agentSessions.current(issueId);
  if (api === undefined || sessionId === null) return;
  await linearSessionFor(deps, issueId).setMrUrl(url);
  const name = deps.settings?.get()["linear.reviewStateName"] ?? DEFAULT_REVIEW_STATE;
  await moveTicket(deps, api, issueId, { name }, sessionId);
};

/** What answering intake needs besides the panel: the jobs (a steer that finds no run becomes a chat) and the run channels. */
export interface IntakeAnswerDeps extends LinearPanelDeps {
  stores: Pick<Stores, "agentSessions" | "jobs">;
  channels?: Pick<RunChannels, "active" | "steer" | "stop" | "stopWhenOpened">;
}

/** An agent API that posts nothing: steering and stopping still act on the run when Linear is not wired. */
const SILENT: LinearAgentApi = {
  createActivity: () => Promise.resolve(),
  setExternalUrls: () => Promise.resolve(),
  setPlan: () => Promise.resolve(),
  setDelegate: () => Promise.resolve(),
  moveToState: () => Promise.resolve("already"),
  issueState: () => Promise.resolve({ type: "", name: "" }),
};

type SessionEvent = Extract<LinearEvent, { kind: "session.created" | "session.prompted" }>;

/** A prompt that found no open run to steer (it has not started, or just ended) is answered by a chat after it. */
const chatInstead = (deps: IntakeAnswerDeps, event: Extract<LinearEvent, { kind: "session.prompted" }>): void => {
  const { issueId, identifier, teamKey, sessionId } = event;
  deps.stores.jobs.enqueue({ kind: "linear", run: "chat", issueId, identifier, teamKey, sessionId, message: event.body, author: event.authorName });
};

/** The job kinds that run a brain, and so answer a stop themselves once their run opens. */
const BRAIN_KINDS: readonly string[] = ["implement", "fix", "chat"];

/**
 * Stops all of the ticket's work: the open run through its channel; a queued implement or chat is failed before it
 * runs; a queued fix, or a running job whose run has not opened its channel yet (or has ended, and it is publishing),
 * gets a stop held for its run. True when a run will answer the stop itself; else `canceled` says whether a queued job
 * was failed here.
 */
const stopTicket = (deps: IntakeAnswerDeps, issueId: string, runId: string | null): { runAnswers: boolean; canceled: boolean } => {
  const { jobs } = deps.stores;
  const holdStop = (jobId: number): boolean => {
    if (deps.channels === undefined) return false;
    deps.channels.stopWhenOpened(jobId);
    return true;
  };
  let runAnswers = runId !== null && deps.channels?.stop(runId) === true;
  let canceled = false;
  for (const job of jobs.queuedForIssue(issueId)) {
    if (!BRAIN_KINDS.includes(job.kind)) continue;
    // A fix belongs to its loop: its run stopping hands the loop back, which failing it here would not.
    if (job.kind !== "fix" && jobs.cancelQueued(job.id, STOPPED_JOB_ERROR)) canceled = true;
    else runAnswers = holdStop(job.id) || runAnswers;
  }
  const running = jobs.runningForIssue(issueId);
  if (!runAnswers && running !== null && BRAIN_KINDS.includes(running.kind)) runAnswers = holdStop(running.id);
  return { runAnswers, canceled };
};

/** The panel's first word on a session event, or a steer or stop handed to the ticket's open run. */
const answerSession = async (deps: IntakeAnswerDeps, api: LinearAgentApi, event: SessionEvent, result: LinearIntakeResult): Promise<void> => {
  const post = (content: ActivityContent): Promise<void> => api.createActivity(event.sessionId, scrubContent(content, panelScrubOf(deps)));
  const runId = deps.channels?.active(event.issueId) ?? null;
  switch (result.action) {
    case "assign_me":
      return post({ type: "response", body: ASSIGN_ME_REPLY });
    case "implement":
      await post({ type: "thought", body: PANEL_TEXT.pickedUp });
      return moveToStarted(deps, event.issueId, event.sessionId);
    case "resume_implement":
      return post({ type: "thought", body: PANEL_TEXT.answerTaken });
    case "chat":
      return post({ type: "thought", body: PANEL_TEXT.reading });
    case "wait_for_lease":
      return post({ type: "thought", body: PANEL_TEXT.waitForLease });
    case "steer":
      if (event.kind !== "session.prompted") return;
      if (runId !== null && deps.channels?.steer(runId, steerText(event.authorName, event.body)) === true) return post({ type: "thought", body: PANEL_TEXT.steered });
      chatInstead(deps, event);
      return post({ type: "thought", body: PANEL_TEXT.reading });
    case "stop": {
      // A run answers the stop itself ("Stopped. Where I got to: …"), or its job its own last word if the stop came too
      // late; without one, this is the one response.
      const { runAnswers, canceled } = stopTicket(deps, event.issueId, runId);
      if (runAnswers) return;
      return post(canceled ? stoppedResponse(null, null) : { type: "response", body: PANEL_TEXT.nothingToStop });
    }
    default:
      return;
  }
};

/**
 * What Linear hears of an intake decision, sent after the webhook is answered: the first thought on new work (within
 * Linear's 10 s), the answer to a mention on a ticket the steward never had, and steering or stopping the open run.
 */
export const answerLinearIntake = async (deps: IntakeAnswerDeps, event: LinearEvent, result: LinearIntakeResult): Promise<void> => {
  if (event.kind === "issue.undelegated") return;
  // Delegated again to a ticket it has a branch for (Task 11 resumes it): only the state moves here.
  if (result.action === "revive" && event.kind === "session.created" && event.delegated) return moveToStarted(deps, event.issueId, event.sessionId);
  const quiet: readonly string[] = ["ignored", "duplicate", "unassign", "revive"];
  if (quiet.includes(result.action)) return;
  const api = deps.linear;
  if (api === undefined) {
    logger.warn({ identifier: event.identifier, action: result.action }, "linear: no agent API to answer in the panel");
    // Without Linear the steer still reaches the run; only the panel's answer is lost.
    if (result.action === "steer" || result.action === "stop") await answerSession(deps, SILENT, event, result);
    return;
  }
  await answerSession(deps, api, event, result);
};
