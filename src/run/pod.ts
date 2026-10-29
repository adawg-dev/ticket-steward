import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { connect, type AddressInfo } from "node:net";
import { z } from "zod";
import { buildWorkspaceEnv } from "../brain/env.js";
import type { runBrainDetached } from "../brain/spawn.js";
import { INTERRUPTED_ERROR, type BrainControlSink, type McpServerSpec } from "../brain/types.js";
import { MediaItemSchema, rejectAll, MediaUploadsSchema, type MediaUploads } from "../codehost/media.js";
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
import { CALLBACK_REQUEST_TIMEOUT_MS, postCallback, REPORT_BACKOFF_MS, REPORT_RETRY_MS } from "./callback.js";
import { applyCommands, MAX_STEER_WAIT_MS, type RunCommand } from "./channel.js";
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
    playwright: playwrightMcpSpec(spec.artifactsDir),
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

/** How long the tools sidecar gets to check and upload the result's media (up to ten files of 25 MB). */
export const ATTACH_MEDIA_MS = 5 * MINUTE_MS;

const MediaOutputSchema = z.object({ media: z.array(MediaItemSchema) });

/**
 * Has the tools sidecar attach the media the result lists (`POST /media`): the agent container holds no GitLab access.
 * Null when the result lists none; every item is listed as not attached when the sidecar cannot attach them.
 */
export const attachMedia = async (p: { toolsUrl: string; fetchImpl: typeof fetch; output: unknown; timeoutMs?: number; signal?: AbortSignal }): Promise<MediaUploads | null> => {
  const parsed = MediaOutputSchema.safeParse(p.output);
  if (!parsed.success || parsed.data.media.length === 0) return null;
  const { media } = parsed.data;
  try {
    const response = await p.fetchImpl(`${p.toolsUrl.replace(/\/+$/, "")}/media`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ media }),
      redirect: "error",
      // A shutdown stops it: the pod's grace period is for the work report and the session, not for uploads.
      signal: AbortSignal.any([AbortSignal.timeout(p.timeoutMs ?? ATTACH_MEDIA_MS), ...(p.signal === undefined ? [] : [p.signal])]),
    });
    if (!response.ok) throw new Error(`the tools sidecar answered ${response.status}`);
    return MediaUploadsSchema.parse(await response.json());
  } catch (err) {
    return rejectAll(media, `upload failed: ${errorMessage(err)}`);
  }
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

/** How often the run pod sends the brain lines it has gathered. */
export const EVENTS_FLUSH_MS = 500;
/** The internal run API's limits for one batch (`MAX_EVENT_LINES`, `EVENTS_BODY_LIMIT`), with room for the envelope. */
const EVENTS_BATCH_LINES = 200;
const EVENTS_BATCH_BYTES = 900 * 1024;
/** A line bigger than this (a huge tool result) is left out: the panel never shows tool output. */
const MAX_EVENT_LINE_BYTES = 512 * 1024;
/** Lines kept while the dispatcher is away; the oldest go first past it. */
const MAX_PENDING_LINES = 2_000;
/** What the last events get once the brain is done, before the run's report goes. */
const EVENTS_FINAL_FLUSH_MS = 10_000;
const EVENTS_REQUEST_TIMEOUT_MS = 10_000;
/** A steering poll that came back empty this fast (no open channel yet) waits this long before the next. */
const STEER_MIN_INTERVAL_MS = 1_000;

/** The run pod's end of its run channel (`RunChannels` in the dispatcher). */
export interface PodChannel {
  /** Gathers a brain line (redacted in-pod) for the next batch to `/events`. */
  onLine: (line: string) => void;
  /** Once the brain runs, long-polls `/steer` and hands what comes to the brain. */
  control: BrainControlSink;
  /** Stops polling and sends the lines still gathered, for a short while. */
  close: () => Promise<void>;
}

const CommandsSchema = z.object({
  commands: z.array(z.discriminatedUnion("type", [z.object({ type: z.literal("steer"), message: z.string() }), z.object({ type: z.literal("stop") })])),
});

/** Waits `ms`, or less when `signal` aborts. */
const pause = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const done = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });

/**
 * The run pod's event and steering channel to the dispatcher, with the run's runner token: brain lines go in batches
 * every `flushMs` to `POST …/internal/runs/<runId>/events`, and `GET …/steer` is long-polled while the brain runs.
 * Both ride out the dispatcher's restarts with backoff (lines are kept, the oldest dropped past a limit); a 401 or
 * another refusal ends that half, never the run.
 */
export const podChannel = (p: {
  callbackUrl: string;
  token: string;
  runId: string;
  fetchImpl: typeof fetch;
  warn: (message: string) => void;
  flushMs?: number;
  steerWaitMs?: number;
  backoffMs?: { first: number; max: number };
}): PodChannel => {
  const base = `${p.callbackUrl.replace(/\/+$/, "")}/internal/runs/${encodeURIComponent(p.runId)}`;
  const backoff = p.backoffMs ?? REPORT_BACKOFF_MS;
  const headers = { authorization: `Bearer ${p.token}` };
  const closed = new AbortController();
  const pending: string[] = [];
  let dropped = 0;
  let eventsRefused = false;
  let eventsDelay = backoff.first;
  let eventsRetryAt = 0;
  let sending: Promise<void> | null = null;

  /** Sends one batch; false when the dispatcher could not take it (the batch stays for the next try). */
  const sendBatch = async (): Promise<boolean> => {
    const batch: string[] = [];
    let bytes = 0;
    for (const line of pending) {
      const size = Buffer.byteLength(JSON.stringify(line)) + 1;
      if (batch.length >= EVENTS_BATCH_LINES || (batch.length > 0 && bytes + size > EVENTS_BATCH_BYTES)) break;
      batch.push(line);
      bytes += size;
    }
    if (batch.length === 0) return true;
    let failure: string;
    try {
      const response = await p.fetchImpl(`${base}/events`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ lines: batch }),
        redirect: "error",
        signal: AbortSignal.timeout(EVENTS_REQUEST_TIMEOUT_MS),
      });
      await response.body?.cancel();
      if (response.ok) {
        pending.splice(0, batch.length);
        return true;
      }
      if (response.status < 500 && response.status !== 408 && response.status !== 429) {
        eventsRefused = true;
        pending.length = 0;
        p.warn(`the steward answered ${response.status} to the run's events; no more are sent`);
        return true;
      }
      failure = `the steward answered ${response.status}`;
    } catch (err) {
      failure = errorMessage(err);
    }
    if (eventsDelay === backoff.first) p.warn(`the run's events were not delivered (${failure}); retrying`);
    return false;
  };

  /** Sends what is gathered, batch by batch, unless the last failure's backoff has not passed. */
  const flush = (): Promise<void> => {
    if (sending !== null) return sending;
    if (pending.length === 0 || eventsRefused || Date.now() < eventsRetryAt) return Promise.resolve();
    const run = async (): Promise<void> => {
      while (pending.length > 0 && !eventsRefused && Date.now() >= eventsRetryAt) {
        if (await sendBatch()) {
          eventsDelay = backoff.first;
          continue;
        }
        eventsRetryAt = Date.now() + eventsDelay;
        eventsDelay = Math.min(eventsDelay * 2, backoff.max);
      }
    };
    // Cleared once settled: `finally` always runs after this assignment.
    sending = run().finally(() => {
      sending = null;
    });
    return sending;
  };

  const timer = setInterval(() => void flush(), p.flushMs ?? EVENTS_FLUSH_MS);
  timer.unref();

  /** Tells the dispatcher the brain ended, so it refuses steers nobody would read. Best effort: a failure is logged. */
  const endSteering = async (): Promise<void> => {
    try {
      const response = await p.fetchImpl(`${base}/steer/end`, { method: "POST", headers, redirect: "error", signal: AbortSignal.timeout(EVENTS_REQUEST_TIMEOUT_MS) });
      await response.body?.cancel();
      if (!response.ok) p.warn(`the steward answered ${response.status} to the end of steering`);
    } catch (err) {
      p.warn(`the end of steering was not delivered: ${errorMessage(err)}`);
    }
  };

  const poll = async (apply: (commands: RunCommand[]) => void): Promise<void> => {
    const waitMs = p.steerWaitMs ?? MAX_STEER_WAIT_MS;
    let delay = backoff.first;
    while (!closed.signal.aborted) {
      const startedAt = Date.now();
      let failure: string | null = null;
      try {
        const response = await p.fetchImpl(`${base}/steer?waitMs=${waitMs}`, {
          headers,
          redirect: "error",
          signal: AbortSignal.any([AbortSignal.timeout(waitMs + EVENTS_REQUEST_TIMEOUT_MS), closed.signal]),
        });
        if (response.status === 401) {
          await response.body?.cancel();
          p.warn("the run's runner token was rejected for steering; no more steering is taken");
          return;
        }
        if (response.ok) {
          const { commands } = CommandsSchema.parse(await response.json());
          apply(commands);
          delay = backoff.first;
          if (commands.length === 0 && Date.now() - startedAt < STEER_MIN_INTERVAL_MS) await pause(STEER_MIN_INTERVAL_MS, closed.signal);
          continue;
        }
        await response.body?.cancel();
        failure = `the steward answered ${response.status}`;
      } catch (err) {
        if (closed.signal.aborted) return;
        failure = errorMessage(err);
      }
      if (delay === backoff.first) p.warn(`steering could not be read (${failure}); retrying`);
      await pause(delay, closed.signal);
      delay = Math.min(delay * 2, backoff.max);
    }
  };

  return {
    onLine: (line) => {
      if (eventsRefused || closed.signal.aborted) return;
      if (Buffer.byteLength(JSON.stringify(line)) > MAX_EVENT_LINE_BYTES) return;
      pending.push(line);
      if (pending.length > MAX_PENDING_LINES) {
        pending.splice(0, pending.length - MAX_PENDING_LINES);
        if (dropped++ === 0) p.warn("the steward is not taking the run's events; the oldest are dropped");
      }
    },
    control: (handlers) => {
      if (closed.signal.aborted) return;
      poll((commands) => applyCommands(handlers, commands)).catch((err: unknown) => p.warn(`steering stopped: ${errorMessage(err)}`));
    },
    close: async () => {
      closed.abort();
      clearInterval(timer);
      // First, so a steer sent while the last lines go out is refused (the person's message falls back to a chat).
      await endSteering();
      const deadline = Date.now() + EVENTS_FINAL_FLUSH_MS;
      while (pending.length > 0 && !eventsRefused && Date.now() < deadline) {
        await sending;
        await flush();
        if (pending.length > 0) await new Promise((resolve) => setTimeout(resolve, Math.max(0, Math.min(eventsRetryAt - Date.now(), deadline - Date.now()))));
      }
    },
  };
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
  /** Overrides for the run channel's timing (tests). */
  channel?: { flushMs?: number; steerWaitMs?: number; backoffMs?: { first: number; max: number } };
}

const failedReport = (spec: RunSpec, error: string): RunReport => ({
  runId: spec.runId, ok: false, error, interrupted: false, stopped: false, setupFailed: false, sessionId: null, output: null, usage: null,
});

/**
 * The agent container's run: waits for the sidecars, lays the overlay into the worktree that git-init cloned, serves the
 * check endpoint, runs `executeRun` with the pod's env and MCP servers (its brain lines out and steering in through
 * `podChannel`, unless the run is interactive), then has the tools sidecar attach the result's
 * media and post the work report, and posts the run report itself, retrying while the dispatcher is away. Rejects only when the report could not be
 * delivered.
 */
export const runPod = async (p: PodRun): Promise<RunReport> => {
  const { spec } = p;
  let report: RunReport;
  let checks: ChecksServer | null = null;
  // A person at the session's terminal steers it there; only a brain run has the channel.
  const channel = spec.interactive
    ? null
    : podChannel({ callbackUrl: p.callbackUrl, token: p.runnerToken, runId: spec.runId, fetchImpl: p.fetchImpl, warn: p.warn, ...p.channel });
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
      ...(channel === null ? {} : { onLine: channel.onLine, control: channel.control }),
      ...(p.signal === undefined ? {} : { signal: p.signal }),
      ...(p.runBrain === undefined ? {} : { runBrain: p.runBrain }),
    });
  } catch (err) {
    report = p.signal?.aborted === true ? { ...failedReport(spec, INTERRUPTED_ERROR), interrupted: true } : failedReport(spec, errorMessage(err));
  }
  await channel?.close();
  if (report.ok) {
    const media = await attachMedia({ toolsUrl: p.toolsUrl, fetchImpl: p.fetchImpl, output: report.output, ...(p.signal === undefined ? {} : { signal: p.signal }) });
    if (media !== null) report = { ...report, media };
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
