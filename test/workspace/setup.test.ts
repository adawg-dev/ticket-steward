import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { runSetup } from "../../src/workspace/index.js";
import { removeDir, tmpDir } from "./helpers.js";

const env = { PATH: process.env.PATH ?? "/usr/bin:/bin" };

describe("runSetup", () => {
  let cwd: string;

  beforeEach(async () => {
    vi.restoreAllMocks();
    cwd = await tmpDir();
  });

  afterEach(async () => {
    await removeDir(cwd);
  });

  it("runs every command in the cwd with the given env and returns ok with the output tail", async () => {
    const result = await runSetup(["echo one", "echo $STEWARD_MARK > mark.txt", "echo two 1>&2"], cwd, { ...env, STEWARD_MARK: "set" }, {
      timeoutMs: 10_000,
      tailBytes: 16_384,
    });

    expect(result.ok).toBe(true);
    expect(result.tail).toBe("$ echo one\none\n$ echo $STEWARD_MARK > mark.txt\n$ echo two 1>&2\ntwo\n");
    expect(await readFile(join(cwd, "mark.txt"), "utf8")).toBe("set\n");
  });

  it("returns ok false on a non-zero exit and stops running further commands", async () => {
    const result = await runSetup(["echo first", "exit 3", "echo never > never.txt"], cwd, env, {
      timeoutMs: 10_000,
      tailBytes: 16_384,
    });

    expect(result.ok).toBe(false);
    expect(result.tail).toBe("$ echo first\nfirst\n$ exit 3\n[exit 3]\n");
    await expect(readFile(join(cwd, "never.txt"), "utf8")).rejects.toThrow();
  });

  it("returns ok false when the timeout elapses", async () => {
    const result = await runSetup(["sleep 5"], cwd, env, { timeoutMs: 300, tailBytes: 16_384 });

    expect(result.ok).toBe(false);
    expect(result.tail).toBe("$ sleep 5\n[timed out]\n");
  });

  it("shares one deadline across all commands", async () => {
    const started = Date.now();

    const result = await runSetup(["sleep 0.7", "sleep 5"], cwd, env, { timeoutMs: 1_000, tailBytes: 16_384 });

    expect(result.ok).toBe(false);
    expect(result.tail).toBe("$ sleep 0.7\n$ sleep 5\n[timed out]\n");
    expect(Date.now() - started).toBeLessThan(1_500);
  });

  it("returns ok false with an interrupted marker when the signal aborts", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 200);

    const result = await runSetup(["sleep 5", "echo never > never.txt"], cwd, env, { timeoutMs: 10_000, tailBytes: 16_384, signal: controller.signal });

    expect(result).toEqual({ ok: false, tail: "$ sleep 5\n[interrupted]\n" });
    await expect(readFile(join(cwd, "never.txt"), "utf8")).rejects.toThrow();
  });

  it("caps the tail to the last tailBytes bytes", async () => {
    const result = await runSetup(["printf abcdefghij"], cwd, env, { timeoutMs: 10_000, tailBytes: 4 });

    expect(result).toEqual({ ok: true, tail: "ghij" });
  });

  it("does not inherit the parent's environment", async () => {
    const result = await runSetup(["env"], cwd, { PATH: env.PATH, ONLY_THIS: "1" }, { timeoutMs: 10_000, tailBytes: 16_384 });

    expect(result.ok).toBe(true);
    expect(result.tail).not.toContain("HOME=");
    expect(result.tail).toContain("ONLY_THIS=1\n");
  });
});
