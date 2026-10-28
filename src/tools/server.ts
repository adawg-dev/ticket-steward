import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { CODEHOST_SERVER_INFO, registerCodeHostTools } from "../codehost/server.js";
import type { CodeHost } from "../codehost/types.js";
import { errorMessage } from "../core/workspace.js";
import { logger } from "../log.js";
import { ORBIT_SERVER_INFO, registerOrbitTools, type OrbitRemote } from "../orbit/server.js";
import { PUSH_SERVER_INFO, registerPushTool, serialPushes, type PushTool } from "../push/server.js";
import type { PushTarget } from "../push/target.js";
import type { RunSpec, WorkReport } from "../run/protocol.js";

/** The only address the sidecar binds: the pod's loopback, which the agent container shares and nothing outside does. */
export const TOOLS_HOST = "127.0.0.1";
export const TOOLS_PORT = 4181;

/** One MCP server per route, built for each request (stateless Streamable HTTP); state shared across requests lives in the closures. */
export type ToolRoutes = Record<string, { info: { name: string; version: string }; register: (server: McpServer) => void }>;

/**
 * The run's routes: the code host and Orbit always, the push tool only when the run may push. Pushes are queued once here,
 * so calls on different requests still run one at a time.
 */
export const toolRoutes = (p: { spec: RunSpec; codehost: CodeHost; orbit: OrbitRemote; push: (target: PushTarget) => PushTool }): ToolRoutes => {
  const routes: ToolRoutes = {
    codehost: { info: CODEHOST_SERVER_INFO, register: (server) => registerCodeHostTools(server, { codehost: p.codehost, worktreePath: p.spec.worktreePath, sha: p.spec.checkout.sha }) },
    orbit: { info: ORBIT_SERVER_INFO, register: (server) => registerOrbitTools(server, p.orbit) },
  };
  if (p.spec.push !== null) {
    const push = serialPushes(p.push(p.spec.push));
    routes.push = { info: PUSH_SERVER_INFO, register: (server) => registerPushTool(server, push) };
  }
  return routes;
};

/** `--listen`: `127.0.0.1:<port>`, and nothing else, so the credentials behind a sidecar never answer off the pod. */
export const parseListen = (value: string, sidecar = "the tools sidecar"): { host: string; port: number } => {
  const match = /^(.+):(\d{1,5})$/.exec(value);
  if (match === null) throw new Error(`--listen must be ${TOOLS_HOST}:<port>, got ${value}`);
  const [, host = "", port = ""] = match;
  if (host !== TOOLS_HOST) throw new Error(`${sidecar} listens on ${TOOLS_HOST} only, not ${host}`);
  const parsed = Number(port);
  if (parsed < 1 || parsed > 65_535) throw new Error(`--listen port ${port} is out of range`);
  return { host, port: parsed };
};

export interface ToolsServer {
  url: string;
  close(): Promise<void>;
}

const MCP_PREFIX = "/mcp/";

const answer = (res: ServerResponse, status: number, body: unknown): void => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

const serveMcp = async (route: ToolRoutes[string], req: IncomingMessage, res: ServerResponse): Promise<void> => {
  const server = new McpServer(route.info);
  route.register(server);
  // Stateless: no session id, one transport per request.
  const transport = new StreamableHTTPServerTransport();
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  // The SDK types its callbacks `T | undefined` where Transport has them optional; they differ under exactOptionalPropertyTypes only.
  await server.connect(transport as Transport);
  await transport.handleRequest(req, res);
};

/**
 * Only the pod's own processes may call the sidecar, by its loopback address. A page the agent's browser opens shares that
 * loopback through the egress sidecar, so binding to 127.0.0.1 is not enough: a DNS-rebound name or a page's request
 * reaches the port too. Such requests carry a foreign Host or an Origin; the runner and the agent's MCP client send neither.
 */
export const fromThePod = (req: IncomingMessage, port: number): boolean =>
  req.headers.origin === undefined && (req.headers.host === `${TOOLS_HOST}:${port}` || req.headers.host === `localhost:${port}`);

/**
 * Serves the run's MCP routes at `/mcp/<name>` over Streamable HTTP, and `POST /finish`, which returns the run's work
 * report once `finish` has computed and delivered it. A request with a foreign Host or any Origin is 403, anything else 404. Errors never carry a credential: the tools
 * mask theirs, and `finish` reports git's scrubbed messages.
 */
export const startToolsServer = async (p: { listen: { host: string; port: number }; routes: ToolRoutes; finish: () => Promise<WorkReport> }): Promise<ToolsServer> => {
  let port = 0;
  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (!fromThePod(req, port)) return answer(res, 403, { error: "the tools sidecar answers the pod's loopback only" });
    const path = new URL(req.url ?? "/", "http://tools").pathname;
    if (path === "/finish") {
      if (req.method !== "POST") return answer(res, 405, { error: "POST only" });
      try {
        return answer(res, 200, await p.finish());
      } catch (err) {
        return answer(res, 502, { error: errorMessage(err) });
      }
    }
    const route = path.startsWith(MCP_PREFIX) && Object.hasOwn(p.routes, path.slice(MCP_PREFIX.length)) ? p.routes[path.slice(MCP_PREFIX.length)] : undefined;
    if (route === undefined) return answer(res, 404, { error: `no route ${path}` });
    // Stateless: no standalone server-to-client stream and no session to delete.
    if (req.method !== "POST") return answer(res, 405, { error: "POST only" });
    await serveMcp(route, req, res);
  };

  const server = createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      logger.warn({ err: errorMessage(err), url: req.url }, "tools sidecar request failed");
      if (!res.headersSent) answer(res, 500, { error: "the tools sidecar failed" });
      else res.end();
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
