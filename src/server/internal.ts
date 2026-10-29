import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { z } from "zod";
import type { RunCallbacks } from "../k8s/executor.js";
import { logger } from "../log.js";
import type { PushLedger, RemoteHead } from "../push/ledger.js";
import type { PushTarget } from "../push/target.js";
import { MAX_STEER_WAIT_MS, type RunChannels } from "../run/channel.js";
import { RunReportSchema, WorkReportSchema, type RunSpec } from "../run/protocol.js";
import type { RunTokenRole, RunTokens } from "../store/index.js";

/** The dispatcher's cluster-internal port: run pods' callbacks only (the NetworkPolicy admits nothing else). */
export const INTERNAL_PORT = 3021;

export interface InternalDeps {
  runs: RunCallbacks;
  /** The runs' event and steering channels, which the executors open and close. */
  channels: Pick<RunChannels, "line" | "next" | "endSteering">;
  tokens: Pick<RunTokens, "verify">;
  /** The steward's own push ledger; the run's target comes from its spec, never from the request. */
  ledger: PushLedger;
  remoteHead: (target: PushTarget) => RemoteHead;
  /** The pushes recorded for a job: a push id from a request must be one of the run's own. */
  pushIdsOf: (jobId: number) => number[];
}

const Sha = z.string().regex(/^[0-9a-f]{40}$/);
const RecordSchema = z.object({ branch: z.string().min(1), sha: Sha, previousSha: Sha.nullable(), note: z.string().nullable() });
const LandedSchema = z.object({ sha: Sha });
const BODY_LIMIT = 5 * 1024 * 1024;
/** A run pod's batch of brain lines: what it sends every half second, with room for a burst. */
export const MAX_EVENT_LINES = 200;
export const EVENTS_BODY_LIMIT = 1024 * 1024;
const EventsSchema = z.object({ lines: z.array(z.string()).max(MAX_EVENT_LINES) });
const SteerQuerySchema = z.object({ waitMs: z.coerce.number().int().nonnegative().default(MAX_STEER_WAIT_MS) });

type RunParams = { runId: string };
type PushParams = RunParams & { id: string };

const bearer = (request: FastifyRequest): string | null => {
  const match = /^Bearer (\S+)$/.exec(request.headers.authorization ?? "");
  return match?.[1] ?? null;
};

/**
 * The run pods' callback API on `INTERNAL_PORT`. Every route takes one run's token for one role: the runner token (the
 * agent container) may only post the run's report and brain lines and poll its steering; the tools token (the tools sidecar) may post the work report and use
 * the push ledger. Any other token, or one revoked when its run ended, gets 401.
 */
export const buildInternalServer = (deps: InternalDeps): FastifyInstance => {
  const app = Fastify({ bodyLimit: BODY_LIMIT });

  /** The run's spec when the token is the run's for `role`; otherwise the reply is sent and null returned. */
  const authorize = async (request: FastifyRequest<{ Params: RunParams }>, reply: FastifyReply, role: RunTokenRole): Promise<RunSpec | null> => {
    const { runId } = request.params;
    const token = bearer(request);
    if (token === null || !deps.tokens.verify(runId, role, token)) {
      logger.warn({ runId, role, route: request.routeOptions.url }, "internal run API: token rejected");
      await reply.code(401).send({ error: "unauthorized" });
      return null;
    }
    const spec = deps.runs.spec(runId);
    // A valid token for a run nobody waits on yet: the steward is starting; the pod tries again.
    if (spec === null) {
      await reply.code(503).send({ error: "the steward is not waiting on this run yet" });
      return null;
    }
    return spec;
  };

  /** The run's push target, or a 409 when the run has no push tool. */
  const targetOf = async (spec: RunSpec, reply: FastifyReply): Promise<PushTarget | null> => {
    if (spec.push !== null) return spec.push;
    await reply.code(409).send({ error: "this run has no push tool" });
    return null;
  };

  const badRequest = (reply: FastifyReply, error: z.ZodError): FastifyReply => reply.code(400).send({ error: z.prettifyError(error) });

  app.post<{ Params: RunParams }>("/internal/runs/:runId/report", async (request, reply) => {
    if ((await authorize(request, reply, "runner")) === null) return reply;
    const parsed = RunReportSchema.safeParse(request.body);
    if (!parsed.success) return badRequest(reply, parsed.error);
    if (parsed.data.runId !== request.params.runId) return reply.code(400).send({ error: "the report is for another run" });
    deps.runs.deliverReport(parsed.data);
    return { ok: true };
  });

  app.post<{ Params: RunParams }>("/internal/runs/:runId/events", { bodyLimit: EVENTS_BODY_LIMIT }, async (request, reply) => {
    if ((await authorize(request, reply, "runner")) === null) return reply;
    const parsed = EventsSchema.safeParse(request.body);
    if (!parsed.success) return badRequest(reply, parsed.error);
    for (const line of parsed.data.lines) deps.channels.line(request.params.runId, line);
    return { ok: true };
  });

  /**
   * Long-polls the run's steering: the commands queued for it, or the first within `waitMs` (at most 25 s), or none.
   * A poller that leaves before the answer leaves the commands queued for its next poll.
   */
  app.get<{ Params: RunParams; Querystring: Record<string, string> }>("/internal/runs/:runId/steer", async (request, reply) => {
    if ((await authorize(request, reply, "runner")) === null) return reply;
    const parsed = SteerQuerySchema.safeParse(request.query);
    if (!parsed.success) return badRequest(reply, parsed.error);
    const left = new AbortController();
    const onClose = (): void => {
      if (!reply.raw.writableFinished) left.abort();
    };
    reply.raw.once("close", onClose);
    try {
      const commands = await deps.channels.next(request.params.runId, Math.min(parsed.data.waitMs, MAX_STEER_WAIT_MS), left.signal);
      return { commands };
    } finally {
      reply.raw.off("close", onClose);
    }
  });

  /** The run pod's brain ended: no steer or stop reaches it any more, so the dispatcher refuses them from now on. */
  app.post<{ Params: RunParams }>("/internal/runs/:runId/steer/end", async (request, reply) => {
    if ((await authorize(request, reply, "runner")) === null) return reply;
    deps.channels.endSteering(request.params.runId);
    return { ok: true };
  });

  app.post<{ Params: RunParams }>("/internal/runs/:runId/work", async (request, reply) => {
    if ((await authorize(request, reply, "tools")) === null) return reply;
    const parsed = WorkReportSchema.safeParse(request.body);
    if (!parsed.success) return badRequest(reply, parsed.error);
    if (parsed.data.runId !== request.params.runId) return reply.code(400).send({ error: "the work report is for another run" });
    deps.runs.deliverWork(parsed.data);
    return { ok: true };
  });

  app.get<{ Params: RunParams }>("/internal/runs/:runId/ticket", async (request, reply) => {
    const spec = await authorize(request, reply, "tools");
    if (spec === null) return reply;
    const target = await targetOf(spec, reply);
    if (target === null) return reply;
    return deps.ledger.ticket(target);
  });

  app.post<{ Params: RunParams }>("/internal/runs/:runId/push/start", async (request, reply) => {
    const spec = await authorize(request, reply, "tools");
    if (spec === null) return reply;
    const target = await targetOf(spec, reply);
    if (target === null) return reply;
    return deps.ledger.start(target, deps.remoteHead(target));
  });

  app.post<{ Params: RunParams }>("/internal/runs/:runId/push/record", async (request, reply) => {
    const spec = await authorize(request, reply, "tools");
    if (spec === null) return reply;
    const target = await targetOf(spec, reply);
    if (target === null) return reply;
    const parsed = RecordSchema.safeParse(request.body);
    if (!parsed.success) return badRequest(reply, parsed.error);
    return deps.ledger.record(target, parsed.data);
  });

  /** A push of this run's job, named by the request; another job's push is not found. */
  const ownPush = async (request: FastifyRequest<{ Params: PushParams }>, reply: FastifyReply): Promise<{ target: PushTarget; id: number } | null> => {
    const spec = await authorize(request, reply, "tools");
    if (spec === null) return null;
    const target = await targetOf(spec, reply);
    if (target === null) return null;
    const id = Number(request.params.id);
    if (!Number.isInteger(id) || !deps.pushIdsOf(target.jobId).includes(id)) {
      await reply.code(404).send({ error: "no such push for this run" });
      return null;
    }
    return { target, id };
  };

  app.post<{ Params: PushParams }>("/internal/runs/:runId/push/:id/landed", async (request, reply) => {
    const push = await ownPush(request, reply);
    if (push === null) return reply;
    const parsed = LandedSchema.safeParse(request.body);
    if (!parsed.success) return badRequest(reply, parsed.error);
    await deps.ledger.landed(push.target, push.id, parsed.data.sha);
    return { ok: true };
  });

  app.post<{ Params: PushParams }>("/internal/runs/:runId/push/:id/revert", async (request, reply) => {
    const push = await ownPush(request, reply);
    if (push === null) return reply;
    await deps.ledger.revert(push.target, push.id);
    return { ok: true };
  });

  return app;
};
