import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { z } from "zod";
import { acquireLease } from "../chat/lease.js";
import { latestSession, type AgentSession } from "../chat/session.js";
import { errorMessage } from "../core/workspace.js";
import { logger } from "../log.js";
import type { Job, JobStatus, Loop, Stores } from "../store/index.js";

/** The admin API's port, bound to 127.0.0.1 only: the CLI in the dispatcher pod (`kubectl exec … steward …`) is its client. */
export const ADMIN_PORT = 3022;
export const ADMIN_HOST = "127.0.0.1";
/** The token's file in the runtime dir; written at each start, mode 0600. */
export const ADMIN_TOKEN_FILE = "admin.token";

const JOB_STATUSES = ["queued", "running", "succeeded", "failed", "publish_failed", "skipped"] as const satisfies readonly JobStatus[];
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 1_000;

/** The ticket a `steward chat` holds and the session it resumes. */
export interface ChatStart {
  runId: string;
  ticket: { id: string; identifier: string };
  session: AgentSession;
}

/** How an interactive run ended: its report's verdict and what it left unpushed (null when it never reported). */
export interface ChatEnd {
  ok: boolean | null;
  error: string | null;
  unpushed: string | null;
}

/** Launches and ends the interactive run pods of `steward chat`; only the Kubernetes runtime has one. */
export interface ChatLauncher {
  /** Starts the run and resolves once its pod exists, with the pod's name; rejects when it cannot start. */
  start(p: ChatStart): Promise<{ pod: string }>;
  /** Waits a little for the run to end on its own, else stops it; also ends a run started before a restart. */
  end(runId: string): Promise<ChatEnd>;
}

export interface AdminDeps {
  token: string;
  stores: Pick<Stores, "db" | "jobs" | "attempts" | "loops" | "leases">;
  /** Issue key or UUID → the issue; rejects when there is none. */
  resolveTicket: (key: string) => Promise<{ id: string; identifier: string }>;
  chat?: ChatLauncher;
}

/** Every chat run's id starts with this; no job's run does (theirs are `<jobId>-<attempt>`). */
export const CHAT_RUN_PREFIX = "chat-";

/** The run id of the interactive run a lease holds: fixed by the lease, so a restarted steward can still end it. */
export const chatRunIdOf = (leaseId: number): string => `${CHAT_RUN_PREFIX}${leaseId}`;

/** The chat runs a live lease holds; stale leases (their CLI died) are pruned first, so their runs are not held. */
export const heldChatRuns = (stores: Pick<Stores, "leases">): Set<string> => {
  stores.leases.pruneStale();
  return new Set(stores.leases.active().map((lease) => chatRunIdOf(lease.id)));
};

/** A fresh token in `<runtimeDir>/admin.token`, mode 0600; returns it. */
export const writeAdminToken = async (runtimeDir: string): Promise<string> => {
  const token = randomBytes(32).toString("base64url");
  await mkdir(runtimeDir, { recursive: true, mode: 0o700 });
  const file = join(runtimeDir, ADMIN_TOKEN_FILE);
  await writeFile(file, token, { mode: 0o600 });
  // writeFile keeps an existing file's mode.
  await chmod(file, 0o600);
  return token;
};

/** What a retry will do, matching the worker's dispatch. */
export const retryMode = (job: Job): string => {
  if (job.unreadable.length > 0) return `job ${job.id}: fails (stored ${job.unreadable.join(", ")} is unreadable)`;
  if (job.kind === "await_review" || job.kind === "fix" || job.kind === "restart") return `job ${job.id}: ${job.kind} step of ${job.subject ?? "its loop"}`;
  if (job.kind === "implement") {
    const stored = job.implementResult;
    if (stored === null) return `job ${job.id}: full run`;
    if (stored.handback !== null) return `job ${job.id}: publish-only (hand-back stored; labels only, nothing to push)`;
    if (job.pushedAt === null) return `job ${job.id}: publish-only (check whether ${job.branch ?? "?"} landed, then labels; never pushes)`;
    return `job ${job.id}: publish-only (${job.branch ?? "?"} already pushed; labels only)`;
  }
  return `job ${job.id}: fails (${job.kind} was removed)`;
};

/** The loop a job belongs to: loop steps carry `loop:<id>` as subject, an implement job is the loop's origin. */
export const loopOfJob = (stores: Pick<Stores, "loops">, job: Job): Loop | null => {
  if (job.kind === "implement") return stores.loops.forImplementJob(job.id);
  const id = job.subject?.startsWith("loop:") === true ? Number.parseInt(job.subject.slice("loop:".length), 10) : Number.NaN;
  return Number.isInteger(id) ? stores.loops.get(id) : null;
};

const ListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
  status: z.enum(JOB_STATUSES).optional(),
});
const ChatBody = z.object({ pid: z.number().int().positive().optional() }).default({});

type IdParams = { id: string };
type KeyParams = { key: string };

const digest = (value: string): Buffer => createHash("sha256").update(value).digest();

/**
 * The dispatcher's admin API on `ADMIN_HOST:ADMIN_PORT`: job and ticket state, retries, and `steward chat`'s leases and
 * interactive run pods. Every request carries `Authorization: Bearer <token>`, the token `serve` wrote to the runtime dir;
 * anything else gets 401. A later CLI, MCP server or web UI builds on these routes.
 */
export const buildAdminServer = (deps: AdminDeps): FastifyInstance => {
  const app = Fastify();
  const { stores } = deps;
  const expected = digest(deps.token);
  /** The runs of the chats this process started, by lease id. */
  const chats = new Map<number, string>();

  app.addHook("onRequest", async (request: FastifyRequest, reply: FastifyReply) => {
    const match = /^Bearer (\S+)$/.exec(request.headers.authorization ?? "");
    if (match?.[1] !== undefined && timingSafeEqual(digest(match[1]), expected)) return;
    logger.warn({ route: request.url, method: request.method }, "admin API: token rejected");
    return reply.code(401).send({ error: "unauthorized" });
  });

  const badRequest = (reply: FastifyReply, error: z.ZodError): FastifyReply => reply.code(400).send({ error: z.prettifyError(error) });

  const jobOf = async (request: FastifyRequest<{ Params: IdParams }>, reply: FastifyReply): Promise<Job | null> => {
    const id = Number(request.params.id);
    const job = Number.isInteger(id) && id > 0 ? stores.jobs.get(id) : null;
    if (job === null) await reply.code(404).send({ error: `job ${request.params.id} not found` });
    return job;
  };

  const ticketOf = async (request: FastifyRequest<{ Params: KeyParams }>, reply: FastifyReply): Promise<{ id: string; identifier: string } | null> => {
    try {
      const { id, identifier } = await deps.resolveTicket(request.params.key);
      return { id, identifier };
    } catch (err) {
      await reply.code(404).send({ error: `ticket ${request.params.key} not found: ${errorMessage(err)}` });
      return null;
    }
  };

  const leaseOf = (issueId: string) => stores.leases.active().find((lease) => lease.issueId === issueId);

  app.get("/api/ping", () => ({ ok: true }));

  app.get("/api/jobs", async (request, reply) => {
    const parsed = ListQuery.safeParse(request.query);
    if (!parsed.success) return badRequest(reply, parsed.error);
    const { limit, status } = parsed.data;
    return { jobs: stores.jobs.list({ limit, ...(status === undefined ? {} : { status }) }) };
  });

  app.get<{ Params: IdParams }>("/api/jobs/:id", async (request, reply) => {
    const job = await jobOf(request, reply);
    if (job === null) return reply;
    return { job, attempts: stores.attempts.forJob(job.id), loop: loopOfJob(stores, job) };
  });

  app.post<{ Params: IdParams }>("/api/jobs/:id/retry", async (request, reply) => {
    const job = await jobOf(request, reply);
    if (job === null) return reply;
    if (!stores.jobs.requeue(job.id)) return reply.code(409).send({ error: `job ${job.id} is already running` });
    return { mode: retryMode(job) };
  });

  app.get<{ Params: KeyParams }>("/api/tickets/:key", async (request, reply) => {
    const ticket = await ticketOf(request, reply);
    if (ticket === null) return reply;
    return {
      ticket,
      loop: stores.loops.latestForIssue(ticket.id),
      session: latestSession(stores, ticket.id),
      leases: stores.leases.active().filter((lease) => lease.issueId === ticket.id),
      running: stores.jobs.runningForIssue(ticket.id),
    };
  });

  app.post<{ Params: KeyParams }>("/api/chat/:key", async (request, reply) => {
    const body = ChatBody.safeParse(request.body ?? undefined);
    if (!body.success) return badRequest(reply, body.error);
    if (deps.chat === undefined) return reply.code(501).send({ error: "this runtime runs steward chat in the CLI, not through the API" });
    const ticket = await ticketOf(request, reply);
    if (ticket === null) return reply;
    const session = latestSession(stores, ticket.id);
    if (session === null) return reply.code(404).send({ error: `no agent session for ${ticket.identifier}` });
    // A run pod brings its own services: the lease holds the ticket only, never a slot.
    const lease = acquireLease(stores, { issueId: ticket.id, identifier: ticket.identifier, worktreeName: session.worktreeName, ...(body.data.pid === undefined ? {} : { pid: body.data.pid }) }, 0);
    if ("busy" in lease) return reply.code(409).send({ error: lease.busy });
    const runId = chatRunIdOf(lease.leaseId);
    try {
      const { pod } = await deps.chat.start({ runId, ticket, session });
      chats.set(lease.leaseId, runId);
      logger.info({ identifier: ticket.identifier, runId, pod }, "steward chat: interactive run started");
      return { runId, pod, container: "agent", leaseId: lease.leaseId };
    } catch (err) {
      stores.leases.release(lease.leaseId);
      return reply.code(502).send({ error: `the chat's run pod could not be started: ${errorMessage(err)}` });
    }
  });

  app.post<{ Params: KeyParams }>("/api/chat/:key/heartbeat", async (request, reply) => {
    const ticket = await ticketOf(request, reply);
    if (ticket === null) return reply;
    const lease = leaseOf(ticket.id);
    if (lease === undefined || !stores.leases.heartbeat(lease.id)) return reply.code(404).send({ error: `no steward chat holds ${ticket.identifier}` });
    return { ok: true };
  });

  app.delete<{ Params: KeyParams }>("/api/chat/:key", async (request, reply) => {
    const ticket = await ticketOf(request, reply);
    if (ticket === null) return reply;
    const lease = leaseOf(ticket.id);
    if (lease === undefined) return { released: false, ok: null, error: null, unpushed: null };
    // The run first: the ticket stays held until its pod is done with the worktree's session.
    const runId = chats.get(lease.id) ?? chatRunIdOf(lease.id);
    let ended: ChatEnd = { ok: null, error: null, unpushed: null };
    try {
      if (deps.chat !== undefined) ended = await deps.chat.end(runId);
    } catch (err) {
      logger.warn({ runId, err: errorMessage(err) }, "steward chat: the run could not be ended");
    } finally {
      chats.delete(lease.id);
      stores.leases.release(lease.id);
    }
    return { released: true, ...ended };
  });

  return app;
};
