import { closeSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";

const LOCK_FILE = "run.lock";

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const readHolderPid = (lockPath: string): number => {
  try {
    return Number.parseInt(readFileSync(lockPath, "utf8"), 10);
  } catch {
    return Number.NaN;
  }
};

const tryCreate = (lockPath: string): { release: () => void } | null => {
  try {
    const fd = openSync(lockPath, "wx", 0o600);
    writeSync(fd, String(process.pid));
    closeSync(fd);
    return { release: () => unlinkSync(lockPath) };
  } catch {
    return null;
  }
};

export const acquireRunLock = (dataDir: string): { release: () => void } | null => {
  const lockPath = join(dataDir, LOCK_FILE);
  const lock = tryCreate(lockPath);
  if (lock !== null) return lock;
  const holder = readHolderPid(lockPath);
  if (!Number.isNaN(holder) && isAlive(holder)) return null;
  try {
    unlinkSync(lockPath);
  } catch {
    // another process cleared the stale lock first; tryCreate below decides who won
  }
  return tryCreate(lockPath);
};
