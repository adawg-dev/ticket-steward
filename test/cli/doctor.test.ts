import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { buildProgram } from "../../src/cli/program.js";
import type { McpServerSpec } from "../../src/brain/types.js";
import { FakeGitLabReview } from "../fakes/fakeGitLabReview.js";
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
  describe("gitlab review checks", () => {
    const reviewDoctor = async (opts: { env: string; review?: { botUsername: string; prompt: string }; api?: FakeGitLabReview }): Promise<string> => {
      await writeFile(join(dir, ".env"), opts.env);
      const configPath = await writeConfig(dir, {
        dataDir: repo.dataDir,
        overlayDir: repo.overlayDir,
        promptPath: repo.promptPath,
        fetchUrl: repo.repo,
        port: await freeTcpPort(),
        serverPort: await freeTcpPort(),
        ...(opts.review === undefined ? {} : { review: opts.review }),
      });
      const { ctx, stdout } = makeContext({
        fetchImpl: linearFetch(() => new Response("{}", { status: 200 })),
        factories: { codehostMcpSpec: fakeCodehostMcpSpec, ...(opts.api === undefined ? {} : { review: opts.api }) },
      });
      await buildProgram(ctx).parseAsync(["node", "steward", "--config", configPath, "doctor"]).catch(() => undefined);
      return stdout();
    };
    const reviewEnv = `LINEAR_API_KEY=${API_KEY}\nLINEAR_WEBHOOK_SECRET=whsec\nGITLAB_TOKEN=glpat-token\nGITLAB_WEBHOOK_SECRET=gitlab-secret\n`;
    const reviewSettings = (botUsername: string): { botUsername: string; prompt: string } => ({ botUsername, prompt: join(dir, "review.md") });

    it("checks the GitLab review setup when review is configured", async () => {
      const output = await reviewDoctor({ env: reviewEnv, review: reviewSettings("steward-bot"), api: new FakeGitLabReview() });

      expect(output).toContain("[ok] gitlab webhook secret: GITLAB_WEBHOOK_SECRET present");
      expect(output).toContain("[ok] gitlab reviewer: GITLAB_TOKEN acts as steward-bot with the api scope");
    });

    it("fails when the token lacks the api scope or belongs to someone else", async () => {
      const review = new FakeGitLabReview();
      review.scopes = ["read_api"];
      const output = await reviewDoctor({ env: reviewEnv, review: reviewSettings("steward-bot"), api: review });
      expect(output).toContain("[fail] gitlab reviewer: GITLAB_TOKEN lacks the api scope; the steward cannot post review comments");

      const other = await reviewDoctor({ env: reviewEnv, review: reviewSettings("someone-else"), api: new FakeGitLabReview() });
      expect(other).toContain("[fail] gitlab reviewer: GITLAB_TOKEN acts as steward-bot, but review.botUsername is someone-else");
    });

    it("fails without any GitLab webhook secret", async () => {
      const output = await reviewDoctor({
        env: `LINEAR_API_KEY=${API_KEY}\nLINEAR_WEBHOOK_SECRET=whsec\nGITLAB_TOKEN=glpat-token\n`,
        review: reviewSettings("steward-bot"),
        api: new FakeGitLabReview(),
      });

      expect(output).toContain("[fail] gitlab webhook secret: set GITLAB_WEBHOOK_SIGNING_TOKEN or GITLAB_WEBHOOK_SECRET");
    });

    it("fails when a signing token was put in GITLAB_WEBHOOK_SECRET", async () => {
      const output = await reviewDoctor({
        env: `LINEAR_API_KEY=${API_KEY}\nLINEAR_WEBHOOK_SECRET=whsec\nGITLAB_TOKEN=glpat-token\nGITLAB_WEBHOOK_SECRET=whsec_c2lnbmluZw==\n`,
        review: reviewSettings("steward-bot"),
        api: new FakeGitLabReview(),
      });

      expect(output).toContain("[fail] gitlab webhook secret: GITLAB_WEBHOOK_SECRET holds a whsec_ signing token; rename it to GITLAB_WEBHOOK_SIGNING_TOKEN");
    });

    it("skips the review checks when review is not configured", async () => {
      const output = await reviewDoctor({ env: reviewEnv, api: new FakeGitLabReview() });

      expect(output).not.toContain("gitlab reviewer");
      expect(output).not.toContain("gitlab webhook secret");
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
