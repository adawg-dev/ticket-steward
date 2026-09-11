import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, readdir, utimes, writeFile } from "node:fs/promises";
import { createServer, type AddressInfo } from "node:net";
import { join } from "node:path";

import { freePort, isPortFree, sweep } from "../../src/workspace/index.js";
import { removeDir, tmpDir } from "./helpers.js";

const DAY_MS = 24 * 60 * 60 * 1000;

const makeDir = async (path: string, ageDays: number): Promise<string> => {
  await mkdir(path, { recursive: true });
  await writeFile(join(path, "file.txt"), "x");
  const at = new Date(Date.now() - ageDays * DAY_MS);
  await utimes(path, at, at);
  return path;
};

const listen = (port: number): Promise<{ port: number; close: () => Promise<void> }> =>
  new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(port, () => {
      const { port: bound } = server.address() as AddressInfo;
      resolve({ port: bound, close: () => new Promise((done) => server.close(() => done())) });
    });
  });

describe("sweep", () => {
  let root: string;
  let workRoot: string;
  let jobsDir: string;

  beforeEach(async () => {
    vi.restoreAllMocks();
    root = await tmpDir();
    workRoot = join(root, "work");
    jobsDir = join(root, "jobs");
    await mkdir(workRoot);
    await mkdir(jobsDir);
  });

  afterEach(async () => {
    await removeDir(root);
  });

  it("keeps the newest N worktrees and removes the rest, oldest first", async () => {
    await makeDir(join(workRoot, "1-1"), 5);
    await makeDir(join(workRoot, "2-1"), 4);
    await makeDir(join(workRoot, "3-1"), 3);
    await makeDir(join(workRoot, "4-1"), 2);

    const result = await sweep({ workRoot, jobsDir, keptWorktrees: 2, days: 30, protect: [] });

    expect(result).toEqual({ removedWorktrees: [join(workRoot, "1-1"), join(workRoot, "2-1")], removedJobDirs: [] });
    expect(await readdir(workRoot)).toEqual(["3-1", "4-1"]);
  });

  it("never removes a protected worktree and does not count it against the kept number", async () => {
    await makeDir(join(workRoot, "1-1"), 5);
    await makeDir(join(workRoot, "2-1"), 4);
    await makeDir(join(workRoot, "3-1"), 3);

    const result = await sweep({ workRoot, jobsDir, keptWorktrees: 1, days: 30, protect: [join(workRoot, "1-1")] });

    expect(result).toEqual({ removedWorktrees: [join(workRoot, "2-1")], removedJobDirs: [] });
    expect(await readdir(workRoot)).toEqual(["1-1", "3-1"]);
  });

  it("removes job dirs older than the retention days", async () => {
    await makeDir(join(jobsDir, "7"), 31);
    await makeDir(join(jobsDir, "8"), 29);

    const result = await sweep({ workRoot, jobsDir, keptWorktrees: 3, days: 30, protect: [] });

    expect(result).toEqual({ removedWorktrees: [], removedJobDirs: [join(jobsDir, "7")] });
    expect(await readdir(jobsDir)).toEqual(["8"]);
  });

  it("tolerates missing work and jobs directories", async () => {
    const result = await sweep({ workRoot: join(root, "nope"), jobsDir: join(root, "nada"), keptWorktrees: 3, days: 30, protect: [] });

    expect(result).toEqual({ removedWorktrees: [], removedJobDirs: [] });
  });
});

/** A separate node process that listens on `port` and prints `ready` once bound. */
const listenInChild = (port: number): Promise<ChildProcess> =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, ["-e", `require("node:net").createServer().listen(${port}, "127.0.0.1", () => process.stdout.write("ready"))`], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    child.stdout?.once("data", () => resolve(child));
  });

describe("freePort", () => {
  it("kills the process holding the port and reports its pid", async () => {
    const probe = await listen(0);
    await probe.close();
    const holder = await listenInChild(probe.port);
    expect(await isPortFree(probe.port)).toBe(false);

    const result = await freePort(probe.port);

    expect(result).toEqual({ killed: [holder.pid] });
    await vi.waitFor(async () => expect(await isPortFree(probe.port)).toBe(true));
  });

  it("reports nothing killed for a free port", async () => {
    const probe = await listen(0);
    await probe.close();

    expect(await freePort(probe.port)).toEqual({ killed: [] });
  });
});

describe("isPortFree", () => {
  it("is true for a port nothing listens on", async () => {
    const probe = await listen(0);
    await probe.close();

    expect(await isPortFree(probe.port)).toBe(true);
  });

  it("is false while a server holds the port", async () => {
    const held = await listen(0);

    expect(await isPortFree(held.port)).toBe(false);

    await held.close();
  });
});
