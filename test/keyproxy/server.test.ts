import { createServer, request, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { KEYPROXY_DUMMY_TOKEN, modelUpstream, startKeyproxy, streamRedactor, type KeyproxyServer, type ModelUpstream } from "../../src/keyproxy/server.js";

const REAL = "sk-ant-real-0123456789abcdef";

interface Seen {
  method: string;
  url: string;
  headers: IncomingMessage["headers"];
  body: string;
}

let upstream: Server | null = null;
let proxy: KeyproxyServer | null = null;
let elsewhere: Server | null = null;

/** A fake model API: records each request and answers with `respond`. */
const startUpstream = async (respond: (req: IncomingMessage, res: ServerResponse) => void, prefix = ""): Promise<{ baseUrl: string; seen: Seen[] }> => {
  const seen: Seen[] = [];
  upstream = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      seen.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body: Buffer.concat(chunks).toString("utf8") });
      respond(req, res);
    });
  });
  await new Promise<void>((resolve) => upstream?.listen(0, "127.0.0.1", resolve));
  const { port } = upstream.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${port}${prefix}`, seen };
};

const startProxy = async (target: ModelUpstream): Promise<string> => {
  proxy = await startKeyproxy({ listen: { host: "127.0.0.1", port: 0 }, upstream: target });
  return proxy.url;
};

const ok = (_req: IncomingMessage, res: ServerResponse): void => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end('{"ok":true}');
};

/** The agent's request, as Claude Code sends it with the dummy token. */
const agentHeaders = { authorization: `Bearer ${KEYPROXY_DUMMY_TOKEN}`, "x-api-key": KEYPROXY_DUMMY_TOKEN, "content-type": "application/json", "anthropic-version": "2023-06-01" };

/** A request with exactly these headers: fetch replaces a Host header with the URL's own. */
const send = (url: string, headers: Record<string, string>): Promise<number> =>
  new Promise((resolve, reject) => {
    const req = request(url, { method: "POST", headers }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("error", reject);
    req.end("{}");
  });

afterEach(async () => {
  await proxy?.close();
  proxy = null;
  for (const server of [upstream, elsewhere]) {
    server?.closeAllConnections();
    await new Promise<void>((resolve) => (server === null ? resolve() : server.close(() => resolve())));
  }
  upstream = null;
  elsewhere = null;
});

describe("keyproxy", () => {
  it("puts the real token on the upstream request in place of the agent's dummy", async () => {
    const { baseUrl, seen } = await startUpstream(ok, "/anthropic");
    const url = await startProxy({ baseUrl, credential: { kind: "auth-token", value: REAL } });

    const response = await fetch(`${url}/v1/messages?beta=true`, { method: "POST", headers: agentHeaders, body: '{"model":"m"}' });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ method: "POST", url: "/anthropic/v1/messages?beta=true", body: '{"model":"m"}' });
    expect(seen[0]?.headers.authorization).toBe(`Bearer ${REAL}`);
    expect(seen[0]?.headers["x-api-key"]).toBeUndefined();
    expect(seen[0]?.headers["anthropic-version"]).toBe("2023-06-01");
    expect(JSON.stringify(seen[0]?.headers)).not.toContain(KEYPROXY_DUMMY_TOKEN);
  });

  it("sends an API key as x-api-key, and an OAuth token as a bearer with the OAuth beta", async () => {
    const { baseUrl, seen } = await startUpstream(ok);
    let url = await startProxy({ baseUrl, credential: { kind: "api-key", value: REAL } });
    await fetch(`${url}/v1/models`, { headers: agentHeaders });
    await proxy?.close();
    url = await startProxy({ baseUrl, credential: { kind: "oauth", value: REAL } });
    await fetch(`${url}/v1/messages`, { method: "POST", headers: { ...agentHeaders, "anthropic-beta": "fine-grained-tool-streaming-2025-05-14" }, body: "{}" });

    expect(seen[0]?.method).toBe("GET");
    expect(seen[0]?.headers["x-api-key"]).toBe(REAL);
    expect(seen[0]?.headers.authorization).toBeUndefined();
    expect(seen[1]?.headers.authorization).toBe(`Bearer ${REAL}`);
    expect(seen[1]?.headers["x-api-key"]).toBeUndefined();
    expect(seen[1]?.headers["anthropic-beta"]).toBe("fine-grained-tool-streaming-2025-05-14,oauth-2025-04-20");
  });

  it("answers 404 off /v1/, including a path that climbs out of it, and never reaches the upstream", async () => {
    const { baseUrl, seen } = await startUpstream(ok);
    const url = await startProxy({ baseUrl, credential: { kind: "auth-token", value: REAL } });

    for (const path of ["/admin", "/", "/v1", "/v1/../admin", "/v1/%2e%2e/admin", "/v10/messages"]) {
      const status = await new Promise<number>((resolve, reject) => {
        // fetch would normalise the dot segments before sending; send the raw path.
        const req = request(`${url}/`, { method: "GET", path, headers: agentHeaders }, (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        });
        req.on("error", reject);
        req.end();
      });
      expect([path, status]).toEqual([path, 404]);
    }
    expect((await fetch(`${url}/v1/messages`, { method: "DELETE", headers: agentHeaders })).status).toBe(405);
    expect(seen).toEqual([]);
  });

  it("refuses a request with a foreign Host or any Origin", async () => {
    const { baseUrl, seen } = await startUpstream(ok);
    const url = await startProxy({ baseUrl, credential: { kind: "auth-token", value: REAL } });
    const port = new URL(url).port;

    for (const headers of [{ host: `rebound.example:${port}` }, { origin: "http://rebound.example" }]) {
      expect(await send(`${url}/v1/messages`, { ...agentHeaders, ...headers })).toBe(403);
    }
    expect(await send(`${url}/v1/messages`, { ...agentHeaders, host: `localhost:${port}` })).toBe(200);
    expect(seen).toHaveLength(1);
  });

  it("streams an SSE response unbuffered", async () => {
    let secondWritten = false;
    const { baseUrl } = await startUpstream((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("event: message_start\ndata: {}\n\n");
      setTimeout(() => {
        secondWritten = true;
        res.end("event: message_stop\ndata: {}\n\n");
      }, 500);
    });
    const url = await startProxy({ baseUrl, credential: { kind: "auth-token", value: REAL } });

    const response = await fetch(`${url}/v1/messages`, { method: "POST", headers: agentHeaders, body: '{"stream":true}' });
    const reader = response.body?.getReader();
    if (reader === undefined) throw new Error("no body");
    const first = await reader.read();

    expect(new TextDecoder().decode(first.value)).toBe("event: message_start\ndata: {}\n\n");
    expect(secondWritten).toBe(false);
    let rest = "";
    for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) rest += new TextDecoder().decode(chunk.value);
    expect(rest).toBe("event: message_stop\ndata: {}\n\n");
  });

  it("masks the real token when the upstream echoes it back, even split across chunks", async () => {
    const { baseUrl } = await startUpstream((req, res) => {
      if (req.url === "/v1/split") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(`data: ${REAL.slice(0, 10)}`);
        setTimeout(() => res.end(`${REAL.slice(10)} end\n\n`), 50);
        return;
      }
      res.writeHead(401, { "content-type": "application/json", "x-echo": REAL });
      res.end(JSON.stringify({ type: "error", error: { type: "authentication_error", message: `invalid x-api-key ${REAL}` } }));
    });
    const url = await startProxy({ baseUrl, credential: { kind: "api-key", value: REAL } });

    const rejected = await fetch(`${url}/v1/messages`, { method: "POST", headers: agentHeaders, body: "{}" });
    const body = await rejected.text();
    const split = await (await fetch(`${url}/v1/split`, { method: "POST", headers: agentHeaders, body: "{}" })).text();

    expect(rejected.status).toBe(401);
    expect(body).toContain("invalid x-api-key ***");
    expect(body).not.toContain(REAL);
    expect(rejected.headers.get("x-echo")).toBe("***");
    expect(split).toBe("data: *** end\n\n");
  });

  it("returns a redirect to the agent and never follows it", async () => {
    let followed = false;
    elsewhere = createServer((_req, res) => {
      followed = true;
      res.end("followed");
    });
    await new Promise<void>((resolve) => elsewhere?.listen(0, "127.0.0.1", resolve));
    const { port } = elsewhere.address() as AddressInfo;
    const { baseUrl } = await startUpstream((_req, res) => {
      res.writeHead(307, { location: `http://localhost:${port}/v1/messages` });
      res.end();
    });
    const url = await startProxy({ baseUrl, credential: { kind: "auth-token", value: REAL } });

    const response = await fetch(`${url}/v1/messages`, { method: "POST", headers: agentHeaders, body: "{}", redirect: "manual" });

    expect(response.status).toBe(307);
    expect(followed).toBe(false);
  });

  it("answers 502 without the token when the upstream cannot be reached", async () => {
    const url = await startProxy({ baseUrl: "http://127.0.0.1:1", credential: { kind: "auth-token", value: REAL } });

    const response = await fetch(`${url}/v1/messages`, { method: "POST", headers: agentHeaders, body: "{}" });

    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain(REAL);
  });
});

describe("modelUpstream", () => {
  it("takes the base URL and the first credential the brain would use", () => {
    expect(modelUpstream({ ANTHROPIC_BASE_URL: "https://gateway.example/anthropic", ANTHROPIC_AUTH_TOKEN: "t", CLAUDE_CODE_OAUTH_TOKEN: "o" })).toEqual({
      baseUrl: "https://gateway.example/anthropic",
      credential: { kind: "auth-token", value: "t" },
    });
    expect(modelUpstream({ ANTHROPIC_API_KEY: "k", ANTHROPIC_AUTH_TOKEN: "t" })).toEqual({ baseUrl: "https://api.anthropic.com", credential: { kind: "api-key", value: "k" } });
    expect(modelUpstream({ CLAUDE_CODE_OAUTH_TOKEN: "o" }).credential).toEqual({ kind: "oauth", value: "o" });
  });

  it("refuses no credential and a base URL that is not http(s)", () => {
    expect(() => modelUpstream({ ANTHROPIC_AUTH_TOKEN: "" })).toThrow("ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN or CLAUDE_CODE_OAUTH_TOKEN");
    expect(() => modelUpstream({ ANTHROPIC_BASE_URL: "file:///etc/passwd", ANTHROPIC_AUTH_TOKEN: "t" })).toThrow("ANTHROPIC_BASE_URL");
  });
});

describe("streamRedactor", () => {
  it("masks the secret across chunk boundaries and holds back only a possible start of it", () => {
    const redactor = streamRedactor("secret");
    const out = [redactor.push(Buffer.from("a sec")), redactor.push(Buffer.from("ret b sesame s")), redactor.push(Buffer.from("ecret")), redactor.end()];

    expect(out.map((chunk) => chunk.toString())).toEqual(["a ", "*** b sesame ", "***", ""]);
    expect(streamRedactor("secret").push(Buffer.from("data: x\n\n")).toString()).toBe("data: x\n\n");
    const tail = streamRedactor("secret");
    expect(tail.push(Buffer.from("x se")).toString()).toBe("x ");
    expect(tail.end().toString()).toBe("se");
  });
});
