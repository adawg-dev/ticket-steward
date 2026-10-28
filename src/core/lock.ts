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

/**
 * When the kernel started `pid`, in clock ticks since boot (field 22 of /proc/<pid>/stat), or null off Linux. A pid
 * alone is not enough in a container: a restarted container numbers its processes from 1 again, so the new steward
 * often gets the dead holder's pid and would otherwise see the lock as held by a live process (itself).
 */
const processStart = (pid: number): string | null => {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    // The command name (field 2) is in parentheses and may contain spaces; field 3 starts after the last ")".
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] ?? null;
  } catch {
    return null;
  }
};

/** `<pid> <start>`, or `<pid>` alone when the start time is unknown (an older steward or no /proc). */
const readHolder = (lockPath: string): { pid: number; start: string | undefined } => {
  try {
    const [pid, start] = readFileSync(lockPath, "utf8").trim().split(" ");
    return { pid: Number.parseInt(pid ?? "", 10), start };
  } catch {
    return { pid: Number.NaN, start: undefined };
  }
};

const isHeld = ({ pid, start }: { pid: number; start: string | undefined }): boolean => {
  if (Number.isNaN(pid) || !isAlive(pid)) return false;
  if (start === undefined) return true;
  const current = processStart(pid);
  return current === null || current === start;
};

const tryCreate = (lockPath: string): { release: () => void } | null => {
  try {
    const fd = openSync(lockPath, "wx", 0o600);
    const start = processStart(process.pid);
    writeSync(fd, start === null ? String(process.pid) : `${process.pid} ${start}`);
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
  if (isHeld(readHolder(lockPath))) return null;
  try {
    unlinkSync(lockPath);
  } catch {
    // another process cleared the stale lock first; tryCreate below decides who won
  }
  return tryCreate(lockPath);
};
