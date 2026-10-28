import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
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
  it("writes the config, env example, prompts and skills placeholder", async () => {
    const { ctx, stdout } = makeContext();
    await buildProgram(ctx).parseAsync(["node", "steward", "init", dir]);

    expect(existsSync(join(dir, "steward.config.ts"))).toBe(true);
    expect(existsSync(join(dir, ".env.example"))).toBe(true);
    expect(existsSync(join(dir, "skills", "README.md"))).toBe(true);
    expect(await readFile(join(dir, "prompts", "implement.md"), "utf8")).toBe(await readFile(resolve("prompts/implement.md"), "utf8"));
    expect(await readFile(join(dir, "prompts", "fix.md"), "utf8")).toBe(await readFile(resolve("prompts/fix.md"), "utf8"));
    expect(await readFile(join(dir, ".env.example"), "utf8")).toBe(await readFile(resolve(".env.example"), "utf8"));
    expect(await readFile(join(dir, ".env.example"), "utf8")).toMatch(/^LINEAR_API_KEY=$/m);
    expect(await readFile(join(dir, ".env.example"), "utf8")).not.toContain("LINEAR_CLIENT_");
    expect((await readFile(join(dir, "steward.config.ts"), "utf8")).startsWith('import { defineConfig } from "ticket-steward";')).toBe(true);
    expect(stdout()).toBe(
      [`wrote ${join(dir, "steward.config.ts")}`, `wrote ${join(dir, ".env.example")}`, `wrote ${join(dir, "prompts", "implement.md")}`, `wrote ${join(dir, "skills", "README.md")}`, `wrote ${join(dir, "prompts", "fix.md")}`, ""].join("\n"),
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
        `  ${join(dir, "prompts", "implement.md")}`,
        `  ${join(dir, "skills", "README.md")}`,
        "",
      ].join("\n"),
    );
  });

  it("keeps an existing prompts/fix.md instead of refusing", async () => {
    await mkdir(join(dir, "prompts"), { recursive: true });
    await writeFile(join(dir, "prompts", "fix.md"), "mine");

    await buildProgram(makeContext().ctx).parseAsync(["node", "steward", "init", dir]);

    expect(await readFile(join(dir, "prompts", "fix.md"), "utf8")).toBe("mine");
  });

  it("generates a config that loads", async () => {
    const { ctx } = makeContext();
    await buildProgram(ctx).parseAsync(["node", "steward", "init", dir]);
    // As an operator would: .env.example copied to .env and the push token filled in.
    await writeFile(join(dir, ".env"), "GITLAB_PUSH_TOKEN=glpat-push-token-value\n");

    const loaded = await ctx.loadConfig({ cwd: dir });

    expect(loaded.config.implement?.prompt).toBe(join(dir, "prompts", "implement.md"));
    expect(loaded.config.workspace.skillsDir).toBe(join(dir, "skills"));
  });
});
