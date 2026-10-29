import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import { buildProgram } from "../../src/cli/program.js";
import { loadConfig } from "../../src/config/load.js";
import type { SecretFetcher } from "../../src/config/secretSource.js";
import { buildAdminServer } from "../../src/server/admin.js";
import { DEFAULT_SETTINGS } from "../../src/settings/schema.js";
import { SettingsStore } from "../../src/settings/store.js";
import { openStores, type Stores } from "../../src/store/index.js";
import type { TicketBundle } from "../../src/tracker/types.js";
import { FakeBrain } from "../fakes/fakeBrain.js";
import { FakeTracker } from "../fakes/fakeTracker.js";
import { freeTcpPort, tmpRepo, type TmpRepo } from "../fakes/tmpRepo.js";
import { RUNTIME } from "../k8s/helpers.js";
import { commitFile, git } from "../workspace/helpers.js";
import { ExitSignal, makeContext, tmpConfigDir, writeConfig, type ConfigPaths } from "./helpers.js";

const IMPLEMENT_PROMPT = fileURLToPath(new URL("../../prompts/implement.md", import.meta.url));

const issue: TicketBundle = {
  id: "issue-1",
  identifier: "API-1",
  url: "https://linear.app/acme/issue/API-1",
  title: "Adapter drops the last chunk",
  description: "The adapter loses the final chunk.",
  team: { id: "team-1", key: "API", name: "API" },
  state: { name: "Todo", type: "unstarted" },
  labels: ["ready-for-agent"],
  priority: 2,
  creator: { name: "Ada", isBot: false },
  createdAt: "2026-09-11T00:00:00.000Z",
  comments: [],
  attachments: [],
  appliedTemplate: null,
  templates: [],
};

const ADMIN_TOKEN = "admin-token-value";

let dir: string;
let repo: TmpRepo;
let tracker: FakeTracker;
let stores: Stores;
let admin: FastifyInstance;
let asked: string[];
let routed: typeof fetch;
let paths: ConfigPaths;

beforeEach(async () => {
  dir = await tmpConfigDir();
  repo = await tmpRepo("unused");
  await commitFile(repo.repo, ".gitignore", ".env\n");
  await repo.mirror.fetch();
  tracker = new FakeTracker([issue]);
  paths = {
    dataDir: repo.dataDir,
    overlayDir: repo.overlayDir,
    fetchUrl: repo.repo,
    port: await freeTcpPort(),
    serverPort: await freeTcpPort(),
    implement: { prompt: IMPLEMENT_PROMPT },
  };
  // steward serve's admin API, reading Linear with the dispatcher's tracker.
  await writeFile(join(dir, "admin.token"), ADMIN_TOKEN, { mode: 0o600 });
  stores = openStores(repo.dataDir);
  admin = buildAdminServer({
    token: ADMIN_TOKEN,
    stores,
    settings: new SettingsStore(stores.db, DEFAULT_SETTINGS),
    resolveTicket: (key) => tracker.resolveIssueId(key),
    fetchTicket: (issueId) => tracker.fetchTicket(issueId),
  });
  await admin.listen({ port: 0, host: "127.0.0.1" });
  const address = admin.server.address();
  if (typeof address !== "object" || address === null) throw new Error("no address");
  asked = [];
  // The CLI asks the fixed admin port; this stands the test server's port in for it. Nothing else answers.
  routed = (input, init) => {
    const url = new URL(String(input));
    asked.push(`${init?.method ?? "GET"} ${url.host}${url.pathname}`);
    if (url.port !== "3022") return Promise.reject(new Error("Intended Test Error"));
    url.port = String(address.port);
    return fetch(url, init);
  };
});

afterEach(async () => {
  await admin.close();
  stores.db.close();
  await repo.cleanup();
  await rm(dir, { recursive: true, force: true });
});

/** The CLI on the Kubernetes runtime, its runtime dir the test's own; `fetcher` stands in for Secrets Manager. */
const run = async (args: string[], opts: { secrets?: Record<string, unknown>; fetcher?: SecretFetcher } = {}) => {
  const configPath = await writeConfig(dir, { ...paths, ...(opts.secrets === undefined ? {} : { secrets: opts.secrets }) });
  const brain = new FakeBrain();
  const context = makeContext({ fetchImpl: routed, factories: { brain } });
  context.ctx.loadConfig = async (load) => {
    const loaded = await loadConfig({ ...load, ...(opts.fetcher === undefined ? {} : { secretFetcher: opts.fetcher }) });
    return { ...loaded, config: { ...loaded.config, runtime: { ...RUNTIME, runtimeDir: dir } } };
  };
  const done = buildProgram(context.ctx).parseAsync(["node", "steward", "--config", configPath, ...args]);
  return { ...context, brain, done };
};

describe("steward implement", () => {
  it("refuses to start work: assigning the steward in Linear is the only way", async () => {
    const { done, stderr } = await run(["implement", "API-1"]);

    await expect(done).rejects.toEqual(new ExitSignal(1));
    expect(stderr()).toContain("assign the steward in Linear to start work");
    expect(stores.jobs.list({ limit: 10 })).toEqual([]);
    expect(asked).toEqual([]);
  });

  it("dry run prints the implement prompt from the dispatcher's bundle, running nothing and writing nothing", async () => {
    const { done, stdout, brain } = await run(["implement", "API-1", "--dry-run"]);
    await done;

    expect(stdout()).toContain("# API-1: Adapter drops the last chunk");
    expect(stdout()).toContain("The adapter loses the final chunk.");
    expect(stdout()).toContain(`at commit \`${await git(repo.mirror.path, ["rev-parse", "main"])}\``);
    expect(asked).toContain("GET 127.0.0.1:3022/api/tickets/API-1/bundle");
    expect(asked.filter((call) => !call.startsWith("GET 127.0.0.1:3022/"))).toEqual([]);
    expect(brain.runs).toBe(0);
    expect(stores.jobs.list({ limit: 10 })).toEqual([]);
    expect(await git(repo.repo, ["branch", "--list", "*/API-1-*"])).toBe("");
  });

  it("never reads the Linear app's credentials", async () => {
    const read: string[] = [];
    const fetcher: SecretFetcher = {
      get: (id) => {
        read.push(id);
        return Promise.resolve(`value-of-${id}`);
      },
    };
    const secrets = {
      source: "aws",
      region: "us-east-1",
      map: { GITLAB_PUSH_TOKEN: "DEV_PUSH", LINEAR_CLIENT_ID: "DEV_STEWARD_LINEAR_CLIENT_ID", LINEAR_CLIENT_SECRET: "DEV_STEWARD_LINEAR_CLIENT_SECRET" },
    };
    const { done } = await run(["implement", "API-1", "--dry-run"], { secrets, fetcher });
    await done;

    expect(read).toEqual(["DEV_PUSH"]);
  });

  it("has no fix command any more", async () => {
    const { done, stderr } = await run(["fix", "API-1"]);

    await expect(done).rejects.toBeInstanceOf(ExitSignal);
    expect(stderr()).toContain("unknown command 'fix'");
  });
});
