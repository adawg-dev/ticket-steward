import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { z } from "zod";
import type { Secrets } from "../config/load.js";
import type { StewardConfig } from "../config/schema.js";
import { shouldEnqueue, type IntakeDecision } from "../core/intake.js";
import { logger } from "../log.js";
import { transaction, type Job, type Stores } from "../store/index.js";
import { exchangeCode } from "../tracker/linear/auth.js";
import { parseEvent, verifySignature } from "../tracker/linear/webhook.js";
import type { Tracker, TriggerEvent } from "../tracker/types.js";

export interface ServerDeps {
  config: StewardConfig;
  secrets: Secrets;
  stores: Stores;
  tracker: Tracker;
  workerState: () => { running: number | null };
  fetchImpl?: typeof fetch;
}

export interface HealthReport {
  ok: boolean;
  authBroken: boolean;
  worker: { running: number | null };
  counts: { queued: number; failedLast24h: number };
  lastSuccessAt: string | null;
}

type Intake = IntakeDecision | { action: "duplicate" };
type WebhookEvent = Exclude<TriggerEvent, { kind: "cli" }>;
type SessionEvent = Extract<TriggerEvent, { kind: "agent.session" }>;

declare module "fastify" {
  interface FastifyRequest {
    afterResponse: (() => Promise<void>) | null;
  }
}

const ACTIVITY_TIMEOUT_MS = 2_000;
const OAUTH_CALLBACK_PATH = "/oauth/linear/callback";
const LINEAR_GRAPHQL_URL = "https://api.linear.app/graphql";
const DAY_MS = 24 * 60 * 60 * 1000;
const COUNT_LIMIT = 100_000;
const QUEUED_THOUGHT = (branch: string): string => `Queued. I will check out \`${branch}\`, read the ticket, and enrich it.`;

const CallbackQuerySchema = z.object({ code: z.string().min(1), state: z.string().min(1) });
const ViewerResponseSchema = z.object({ data: z.object({ viewer: z.object({ id: z.string() }) }) });

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

const header = (value: string | string[] | undefined): string | undefined => (Array.isArray(value) ? value[0] : value);

const parseJson = (raw: string): unknown => {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
};

const withTimeout = async (fn: () => Promise<void>, ms: number): Promise<void> => {
  let timer: NodeJS.Timeout | undefined;
  const expiry = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
  });
  try {
    await Promise.race([fn(), expiry]);
  } finally {
    clearTimeout(timer);
  }
};

const intake = (deps: ServerDeps, event: WebhookEvent): Intake =>
  transaction(deps.stores.db, () => {
    const { jobs, deliveries } = deps.stores;
    if (!deliveries.markSeen(event.deliveryId)) return { action: "duplicate" };
    const decision = shouldEnqueue({
      event,
      allowlist: deps.config.tracker.teams,
      priorSuccess: jobs.hasSucceeded(event.issueId),
      hasQueuedJob: jobs.findQueued(event.issueId) !== null,
    });
    if (decision.action === "enqueue") jobs.enqueue(event);
    if (decision.action === "attach" && event.kind === "agent.session") {
      jobs.attachSession(event.issueId, event.sessionId, event.promptBody);
    }
    return decision;
  });

const sessionActivity = (deps: ServerDeps, event: SessionEvent, decision: Intake): (() => Promise<void>) | null => {
  const { agentSession } = deps.tracker;
  if (decision.action === "skip") return () => agentSession.response(event.sessionId, decision.reason);
  if (decision.action === "duplicate") return null;
  return () => agentSession.thought(event.sessionId, QUEUED_THOUGHT(deps.config.workspace.baseBranch));
};

const isFailedWithin = (job: Job, sinceMs: number): boolean =>
  job.finishedAt !== null && new Date(job.finishedAt).getTime() >= sinceMs;

const healthReport = (deps: ServerDeps): HealthReport => {
  const { jobs, tokens } = deps.stores;
  const authBroken = tokens.isAuthBroken();
  const since = Date.now() - DAY_MS;
  return {
    ok: !authBroken,
    authBroken,
    worker: deps.workerState(),
    counts: {
      queued: jobs.list({ status: "queued", limit: COUNT_LIMIT }).length,
      failedLast24h: jobs.list({ status: "failed", limit: COUNT_LIMIT }).filter((job) => isFailedWithin(job, since)).length,
    },
    lastSuccessAt: jobs.list({ status: "succeeded", limit: 1 })[0]?.finishedAt ?? null,
  };
};

const fetchViewerId = async (accessToken: string, fetchImpl: typeof fetch): Promise<string> => {
  const response = await fetchImpl(LINEAR_GRAPHQL_URL, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ query: "{ viewer { id } }" }),
  });
  if (!response.ok) throw new Error(`Linear viewer query answered ${response.status}`);
  return ViewerResponseSchema.parse(await response.json()).data.viewer.id;
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
    if (event === null || event.kind === "cli") return { ok: true, action: "ignored" };

    const decision = intake(deps, event);
    if (event.kind === "agent.session") request.afterResponse = sessionActivity(deps, event, decision);
    logger.info({ delivery: event.deliveryId, kind: event.kind, identifier: event.identifier, action: decision.action }, "webhook received");
    return { ok: true, action: decision.action };
  });
};

const registerHealth = (app: FastifyInstance, deps: ServerDeps): void => {
  app.get("/health", async (_request, reply) => {
    const report = healthReport(deps);
    return reply.code(report.authBroken ? 503 : 200).send(report);
  });
};

const registerOauthCallback = (app: FastifyInstance, deps: ServerDeps): void => {
  const fetchImpl = deps.fetchImpl ?? fetch;
  app.get(OAUTH_CALLBACK_PATH, async (request, reply) => {
    const query = CallbackQuerySchema.safeParse(request.query);
    if (!query.success || !deps.stores.tokens.consumeOauthState(query.data.state)) {
      return reply.code(400).type("text/plain").send("Invalid or expired OAuth state.");
    }
    const { LINEAR_CLIENT_ID: clientId, LINEAR_CLIENT_SECRET: clientSecret } = deps.secrets;
    if (clientId === undefined || clientSecret === undefined) {
      return reply.code(500).type("text/plain").send("LINEAR_CLIENT_ID and LINEAR_CLIENT_SECRET are not configured.");
    }
    const pair = await exchangeCode({
      clientId,
      clientSecret,
      redirectUri: `${deps.config.server.publicUrl}${OAUTH_CALLBACK_PATH}`,
      code: query.data.code,
      fetchImpl,
    });
    const appUserId = await fetchViewerId(pair.accessToken, fetchImpl);
    deps.stores.tokens.set({ ...pair, appUserId });
    deps.stores.tokens.setAuthBroken(false);
    return reply.type("text/plain").send("Linear authorization complete. You can close this tab.");
  });
};

const runAfterResponse = async (request: FastifyRequest): Promise<void> => {
  const pending = request.afterResponse;
  if (pending === null) return;
  try {
    await withTimeout(pending, ACTIVITY_TIMEOUT_MS);
  } catch (err) {
    logger.warn({ err: errorMessage(err) }, "agent session activity failed");
  }
};

export const buildServer = (deps: ServerDeps): FastifyInstance => {
  const app = Fastify();
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_request, body, done) => done(null, body));
  app.decorateRequest("afterResponse", null);
  app.addHook("onResponse", runAfterResponse);
  registerWebhook(app, deps);
  registerHealth(app, deps);
  registerOauthCallback(app, deps);
  return app;
};
