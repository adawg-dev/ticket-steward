import Fastify, { type FastifyInstance } from "fastify";
import type { Secrets } from "../config/load.js";
import type { StewardConfig } from "../config/schema.js";
import { chatIntake, type ChatAction } from "../chat/intake.js";
import type { GitLabMrApi } from "../codehost/gitlabMr.js";
import { parseGitlabEvent, verifyGitlabWebhook, type GitlabWakeEvent } from "../codehost/gitlabWebhook.js";
import { shouldEnqueue, type IntakeDecision } from "../core/intake.js";
import { logger } from "../log.js";
import { loopSubject, transaction, type Job, type Loop, type Stores } from "../store/index.js";
import { parseEvent, verifySignature } from "../tracker/linear/webhook.js";
import type { Tracker, TriggerEvent } from "../tracker/types.js";
import type { WorkerState } from "../worker/index.js";

export interface ServerDeps {
  config: StewardConfig;
  secrets: Secrets;
  stores: Stores;
  tracker: Tracker;
  workerState: () => WorkerState;
  /** Set with `greptile` or `chat` on GitLab: chat intake checks a note author's access and answers notes it cannot serve. */
  gitlab?: GitLabMrApi;
}

export interface HealthReport {
  ok: boolean;
  apiKeyRejected: boolean;
  worker: WorkerState;
  counts: { queued: number; failedLast24h: number };
  lastSuccessAt: string | null;
}

type Intake = IntakeDecision | { action: "duplicate" };
type WebhookEvent = Extract<TriggerEvent, { kind: "issue.created" | "issue.labeled" }>;

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

const intake = (deps: ServerDeps, event: WebhookEvent): Intake =>
  transaction(deps.stores.db, () => {
    const { jobs, deliveries, loops } = deps.stores;
    if (!deliveries.markSeen(event.deliveryId)) return { action: "duplicate" };
    if (deps.config.implement === undefined) return { action: "skip", reason: "implement is not configured" };
    const loop = loops.latestForIssue(event.issueId);
    const queuedKind = loop?.state === "handed_back" ? "restart" : "implement";
    const decision = shouldEnqueue({
      event,
      allowlist: deps.config.tracker.teams,
      priorSuccess: jobs.hasSucceeded(event.issueId, "implement"),
      hasQueuedJob: jobs.findQueued(event.issueId, queuedKind) !== null,
      loop,
    });
    if (decision.action === "enqueue") jobs.enqueue(event);
    if (decision.action === "restart" && loop !== null) {
      jobs.enqueue({ kind: "loop", issueId: event.issueId, identifier: event.identifier, teamKey: event.teamKey, loopId: loop.id, step: "restart", labelDriven: true });
    }
    return decision;
  });

const isFailedWithin = (job: Job, sinceMs: number): boolean =>
  job.finishedAt !== null && new Date(job.finishedAt).getTime() >= sinceMs;

const healthReport = (deps: ServerDeps): HealthReport => {
  const { jobs } = deps.stores;
  const apiKeyRejected = deps.tracker.apiKeyRejected();
  const since = Date.now() - DAY_MS;
  return {
    ok: !apiKeyRejected,
    apiKeyRejected,
    worker: deps.workerState(),
    counts: {
      queued: jobs.list({ status: "queued", limit: COUNT_LIMIT }).length,
      failedLast24h: jobs.list({ status: "failed", limit: COUNT_LIMIT }).filter((job) => isFailedWithin(job, since)).length,
    },
    lastSuccessAt: jobs.list({ status: "succeeded", limit: 1 })[0]?.finishedAt ?? null,
  };
};

const registerWebhook = (app: FastifyInstance, deps: ServerDeps): void => {
  app.post<{ Body: string }>("/webhooks/linear", async (request, reply) => {
    const secret = deps.secrets.LINEAR_WEBHOOK_SECRET;
    const signature = header(request.headers["linear-signature"]);
    if (secret === undefined || !verifySignature(request.body, signature, secret)) {
      logger.warn({ delivery: header(request.headers["linear-delivery"]) }, "webhook signature rejected");
      return reply.code(401).send({ ok: false });
    }
    const body = parseJson(request.body);
    if (body === undefined) return reply.code(400).send({ ok: false });

    const labels = deps.config.tracker.labels;
    const triggers = labels === undefined ? undefined : { implement: labels.implement };
    const event = parseEvent({ event: header(request.headers["linear-event"]), delivery: header(request.headers["linear-delivery"]) }, body, { labels: triggers });
    if (event === null || event.kind === "cli") return { ok: true, action: "ignored" };

    const decision = intake(deps, event);
    logger.info({ delivery: event.deliveryId, kind: event.kind, identifier: event.identifier, action: decision.action }, "webhook received");
    return { ok: true, action: decision.action };
  });
};

/** Pipeline and MR hooks can pass Fastify's 1 MiB default; a 413 would count as a failing delivery and GitLab disables those. */
const GITLAB_BODY_LIMIT = 5 * 1024 * 1024;

type GitlabAction = "ignored" | "woken" | "no_loop" | ChatAction;

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
  if (!isOurProject(event, project, waiting)) return { action: "ignored", loopId: null };
  const loop = waiting.find((candidate) => sameProject(candidate, event, project) && sameChange(candidate, event));
  if (loop === undefined) return { action: "no_loop", loopId: null };
  // A queued await comes due now; a running one comes due as soon as it defers, so a wake mid-poll is not lost.
  // A waiting loop with no queued or running await has nothing to wake.
  return { action: deps.stores.jobs.wake(loopSubject(loop.id), new Date()) ? "woken" : "no_loop", loopId: loop.id };
};

/** A chat request (a `chat.prefix` note) is chat's alone; any other event may wake a waiting loop. */
const gitlabIntake = async (deps: ServerDeps, event: GitlabWakeEvent | null): Promise<{ action: GitlabAction; loopId: number | null }> => {
  const { codehost, greptile } = deps.config;
  if (event === null) return { action: "ignored", loopId: null };
  const chat = await chatIntake(deps, event);
  if (chat !== null) return chat;
  if (greptile === undefined || codehost.kind !== "gitlab") return { action: "ignored", loopId: null };
  return wakeLoop(deps, event, codehost.project);
};

/**
 * GitLab events wake a waiting fix loop's deferred await; polling is only the fallback. A `chat.prefix` note from a
 * Developer enqueues a chat (or a handed-back loop's restart); nothing else enqueues a job.
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
    return reply.code(report.apiKeyRejected ? 503 : 200).send(report);
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
