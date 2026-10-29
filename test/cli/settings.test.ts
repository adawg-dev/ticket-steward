import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { buildProgram } from "../../src/cli/program.js";
import { loadConfig, type LoadedConfig } from "../../src/config/load.js";
import { buildAdminServer } from "../../src/server/admin.js";
import { DEFAULT_SETTINGS } from "../../src/settings/schema.js";
import { SettingsStore } from "../../src/settings/store.js";
import { openStores, type Stores } from "../../src/store/index.js";
import { RUNTIME } from "../k8s/helpers.js";
import { makeContext, tmpConfigDir, writeConfig } from "./helpers.js";

const TOKEN = "admin-token-value";

let dir: string;
let dataDir: string;
let configPath: string;
let stores: Stores;
let admin: FastifyInstance | null;

beforeEach(async () => {
  dir = await tmpConfigDir();
  dataDir = join(dir, "data");
  configPath = await writeConfig(dir, { dataDir, overlayDir: join(dir, "overlay"), fetchUrl: "https://gitlab.example/acme/repo.git", port: 4100, serverPort: 3020 });
  stores = openStores(dataDir);
  admin = null;
});

afterEach(async () => {
  await admin?.close();
  stores.db.close();
  await rm(dir, { recursive: true, force: true });
});

/** The CLI on the local runtime: it opens the DB. */
const runLocal = async (args: string[]) => {
  const context = makeContext();
  const done = buildProgram(context.ctx).parseAsync(["node", "steward", "--config", configPath, "settings", ...args]);
  return { ...context, done };
};

describe("steward settings on the local runtime", () => {
  it("prints every setting, or one, seeded from the config", async () => {
    const all = await runLocal(["get"]);
    await all.done;
    expect(all.stdout()).toContain("review.quietMinutes\t2\n");
    expect(all.stdout()).toContain('linear.reviewStateName\t"In Review"\n');
    const one = await runLocal(["get", "ci.lookbackDays"]);
    await one.done;
    expect(one.stdout()).toBe("14\n");
  });

  it("sets a value parsed as JSON, else taken as a string, and audits it as cli", async () => {
    await (await runLocal(["set", "review.quietMinutes", "5"])).done;
    await (await runLocal(["set", "linear.reviewStateName", "Code Review"])).done;
    const settings = new SettingsStore(stores.db, DEFAULT_SETTINGS);
    expect(settings.get()).toMatchObject({ "review.quietMinutes": 5, "linear.reviewStateName": "Code Review" });
    expect(settings.audit(10).map(({ key, updatedBy }) => `${key} ${updatedBy}`)).toEqual(["linear.reviewStateName cli", "review.quietMinutes cli"]);
  });

  it("refuses an unknown key and an invalid value, changing nothing", async () => {
    const unknown = await runLocal(["set", "worker.allowlist", "[]"]);
    await expect(unknown.done).rejects.toThrow("exit 1");
    expect(unknown.stderr()).toContain("unknown setting worker.allowlist");
    const invalid = await runLocal(["set", "review.quietMinutes", "-1"]);
    await expect(invalid.done).rejects.toThrow("exit 1");
    expect(invalid.stderr()).toContain("review.quietMinutes");
    const missing = await runLocal(["get", "nope"]);
    await expect(missing.done).rejects.toThrow("exit 1");
    expect(new SettingsStore(stores.db, DEFAULT_SETTINGS).audit(10)).toEqual([]);
  });
});

describe("steward settings on the Kubernetes runtime", () => {
  it("reads and sets through the admin API", async () => {
    await writeFile(join(dir, "admin.token"), TOKEN, { mode: 0o600 });
    const settings = new SettingsStore(stores.db, DEFAULT_SETTINGS);
    admin = buildAdminServer({ token: TOKEN, stores, settings, resolveTicket: (key) => Promise.resolve({ id: key, identifier: key }), fetchTicket: () => Promise.reject(new Error("Intended Test Error")) });
    await admin.listen({ port: 0, host: "127.0.0.1" });
    const address = admin.server.address();
    if (typeof address !== "object" || address === null) throw new Error("no address");
    const asked: Array<{ call: string; body: unknown }> = [];
    // The CLI asks the fixed admin port; this stands the test server's port in for it.
    const routed: typeof fetch = (input, init) => {
      const url = new URL(String(input));
      asked.push({ call: `${init?.method ?? "GET"} ${url.pathname}`, body: typeof init?.body === "string" ? JSON.parse(init.body) : null });
      if (url.port !== "3022") return Promise.reject(new Error("Intended Test Error"));
      url.port = String(address.port);
      return fetch(url, init);
    };
    const loaded = await loadConfig({ configPath });
    const kubernetes: LoadedConfig = { ...loaded, config: { ...loaded.config, runtime: { ...RUNTIME, runtimeDir: dir } } };
    const run = async (args: string[]) => {
      const context = makeContext({ fetchImpl: routed });
      context.ctx.loadConfig = () => Promise.resolve(kubernetes);
      await buildProgram(context.ctx).parseAsync(["node", "steward", "--config", configPath, "settings", ...args]);
      return context;
    };

    const set = await run(["set", "review.quietMinutes", "5"]);
    expect(set.stdout()).toBe("review.quietMinutes\t5\n");
    expect(asked).toContainEqual({ call: "PATCH /api/settings", body: { "review.quietMinutes": 5 } });
    expect(settings.audit(10).map(({ key, updatedBy }) => `${key} ${updatedBy}`)).toEqual(["review.quietMinutes admin-cli"]);

    const get = await run(["get", "review.quietMinutes"]);
    expect(get.stdout()).toBe("5\n");
    expect(asked.map(({ call }) => call)).toContain("GET /api/settings");
  });
});
