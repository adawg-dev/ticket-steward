import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { buildProgram } from "../../src/cli/program.js";
import type { McpServerSpec } from "../../src/brain/types.js";
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

const authBrokenFetch: typeof fetch = async () => new Response(JSON.stringify({ ok: false, authBroken: true }), { status: 503 });

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
    await writeFile(join(dir, ".env"), "LINEAR_CLIENT_ID=id\nLINEAR_CLIENT_SECRET=secret\nLINEAR_WEBHOOK_SECRET=whsec\nGITLAB_TOKEN=glpat-token\nANTHROPIC_API_KEY=sk-ant-key\n");
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
    const { ctx, stdout } = makeContext({ fetchImpl: authBrokenFetch, factories: { codehostMcpSpec: fakeCodehostMcpSpec } });

    await expect(buildProgram(ctx).parseAsync(["node", "steward", "--config", configPath, "doctor"])).rejects.toEqual(new ExitSignal(1));

    const lines = stdout().trimEnd().split("\n");
    expect(lines[0]).toBe(`[ok] config: ${configPath}`);
    expect(lines[1]).toBe("[ok] tracker secrets: LINEAR_CLIENT_ID, LINEAR_CLIENT_SECRET, LINEAR_WEBHOOK_SECRET present");
    expect(lines[2]).toBe("[ok] brain credential: claude-code credential present");
    expect(lines[3]).toBe("[ok] codehost token: GITLAB_TOKEN present");
    expect(lines[4]).toBe("[warn] mirror token: MIRROR_TOKEN missing; fetchUrl must be reachable anonymously");
    expect(lines[5]).toBe(`[warn] running user: owns ${join(home, ".ssh")}; run the steward as a dedicated user`);
    expect(lines[6]).toBe(`[ok] dataDir mode: ${repo.dataDir} is 0700`);
    expect(lines[7]).toBe(`[ok] overlayDir mode: ${repo.overlayDir} is 0700`);
    expect(lines[8]).toBe(`[ok] mirror: ${join(repo.dataDir, "repo.git")} fetched; main@${repo.sha.slice(0, 7)}`);
    expect(lines[9]).toBe("[ok] overlay: 1 file(s)");
    expect(lines[10]).toBe(`[ok] skills: ${skillsDir}`);
    expect(lines[11]).toBe("[fail] linear token: no token stored; run steward auth linear");
    expect(lines[12]).toBe("[ok] auth_broken: clear");
    expect(lines[13]).toBe("[fail] public url: https://steward.example/health answered 503");
    expect(lines[14]).toBe("[ok] codehost mcp: tools: recent_changes, permalink");
    expect(lines[15]?.startsWith("[ok] playwright mcp: ")).toBe(true);
    expect(lines[16]).toBe(`[ok] chromium: ${join(browsers, "chromium-1000")}`);
    expect(lines[17]).toBe(`[ok] port: ${port} is free`);
    expect(lines.length).toBe(18);
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

    expect(stdout().trimEnd().split("\n")[16]).toBe(`[fail] chromium: no chromium under ${browsers}; run npx playwright install chromium`);
  });
});
