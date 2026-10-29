import { afterEach, describe, expect, it, vi } from "vitest";
import { logger } from "../../src/log.js";
import { lazyOrbitQuery, ORBIT_PROBE_QUERY, orbitCount, probeOrbitQuery } from "../../src/orbit/query.js";
import type { OrbitExec, OrbitRun } from "../../src/orbit/run.js";
import { orbitRemote } from "../../src/orbit/server.js";

const gitlab = { kind: "gitlab" as const, baseUrl: "https://gitlab.example.com", project: "acme/app" };
const FAKE_TOKEN = "glpat-fake-orbit-token";
const COUNT = (n: number): string => JSON.stringify({ result: { query_type: "aggregation", rows: [{ n }] }, row_count: 1 });

const fakeExec = (runs: Array<Partial<OrbitRun>>) => {
  const calls: Array<{ args: string[]; cwd: string }> = [];
  const exec: OrbitExec = async (args, opts) => {
    calls.push({ args, cwd: opts.cwd });
    const run = runs.shift() ?? {};
    return { exitCode: 0, stdout: "", stderr: "", timedOut: false, ...run };
  };
  return { exec, calls };
};

const remoteWith = (exec: OrbitExec, token: string | null = FAKE_TOKEN) =>
  orbitRemote({ exec, dataDir: "/data", worktreePath: "/data", codehost: gitlab, secrets: token === null ? {} : { GITLAB_TOKEN: token } });

afterEach(() => {
  vi.restoreAllMocks();
});

describe("probeOrbitQuery", () => {
  it("returns a query function once the probe answers, which runs raw queries and parses their JSON", async () => {
    const { exec, calls } = fakeExec([{ stdout: COUNT(0) }, { stdout: COUNT(3) }]);

    const query = await probeOrbitQuery(remoteWith(exec));

    expect(query).not.toBeNull();
    expect(orbitCount(await query?.("MATCH (j:Job) RETURN count(j) AS n"))).toBe(3);
    expect(calls.map((call) => call.args)).toEqual([
      ["query", "--response-format", "raw", "--", ORBIT_PROBE_QUERY],
      ["query", "--response-format", "raw", "--", "MATCH (j:Job) RETURN count(j) AS n"],
    ]);
  });

  it("is null, without throwing, when the remote answers 403, and says so in one warning without the token", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    const { exec } = fakeExec([{ exitCode: 1, stderr: `HTTP 403 Forbidden for token ${FAKE_TOKEN}` }]);

    expect(await probeOrbitQuery(remoteWith(exec))).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(warn.mock.calls[0])).not.toContain(FAKE_TOKEN);
    expect(JSON.stringify(warn.mock.calls[0])).toContain("403");
  });

  it("is null when there is no token, without running Orbit", async () => {
    vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    const { exec, calls } = fakeExec([]);

    expect(await probeOrbitQuery(remoteWith(exec, null))).toBeNull();
    expect(calls).toEqual([]);
  });

  it("throws from a query whose run fails after the probe, so the caller can drop that signal", async () => {
    const { exec } = fakeExec([{ stdout: COUNT(0) }, { exitCode: 2, stderr: "bad query" }]);

    const query = await probeOrbitQuery(remoteWith(exec));

    await expect(query?.("MATCH (x) RETURN x")).rejects.toThrow("bad query");
  });
});

describe("lazyOrbitQuery", () => {
  it("probes on first use only, and a failed probe stays null with one warning", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    const { exec, calls } = fakeExec([{ exitCode: 1, stderr: "403 Forbidden" }]);
    const orbit = lazyOrbitQuery(remoteWith(exec));

    expect(calls).toEqual([]);
    expect(await orbit()).toBeNull();
    expect(await orbit()).toBeNull();
    expect(calls).toHaveLength(1);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe("orbitCount", () => {
  it("reads the first row's count, and null from anything else", () => {
    expect(orbitCount(JSON.parse(COUNT(4)))).toBe(4);
    expect(orbitCount({ result: { rows: [] } })).toBeNull();
    expect(orbitCount("nope")).toBeNull();
  });
});
