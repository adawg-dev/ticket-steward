import { createServer, type IncomingMessage, type OutgoingHttpHeaders, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Secrets } from "../config/load.js";
import { errorMessage } from "../core/workspace.js";
import { logger } from "../log.js";
import { fromThePod } from "../tools/server.js";

export const KEYPROXY_HOST = "127.0.0.1";
export const KEYPROXY_PORT = 4180;
/** The agent's `ANTHROPIC_AUTH_TOKEN`: Claude Code needs some credential to start, and keyproxy discards whatever it sends. */
export const KEYPROXY_DUMMY_TOKEN = "steward-keyproxy";

const DEFAULT_BASE_URL = "https://api.anthropic.com";
/** Claude Code adds this beta itself when it holds the OAuth token; the agent holds the dummy, so keyproxy adds it. */
const OAUTH_BETA = "oauth-2025-04-20";
const MASK = "***";

/** The model credential, in the env name's form: an API key goes as `x-api-key`, the others as a bearer. */
export type ModelCredential = { kind: "api-key" | "auth-token" | "oauth"; value: string };
export interface ModelUpstream {
  baseUrl: string;
  credential: ModelCredential;
}

const present = (value: string | undefined): value is string => value !== undefined && value !== "";

/** The secrets `modelUpstream` reads; the keyproxy sidecar loads these and no other. */
export const MODEL_SECRET_NAMES = ["ANTHROPIC_BASE_URL", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"] as const;

/** The upstream and the credential the claude-code brain would use from these secrets, in its order. */
export const modelUpstream = (secrets: Secrets): ModelUpstream => {
  const baseUrl = present(secrets.ANTHROPIC_BASE_URL) ? secrets.ANTHROPIC_BASE_URL : DEFAULT_BASE_URL;
  let protocol: string;
  try {
    ({ protocol } = new URL(baseUrl));
  } catch {
    throw new Error("ANTHROPIC_BASE_URL is not a URL");
  }
  if (protocol !== "https:" && protocol !== "http:") throw new Error("ANTHROPIC_BASE_URL must be an http(s) URL");
  const credential: ModelCredential | null = present(secrets.ANTHROPIC_API_KEY)
    ? { kind: "api-key", value: secrets.ANTHROPIC_API_KEY }
    : present(secrets.ANTHROPIC_AUTH_TOKEN)
      ? { kind: "auth-token", value: secrets.ANTHROPIC_AUTH_TOKEN }
      : present(secrets.CLAUDE_CODE_OAUTH_TOKEN)
        ? { kind: "oauth", value: secrets.CLAUDE_CODE_OAUTH_TOKEN }
        : null;
  if (credential === null) throw new Error("keyproxy needs one of ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN or CLAUDE_CODE_OAUTH_TOKEN");
  return { baseUrl, credential };
};

/**
 * Masks `secret` in a byte stream. A chunk's tail that could be the start of the secret is held for the next chunk, and
 * nothing else is, so an SSE event that ends in a blank line goes out at once.
 */
export const streamRedactor = (secret: string): { push(chunk: Buffer): Buffer; end(): Buffer } => {
  const needle = Buffer.from(secret);
  const mask = Buffer.from(MASK);
  let held = Buffer.alloc(0);
  return {
    push: (chunk) => {
      let rest = Buffer.concat([held, chunk]);
      const out: Buffer[] = [];
      for (let at = rest.indexOf(needle); at !== -1; at = rest.indexOf(needle)) {
        out.push(rest.subarray(0, at), mask);
        rest = rest.subarray(at + needle.length);
      }
      let keep = Math.min(needle.length - 1, rest.length);
      while (keep > 0 && !rest.subarray(rest.length - keep).equals(needle.subarray(0, keep))) keep -= 1;
      out.push(rest.subarray(0, rest.length - keep));
      held = Buffer.from(rest.subarray(rest.length - keep));
      return Buffer.concat(out);
    },
    end: () => {
      const tail = held;
      held = Buffer.alloc(0);
      return tail;
    },
  };
};

/**
 * Headers keyproxy never passes upstream: the agent's credentials, the hop-by-hop ones, and the ones fetch sets itself.
 * `accept-encoding` goes too: fetch asks for and decodes compression itself, so the body keyproxy masks is plain.
 */
const DROPPED_REQUEST = new Set([
  "authorization",
  "x-api-key",
  "proxy-authorization",
  "cookie",
  "host",
  "connection",
  "keep-alive",
  "proxy-connection",
  "transfer-encoding",
  "te",
  "trailer",
  "upgrade",
  "expect",
  "content-length",
  "accept-encoding",
  "origin",
]);
/** fetch has already decoded the body, so its length and encoding no longer describe what the agent gets. */
const DROPPED_RESPONSE = new Set(["connection", "keep-alive", "transfer-encoding", "content-encoding", "content-length", "set-cookie"]);

const upstreamHeaders = (incoming: IncomingMessage["headers"], credential: ModelCredential): Headers => {
  const headers = new Headers();
  for (const [name, value] of Object.entries(incoming)) {
    if (value === undefined || DROPPED_REQUEST.has(name)) continue;
    headers.set(name, Array.isArray(value) ? value.join(", ") : value);
  }
  if (credential.kind === "api-key") headers.set("x-api-key", credential.value);
  else headers.set("authorization", `Bearer ${credential.value}`);
  if (credential.kind === "oauth") {
    const betas = (headers.get("anthropic-beta") ?? "")
      .split(",")
      .map((beta) => beta.trim())
      .filter((beta) => beta !== "");
    if (!betas.includes(OAUTH_BETA)) headers.set("anthropic-beta", [...betas, OAUTH_BETA].join(","));
  }
  return headers;
};

/** The upstream URL for an agent's path, or null when the path is not under `/v1/` once its dot segments are resolved. */
const upstreamUrl = (baseUrl: string, rawPath: string): URL | null => {
  // Parsed against a fixed origin: an absolute-form request line names a host keyproxy ignores.
  const incoming = new URL(rawPath, "http://keyproxy");
  if (!incoming.pathname.startsWith("/v1/")) return null;
  const url = new URL(baseUrl);
  url.pathname = `${url.pathname.replace(/\/+$/, "")}${incoming.pathname}`;
  url.search = incoming.search;
  url.hash = "";
  return url;
};

const answer = (res: ServerResponse, status: number, message: string): void => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify({ type: "error", error: { type: "keyproxy_error", message } }));
};

const readBody = async (req: IncomingMessage): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  return Buffer.concat(chunks);
};

/** A write that waits for the socket to drain, so a slow agent slows the upstream read rather than filling memory. */
const write = (res: ServerResponse, chunk: Buffer): Promise<void> =>
  chunk.length === 0 || res.write(chunk) ? Promise.resolve() : new Promise((resolve) => res.once("drain", resolve).once("close", resolve));

export interface KeyproxyServer {
  url: string;
  close(): Promise<void>;
}

/**
 * The model credential sidecar. It forwards `GET`/`POST /v1/*` to the one configured upstream with the real credential in
 * place of whatever the agent sent, and streams the response back as it arrives, the credential masked wherever the
 * upstream echoes it. Any other path is 404, a foreign Host or any Origin 403 (as the tools sidecar), and a redirect goes
 * back to the agent unfollowed, so keyproxy never carries the credential to another host.
 */
export const startKeyproxy = async (p: { listen: { host: string; port: number }; upstream: ModelUpstream; fetchImpl?: typeof fetch }): Promise<KeyproxyServer> => {
  const fetchImpl = p.fetchImpl ?? fetch;
  const secret = p.upstream.credential.value;
  const redact = (text: string): string => text.replaceAll(secret, MASK);
  let port = 0;

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (!fromThePod(req, port)) return answer(res, 403, "keyproxy answers the pod's loopback only");
    const url = upstreamUrl(p.upstream.baseUrl, req.url ?? "/");
    if (url === null) return answer(res, 404, "keyproxy forwards /v1/ only");
    if (req.method !== "GET" && req.method !== "POST") return answer(res, 405, "GET and POST only");

    const abort = new AbortController();
    res.on("close", () => abort.abort());
    const body = req.method === "POST" ? await readBody(req) : null;
    let upstream: Response;
    try {
      upstream = await fetchImpl(url, { method: req.method, headers: upstreamHeaders(req.headers, p.upstream.credential), body, redirect: "manual", signal: abort.signal });
    } catch (err) {
      logger.warn({ err: redact(errorMessage(err)), path: url.pathname }, "keyproxy: upstream request failed");
      return answer(res, 502, "keyproxy could not reach the model upstream");
    }

    const headers: OutgoingHttpHeaders = {};
    upstream.headers.forEach((value, name) => {
      if (!DROPPED_RESPONSE.has(name)) headers[name] = redact(value);
    });
    res.writeHead(upstream.status, headers);
    res.flushHeaders();
    if (upstream.body === null) return void res.end();
    const redactor = streamRedactor(secret);
    const reader = upstream.body.getReader();
    try {
      for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) await write(res, redactor.push(Buffer.from(chunk.value)));
      res.end(redactor.end());
    } catch (err) {
      // The agent went away, or the upstream broke off mid-stream: either way there is no one left to answer.
      if (!abort.signal.aborted) logger.warn({ err: redact(errorMessage(err)), path: url.pathname }, "keyproxy: upstream stream failed");
      res.destroy();
    }
  };

  const server = createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      logger.warn({ err: redact(errorMessage(err)), url: req.url }, "keyproxy request failed");
      if (!res.headersSent) answer(res, 500, "keyproxy failed");
      else res.destroy();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(p.listen.port, p.listen.host, () => resolve());
  });
  ({ port } = server.address() as AddressInfo);
  return {
    url: `http://${p.listen.host}:${port}`,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
};
