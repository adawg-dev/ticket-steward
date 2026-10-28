import { ORBIT_OUTPUT_BYTES, ORBIT_TOOL_TIMEOUT_MS, orbitMcpSpec, orbitRemote, runOrbitTool, type OrbitRemote } from "../../src/orbit/server.js";
import type { OrbitExec, OrbitRun } from "../../src/orbit/run.js";

const gitlab = { kind: "gitlab" as const, baseUrl: "https://gitlab.example.com", project: "acme/app" };
const FAKE_TOKEN = "glpat-fake-orbit-token";

/** An exec that records its calls and answers with `run`. */
const fakeExec = (run: Partial<OrbitRun> | Error) => {
  const calls: Array<{ args: string[]; cwd: string; env: Record<string, string>; timeoutMs: number }> = [];
  const exec: OrbitExec = async (args, opts) => {
    calls.push({ args, ...opts });
    if (run instanceof Error) throw run;
    return { exitCode: 0, stdout: "", stderr: "", timedOut: false, ...run };
  };
  return { exec, calls };
};

const remoteWith = (exec: OrbitExec): OrbitRemote => orbitRemote({ exec, dataDir: "/data", worktreePath: "/data/work/42-1", codehost: gitlab, secrets: { GITLAB_TOKEN: FAKE_TOKEN } });

describe("runOrbitTool", () => {
  it("runs Orbit in the worktree with the token in the child's env only and returns its output", async () => {
    const { exec, calls } = fakeExec({ stdout: "3 merge requests" });

    expect(await runOrbitTool(remoteWith(exec), ["query", "--", "MATCH (m) RETURN m"])).toEqual({ content: [{ type: "text", text: "3 merge requests" }] });
    expect(calls).toEqual([
      {
        args: ["query", "--", "MATCH (m) RETURN m"],
        cwd: "/data/work/42-1",
        env: expect.objectContaining({ GITLAB_TOKEN: FAKE_TOKEN, GITLAB_URL: "https://gitlab.example.com", ORBIT_DATA_DIR: "/data/orbit" }),
        timeoutMs: ORBIT_TOOL_TIMEOUT_MS,
      },
    ]);
  });

  it("returns a timeout as an unavailable error result", async () => {
    const { exec } = fakeExec({ exitCode: null, timedOut: true });
    expect(await runOrbitTool(remoteWith(exec), ["schema"])).toEqual({ content: [{ type: "text", text: "Orbit remote is unavailable: timed out after 60 s" }], isError: true });
  });

  it("returns a non-zero exit as an error result with Orbit's reason, the token masked", async () => {
    const { exec } = fakeExec({ exitCode: 1, stderr: `Orbit access denied for ${FAKE_TOKEN}\n` });
    expect(await runOrbitTool(remoteWith(exec), ["schema"])).toEqual({ content: [{ type: "text", text: "Orbit remote is unavailable: Orbit access denied for ***" }], isError: true });
  });

  it("falls back to stdout, then the exit code, for the reason", async () => {
    expect((await runOrbitTool(remoteWith(fakeExec({ exitCode: 2, stdout: "no schema" }).exec), ["schema"])).content[0]?.text).toBe("Orbit remote is unavailable: no schema");
    expect((await runOrbitTool(remoteWith(fakeExec({ exitCode: 3 }).exec), ["schema"])).content[0]?.text).toBe("Orbit remote is unavailable: orbit exited 3");
  });

  it("turns a thrown exec into an error result", async () => {
    const { exec } = fakeExec(new Error("spawn orbit ENOENT"));
    expect(await runOrbitTool(remoteWith(exec), ["schema"])).toEqual({ content: [{ type: "text", text: "Orbit remote is unavailable: spawn orbit ENOENT" }], isError: true });
  });

  it("truncates output past 64 KiB and says so", async () => {
    const { exec } = fakeExec({ stdout: "x".repeat(ORBIT_OUTPUT_BYTES + 10) });
    const text = (await runOrbitTool(remoteWith(exec), ["context", "--", "mr:1"])).content[0]?.text ?? "";
    expect(text.startsWith("x".repeat(ORBIT_OUTPUT_BYTES))).toBe(true);
    expect(text.slice(ORBIT_OUTPUT_BYTES)).toBe(`\n[output truncated at ${ORBIT_OUTPUT_BYTES} bytes; narrow the query]`);
  });

  it("never runs Orbit without a token or on a non-GitLab code host", async () => {
    const { exec, calls } = fakeExec({ stdout: "x" });
    const noToken = orbitRemote({ exec, dataDir: "/data", worktreePath: "/w", codehost: gitlab, secrets: {} });
    const github = orbitRemote({ exec, dataDir: "/data", worktreePath: "/w", codehost: { kind: "github", owner: "acme", repo: "app" }, secrets: { GITLAB_TOKEN: FAKE_TOKEN } });

    expect(await runOrbitTool(noToken, ["schema"])).toEqual({ content: [{ type: "text", text: "Orbit remote is unavailable: GITLAB_TOKEN is not set" }], isError: true });
    expect((await runOrbitTool(github, ["schema"])).content[0]?.text).toBe("Orbit remote is unavailable: the code host is not GitLab");
    expect(calls).toEqual([]);
  });
});

describe("orbitMcpSpec", () => {
  it("carries no secret on the command line or in the env", () => {
    const spec = orbitMcpSpec({ binPath: "/opt/steward/bin/steward.js", configPath: "/etc/steward/steward.config.ts", worktreePath: "/data/work/42-1" });
    expect(spec.args).toEqual(["/opt/steward/bin/steward.js", "mcp", "orbit", "--config", "/etc/steward/steward.config.ts", "--workspace", "/data/work/42-1"]);
    expect(Object.keys(spec.env ?? {}).sort()).toEqual(["HOME", "PATH"]);
  });
});
