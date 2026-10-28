import { spawnSync } from "node:child_process";
import { readFileSync, unlinkSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireRunLock } from "../../src/core/lock.js";

vi.mock("node:fs", { spy: true });

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

  // A restarted container numbers its processes from 1 again, so the new steward can get the old holder's pid.
  it.runIf(process.platform === "linux")("reclaims a lock whose pid is alive but was started after the holder", async () => {
    await writeFile(join(dataDir, "run.lock"), `${process.pid} 1`);
    const lock = acquireRunLock(dataDir);
    expect(lock).not.toBeNull();
    lock?.release();
  });

  it("treats a lock without a start time as held while its pid is alive", async () => {
    await writeFile(join(dataDir, "run.lock"), String(process.pid));
    expect(acquireRunLock(dataDir)).toBeNull();
  });

  it("reclaims a lock file with unreadable content", async () => {
    await writeFile(join(dataDir, "run.lock"), "garbage");
    const lock = acquireRunLock(dataDir);
    expect(lock).not.toBeNull();
    lock?.release();
  });

  it("still acquires when another process removes the stale lock between the read and the unlink", async () => {
    const exited = spawnSync(process.execPath, ["-e", "0"]);
    const lockPath = join(dataDir, "run.lock");
    await writeFile(lockPath, String(exited.pid));
    vi.mocked(readFileSync).mockImplementationOnce(() => {
      unlinkSync(lockPath);
      return String(exited.pid);
    });

    const lock = acquireRunLock(dataDir);

    expect(lock).not.toBeNull();
    expect(readFileSync(lockPath, "utf8").split(" ")[0]).toBe(String(process.pid));
    lock?.release();
  });
});
