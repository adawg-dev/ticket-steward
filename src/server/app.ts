import Fastify, { type FastifyInstance } from "fastify";
import { z } from "zod";
import type { Secrets } from "../config/load.js";
import type { StewardConfig } from "../config/schema.js";
import { noteIntake, type NoteAction } from "../chat/intake.js";
import type { GitLabMrApi } from "../codehost/gitlabMr.js";
import { fromOwnProject, parseGitlabEvent, verifyGitlabWebhook, type GitlabWakeEvent } from "../codehost/gitlabWebhook.js";
import { errorMessage } from "../core/workspace.js";
import { linearIntake } from "../linear/intake.js";
import { answerLinearIntake, type IntakeAnswerDeps } from "../linear/session.js";
import { logger } from "../log.js";
import type { Settings } from "../settings/schema.js";
import type { RunChannels } from "../run/channel.js";
import { loopSubject, type Job, type Loop, type Stores } from "../store/index.js";
import type { LinearAgentApi } from "../tracker/linear/agent.js";
import { parseLinearEvent, verifySignature } from "../tracker/linear/webhook.js";
import type { Tracker } from "../tracker/types.js";
import type { WorkerState } from "../worker/index.js";

export interface ServerDeps {
  config: StewardConfig;
  secrets: Secrets;
  stores: Stores;
  tracker: Tracker;
  workerState: () => WorkerState;
  /** The runtime settings, read on each use. */
  settings: { get(): Settings };
  /** Linear's agent API with the app's token; absent, nothing is answered in the panel (and that is logged). */
  linear?: LinearAgentApi;
  /** Set with `greptile` or `chat` on GitLab: chat intake checks a note author's access and answers notes it cannot serve. */
  gitlab?: GitLabMrApi;
  /** The open runs' channels: a Linear prompt steers the ticket's open run, and its stop stops it. */
  channels?: Pick<RunChannels, "active" | "steer" | "stop" | "stopWhenOpened">;
  /** Scrubs what the panel is told; the run redactor in `serve`. */
  redactor?: { redact(text: string): string };
}

export interface HealthReport {
  ok: boolean;
  credentialsRejected: boolean;
  worker: WorkerState;
  counts: { queued: number; failedLast24h: number };
  lastSuccessAt: string | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const COUNT_LIMIT = 100_000;

const header = (value: string | string[] | undefined): string | undefined => (Array.isArray(value) ? value[0] : value);

const parseJson = (raw: string): unknown => {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
};

const isFailedWithin = (job: Job, sinceMs: number): boolean =>
  job.finishedAt !== null && new Date(job.finishedAt).getTime() >= sinceMs;

const healthReport = (deps: ServerDeps): HealthReport => {
  const { jobs } = deps.stores;
  const credentialsRejected = deps.tracker.credentialsRejected();
  const since = Date.now() - DAY_MS;
  return {
    ok: !credentialsRejected,
    credentialsRejected,
    worker: deps.workerState(),
    counts: {
      queued: jobs.list({ status: "queued", limit: COUNT_LIMIT }).length,
      failedLast24h: jobs.list({ status: "failed", limit: COUNT_LIMIT }).filter((job) => isFailedWithin(job, since)).length,
    },
    lastSuccessAt: jobs.list({ status: "succeeded", limit: 1 })[0]?.finishedAt ?? null,
  };
};

const PermissionChangeSchema = z.object({
  action: z.string(),
  addedTeamIds: z.array(z.string()).nullish(),
  removedTeamIds: z.array(z.string()).nullish(),
  canAccessAllPublicTeams: z.boolean().nullish(),
});

/**
 * An admin changed which teams the app can see. Logged: a team it lost stops sending its tickets' events, and runs on
 * them fail on their next Linear read (which the panel cannot show, since the app can no longer post there).
 */
const logPermissionChange = (delivery: string | undefined, body: unknown): void => {
  const parsed = PermissionChangeSchema.safeParse(body);
  if (!parsed.success) {
    logger.warn({ delivery }, "linear: an unreadable permission change");
    return;
  }
  const { action, addedTeamIds, removedTeamIds, canAccessAllPublicTeams } = parsed.data;
  const fields = { delivery, action, addedTeamIds: addedTeamIds ?? [], removedTeamIds: removedTeamIds ?? [], canAccessAllPublicTeams };
  if ((removedTeamIds ?? []).length > 0) logger.warn(fields, "linear: the app lost access to teams");
  else logger.info(fields, "linear: the app's team access changed");
};

const unredacted = { redact: (text: string): string => text };

/** The panel's view of the server's deps. */
const panelDeps = (deps: ServerDeps): IntakeAnswerDeps => ({
  stores: deps.stores,
  settings: deps.settings,
  redactor: deps.redactor ?? unredacted,
  tracker: deps.tracker,
  ...(deps.linear === undefined ? {} : { linear: deps.linear }),
  ...(deps.channels === undefined ? {} : { channels: deps.channels }),
});

/**
 * Agent-session events (delegation, mention, prompt) and the steward losing a delegation. Intake records the delivery
 * and enqueues work without calling Linear; anything Linear must hear is sent after the reply.
 */
const registerWebhook = (app: FastifyInstance, deps: ServerDeps): void => {
  app.post<{ Body: string }>("/webhooks/linear", async (request, reply) => {
    const secret = deps.secrets.LINEAR_WEBHOOK_SECRET;
    const signature = header(request.headers["linear-signature"]);
    const delivery = header(request.headers["linear-delivery"]);
    if (secret === undefined || !verifySignature(request.body, signature, secret)) {
      logger.warn({ delivery }, "webhook signature rejected");
      return reply.code(401).send({ ok: false });
    }
    const body = parseJson(request.body);
    if (body === undefined) return reply.code(400).send({ ok: false });

    // Read once and cached (serve reads it at start); until it can be read, nothing is recorded and Linear redelivers.
    let appUserId: string;
    try {
      appUserId = await deps.tracker.appUserId();
    } catch (err) {
      logger.warn({ delivery, err: errorMessage(err) }, "webhook: the app's Linear user could not be read");
      return reply.code(503).send({ ok: false });
    }
    const kind = header(request.headers["linear-event"]);
    if (kind === "PermissionChange") {
      logPermissionChange(delivery, body);
      return { ok: true, action: "logged" };
    }
    const event = parseLinearEvent({ event: kind, delivery }, body, appUserId);
    if (event === null) return { ok: true, action: "ignored" };

    const result = await linearIntake(deps, event);
    logger.info({ delivery, kind: event.kind, identifier: event.identifier, action: result.action, jobId: result.jobId }, "webhook received");
    answerLinearIntake(panelDeps(deps), event, result).catch((err: unknown) =>
      logger.warn({ delivery, identifier: event.identifier, err: errorMessage(err) }, "linear: the panel answer failed"),
    );
    return { ok: true, action: result.action };
  });
};

/** Pipeline and MR hooks can pass Fastify's 1 MiB default; a 413 would count as a failing delivery and GitLab disables those. */
const GITLAB_BODY_LIMIT = 5 * 1024 * 1024;

type GitlabAction = "woken" | "no_loop" | NoteAction;

/** A loop waits on GitLab only for its MR or its review; a fixing loop has nothing to wake. */
const WAITING_STATES: readonly Loop["state"][] = ["awaiting_mr", "awaiting_review"];

/** The loop's project once it found its MR, the configured project (by path or numeric id) before that. */
const sameProject = (loop: Loop, event: GitlabWakeEvent, project: string): boolean =>
  loop.projectId !== null ? loop.projectId === event.projectId : event.projectPath === project || String(event.projectId) === project;

const isOurProject = (event: GitlabWakeEvent, project: string, loops: Loop[]): boolean =>
  event.projectPath === project || String(event.projectId) === project || loops.some((loop) => loop.projectId === event.projectId);

/** By the MR when both sides know it, else by branch. */
const sameChange = (loop: Loop, event: GitlabWakeEvent): boolean =>
  loop.mrIid !== null && event.mrIid !== null ? loop.mrIid === event.mrIid : loop.branch === event.branch;

const wakeLoop = (deps: ServerDeps, event: GitlabWakeEvent, project: string): { action: GitlabAction; loopId: number | null } => {
  const waiting = deps.stores.loops.active().filter((loop) => WAITING_STATES.includes(loop.state));
  // A fork's MR may share a steward branch's name; it is never the steward's change.
  if (!fromOwnProject(event) || !isOurProject(event, project, waiting)) return { action: "ignored", loopId: null };
  const loop = waiting.find((candidate) => sameProject(candidate, event, project) && sameChange(candidate, event));
  if (loop === undefined) return { action: "no_loop", loopId: null };
  // MR notes are being batched: their await is due once the quiet window ends, and the round reads the pipeline then.
  if (loop.pendingNotesSince !== null && deps.stores.jobs.pendingStep(loopSubject(loop.id))?.status === "queued") {
    return { action: "queued_round", loopId: loop.id };
  }
  // A queued await comes due now; a running one comes due as soon as it defers, so a wake mid-poll is not lost.
  // A waiting loop with no queued or running await has nothing to wake.
  return { action: deps.stores.jobs.wake(loopSubject(loop.id), new Date()) ? "woken" : "no_loop", loopId: loop.id };
};

/** A note is the note intake's (chat, or a round after the quiet window); an MR or pipeline event may wake a waiting loop. */
const gitlabIntake = async (deps: ServerDeps, event: GitlabWakeEvent | null): Promise<{ action: GitlabAction; loopId: number | null }> => {
  const { codehost, greptile } = deps.config;
  if (event === null) return { action: "ignored", loopId: null };
  // A note without its author and body could be the steward's own; it never wakes anything.
  if (event.kind === "note") return event.note === undefined ? { action: "ignored", loopId: null } : noteIntake(deps, event, event.note);
  if (greptile === undefined || codehost.kind !== "gitlab") return { action: "ignored", loopId: null };
  return wakeLoop(deps, event, codehost.project);
};

/**
 * GitLab MR and pipeline events wake a waiting fix loop's deferred await; polling is only the fallback. Any MR note that is
 * not the steward's (from a Developer, or a bot) wakes the loop after a quiet window, or steers the ticket's open run; a
 * `chat.prefix` note from a Developer enqueues a chat (on an unassigned loop, after its revive).
 */
const registerGitlabWebhook = (app: FastifyInstance, deps: ServerDeps): void => {
  app.post<{ Body: string }>("/webhooks/gitlab", { bodyLimit: GITLAB_BODY_LIMIT }, async (request, reply) => {
    const kind = header(request.headers["x-gitlab-event"]);
    const headers = {
      token: header(request.headers["x-gitlab-token"]),
      id: header(request.headers["webhook-id"]),
      timestamp: header(request.headers["webhook-timestamp"]),
      signature: header(request.headers["webhook-signature"]),
    };
    const secrets = { secret: deps.secrets.GITLAB_WEBHOOK_SECRET, signingToken: deps.secrets.GITLAB_WEBHOOK_SIGNING_TOKEN };
    if (!verifyGitlabWebhook(request.body, headers, secrets, Math.floor(Date.now() / 1000))) {
      // Which auth style arrived versus which is configured; never the values themselves.
      const auth = {
        sentToken: headers.token !== undefined,
        sentSignature: headers.signature !== undefined,
        hasSecret: (secrets.secret ?? "") !== "",
        hasSigningToken: (secrets.signingToken ?? "") !== "",
      };
      logger.warn({ event: kind, ...auth }, "gitlab webhook rejected");
      return reply.code(401).send({ ok: false });
    }
    // A validly signed event is always answered 200: GitLab disables a hook that keeps failing.
    const event = parseGitlabEvent(kind, parseJson(request.body));
    let result: { action: GitlabAction; loopId: number | null };
    try {
      result = await gitlabIntake(deps, event);
    } catch (err) {
      logger.error({ kind, err: err instanceof Error ? err.message : String(err) }, "gitlab webhook intake failed");
      return { ok: true, action: "ignored" };
    }
    const { action, loopId } = result;
    logger.info({ kind, branch: event?.branch, mrIid: event?.mrIid, loopId, action }, "gitlab webhook received");
    return { ok: true, action };
  });
};

const registerHealth = (app: FastifyInstance, deps: ServerDeps): void => {
  app.get("/health", async (_request, reply) => {
    const report = healthReport(deps);
    return reply.code(report.credentialsRejected ? 503 : 200).send(report);
  });
};

export const buildServer = (deps: ServerDeps): FastifyInstance => {
  const app = Fastify();
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_request, body, done) => done(null, body));
  registerWebhook(app, deps);
  registerGitlabWebhook(app, deps);
  registerHealth(app, deps);
  return app;
};
