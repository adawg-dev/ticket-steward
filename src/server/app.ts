import Fastify, { type FastifyInstance } from "fastify";
import type { Secrets } from "../config/load.js";
import type { StewardConfig } from "../config/schema.js";
import { shouldEnqueue, type IntakeDecision } from "../core/intake.js";
import { logger } from "../log.js";
import { transaction, type Job, type Stores } from "../store/index.js";
import { parseEvent, verifySignature } from "../tracker/linear/webhook.js";
import type { Tracker, TriggerEvent } from "../tracker/types.js";

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
type WebhookEvent = Extract<TriggerEvent, { kind: "issue.created" }>;

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
    const decision = shouldEnqueue({
      event,
      allowlist: deps.config.tracker.teams,
      gatewayIssues: deps.config.tracker.gatewayIssues,
      priorSuccess: jobs.hasSucceeded(event.issueId),
      hasQueuedJob: jobs.findQueued(event.issueId) !== null,
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

    const event = parseEvent({ event: header(request.headers["linear-event"]), delivery: header(request.headers["linear-delivery"]) }, body);
    if (event === null || event.kind !== "issue.created") return { ok: true, action: "ignored" };

    const decision = intake(deps, event);
    logger.info({ delivery: event.deliveryId, kind: event.kind, identifier: event.identifier, action: decision.action }, "webhook received");
    return { ok: true, action: decision.action };
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
  registerHealth(app, deps);
  return app;
};
