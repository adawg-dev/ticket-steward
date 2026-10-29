import { rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AdminClient } from "../../src/cli/client.js";
import { CLI_SECRET_NAMES } from "../../src/cli/context.js";
import { adminTracker, buildRuntime } from "../../src/cli/runtime.js";
import { loadConfig, type LoadedConfig } from "../../src/config/load.js";
import type { TicketBundle } from "../../src/tracker/types.js";
import { makeContext, tmpConfigDir, writeConfig } from "./helpers.js";

const bundle: TicketBundle = {
  id: "issue-1",
  identifier: "API-1",
  url: "https://linear.app/acme/issue/API-1",
  title: "Adapter drops the last chunk",
  description: "The adapter loses the final chunk.",
  team: { id: "team-1", key: "API", name: "API" },
  state: { name: "Todo", type: "unstarted" },
  labels: [],
  priority: 2,
  creator: { name: "Ada", isBot: false },
  createdAt: "2026-10-29T00:00:00.000Z",
  comments: [],
  attachments: [],
  appliedTemplate: null,
  templates: [],
};

let dir: string;
let loaded: LoadedConfig;

beforeEach(async () => {
  dir = await tmpConfigDir();
  const configPath = await writeConfig(dir, { dataDir: join(dir, "data"), overlayDir: join(dir, "overlay"), fetchUrl: "https://gitlab.example/acme/repo.git", port: 4100, serverPort: 3020 });
  loaded = await loadConfig({ configPath, secretNames: CLI_SECRET_NAMES });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("CLI_SECRET_NAMES", () => {
  it("leaves out every Linear secret", () => {
    expect(CLI_SECRET_NAMES.filter((name) => name.startsWith("LINEAR_"))).toEqual([]);
    expect(CLI_SECRET_NAMES).toContain("GITLAB_PUSH_TOKEN");
  });
});

describe("buildRuntime for a CLI command", () => {
  it("holds no Linear token and reaches Linear only through serve's admin API", async () => {
    let asked = 0;
    const counting: typeof fetch = () => {
      asked += 1;
      return Promise.reject(new Error("Intended Test Error"));
    };
    const { ctx } = makeContext({ fetchImpl: counting });
    const runtime = await buildRuntime(loaded, ctx);
    try {
      expect(runtime.linearToken).toBeUndefined();
      // The local runtime has no admin API: nothing is asked, and nothing reaches Linear.
      await expect(runtime.tracker.fetchTicket("issue-1")).rejects.toThrow("reaches Linear only through steward serve's admin API");
      await expect(runtime.tracker.appUserId()).rejects.toThrow("reaches Linear only through steward serve's admin API");
      expect(runtime.tracker.credentialsRejected()).toBe(false);
      expect(asked).toBe(0);
    } finally {
      runtime.stores.db.close();
    }
  });

  it("serve's runtime needs the Linear app's credentials", async () => {
    const { ctx } = makeContext();
    await expect(buildRuntime(loaded, ctx, { serve: true })).rejects.toThrow("LINEAR_CLIENT_ID and LINEAR_CLIENT_SECRET must be set");
  });
});

describe("adminTracker", () => {
  it("reads tickets from the admin API's bundle", async () => {
    const keys: string[] = [];
    const client: Pick<AdminClient, "ticketBundle"> = {
      ticketBundle: (key) => {
        keys.push(key);
        return Promise.resolve(structuredClone(bundle));
      },
    };
    const tracker = adminTracker(client);

    expect(await tracker.resolveIssueId("API-1")).toEqual({ id: "issue-1", identifier: "API-1", teamKey: "API" });
    expect(await tracker.fetchTicket("issue-1")).toEqual(bundle);
    expect(await tracker.readDescription("issue-1")).toBe("The adapter loses the final chunk.");
    expect(keys).toEqual(["API-1", "issue-1", "issue-1"]);
  });
});
