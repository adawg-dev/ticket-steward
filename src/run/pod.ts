import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { connect, type AddressInfo } from "node:net";
import { z } from "zod";
import { buildWorkspaceEnv } from "../brain/env.js";
import type { runBrainDetached } from "../brain/spawn.js";
import { INTERRUPTED_ERROR, type McpServerSpec } from "../brain/types.js";
import type { BrainConfig } from "../config/schema.js";
import { Redactor } from "../core/redact.js";
import { errorMessage, MINUTE_MS, playwrightMcpSpec, SETUP_TAIL_BYTES } from "../core/workspace.js";
import { KEYPROXY_DUMMY_TOKEN, KEYPROXY_HOST, KEYPROXY_PORT } from "../keyproxy/server.js";
import { logger } from "../log.js";
import { SESSIONS_CONFIG_DIR } from "../sessions/store.js";
import { fromThePod, TOOLS_HOST, TOOLS_PORT } from "../tools/server.js";
import { git, gitOrThrow } from "../workspace/git.js";
import { splitCredentials } from "../workspace/mirror.js";
import { copyOverlay } from "../workspace/overlay.js";
import { Mutex } from "../workspace/mutex.js";
import { runSetup } from "../workspace/setup.js";
import { copySkills } from "../workspace/skills.js";
import { CALLBACK_REQUEST_TIMEOUT_MS, postCallback, REPORT_RETRY_MS } from "./callback.js";
import { executeRun } from "./execute.js";
import { RunReportSchema, type RunReport, type RunSpec } from "./protocol.js";

/**
 * The run pod's fixed layout, as the agent container sees it. Every sidecar answers on the pod's loopback; the agent
 * container reaches them there and holds none of their credentials.
 */
export const POD_PORTS = { keyproxy: KEYPROXY_PORT, tools: TOOLS_PORT, egress: 4182, checks: 4183, app: 3000, postgres: 5432, redis: 6379, rabbitmq: 5672 } as const;

/** Where egress puts its CA certificate (only the certificate); the agent may trust it, never write to it. */
export const EGRESS_CA_DIR = "/run/egress-ca";
export const EGRESS_CA_FILE = `${EGRESS_CA_DIR}/ca.pem`;
/** The rendered overlay (placeholders only), mounted read-only from render-overlay's volume. */
export const POD_OVERLAY_DIR = "/run/steward/overlay";
export const TOOLS_URL = `http://${TOOLS_HOST}:${POD_PORTS.tools}`;
/** What the agent may neither read nor write in a run pod. Its credentials are elsewhere: in containers it cannot reach. */
export const POD_DENY_PATHS = [EGRESS_CA_DIR];
/** The ports run-pod waits on before the run: keyproxy, tools, egress and the run's services. */
export const POD_WAIT_PORTS = [POD_PORTS.keyproxy, POD_PORTS.tools, POD_PORTS.egress, POD_PORTS.postgres, POD_PORTS.redis, POD_PORTS.rabbitmq];
export const POD_WAIT_TIMEOUT_MS = 120_000;

/** What the sessions-sync sidecar gets for its last push once the agent container has exited. */
export const SESSION_FINAL_PUSH_MS = 2 * MINUTE_MS;

/** The checks server's budget for one batch: the configured checks timeout plus a minute. */
export const podChecksTimeoutMs = (checksTimeoutMinutes: number): number => (checksTimeoutMinutes + 1) * MINUTE_MS;

/** The tools sidecar's budget to finish (a push's checks in flight, then the work report). */
const finishToolsMs = (checksTimeoutMs: number): number => checksTimeoutMs + REPORT_RETRY_MS + 2 * CALLBACK_REQUEST_TIMEOUT_MS;

/**
 * The most a run pod needs after SIGTERM: finish the tools, post the run report, then the sessions' last push. The Job's
 * grace period, so the kubelet does not kill sessions-sync before it uploads.
 */
export const podShutdownBudgetMs = (checksTimeoutMinutes: number): number =>
  finishToolsMs(podChecksTimeoutMs(checksTimeoutMinutes)) + REPORT_RETRY_MS + SESSION_FINAL_PUSH_MS;

const LOOPBACK = "127.0.0.1";
const egressUrl = `http://${LOOPBACK}:${POD_PORTS.egress}`;

/**
 * The env of setup, the checks and the app in a run pod: the workspace env on the pod's app port, with every HTTP(S)
 * request through the egress sidecar (both spellings: curl reads only the lower-case one) and its CA trusted by Node,
 * OpenSSL and Python's requests.
 */
export const buildPodWorkspaceEnv = (p: { caFile?: string } = {}): Record<string, string> => {
  const caFile = p.caFile ?? EGRESS_CA_FILE;
  const noProxy = `${LOOPBACK},localhost`;
  return {
    ...buildWorkspaceEnv(POD_PORTS.app),
    HTTPS_PROXY: egressUrl,
    HTTP_PROXY: egressUrl,
    NO_PROXY: noProxy,
    https_proxy: egressUrl,
    http_proxy: egressUrl,
    no_proxy: noProxy,
    NODE_EXTRA_CA_CERTS: caFile,
    SSL_CERT_FILE: caFile,
    REQUESTS_CA_BUNDLE: caFile,
  };
};

/**
 * The brain's env in a run pod: the pod's workspace env, the model through keyproxy with its dummy token (keyproxy puts
 * the real credential on), the session store at its fixed path, and with `author` the identity its commits carry.
 */
export const buildPodBrainEnv = (p: { caFile?: string; author?: { name: string; email: string } } = {}): Record<string, string> => ({
  ...buildPodWorkspaceEnv(p.caFile === undefined ? {} : { caFile: p.caFile }),
  ANTHROPIC_BASE_URL: `http://${KEYPROXY_HOST}:${POD_PORTS.keyproxy}`,
  ANTHROPIC_AUTH_TOKEN: KEYPROXY_DUMMY_TOKEN,
  CLAUDE_CONFIG_DIR: SESSIONS_CONFIG_DIR,
  ...(p.author === undefined
    ? {}
    : { GIT_AUTHOR_NAME: p.author.name, GIT_AUTHOR_EMAIL: p.author.email, GIT_COMMITTER_NAME: p.author.name, GIT_COMMITTER_EMAIL: p.author.email }),
});

/** The steward's MCP servers on the tools sidecar (push only when the run may push), and Playwright in the agent's own container. */
export const podMcpServers = (spec: RunSpec, toolsUrl: string = TOOLS_URL): Record<string, McpServerSpec> => {
  const base = toolsUrl.replace(/\/+$/, "");
  const http = (name: string): McpServerSpec => ({ type: "http", url: `${base}/mcp/${name}` });
  return {
    codehost: http("codehost"),
    playwright: playwrightMcpSpec(),
    orbit: http("orbit"),
    ...(spec.push === null ? {} : { push: http("push") }),
  };
};

const portOpen = (port: number): Promise<boolean> =>
  new Promise((resolve) => {
    const socket = connect({ host: LOOPBACK, port });
    const done = (open: boolean): void => {
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(1_000, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });

/**
 * Waits until egress has published its CA and every port accepts a connection: the sidecars start alongside the agent
 * container, with no ordering between them. Throws naming what was still missing at the limit.
 */
export const waitForPod = async (p: { caFile: string; ports: number[]; timeoutMs: number; intervalMs?: number }): Promise<void> => {
  const deadline = Date.now() + p.timeoutMs;
  for (;;) {
    const closed = (await Promise.all(p.ports.map(async (port) => ((await portOpen(port)) ? null : `port ${port}`)))).filter((port) => port !== null);
    const missing = [...(existsSync(p.caFile) ? [] : [p.caFile]), ...closed];
    if (missing.length === 0) return;
    if (Date.now() >= deadline) throw new Error(`the run pod was not ready after ${p.timeoutMs / 1000} s: ${missing.join(", ")}`);
    await new Promise((resolve) => setTimeout(resolve, p.intervalMs ?? 500));
  }
};

/** Lays the rendered overlay (placeholders only) and the steward's skills into the cloned worktree. */
export const furnishPodWorktree = async (p: { worktreePath: string; overlayDir: string; skillsDir: string | undefined }): Promise<void> => {
  if (existsSync(p.overlayDir)) await copyOverlay(p.overlayDir, p.worktreePath, {});
  await copySkills(p.skillsDir, p.worktreePath);
};

export interface ChecksServer {
  url: string;
  close(): Promise<void>;
}

const ChecksRequest = z.object({ commands: z.array(z.string()) });
const MAX_CHECKS_BODY_BYTES = 1024 * 1024;

const answer = (res: ServerResponse, status: number, body: unknown): void => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

const readBody = (req: IncomingMessage): Promise<string> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_CHECKS_BODY_BYTES) req.destroy(new Error("the request body is too large"));
      else chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });

/**
 * The agent container's check endpoint for the tools sidecar's push: `POST /checks` with `{ commands }` runs them in the
 * worktree with the workspace env, one request at a time, and answers `{ ok, tail }`. Like the tools sidecar it answers
 * the pod's loopback only (no foreign Host, no Origin), so a page in the agent's browser cannot call it.
 */
export const startChecksServer = async (p: { listen: { host: string; port: number }; worktreePath: string; env: Record<string, string>; timeoutMs: number }): Promise<ChecksServer> => {
  let port = 0;
  const serial = new Mutex();
  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (!fromThePod(req, port)) return answer(res, 403, { error: "the check endpoint answers the pod's loopback only" });
    if (new URL(req.url ?? "/", "http://checks").pathname !== "/checks") return answer(res, 404, { error: "no such route" });
    if (req.method !== "POST") return answer(res, 405, { error: "POST only" });
    let commands: string[];
    try {
      ({ commands } = ChecksRequest.parse(JSON.parse(await readBody(req))));
    } catch {
      return answer(res, 400, { error: "the body must be { commands: string[] }" });
    }
    const result = await serial.run(() => runSetup(commands, p.worktreePath, p.env, { timeoutMs: p.timeoutMs, tailBytes: SETUP_TAIL_BYTES }));
    answer(res, 200, result);
  };
  const server = createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      logger.warn({ err: errorMessage(err) }, "check endpoint request failed");
      if (!res.headersSent) answer(res, 500, { error: "the checks could not be run" });
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

/**
 * Asks the tools sidecar to compute the run's work report from git and deliver it to the dispatcher (`POST /finish`).
 * Its push tool may still be running a push for the agent, and it retries the delivery while the dispatcher is away,
 * so this waits as long as both may take.
 */
export const finishTools = async (p: { toolsUrl: string; fetchImpl: typeof fetch; timeoutMs: number }): Promise<void> => {
  const response = await p.fetchImpl(`${p.toolsUrl.replace(/\/+$/, "")}/finish`, { method: "POST", redirect: "error", signal: AbortSignal.timeout(p.timeoutMs) });
  if (!response.ok) throw new Error(`the tools sidecar answered ${response.status} to /finish`);
};

/**
 * Delivers the run's report to the dispatcher (`POST …/internal/runs/<runId>/report`) with the run's runner token,
 * retrying while the dispatcher is away (`postCallback`). A report lost here fails the Job, and the dispatcher requeues
 * the run.
 */
export const postReport = async (p: {
  callbackUrl: string;
  token: string;
  report: RunReport;
  fetchImpl: typeof fetch;
  retryForMs?: number;
  backoffMs?: { first: number; max: number };
  warn?: (message: string) => void;
}): Promise<void> => {
  const { callbackUrl, report, ...rest } = p;
  await postCallback({
    ...rest,
    url: `${callbackUrl.replace(/\/+$/, "")}/internal/runs/${encodeURIComponent(report.runId)}/report`,
    body: JSON.stringify(RunReportSchema.parse(report)),
    what: "run report",
    tokenName: "runner",
  });
};

/**
 * Leaves no credential in the clone's config: every `http.*.extraHeader` removed and origin set to `url` (without
 * credentials). Git reads only the repo's own file here; the global and system configs are not the clone's.
 */
export const scrubRemoteCredentials = async (repoPath: string, url: string): Promise<void> => {
  const headers = await git(["config", "--local", "--name-only", "--get-regexp", "^http\\..*extraheader$"], repoPath);
  // Exit 1: no such key.
  for (const name of new Set(headers.stdout.split("\n").filter((line) => line !== ""))) {
    await gitOrThrow(["config", "--local", "--unset-all", name], repoPath);
  }
  await gitOrThrow(["config", "--local", "remote.origin.url", url], repoPath);
};

/**
 * The run's worktree, cloned fresh at the spec's commit: the ticket branch fetched as well when it is pushed. The
 * credential goes to each git process as an env-supplied header, never into `.git`; afterwards the config is scrubbed
 * anyway, origin carries no credential, and pushes from the worktree go nowhere (the tools sidecar pushes).
 */
export const gitInit = async (p: { spec: Pick<RunSpec, "worktreePath" | "checkout">; fetchUrl: string }): Promise<void> => {
  const remote = splitCredentials(p.fetchUrl);
  const path = p.spec.worktreePath;
  await mkdir(path, { recursive: true });
  try {
    await gitOrThrow(["clone", "--quiet", "--no-checkout", remote.url, path], undefined, remote.env);
    const { ref } = p.spec.checkout;
    if (ref !== null) await gitOrThrow(["fetch", "--quiet", "--no-tags", "origin", `+refs/heads/${ref}:refs/remotes/origin/${ref}`], path, remote.env);
    const present = await git(["cat-file", "-e", `${p.spec.checkout.sha}^{commit}`], path);
    // Neither the default branches nor the ticket branch has it: ask for the commit itself.
    if (present.exitCode !== 0) await gitOrThrow(["fetch", "--quiet", "--no-tags", "origin", p.spec.checkout.sha], path, remote.env);
    await gitOrThrow(["checkout", "--quiet", "--detach", p.spec.checkout.sha], path);
  } finally {
    if (existsSync(`${path}/.git`)) await scrubRemoteCredentials(path, remote.url);
  }
  await gitOrThrow(["config", "--local", "remote.origin.pushurl", "/dev/null"], path);
};

/** What `runPod` needs beyond the spec: the brain's config and where the pod's parts are (fixed, but tests move them). */
export interface PodRun {
  spec: RunSpec;
  brain: BrainConfig;
  author?: { name: string; email: string };
  skillsDir: string | undefined;
  overlayDir: string;
  caFile: string;
  toolsUrl: string;
  waitPorts: number[];
  waitTimeoutMs: number;
  checksListen: { host: string; port: number };
  checksTimeoutMs: number;
  callbackUrl: string;
  runnerToken: string;
  fetchImpl: typeof fetch;
  /** Problems after the run that do not change its report (the tools sidecar's finish, a report attempt that failed). */
  warn: (message: string) => void;
  signal?: AbortSignal;
  runBrain?: typeof runBrainDetached;
}

const failedReport = (spec: RunSpec, error: string): RunReport => ({
  runId: spec.runId, ok: false, error, interrupted: false, setupFailed: false, sessionId: null, output: null, usage: null,
});

/**
 * The agent container's run: waits for the sidecars, lays the overlay into the worktree that git-init cloned, serves the
 * check endpoint, runs `executeRun` with the pod's env and MCP servers, then has the tools sidecar post the work report
 * and posts the run report itself, retrying while the dispatcher is away. Rejects only when the report could not be
 * delivered.
 */
export const runPod = async (p: PodRun): Promise<RunReport> => {
  const { spec } = p;
  let report: RunReport;
  let checks: ChecksServer | null = null;
  try {
    await waitForPod({ caFile: p.caFile, ports: p.waitPorts, timeoutMs: p.waitTimeoutMs });
    await mkdir(spec.artifactsDir, { recursive: true, mode: 0o700 });
    await furnishPodWorktree({ worktreePath: spec.worktreePath, overlayDir: p.overlayDir, skillsDir: p.skillsDir });
    checks = await startChecksServer({ listen: p.checksListen, worktreePath: spec.worktreePath, env: buildPodWorkspaceEnv({ caFile: p.caFile }), timeoutMs: p.checksTimeoutMs });
    const sha = await gitOrThrow(["rev-parse", "HEAD"], spec.worktreePath);
    report = await executeRun(spec, {
      workspace: { path: spec.worktreePath, sha },
      brain: p.brain,
      brainEnv: buildPodBrainEnv({ caFile: p.caFile, ...(p.author === undefined ? {} : { author: p.author }) }),
      mcpServers: podMcpServers(spec, p.toolsUrl),
      denyPaths: POD_DENY_PATHS,
      // The agent container holds no secret to mask; placeholders are not secrets.
      redactor: new Redactor([]),
      ...(p.signal === undefined ? {} : { signal: p.signal }),
      ...(p.runBrain === undefined ? {} : { runBrain: p.runBrain }),
    });
  } catch (err) {
    report = p.signal?.aborted === true ? { ...failedReport(spec, INTERRUPTED_ERROR), interrupted: true } : failedReport(spec, errorMessage(err));
  }
  try {
    await finishTools({ toolsUrl: p.toolsUrl, fetchImpl: p.fetchImpl, timeoutMs: finishToolsMs(p.checksTimeoutMs) });
  } catch (err) {
    p.warn(`the tools sidecar did not finish the run: ${errorMessage(err)}`);
  } finally {
    await checks?.close();
  }
  await postReport({ callbackUrl: p.callbackUrl, token: p.runnerToken, report, fetchImpl: p.fetchImpl, warn: p.warn });
  return report;
};
