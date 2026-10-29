import { createServer } from "node:net";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AdminError, connectAdmin } from "../../src/cli/client.js";
import { buildProgram } from "../../src/cli/program.js";
import type { LoadedConfig } from "../../src/config/load.js";
import { loadConfig } from "../../src/config/load.js";
import type { StewardConfig } from "../../src/config/schema.js";
import { buildAdminServer, type ChatLauncher } from "../../src/server/admin.js";
import { DEFAULT_SETTINGS } from "../../src/settings/schema.js";
import { SettingsStore } from "../../src/settings/store.js";
import { openStores, type Stores } from "../../src/store/index.js";
import { FakeBrain } from "../fakes/fakeBrain.js";
import { FakeCodeHost } from "../fakes/fakeCodeHost.js";
import { FakeTracker } from "../fakes/fakeTracker.js";
import { RUNTIME } from "../k8s/helpers.js";
import { makeContext, rejectingFetch, tmpConfigDir, writeConfig } from "./helpers.js";

const TOKEN = "admin-token-value";

let dir: string;
let dataDir: string;
let configPath: string;
let stores: Stores;
let servers: FastifyInstance[];

/** A loopback port nothing listens on. */
const closedPort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      server.close(() => resolve(port));
    });
  });

/** The test config on the Kubernetes runtime, its runtime dir the test's own directory. */
const kubernetesConfig = (config: StewardConfig): StewardConfig => ({ ...config, runtime: { ...RUNTIME, runtimeDir: dir } });

const serveAdmin = async (chat?: ChatLauncher): Promise<number> => {
  const resolveTicket = (key: string) => Promise.resolve({ id: `issue-${key}`, identifier: key });
  const app = buildAdminServer({ token: TOKEN, stores, settings: new SettingsStore(stores.db, DEFAULT_SETTINGS), resolveTicket, fetchTicket: () => Promise.reject(new Error("Intended Test Error")), ...(chat === undefined ? {} : { chat }) });
  servers.push(app);
  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address();
  if (typeof address !== "object" || address === null) throw new Error("no address");
  return address.port;
};

beforeEach(async () => {
  dir = await tmpConfigDir();
  dataDir = join(dir, "data");
  configPath = await writeConfig(dir, { dataDir, overlayDir: join(dir, "overlay"), fetchUrl: "https://gitlab.example/acme/repo.git", port: 4100, serverPort: 3020 });
  stores = openStores(dataDir);
  servers = [];
});

afterEach(async () => {
  for (const server of servers) await server.close();
  stores.db.close();
  await rm(dir, { recursive: true, force: true });
});

describe("connectAdmin", () => {
  it("is null on the local runtime while serve has written no token, without asking anything", async () => {
    let asked = 0;
    const counting: typeof fetch = () => {
      asked += 1;
      return Promise.reject(new Error("Intended Test Error"));
    };
    const { config } = await loadConfig({ configPath });
    expect(await connectAdmin({ fetchImpl: counting }, config)).toBeNull();
    expect(asked).toBe(0);
  });

  it("talks to serve's admin API on the local runtime too, with the token in the data dir's run dir", async () => {
    const { config } = await loadConfig({ configPath });
    await mkdir(join(config.dataDir, "run"), { recursive: true });
    await writeFile(join(config.dataDir, "run", "admin.token"), TOKEN, { mode: 0o600 });
    const port = await serveAdmin();
    const client = await connectAdmin({ fetchImpl: fetch }, config, { port });
    if (client === null) throw new Error("the admin API did not answer");
    expect(await client.listJobs({ limit: 5 })).toEqual([]);
  });

  it("is null without a token file, and when the admin port is closed", async () => {
    const { config } = await loadConfig({ configPath });
    const port = await closedPort();
    expect(await connectAdmin({ fetchImpl: fetch }, kubernetesConfig(config), { port })).toBeNull();
    await writeFile(join(dir, "admin.token"), TOKEN, { mode: 0o600 });
    expect(await connectAdmin({ fetchImpl: fetch }, kubernetesConfig(config), { port })).toBeNull();
  });

  it("talks to the admin API with the token from the runtime dir", async () => {
    const id = stores.jobs.enqueue({ kind: "cli", issueId: "issue-1", identifier: "API-1", teamKey: "API", action: "implement" });
    await writeFile(join(dir, "admin.token"), TOKEN, { mode: 0o600 });
    const port = await serveAdmin();
    const { config } = await loadConfig({ configPath });
    const client = await connectAdmin({ fetchImpl: fetch }, kubernetesConfig(config), { port });
    if (client === null) throw new Error("the admin API did not answer");
    expect((await client.listJobs({ limit: 5 })).map((job) => job.id)).toEqual([id]);
    expect((await client.job(id))?.job.identifier).toBe("API-1");
    expect(await client.job(999)).toBeNull();
    await expect(client.retry(999)).rejects.toThrow(new AdminError(404, "job 999 not found"));
  });

  it("fails loudly when the API answers but refuses the token", async () => {
    await writeFile(join(dir, "admin.token"), "stale-token", { mode: 0o600 });
    const port = await serveAdmin();
    const { config } = await loadConfig({ configPath });
    await expect(connectAdmin({ fetchImpl: fetch }, kubernetesConfig(config), { port })).rejects.toThrow(/refused the token/);
  });
});

describe("steward jobs on the Kubernetes runtime", () => {
  const run = async (args: string[], fetchImpl: typeof fetch) => {
    const loaded = await loadConfig({ configPath });
    const context = makeContext({ fetchImpl, factories: { tracker: new FakeTracker(), brain: new FakeBrain(), codehost: new FakeCodeHost() } });
    const kubernetes: LoadedConfig = { ...loaded, config: kubernetesConfig(loaded.config) };
    context.ctx.loadConfig = () => Promise.resolve(kubernetes);
    await buildProgram(context.ctx).parseAsync(["node", "steward", "--config", configPath, ...args]);
    return context;
  };

  it("falls back to the database when the admin port is closed", async () => {
    const id = stores.jobs.enqueue({ kind: "cli", issueId: "issue-1", identifier: "API-1", teamKey: "API", action: "implement" });
    await writeFile(join(dir, "admin.token"), TOKEN, { mode: 0o600 });
    // Nothing answers: the admin port is closed (and the public port too, so no running line).
    const { stdout } = await run(["jobs"], rejectingFetch);
    expect(stdout()).toContain(`${id}\tqueued\tAPI-1\timplement\tattempts=0`);
  });

  it("lists through the admin API when it answers", async () => {
    const id = stores.jobs.enqueue({ kind: "cli", issueId: "issue-1", identifier: "API-1", teamKey: "API", action: "implement" });
    await writeFile(join(dir, "admin.token"), TOKEN, { mode: 0o600 });
    const port = await serveAdmin();
    const asked: string[] = [];
    // The CLI asks the fixed admin port; this stands the test server's port in for it.
    const routed: typeof fetch = (input, init) => {
      const url = new URL(String(input));
      asked.push(`${init?.method ?? "GET"} ${url.pathname}`);
      if (url.port !== "3022") return Promise.reject(new Error("Intended Test Error"));
      url.port = String(port);
      return fetch(url, init);
    };
    const { stdout } = await run(["jobs"], routed);
    expect(stdout()).toContain(`${id}\tqueued\tAPI-1\timplement\tattempts=0`);
    expect(asked).toContain("GET /api/jobs");
  });
});

describe("steward chat on the Kubernetes runtime", () => {
  const SHA = "c".repeat(40);

  it("opens the chat through the admin API, attaches to the returned pod, then releases the ticket and lists what was left", async () => {
    const jobId = stores.jobs.enqueue({ kind: "cli", issueId: "issue-API-1", identifier: "API-1", teamKey: "API", action: "implement" });
    stores.jobs.recordWorkspace(jobId, "ticket-API-1", SHA);
    stores.jobs.recordSession(jobId, "session-1");
    await writeFile(join(dir, "admin.token"), TOKEN, { mode: 0o600 });
    const ended: string[] = [];
    const port = await serveAdmin({
      start: ({ runId }) => Promise.resolve({ pod: `run-${runId}-xyz` }),
      end: (runId) => {
        ended.push(runId);
        return Promise.resolve({ ok: true, error: null, unpushed: "?? notes.txt" });
      },
    });
    const routed: typeof fetch = (input, init) => {
      const url = new URL(String(input));
      if (url.port !== "3022") return Promise.reject(new Error("Intended Test Error"));
      url.port = String(port);
      return fetch(url, init);
    };
    const attached: Array<{ namespace: string; pod: string; container: string; leases: number }> = [];
    const loaded = await loadConfig({ configPath });
    const context = makeContext({
      fetchImpl: routed,
      factories: {
        attachTty: ({ namespace, pod, container }) => {
          attached.push({ namespace, pod, container, leases: stores.leases.active().length });
          return Promise.resolve();
        },
      },
    });
    context.ctx.loadConfig = () => Promise.resolve({ ...loaded, config: kubernetesConfig(loaded.config) });
    await buildProgram(context.ctx).parseAsync(["node", "steward", "--config", configPath, "chat", "API-1"]);

    expect(attached).toEqual([{ namespace: "ticket-steward", pod: "run-chat-1-xyz", container: "agent", leases: 1 }]);
    expect(ended).toEqual(["chat-1"]);
    expect(stores.leases.active()).toEqual([]);
    expect(context.stdout()).toContain("Left in the agent's worktree, not pushed:\n?? notes.txt");
  });

  it("fails, without touching the DB's leases, when the admin API does not answer", async () => {
    const loaded = await loadConfig({ configPath });
    const context = makeContext();
    context.ctx.loadConfig = () => Promise.resolve({ ...loaded, config: kubernetesConfig(loaded.config) });
    await expect(buildProgram(context.ctx).parseAsync(["node", "steward", "--config", configPath, "chat", "API-1"])).rejects.toThrow("exit 1");
    expect(context.stderr()).toContain("admin API, which does not answer");
  });
});
