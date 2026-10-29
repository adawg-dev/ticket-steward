import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { buildProgram } from "../../src/cli/program.js";
import { NO_ADMIN_API } from "../../src/cli/runtime.js";
import { loadConfig } from "../../src/config/load.js";
import type { SecretFetcher } from "../../src/config/secretSource.js";
import { buildAdminServer } from "../../src/server/admin.js";
import { DEFAULT_SETTINGS } from "../../src/settings/schema.js";
import { SettingsStore } from "../../src/settings/store.js";
import { openStores, type Stores } from "../../src/store/index.js";
import type { TemplateListing } from "../../src/tracker/types.js";
import { RUNTIME } from "../k8s/helpers.js";
import { ExitSignal, makeContext, tmpConfigDir, writeConfig } from "./helpers.js";

const listings: TemplateListing[] = [
  { scope: "API", template: { name: "Bugs", description: "Bug report", body: "**Repro Steps**\n**Evidence**", requiredFields: ["Repro Steps", "Evidence"] } },
  { scope: "API", template: { name: "Feature", description: "Feature request", body: "**Goal**", requiredFields: ["Goal"] } },
];

const ADMIN_TOKEN = "admin-token-value";

let dir: string;
let configPath: string;
let stores: Stores;
let admin: FastifyInstance;
let asked: string[];
let routed: typeof fetch;

beforeEach(async () => {
  dir = await tmpConfigDir();
  configPath = await writeConfig(dir, {
    dataDir: join(dir, "data"),
    overlayDir: join(dir, "overlay"),
    fetchUrl: "https://gitlab.example/acme/repo.git",
    port: 4100,
    serverPort: 3020,
  });
  // steward serve's admin API, listing the templates with the dispatcher's token.
  await writeFile(join(dir, "admin.token"), ADMIN_TOKEN, { mode: 0o600 });
  stores = openStores(join(dir, "data"));
  admin = buildAdminServer({
    token: ADMIN_TOKEN,
    stores,
    settings: new SettingsStore(stores.db, DEFAULT_SETTINGS),
    resolveTicket: () => Promise.reject(new Error("unused")),
    fetchTicket: () => Promise.reject(new Error("unused")),
    listTemplates: () => Promise.resolve(listings),
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
  await rm(dir, { recursive: true, force: true });
});

/** `steward templates`, on the Kubernetes runtime with the test's runtime dir unless `local`. */
const run = (opts: { fetcher?: SecretFetcher; local?: boolean } = {}) => {
  const context = makeContext({ fetchImpl: routed });
  context.ctx.loadConfig = async (load) => {
    const loaded = await loadConfig({ ...load, ...(opts.fetcher === undefined ? {} : { secretFetcher: opts.fetcher }) });
    return opts.local === true ? loaded : { ...loaded, config: { ...loaded.config, runtime: { ...RUNTIME, runtimeDir: dir } } };
  };
  const done = buildProgram(context.ctx).parseAsync(["node", "steward", "--config", configPath, "templates"]);
  return { ...context, done };
};

describe("steward templates", () => {
  it("prints one line per template with its scope and required fields, as the dispatcher lists them", async () => {
    const { done, stdout } = await run();
    await done;

    expect(stdout()).toBe("API\tBugs\trequired: Repro Steps, Evidence\nAPI\tFeature\trequired: Goal\n");
    expect(asked).toContain("GET 127.0.0.1:3022/api/templates");
    expect(asked.filter((call) => !call.startsWith("GET 127.0.0.1:3022/"))).toEqual([]);
  });

  it("never reads a secret, the Linear app's credentials least of all", async () => {
    const read: string[] = [];
    const fetcher: SecretFetcher = {
      get: (id) => {
        read.push(id);
        return Promise.resolve(`value-of-${id}`);
      },
    };
    configPath = await writeConfig(dir, {
      dataDir: join(dir, "data"),
      overlayDir: join(dir, "overlay"),
      fetchUrl: "https://gitlab.example/acme/repo.git",
      port: 4100,
      serverPort: 3020,
      secrets: { source: "aws", region: "us-east-1", map: { LINEAR_CLIENT_ID: "DEV_STEWARD_LINEAR_CLIENT_ID", LINEAR_CLIENT_SECRET: "DEV_STEWARD_LINEAR_CLIENT_SECRET" } },
    });
    const { done } = await run({ fetcher });
    await done;

    expect(read).toEqual([]);
  });

  it("fails without the dispatcher's admin API", async () => {
    const { done, stderr } = await run({ local: true });

    await expect(done).rejects.toEqual(new ExitSignal(1));
    expect(stderr()).toContain(NO_ADMIN_API);
    expect(asked).toEqual([]);
  });
});
