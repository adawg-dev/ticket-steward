import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buildProgram } from "../../src/cli/program.js";
import { commitFile, git } from "../workspace/helpers.js";
import { makeContext, tmpConfigDir, writeConfig } from "./helpers.js";

let dir: string;
let checkout: string;
let overlayDir: string;
let configPath: string;

beforeEach(async () => {
  vi.restoreAllMocks();
  dir = await tmpConfigDir();
  checkout = join(dir, "checkout");
  overlayDir = join(dir, "overlay");
  await mkdir(checkout);
  await git(checkout, ["init", "-q", "-b", "main"]);
  await commitFile(checkout, ".gitignore", ".env*\n");
  await mkdir(join(checkout, "apps", "web"), { recursive: true });
  await writeFile(join(checkout, ".env"), "DATABASE_URL=postgres://steward:pw@localhost:5432/dev\n");
  await writeFile(join(checkout, "apps", "web", ".env.local"), "API_URL=https://api.prod.example\n");
  configPath = await writeConfig(dir, {
    dataDir: join(dir, "data"),
    overlayDir,
    promptPath: join(dir, "prompt.md"),
    fetchUrl: checkout,
    port: 4100,
    serverPort: 3020,
  });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("steward overlay sync", () => {
  it("copies gitignored env files and refuses prod-looking values", async () => {
    const { ctx, stdout } = makeContext();
    await buildProgram(ctx).parseAsync(["node", "steward", "--config", configPath, "overlay", "sync", "--from", checkout]);

    expect(stdout()).toBe("copied .env\nrefused apps/web/.env.local: API_URL matches a deny pattern\n");
    expect(await readFile(join(overlayDir, ".env"), "utf8")).toBe("DATABASE_URL=postgres://steward:pw@localhost:5432/dev\n");
  });

  it("accepts a refused value when an allow pattern matches it", async () => {
    const { ctx, stdout } = makeContext();
    await buildProgram(ctx).parseAsync([
      "node", "steward", "--config", configPath, "overlay", "sync", "--from", checkout, "--allow-pattern", "api\\.prod\\.example",
    ]);

    expect(stdout()).toBe("copied .env\ncopied apps/web/.env.local\n");
  });
});
