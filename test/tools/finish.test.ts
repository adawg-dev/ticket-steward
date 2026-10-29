import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RunSpec } from "../../src/run/protocol.js";
import { postWork, toolsWork } from "../../src/tools/finish.js";
import { commitFile, git, makeSourceRepo, removeDir, tmpDir } from "../workspace/helpers.js";

let root: string;
let worktree: string;
let start: string;

const specAt = (sha: string): RunSpec => ({
  version: 1,
  runId: "7-1",
  jobId: 7,
  kind: "implement",
  identifier: "API-1",
  issueId: "issue-1",
  checkout: { ref: null, sha },
  baseSha: sha,
  worktreePath: worktree,
  artifactsDir: join(root, "artifacts"),
  transcriptPath: join(root, "transcript.jsonl"),
  prompt: "",
  personCommits: null,
  output: "implement",
  resumeSessionId: null,
  limits: { timeoutMinutes: 60, maxTurns: 200, setupTimeoutMinutes: 20 },
  push: null,
  setup: [],
  checks: [],
  interactive: false,
});

beforeEach(async () => {
  root = await tmpDir();
  const { repo } = await makeSourceRepo(root);
  worktree = join(root, "work", "ticket-API-1");
  await mkdir(join(root, "work"));
  await git(root, ["clone", "-q", repo, worktree]);
  start = await git(worktree, ["rev-parse", "HEAD"]);
});

afterEach(async () => {
  await removeDir(root);
});

describe("toolsWork", () => {
  it("reports commits after the start and uncommitted paths, leaving out the steward's files", async () => {
    await commitFile(worktree, "src/a.ts", "a\n");
    await writeFile(join(worktree, "notes.md"), "draft\n");
    await writeFile(join(worktree, ".env"), "KEY=x\n");

    const work = await toolsWork({ spec: specAt(start), pushedSha: null, guard: () => Promise.resolve({ stewardFiles: [".env"], secrets: [] }) });

    expect(work.runId).toBe("7-1");
    expect(work.pushedSha).toBeNull();
    expect(work.unpushed).toContain("uncommitted:\n  notes.md");
    expect(work.unpushed).toContain("add src/a.ts");
    expect(work.unpushed).not.toContain(".env");
  });

  it("is empty after a push of everything", async () => {
    const sha = await commitFile(worktree, "src/a.ts", "a\n");

    expect(await toolsWork({ spec: specAt(start), pushedSha: sha, guard: () => Promise.resolve({ stewardFiles: [], secrets: [] }) })).toEqual({ runId: "7-1", unpushed: "", pushedSha: sha });
  });

  it("counts a worktree it cannot read as unpushed work", async () => {
    await removeDir(worktree);

    const work = await toolsWork({ spec: specAt(start), pushedSha: null, guard: () => Promise.resolve({ stewardFiles: [], secrets: [] }) });

    expect(work.unpushed).toMatch(/^the worktree could not be read: /);
  });
});

describe("postWork", () => {
  let server: Server;
  let baseUrl: string;
  let statuses: number[];
  const quick = { retryForMs: 5_000, backoffMs: { first: 10, max: 20 } };
  const seen: Array<{ url: string; authorization: string | undefined; body: string }> = [];

  beforeEach(async () => {
    statuses = [204];
    seen.length = 0;
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
      req.on("end", () => {
        seen.push({ url: req.url ?? "", authorization: req.headers.authorization, body });
        // The answers in turn, the last one repeated.
        res.writeHead(statuses[Math.min(seen.length, statuses.length) - 1] ?? 204).end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("posts the report to the run's work route with the tools token", async () => {
    const work = { runId: "7-1", unpushed: "", pushedSha: null };

    await postWork({ baseUrl, token: "tools-token-value", work });

    expect(seen).toEqual([{ url: "/internal/runs/7-1/work", authorization: "Bearer tools-token-value", body: JSON.stringify(work) }]);
  });

  it("keeps trying while the dispatcher answers 503 (restarting), and delivers the report once it is back", async () => {
    statuses = [503, 503, 200];
    const work = { runId: "7-1", unpushed: "", pushedSha: "a".repeat(40) };
    const warnings: string[] = [];

    await postWork({ baseUrl, token: "tools-token-value", work, warn: (message) => warnings.push(message), ...quick });

    expect(seen.map((s) => s.url)).toEqual(["/internal/runs/7-1/work", "/internal/runs/7-1/work", "/internal/runs/7-1/work"]);
    expect(JSON.parse(seen[2]?.body ?? "")).toEqual(work);
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain("the work report was not delivered (the steward answered 503)");
  });

  it("keeps trying while the dispatcher refuses connections", async () => {
    let calls = 0;
    // The first attempt finds nothing listening: a real connection refused.
    const fetchImpl: typeof fetch = (input, init) => (calls++ === 0 ? fetch("http://127.0.0.1:1/internal/runs/7-1/work", init) : fetch(input, init));

    await postWork({ baseUrl, token: "tools-token-value", work: { runId: "7-1", unpushed: "", pushedSha: null }, fetchImpl, ...quick });

    expect(calls).toBe(2);
    expect(seen).toHaveLength(1);
  });

  it("fails at once on 401 (the tools token rejected) and on 400", async () => {
    for (const [status, message] of [[401, "the run's tools token was rejected"], [400, "the steward answered 400 to the work report"]] as const) {
      statuses = [status];
      seen.length = 0;
      await expect(postWork({ baseUrl, token: "tools-token-value", work: { runId: "7-1", unpushed: "", pushedSha: null }, ...quick })).rejects.toThrow(message);
      expect(seen).toHaveLength(1);
    }
  });

  it("gives up when the dispatcher stays away past the limit", async () => {
    statuses = [503];

    await expect(postWork({ baseUrl, token: "tools-token-value", work: { runId: "7-1", unpushed: "", pushedSha: null }, retryForMs: 100, backoffMs: { first: 10, max: 20 } })).rejects.toThrow(/work report was not delivered in 0\.1 s .*503/);
    expect(seen.length).toBeGreaterThan(1);
  });
});
