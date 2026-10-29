import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentSession } from "../../src/chat/session.js";
import { buildAdminServer, chatRunIdOf, writeAdminToken, type ChatLauncher } from "../../src/server/admin.js";
import { openStores, type Stores } from "../../src/store/index.js";

const SHA = "c".repeat(40);
const TOKEN = "admin-token-value";

let dir: string;
let stores: Stores;
let app: FastifyInstance;
let started: Array<{ runId: string; identifier: string; sessionId: string }>;
let ended: string[];

const launcher: ChatLauncher = {
  start: (p: { runId: string; ticket: { identifier: string }; session: AgentSession }) => {
    started.push({ runId: p.runId, identifier: p.ticket.identifier, sessionId: p.session.sessionId });
    return Promise.resolve({ pod: `run-${p.runId}-abcde` });
  },
  end: (runId) => {
    ended.push(runId);
    return Promise.resolve({ ok: true, error: null, unpushed: "?? notes.txt" });
  },
};

const resolveTicket = (key: string): Promise<{ id: string; identifier: string }> => {
  if (!/^API-\d+$/.test(key)) return Promise.reject(new Error(`no issue ${key}`));
  return Promise.resolve({ id: `issue-${key}`, identifier: key });
};

/** An implement job of the ticket that left a session in its worktree, with its push landed. */
const withSession = (identifier: string): number => {
  const id = stores.jobs.enqueue({ kind: "cli", issueId: `issue-${identifier}`, identifier, teamKey: "API", action: "implement" });
  stores.jobs.recordWorkspace(id, `ticket-${identifier}`, SHA);
  stores.jobs.recordSession(id, `session-${identifier}`);
  return id;
};

const call = (method: "GET" | "POST" | "DELETE", url: string, token: string | null = TOKEN, payload?: object) =>
  app.inject({ method, url, ...(token === null ? {} : { headers: { authorization: `Bearer ${token}` } }), ...(payload === undefined ? {} : { payload }) });

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "steward-admin-"));
  stores = openStores(dir);
  started = [];
  ended = [];
  app = buildAdminServer({ token: TOKEN, stores, resolveTicket, chat: launcher });
});

afterEach(async () => {
  await app.close();
  stores.db.close();
  await rm(dir, { recursive: true, force: true });
});

describe("admin API authentication", () => {
  it("answers 401 without the token, with another token and with a malformed header", async () => {
    for (const token of [null, "wrong-token"]) {
      const response = await call("GET", "/api/jobs", token);
      expect(response.statusCode).toBe(401);
    }
    const malformed = await app.inject({ method: "GET", url: "/api/jobs", headers: { authorization: TOKEN } });
    expect(malformed.statusCode).toBe(401);
    expect((await call("POST", "/api/chat/API-1", null)).statusCode).toBe(401);
    expect(started).toEqual([]);
  });

  it("writes the token to <runtimeDir>/admin.token with mode 0600, a new one each start", async () => {
    const first = await writeAdminToken(dir);
    const file = join(dir, "admin.token");
    expect(await readFile(file, "utf8")).toBe(first);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    const second = await writeAdminToken(dir);
    expect(second).not.toBe(first);
    expect(await readFile(file, "utf8")).toBe(second);
    expect(first).toMatch(/^[A-Za-z0-9_-]{40,}$/);
  });
});

describe("admin API jobs", () => {
  it("lists jobs newest first, honouring limit and status", async () => {
    const first = stores.jobs.enqueue({ kind: "cli", issueId: "issue-1", identifier: "API-1", teamKey: "API", action: "implement" });
    const second = stores.jobs.enqueue({ kind: "cli", issueId: "issue-2", identifier: "API-2", teamKey: "API", action: "implement" });
    stores.jobs.claimById(second);

    const all = (await call("GET", "/api/jobs")).json<{ jobs: Array<{ id: number }> }>();
    expect(all.jobs.map((job) => job.id)).toEqual([second, first]);
    const limited = (await call("GET", "/api/jobs?limit=1")).json<{ jobs: Array<{ id: number }> }>();
    expect(limited.jobs.map((job) => job.id)).toEqual([second]);
    const queued = (await call("GET", "/api/jobs?status=queued")).json<{ jobs: Array<{ id: number }> }>();
    expect(queued.jobs.map((job) => job.id)).toEqual([first]);
    expect((await call("GET", "/api/jobs?limit=0")).statusCode).toBe(400);
    expect((await call("GET", "/api/jobs?status=bogus")).statusCode).toBe(400);
  });

  it("shows a job with its attempts, and 404 for an unknown one", async () => {
    const id = stores.jobs.enqueue({ kind: "cli", issueId: "issue-1", identifier: "API-1", teamKey: "API", action: "implement" });
    const shown = await call("GET", `/api/jobs/${id}`);
    expect(shown.statusCode).toBe(200);
    expect(shown.json()).toMatchObject({ job: { id, identifier: "API-1" }, attempts: [], loop: null });
    expect((await call("GET", "/api/jobs/999")).statusCode).toBe(404);
  });

  it("requeues a finished job for retry, saying what the retry will do, and refuses a running one", async () => {
    const id = stores.jobs.enqueue({ kind: "cli", issueId: "issue-1", identifier: "API-1", teamKey: "API", action: "implement" });
    stores.jobs.claimById(id);
    const running = await call("POST", `/api/jobs/${id}/retry`);
    expect(running.statusCode).toBe(409);
    expect(running.json()).toEqual({ error: `job ${id} is already running` });

    stores.jobs.finish(id, { status: "failed", error: "boom", retryable: false });
    const retried = await call("POST", `/api/jobs/${id}/retry`);
    expect(retried.statusCode).toBe(200);
    expect(retried.json()).toEqual({ mode: `job ${id}: full run` });
    expect(stores.jobs.get(id)?.status).toBe("queued");
    expect((await call("POST", "/api/jobs/999/retry")).statusCode).toBe(404);
  });
});

describe("admin API tickets", () => {
  it("returns the ticket's loop state, latest session and leases", async () => {
    const jobId = withSession("API-1");
    const response = await call("GET", "/api/tickets/API-1");
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      ticket: { id: "issue-API-1", identifier: "API-1" },
      loop: null,
      session: { sessionId: "session-API-1", worktreeName: "ticket-API-1", jobId },
      leases: [],
      running: null,
    });
    expect((await call("GET", "/api/tickets/nope")).statusCode).toBe(404);
  });
});

describe("admin API chat", () => {
  it("takes the lease and launches an interactive run, returning its pod and the agent container", async () => {
    withSession("API-1");
    const response = await call("POST", "/api/chat/API-1", TOKEN, { pid: 4242 });
    expect(response.statusCode).toBe(200);
    const [lease] = stores.leases.active();
    if (lease === undefined) throw new Error("no lease taken");
    const runId = chatRunIdOf(lease.id);
    expect(response.json()).toEqual({ runId, pod: `run-${runId}-abcde`, container: "agent", leaseId: lease.id });
    expect(lease).toMatchObject({ issueId: "issue-API-1", worktreeName: "ticket-API-1", slot: null, pid: 4242 });
    expect(started).toEqual([{ runId, identifier: "API-1", sessionId: "session-API-1" }]);
  });

  it("answers the second chat on a ticket with 409, naming the holder", async () => {
    withSession("API-1");
    expect((await call("POST", "/api/chat/API-1", TOKEN, { pid: 4242 })).statusCode).toBe(200);
    const second = await call("POST", "/api/chat/API-1", TOKEN, { pid: 5151 });
    expect(second.statusCode).toBe(409);
    expect(second.json<{ error: string }>().error).toBe("another steward chat (pid 4242) holds API-1");
    expect(started).toHaveLength(1);
    expect(stores.leases.active()).toHaveLength(1);
  });

  it("refuses while a job on the ticket runs, and 404s a ticket without a session", async () => {
    const jobId = withSession("API-1");
    stores.jobs.claimById(jobId);
    const busy = await call("POST", "/api/chat/API-1");
    expect(busy.statusCode).toBe(409);
    expect(busy.json<{ error: string }>().error).toContain(`job ${jobId}`);
    const none = await call("POST", "/api/chat/API-2");
    expect(none.statusCode).toBe(404);
    expect(none.json()).toEqual({ error: "no agent session for API-2" });
    expect(stores.leases.active()).toEqual([]);
  });

  it("gives the lease back when the run pod cannot be started", async () => {
    withSession("API-1");
    app = buildAdminServer({ token: TOKEN, stores, resolveTicket, chat: { ...launcher, start: () => Promise.reject(new Error("quota exceeded")) } });
    const response = await call("POST", "/api/chat/API-1");
    expect(response.statusCode).toBe(502);
    expect(response.json()).toEqual({ error: "the chat's run pod could not be started: quota exceeded" });
    expect(stores.leases.active()).toEqual([]);
  });

  it("heartbeats the lease, and releases it on DELETE after ending the run, returning what was left unpushed", async () => {
    withSession("API-1");
    const opened = (await call("POST", "/api/chat/API-1")).json<{ runId: string; leaseId: number }>();
    expect((await call("POST", "/api/chat/API-1/heartbeat")).statusCode).toBe(200);

    const closed = await call("DELETE", "/api/chat/API-1");
    expect(closed.statusCode).toBe(200);
    expect(closed.json()).toEqual({ released: true, ok: true, error: null, unpushed: "?? notes.txt" });
    expect(ended).toEqual([opened.runId]);
    expect(stores.leases.active()).toEqual([]);
    expect((await call("POST", "/api/chat/API-1/heartbeat")).statusCode).toBe(404);
    expect((await call("DELETE", "/api/chat/API-1")).json()).toEqual({ released: false, ok: null, error: null, unpushed: null });
  });

  it("ends a lease's run after a restart, when the steward no longer remembers it", async () => {
    withSession("API-1");
    await call("POST", "/api/chat/API-1");
    const [lease] = stores.leases.active();
    if (lease === undefined) throw new Error("no lease taken");
    // A fresh server over the same database: the steward restarted while the chat was open.
    app = buildAdminServer({ token: TOKEN, stores, resolveTicket, chat: launcher });
    expect((await call("POST", "/api/chat/API-1/heartbeat")).statusCode).toBe(200);
    expect((await call("DELETE", "/api/chat/API-1")).json()).toMatchObject({ released: true });
    expect(ended).toEqual([chatRunIdOf(lease.id)]);
    expect(stores.leases.active()).toEqual([]);
  });

  it("answers 501 when the runtime cannot launch chats", async () => {
    withSession("API-1");
    app = buildAdminServer({ token: TOKEN, stores, resolveTicket });
    const response = await call("POST", "/api/chat/API-1");
    expect(response.statusCode).toBe(501);
    expect(stores.leases.active()).toEqual([]);
  });
});
