import { existsSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { buildProgram } from "../../src/cli/program.js";
import { ExitSignal, makeContext, tmpConfigDir } from "./helpers.js";

let dir: string;

beforeEach(async () => {
  vi.restoreAllMocks();
  dir = await tmpConfigDir();
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("steward init", () => {
  it("writes the config, env example, prompt and skills placeholder", async () => {
    const { ctx, stdout } = makeContext();
    await buildProgram(ctx).parseAsync(["node", "steward", "init", dir]);

    expect(existsSync(join(dir, "steward.config.ts"))).toBe(true);
    expect(existsSync(join(dir, ".env.example"))).toBe(true);
    expect(existsSync(join(dir, "skills", "README.md"))).toBe(true);
    expect(await readFile(join(dir, "prompts", "enrich.md"), "utf8")).toBe(await readFile(resolve("prompts/enrich.md"), "utf8"));
    expect(await readFile(join(dir, ".env.example"), "utf8")).toBe(await readFile(resolve(".env.example"), "utf8"));
    expect((await readFile(join(dir, "steward.config.ts"), "utf8")).startsWith('import { defineConfig } from "ticket-steward";')).toBe(true);
    expect(stdout()).toBe(
      [`wrote ${join(dir, "steward.config.ts")}`, `wrote ${join(dir, ".env.example")}`, `wrote ${join(dir, "prompts", "enrich.md")}`, `wrote ${join(dir, "skills", "README.md")}`, ""].join("\n"),
    );
  });

  it("refuses to overwrite existing files and lists them", async () => {
    await buildProgram(makeContext().ctx).parseAsync(["node", "steward", "init", dir]);
    const { ctx, stderr } = makeContext();

    await expect(buildProgram(ctx).parseAsync(["node", "steward", "init", dir])).rejects.toEqual(new ExitSignal(1));

    expect(stderr()).toBe(
      [
        "refusing to overwrite existing files:",
        `  ${join(dir, "steward.config.ts")}`,
        `  ${join(dir, ".env.example")}`,
        `  ${join(dir, "prompts", "enrich.md")}`,
        `  ${join(dir, "skills", "README.md")}`,
        "",
      ].join("\n"),
    );
  });

  it("generates a config that loads", async () => {
    const { ctx } = makeContext();
    await buildProgram(ctx).parseAsync(["node", "steward", "init", dir]);

    const loaded = await ctx.loadConfig({ cwd: dir });

    expect(loaded.config.prompt).toBe(join(dir, "prompts", "enrich.md"));
    expect(loaded.config.workspace.skillsDir).toBe(join(dir, "skills"));
  });
});
