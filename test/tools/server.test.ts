import { request } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { MediaItem, MediaUploads } from "../../src/codehost/media.js";
import type { OrbitRemote } from "../../src/orbit/server.js";
import type { PushResult } from "../../src/push/service.js";
import type { RunSpec, WorkReport } from "../../src/run/protocol.js";
import { parseListen, startToolsServer, toolRoutes, type ToolsServer } from "../../src/tools/server.js";
import { FakeCodeHost } from "../fakes/fakeCodeHost.js";

const SHA = "a".repeat(40);

const spec: RunSpec = {
  version: 1,
  runId: "7-1",
  jobId: 7,
  kind: "implement",
  identifier: "API-1",
  issueId: "issue-1",
  checkout: { ref: null, sha: SHA },
  baseSha: SHA,
  worktreePath: "/var/lib/ticket-steward/work/ticket-API-1",
  artifactsDir: "/var/lib/ticket-steward/jobs/7/artifacts",
  transcriptPath: "/var/lib/ticket-steward/jobs/7/attempt-1.jsonl",
  prompt: "Implement API-1.",
  personCommits: null,
  output: "implement",
  resumeSessionId: null,
  limits: { timeoutMinutes: 60, maxTurns: 200, setupTimeoutMinutes: 20 },
  push: { jobId: 7, worktreePath: "/var/lib/ticket-steward/work/ticket-API-1", identifier: "API-1", issueId: "issue-1", title: "Adapter drops the last chunk", mode: "create", branch: null, baseSha: SHA, loopId: null, port: 3000 },
  setup: [],
  checks: [],
  interactive: false,
};

const orbit: OrbitRemote = { exec: () => Promise.reject(new Error("not called")), cwd: spec.worktreePath, env: {}, unavailable: "GITLAB_TOKEN is not set", secrets: [] };
const pushed: PushResult = { ok: true, branch: "fix/API-1-x", sha: SHA, commits: 1 };
const work: WorkReport = { runId: "7-1", unpushed: "", pushedSha: SHA };

let server: ToolsServer | null = null;

const uploads: MediaUploads = { embeds: [{ caption: "After", markdown: "![a.png](/uploads/1/a.png)" }], rejected: [] };
const attached: MediaItem[][] = [];

const start = async (runSpec: RunSpec, opts: { media?: boolean } = {}): Promise<ToolsServer> => {
  server = await startToolsServer({
    listen: { host: "127.0.0.1", port: 0 },
    routes: toolRoutes({ spec: runSpec, codehost: new FakeCodeHost(), orbit, push: () => () => Promise.resolve(pushed) }),
    finish: () => Promise.resolve(work),
    ...(opts.media === false
      ? {}
      : {
          media: (items: MediaItem[]) => {
            attached.push(items);
            return Promise.resolve(uploads);
          },
        }),
  });
  return server;
};

const connect = async (url: string): Promise<Client> => {
  const client = new Client({ name: "steward-test", version: "0.0.0" });
  // The SDK types `sessionId` as `string | undefined` where Transport has it optional; under exactOptionalPropertyTypes only.
  await client.connect(new StreamableHTTPClientTransport(new URL(url)) as Transport);
  return client;
};

/** A POST with exactly these headers: fetch replaces a Host header with the URL's own. */
const post = (url: string, headers: Record<string, string>, body = ""): Promise<number> =>
  new Promise((resolve, reject) => {
    const req = request(url, { method: "POST", headers }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("error", reject);
    req.end(body);
  });

afterEach(async () => {
  await server?.close();
  server = null;
  attached.length = 0;
});

describe("the tools sidecar", () => {
  it("serves the push tool over HTTP when the run has a push target", async () => {
    const { url } = await start(spec);
    const client = await connect(`${url}/mcp/push`);

    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(["push"]);
    const result = await client.callTool({ name: "push", arguments: { branchType: "fix" } });
    expect(result.content).toEqual([{ type: "text", text: JSON.stringify(pushed) }]);
    await client.close();
  });

  it("serves the code host and Orbit tools", async () => {
    const { url } = await start(spec);
    const codehost = await connect(`${url}/mcp/codehost`);
    const orbitClient = await connect(`${url}/mcp/orbit`);

    expect((await codehost.listTools()).tools.map((tool) => tool.name).sort()).toEqual(["permalink", "recent_changes"]);
    expect((await orbitClient.listTools()).tools.map((tool) => tool.name).sort()).toEqual(["orbit_context", "orbit_query", "orbit_schema"]);
    await codehost.close();
    await orbitClient.close();
  });

  it("answers 404 on the push route when the run has no push target", async () => {
    const { url } = await start({ ...spec, push: null });

    const response = await fetch(`${url}/mcp/push`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });

    expect(response.status).toBe(404);
  });

  it("finishes the run with the work report", async () => {
    const { url } = await start(spec);

    const response = await fetch(`${url}/finish`, { method: "POST" });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(work);
  });

  it("attaches the result's media and answers with what it attached", async () => {
    const { url } = await start(spec);
    const media = [{ path: "a.png", caption: "After" }];

    const response = await fetch(`${url}/media`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ media }) });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(uploads);
    expect(attached).toEqual([media]);
  });

  it("answers 400 to a media body that is not { media }, and 404 when it cannot attach media", async () => {
    const { url } = await start(spec);
    expect((await fetch(`${url}/media`, { method: "POST", body: JSON.stringify({ files: ["a.png"] }) })).status).toBe(400);
    expect((await fetch(`${url}/media`, { method: "GET" })).status).toBe(405);
    expect(attached).toEqual([]);
    await server?.close();

    const without = await start(spec, { media: false });
    expect((await fetch(`${without.url}/media`, { method: "POST", body: JSON.stringify({ media: [] }) })).status).toBe(404);
  });

  it("refuses a request with a foreign Host or any Origin, on /finish and the MCP routes alike", async () => {
    const { url } = await start(spec);
    const port = new URL(url).port;
    const mcp = { "content-type": "application/json", accept: "application/json, text/event-stream" };
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });

    for (const headers of [{ host: `rebound.example:${port}` }, { host: "127.0.0.1:1" }, { origin: "http://rebound.example" }, { origin: "null" }]) {
      expect(await post(`${url}/finish`, headers)).toBe(403);
      expect(await post(`${url}/media`, headers, JSON.stringify({ media: [] }))).toBe(403);
      expect(await post(`${url}/mcp/orbit`, { ...mcp, ...headers }, body)).toBe(403);
    }
    expect(await post(`${url}/finish`, { host: `localhost:${port}` })).toBe(200);
  });

  it("listens on 127.0.0.1 only", () => {
    expect(parseListen("127.0.0.1:4181")).toEqual({ host: "127.0.0.1", port: 4181 });
    expect(() => parseListen("0.0.0.0:4181")).toThrow("127.0.0.1");
    expect(() => parseListen("127.0.0.1")).toThrow();
  });
});
