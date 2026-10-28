import { appendFile, chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { join, resolve } from "node:path";
import { buildProgram } from "../../src/cli/program.js";
import type { McpServerSpec } from "../../src/brain/types.js";
import type { SlotPorts } from "../../src/workspace/slots.js";
import { fakeSlotRunner, type FakeSlotRunner } from "../fakes/fakeSlotRunner.js";
import { FakeGitLabMr } from "../fakes/fakeGitLabMr.js";
import { freeTcpPort, tmpRepo, type TmpRepo } from "../fakes/tmpRepo.js";
import { ExitSignal, makeContext, tmpConfigDir, writeConfig } from "./helpers.js";

let dir: string;
let repo: TmpRepo;
let home: string;
let browsers: string;

const tsxBin = resolve("node_modules/tsx/dist/cli.mjs");
const fakeServerEntry = resolve("test/codehost/fakeServerEntry.ts");

/** Serves the codehost MCP from the in-repo fake entry, the way the codehost server test does. */
const fakeCodehostMcpSpec = (p: { worktreePath: string; sha: string }): McpServerSpec => ({
  command: process.execPath,
  args: [tsxBin, fakeServerEntry, p.worktreePath, p.sha],
  env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
});

beforeEach(async () => {
  vi.restoreAllMocks();
  dir = await tmpConfigDir();
  repo = await tmpRepo("{{ticket}}");
  home = join(dir, "home");
  browsers = join(dir, "browsers");
  await mkdir(home);
  await mkdir(browsers);
  vi.stubEnv("HOME", home);
  vi.stubEnv("PLAYWRIGHT_BROWSERS_PATH", browsers);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await repo.cleanup();
  await rm(dir, { recursive: true, force: true });
});

const unhealthyFetch: typeof fetch = async () => new Response(JSON.stringify({ ok: false, apiKeyRejected: true }), { status: 503 });

const LINEAR_GRAPHQL_URL = "https://api.linear.app/graphql";
const API_KEY = "lin_api_doctor_test";

/** Answers the Linear viewer query with `linear` and the public health URL with 200. */
const linearFetch = (linear: () => Response, seen: Array<{ url: string; init: RequestInit | undefined }> = []): typeof fetch =>
  async (input, init) => {
    const url = input instanceof Request ? input.url : input.toString();
    seen.push({ url, init });
    return url === LINEAR_GRAPHQL_URL ? linear() : new Response("{}", { status: 200 });
  };

describe("steward doctor", () => {
  it("reports a config failure, still runs the user check, and exits 1", async () => {
    const { ctx, stdout } = makeContext();
    const run = buildProgram(ctx).parseAsync(["node", "steward", "--config", join(dir, "steward.config.ts"), "doctor"]);

    await expect(run).rejects.toEqual(new ExitSignal(1));
    expect(stdout().startsWith("[fail] config: ")).toBe(true);
    expect(stdout().endsWith("[ok] running user: owns no ~/.ssh or ~/.kube\n")).toBe(true);
  });

  it("reports every check even after failures and exits 1", async () => {
    const port = await freeTcpPort();
    await writeFile(join(dir, ".env"), `LINEAR_API_KEY=${API_KEY}\nLINEAR_WEBHOOK_SECRET=whsec\nGITLAB_TOKEN=glpat-token\nANTHROPIC_API_KEY=sk-ant-key\n`);
    await writeFile(join(repo.overlayDir, ".env"), "DATABASE_URL=postgres://steward:pw@localhost/dev\n");
    const skillsDir = join(dir, "skills");
    await mkdir(skillsDir);
    await mkdir(join(home, ".ssh"));
    await mkdir(join(browsers, "chromium-1000"));
    const configPath = await writeConfig(dir, {
      dataDir: repo.dataDir,
      overlayDir: repo.overlayDir,
      promptPath: repo.promptPath,
      fetchUrl: repo.repo,
      port,
      serverPort: await freeTcpPort(),
      skillsDir,
    });
    const { ctx, stdout } = makeContext({ fetchImpl: unhealthyFetch, factories: { codehostMcpSpec: fakeCodehostMcpSpec } });

    await expect(buildProgram(ctx).parseAsync(["node", "steward", "--config", configPath, "doctor"])).rejects.toEqual(new ExitSignal(1));

    const lines = stdout().trimEnd().split("\n");
    expect(lines[0]).toBe(`[ok] config: ${configPath}`);
    expect(lines[1]).toBe("[ok] webhook secret: LINEAR_WEBHOOK_SECRET present");
    expect(lines[2]).toBe("[ok] brain credential: claude-code credential present");
    expect(lines[3]).toBe("[ok] codehost token: GITLAB_TOKEN present");
    expect(lines[4]).toBe("[warn] mirror token: MIRROR_TOKEN missing; fetchUrl must be reachable anonymously");
    expect(lines[5]).toBe(`[warn] running user: owns ${join(home, ".ssh")}; run the steward as a dedicated user`);
    expect(lines[6]).toBe(`[ok] dataDir mode: ${repo.dataDir} is 0700`);
    expect(lines[7]).toBe(`[ok] overlayDir mode: ${repo.overlayDir} is 0700`);
    expect(lines[8]).toBe(`[ok] mirror: ${join(repo.dataDir, "repo.git")} fetched; main@${repo.sha.slice(0, 7)}`);
    expect(lines[9]).toBe("[ok] overlay: 1 file(s)");
    expect(lines[10]).toBe(`[ok] skills: ${skillsDir}`);
    expect(lines[11]).toBe("[fail] linear api key: viewer query answered 503");
    expect(lines[12]).toBe("[fail] public url: https://steward.example/health answered 503");
    expect(lines[13]).toBe("[ok] codehost mcp: tools: recent_changes, permalink");
    expect(lines[14]?.startsWith("[ok] playwright mcp: ")).toBe(true);
    expect(lines[15]).toBe(`[ok] chromium: ${join(browsers, "chromium-1000")}`);
    expect(lines[16]).toBe(`[ok] port: ${port} is free`);
    expect(lines.length).toBe(17);
  });

  it("fails when no chromium is installed under PLAYWRIGHT_BROWSERS_PATH", async () => {
    const configPath = await writeConfig(dir, {
      dataDir: repo.dataDir,
      overlayDir: repo.overlayDir,
      promptPath: repo.promptPath,
      fetchUrl: repo.repo,
      port: await freeTcpPort(),
      serverPort: await freeTcpPort(),
    });
    const { ctx, stdout } = makeContext({ factories: { codehostMcpSpec: fakeCodehostMcpSpec } });

    await expect(buildProgram(ctx).parseAsync(["node", "steward", "--config", configPath, "doctor"])).rejects.toEqual(new ExitSignal(1));

    expect(stdout().trimEnd().split("\n")[15]).toBe(`[fail] chromium: no chromium under ${browsers}; run npx playwright install chromium`);
  });

  describe("linear api key check", () => {
    const doctorLine = async (env: string, fetchImpl: typeof fetch): Promise<string | undefined> => {
      await writeFile(join(dir, ".env"), env);
      const configPath = await writeConfig(dir, {
        dataDir: repo.dataDir,
        overlayDir: repo.overlayDir,
        promptPath: repo.promptPath,
        fetchUrl: repo.repo,
        port: await freeTcpPort(),
        serverPort: await freeTcpPort(),
      });
      const { ctx, stdout } = makeContext({ fetchImpl, factories: { codehostMcpSpec: fakeCodehostMcpSpec } });
      await buildProgram(ctx).parseAsync(["node", "steward", "--config", configPath, "doctor"]).catch(() => undefined);
      return stdout().split("\n").find((line) => line.includes("] linear api key: "));
    };

    it("fails when LINEAR_API_KEY is missing", async () => {
      const line = await doctorLine("LINEAR_WEBHOOK_SECRET=whsec\n", linearFetch(() => new Response("{}", { status: 200 })));
      expect(line).toBe("[fail] linear api key: missing LINEAR_API_KEY; create a personal API key for the steward's Linear user");
    });

    it("sends the key as a raw Authorization header and reports the viewer's name", async () => {
      const seen: Array<{ url: string; init: RequestInit | undefined }> = [];
      const viewer = () => new Response(JSON.stringify({ data: { viewer: { id: "user-1", name: "Steward Bot" } } }), { status: 200 });

      const line = await doctorLine(`LINEAR_API_KEY=${API_KEY}\n`, linearFetch(viewer, seen));

      expect(line).toBe("[ok] linear api key: authenticated as Steward Bot; every steward write appears as this user, so use a dedicated bot user");
      const query = seen.find((call) => call.url === LINEAR_GRAPHQL_URL);
      expect(new Headers(query?.init?.headers).get("authorization")).toBe(API_KEY);
      expect(JSON.parse(String(query?.init?.body))).toEqual({ query: "{ viewer { id name } }" });
    });

    it("reports an invalid or revoked key on 401", async () => {
      const line = await doctorLine(`LINEAR_API_KEY=${API_KEY}\n`, linearFetch(() => new Response("{}", { status: 401 })));
      expect(line).toBe("[fail] linear api key: Linear rejected LINEAR_API_KEY: the key is invalid or revoked");
    });

    it("reports an invalid or revoked key on a GraphQL authentication error", async () => {
      const body = JSON.stringify({ errors: [{ message: "Authentication required", extensions: { code: "AUTHENTICATION_ERROR" } }] });
      const line = await doctorLine(`LINEAR_API_KEY=${API_KEY}\n`, linearFetch(() => new Response(body, { status: 400 })));
      expect(line).toBe("[fail] linear api key: Linear rejected LINEAR_API_KEY: the key is invalid or revoked");
    });
  });
  it("fails when a workflow label is missing in Linear", async () => {
    const port = await freeTcpPort();
    const serverPort = await freeTcpPort();
    const configPath = await writeConfig(dir, { dataDir: repo.dataDir, overlayDir: repo.overlayDir, promptPath: repo.promptPath, fetchUrl: repo.repo, port, serverPort, implement: { prompt: repo.promptPath } });
    const fetchImpl: typeof fetch = async (input, init) => {
      const body = typeof init?.body === "string" ? init.body : "";
      if (String(input) === LINEAR_GRAPHQL_URL && body.includes("issueLabels")) {
        return new Response(JSON.stringify({ data: { issueLabels: { nodes: [{ name: "needs-triage" }] } } }), { status: 200 });
      }
      if (String(input) === LINEAR_GRAPHQL_URL) return new Response(JSON.stringify({ data: { viewer: { id: "u", name: "Bot" } } }), { status: 200 });
      return new Response("{}", { status: 200 });
    };
    const { ctx, stdout } = makeContext({ fetchImpl, factories: { codehostMcpSpec: fakeCodehostMcpSpec } });

    await expect(buildProgram(ctx).parseAsync(["node", "steward", "--config", configPath, "doctor"])).rejects.toBeInstanceOf(ExitSignal);

    expect(stdout()).toContain("[fail] linear labels: missing in Linear: ready-for-agent, needs-info, ready-for-human, agent-implemented");
    expect(stdout()).toContain("[ok] push token: GITLAB_PUSH_TOKEN reaches");
  });
});

describe("greptile checks", () => {
  const run = async (gitlab: FakeGitLabMr, prompt: string, env = ""): Promise<string> => {
    const port = await freeTcpPort();
    const serverPort = await freeTcpPort();
    const configPath = await writeConfig(dir, {
      dataDir: repo.dataDir, overlayDir: repo.overlayDir, promptPath: repo.promptPath, fetchUrl: repo.repo, port, serverPort,
      implement: { prompt: repo.promptPath }, greptile: { prompt },
    });
    if (env !== "") await appendFile(join(dir, ".env"), env);
    const fetchImpl: typeof fetch = async (input, init) => {
      const body = typeof init?.body === "string" ? init.body : "";
      if (String(input) === LINEAR_GRAPHQL_URL && body.includes("issueLabels")) {
        return new Response(JSON.stringify({ data: { issueLabels: { nodes: [{ name: "agent-approved" }] } } }), { status: 200 });
      }
      return new Response(JSON.stringify({ data: { viewer: { id: "u", name: "Bot" } } }), { status: 200 });
    };
    const { ctx, stdout } = makeContext({ fetchImpl, factories: { codehostMcpSpec: fakeCodehostMcpSpec, gitlab } });
    await expect(buildProgram(ctx).parseAsync(["node", "steward", "--config", configPath, "doctor"])).rejects.toBeInstanceOf(ExitSignal);
    return stdout();
  };

  it("fails when the token lacks the api scope, the bot is unknown and the prompt is missing", async () => {
    const gitlab = new FakeGitLabMr();
    gitlab.scopes = ["read_api"];
    const out = await run(gitlab, join(dir, "missing-fix.md"));
    expect(out).toContain("[fail] gitlab token scope: gitlab token lacks api scope");
    expect(out).toContain("[fail] greptile bot: greptile bot user greptile-bot not found");
    expect(out).toContain(`[fail] greptile prompt: ${join(dir, "missing-fix.md")} does not exist`);
    expect(out).toContain("[fail] linear labels: missing in Linear:");
    expect(out).toContain("[warn] gitlab webhook secret: neither GITLAB_WEBHOOK_SIGNING_TOKEN nor GITLAB_WEBHOOK_SECRET is set; the loop falls back to 5-minute polling");
  });

  it("finds the GitLab webhook signing token", async () => {
    const out = await run(new FakeGitLabMr(), repo.promptPath, "GITLAB_WEBHOOK_SIGNING_TOKEN=whsec_c2lnbmluZw==\n");
    expect(out).toContain("[ok] gitlab webhook secret: GITLAB_WEBHOOK_SIGNING_TOKEN present");
  });

  it("passes when the scope, the bot and the prompt are right", async () => {
    const gitlab = new FakeGitLabMr();
    gitlab.users.add("greptile-bot");
    const out = await run(gitlab, repo.promptPath);
    expect(out).toContain("[ok] gitlab token scope: GITLAB_TOKEN has the api scope");
    expect(out).toContain("[ok] greptile bot: greptile-bot exists");
    expect(out).toContain(`[ok] greptile prompt: ${repo.promptPath}`);
  });
});

describe("slot checks", () => {
  let helper: string;
  let socketPath: string;
  let socketServer: Server;
  let appPortBase: number;
  let ports: Map<number, SlotPorts>;

  const distinctFreePorts = async (count: number): Promise<number[]> => {
    const found: number[] = [];
    while (found.length < count) {
      const port = await freeTcpPort();
      if (!found.includes(port)) found.push(port);
    }
    return found;
  };

  beforeEach(async () => {
    helper = join(dir, "steward-slot");
    await writeFile(helper, "#!/usr/bin/env bash\n");
    await chmod(helper, 0o755);
    // A real socket file, so the existence and type checks see what systemd would create; requests go through the fake runner.
    socketPath = join(dir, "slot.sock");
    socketServer = createServer((connection) => connection.destroy());
    await new Promise<void>((ready) => socketServer.listen(socketPath, () => ready()));
    await writeFile(join(repo.overlayDir, ".env"), "DB_PORT=5432\n");
    const [app, p1, r1, q1, p2, r2, q2] = await distinctFreePorts(7);
    appPortBase = (app ?? 0) - 1;
    ports = new Map([
      [1, { postgres: p1 ?? 0, redis: r1 ?? 0, rabbitmq: q1 ?? 0 }],
      [2, { postgres: p2 ?? 0, redis: r2 ?? 0, rabbitmq: q2 ?? 0 }],
    ]);
  });

  afterEach(async () => {
    await new Promise<void>((done) => socketServer.close(() => done()));
  });

  const slotRunner = (): FakeSlotRunner => fakeSlotRunner((n) => ports.get(n) ?? { postgres: 1, redis: 1, rabbitmq: 1 });

  const slotLines = async (
    runner: FakeSlotRunner,
    options: { env?: Record<string, string | null>; port?: number | null; socket?: string } = {},
  ): Promise<{ lines: string[]; out: string }> => {
    const configPath = await writeConfig(dir, {
      dataDir: repo.dataDir,
      overlayDir: repo.overlayDir,
      promptPath: repo.promptPath,
      fetchUrl: repo.repo,
      port: options.port ?? null,
      serverPort: await freeTcpPort(),
      slots: { count: 2, socket: options.socket ?? socketPath, appPortBase, env: options.env ?? {} },
    });
    const { ctx, stdout } = makeContext({ factories: { codehostMcpSpec: fakeCodehostMcpSpec, slotRunner: runner.run, slotHelperPath: helper } });
    await buildProgram(ctx).parseAsync(["node", "steward", "--config", configPath, "doctor"]).catch(() => undefined);
    return { lines: stdout().split("\n").filter((line) => line.includes("] slot ")), out: stdout() };
  };

  it.skipIf(process.getuid?.() === 0)("checks the helper, the socket, every slot's ports and the env keys", async () => {
    const { lines } = await slotLines(slotRunner(), { env: { DB_PORT: "{{postgres}}", REDIS_URL: "redis://localhost:{{redis}}" } });

    const p1 = ports.get(1);
    const p2 = ports.get(2);
    expect(lines).toEqual([
      `[fail] slot helper: ${helper} is not owned by root; chown root:root ${helper}`,
      `[ok] slot socket: ${socketPath}: check ok`,
      `[ok] slot 1 ports: app ${appPortBase + 1}, postgres ${p1?.postgres}, redis ${p1?.redis}, rabbitmq ${p1?.rabbitmq} free`,
      `[ok] slot 2 ports: app ${appPortBase + 2}, postgres ${p2?.postgres}, redis ${p2?.redis}, rabbitmq ${p2?.rabbitmq} free`,
      "[fail] slot env keys: not in any overlay file: REDIS_URL; remove them from slots.env or sync the overlay",
    ]);
  });

  it("names a slot that is still up", async () => {
    const runner = slotRunner();
    runner.respond("status", { stdout: "steward-slot-1-postgres-1 Up 3 minutes\n" });
    const held = createServer();
    const postgres = ports.get(1)?.postgres ?? 0;
    await new Promise<void>((resolve) => held.listen(postgres, resolve));
    try {
      const { lines } = await slotLines(runner, { env: { DB_PORT: "{{postgres}}" } });
      expect(lines).toContain(`[fail] slot 1 ports: slot 1 is up (postgres ${postgres} in use); stop serve or run ${helper} down 1 as root`);
    } finally {
      await new Promise<void>((resolve) => held.close(() => resolve()));
    }
  });

  it("reports a missing socket with the unit to enable", async () => {
    const missing = join(dir, "missing.sock");
    const { lines } = await slotLines(slotRunner(), { socket: missing });
    expect(lines).toContain(`[fail] slot socket: ${missing} does not exist; systemctl enable --now steward-slot.socket (docs/ops.md, "Worker slots")`);
  });

  it("reports a path that is not a socket", async () => {
    const plain = join(dir, "plain-file");
    await writeFile(plain, "");
    const { lines } = await slotLines(slotRunner(), { socket: plain });
    expect(lines).toContain(`[fail] slot socket: ${plain} is not a socket`);
  });

  it("reports a failed check over the socket in the runner's own words", async () => {
    const runner = slotRunner();
    const reason = `cannot reach the slot helper at ${socketPath}: connect ECONNREFUSED ${socketPath}`;
    runner.respond("check", { exitCode: 1, stdout: "", output: reason });
    const { lines } = await slotLines(runner);
    expect(lines).toContain(`[fail] slot socket: check over ${socketPath} failed: ${reason}; see docs/ops.md, "Worker slots"`);
  });

  it("reports workspace.port next to slots as a config failure", async () => {
    const { out } = await slotLines(slotRunner(), { port: 4100 });
    expect(out.startsWith("[fail] config: ")).toBe(true);
    expect(out).toContain("workspace.port was replaced by slots.appPortBase (see docs/ops.md)");
  });
});
