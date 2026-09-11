import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireRunLock } from "../../src/core/lock.js";

let dataDir: string;

beforeEach(async () => {
  vi.restoreAllMocks();
  dataDir = await mkdtemp(join(tmpdir(), "steward-lock-"));
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

describe("acquireRunLock", () => {
  it("acquires the lock on a fresh data dir", () => {
    const lock = acquireRunLock(dataDir);
    expect(lock).not.toBeNull();
    lock?.release();
  });

  it("returns null while the lock is held", () => {
    const first = acquireRunLock(dataDir);
    expect(acquireRunLock(dataDir)).toBeNull();
    first?.release();
  });

  it("acquires again after release", () => {
    const first = acquireRunLock(dataDir);
    first?.release();
    const second = acquireRunLock(dataDir);
    expect(second).not.toBeNull();
    second?.release();
  });

  it("reclaims a lock left by a dead process", async () => {
    const exited = spawnSync(process.execPath, ["-e", "0"]);
    await writeFile(join(dataDir, "run.lock"), String(exited.pid));
    const lock = acquireRunLock(dataDir);
    expect(lock).not.toBeNull();
    lock?.release();
  });

  it("reclaims a lock file with unreadable content", async () => {
    await writeFile(join(dataDir, "run.lock"), "garbage");
    const lock = acquireRunLock(dataDir);
    expect(lock).not.toBeNull();
    lock?.release();
  });
});
