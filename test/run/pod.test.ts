import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer, request, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { buildProgram } from "../../src/cli/program.js";
import type { SpawnInteractive } from "../../src/cli/context.js";
import type { RunSpec } from "../../src/run/protocol.js";
import { buildPodBrainEnv, EGRESS_CA_DIR, podMcpServers, postReport, scrubRemoteCredentials, startChecksServer, waitForPod, type ChecksServer } from "../../src/run/pod.js";
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
  push: { jobId: 7, worktreePath: repo, identifier: "API-1", issueId: "issue-1", mode: "create", branch: null, baseSha: base, loopId: null, port: 3000 },
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
const recorder = async (answer: (req: Received) => unknown, status: (req: Received) => number = () => 200): Promise<{ url: string; port: number; received: Received[]; server: Server }> => {
  const received: Received[] = [];
  const server = createServer((req: IncomingMessage, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const entry = { method: req.method ?? "", path: req.url ?? "", authorization: req.headers.authorization ?? "", body: Buffer.concat(chunks).toString("utf8") };
      received.push(entry);
      res.writeHead(status(entry), { "content-type": "application/json" });
      res.end(JSON.stringify(answer(entry)));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, port, received, server };
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
  const report = { runId: "7-1", ok: true, error: null, interrupted: false, setupFailed: false, sessionId: "session-2", output: null, usage: null };
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
    expect(callback.received).toHaveLength(1);
    const [report] = callback.received;
    expect(report).toMatchObject({ method: "POST", path: "/internal/runs/7-1/report", authorization: `Bearer ${RUNNER_TOKEN}` });
    expect(JSON.parse(report?.body ?? "")).toEqual({ runId: "7-1", ok: true, error: null, interrupted: false, setupFailed: false, sessionId: "session-2", output: { outcome: "pushed" }, usage: { inputTokens: 10, outputTokens: 5 } });

    const input = brain.lastInput();
    expect(input.env.ANTHROPIC_AUTH_TOKEN).toBe("steward-keyproxy");
    expect(Object.values(input.env)).not.toContain("glpat-push-token-value");
    expect(input.env.NODE_EXTRA_CA_CERTS).toBe(join(root, "ca.pem"));
    expect(input.mcpServers.push).toEqual({ type: "http", url: `${tools.url}/mcp/push` });
    expect(input.denyPaths).toEqual([EGRESS_CA_DIR]);
    expect(await readFile(join(repo, "apps", "api", ".env"), "utf8")).toContain("STEWARD_PH_STRIPE_SECRET_KEY_");
  });

  it("reports a failed setup without running the brain", async () => {
    const { args, callback } = await setUp(specFor({ setup: ["exit 4"] }));
    const brain = new FakeBrain({ result: {} });
    const test = makeContext({ fetchImpl: fetch, factories: { brain } });

    await buildProgram(test.ctx).parseAsync(args);

    expect(brain.runs).toBe(0);
    expect(JSON.parse(callback.received[0]?.body ?? "")).toMatchObject({ ok: false, setupFailed: true });
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
    expect(JSON.parse(callback.received[0]?.body ?? "")).toMatchObject({ runId: "7-1", ok: true, sessionId: "session-1" });
  });
});
