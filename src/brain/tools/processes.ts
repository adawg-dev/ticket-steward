import { spawn } from "node:child_process";
import { openSync, closeSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { execa } from "execa";

const MAX_PROCESSES = 4;
const STOP_GRACE_MS = 5_000;
const LOG_TAIL_LINES = 80;
const NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;

/** Replaces `$NAME` and `${NAME}` for the given names only; anything else is left as written. */
export const expandVars = (text: string, vars: Record<string, string>): string =>
  text.replace(/\$\{([A-Z_][A-Z0-9_]*)\}|\$([A-Z_][A-Z0-9_]*)/g, (match: string, braced: string | undefined, bare: string | undefined) => {
    const value = vars[braced ?? bare ?? ""];
    return value === undefined ? match : value;
  });

interface Entry {
  pid: number;
  logPath: string;
  exit: { code: number | null; signal: string | null } | null;
  exited: Promise<void>;
}

/** Every descendant of `root`, from one `ps` snapshot. */
const descendants = async (root: number): Promise<number[]> => {
  const { stdout } = await execa("ps", ["-e", "-o", "pid=,ppid="], { reject: false });
  const children = new Map<number, number[]>();
  for (const line of stdout.split("\n")) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    if (pid === undefined || ppid === undefined || Number.isNaN(pid) || Number.isNaN(ppid)) continue;
    children.set(ppid, [...(children.get(ppid) ?? []), pid]);
  }
  const found: number[] = [];
  const queue = [root];
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    for (const child of children.get(next) ?? []) {
      found.push(child);
      queue.push(child);
    }
  }
  return found;
};

const signal = (pids: number[], sig: NodeJS.Signals): void => {
  for (const pid of pids) {
    try {
      process.kill(pid, sig);
    } catch {
      // already gone
    }
  }
};

const tail = async (path: string): Promise<string> => {
  const text = await readFile(path, "utf8").catch(() => "");
  return text.split("\n").slice(-LOG_TAIL_LINES).join("\n");
};

/**
 * Long-lived processes the brain starts, such as a dev server. They are not detached, so they stay in the
 * runner's process group: the steward kills that group after every run, even when `stopAll` never gets to run.
 */
export class BackgroundProcesses {
  private readonly entries = new Map<string, Entry>();

  constructor(
    private readonly cwd: string,
    private readonly logDir: string,
  ) {}

  async start(name: string, command: string, args: string[]): Promise<{ pid: number; logPath: string }> {
    if (!NAME.test(name)) throw new Error("invalid process name: use lower-case letters, digits and dashes");
    const existing = this.entries.get(name);
    if (existing !== undefined && existing.exit === null) throw new Error(`a process named ${name} is already running`);
    const running = [...this.entries.values()].filter((entry) => entry.exit === null).length;
    if (running >= MAX_PROCESSES) throw new Error(`at most ${MAX_PROCESSES} background processes can run at once`);

    await mkdir(this.logDir, { recursive: true, mode: 0o700 });
    const logPath = join(this.logDir, `${name}.log`);
    const fd = openSync(logPath, "a", 0o600);
    const child = spawn(command, args, { cwd: this.cwd, stdio: ["ignore", fd, fd] });
    closeSync(fd);
    const pid = await new Promise<number>((resolve, reject) => {
      child.once("spawn", () => resolve(child.pid ?? 0));
      child.once("error", reject);
    });
    const entry: Entry = { pid, logPath, exit: null, exited: Promise.resolve() };
    entry.exited = new Promise<void>((resolve) => {
      child.once("exit", (code, sig) => {
        entry.exit = { code, signal: sig };
        resolve();
      });
    });
    this.entries.set(name, entry);
    return { pid, logPath };
  }

  async status(name: string): Promise<string> {
    const entry = this.entries.get(name);
    if (entry === undefined) return `no process named ${name}`;
    const state =
      entry.exit === null
        ? `running (pid ${entry.pid})`
        : entry.exit.code === null
          ? `exited on signal ${entry.exit.signal ?? "unknown"}`
          : `exited with code ${entry.exit.code}`;
    return `${state}\n${await tail(entry.logPath)}`;
  }

  /** SIGTERM to the process and everything it started, then SIGKILL to whatever is left after a grace period. */
  async stop(name: string): Promise<string> {
    const entry = this.entries.get(name);
    if (entry === undefined) return `no process named ${name}`;
    const tree = [entry.pid, ...(await descendants(entry.pid))];
    signal(tree, "SIGTERM");
    const graceful = await Promise.race([entry.exited.then(() => true), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), STOP_GRACE_MS))]);
    signal(tree, "SIGKILL");
    return `stopped ${name}${graceful ? "" : " (forced after 5 s)"}`;
  }

  async stopAll(): Promise<void> {
    const running = [...this.entries.entries()].filter(([, entry]) => entry.exit === null).map(([name]) => name);
    await Promise.all(running.map((name) => this.stop(name)));
  }
}
