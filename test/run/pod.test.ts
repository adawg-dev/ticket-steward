import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer, request, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { buildProgram } from "../../src/cli/program.js";
import type { SpawnInteractive } from "../../src/cli/context.js";
import { STOPPED_ERROR, type Brain, type BrainRun } from "../../src/brain/types.js";
import type { RunSpec } from "../../src/run/protocol.js";
import { buildPodBrainEnv, EGRESS_CA_DIR, podChannel, podMcpServers, postReport, scrubRemoteCredentials, startChecksServer, waitForPod, type ChecksServer } from "../../src/run/pod.js";
import { FakeBrain } from "../fakes/fakeBrain.js";
import { makeContext, writeConfig } from "../cli/helpers.js";
import { commitFile, git, makeSourceRepo, removeDir, serveGitHttp, tmpDir, type GitHttpServer } from "../workspace/helpers.js";

const MIRROR_TOKEN = "glpat-mirror-secret-value";
const RUNNER_TOKEN = "runner-token-value";

let root: string;
let repo: string;
let base: string;

const specFor = (patch: Partial<RunSpec> = {}): RunSpec => ({
  version: 1,
  runId: "7-1",
  jobId: 7,
  kind: "implement",
  identifier: "API-1",
  issueId: "issue-1",
  checkout: { ref: null, sha: base },
  baseSha: base,
  worktreePath: repo,
  artifactsDir: join(root, "jobs", "7", "artifacts"),
  transcriptPath: join(root, "jobs", "7", "attempt-1.jsonl"),
  prompt: "Implement API-1.",
  personCommits: null,
  output: "implement",
  resumeSessionId: null,
  limits: { timeoutMinutes: 1, maxTurns: 5, setupTimeoutMinutes: 1 },
  push: { jobId: 7, worktreePath: repo, identifier: "API-1", issueId: "issue-1", title: "Adapter drops the last chunk", mode: "create", branch: null, baseSha: base, loopId: null, port: 3000 },
  setup: [],
  checks: [],
  interactive: false,
  ...patch,
});

const writeSpec = async (spec: RunSpec): Promise<string> => {
  const path = join(root, "spec.json");
  await writeFile(path, JSON.stringify(spec));
  return path;
};

interface Received {
  method: string;
  path: string;
  authorization: string;
  body: string;
}

/** A local HTTP server that records every request and answers `status` (200 by default) with `answer`'s JSON. */
interface Recorder {
  url: string;
  port: number;
  received: Received[];
  server: Server;
  answer: (req: Received) => unknown;
  status: (req: Received) => number;
}

const recorder = async (answer: (req: Received) => unknown, status: (req: Received) => number = () => 200): Promise<Recorder> => {
  const received: Received[] = [];
  const self: Pick<Recorder, "answer" | "status"> = { answer, status };
  const server = createServer((req: IncomingMessage, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const entry = { method: req.method ?? "", path: req.url ?? "", authorization: req.headers.authorization ?? "", body: Buffer.concat(chunks).toString("utf8") };
      received.push(entry);
      res.writeHead(self.status(entry), { "content-type": "application/json" });
      res.end(JSON.stringify(self.answer(entry)));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return Object.assign(self, { url: `http://127.0.0.1:${port}`, port, received, server });
};

/** A loopback port nothing listens on now: `--checks-listen` takes a real port, as in the pod. */
const freePort = async (): Promise<number> => {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
};

const servers: Server[] = [];
const closeAll = async (): Promise<void> => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
};

beforeEach(async () => {
  root = await tmpDir();
  ({ repo, sha: base } = await makeSourceRepo(root));
});

afterEach(async () => {
  await closeAll();
  delete process.env.STEWARD_CALLBACK_URL;
  delete process.env.STEWARD_RUNNER_TOKEN;
  await removeDir(root);
});

describe("buildPodBrainEnv", () => {
  it("points the agent at the pod's sidecars and carries no credential but keyproxy's dummy token", () => {
    const env = buildPodBrainEnv({ author: { name: "Ticket Steward", email: "steward@example.com" } });

    const credentialKeys = Object.keys(env).filter((key) => /TOKEN|SECRET|KEY|PASSWORD/i.test(key));
    expect(credentialKeys).toEqual(["ANTHROPIC_AUTH_TOKEN"]);
    expect(env).toMatchObject({
      ANTHROPIC_BASE_URL: "http://127.0.0.1:4180",
      ANTHROPIC_AUTH_TOKEN: "steward-keyproxy",
      HTTPS_PROXY: "http://127.0.0.1:4182",
      HTTP_PROXY: "http://127.0.0.1:4182",
      NO_PROXY: "127.0.0.1,localhost",
      NODE_EXTRA_CA_CERTS: "/run/egress-ca/ca.pem",
      SSL_CERT_FILE: "/run/egress-ca/ca.pem",
      REQUESTS_CA_BUNDLE: "/run/egress-ca/ca.pem",
      CLAUDE_CONFIG_DIR: "/var/lib/ticket-steward/sessions",
      GIT_AUTHOR_NAME: "Ticket Steward",
      GIT_COMMITTER_EMAIL: "steward@example.com",
      PORT: "3000",
    });
  });
});

describe("podMcpServers", () => {
  it("reaches codehost, push and orbit on the tools sidecar and runs Playwright over stdio", () => {
    const servers = podMcpServers(specFor(), "http://127.0.0.1:4181");

    expect(servers.codehost).toEqual({ type: "http", url: "http://127.0.0.1:4181/mcp/codehost" });
    expect(servers.push).toEqual({ type: "http", url: "http://127.0.0.1:4181/mcp/push" });
    expect(servers.orbit).toEqual({ type: "http", url: "http://127.0.0.1:4181/mcp/orbit" });
    expect(servers.playwright).toMatchObject({ command: process.execPath });
    expect(servers.playwright?.type === "http" ? [] : servers.playwright?.args).toEqual(expect.arrayContaining(["--caps=devtools", "--output-dir", join(root, "jobs", "7", "artifacts")]));
  });

  it("gives a run without a push target no push tool", () => {
    expect(Object.keys(podMcpServers(specFor({ push: null }), "http://127.0.0.1:4181")).sort()).toEqual(["codehost", "orbit", "playwright"]);
  });
});

describe("waitForPod", () => {
  it("names what is not ready when the limit passes", async () => {
    const listening = await recorder(() => ({}));
    servers.push(listening.server);

    await expect(waitForPod({ caFile: join(root, "ca.pem"), ports: [listening.port], timeoutMs: 200, intervalMs: 20 })).rejects.toThrow(`not ready after 0.2 s: ${join(root, "ca.pem")}`);
  });

  it("resolves once the CA is there and every port answers", async () => {
    const listening = await recorder(() => ({}));
    servers.push(listening.server);
    await writeFile(join(root, "ca.pem"), "ca");

    await expect(waitForPod({ caFile: join(root, "ca.pem"), ports: [listening.port], timeoutMs: 2_000, intervalMs: 20 })).resolves.toBeUndefined();
  });
});

describe("startChecksServer", () => {
  let checks: ChecksServer | null = null;

  afterEach(async () => {
    await checks?.close();
    checks = null;
  });

  const post = (url: string, body: string, host?: string): Promise<{ status: number; body: string }> =>
    new Promise((resolve, reject) => {
      const target = new URL("/checks", url);
      const req = request(target, { method: "POST", headers: { "content-type": "application/json", ...(host === undefined ? {} : { host }) } }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
      });
      req.on("error", reject);
      req.end(body);
    });

  it("runs the commands in the worktree and answers with their result", async () => {
    checks = await startChecksServer({ listen: { host: "127.0.0.1", port: 0 }, worktreePath: repo, env: { PATH: process.env.PATH ?? "/usr/bin:/bin" }, timeoutMs: 10_000 });

    const passed = await post(checks.url, JSON.stringify({ commands: ["cat README.md"] }));
    const failed = await post(checks.url, JSON.stringify({ commands: ["echo lint failed", "exit 1"] }));

    expect(passed.status).toBe(200);
    expect(JSON.parse(passed.body)).toEqual({ ok: true, tail: "$ cat README.md\nhello\n" });
    expect(JSON.parse(failed.body)).toMatchObject({ ok: false, tail: expect.stringContaining("lint failed") as string });
  });

  it("refuses a request from a page (foreign Host) and a body that is not { commands }", async () => {
    checks = await startChecksServer({ listen: { host: "127.0.0.1", port: 0 }, worktreePath: repo, env: {}, timeoutMs: 10_000 });

    expect((await post(checks.url, JSON.stringify({ commands: ["true"] }), "evil.example")).status).toBe(403);
    expect((await post(checks.url, JSON.stringify({ commands: "true" }))).status).toBe(400);
  });
});

describe("postReport", () => {
  const report = { runId: "7-1", ok: true, error: null, interrupted: false, stopped: false, setupFailed: false, sessionId: "session-2", output: null, usage: null };
  const quick = { retryForMs: 5_000, backoffMs: { first: 10, max: 20 } };

  it("keeps trying while the dispatcher refuses connections or answers 503, and delivers the report once it is back", async () => {
    const refused = `http://127.0.0.1:${await freePort()}`;
    const callback = await recorder(() => ({ ok: true }), (req) => (callback.received.indexOf(req) === 0 ? 503 : 200));
    servers.push(callback.server);
    let calls = 0;
    // The first attempt finds no dispatcher listening: a real connection refused.
    const fetchImpl: typeof fetch = (input, init) => (calls++ === 0 ? fetch(`${refused}/internal/runs/7-1/report`, init) : fetch(input, init));
    const warnings: string[] = [];

    await postReport({ callbackUrl: callback.url, token: RUNNER_TOKEN, report, fetchImpl, warn: (message) => warnings.push(message), ...quick });

    expect(calls).toBe(3);
    expect(callback.received.map((r) => `${r.method} ${r.path}`)).toEqual(["POST /internal/runs/7-1/report", "POST /internal/runs/7-1/report"]);
    expect(JSON.parse(callback.received[1]?.body ?? "")).toEqual(report);
    expect(warnings).toHaveLength(2);
    expect(warnings[1]).toContain("503");
  });

  it("fails at once on 401 and on another 4xx", async () => {
    for (const [status, message] of [[401, "runner token was rejected"], [404, "answered 404"]] as const) {
      const callback = await recorder(() => ({ error: "no" }), () => status);
      servers.push(callback.server);
      await expect(postReport({ callbackUrl: callback.url, token: RUNNER_TOKEN, report, fetchImpl: fetch, ...quick })).rejects.toThrow(message);
      expect(callback.received).toHaveLength(1);
    }
  });

  it("gives up when the dispatcher stays away past the limit", async () => {
    const callback = await recorder(() => ({ error: "restarting" }), () => 503);
    servers.push(callback.server);
    await expect(postReport({ callbackUrl: callback.url, token: RUNNER_TOKEN, report, fetchImpl: fetch, retryForMs: 100, backoffMs: { first: 10, max: 20 } })).rejects.toThrow(/not delivered in 0\.1 s .*503/);
    expect(callback.received.length).toBeGreaterThan(1);
  });
});

describe("steward git-init", () => {
  let remote: GitHttpServer;

  afterEach(async () => {
    await remote.close();
  });

  it("checks out the ticket branch's commit with the mirror token, and leaves no token in .git", async () => {
    await git(repo, ["checkout", "-q", "-b", "API-1-feature"]);
    const branchSha = await commitFile(repo, "feature.txt", "feature\n");
    await git(repo, ["checkout", "-q", "main"]);
    const served = join(root, "served");
    await mkdir(served);
    await git(root, ["clone", "-q", "--bare", repo, join(served, "remote.git")]);
    remote = await serveGitHttp(served);

    const dir = join(root, "config");
    await mkdir(dir);
    await writeFile(join(dir, ".env"), `MIRROR_TOKEN=${MIRROR_TOKEN}\n`);
    const configPath = await writeConfig(dir, { dataDir: join(dir, "data"), overlayDir: join(dir, "overlay"), fetchUrl: `${remote.url}/remote.git`, port: 4100, serverPort: 3020 });
    const worktree = join(root, "work", "ticket-API-1");
    const specPath = await writeSpec(specFor({ worktreePath: worktree, checkout: { ref: "API-1-feature", sha: branchSha } }));
    const test = makeContext();

    await buildProgram(test.ctx).parseAsync(["node", "steward", "--config", configPath, "git-init", "--spec", specPath]);

    expect(await git(worktree, ["rev-parse", "HEAD"])).toBe(branchSha);
    expect(remote.authorizations).toContain(`Basic ${Buffer.from(`oauth2:${MIRROR_TOKEN}`).toString("base64")}`);
    const gitConfig = await readFile(join(worktree, ".git", "config"), "utf8");
    expect(gitConfig).not.toContain(MIRROR_TOKEN);
    expect(gitConfig).not.toContain(Buffer.from(`oauth2:${MIRROR_TOKEN}`).toString("base64"));
    expect(gitConfig.toLowerCase()).not.toContain("extraheader");
    expect(await git(worktree, ["config", "remote.origin.url"])).toBe(`${remote.url}/remote.git`);
    expect(await git(worktree, ["config", "remote.origin.pushurl"])).toBe("/dev/null");
    expect(test.stdout()).not.toContain(MIRROR_TOKEN);
  });
});

describe("scrubRemoteCredentials", () => {
  it("removes every extraHeader and a token in origin's URL", async () => {
    const basic = Buffer.from(`oauth2:${MIRROR_TOKEN}`).toString("base64");
    await git(repo, ["config", "http.https://gitlab.example.extraHeader", `Authorization: Basic ${basic}`]);
    await git(repo, ["config", "--add", "http.extraHeader", `Authorization: Bearer ${MIRROR_TOKEN}`]);
    await git(repo, ["remote", "add", "origin", `https://oauth2:${MIRROR_TOKEN}@gitlab.example/acme/repo.git`]);

    await scrubRemoteCredentials(repo, "https://gitlab.example/acme/repo.git");

    const gitConfig = await readFile(join(repo, ".git", "config"), "utf8");
    expect(gitConfig).not.toContain(MIRROR_TOKEN);
    expect(gitConfig).not.toContain(basic);
    expect(await git(repo, ["config", "remote.origin.url"])).toBe("https://gitlab.example/acme/repo.git");
  });
});

/** The requests to the dispatcher's run API that carry the run report (the pod also posts events and polls steering). */
const reportsTo = (callback: Recorder): Received[] => callback.received.filter((r) => r.path.endsWith("/report"));

describe("steward run-pod", () => {
  const setUp = async (spec: RunSpec): Promise<{ args: string[]; tools: Awaited<ReturnType<typeof recorder>>; callback: Awaited<ReturnType<typeof recorder>> }> => {
    const tools = await recorder(() => ({ runId: spec.runId, unpushed: "", pushedSha: null }));
    const callback = await recorder(() => ({ ok: true }));
    servers.push(tools.server, callback.server);
    const dir = join(root, "config");
    await mkdir(dir);
    const configPath = await writeConfig(dir, { dataDir: join(dir, "data"), overlayDir: join(dir, "overlay"), fetchUrl: "https://gitlab.example/acme/repo.git", port: 4100, serverPort: 3020 });
    const overlay = join(root, "overlay");
    await mkdir(join(overlay, "apps", "api"), { recursive: true });
    await writeFile(join(overlay, "apps", "api", ".env"), "STRIPE_SECRET_KEY=STEWARD_PH_STRIPE_SECRET_KEY_0123456789abcdef\n");
    await writeFile(join(root, "ca.pem"), "ca");
    process.env.STEWARD_CALLBACK_URL = callback.url;
    process.env.STEWARD_RUNNER_TOKEN = RUNNER_TOKEN;
    const specPath = await writeSpec(spec);
    return {
      tools,
      callback,
      args: [
        "node", "steward", "--config", configPath, "run-pod", "--spec", specPath,
        "--overlay", overlay, "--egress-ca", join(root, "ca.pem"), "--tools-url", tools.url,
        "--wait-for", String(tools.port), "--checks-listen", `127.0.0.1:${await freePort()}`,
      ],
    };
  };

  it("runs the brain with the pod's env and tools, asks the tools sidecar to finish, then posts the report", async () => {
    const { args, tools, callback } = await setUp(specFor());
    const brain = new FakeBrain({ result: { outcome: "pushed" }, sessionId: "session-2" });
    const test = makeContext({ fetchImpl: fetch, factories: { brain } });

    await buildProgram(test.ctx).parseAsync(args);

    expect(tools.received.map((r) => `${r.method} ${r.path}`)).toEqual(["POST /finish"]);
    expect(reportsTo(callback)).toHaveLength(1);
    const [report] = reportsTo(callback);
    // The brain's lines went to the run's events before the report, with the runner token.
    const events = callback.received.filter((r) => r.path === "/internal/runs/7-1/events");
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((r) => r.method === "POST" && r.authorization === `Bearer ${RUNNER_TOKEN}`)).toBe(true);
    expect(events.flatMap((r) => (JSON.parse(r.body) as { lines: string[] }).lines)).toEqual([JSON.stringify({ type: "fake", prompt: "Implement API-1." })]);
    const order = callback.received.map((r) => r.path);
    expect(order.lastIndexOf("/internal/runs/7-1/events")).toBeLessThan(order.indexOf("/internal/runs/7-1/report"));
    expect(report).toMatchObject({ method: "POST", path: "/internal/runs/7-1/report", authorization: `Bearer ${RUNNER_TOKEN}` });
    expect(JSON.parse(report?.body ?? "")).toEqual({ runId: "7-1", ok: true, error: null, interrupted: false, stopped: false, setupFailed: false, sessionId: "session-2", output: { outcome: "pushed" }, usage: { inputTokens: 10, outputTokens: 5 } });

    const input = brain.lastInput();
    expect(input.env.ANTHROPIC_AUTH_TOKEN).toBe("steward-keyproxy");
    expect(Object.values(input.env)).not.toContain("glpat-push-token-value");
    expect(input.env.NODE_EXTRA_CA_CERTS).toBe(join(root, "ca.pem"));
    expect(input.mcpServers.push).toEqual({ type: "http", url: `${tools.url}/mcp/push` });
    expect(input.denyPaths).toEqual([EGRESS_CA_DIR]);
    expect(await readFile(join(repo, "apps", "api", ".env"), "utf8")).toContain("STEWARD_PH_STRIPE_SECRET_KEY_");
  });

  it("has the tools sidecar attach the result's media and carries what it attached in the report", async () => {
    const uploads = { embeds: [{ caption: "After", markdown: "![a.png](/uploads/1/a.png)" }], rejected: [{ name: "x.exe", reason: "not an image or video" }] };
    const { args, tools, callback } = await setUp(specFor());
    const media = [{ path: "a.png", caption: "After" }, { path: "x.exe", caption: "No" }];
    const brain = new FakeBrain({ result: { outcome: "implemented", media }, sessionId: "session-2" });
    const test = makeContext({ fetchImpl: fetch, factories: { brain } });
    tools.answer = (req) => (req.path === "/media" ? uploads : { runId: "7-1", unpushed: "", pushedSha: null });

    await buildProgram(test.ctx).parseAsync(args);

    expect(tools.received.map((r) => `${r.method} ${r.path}`)).toEqual(["POST /media", "POST /finish"]);
    expect(JSON.parse(tools.received[0]?.body ?? "")).toEqual({ media });
    expect(JSON.parse(reportsTo(callback)[0]?.body ?? "")).toMatchObject({ ok: true, media: uploads });
  });

  it("lists every item as not attached when the tools sidecar cannot attach them", async () => {
    const { args, tools, callback } = await setUp(specFor());
    const brain = new FakeBrain({ result: { outcome: "implemented", media: [{ path: "shots/a.png", caption: "After" }] } });
    const test = makeContext({ fetchImpl: fetch, factories: { brain } });
    tools.status = (req) => (req.path === "/media" ? 502 : 200);

    await buildProgram(test.ctx).parseAsync(args);

    const report = JSON.parse(reportsTo(callback)[0]?.body ?? "") as { ok: boolean; media: { embeds: unknown[]; rejected: Array<{ name: string; reason: string }> } };
    expect(report.ok).toBe(true);
    expect(report.media.embeds).toEqual([]);
    expect(report.media.rejected).toEqual([{ name: "a.png", reason: expect.stringContaining("upload failed") }]);
  });

  it("reports a failed setup without running the brain", async () => {
    const { args, callback } = await setUp(specFor({ setup: ["exit 4"] }));
    const brain = new FakeBrain({ result: {} });
    const test = makeContext({ fetchImpl: fetch, factories: { brain } });

    await buildProgram(test.ctx).parseAsync(args);

    expect(brain.runs).toBe(0);
    expect(JSON.parse(reportsTo(callback)[0]?.body ?? "")).toMatchObject({ ok: false, setupFailed: true });
  });

  it("with an interactive spec, resumes the session in Claude Code under the chat hook and reports when it exits", async () => {
    const { args, callback } = await setUp(specFor({ kind: "chat", output: "chat", interactive: true, resumeSessionId: "session-1" }));
    const calls: Array<{ args: string[]; cwd: string; env: Record<string, string> }> = [];
    const spawnInteractive: SpawnInteractive = async (_command, spawnArgs, options) => {
      calls.push({ args: spawnArgs, ...options });
      return 0;
    };
    const test = makeContext({ fetchImpl: fetch, factories: { spawnInteractive } });

    await buildProgram(test.ctx).parseAsync(args);

    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call?.cwd).toBe(repo);
    expect(call?.args.slice(0, 2)).toEqual(["--resume", "session-1"]);
    const settings = call?.args[call.args.indexOf("--settings") + 1] ?? "";
    expect(settings).toContain("chat-hook");
    expect(settings).toContain(`'--deny' '${EGRESS_CA_DIR}'`);
    expect(call?.env.ANTHROPIC_AUTH_TOKEN).toBe("steward-keyproxy");
    // A person at the terminal steers it there: no events and no steering poll.
    expect(callback.received.map((r) => r.path)).toEqual(["/internal/runs/7-1/report"]);
    expect(JSON.parse(callback.received[0]?.body ?? "")).toMatchObject({ runId: "7-1", ok: true, sessionId: "session-1" });
  });

  it("hands a steer command from the steering poll to the running brain", async () => {
    const { args, callback } = await setUp(specFor());
    let polls = 0;
    callback.answer = (req) => {
      if (!req.path.startsWith("/internal/runs/7-1/steer")) return { ok: true };
      polls += 1;
      return { commands: polls === 1 ? [{ type: "steer", message: "use v2" }] : [] };
    };
    const steered: string[] = [];
    const brain: Brain = {
      kind: "claude-code",
      run: (_input, onMessage, control) => {
        onMessage(JSON.stringify({ type: "assistant", message: { content: [] } }));
        return new Promise<BrainRun>((resolve) => {
          control?.({
            steer: (message) => {
              steered.push(message);
              resolve({ ok: true, output: { outcome: "implemented" } });
            },
            stop: () => resolve({ ok: false, output: undefined, error: STOPPED_ERROR }),
          });
        });
      },
    };
    const test = makeContext({ fetchImpl: fetch, factories: { brain } });

    await buildProgram(test.ctx).parseAsync(args);

    expect(steered).toEqual(["use v2"]);
    const poll = callback.received.find((r) => r.path.startsWith("/internal/runs/7-1/steer"));
    expect(poll).toMatchObject({ method: "GET", path: "/internal/runs/7-1/steer?waitMs=25000", authorization: `Bearer ${RUNNER_TOKEN}` });
    expect(JSON.parse(reportsTo(callback)[0]?.body ?? "")).toMatchObject({ ok: true, output: { outcome: "implemented" } });
  });
});

describe("podChannel", () => {
  const quick = { flushMs: 10, steerWaitMs: 50, backoffMs: { first: 10, max: 20 } };

  it("keeps the lines while the dispatcher answers 503 and delivers them in order once it is back", async () => {
    const callback = await recorder(() => ({ ok: true }), (req) => (callback.received.indexOf(req) < 2 ? 503 : 200));
    servers.push(callback.server);
    const warnings: string[] = [];
    const channel = podChannel({ callbackUrl: callback.url, token: RUNNER_TOKEN, runId: "7-1", fetchImpl: fetch, warn: (message) => warnings.push(message), ...quick });

    channel.onLine("one");
    channel.onLine("two");
    await vi.waitFor(() => expect(callback.received.length).toBeGreaterThanOrEqual(3));
    channel.onLine("three");
    await channel.close();

    const events = callback.received.filter((r) => r.path.endsWith("/events"));
    const delivered = events.filter((r) => events.indexOf(r) >= 2).flatMap((r) => (JSON.parse(r.body) as { lines: string[] }).lines);
    expect(delivered).toEqual(["one", "two", "three"]);
    expect(warnings.some((warning) => warning.includes("503"))).toBe(true);
  });

  it("sends at most 200 lines a batch", async () => {
    const callback = await recorder(() => ({ ok: true }));
    servers.push(callback.server);
    const channel = podChannel({ callbackUrl: callback.url, token: RUNNER_TOKEN, runId: "7-1", fetchImpl: fetch, warn: () => undefined, ...quick, flushMs: 60_000 });

    for (let i = 0; i < 450; i += 1) channel.onLine(`line ${i}`);
    await channel.close();

    const events = callback.received.filter((r) => r.path.endsWith("/events"));
    expect(events.map((r) => (JSON.parse(r.body) as { lines: string[] }).lines.length)).toEqual([200, 200, 50]);
  });

  it("stops polling a steering the dispatcher refuses (401), and polls again after a 503", async () => {
    const steered: string[] = [];
    const handlers = { steer: (message: string) => void steered.push(message), stop: () => undefined };
    let calls = 0;
    const urls: string[] = [];
    const fetchImpl: typeof fetch = (input) => {
      calls += 1;
      urls.push(String(input));
      if (urls.at(-1)?.endsWith("/steer/end") === true) return Promise.resolve(Response.json({ ok: true }));
      if (calls === 1) return Promise.resolve(new Response("{}", { status: 503 }));
      if (calls === 2) return Promise.resolve(Response.json({ commands: [{ type: "steer", message: "use v2" }] }));
      return Promise.resolve(new Response("{}", { status: 401 }));
    };
    const warnings: string[] = [];
    const channel = podChannel({ callbackUrl: "http://steward.invalid", token: RUNNER_TOKEN, runId: "7-1", fetchImpl, warn: (message) => warnings.push(message), ...quick });

    channel.control(handlers);
    await vi.waitFor(() => expect(warnings.some((warning) => warning.includes("rejected"))).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 50));
    await channel.close();

    expect(steered).toEqual(["use v2"]);
    expect(urls.filter((url) => url.includes("/steer?"))).toHaveLength(3);
  });

  it("tells the dispatcher, on close, that the brain ended, before its last lines go out", async () => {
    const callback = await recorder(() => ({ ok: true }));
    servers.push(callback.server);
    const channel = podChannel({ callbackUrl: callback.url, token: RUNNER_TOKEN, runId: "7-1", fetchImpl: fetch, warn: () => undefined, ...quick, flushMs: 60_000 });

    channel.onLine("last");
    await channel.close();

    expect(callback.received.map((r) => `${r.method} ${r.path}`)).toEqual(["POST /internal/runs/7-1/steer/end", "POST /internal/runs/7-1/events"]);
    expect(callback.received[0]?.authorization).toBe(`Bearer ${RUNNER_TOKEN}`);
  });
});
