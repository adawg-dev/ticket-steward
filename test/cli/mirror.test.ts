import { rm } from "node:fs/promises";
import { join } from "node:path";
import { buildProgram } from "../../src/cli/program.js";
import { Mirror } from "../../src/workspace/mirror.js";
import { commitFile, makeSourceRepo, tmpDir } from "../workspace/helpers.js";
import { makeContext, tmpConfigDir, writeConfig } from "./helpers.js";

let dir: string;
let source: string;
let dataDir: string;
let configPath: string;

beforeEach(async () => {
  vi.restoreAllMocks();
  dir = await tmpConfigDir();
  source = (await makeSourceRepo(await tmpDir())).repo;
  dataDir = join(dir, "data");
  configPath = await writeConfig(dir, {
    dataDir,
    overlayDir: join(dir, "overlay"),
    promptPath: join(dir, "prompt.md"),
    fetchUrl: source,
    port: 4100,
    serverPort: 3020,
  });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  await rm(join(source, ".."), { recursive: true, force: true });
});

describe("steward mirror", () => {
  it("init creates the bare mirror under dataDir", async () => {
    const { ctx, stdout } = makeContext();
    await buildProgram(ctx).parseAsync(["node", "steward", "--config", configPath, "mirror", "init"]);

    const mirror = new Mirror(join(dataDir, "repo.git"), source);
    expect(stdout()).toBe(`mirror created at ${join(dataDir, "repo.git")}\n`);
    expect(mirror.exists()).toBe(true);
    expect(await mirror.hasWorktreeConfigExtension()).toBe(true);
  });

  it("fetch picks up a new commit and prints the base branch sha", async () => {
    await buildProgram(makeContext().ctx).parseAsync(["node", "steward", "--config", configPath, "mirror", "init"]);
    const sha = await commitFile(source, "new.txt", "new\n");

    const { ctx, stdout } = makeContext();
    await buildProgram(ctx).parseAsync(["node", "steward", "--config", configPath, "mirror", "fetch"]);

    expect(stdout()).toBe(`main ${sha}\n`);
  });
});
