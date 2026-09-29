import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { BackgroundProcesses, expandVars } from "../../../src/brain/tools/processes.js";
import { removeDir, tmpDir } from "../../workspace/helpers.js";

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const waitFor = async (check: () => Promise<boolean> | boolean, timeoutMs = 5_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
};

describe("expandVars", () => {
  it("expands $NAME and ${NAME} for known names only", () => {
    const vars = { STEWARD_PORT: "4100", ARTIFACTS_DIR: "/data/jobs/7/artifacts" };

    expect(expandVars("http://localhost:$STEWARD_PORT/", vars)).toBe("http://localhost:4100/");
    expect(expandVars("${ARTIFACTS_DIR}/next-dev.log", vars)).toBe("/data/jobs/7/artifacts/next-dev.log");
    expect(expandVars("$HOME/$STEWARD_PORTX", vars)).toBe("$HOME/$STEWARD_PORTX");
  });
});

describe("BackgroundProcesses", () => {
  let root: string;
  let processes: BackgroundProcesses;

  beforeEach(async () => {
    root = await tmpDir();
    processes = new BackgroundProcesses(root, join(root, "artifacts"));
  });

  afterEach(async () => {
    await processes.stopAll();
    await removeDir(root);
  });

  it("keeps a process running past the call and logs its output", async () => {
    const started = await processes.start("server", "sh", ["-c", "echo ready; sleep 30"]);

    expect(started.pid).toBeGreaterThan(0);
    await waitFor(async () => (await readFile(started.logPath, "utf8")).includes("ready"));
    expect(await processes.status("server")).toMatch(/^running \(pid \d+\)\n[\s\S]*ready/);
  });

  it("stops the whole process tree", async () => {
    const started = await processes.start("tree", "sh", ["-c", "sleep 30 & echo $! > child.pid; wait"]);
    await waitFor(async () => (await readFile(join(root, "child.pid"), "utf8").catch(() => "")).trim() !== "");
    const child = Number((await readFile(join(root, "child.pid"), "utf8")).trim());

    expect(await processes.stop("tree")).toMatch(/^stopped tree/);
    await waitFor(() => !alive(started.pid) && !alive(child));
  });

  it("reports how a process exited", async () => {
    await processes.start("quick", "sh", ["-c", "echo boom; exit 3"]);

    await waitFor(async () => (await processes.status("quick")).startsWith("exited"));
    expect(await processes.status("quick")).toMatch(/^exited with code 3\n[\s\S]*boom/);
  });

  it("refuses a duplicate name, an invalid name and more than four processes", async () => {
    await processes.start("a", "sleep", ["30"]);

    await expect(processes.start("a", "sleep", ["30"])).rejects.toThrow("a process named a is already running");
    await expect(processes.start("../x", "sleep", ["30"])).rejects.toThrow("invalid process name");
    await processes.start("b", "sleep", ["30"]);
    await processes.start("c", "sleep", ["30"]);
    await processes.start("d", "sleep", ["30"]);
    await expect(processes.start("e", "sleep", ["30"])).rejects.toThrow("at most 4 background processes");
  });

  it("stopAll stops everything that is still running", async () => {
    const one = await processes.start("one", "sleep", ["30"]);
    const two = await processes.start("two", "sleep", ["30"]);

    await processes.stopAll();

    await waitFor(() => !alive(one.pid) && !alive(two.pid));
  });

  it("reports an unknown process", async () => {
    expect(await processes.status("nope")).toBe("no process named nope");
    expect(await processes.stop("nope")).toBe("no process named nope");
  });
});
