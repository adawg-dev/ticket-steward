import Fastify, { type FastifyInstance } from "fastify";
import type { Secrets } from "../config/load.js";
import type { StewardConfig } from "../config/schema.js";
import { parseMergeRequestEvent, verifyGitlabWebhook } from "../codehost/gitlabWebhook.js";
import { jobKindFor, shouldEnqueue, type IntakeDecision } from "../core/intake.js";
import { logger } from "../log.js";
import { transaction, type Job, type Stores } from "../store/index.js";
import { reviewSubject } from "../store/jobs.js";
import { parseEvent, verifySignature } from "../tracker/linear/webhook.js";
import type { ReviewTrigger, Tracker, TriggerEvent } from "../tracker/types.js";

export interface ServerDeps {
  config: StewardConfig;
  secrets: Secrets;
  stores: Stores;
  tracker: Tracker;
  workerState: () => { running: number | null };
}

export interface HealthReport {
  ok: boolean;
  apiKeyRejected: boolean;
  worker: { running: number | null };
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
    const { jobs, deliveries } = deps.stores;
    if (!deliveries.markSeen(event.deliveryId)) return { action: "duplicate" };
    const kind = jobKindFor(event);
    if (kind === "implement" && deps.config.implement === undefined) {
      return { action: "skip", reason: "implement is not configured" };
    }
    const decision = shouldEnqueue({
      event,
      allowlist: deps.config.tracker.teams,
      gatewayIssues: deps.config.tracker.gatewayIssues,
      priorSuccess: jobs.hasSucceeded(event.issueId, kind),
      hasQueuedJob: jobs.findQueued(event.issueId, kind) !== null,
    });
    if (decision.action === "enqueue") jobs.enqueue(event);
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
    // ready-for-agent triggers only with an implement block; intake's "implement is not configured" skip stays as a backstop.
    const triggers = labels === undefined ? undefined : { triage: labels.triage, ...(deps.config.implement === undefined ? {} : { implement: labels.implement }) };
    const event = parseEvent({ event: header(request.headers["linear-event"]), delivery: header(request.headers["linear-delivery"]) }, body, { labels: triggers });
    if (event === null || event.kind === "cli" || event.kind === "mr.review") return { ok: true, action: "ignored" };

    const decision = intake(deps, event);
    logger.info({ delivery: event.deliveryId, kind: event.kind, identifier: event.identifier, action: decision.action }, "webhook received");
    return { ok: true, action: decision.action };
  });
};

type ReviewIntake = "enqueue" | "superseded" | "duplicate";

const reviewIntake = (deps: ServerDeps, trigger: ReviewTrigger): ReviewIntake =>
  transaction(deps.stores.db, () => {
    const { jobs, deliveries } = deps.stores;
    if (!deliveries.markSeen(trigger.deliveryId)) return "duplicate";
    const queued = jobs.findQueuedBySubject(reviewSubject(trigger.projectId, trigger.mrIid));
    if (queued !== null && jobs.replaceTrigger(queued.id, trigger)) return "superseded";
    jobs.enqueue(trigger);
    return "enqueue";
  });

const registerGitlabWebhook = (app: FastifyInstance, deps: ServerDeps): void => {
  app.post<{ Body: string }>("/webhooks/gitlab", async (request, reply) => {
    const review = deps.config.review;
    if (review === undefined) return reply.code(404).send({ ok: false });
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
      logger.warn({ event: header(request.headers["x-gitlab-event"]), ...auth }, "gitlab webhook rejected");
      return reply.code(401).send({ ok: false });
    }
    if (header(request.headers["x-gitlab-event"]) !== "Merge Request Hook") return { ok: true, action: "ignored" };
    const body = parseJson(request.body);
    if (body === undefined) return reply.code(400).send({ ok: false });
    const delivery = header(request.headers["webhook-id"]) ?? header(request.headers["idempotency-key"]);
    const parsed = parseMergeRequestEvent(body, {
      deliveryId: delivery === undefined ? undefined : `gitlab:${delivery}`,
      botUsername: review.botUsername,
      teams: deps.config.tracker.teams,
      allowForks: review.allowForks,
    });
    if (!parsed.ok) {
      logger.info({ reason: parsed.reason }, "gitlab webhook ignored");
      return { ok: true, action: "ignored", reason: parsed.reason };
    }
    const action = reviewIntake(deps, parsed.trigger);
    logger.info({ delivery: parsed.trigger.deliveryId, mr: parsed.trigger.mrIid, key: parsed.trigger.linearKey, reason: parsed.trigger.reason, action }, "gitlab webhook received");
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
